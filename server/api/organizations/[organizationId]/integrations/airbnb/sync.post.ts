import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { requestAirbnbSync } from '~/server/integrations/channex/airbnb-sync'
import { hasOrganizationEntitlement } from '~/server/utils/billing'

// Which Airbnb listings sync: {sync: [listing_id…], stop: [product_id…]}. 402 HOME_LIMIT with the homes quote
// before anything is queued; otherwise 202 with the queued listings, which the airbnb-sync task works through.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required', code: 'VALIDATION_ERROR', field: 'organizationId' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ sync?: unknown; stop?: unknown }>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Send {sync, stop}', code: 'VALIDATION_ERROR', field: 'body' }, { status: 400 })
  // Starting a sync is Business; stopping one never needs a plan.
  if (Array.isArray(body.sync) && body.sync.length && !await hasOrganizationEntitlement(env, organization.id, 'channel_sync')) return jsonResponse({ error: 'Airbnb sync comes with the Business plan', code: 'ENTITLEMENT_REQUIRED', entitlement: 'channel_sync' }, { status: 403 })
  const listings = await requestAirbnbSync(env, env.DB, organization.id, session.user.id, body)
  return jsonResponse({ listings }, { status: 202 })
})
