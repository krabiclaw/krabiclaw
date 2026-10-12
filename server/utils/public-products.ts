import { getSourceLocale } from '~/server/utils/organization-locales'
import { parseGoogleReviewMetadata, type GoogleReviewMetadata } from '~/shared/google-review'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { bookingWindow, listSessions } from '~/server/utils/availability'
import { getProduct, getProductBySlug, hydrateProductMedia, listCollections, listLocationProducts, listOrganizationProducts } from '~/server/utils/product-management'
import type { Collection, Product, ProductBookingConfig, ProductPresentation, ProductSurface } from '~/server/types/products'
import { isExperience, productSurfaceOf, resolveProductPresentation, presentationForSurface } from '~/utils/product-presentation'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import {
  loadExactPublicLocalizations,
  projectExactLocalizedCollection,
  projectExactLocalizedResource,
  projectLocalizedMediaAlt,
  resolveLocalizedRouteResourceId,
} from '~/server/utils/public-localization'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { parsePostalAddress, type PostalAddress } from '~/utils/postal-address'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { refreshProductBusy } from '~/server/domain/member-scheduling'
import { selectProductCollectionSiblings, type ProductCollectionSibling } from '~/utils/product-seo'
import { getPublicTenantPageForPath } from '~/server/utils/public-tenant-pages'
import { getPublishedTenantPage } from '~/server/utils/content/pages'
import { readStripeCheckoutSetup } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'

interface PublicProductOrganizationRow {
  id: string
  name: string
  vertical: string
  theme_id: string
  default_currency: string
}

export interface PublicProductLocation {
  id: string
  slug: string
  title: string
  /** The zone this branch states its times in — what turns a session into a wall clock. */
  timezone: string | null
  /**
   * Where a guest turns up. Parsed at the row boundary, because a localized
   * page lays its translated address parts over this one and needs an object
   * to lay them on: handed the stored string, the translation replaced it
   * whole and every /th product page lost its regionCode and 500'd.
   */
  address: PostalAddress | null
  phone: string | null
  maps_url: string | null
  latitude: number | null
  longitude: number | null
}

type PublicProductLocationRow = Omit<PublicProductLocation, 'address'> & { address: string | null }

function publicProductLocation(row: PublicProductLocationRow): PublicProductLocation {
  return { ...row, address: parsePostalAddress(row.address) }
}

export interface PublicProductCollection {
  organization: PublicProductOrganizationRow
  currency: CurrencyCode
  presentation: ProductPresentation
  locations: PublicProductLocation[]
  products: Product[]
  /**
   * Site and location collections, in merchandising order. These replace the
   * old per-location category, so a template groups by explicit membership
   * rather than by a column copied onto every product.
   */
  collections: Collection[]
}

/** What the page needs to know about this product's booking capability. */
export type PublicProductBooking = ProductBookingConfig

/** One occurrence, as the product page and its structured data read it. */
export interface PublicProductSession {
  id: string
  starts_at: string
  ends_at: string
  timezone: string
  remaining: number | null
  is_full: boolean
  /** When this occurrence was scheduled, and so when its seats went on sale. */
  created_at: string
}

export interface PublicProductDetail extends PublicProductCollection {
  location: PublicProductLocation | null
  scopeRequired?: boolean
  onlineAvailable?: boolean
  product: Product
  /**
   * Present exactly when the Product takes bookings.
   *
   * The existence of the config row is the capability — not a non-null
   * duration, not the vertical, not a type discriminator. `null` means this
   * page shows no booking affordance at all, which is different from a
   * bookable Product with nothing scheduled.
   */
  booking: PublicProductBooking | null
  localeRepresentations: PublicLocaleRepresentation[]
}

export interface PublicProductDetailPayload {
  product: Product
  location: PublicProductLocation | null
  locations?: PublicProductLocation[]
  scopeRequired?: boolean
  onlineAvailable?: boolean
  currency: CurrencyCode
  vertical: string
  brandName: string
  reviews: PublicProductReview[]
  booking: PublicProductBooking | null
  sessions: PublicProductSession[]
  collectionName: string
  collectionSiblings: ProductCollectionSibling[]
  localeRepresentations: PublicLocaleRepresentation[]
}

