import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'
import { readAirbnbSync } from '~/server/integrations/channex/airbnb-sync'

// The organization's Airbnb connection and how many listings it maps.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const connection = new ChannexConnection(env.DB, env, organization.id, session.user.id)
  if (getQuery(event).view !== 'workspace') return jsonResponse(await connection.status())
  const [workspace, jobs] = await Promise.all([
    connection.workspace(),
    readAirbnbSync(env.DB, organization.id),
  ])
  return jsonResponse({ ...workspace, jobs })
})
