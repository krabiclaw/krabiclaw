import { definePlugin } from 'nitro';
import { errorChainForTelemetry } from '~/shared/error-telemetry'
import { getRequestDataMetrics } from '~/server/utils/request-metrics'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('error', async (error, { event, tags }) => {
    // A 404 here is routinely a scanner bot probing for .env/wp-admin/phpinfo
    // paths, not a real server fault — logging every one at error severity
    // drowns out genuine 5xx exceptions in Observability queries filtered by
    // level=error (this happened during the 2026-07-21 MCP OAuth incident).
    // Mirrors the same >=500 threshold already used in server/api/auth/[...].ts.
    const chain = errorChainForTelemetry(error)
    const statusCode = chain[0]?.status
    const browserError = tags?.includes('browser') ? event?.req.context?.browserError : undefined
    const url = event ? new URL(event.req.url) : undefined
    const log = !browserError && statusCode && statusCode < 500 ? console.warn : console.error
    log(browserError ? '[CLIENT_ERROR]' : '[NITRO_SERVER_ERROR]', JSON.stringify({
      ...(browserError ? browserError : {}),
      host: url?.host ?? null,
      path: url?.pathname ?? null,
      request_id: event ? getRequestDataMetrics(event).requestId : null,
      ray_id: event?.req.headers.get('cf-ray') ?? null,
      tags: tags ?? [],
      error_chain: chain,
    }))
  })
})
