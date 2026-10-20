import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { getSessionAvailability } from '~/server/utils/availability'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  const sessionId = getRouterParam(event, 'sessionId')
  if (!organizationId || !productId || !sessionId) throw new HTTPError({ statusCode: 400, statusMessage: 'Organization, product and session are required' })
  const { db, organization } = await requireProductAccess(event, organizationId, productId)
  return jsonResponse({ success: true, session: await getSessionAvailability(db, organization.id, productId, sessionId) })
})
