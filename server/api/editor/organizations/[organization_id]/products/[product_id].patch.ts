import type { UpdateProductInput } from '~/server/types/products'
import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { presentDashboardProduct } from '~/server/utils/dashboard-editor-resources'
import { updateProduct } from '~/server/utils/product-management'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  try {
    const body = await readRequiredBody<UpdateProductInput>(event)
    const { env, db, session, organization } = await requireProductAccess(event, organizationId, productId, body as unknown as Record<string, unknown>)
    const idempotencyKey = event.req.headers.get('idempotency-key')?.trim()
    if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 200)) {
      return jsonResponse({ error: 'Idempotency-Key must be 1 to 200 characters', code: 'VALIDATION_ERROR', field: 'idempotency_key' }, { status: 400 })
    }
    const query = getQuery(event)
    if (query.location_id !== undefined && (typeof query.location_id !== 'string' || !query.location_id.trim())) {
      return jsonResponse({ error: 'Invalid location_id' }, { status: 400 })
    }
    const product = await updateProduct(db, {
      organizationId: organization.id, productId, patch: body, actor: { actorId: session.user.id }, env, idempotencyKey,
    })
    if (query.editor === '1') {
      const saved = await presentDashboardProduct({ env, db, organization }, product, query.location_id as string | undefined ?? null, true)
      return jsonResponse({ ...saved, product: { ...saved.product, channel_push: product.channel_push } })
    }
    return jsonResponse({ success: true, product })
  } catch (error) {
    rethrowHttpError(error)
    console.error('product_update_failed', { organizationId, productId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to update product' }, { status: 500 })
  }
})
