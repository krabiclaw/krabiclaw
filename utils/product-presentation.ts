import type { Collection, Product, ProductPresentation, ProductSurface, SiteProductSurface } from '~/server/types/products'
import { normalizeVertical } from '~/utils/vertical-copy'
import { isMediaCategory, type MediaCategory } from '~/shared/media-placement-contract'
import { organizationSupportsBlawbyTemplate } from '~/utils/template-registry'

/** Product kind owns its public surface; scheduling is an independent capability. */
export function isExperience(product: Pick<Product, 'kind'>): boolean {
  return product.kind === 'experience'
}

export function productSurfaceOf(_vertical: string | null | undefined, product: Pick<Product, 'kind'>): ProductSurface {
  return product.kind === 'experience' ? 'experiences' : product.kind === 'dish' ? 'menu' : product.kind === 'stay' ? 'stays' : 'products'
}

/**
 * Experiences read the same on every vertical, so they have one presentation
 * rather than one per vertical. The page is the site's, not a branch's: an
 * experience is named by its own slug, the way it was printed on the card the
 * guest is holding.
 */
export const EXPERIENCE_PRESENTATION: ProductPresentation = {
  feature: 'products',
  collectionPath: '/experiences',
  locationCollectionSegment: 'experiences',
  productPath: (_locationSlug, productSlug) => `/experiences/${encodeURIComponent(productSlug)}`,
  collectionLabel: 'Experiences',
  itemLabel: 'Experience',
  itemLabelPlural: 'Experiences',
  collectionGroupLabel: 'Collection',
  collectionGroupLabelPlural: 'Collections',
  // A class that runs at a stated time on stated dates is an Event, not a
  // Product. It is what Google's date-and-time result reads, and a Product node
  // can never win one. The page reads this down to Product for the one
  // experience with nothing scheduled, which has no startDate to state.
  structuredDataType: 'Event',
}

/**
 * A place to stay reads the same on every vertical. Its page is the site's,
 * named by its own slug: a home is the listing a guest books, not a branch's
 * product. schema.org calls it an Accommodation.
 */
export const STAY_PRESENTATION: ProductPresentation = {
  feature: 'products',
  collectionPath: '/stays',
  locationCollectionSegment: 'stays',
  productPath: (_locationSlug, productSlug) => `/stays/${encodeURIComponent(productSlug)}`,
  collectionLabel: 'Places to stay',
  itemLabel: 'Place to stay',
  itemLabelPlural: 'Places to stay',
  collectionGroupLabel: 'Collection',
  collectionGroupLabelPlural: 'Collections',
  structuredDataType: 'Accommodation',
}

/**
 * The catalog sections a site's navigation offers, in order, each only when
 * the site has something on it, linked where the site's vertical lists them.
 * Header, footer and sitemap read this one list.
 */
export function catalogNavigation(vertical: string | null | undefined, sections: Partial<Record<ProductSurface, boolean>> | null): Array<{ surface: ProductSurface, path: string, labelKey: string }> {
  const order: ProductSurface[] = ['menu', 'products', 'stays', 'experiences']
  return order.filter(surface => sections?.[surface] === true)
    .map(surface => ({ surface, path: presentationForSurface(vertical, surface).collectionPath, labelKey: `saya.footer.${surface}` }))
}

/** Where a location's items on one surface are listed. Homes have no branch index; they are listed site-wide. */
export function locationSurfacePath(locationSlug: string, surface: ProductSurface): string {
  return surface === 'stays' ? STAY_PRESENTATION.collectionPath : `/locations/${encodeURIComponent(locationSlug)}/${surface}`
}

/**
 * A location's public page. A location that holds one home and nothing else
 * is that home, so its page is the home's listing.
 */
export function publicLocationPath(location: { slug: string, home_slug?: string | null }): string {
  return location.home_slug
    ? STAY_PRESENTATION.productPath('', location.home_slug)
    : `/locations/${encodeURIComponent(location.slug)}`
}

