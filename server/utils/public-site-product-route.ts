import { getSourceLocale } from '~/server/utils/organization-locales'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { loadPublicSiteProductDetail, publicProductDetailPayload } from '~/server/utils/public-products'
import type { SiteProductSurface } from '~/server/types/products'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { assertExactCanonicalLocale } from '~/server/utils/localization'

/** The public API for a site-wide item page: /api/public/experiences/<slug> and /api/public/stays/<slug>. */
export function defineSiteProductDetailHandler(surface: SiteProductSurface) {
  const noun = surface === 'experiences' ? 'Experience' : 'Place to stay'
  return defineHandler(async (event) => {
    const organizationId = event.context.organizationId as string | null | undefined
    const slug = getRouterParam(event, 'slug')
    if (!organizationId || !slug) return jsonResponse({ error: `Organization and ${noun} slugs are required` }, { status: 400 })
    const env = cloudflareEnv(event)
    const db = env.DB
    if (!db) return jsonResponse({ error: 'Database unavailable' }, { status: 503 })
    const locale = assertExactCanonicalLocale(getQuery(event).locale ?? await getSourceLocale(db, organizationId))
    const previewAuthorized = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env))
    const scope = getQuery(event).location_id
    const result = await loadPublicSiteProductDetail(env, db, organizationId, surface, previewAuthorized, slug, locale, typeof scope === 'string' ? scope : null)
    if (!result) return jsonResponse({ error: `${noun} not found` }, { status: 404 })
    return jsonResponse(await publicProductDetailPayload(db, env, result))
  })
}
