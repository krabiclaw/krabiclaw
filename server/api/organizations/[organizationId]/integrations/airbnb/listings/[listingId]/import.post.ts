import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// Starts importing a listing as a home: {missingDetails, checkInTime, checkOutTime}. 202 until the import completes.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const listingId = getRouterParam(event, 'listingId')
  if (!organizationId || !listingId) return jsonResponse({ error: 'Organization and listing IDs are required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ missingDetails?: unknown; checkInTime?: unknown; checkOutTime?: unknown }>(event)
  const missing = body?.missingDetails ?? {}
  if (!missing || typeof missing !== 'object' || Array.isArray(missing)) return jsonResponse({ error: 'missingDetails must be an object', code: 'VALIDATION_ERROR' }, { status: 400 })
  const result = await new AirbnbConnection(env.DB, env, organization.id, session.user.id).prepare(listingId, {
    missingDetails: missing as Record<string, unknown>, checkInTime: body?.checkInTime, checkOutTime: body?.checkOutTime,
  })
  return jsonResponse(result, { status: result.stage === 'complete' ? 200 : 202 })
})
