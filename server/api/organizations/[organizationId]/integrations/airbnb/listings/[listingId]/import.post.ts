import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// Starts importing a listing as a home: {missingDetails}, only the fields the listing's details report missing. 202 until the import completes.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const listingId = getRouterParam(event, 'listingId')
  if (!organizationId || !listingId) return jsonResponse({ error: 'Organization and listing IDs are required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<Record<string, unknown>>(event)
  // Check-in and checkout come from Airbnb; a request still sending them is refused rather than ignored.
  const unknown = Object.keys(body ?? {}).find(key => key !== 'missingDetails')
  if (unknown) return jsonResponse({ error: `${unknown} is not accepted; the import takes it from Airbnb`, code: 'VALIDATION_ERROR', field: unknown }, { status: 400 })
  const missing = body?.missingDetails ?? {}
  if (!missing || typeof missing !== 'object' || Array.isArray(missing)) return jsonResponse({ error: 'missingDetails must be an object', code: 'VALIDATION_ERROR', field: 'missingDetails' }, { status: 400 })
  const result = await new AirbnbConnection(env.DB, env, organization.id, session.user.id).prepare(listingId, { missingDetails: missing as Record<string, unknown> })
  return jsonResponse(result, { status: result.stage === 'complete' ? 200 : 202 })
})
