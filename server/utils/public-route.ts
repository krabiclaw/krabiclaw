import { HTTPError, type H3Event } from 'nitro'
import { setHeader } from 'nitro/h3'
import { executeBatch, queryFirst } from '~/server/db'
import { selectPrice } from '~/shared/prices'
import { cloudflareEnv } from '~/server/utils/api-response'
import { bookingPolicy, formatBookingPolicySummary } from '~/server/utils/booking-policy-summary'
import { getPublishedBlogPost } from '~/server/utils/content/publishing'
import { listQa } from '~/server/utils/location-qa'
import { assertExactCanonicalLocale, publicTenantLocaleNames, readPublicOrganizationLanguage, readPublicSourceLocale } from '~/server/utils/localization'
import { mediaPlacementsQuery, toResolvedMediaAsset, type MediaAsset } from '~/server/utils/media-asset-manager'
import { preparePublicLocationReviews, readPublicLocationReviews, visiblePublicReview } from '~/server/utils/organization-reviews'
import { hydrateProductMedia, listCollections, listOrganizationProducts, publicProduct } from '~/server/utils/product-management'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { loadPublicBase } from '~/server/utils/public-base'
import { listPublicLocaleRepresentations, publicResourceLocaleQuery, type LocalizedRouteCandidate } from '~/server/utils/public-locale-representations'
import { indexStoredPublicLocalizations, loadExactPublicLocalizations, preloadedPublicLocalizations, projectExactLocalizedCollection, projectLocalizedMediaAlt, resolveLocalizedRouteResourceId } from '~/server/utils/public-localization'
import { publicLocationSql } from '~/server/utils/public-locations'
import { preparePublicCollectionRows, publicDocumentCollectionKind, readPublicShellRows } from '~/server/utils/public-shell-query'
import { getPublicTenantPageForPath } from '~/server/utils/public-tenant-pages'
import type { PublicMenuProduct, PublicProduct } from '~/server/types/products'
import { siteRendersPageDocumentAt } from '~/shared/tenant-page-paths'
import { hasPublicLocationPages, resolvePublicSite } from '~/utils/site-routing'
import { RESOURCE_LOCALIZATIONS_SQL } from '~/shared/content-registries'

const pages = new Set(['home', 'locations', 'location', 'about', 'contact', 'reservations', 'qa', 'reviews', 'posts', 'photos', 'menu', 'products', 'experiences', 'stays', 'blog'])
const datasets = new Set(['content', 'location', 'products', 'reviews', 'photos', 'qa', 'menu_cards', 'blog_post'])
const slugPattern = /^[a-z0-9_-]+$/
const photoCategories = new Set(['EXTERIOR', 'INTERIOR', 'FOOD', 'MENU', 'TEAM'])
type MediaRow = MediaAsset & { product_id: string; slot: string }
type Location = { id: string; slug: string; title: string; rating: number | null; review_count: number | null; last_synced_at: string | null }
type LocationDocumentRoute = { slug: string; page: string; locale: string | undefined }

export function preparePublicLocationDocument(organization: { sql: string }, route: LocationDocumentRoute) {
  const { slug, page, locale } = route
  const locationSql = `FROM business_locations bl WHERE bl.organization_id = ${organization.sql} AND ${publicLocationSql('bl')}
    AND ${locale ? `bl.id = (SELECT rl.resource_id FROM ${RESOURCE_LOCALIZATIONS_SQL} rl
      WHERE rl.organization_id = bl.organization_id AND rl.resource_type = 'business_location'
        AND rl.locale = ? AND rl.route_path = ?)` : 'bl.slug = ?'} LIMIT 1`
  const params = locale ? [locale, `/${locale}/locations/${slug}`] : [slug]
  const scope = { sql: `(SELECT bl.id ${locationSql})`, params }
  const collection = page === 'menu' ? preparePublicCollectionRows(organization, 'dish', false, scope) : null
  const reviews = page === 'reviews' ? preparePublicLocationReviews(organization, scope) : null
  return {
    queries: [
      { query: `SELECT bl.id, bl.slug, bl.title, bl.rating, bl.review_count, bl.last_synced_at ${locationSql}`, params },
      publicResourceLocaleQuery(organization, 'business_location', scope, ''),
      ...(collection?.queries ?? reviews?.queries ?? []),
    ],
    read([locationRows, localizedRows, ...contentRows]: D1Result[], organizationId: string) {
      const location = locationRows!.results[0] as Location | undefined
      const catalog = collection?.read(contentRows)
      return {
        ...route, organizationId, location,
        candidates: localizedRows!.results as LocalizedRouteCandidate[],
        collection: catalog ? { ...catalog, collections: catalog.collections.filter(row => row.location_id === null || row.location_id === location?.id) } : null,
        reviews: reviews && location ? reviews.read(contentRows, organizationId, location) : null,
      }
    },
  }
}

