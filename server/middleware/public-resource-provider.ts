import { HTTPError, defineHandler  } from 'nitro';

import type { PublicResourceProvider } from '~/utils/public-resource-provider'
import { readPublicRoute } from '~/server/utils/public-route'
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
