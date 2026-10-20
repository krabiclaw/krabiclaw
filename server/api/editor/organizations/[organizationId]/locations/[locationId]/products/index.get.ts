import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { roleAllows, assertRoleAllows, findLocation } from '~/server/utils/member-access'
import { defineHandler, HTTPError } from 'nitro'
import { hydrateProductMedia, listLocationProducts } from '~/server/utils/product-management'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !locationId) return jsonResponse({ error: 'Organization ID and location ID are required' }, { status: 400 })
  try {
    const { db, organization } = await requireOrganizationMembership(event, organizationId)
    if (!await findLocation(db, { organizationId: organization.id, locationId })) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
    const managesCatalog = await roleAllows({ ...organization.membership, permissions: { products: ['read'] } })
    if (!managesCatalog) await assertRoleAllows({ ...organization.membership, permissions: { products: ['assigned'] } })
    // The editor shows the photograph the public page shows. Placements are
    // site-scoped, so they are attached here, for this site, the same way the
    // public reader attaches them — a list that said "no photo" for a product
    // with a live cover was the editor lying about the customer's page.
    const products = await hydrateProductMedia(db, organizationId, await listLocationProducts(db, { organizationId: organization.id, locationId, assignedUserId: managesCatalog ? undefined : organization.user_id }))
    return jsonResponse({ success: true, products, organization_id: organizationId, location_id: locationId })
  } catch (error) {
    rethrowHttpError(error)
    console.error('location_products_list_failed', { organizationId, locationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list products for this location' }, { status: 500 })
  }
})