export async function readPublicRoute(
  event: H3Event, organizationId: string, query: Record<string, string | undefined>,
  { signal, api = false }: { signal?: AbortSignal; api?: boolean } = {},
) {
  const page = query.page ?? 'home'
  const slug = query.location
  const requested = new Set(query.datasets ? query.datasets.split(',') : [])
  const menuCards = requested.has('menu_cards')
  const includesProducts = menuCards || requested.has('products')
  const blogSlug = query.blogSlug
  if (!pages.has(page) || [...requested].some(dataset => !datasets.has(dataset))
    || (slug && !slugPattern.test(slug)) || (blogSlug && !slugPattern.test(blogSlug))
    || (menuCards && (page !== 'menu' || requested.has('products')))) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid public page query' })
  }
  signal?.throwIfAborted()
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })
  const locale = query.locale === undefined ? undefined : assertExactCanonicalLocale(query.locale)
  const preview = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env))
  if (api) setHeader(event, 'cache-control', preview ? 'private, no-store' : 'public, max-age=60, stale-while-revalidate=300')
  const [{ organization }, source] = await Promise.all([
    loadPublicBase(event, organizationId, { previewAuthorized: preview }),
    readPublicSourceLocale(event, db, organizationId),
  ])
  if ((slug || page === 'locations') && !hasPublicLocationPages(organization.vertical)) throw new HTTPError({ statusCode: 404, statusMessage: 'Page not found' })
  const language = await readPublicOrganizationLanguage(event, db, organizationId, locale ?? source.locale, source)
  const documentLocation = event.context.publicLocationDocument as ReturnType<ReturnType<typeof preparePublicLocationDocument>['read']> | undefined
  const locationDocument = !preview && documentLocation?.organizationId === organizationId && documentLocation?.slug === slug
    && documentLocation.page === page && (documentLocation.locale ?? source.locale) === language.locale ? documentLocation : undefined
  const stored = language.source ? undefined : preloadedPublicLocalizations(event, organizationId, language.locale)
  const translations = language.source ? []
    : stored ? indexStoredPublicLocalizations(stored) : await loadExactPublicLocalizations(env, db, organizationId, language.locale)
  const localizedId = slug && !language.source
    ? resolveLocalizedRouteResourceId(translations, 'business_location', `/${language.locale}/locations/${slug}`)
    : null
  if (slug && !language.source && !localizedId) throw new HTTPError({ statusCode: 404, statusMessage: 'Localized location was not found' })

  const previewMenu = preview && organization.vertical === 'restaurant'
  const collectionKind = includesProducts && (page === 'menu' || page === 'reservations') ? publicDocumentCollectionKind(`/${page}`) : undefined
  const globalReviews = requested.has('reviews') && !slug
  const kind = page === 'experiences' ? 'experience' : page === 'stays' ? 'stay' : undefined
  // These documents already have the queries in the tenant batch. The shell and
  // page consume the same results. Other routes call their own readers directly.
  const documentRows = !slug && (globalReviews || collectionKind || (includesProducts && kind === 'experience'))
    ? readPublicShellRows(event, db, organization, language.locale, previewMenu, globalReviews, collectionKind)
    : null
  const location = locationDocument ? locationDocument.location : slug ? await queryFirst<Location>(db, `
    SELECT bl.id, bl.slug, bl.title, bl.rating, bl.review_count, bl.last_synced_at
    FROM business_locations bl WHERE bl.organization_id = ?
      AND bl.${localizedId ? 'id' : 'slug'} = ? AND ${publicLocationSql('bl')} LIMIT 1
  `, [organizationId, localizedId ?? slug]) : null
  if (slug && !location) throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  const locationsRead = !includesProducts ? [] : location ? [location] : documentRows
    ? documentRows.then(({ results, indexes }) => results[indexes.locations]!.results as Location[])
    : executeBatch(db, [{
      query: `SELECT bl.id, bl.slug, bl.title FROM business_locations bl WHERE bl.organization_id = ? AND ${publicLocationSql('bl')}`,
      params: [organizationId],
    }], { operation: 'Read catalog locations' }).then(([rows]) => rows!.results as Location[])
  signal?.throwIfAborted()

  const sourcePath = location ? `/locations/${location.slug}${page === 'location' ? '' : `/${page}`}` : page === 'home' ? '/' : `/${page}`
  const site = resolvePublicSite({ themeId: organization.theme_id })
  const documentPath = requested.has('content') ? page === 'location' && siteRendersPageDocumentAt(site, sourcePath)
    ? sourcePath : site.pageDocuments.recipes[page] ?? null : null
  const loadRepresentations = () => listPublicLocaleRepresentations(env, db, {
    organizationId, sourcePath, sourceLocale: source, publishedLocaleRoute: !location,
    publishedLocales: publicTenantLocaleNames(event, organizationId),
    candidates: locationDocument?.candidates,
    ...(location ? { resource: { type: 'business_location' as const, id: location.id, routeSuffix: page === 'location' ? '' : `/${page}` } } : {}),
  })
  const collectionRead = !includesProducts ? null : collectionKind
    ? locationDocument?.collection ?? (documentRows ? documentRows.then(value => value.collection!) : readScopedCollection(collectionKind))
    : readCatalog()
  const fullLocationReviews = page !== 'location'
  const [catalog, reviewRows, media, qa, tenantPage, article, routeRepresentations, locations] = await Promise.all([
    collectionRead,
    location && requested.has('reviews') ? locationDocument?.reviews ?? readPublicLocationReviews(db, organizationId, location, fullLocationReviews)
      : globalReviews && documentRows ? documentRows.then(({ results, indexes }) => ({
        reviews: (results[indexes.reviews!]!.results as Record<string, unknown>[]).map(visiblePublicReview), aggregate: null,
      })) : { reviews: [], aggregate: null },
    requested.has('photos') ? readPhotos() : [],
    requested.has('qa') ? listQa(db, organizationId, location?.id ?? null, true, null, language.locale) : [],
    documentPath ? getPublicTenantPageForPath(env, db, organizationId, documentPath, { locale, preview, localizations: language.source ? null : translations }) : null,
    blogSlug && requested.has('blog_post') ? getPublishedBlogPost(db, organizationId, 'blog', blogSlug, language.locale, env, preview) : null,
    !documentPath || location ? loadRepresentations() : null,
    locationsRead,
  ])
  signal?.throwIfAborted()
  if (documentPath && !tenantPage && locale && !language.source && !preview
    && page !== 'location' && !site.pageDocuments.optionalLocalizedPaths.includes(documentPath)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Localized page was not found' })
  }
  if (blogSlug && !article && !language.source) throw new HTTPError({ statusCode: 404, statusMessage: 'Localized blog post was not found' })

  const active = new Set(locations.map(row => row.id))
  const sourceProducts = (catalog?.products ?? []).filter(product => product.locations.some(binding =>
    (binding.published || (previewMenu && page === 'menu')) && active.has(binding.location_id) && (!location || location.id === binding.location_id))
    || (!location && (product.kind === 'stay' || Boolean(product.order_url || product.booking?.held_online))))
  const byProduct = new Map<string, MediaRow[]>()
  for (const row of (catalog?.media ?? []) as MediaRow[]) {
    const rows = byProduct.get(row.product_id) ?? []
    rows.push(row)
    byProduct.set(row.product_id, rows)
  }
  const products = localizeProducts(sourceProducts).map(product => {
    const rows = byProduct.get(product.id)
    const cover = rows?.find(item => item.slot === 'image')
    const image = rows ? cover ? toResolvedMediaAsset(cover) : null : product.image
    const gallery = rows ? rows.filter(item => item.slot === 'gallery').map(toResolvedMediaAsset) : product.gallery
    return publicProduct({ ...product, image: image ? projectLocalizedMediaAlt([image], translations)[0] ?? null : null, gallery: projectLocalizedMediaAlt(gallery, translations) })
  })
  return {
    kind: page, success: true, tenant_page: tenantPage, products: menuCards ? products.map(menuProduct) : products,
    collections: language.source ? catalog?.collections ?? [] : projectExactLocalizedCollection('collection', catalog?.collections ?? [], translations),
    location_reviews: location ? reviewRows.reviews.slice(0, 3) : [],
    global_reviews: globalReviews ? reviewRows.reviews : [],
    reviews_aggregate: reviewRows.aggregate,
    reviews_list: location && fullLocationReviews ? reviewRows.reviews : [],
    media, qa_list: qa, blog_post: article,
    table_policy_summaries: Object.fromEntries(products.flatMap(product => {
      if (product.kind !== 'table' || !product.booking) return []
      const currency = organization.default_currency
      if (!currency) throw new HTTPError({ statusCode: 500, statusMessage: 'Organization currency is not configured' })
      const variant = product.variants.find(candidate => candidate.active)
      const price = variant ? selectPrice(variant.prices, { currency, location_id: product.locations.find(binding => binding.published)?.location_id ?? null }) : null
      return [[product.id, formatBookingPolicySummary(bookingPolicy(product.booking, price), language.locale, product.kind)]]
    })),
    locale_representations: (article && 'locale_representations' in article ? article.locale_representations : null)
      ?? routeRepresentations ?? tenantPage?.locale_representations ?? await loadRepresentations(),
  }

  async function readScopedCollection(kind: NonNullable<typeof collectionKind>) {
    const plan = preparePublicCollectionRows(organizationId, kind, previewMenu, location?.id)
    return plan.read(await executeBatch(db, plan.queries, { operation: 'Read public collection' }))
  }

  async function readCatalog() {
    const [items, collections] = await Promise.all([
      kind === 'experience' && documentRows ? documentRows.then(row => row.experiences)
        : listOrganizationProducts(db, { organizationId, locationId: location?.id, kind, publishedOnly: true, env }),
      listCollections(db, { organizationId }),
    ])
    return {
      products: await hydrateProductMedia(db, organizationId, items),
      collections: location ? collections.filter(row => row.location_id === null || row.location_id === location.id) : collections,
      media: [],
    }
  }

  function localizeProducts<T extends (typeof sourceProducts)[number]>(products: T[]): T[] {
    if (language.source) return products
    if (page !== 'reservations') return projectExactLocalizedCollection('product', products, translations)
    const places = projectExactLocalizedCollection('business_location', locations, translations)
    return products.flatMap(product => {
      const place = places.find(row => product.locations.some(binding => binding.location_id === row.id && binding.published && binding.active))
      return place ? [{ ...product, name: place.title }] : []
    })
  }

  async function readPhotos() {
    const plan = mediaPlacementsQuery({ organizationId, ownerType: 'business_location', slot: 'gallery',
      owners: location ? [location.id] : { sql: `SELECT bl.id FROM business_locations bl WHERE bl.organization_id = ? AND ${publicLocationSql('bl')}`, params: [organizationId] } })
    const [result] = await executeBatch(db, [{
      ...plan, query: `SELECT * FROM (${plan.query}) WHERE kind = 'image' ORDER BY owner_id, sort_order, placement_id LIMIT 100`,
    }], { operation: 'Read public gallery' })
    const photos = (result!.results as (MediaAsset & { placement_id: string; owner_id: string; owner_type: string; slot: string; sort_order: number })[]).map(row => {
      const category = row.category?.toUpperCase()
      return {
        ...toResolvedMediaAsset(row), asset_id: row.id, placement_id: row.placement_id, owner_type: row.owner_type,
        owner_id: row.owner_id, slot: row.slot, category: category && photoCategories.has(category) ? category : 'OTHER', sort_order: row.sort_order,
      }
    })
    return projectLocalizedMediaAlt(photos, translations)
  }
}

function menuProduct(product: PublicProduct): PublicMenuProduct {
  const { id, kind, name, slug, description, active, details, locations, collections, image,
    order_url, updated_at, booking, page, variants } = product
  if (kind !== 'dish') throw new Error('The menu contains a product that is not a dish')
  return {
    id, kind, name, slug, description, active, locations, collections, image, order_url, updated_at, stay: null,
    details: Object.fromEntries(Object.entries(details).filter(([key]) => ['pricing_note', 'featured', 'dietary_notes'].includes(key))),
    booking: booking ? { held_online: booking.held_online, duration_minutes: booking.duration_minutes, default_capacity: booking.default_capacity } : null,
    page: page ? { path: page.path } : null,
    variants: variants.map(({ id, name, active, prices }) => ({
      id, name, active,
      prices: prices.map(({ id, active, currency, location_id, type, recurring_interval, recurring_interval_count, valid_from_at,
        valid_until_at, unit_amount, compare_at_unit_amount }) => ({ id, active, currency, location_id, type, recurring_interval,
        recurring_interval_count, valid_from_at, valid_until_at, unit_amount, compare_at_unit_amount })),
    })),
  }
}
