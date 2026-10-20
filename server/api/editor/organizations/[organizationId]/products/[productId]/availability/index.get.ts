import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { listAvailabilityRules } from '~/server/utils/availability'
import { findLocation } from '~/server/utils/member-access'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

/** The weekly schedule a product runs at one location: its rules, as stored. */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  // Weekly times belong to a location; an online offering is booked in its provider's hours.
  const locationId = getQuery(event).location_id
  if (typeof locationId !== 'string' || !locationId) return jsonResponse({ error: 'location_id is required' }, { status: 400 })
  try {
    const { db, organization } = await requireProductAccess(event, organizationId, productId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    if (!await findLocation(db, { organizationId: organization.id, locationId })) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
    const rules = (await listAvailabilityRules(db, organization.id, productId)).filter(rule => rule.location_id === locationId)
    return jsonResponse({ success: true, rules })
  } catch (error) {
    rethrowHttpError(error)
    console.error('availability_list_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to load the schedule' }, { status: 500 })
  }
})
