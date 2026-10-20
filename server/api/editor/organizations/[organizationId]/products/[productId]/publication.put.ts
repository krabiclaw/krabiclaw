import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { getProduct, requireOrganizationProduct, setProductPublication } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  try {
    const { db, session, organization, env } = await requireOrganizationAccess(event, organizationId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const body = await readStrictBody<{ published: unknown }>(event, { published: 'unknown' })
    if (typeof body.published !== 'boolean') return jsonResponse({ error: 'published must be a boolean' }, { status: 400 })
    await setProductPublication(db, {
      organizationId, productId, published: body.published, actor: { actorId: session.user.id }, env,
    })
    return jsonResponse({ success: true, product: await getProduct(db, organization.id, productId) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('product_publication_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to set product publication' }, { status: 500 })
  }
})