export interface PublicProductReview {
  id: string
  author_name: string
  rating: number
  title: string | null
  content: string
  source: string
  original_reference: string | null
  google_review_metadata: GoogleReviewMetadata | null
  original_review_date: string | null
  created_at: string
}

// previewAuthorized carries the site's one preview authorization down from the
// request: a site that has not finished onboarding is readable only with it.
async function loadProductOrganization(db: DbClient, organizationId: string, routeKind: ProductSurface, previewAuthorized: boolean) {
  const organization = await queryFirst<PublicProductOrganizationRow>(db, `
    SELECT id, name, vertical, theme_id, default_currency
      FROM organization
     WHERE id = ? AND ${publicTenantVisibilitySql('organization', previewAuthorized)}
       AND name IS NOT NULL AND trim(name) <> ''
     LIMIT 1
  `, [organizationId])
  if (!organization) return null
  // Supported sites can carry dishes, experiences, services and merchandise.
  const verticalPresentation = resolveProductPresentation(organization.vertical)
  if (!verticalPresentation) return null
  const presentation = presentationForSurface(organization.vertical, routeKind)
  if (presentation.locationCollectionSegment !== routeKind) return null
  if (!isCurrencyCode(organization.default_currency)) throw new Error(`Unsupported organization currency: ${organization.default_currency}`)
  return { organization, presentation, currency: organization.default_currency }
}

export async function loadPublicProductCollection(
  db: DbClient,
  organizationId: string,
  routeKind: ProductSurface,
  previewAuthorized: boolean,
  locationSlug?: string | null,
  env?: CloudflareEnv,
): Promise<PublicProductCollection | null> {
  const resolved = await loadProductOrganization(db, organizationId, routeKind, previewAuthorized)
  if (!resolved) return null
  const locationRows = (await queryAll<PublicProductLocationRow>(db, `
    SELECT id, slug, title, timezone, address, phone, maps_url, latitude, longitude
      FROM business_locations
     WHERE organization_id = ? AND status = 'active'
       ${locationSlug ? 'AND slug = ?' : ''}
     ORDER BY title, id
  `, [organizationId, ...(locationSlug ? [locationSlug] : [])])).map(publicProductLocation)
  if (locationSlug && locationRows.length !== 1) return null
  const locations = locationRows
  if (locationSlug && locations.length !== 1) return null
  const kind = routeKind === 'experiences' ? 'experience' : routeKind === 'menu' ? 'dish' : undefined
  let setup: ReturnType<typeof readStripeCheckoutSetup> | undefined
  const paymentSetup = () => {
    if (!env) throw new Error('The organization environment is required to assess paid booking readiness')
    return setup ??= readStripeCheckoutSetup(db, organizationId, env)
  }
  // Location publication is the public gate here: a product carried by the
  // site but withheld at this branch is absent, not shown greyed out.
  const [catalogProducts, allCollections] = await Promise.all([
    locationSlug
      ? listLocationProducts(db, { organizationId, locationId: locations[0]!.id, kind, publishedOnly: true, env, paymentSetup })
      : listOrganizationProducts(db, { organizationId, kind, publishedOnly: true, env, paymentSetup }),
    listCollections(db, { organizationId }),
  ])
  // Hydrated products already include their location publication flags. Reuse
  // that one catalog rather than hydrating and checking it again per branch.
  const perLocation = locationSlug ? [catalogProducts] : locations.map(location =>
    catalogProducts.filter(product => product.locations.some(entry => entry.location_id === location.id && entry.published)))
  const onlineProducts = locationSlug ? [] : catalogProducts.filter(product => Boolean(product.booking?.online_timezone || product.order_url))
  const seen = new Set<string>()
  // Collections and detail routes use the same explicit product kind.
  const products = await hydrateProductMedia(db, organizationId, [...perLocation.flat(), ...onlineProducts].filter((product) => {
    if (seen.has(product.id)) return false
    seen.add(product.id)
    return productSurfaceOf(resolved.organization.vertical, product) === routeKind
  }))
  const collections = [
    ...allCollections.filter(collection => collection.location_id === null),
    ...locations.flatMap(location => allCollections.filter(collection => collection.location_id === location.id)),
  ]
  return { ...resolved, locations, products, collections }
}

