import { HTTPError } from 'nitro';
import { oncePerRequest } from '~/server/utils/request-scope'

import type { H3Event } from 'nitro';
import {  setHeader } from 'nitro/h3';
import { cloudflareEnv } from '~/server/utils/api-response'
import { executeBatch, queryAll, type BatchQuery } from '~/server/db'
import { buildPublicResourceCacheKey, getPublicResourceCache, putPublicResourceCache } from '~/server/utils/public-resource-cache'
import { loadPublicBase } from '~/server/utils/public-base'
import { appendPublicShellQueries, buildPublicShellPayload } from '~/server/utils/public-shell-query'
import { listOrganizationProducts } from '~/server/utils/product-management'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { isNonProductionHost } from '~/server/utils/tenant-hosts'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { isPublicShellPayload } from '~/utils/public-resource-contracts'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { getSourceLocale } from '~/server/utils/organization-locales'
import {
  indexStoredPublicLocalizations,
  projectExactLocalizedCollection,
  projectExactLocalizedResource,
  type StoredPublicLocalizationRow,
} from '~/server/utils/public-localization'

export interface PublicShellLoadOptions {
  mutateResponseHeaders?: boolean
  signal?: AbortSignal
}

export async function loadPublicShellSource(
  event: H3Event,
  organizationId: string,
  query: Pick<Record<string, string | undefined>, 'locale'>,
  options: PublicShellLoadOptions = {},
) {
  options.signal?.throwIfAborted()
  const mutateHeaders = options.mutateResponseHeaders ?? true
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })

  const locale = typeof query.locale === 'string' ? query.locale : undefined
  if (locale !== undefined) assertExactCanonicalLocale(locale)
  const previewAuthorized = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env))
  const host = (event.req.headers.get('host')) ?? ''
  const useCache = !previewAuthorized && !isNonProductionHost(host)
  const cacheKey = buildPublicResourceCacheKey(organizationId, {
    contract: 'shell',
    page: null,
    location: null,
    datasets: [],
    blogSlug: null,
    locale,
  })
  const cache = env.ORGANIZATION_CACHE
  if (mutateHeaders) {
    setHeader(event, 'cache-control', previewAuthorized
      ? 'private, no-store'
      : 'public, max-age=60, stale-while-revalidate=300')
  }
  if (useCache && cache) {
    const cacheStartedAt = performance.now()
    const cached = await getPublicResourceCache(cache, cacheKey)
    recordRequestPhase(event, 'cache', cacheStartedAt)
    options.signal?.throwIfAborted()
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as unknown
        if (!isPublicShellPayload(parsed)) throw new Error('Shell cache contract mismatch')
        if (mutateHeaders) setHeader(event, 'x-bootstrap-cache', 'HIT')
        return parsed
      } catch (error) {
        await cache.delete(cacheKey)
        throw new HTTPError({ statusCode: 500, statusMessage: 'Public shell cache is invalid', cause: error })
      }
    }
    if (mutateHeaders) setHeader(event, 'x-bootstrap-cache', 'MISS')
  } else if (mutateHeaders) {
    setHeader(event, 'x-bootstrap-cache', useCache ? 'NO-KV' : 'SKIP')
  }

  const [{ organization }, sourceLocale] = await Promise.all([
    loadPublicBase(event, organizationId, { previewAuthorized }),
    getSourceLocale(db, organizationId),
  ])
  const shellQueries: BatchQuery[] = []
  const shellIndexes = appendPublicShellQueries(shellQueries, organization.id)
  // The entitlement, the shell rows and the bookable experiences depend on the
  // site alone; they were three sequential round trips on every cold shell.
  const [entitlement, shellResults, experiences] = await Promise.all([
    assertPublicOrganizationLanguageEntitlement(env, db, organization.id, locale ?? sourceLocale),
    executeBatch(db, shellQueries),
    listOrganizationProducts(db, { organizationId: organization.id, kind: 'experience', publishedOnly: true, env }),
  ])
  options.signal?.throwIfAborted()
  const payload = {
    success: true,
    ...(await buildPublicShellPayload(db, organization, shellResults, shellIndexes, env, experiences)),
    count: shellResults[shellIndexes.locations]?.results?.length ?? 0,
    platformMessages: entitlement.platform_messages,
  }
  if (locale && locale !== sourceLocale) {
    if (!entitlement.platform_messages) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Published platform locale messages are unavailable' })
    }
    payload.platformMessages = entitlement.platform_messages
    const localizedRows = await queryAll<StoredPublicLocalizationRow>(db, `
      SELECT resource_type, resource_id, locale, values_json, route_path
       FROM resource_localizations
       WHERE organization_id = ?  AND locale = ?
         AND resource_type IN ('organization', 'business_location')
    `, [organization.id, locale])
    // The shell reads the site and its locations; neither carries details,
    // so no definition is in scope here.
    const localizations = indexStoredPublicLocalizations(localizedRows)
    const organizationLocalization = localizations.find(item => item.resourceType === 'organization' && item.resourceId === organizationId)
    payload.locations = projectExactLocalizedCollection('business_location', payload.locations, localizations)
    const localizedOrganization = organizationLocalization
      ? projectExactLocalizedResource('organization', { ...payload.organization, id: organizationId }, organizationLocalization)
      : { ...payload.organization, id: organizationId, name: null, brand_description: null }
    const { id: _localizedOrganizationId, ...localizedOrganizationValues } = localizedOrganization
    payload.organization = localizedOrganizationValues
    const {
      name: _sourceBrandName,
      brand_description: _sourceBrandDescription,
      seo_title: _sourceSeoTitle,
      seo_description: _sourceSeoDescription,
      ...nonLocalizedConfig
    } = payload.config
    payload.config = {
      ...nonLocalizedConfig,
      ...(typeof localizedOrganization.name === 'string' ? {
        name: localizedOrganization.name,
        seo_title: localizedOrganization.name,
      } : {}),
      ...(typeof localizedOrganization.brand_description === 'string' ? {
        brand_description: localizedOrganization.brand_description,
        seo_description: localizedOrganization.brand_description,
      } : {}),
    }
    payload.count = payload.locations.length
  }
  if (useCache && cache) {
    await putPublicResourceCache(cache, cacheKey, JSON.stringify(payload))
  }
  return payload
}

export function loadPublicShell(
  event: H3Event,
  organizationId: string,
  query: Pick<Record<string, string | undefined>, 'locale'>,
  options?: PublicShellLoadOptions,
) {
  if (options?.signal) {
    const startedAt = performance.now()
    return loadPublicShellSource(event, organizationId, query, options)
      .finally(() => recordRequestPhase(event, 'shell', startedAt))
  }
  return oncePerRequest(event, `public-shell:${organizationId}:${query.locale ?? ''}`, () => {
    const startedAt = performance.now()
    return loadPublicShellSource(event, organizationId, query, options)
      .finally(() => recordRequestPhase(event, 'shell', startedAt))
  })
}
