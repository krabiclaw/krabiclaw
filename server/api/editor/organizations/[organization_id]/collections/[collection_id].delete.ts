import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { deleteCollection } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const collectionId = getRouterParam(event, 'collection_id')
  if (!organizationId || !collectionId) return jsonResponse({ error: 'Organization ID and collection ID are required' }, { status: 400 })
  try {
    const { db, organization } = await requireOrganizationAccess(event, organizationId)
    // Deleting a grouping never deletes what was grouped.
    await deleteCollection(db, { organizationId: organization.id, collectionId })
    return jsonResponse({ success: true, collection_id: collectionId })
  } catch (error) {
    rethrowHttpError(error)
    console.error('collection_delete_failed', { organizationId, collectionId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to delete collection' }, { status: 500 })
  }
})
