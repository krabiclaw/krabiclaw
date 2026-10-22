import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { listCollections, reorderCollections } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readStrictBody<{ collection_ids: unknown; location_id?: unknown; expected_collection_ids?: string[] }>(event, { collection_ids: 'unknown', location_id: 'unknown', expected_collection_ids: 'unknown' })
    if (!Array.isArray(body.collection_ids) || body.collection_ids.some(id => typeof id !== 'string' || !id.trim())) {
      return jsonResponse({ error: 'collection_ids must contain non-empty collection IDs' }, { status: 400 })
    }
    const locationId = body.location_id === undefined ? null : (body.location_id === null ? null : String(body.location_id))
    await reorderCollections(db, {
      organizationId: organization.id, locationId,
      collectionIds: body.collection_ids.map(id => String(id).trim()), actor: { actorId: session.user.id },
      ...(Object.hasOwn(body, 'expected_collection_ids') ? { expectedCollectionIds: body.expected_collection_ids } : {}),
    })
    return jsonResponse({ success: true, collections: await listCollections(db, { organizationId: organization.id, locationId }) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('collections_reorder_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to reorder collections' }, { status: 500 })
  }
})
