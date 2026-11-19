import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { BATCH_VIEWER, roleAllows, assertRoleAllows } from '~/server/utils/member-access'
import { hydrateProductMedia, listOrganizationProducts, prepareEditorCatalog } from '~/server/utils/product-management'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const query = getQuery(event)
    if (query.include === 'collections') {
      if (query.location_id !== undefined && (typeof query.location_id !== 'string' || !query.location_id.trim())) {
        return jsonResponse({ error: 'Invalid location_id' }, { status: 400 })
      }
      const plan = prepareEditorCatalog({
        organizationId: { sql: BATCH_VIEWER.organization }, assignedUserId: { user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: ['read'] })) },
        kind: query.kind === 'dish' ? 'dish' : undefined, locationId: query.location_id,
      })
      const { organization, rows } = await readDashboardMemberResources(event, organizationId, plan.queries)
      if (!await roleAllows({ ...organization, permissions: { products: ['read'] } })) await assertRoleAllows({ ...organization, permissions: { products: ['assigned'] } })
      return jsonResponse({ success: true, ...plan.read(rows), organization_id: organizationId })
    }
    const { db, organization } = await requireOrganizationMembership(event, organizationId)
    // Everything this site carries, published or withheld: the editor decides
    // visibility, so it must be able to see what is currently hidden.
    // The same photographs the location list attaches, so a row looks the same in every scope.
    const managesCatalog = await roleAllows({ ...organization.membership, permissions: { products: ['read'] } })
    if (!managesCatalog) await assertRoleAllows({ ...organization.membership, permissions: { products: ['assigned'] } })
    const products = await hydrateProductMedia(db, organization.id, await listOrganizationProducts(db, { organizationId: organization.id, assignedUserId: managesCatalog ? undefined : organization.user_id }))
    return jsonResponse({ success: true, products, organization_id: organizationId })
  } catch (error) {
    rethrowHttpError(error)
    console.error('products_list_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list products' }, { status: 500 })
  }
})
