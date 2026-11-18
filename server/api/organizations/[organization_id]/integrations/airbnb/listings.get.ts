import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'

// The listings on the connected Airbnb account and imported homes whose listings are missing.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const connection = new ChannexConnection(env.DB, env, organization.id, session.user.id)
  return jsonResponse(await connection.listings())
})
