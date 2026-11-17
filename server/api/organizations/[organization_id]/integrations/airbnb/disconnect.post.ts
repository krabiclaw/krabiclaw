import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'

// Asks for the disconnect, which the AIRBNB_SYNC queue runs; disconnected: false means it is under way.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ retry?: unknown }>(event)
  if (body?.retry !== undefined && typeof body.retry !== 'boolean') return jsonResponse({ error: 'Retry must be true or false' }, { status: 400 })
  const connection = new ChannexConnection(env.DB, env, organization.id, session.user.id)
  return jsonResponse(await connection.disconnect(body?.retry === true))
})
