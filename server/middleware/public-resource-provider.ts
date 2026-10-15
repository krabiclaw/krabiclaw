import { HTTPError, defineHandler  } from 'nitro';

import type { PublicResourceProvider } from '~/utils/public-resource-provider'
import { loadPublicPage } from '~/server/utils/public-page'
import { loadPublicShell } from '~/server/utils/public-shell'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { getPublicConfig } from '~/server/utils/organization-config'
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
      return finalizeRequestMetrics(event, 'public-config-ssr', await getPublicConfig(db, options.organizationId, {
        previewAuthorized: options.organizationId === event.context.organizationId && event.context.previewAuthorized === true,
      }))
    }
    if (options.resourceKind === 'shell') {
      const payload = await loadPublicShell(event, options.organizationId, {
        locale: options.query.locale, }, {
        mutateResponseHeaders: false, signal: options.signal, })
      return finalizeRequestMetrics(event, 'public-shell-ssr', payload)
    }
    const payload = await loadPublicPage(event, options.organizationId, options.query, {
      mutateResponseHeaders: false, signal: options.signal, })
    return finalizeRequestMetrics(event, 'public-page-ssr', payload)
  }
  event.context.publicResourceProvider = provider
})
