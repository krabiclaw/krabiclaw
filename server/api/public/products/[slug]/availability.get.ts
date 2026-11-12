import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { readPublicProductAvailability } from '~/server/utils/public-session-booking'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

/** Read the offering's local dates in [from, to), with the stay departure boundary when applicable. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return jsonResponse({ error: 'organizationId and slug required' }, { status: 400 })
  const env = cloudflareEnv(event)
  const availability = await readPublicProductAvailability(env.DB, organizationId, slug, env, getQuery(event))
  return jsonResponse(finalizeRequestMetrics(event, 'product-availability', availability), { headers: { 'cache-control': 'private, no-store' } })
})
