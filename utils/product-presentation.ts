import type { Collection, Product, ProductPresentation, ProductSurface } from '~/server/types/products'
import { normalizeVertical } from '~/utils/vertical-copy'
import { isMediaCategory, type MediaCategory } from '~/shared/media-placement-contract'
import { organizationSupportsBlawbyTemplate } from '~/utils/template-registry'

/** Product kind owns its public surface; scheduling is an independent capability. */
export function isExperience(product: Pick<Product, 'kind'>): boolean {
  return product.kind === 'experience'
}

export function productSurfaceOf(_vertical: string | null | undefined, product: Pick<Product, 'kind'>): ProductSurface {
  return product.kind === 'experience' ? 'experiences' : product.kind === 'dish' ? 'menu' : 'products'
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

/** The surface this product is read on, and the paths and words that go with it. */
export function presentationForProduct(vertical: string | null | undefined, product: Pick<Product, 'kind'>, themeId?: string): ProductPresentation {
  return product.kind === 'experience' ? EXPERIENCE_PRESENTATION : product.kind === 'dish' ? requireProductPresentation('restaurant') : requireProductPresentation(product.kind === 'service' ? 'service' : 'experience', themeId)
}

/** The words one surface owns: experiences read the same on every vertical. */
export function presentationForSurface(vertical: string | null | undefined, surface: ProductSurface): ProductPresentation {
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

/** Counts used to name the catalog’s menu, experience and product surfaces. */
export interface CatalogCounts {
  total: number
  experiences: number
  dishes: number
}

export function countCatalog(products: ReadonlyArray<Pick<Product, 'kind'>>): CatalogCounts {
  return { total: products.length, experiences: products.filter(isExperience).length, dishes: products.filter(product => product.kind === 'dish').length }
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
  const forVertical = PHOTO_CATEGORIES_BY_VERTICAL[normalizeVertical(vertical)] ?? PHOTO_CATEGORIES_BY_VERTICAL.service!
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
  if (counts.total > counts.experiences + counts.dishes) surfaces.push('products')
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
    const total = surface === 'experiences' ? counts.experiences : surface === 'menu' ? counts.dishes : counts.total - counts.experiences - counts.dishes
    return `${total} ${(total === 1 ? words.itemLabel : words.itemLabelPlural).toLowerCase()}`
  }).join(' · ')
}

/** The shared catalog routes support every product type. */
export function isCatalogSurface(vertical: string | null | undefined, segment: string): segment is ProductSurface {
  requireProductPresentation(vertical)
  return segment === 'experiences' || segment === 'menu' || segment === 'products'
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

export interface ProductCollectionGroup {
  id: string
  name: string
  description: string | null
  sort_order: number
  /** The location whose collection this is, or null for a site-wide one. */
  location_id: string | null
  products: Product[]
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
export function groupProductsByCollection(
  products: readonly Product[],
  collections: readonly Collection[],
): ProductCollectionGroup[] {
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
