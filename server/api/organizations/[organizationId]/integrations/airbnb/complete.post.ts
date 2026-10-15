import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// The Airbnb callback: {token, channel_id} from krabiclaw://airbnb/callback.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const connection = new AirbnbConnection(env.DB, env, organization.id, session.user.id)
  const body = await readBody<{ token?: unknown; channel_id?: unknown }>(event)
  if (typeof body?.token !== 'string' || !body.token || typeof body.channel_id !== 'string' || !body.channel_id) {
    return jsonResponse({ error: 'token and channel_id from the Airbnb callback are required', code: 'VALIDATION_ERROR' }, { status: 400 })
  }
  return jsonResponse(await connection.complete(body.token, body.channel_id))
})
