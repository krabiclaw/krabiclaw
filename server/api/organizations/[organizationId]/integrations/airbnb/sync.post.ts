import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { getCloudflareWaitUntil } from '~/server/utils/mcp-route-helpers'
import { REQUEST_SLICE_MS, requestAirbnbSync, runAirbnbSyncJobs } from '~/server/integrations/channex/airbnb-sync'

// Which Airbnb listings sync: {sync: [listing_id…], stop: [product_id…]}. 402 HOME_LIMIT with the homes quote
// before anything is queued; otherwise 202 with the queued listings, which the airbnb-sync task works through.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required', code: 'VALIDATION_ERROR', field: 'organizationId' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ sync?: unknown; stop?: unknown }>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Send {sync, stop}', code: 'VALIDATION_ERROR', field: 'body' }, { status: 400 })
  const waitUntil = getCloudflareWaitUntil(event)
  if (!waitUntil) throw new HTTPError({ statusCode: 500, message: 'Airbnb sync requires the Worker execution context', data: { code: 'EXECUTION_CONTEXT_REQUIRED' } })
  const listings = await requestAirbnbSync(env, env.DB, organization.id, session.user.id, body)
  // The first steps start now; the airbnb-sync task carries on every two minutes.
  waitUntil(runAirbnbSyncJobs(env, Date.now() + REQUEST_SLICE_MS, organization.id))
  return jsonResponse({ listings }, { status: 202 })
})
