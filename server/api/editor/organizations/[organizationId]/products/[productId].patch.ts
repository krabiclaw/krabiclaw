import type { UpdateProductInput } from '~/server/types/products'
import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { requireOrganizationProduct, updateProduct } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  try {
    const body = await readRequiredBody<UpdateProductInput>(event)
    const { env, db, session, organization } = await requireProductAccess(event, organizationId, productId, body as unknown as Record<string, unknown>)
    // Authorizing this site does not authorize a product id in the path: the
    // catalog is organization-wide, and an editor scoped to one site must not
    // reach another site's product through it.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const product = await updateProduct(db, {
      organizationId: organization.id, productId, patch: body, actor: { actorId: session.user.id }, env,
    })
    return jsonResponse({ success: true, product })
  } catch (error) {
    rethrowHttpError(error)
    console.error('product_update_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to update product' }, { status: 500 })
  }
})