export async function loadPublicProductDetail(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  routeKind: ProductSurface,
  previewAuthorized: boolean,
  locationSlug: string,
  productSlug: string,
  locale?: string,
): Promise<(PublicProductDetail & { location: PublicProductLocation }) | null> {
  const sourceLocale = await getSourceLocale(db, organizationId)
  locale ??= sourceLocale
  if (locale === sourceLocale) {
    const collection = await loadPublicProductCollection(db, organizationId, routeKind, previewAuthorized, locationSlug, env)
    const location = collection?.locations[0]
    if (!collection || !location) return null
    const found = collection.products.find(product => product.slug === productSlug)
    // The product must be published on this site and actually offered at this
    // location: reaching it by slug alone would render a branch's page for
    // something the site withholds, or something that branch does not sell.
    const offeredHere = found?.locations.some(entry => entry.location_id === location.id && entry.published)
    const publishedHere = found?.publications.some(entry => entry.organization_id === organizationId && entry.published)
    const onThisSurface = found ? productSurfaceOf(collection.organization.vertical, found) === routeKind : false
    if (!found || !offeredHere || !publishedHere || !onThisSurface) return null
    const product = found
    if (!product) return null
    const localeRepresentations = await listPublicLocaleRepresentations(env, db, {
      organizationId: collection.organization.id,
      
      sourcePath: collection.presentation.productPath(location.slug, product.slug),
      resource: { type: 'product', id: product.id },
    })
    return {
      ...collection,
      location,
      product,
      booking: product.booking,
      localeRepresentations,
    }
  }

  const resolved = await loadProductOrganization(db, organizationId, routeKind, previewAuthorized)
  if (!resolved) return null
  const localizations = await loadExactPublicLocalizations(env, db, resolved.organization.id, locale)
  const localizedLocationPath = `/${locale}/locations/${locationSlug}`
  const locationId = resolveLocalizedRouteResourceId(localizations, 'business_location', localizedLocationPath)
  if (!locationId) return null
  const sourceLocation = await queryFirst<PublicProductLocationRow>(db, `
    SELECT id, slug, title, timezone, address, phone, maps_url, latitude, longitude FROM business_locations
     WHERE organization_id = ?  AND id = ? AND status = 'active' LIMIT 1
  `, [resolved.organization.id, locationId])
  if (!sourceLocation) return null
  const collection = await loadPublicProductCollection(db, organizationId, routeKind, previewAuthorized, sourceLocation.slug, env)
  const location = collection?.locations[0]
  if (!collection || !location) return null
  // The Product is named by the same slug its English route names: a Product
  // reaches the public through each location that offers it, so its localized
  // route is that location's route under a locale prefix, not a stored path of
  // its own.
  const sourceProduct = collection.products.find(product => product.slug === productSlug)
  const locationLocalization = localizations.find(item => item.resourceType === 'business_location' && item.resourceId === location.id)
  const productLocalization = localizations.find(item => item.resourceType === 'product' && item.resourceId === sourceProduct?.id)
  const organizationLocalization = localizations.find(item => item.resourceType === 'organization' && item.resourceId === organizationId)
  if (!sourceProduct || !locationLocalization || !productLocalization) return null
  const localizedProduct = projectExactLocalizedResource('product', sourceProduct, productLocalization)
  const product = {
    ...localizedProduct,
    image: localizedProduct.image
      ? projectLocalizedMediaAlt([localizedProduct.image], localizations)[0] ?? null
      : null,
    gallery: projectLocalizedMediaAlt(localizedProduct.gallery, localizations),
  }
  const localizedLocation = projectExactLocalizedResource('business_location', location, locationLocalization)
  const localizedOrganization = organizationLocalization
    ? projectExactLocalizedResource('organization', collection.organization, organizationLocalization)
    : { ...collection.organization, name: '' }
  const localeRepresentations = await listPublicLocaleRepresentations(env, db, {
    organizationId: collection.organization.id,
    
    sourcePath: collection.presentation.productPath(location.slug, sourceProduct.slug),
    resource: { type: 'product', id: sourceProduct.id },
  })
  return {
    ...collection,
    organization: localizedOrganization,
    locations: projectExactLocalizedCollection('business_location', collection.locations, localizations),
    products: projectExactLocalizedCollection('product', collection.products, localizations),
    collections: projectExactLocalizedCollection('collection', collection.collections, localizations),
    location: localizedLocation,
    product,
    booking: sourceProduct.booking,
    localeRepresentations,
  }
}

