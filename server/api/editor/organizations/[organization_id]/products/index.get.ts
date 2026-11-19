import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { roleAllows, assertRoleAllows } from '~/server/utils/member-access'
import { hydrateProductMedia, listOrganizationProducts, readEditorCatalog } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, organization } = await requireOrganizationMembership(event, organizationId)
    // Everything this site carries, published or withheld: the editor decides
    // visibility, so it must be able to see what is currently hidden.
    // The same photographs the location list attaches, so a row looks the same in every scope.
    const managesCatalog = await roleAllows({ ...organization.membership, permissions: { products: ['read'] } })
    if (!managesCatalog) await assertRoleAllows({ ...organization.membership, permissions: { products: ['assigned'] } })
    const query = getQuery(event)
    if (query.include === 'collections') {
      if (query.location_id !== undefined && (typeof query.location_id !== 'string' || !query.location_id.trim())) {
        return jsonResponse({ error: 'Invalid location_id' }, { status: 400 })
      }
      const data = await readEditorCatalog(db, {
        organizationId: organization.id, assignedUserId: managesCatalog ? undefined : organization.user_id,
        kind: query.kind === 'dish' ? 'dish' : undefined, locationId: query.location_id,
      })
      return jsonResponse({ success: true, ...data, organization_id: organizationId })
    }
    const products = await hydrateProductMedia(db, organization.id, await listOrganizationProducts(db, { organizationId: organization.id, assignedUserId: managesCatalog ? undefined : organization.user_id }))
    return jsonResponse({ success: true, products, organization_id: organizationId })
  } catch (error) {
    rethrowHttpError(error)
    console.error('products_list_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list products' }, { status: 500 })
  }
})
