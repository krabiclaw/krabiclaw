import { definePlugin } from 'nitro';
import { errorChainForTelemetry } from '~/server/utils/error-telemetry'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('request', async ({ req }) => {
    if (import.meta.dev || import.meta.preset !== 'cloudflare-module' || req.runtime?.cloudflare?.env || !req.context?.nuxt?.['~internal'] || !req.context.nuxt['~rendering-error']) return
    req.context.cloudflare = { env: (await import('cloudflare:workers')).env }
  })

  nitroApp.hooks.hook('error', async (error, { event: _event }) => {
    // A 404 here is routinely a scanner bot probing for .env/wp-admin/phpinfo
    // paths, not a real server fault — logging every one at error severity
    // drowns out genuine 5xx exceptions in Observability queries filtered by
    // level=error (this happened during the 2026-07-21 MCP OAuth incident).
    // Mirrors the same >=500 threshold already used in server/api/auth/[...].ts.
    const chain = errorChainForTelemetry(error)
    const statusCode = chain[0]?.status
    const log = statusCode && statusCode < 500 ? console.warn : console.error
    log('[NITRO_SERVER_ERROR]', chain)
  })
})