/** One experience page; a guest chooses among its actual booking scopes. */
export async function loadPublicExperienceDetail(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  previewAuthorized: boolean,
  productSlug: string,
  locale?: string,
  requestedScope?: string | null,
): Promise<PublicProductDetail | null> {
  const [sourceLocale, collection] = await Promise.all([
    getSourceLocale(db, organizationId),
    loadPublicProductCollection(db, organizationId, 'experiences', previewAuthorized, undefined, env),
  ])
  locale ??= sourceLocale
  if (!collection) return null
  const found = collection.products.find(product => product.slug === productSlug && isExperience(product))
  if (!found) return null
  return projectPublicOffering(env, db, collection, found, locale, requestedScope, collection.presentation.productPath('', found.slug), sourceLocale)
}

/** An authored page binds its offer by product ID, independent of the theme. */
export async function loadPublicPageProductDetail(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  previewAuthorized: boolean,
  pagePath: string,
  locale?: string,
  requestedScope?: string | null,
): Promise<PublicProductDetail | null> {
  locale ??= await getSourceLocale(db, organizationId)
  const page = previewAuthorized
    ? await getPublicTenantPageForPath(env, db, organizationId, pagePath, { locale, preview: true })
    : await getPublishedTenantPage(db, organizationId, pagePath, locale)
  if (page && !previewAuthorized && page.id !== page.page_id) await loadExactPublicLocalizations(env, db, organizationId, page.locale)
  if (!page?.product_id) return null
  const product = await getProduct(db, organizationId, page.product_id)
  if (!product.locations.some(location => location.published) && !product.booking?.online_timezone && !product.order_url) return null
  const collection = await loadPublicProductCollection(db, organizationId, productSurfaceOf(null, product), previewAuthorized, undefined, env)
  const found = collection?.products.find(product => product.id === page.product_id)
  if (!collection || !found) return null
  return projectPublicOffering(env, db, collection, found, locale, requestedScope, product.page?.path ?? pagePath)
}

