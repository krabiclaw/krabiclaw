import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// Disconnects step by step; disconnected: false means call again.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const connection = new AirbnbConnection(env.DB, env, organization.id, session.user.id)
  return jsonResponse(await connection.disconnect())
})
