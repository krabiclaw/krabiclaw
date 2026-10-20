import { cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { listPublicOnlineProducts } from '~/server/utils/public-session-booking'
import { loadPublicProductApiCollection } from '~/server/utils/public-products'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { loadExactPublicLocalizations, projectExactLocalizedCollection } from '~/server/utils/public-localization'
import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })

  const rawLocation = getQuery(event).location
  const location = typeof rawLocation === 'string' && rawLocation.trim() ? rawLocation.trim() : null
  try {
    const env = cloudflareEnv(event)
    const db = env.DB
    if (!db) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })
    const locale = getQuery(event).locale === undefined ? undefined : assertExactCanonicalLocale(getQuery(event).locale)
    const previewAuthorized = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env))
    if (getQuery(event).online === 'true') {
      const result = await listPublicOnlineProducts(db, organizationId, previewAuthorized, env)
      if (locale && locale !== await getSourceLocale(db, organizationId)) {
        const localizations = await loadExactPublicLocalizations(env, db, organizationId, locale)
        result.products = projectExactLocalizedCollection('product', result.products, localizations)
      }
      return jsonResponse(result)
    }
    const result = await loadPublicProductApiCollection(env, db, organizationId, previewAuthorized, location, locale)
    if (!result) return jsonResponse({ error: 'Products not found' }, { status: 404 })
    return jsonResponse({
      products: result.products,
      locations: result.locations.map(({ id, slug, title }) => ({ id, slug, title })),
      currency: result.currency,
    })
  } catch (error) {
    rethrowHttpError(error)
    console.error('public_product_list_failed', { organizationId, location, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to load Products' }, { status: 500 })
  }
})
