import { cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { loadPublicProductApiDetail, loadPublicProductReviews } from '~/server/utils/public-products'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const locationSlug = getRouterParam(event, 'location_slug')
  const productSlug = getRouterParam(event, 'product_slug')
  if (!organizationId || !locationSlug || !productSlug) return jsonResponse({ error: 'Organization, location, and Product slugs are required' }, { status: 400 })
  try {
    const env = cloudflareEnv(event)
    const db = env.DB
    if (!db) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })
    const previewAuthorized = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(cloudflareEnv(event)))
    const resolved = await loadPublicProductApiDetail(env, db, organizationId, previewAuthorized, locationSlug, productSlug)
    if (!resolved) return jsonResponse({ error: 'Product not found' }, { status: 404 })
    const reviews = await loadPublicProductReviews(db, resolved)
    return jsonResponse({ reviews })
  } catch (error) {
    rethrowHttpError(error)
    console.error('public_product_reviews_failed', { organizationId, locationSlug, productSlug, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to load Product reviews' }, { status: 500 })
  }
})
