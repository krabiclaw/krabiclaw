import type { ProductSurface } from '~/server/types/products'
import type { PublicProductDetailPayload } from '~/server/utils/public-products'
import { isCurrencyCode } from '~/shared/currencies'
import { isRecord, publicApiRequest } from '~/utils/api-clients'
import { isPublicProduct, type PublicLocaleRepresentation } from '~/utils/public-resource-contracts'

export type { PublicProductDetailPayload } from '~/server/utils/public-products'

export function isPublicProductDetailPayload(value: unknown): value is PublicProductDetailPayload {
  return isRecord(value)
    && isPublicProduct(value.product)
    && (value.location === null || (isRecord(value.location)
    && typeof value.location.id === 'string'
    && typeof value.location.slug === 'string'
    && typeof value.location.title === 'string'
    && (value.location.address === null || typeof value.location.address === 'object')
    && (value.location.phone === null || typeof value.location.phone === 'string')
    && (value.location.maps_url === null || typeof value.location.maps_url === 'string')
    && (value.location.latitude === null || typeof value.location.latitude === 'number')
    && (value.location.longitude === null || typeof value.location.longitude === 'number')))
    && (value.locations === undefined || (Array.isArray(value.locations) && value.locations.every(location => isRecord(location) && typeof location.id === 'string' && typeof location.slug === 'string' && typeof location.title === 'string')))
    && (value.scopeRequired === undefined || typeof value.scopeRequired === 'boolean')
    && (value.onlineAvailable === undefined || typeof value.onlineAvailable === 'boolean')
    && isCurrencyCode(value.currency)
    && typeof value.vertical === 'string'
    && typeof value.brandName === 'string'
    && value.brandName.trim().length > 0
    && (value.booking === null || (isRecord(value.booking)
      && (value.booking.duration_minutes === null || typeof value.booking.duration_minutes === 'number')
      && (value.booking.default_capacity === null || typeof value.booking.default_capacity === 'number')))
    && Array.isArray(value.sessions)
    && value.sessions.every(session => isRecord(session)
      && typeof session.id === 'string'
      && typeof session.starts_at === 'string'
      && typeof session.ends_at === 'string'
      && typeof session.timezone === 'string'
      && (session.remaining === null || typeof session.remaining === 'number')
      && typeof session.is_full === 'boolean'
      && typeof session.created_at === 'string')
    && Array.isArray(value.reviews)
    && value.reviews.every(review => isRecord(review)
      && typeof review.id === 'string'
      && typeof review.author_name === 'string'
      && typeof review.rating === 'number'
      && (typeof review.title === 'string' || review.title === null)
      && typeof review.content === 'string'
      && (typeof review.original_review_date === 'string' || review.original_review_date === null)
      && typeof review.created_at === 'string'
      && typeof review.source === 'string'
      && (typeof review.original_reference === 'string' || review.original_reference === null)
      && (isRecord(review.google_review_metadata) || review.google_review_metadata === null))
    && typeof value.collectionName === 'string'
    && Array.isArray(value.collectionSiblings)
    && value.collectionSiblings.every(sibling => isRecord(sibling)
      && typeof sibling.id === 'string'
      && typeof sibling.name === 'string'
      && typeof sibling.slug === 'string')
    && typeof value.stayCheckoutAvailable === 'boolean'
    && Array.isArray(value.localeRepresentations)
    && value.localeRepresentations.every(item => isRecord(item)
      && typeof item.locale === 'string'
      && typeof item.label === 'string'
      && typeof item.route_path === 'string'
      && (item.source === 'source' || item.source === 'localized'))
}

