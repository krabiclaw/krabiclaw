import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// Resend this connected home's full calendar through the normal ARI outbox, preserving its mapping and guest messages.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization and product IDs are required', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  return jsonResponse(await new AirbnbConnection(env.DB, env, organization.id, session.user.id).syncFullCalendar(productId))
})
