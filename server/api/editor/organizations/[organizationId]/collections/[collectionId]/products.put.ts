import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { listCollectionProducts, setCollectionProducts } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import type { SetCollectionProductsInput } from '~/server/types/products'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const collectionId = getRouterParam(event, 'collectionId')
  if (!organizationId || !collectionId) return jsonResponse({ error: 'Organization ID and collection ID are required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readStrictBody<SetCollectionProductsInput>(event, { product_ids: 'unknown', expected_product_ids: 'unknown', move_to: 'unknown' })
    if (!Array.isArray(body.product_ids) || body.product_ids.some(id => typeof id !== 'string' || !id.trim())) {
      return jsonResponse({ error: 'product_ids must contain non-empty product IDs' }, { status: 400 })
    }
    // The complete intended membership and order. A partial list would leave
    // unnamed products at whatever position they happened to hold.
    await setCollectionProducts(db, {
      organizationId: organization.id, collectionId,
      productIds: body.product_ids.map(id => String(id).trim()), actor: { actorId: session.user.id },
      ...(Object.hasOwn(body, 'expected_product_ids') ? { expectedProductIds: body.expected_product_ids } : {}),
      ...(Object.hasOwn(body, 'move_to') ? { moveTo: body.move_to } : {}),
    })
    return jsonResponse({ success: true, products: await listCollectionProducts(db, { organizationId: organization.id, collectionId }) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('collection_products_failed', { organizationId, collectionId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to set collection products' }, { status: 500 })
  }
})
