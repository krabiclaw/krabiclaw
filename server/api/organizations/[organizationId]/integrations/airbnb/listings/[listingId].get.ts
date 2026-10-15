import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// A listing's details, and the fields Airbnb left out that the import form asks for.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const listingId = getRouterParam(event, 'listingId')
  if (!organizationId || !listingId) return jsonResponse({ error: 'Organization and listing IDs are required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  return jsonResponse(await new AirbnbConnection(env.DB, env, organization.id, session.user.id).details(listingId))
})