/** The site-wide item page a path names — /experiences/<slug> or /stays/<slug> — or null. */
export function parseSiteProductPath(path: string): { surface: SiteProductSurface, slug: string } | null {
  const match = /^\/(experiences|stays)\/([^/]+)$/.exec(path)
  if (!match) return null
  let slug: string
  try {
    slug = decodeURIComponent(match[2]!)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
  return { surface: match[1] as SiteProductSurface, slug }
}

/** The i18n key for a product card's call to action, by the product's own kind. */
export function productCtaKey(kind: string | null | undefined): string {
  return kind === 'experience' ? 'saya.common.view_experience'
    : kind === 'dish' ? 'saya.common.view_dish'
      : kind === 'stay' ? 'stay.check_availability'
        : 'saya.common.view_item'
}

/** The surface this product is read on, and the paths and words that go with it. */
export function presentationForProduct(vertical: string | null | undefined, product: Pick<Product, 'kind'>, themeId?: string): ProductPresentation {
  if (product.kind === 'stay') return STAY_PRESENTATION
  return product.kind === 'experience' ? EXPERIENCE_PRESENTATION : product.kind === 'dish' ? requireProductPresentation('restaurant') : requireProductPresentation(product.kind === 'service' ? 'service' : 'experience', themeId)
}

/** The words one surface owns: experiences read the same on every vertical. */
export function presentationForSurface(vertical: string | null | undefined, surface: ProductSurface): ProductPresentation {
  if (surface === 'stays') return STAY_PRESENTATION
  return surface === 'experiences' ? EXPERIENCE_PRESENTATION : surface === 'menu' ? requireProductPresentation('restaurant') : requireProductPresentation(normalizeVertical(vertical) === 'service' ? 'service' : 'experience')
}

export function resolveProductPresentation(vertical: string | null | undefined, themeId?: string): ProductPresentation | null {
  if (vertical === null || vertical === undefined || vertical.trim() === '') return null
  const normalized = normalizeVertical(vertical)
  if (normalized === 'restaurant') {
    return {
      feature: 'products',
      collectionPath: '/menu',
      locationCollectionSegment: 'menu',
      productPath: (locationSlug, productSlug) => `/locations/${encodeURIComponent(locationSlug)}/menu/${encodeURIComponent(productSlug)}`,
      collectionLabel: 'Menu',
      itemLabel: 'Dish',
      itemLabelPlural: 'Dishes',
      collectionGroupLabel: 'Section',
      collectionGroupLabelPlural: 'Sections',
      structuredDataType: 'MenuItem',
    }
  }
  if (normalized === 'experience' || normalized === 'service' || normalized === 'lodging') {
    return {
      feature: 'products',
      collectionPath: '/products',
      locationCollectionSegment: 'products',
      productPath: (locationSlug, productSlug) => `/locations/${encodeURIComponent(locationSlug)}/products/${encodeURIComponent(productSlug)}`,
      collectionLabel: organizationSupportsBlawbyTemplate({ vertical, themeId }) ? 'Services' : 'Products',
      itemLabel: organizationSupportsBlawbyTemplate({ vertical, themeId }) ? 'Service' : 'Product',
      itemLabelPlural: organizationSupportsBlawbyTemplate({ vertical, themeId }) ? 'Services' : 'Products',
      collectionGroupLabel: 'Collection',
      collectionGroupLabelPlural: 'Collections',
      structuredDataType: 'Product',
    }
  }
  return null
}

export function requireProductPresentation(vertical: string | null | undefined, themeId?: string): ProductPresentation {
  const presentation = resolveProductPresentation(vertical, themeId)
  if (!presentation) throw new Error(`Products are not presented for vertical: ${normalizeVertical(vertical)}`)
  return presentation
}

export function productLocationCollectionPath(vertical: string | null | undefined, locationSlug: string): string {
  const presentation = requireProductPresentation(vertical)
  return `/locations/${encodeURIComponent(locationSlug)}/${presentation.locationCollectionSegment}`
}

/** Counts used to name the catalog’s menu, experience, stay and product surfaces. */
export interface CatalogCounts {
  total: number
  experiences: number
  dishes: number
  stays: number
}

export function countCatalog(products: ReadonlyArray<Pick<Product, 'kind'>>): CatalogCounts {
  return {
    total: products.length,
    experiences: products.filter(isExperience).length,
    dishes: products.filter(product => product.kind === 'dish').length,
    stays: products.filter(product => product.kind === 'stay').length,
  }
}

/**
 * The photo categories a vertical actually has. The column stores one of a
 * fixed set, but which of them mean anything is the tenant's business: a law
 * firm was offered "Food" and "Menu" filters because the list was written out
 * by hand in the photos page.
 *
 * A category already stored on an asset is always offered, whatever the
 * vertical — a site that changed vertical, or media added over MCP, must not
 * have pictures that no filter can reach.
 */
// The tenant's word for each subject the column can hold. Keyed by the shared
// list, so a category added there must be named here or this stops compiling.
const PHOTO_CATEGORY_LABELS: Record<MediaCategory, string> = {
  exterior: 'Exterior',
  interior: 'Interior',
  food: 'Food',
  menu: 'Menu',
  team: 'Team',
  other: 'Other',
  logo: 'Logo',
  blog: 'Article',
}

/** Which subjects each vertical is offered. Only a restaurant plates food. */
const PHOTO_CATEGORIES_BY_VERTICAL: Record<string, readonly MediaCategory[]> = {
  restaurant: ['exterior', 'interior', 'food', 'menu', 'team', 'other'],
  experience: ['exterior', 'interior', 'team', 'other'],
  service: ['exterior', 'interior', 'team', 'other'],
  lodging: ['exterior', 'interior', 'team', 'other'],
}

export function photoCategories(
  vertical: string | null | undefined,
  stored: Iterable<string | null | undefined> = [],
): Array<{ id: MediaCategory, label: string }> {
  const forVertical = PHOTO_CATEGORIES_BY_VERTICAL[vertical ? normalizeVertical(vertical) : 'service'] ?? PHOTO_CATEGORIES_BY_VERTICAL.service!
  const ids = [...forVertical]
  // A subject already on an asset is always offered, whatever the vertical: a
  // site that changed vertical, or media added over MCP, must not have pictures
  // no filter can reach.
  for (const category of stored) {
    if (isMediaCategory(category) && !ids.includes(category)) ids.push(category)
  }
  return ids.map(id => ({ id, label: PHOTO_CATEGORY_LABELS[id] }))
}

export const CATALOG_LABEL = 'Catalog'

/** Nonempty surfaces follow the products’ explicit types. */
export function catalogSurfaces(vertical: string | null | undefined, counts: CatalogCounts): ProductSurface[] {
  const own = requireProductPresentation(vertical).locationCollectionSegment
  const surfaces: ProductSurface[] = []
  if (counts.dishes > 0) surfaces.push('menu')
  if (counts.total > counts.experiences + counts.dishes + counts.stays) surfaces.push('products')
  if (counts.stays > 0) surfaces.push('stays')
  if (counts.experiences > 0) surfaces.push('experiences')
  return surfaces.length > 0 ? surfaces : [own]
}

/** What to call the whole catalog: one surface speaks for it, two do not. */
export function catalogLabel(vertical: string | null | undefined, counts: CatalogCounts): string {
  const surfaces = catalogSurfaces(vertical, counts)
  return surfaces.length === 1 ? presentationForSurface(vertical, surfaces[0]!).collectionLabel : CATALOG_LABEL
}

/**
 * The catalog counted in the merchant's own words, one count per surface:
 * "24 dishes · 3 experiences". Plurals are each presentation's own, because
 * appending an "s" is how "dishs" reaches a merchant's screen.
 */
export function catalogSummary(vertical: string | null | undefined, counts: CatalogCounts): string {
  const surfaces = catalogSurfaces(vertical, counts)
  if (counts.total === 0) return `Add your first ${presentationForSurface(vertical, surfaces[0]!).itemLabel.toLowerCase()}`
  return surfaces.map((surface) => {
    const words = presentationForSurface(vertical, surface)
    const total = surface === 'experiences' ? counts.experiences : surface === 'menu' ? counts.dishes : surface === 'stays' ? counts.stays : counts.total - counts.experiences - counts.dishes - counts.stays
    return `${total} ${(total === 1 ? words.itemLabel : words.itemLabelPlural).toLowerCase()}`
  }).join(' · ')
}

/** The shared catalog routes support every product type. */
export function isCatalogSurface(vertical: string | null | undefined, segment: string): segment is ProductSurface {
  requireProductPresentation(vertical)
  return segment === 'experiences' || segment === 'menu' || segment === 'products' || segment === 'stays'
}

/** Collections appear on each surface represented by their members. Empty collections remain editable. */
export function collectionsOnSurface<
  P extends Pick<Product, 'kind'>,
  T extends { products: readonly P[] },
>(
  vertical: string | null | undefined,
  rows: readonly T[],
  surface: ProductSurface,
): Array<T & { products: P[] }> {
  return rows.flatMap((row) => {
    const products = row.products.filter(product => productSurfaceOf(vertical, product) === surface)
    if (row.products.length > 0 && products.length === 0) return []
    return [{ ...row, products }]
  })
}

export interface ProductCollectionGroup<T extends Pick<Product, 'id' | 'name' | 'collections'> = Product> {
  id: string
  name: string
  description: string | null
  /** The section's own picture, which introduces it; null when it has none. */
  image: Collection['image']
  sort_order: number
  /** The location whose collection this is, or null for a site-wide one. */
  location_id: string | null
  products: T[]
}

/**
 * One group per collection, in the merchant's order, with the product order
 * they chose inside it.
 *
 * A product in two collections appears in both, once each — that is what
 * membership means. Products in no collection are not silently dropped into an
 * "other" bucket they were never put in; they are simply not grouped, because
 * a grouping built from collections has nowhere to put them.
 *
 * Both the collection page and the home page's preview read their order from
 * here, so the order a merchant arranges is the order every surface shows.
 */
export function groupProductsByCollection<T extends Pick<Product, 'id' | 'name' | 'collections'>>(
  products: readonly T[],
  collections: readonly Collection[],
): ProductCollectionGroup<T>[] {
  const positionFor = new Map<string, Map<string, number>>()
  for (const product of products) {
    for (const membership of product.collections) {
      const positions = positionFor.get(membership.collection_id) ?? new Map<string, number>()
      positions.set(product.id, membership.sort_order)
      positionFor.set(membership.collection_id, positions)
    }
  }
  return collections
    .map((collection) => {
      const positions = positionFor.get(collection.id)
      return {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        image: collection.image,
        sort_order: collection.sort_order,
        location_id: collection.location_id,
        products: positions
          ? products
              .filter(product => positions.has(product.id))
              .sort((left, right) => (positions.get(left.id)! - positions.get(right.id)!) || left.name.localeCompare(right.name))
          : [],
      }
    })
    .filter(group => group.products.length > 0)
}

/** A home's size the way Airbnb lists it under the title: "2 guests · Studio · 1 bed · 1 bath". */
export function staySpecLabels(stay: { max_guests: number; bedrooms: number | null; beds: number | null; bathrooms: number | null }, t: (key: string, plural: number) => string): string[] {
  return [
    t('stay.sleeps', stay.max_guests),
    ...(stay.bedrooms === null ? [] : [stay.bedrooms === 0 ? t('stay.studio', 1) : t('stay.bedrooms', stay.bedrooms)]),
    ...(stay.beds === null ? [] : [t('stay.beds', stay.beds)]),
    ...(stay.bathrooms === null ? [] : [t('stay.bathrooms', stay.bathrooms)]),
  ]
}
