import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { AirbnbConnection } from '~/server/integrations/channex/airbnb-connection'

// One stage of a listing's import. 202 until it completes; waiting means ask the same stage again.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization and product IDs are required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const result = await new AirbnbConnection(env.DB, env, organization.id, session.user.id).advance(productId)
  return jsonResponse(result, { status: result.stage === 'complete' ? 200 : 202 })
})