async function projectPublicOffering(
  env: CloudflareEnv,
  db: DbClient,
  collection: PublicProductCollection,
  found: Product,
  locale: string,
  requestedScope: string | null | undefined,
  sourcePath: string,
  sourceLocale?: string,
): Promise<PublicProductDetail | null> {
  const organizationId = collection.organization.id
  const offeredAt = new Set(found.locations.filter(entry => entry.published && entry.active).map(entry => entry.location_id))
  const locations = collection.locations.filter(location => offeredAt.has(location.id))
  const onlineAvailable = Boolean(found.booking?.online_timezone)
  let location: PublicProductLocation | null = null
  if (requestedScope && requestedScope !== 'online') {
    location = locations.find(entry => entry.id === requestedScope) ?? null
    if (!location) return null
  } else if (requestedScope === 'online' && !onlineAvailable) return null
  else if (!requestedScope && locations.length === 1 && !onlineAvailable) location = locations[0]!
  const scopeRequired = !requestedScope && locations.length + Number(onlineAvailable) > 1
  let product = found
  let organization = collection.organization
  let localizedLocations = locations
  let products = collection.products
  let collections = collection.collections
  if (locale !== (sourceLocale ?? await getSourceLocale(db, organizationId))) {
    const localizations = await loadExactPublicLocalizations(env, db, organizationId, locale)
    const localized = localizations.find(item => item.resourceType === 'product' && item.resourceId === found.id)
    if (!localized) return null
    product = projectExactLocalizedResource('product', found, localized)
    product = { ...product, image: product.image ? projectLocalizedMediaAlt([product.image], localizations)[0] ?? null : null, gallery: projectLocalizedMediaAlt(product.gallery, localizations) }
    localizedLocations = projectExactLocalizedCollection('business_location', locations, localizations)
    products = projectExactLocalizedCollection('product', collection.products, localizations)
    collections = projectExactLocalizedCollection('collection', collection.collections, localizations)
    if (location) {
      location = localizedLocations.find(entry => entry.id === location!.id) ?? null
      if (!location) return null
    }
    const translatedOrganization = localizations.find(item => item.resourceType === 'organization' && item.resourceId === organizationId)
    if (translatedOrganization) organization = projectExactLocalizedResource('organization', organization, translatedOrganization)
  }
  const localeRepresentations = await listPublicLocaleRepresentations(env, db, {
    organizationId, sourcePath, resource: { type: 'product', id: found.id },
  })
  return { ...collection, organization, products, collections, locations: localizedLocations, location, product, booking: found.booking, scopeRequired, onlineAvailable, localeRepresentations }
}

/** One public response for server rendering and API navigation. */
export async function publicProductDetailPayload(db: DbClient, env: CloudflareEnv, detail: PublicProductDetail): Promise<PublicProductDetailPayload> {
  const memberships = new Set(detail.product.collections.map(entry => entry.collection_id))
  const collection = detail.collections.find(collection => memberships.has(collection.id))
  const [reviews, sessions] = await Promise.all([
    loadPublicProductReviews(db, detail),
    loadPublicProductSessions(db, detail, env),
  ])
  return {
    product: detail.product, location: detail.location, locations: detail.locations,
    scopeRequired: detail.scopeRequired, onlineAvailable: detail.onlineAvailable,
    currency: detail.currency, vertical: detail.organization.vertical, brandName: detail.organization.name,
    reviews,
    booking: detail.booking, sessions,
    collectionName: collection?.name ?? '',
    collectionSiblings: collection ? selectProductCollectionSiblings(detail.products, detail.product, collection.id, { currency: detail.currency, location_id: detail.location?.id ?? null, at: new Date().toISOString() }) : [],
    localeRepresentations: detail.localeRepresentations,
  }
}

export async function loadPublicProductApiCollection(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  previewAuthorized: boolean,
  locationSlug?: string | null,
  locale?: string,
): Promise<PublicProductCollection | null> {
  const organization = await queryFirst<{ vertical: string }>(db, `SELECT vertical FROM organization WHERE id = ? AND ${publicTenantVisibilitySql('organization', previewAuthorized)} LIMIT 1`, [organizationId])
  const presentation = organization ? resolveProductPresentation(organization.vertical) : null
  if (!presentation) return null
  const collection = await loadPublicProductCollection(db, organizationId, presentation.locationCollectionSegment, previewAuthorized, locationSlug, env)
  if (!collection) return null
  if (!locale || locale === await getSourceLocale(db, organizationId)) return collection
  const localizations = await loadExactPublicLocalizations(env, db, organizationId, locale)
  return {
    ...collection,
    products: projectExactLocalizedCollection('product', collection.products, localizations),
    locations: projectExactLocalizedCollection('business_location', collection.locations, localizations),
    collections: projectExactLocalizedCollection('collection', collection.collections, localizations),
  }
}

