import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'

// The content stage again for a completed import: photos, texts, counts, amenities and check-in method from Airbnb, with the report of what was left out.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization and product IDs are required', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  return jsonResponse(await new ChannexConnection(env.DB, env, organization.id, session.user.id).refreshContent(productId))
})
