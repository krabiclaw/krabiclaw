import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireLocationAccess } from '~/server/utils/location-access'
import { getProduct, removeProductLocation, requireOrganizationProduct } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !productId || !locationId) return jsonResponse({ error: 'Organization, product and location IDs are required' }, { status: 400 })
  try {
    const { db, organization } = await requireLocationAccess(event, organizationId, locationId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    await removeProductLocation(db, { organizationId: organization.id, productId, locationId })
    return jsonResponse({ success: true, product: await getProduct(db, organization.id, productId) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('product_location_remove_failed', { organizationId, productId, locationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to remove product from location' }, { status: 500 })
  }
})
