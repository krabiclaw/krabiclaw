import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { createCollection } from '~/server/utils/product-management'
import type { CreateCollectionInput } from '~/server/types/products'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readRequiredBody<CreateCollectionInput>(event)
    const collection = await createCollection(db, {
      organizationId: organization.id,
      collection: body,
      actor: { actorId: session.user.id },
    })
    return jsonResponse({ success: true, collection }, { status: 201 })
  } catch (error) {
    rethrowHttpError(error)
    console.error('collection_create_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to create collection' }, { status: 500 })
  }
})
