import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// Starts importing a listing as a home: {missingDetails}, only the fields the listing's details report missing. 202 while the import is under way; 200 at rest, as a draft or complete.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const listingId = getRouterParam(event, 'listingId')
  if (!organizationId || !listingId) return jsonResponse({ error: 'Organization and listing IDs are required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<Record<string, unknown>>(event)
  // The installed iOS build (10) still sends checkInTime and checkOutTime and
  // asks for childBeds and infantCots. They are read and discarded: the times
  // are Airbnb's and Channex gets 0 for both bed counts. Any other key is refused.
  const { checkInTime: _checkInTime, checkOutTime: _checkOutTime, ...rest } = body ?? {}
  const unknown = Object.keys(rest).find(key => key !== 'missingDetails')
  if (unknown) return jsonResponse({ error: `${unknown} is not accepted`, code: 'VALIDATION_ERROR', field: unknown }, { status: 400 })
  const missing = rest.missingDetails ?? {}
  if (!missing || typeof missing !== 'object' || Array.isArray(missing)) return jsonResponse({ error: 'missingDetails must be an object', code: 'VALIDATION_ERROR', field: 'missingDetails' }, { status: 400 })
  const { childBeds: _childBeds, infantCots: _infantCots, ...missingDetails } = missing as Record<string, unknown>
  const result = await new AirbnbConnection(env.DB, env, organization.id, session.user.id).prepare(listingId, { missingDetails })
  return jsonResponse(result, { status: result.stage === 'complete' || result.stage === 'draft' ? 200 : 202 })
})
