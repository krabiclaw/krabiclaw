import { HTTPError } from 'nitro';
import { oncePerRequest } from '~/server/utils/request-scope'

import type { H3Event } from 'nitro';
import {  setHeader } from 'nitro/h3';
import { cloudflareEnv } from '~/server/utils/api-response'
import { executeBatch, queryAll, queryFirst, type BatchQuery } from '~/server/db'
import { buildPublicResourceCacheKey, getPublicResourceCache, putPublicResourceCache } from '~/server/utils/public-resource-cache'
import { loadPublicBase } from '~/server/utils/public-base'
import { appendPublicShellQueries, buildPublicShellPayload } from '~/server/utils/public-shell-query'
import { listOrganizationProducts } from '~/server/utils/product-management'
import { getOptionalPublicConsultationSettings, getPublicCompliance } from '~/server/utils/professional-services'
import { listPublishedTenantPagePaths } from '~/server/utils/content/pages'
import { platformLocale } from '~/shared/platform-locales'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { isNonProductionHost } from '~/server/utils/tenant-hosts'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { isPublicShellPayload } from '~/utils/public-resource-contracts'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { isLegalPracticeSite } from '~/utils/template-registry'
import {
  indexStoredPublicLocalizations,
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
  const [
    entitlement,
    shellResults,
    experiences,
    sourceConsultation,
    sourceCompliance,
    publishedPages,
    verification,
    localizedRows,
  ] = await Promise.all([
    assertPublicOrganizationLanguageEntitlement(env, db, organization.id, locale ?? sourceLocale),
    executeBatch(db, shellQueries),
    listOrganizationProducts(db, { organizationId: organization.id, kind: 'experience', publishedOnly: true, env }),
    // Only a legal practice books consultations; a venue's site has no schedule page.
    isLegalPracticeSite({ themeId: organization.theme_id, vertical: organization.vertical }) ? getOptionalPublicConsultationSettings(db, organization.id) : null,
    getPublicCompliance(db, organization.id),
    listPublishedTenantPagePaths(db, organization.id, locale ?? sourceLocale),
    queryFirst<{ token: string | null }>(db, `
      SELECT (SELECT i.verification_token FROM organization_integrations i WHERE i.organization_id = organization.id AND i.provider = 'google_search_console') AS token
        FROM organization WHERE id = ? LIMIT 1
    `, [organization.id]),
    locale && locale !== sourceLocale ? queryAll<StoredPublicLocalizationRow>(db, `
      SELECT resource_type, resource_id, locale, values_json, route_path
       FROM resource_localizations
       WHERE organization_id = ? AND locale = ?
         AND resource_type IN ('organization', 'business_location')
    `, [organization.id, locale]) : [],
  ])
  options.signal?.throwIfAborted()

  let canSchedule = false
  if (sourceConsultation?.mode === 'native') {
    const services = await listOrganizationProducts(db, { organizationId: organization.id, kind: 'service', publishedOnly: true, bookableOnly: true, env })
    canSchedule = services.length > 0
  } else if (sourceConsultation?.mode === 'external_url') {
    canSchedule = Boolean(sourceConsultation.external_url)
  }

  const pageLinks = publishedPages
    .filter(page => page.path !== '/schedule' || canSchedule)
    .map(page => ({ id: page.id, path: page.path, title: page.title }))

  if (experiences.length && !pageLinks.some(page => page.path === '/experiences')) {
    const title = platformLocale(locale ?? sourceLocale)?.messages['site.footer.experiences'] || 'Experiences'
    pageLinks.push({ id: 'experiences', path: '/experiences', title })
  }

  const localizations = locale && locale !== sourceLocale ? indexStoredPublicLocalizations(localizedRows) : undefined
  const payload = {
    success: true,
    ...(await buildPublicShellPayload(db, organization, shellResults, shellIndexes, env, experiences, {
      consultation: sourceConsultation,
      canSchedule,
      compliance: sourceCompliance,
      pageLinks,
      searchConsoleVerification: verification?.token ?? organization.search_console_verification ?? null,
      localizations,
    })),
    count: shellResults[shellIndexes.locations]?.results?.length ?? 0,
    platformMessages: entitlement.platform_messages,
  }
  if (locale && locale !== sourceLocale) {
    if (!entitlement.platform_messages) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Published platform locale messages are unavailable' })
    }
    payload.platformMessages = entitlement.platform_messages
    // The shell reads the site and its locations; neither carries details,
    // so no definition is in scope here.
    const organizationLocalization = localizations?.find(item => item.resourceType === 'organization' && item.resourceId === organizationId)
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
    if (organizationLocalization?.values.consultation && payload.consultation) {
      const consultationValues = organizationLocalization.values.consultation as { cta_label?: unknown }
      if (typeof consultationValues.cta_label === 'string') {
        payload.consultation = {
          ...payload.consultation,
          cta_label: consultationValues.cta_label,
        }
      }
    }
    if (organizationLocalization?.values.compliance && payload.compliance) {
      const complianceValues = organizationLocalization.values.compliance as {
        entity_name?: unknown
        disclaimer?: unknown
        footer_disclaimer?: unknown
      }
      payload.compliance = {
        ...payload.compliance,
        entity_name: typeof complianceValues.entity_name === 'string' ? complianceValues.entity_name : payload.compliance.entity_name,
        disclaimer: typeof complianceValues.disclaimer === 'string' ? complianceValues.disclaimer : payload.compliance.disclaimer,
        footer_disclaimer: typeof complianceValues.footer_disclaimer === 'string' ? complianceValues.footer_disclaimer : payload.compliance.footer_disclaimer,
      }
    }
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
