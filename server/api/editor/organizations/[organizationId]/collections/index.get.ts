import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { roleAllows, assertRoleAllows } from '~/server/utils/member-access'
import { listCollections } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, organization } = await requireOrganizationMembership(event, organizationId)
    const managesCatalog = await roleAllows({ ...organization.membership, permissions: { products: ['read'] } })
    if (!managesCatalog) await assertRoleAllows({ ...organization.membership, permissions: { products: ['assigned'] } })
    const query = getQuery(event)
    // Omitting location_id lists every collection on the site; passing it —
    // including the empty string for site-wide — narrows to that scope. The
    // two are different questions, so neither stands in for the other.
    const locationId = query.location_id === undefined ? undefined : (String(query.location_id) || null)
    const collections = await listCollections(db, { organizationId: organization.id, locationId, assignedUserId: managesCatalog ? undefined : organization.user_id })
    return jsonResponse({ success: true, collections })
  } catch (error) {
    rethrowHttpError(error)
    console.error('collections_list_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list collections' }, { status: 500 })
  }
})
