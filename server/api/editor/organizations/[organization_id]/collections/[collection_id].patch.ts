import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { updateCollection } from '~/server/utils/product-management'
import type { UpdateCollectionInput } from '~/server/types/products'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const collectionId = getRouterParam(event, 'collection_id')
  if (!organizationId || !collectionId) return jsonResponse({ error: 'Organization ID and collection ID are required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readRequiredBody<UpdateCollectionInput>(event)
    const collection = await updateCollection(db, {
      organizationId: organization.id, collectionId, patch: body, actor: { actorId: session.user.id },
    })
    return jsonResponse({ success: true, collection })
  } catch (error) {
    rethrowHttpError(error)
    console.error('collection_update_failed', { organizationId, collectionId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to update collection' }, { status: 500 })
  }
})