export async function loadPublicProductApiDetail(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  previewAuthorized: boolean,
  locationSlug: string,
  productSlug: string,
  locale?: string,
): Promise<(PublicProductDetail & { location: PublicProductLocation }) | null> {
  locale ??= await getSourceLocale(db, organizationId)
  const organization = await queryFirst<{ id: string; vertical: string }>(db, `SELECT id, vertical FROM organization WHERE id = ? AND ${publicTenantVisibilitySql('organization', previewAuthorized)} LIMIT 1`, [organizationId])
  const presentation = organization ? resolveProductPresentation(organization.vertical) : null
  if (!organization || !presentation) return null
  // The surface is the Product's own — an Experience answers here too, so its
  // reviews are read and written through the same location-scoped API as every
  // other Product's.
  const product = await getProductBySlug(db, organization.id, productSlug)
  if (!product) return null
  return loadPublicProductDetail(env, db, organizationId, productSurfaceOf(organization.vertical, product), previewAuthorized, locationSlug, productSlug, locale)
}

/**
 * The occurrences of this product a guest can claim a seat on, at this branch.
 *
 * Read here, with the page, so the dates are in the HTML the server sends.
 * Loading them after hydration meant a crawler was told "no availability"
 * about a product with a full calendar, while a browser was shown the truth.
 *
 * Materialized sessions only, scoped to this branch and to the public booking
 * window — the same three facts `/api/public/products/{slug}/sessions` reads,
 * which the page still calls to refresh them. A product that takes no bookings
 * has no calendar to read, so it costs no query.
 */
export async function loadPublicProductSessions(
  db: DbClient,
  detail: PublicProductDetail,
  env: CloudflareEnv,
): Promise<PublicProductSession[]> {
  if (!detail.product.active || !detail.booking || detail.scopeRequired) return []
  // A branch with no zone cannot state when anything starts, so it offers
  // nothing here rather than a time in a zone nobody chose.
  if (!detail.location) {
    if (!detail.booking.online_timezone) return []
    const { listPublicBookingSessions } = await import('~/server/utils/public-session-booking')
    return (await listPublicBookingSessions(db, detail.organization.id, detail.product.slug, env, 'online')).sessions.filter(session => !session.is_full)
  }
  if (!detail.product.locations.some(location => location.location_id === detail.location!.id && location.active && location.published)) return []
  if (!detail.location.timezone) return []
  await refreshProductBusy(db,env,detail.organization.id,detail.product.id)
  const window = bookingWindow(detail.location.timezone)
  const sessions = await listSessions(db, {
    organizationId: detail.organization.id,
    productId: detail.product.id,
    locationId: detail.location.id,
    fromInstant: window.fromInstant,
    toInstant: window.toInstant,
    statuses: ['scheduled'],
  })
  return sessions
    .filter(session => !session.is_full)
    .map(session => ({
      id: session.id,
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      timezone: session.timezone,
      remaining: session.remaining,
      is_full: session.is_full,
      created_at: session.created_at,
    }))
}

/**
 * Approved reviews of this product at the location the page is for: the ones
 * written about the product (a booking review names its product), and the
 * place's Google reviews, which are about the location and name no product.
 * A review of a different product at the same location is not shown. Google
 * reviews carry no title, so a title is optional. Newest written first.
 */
export async function loadPublicProductReviews(
  db: DbClient,
  detail: PublicProductDetail,
): Promise<PublicProductReview[]> {
  const rows = await queryAll<Omit<PublicProductReview, 'google_review_metadata'> & { google_review_metadata: string | null }>(db, `
    SELECT id, author_name, rating, title, content, source, original_reference, google_review_metadata,
           original_review_date, created_at
     FROM reviews
     WHERE organization_id = ? AND status = 'approved'
       AND location_id IS ?
       AND (product_id = ? OR (product_id IS NULL AND source = 'google_places'))
       AND author_name IS NOT NULL AND trim(author_name) <> ''
       AND content IS NOT NULL AND trim(content) <> ''
     ORDER BY COALESCE(original_review_date, created_at) DESC, id DESC
     LIMIT 50
  `, [detail.organization.id, detail.location?.id ?? null, detail.product.id])
  return rows.map(row => ({ ...row, google_review_metadata: parseGoogleReviewMetadata(row.google_review_metadata) }))
}