export async function usePublicProductDetail(routeKind: ProductSurface) {
  const nuxtApp = useNuxtApp()
  const route = useRoute()
  const requestEvent = useRequestEvent()
  const { id: organizationId } = useTenantOrganization().organization
  // An Experience's and a home's page is site-wide: /experiences/<product-slug>
  // and /stays/<product-slug> name the Product in their only slug segment, where
  // a vertical's product page names the branch first. Same payload either way,
  // so one composable serves both.
  const routeSlug = String(route.params.slug ?? '')
  const productSlugParam = String(route.params.productSlug ?? '')
  const siteWideSurface = (routeKind === 'experiences' || routeKind === 'stays') && productSlugParam === '' ? routeKind : null
  const locationSlug = siteWideSurface ? '' : routeSlug
  const productSlug = siteWideSurface ? routeSlug : productSlugParam
  const scope = computed(() => typeof route.query.location_id === 'string' ? route.query.location_id : null)
  const locale = typeof route.params.locale === 'string' ? route.params.locale : useState<string>('public-locale').value
  const localeRepresentations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])
  if (!organizationId || !productSlug || (!siteWideSurface && !locationSlug)) throw createError({ statusCode: 404, statusMessage: 'Product not found', fatal: true })

  const { data, error } = await useAsyncData<PublicProductDetailPayload | null>(
    () => `public-product-${organizationId}-${locale}-${locationSlug}-${productSlug}-${scope.value ?? ''}`,
    async (_nuxtApp, { signal }) => {
      if (import.meta.server) {
        if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
        const [{ cloudflareEnv }, { loadPublicSiteProductDetail, loadPublicProductDetail, publicProductDetailPayload }] = await Promise.all([
          import('~/server/utils/api-response'),
          import('~/server/utils/public-products'),
        ])
        const env = cloudflareEnv(requestEvent)
        const db = env.DB
        if (!db) throw createError({ statusCode: 500, statusMessage: 'Database not available' })
        const previewAuthorized = Boolean(requestEvent.context.previewAuthorized)
        const detail = siteWideSurface
          ? await loadPublicSiteProductDetail(env, db, organizationId, siteWideSurface, previewAuthorized, productSlug, locale, scope.value)
          : await loadPublicProductDetail(env, db, organizationId, routeKind, previewAuthorized, locationSlug, productSlug, locale)
        if (!detail) return null
        return publicProductDetailPayload(db, env, detail)
      }
      const path = siteWideSurface
        ? `/api/public/${siteWideSurface}/${encodeURIComponent(productSlug)}`
        : `/api/public/locations/${encodeURIComponent(locationSlug)}/products/${encodeURIComponent(productSlug)}`
      return publicApiRequest(`${path}?locale=${encodeURIComponent(locale)}${scope.value ? `&location_id=${encodeURIComponent(scope.value)}` : ''}`, {
        signal,
        coalesceKey: `public-product-${organizationId}-${locale}-${locationSlug}-${productSlug}-${scope.value ?? ''}`,
        validate: isPublicProductDetailPayload,
      })
    },
    { server: true, lazy: false },
  )
  if (error.value) {
    const failure = error.value
    if (import.meta.server) throw failure
    throw nuxtApp.runWithContext(() => showError(failure))
  }
  watch(error, (failure) => {
    if (failure) nuxtApp.runWithContext(() => showError(failure))
  }, { flush: 'sync' })
  if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Product not found', fatal: true })
  localeRepresentations.value = data.value.localeRepresentations
  return { organizationId, detail: data as Ref<PublicProductDetailPayload> }
}

/** The same public offering behind a page's explicit product binding. */
export async function usePublicPageProduct(pagePath: ComputedRef<string>, locale: ComputedRef<string>, productId: ComputedRef<string | null>) {
  const nuxtApp = useNuxtApp()
  const route = useRoute()
  const event = useRequestEvent()
  const { id: organizationId } = useTenantOrganization().organization
  const scope = computed(() => typeof route.query.location_id === 'string' ? route.query.location_id : null)
  const { data, error } = await useAsyncData<PublicProductDetailPayload | null>(
    () => `page-product:${organizationId}:${pagePath.value}:${locale.value}:${productId.value}:${scope.value ?? ''}`,
    async (_nuxtApp, { signal }) => {
      if (!productId.value) return null
      if (import.meta.server) {
        if (!event) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
        const [{ cloudflareEnv }, { loadPublicPageProductDetail, publicProductDetailPayload }] = await Promise.all([
          import('~/server/utils/api-response'), import('~/server/utils/public-products'),
        ])
        const env = cloudflareEnv(event)
        const detail = await loadPublicPageProductDetail(env, env.DB, organizationId, Boolean(event.context.previewAuthorized), pagePath.value, locale.value, scope.value)
        return detail ? publicProductDetailPayload(env.DB, env, detail) : null
      }
      return publicApiRequest<PublicProductDetailPayload | null>('/api/public/pages/product', {
        query: { path: pagePath.value, locale: locale.value, ...(scope.value ? { location_id: scope.value } : {}) }, signal,
        validate: (value): value is PublicProductDetailPayload | null => value === null || isPublicProductDetailPayload(value),
      })
    },
  )
  if (error.value) {
    const failure = error.value
    if (import.meta.server) throw failure
    throw nuxtApp.runWithContext(() => showError(failure))
  }
  watch(error, (failure) => {
    if (failure) nuxtApp.runWithContext(() => showError(failure))
  }, { flush: 'sync' })
  return data
}
