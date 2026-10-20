import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireLocationAccess } from '~/server/utils/location-access'
import { getProduct, requireOrganizationProduct, setProductLocation } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !productId || !locationId) return jsonResponse({ error: 'Organization, product and location IDs are required' }, { status: 400 })
  try {
    // Location access, not site access: a location editor may say whether this
    // branch offers the product without gaining rights over the product itself.
    const { db, session, organization, env } = await requireLocationAccess(event, organizationId, locationId)
    // A product id in the path is not authorized by the site in the path.
    await requireOrganizationProduct(db, { organizationId: organization.id, productId })
    const body = await readStrictBody<{ active?: unknown; published?: unknown }>(event, { active: 'unknown', published: 'unknown' })
    for (const field of ['active', 'published'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        return jsonResponse({ error: `${field} must be a boolean` }, { status: 400 })
      }
    }
    await setProductLocation(db, {
      organizationId: organization.id, productId, locationId,
      active: body.active as boolean | undefined, published: body.published as boolean | undefined,
      actor: { actorId: session.user.id }, env,
    })
    return jsonResponse({ success: true, product: await getProduct(db, organization.id, productId) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('product_location_failed', { organizationId, productId, locationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to set product location' }, { status: 500 })
  }
})
