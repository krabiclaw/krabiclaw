import { HTTPError, defineHandler  } from 'nitro';

import type { PublicResourceProvider } from '~/utils/public-resource-provider'
import { readPublicRoute } from '~/server/utils/public-route'
import { readPublicAuthoredPage } from '~/server/utils/public-tenant-pages'
import { preparePublicInquiryForm, readPublicInquiryForm } from '~/server/domain/form-questions'
import { readPublicOrganizationLanguage, readPublicSourceLocale } from '~/server/utils/localization'
import { loadPublicShell } from '~/server/utils/public-shell'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { getPublicConfig, publicConfigFromRow, type PublicConfigRow } from '~/server/utils/organization-config'
import { oncePerRequest } from '~/server/utils/request-scope'
import { cloudflareEnv } from '~/server/utils/api-response'

export default defineHandler((event) => {
  const provider: PublicResourceProvider = async (options) => {
    options.signal?.throwIfAborted()
    if (!options.organizationId) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Public organization context unavailable' })
    }
    if (options.resourceKind === 'config') {
      const db = cloudflareEnv(event).db
      if (!db) throw new HTTPError({ statusCode: 500, statusMessage: 'Database not available' })
      const organizationId = options.organizationId
      const previewAuthorized = organizationId === event.context.organizationId && event.context.previewAuthorized === true
      const row = event.context.tenantConfigRow as (PublicConfigRow & { id: string }) | undefined
      const config = await oncePerRequest(event, `public-config:${organizationId}:${previewAuthorized}`, async () =>
        row?.id === organizationId ? publicConfigFromRow(row) : getPublicConfig(db, organizationId, { previewAuthorized }))
      return finalizeRequestMetrics(event, 'public-config-ssr', config)
    }
    if (options.resourceKind === 'inquiry') {
      const db = cloudflareEnv(event).db
      if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })
      const { organizationId } = options
      if (organizationId !== event.context.organizationId) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
      const source = await readPublicSourceLocale(event, db, organizationId)
      const { locale } = await readPublicOrganizationLanguage(event, db, organizationId, options.query.locale || source.locale, source)
      const saved = event.context.publicInquiryForm as { organizationId: string; locale: string; value: unknown } | undefined
      const form = saved?.organizationId === organizationId && saved.locale === locale
        ? preparePublicInquiryForm(organizationId, locale).read(saved.value)
        : await readPublicInquiryForm(db, organizationId, locale)
      return finalizeRequestMetrics(event, 'public-inquiry-ssr', { success: true, ...form })
    }
    if (options.resourceKind === 'document') {
      if (options.organizationId !== event.context.organizationId) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
      return finalizeRequestMetrics(event, 'public-authored-page-ssr', await readPublicAuthoredPage(event, options.query))
    }
    if (options.resourceKind === 'shell') {
      const payload = await loadPublicShell(event, options.organizationId, {
        locale: options.query.locale, }, {
        mutateResponseHeaders: false, signal: options.signal, })
      return finalizeRequestMetrics(event, 'public-shell-ssr', payload)
    }
    const payload = await readPublicRoute(event, options.organizationId, options.query, { signal: options.signal })
    return finalizeRequestMetrics(event, 'public-page-ssr', payload)
  }
  event.context.publicResourceProvider = provider
})
