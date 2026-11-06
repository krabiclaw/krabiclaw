import type { OrganizationVertical } from '~/utils/vertical-copy'
import { isLegalPractice, type SiteSurface } from '~/utils/site-routing'
import { resolveProductPresentation } from '~/utils/product-presentation'

export type CmsSectionId = 'pages' | 'collections' | 'locations' | 'media' | 'organization'

// Explicit module identifiers a vertical/site/site/location can turn on.
// 'consultations' and 'appointments' are declared (not yet wired to any catalog entry below) because
// no distinct manager/route exists for them yet, and a legal practice's practice management lives
// entirely on the single 'services' page. Reservation policies belong to locations because every
// reservation is location-owned. Booking is a capability of a Product, configured where the
// Product is, so it needs no module of its own. Wire distinct manager entries only when their
// routes provide distinct customer-facing UX.
export type ProductFeature =
  | 'contact' | 'locations' | 'settings'
  | 'products' | 'reservations'
  | 'services' | 'consultations' | 'appointments'
  | 'blog' | 'qa' | 'reviews' | 'posts' | 'photos'
  | 'stays'

export interface CmsPageCapability {
  id: string
  feature: ProductFeature
  label: string
  route: string
  scope: 'organization' | 'location'
  editor: 'tenant_pages'
}

export interface CmsManagerCapability {
  /** Unique across the whole registry, e.g. 'organization.qa' vs 'location.qa' — two distinct managers
   *  that happen to share a feature id. Always `${scope}.${id}`. */
  key: string
  id: ProductFeature
  label: string
  section: Exclude<CmsSectionId, 'pages'>
  route: string
  scope: 'organization' | 'location'
}

export interface CmsCapabilityDefinition {
  vertical: OrganizationVertical
  site: SiteSurface
  locationVocabulary: 'location' | 'office/service area'
  pages: readonly CmsPageCapability[]
  managers: readonly CmsManagerCapability[]
  features: readonly ProductFeature[]
}

interface CmsSiteCatalog {
  pages: readonly CmsPageCapability[]
  managers: readonly CmsManagerCapability[]
  locationVocabularyDefault: 'location' | 'office/service area'
}

// One customer catalog; domain features select the applicable editors.
const customerSiteCatalog: CmsSiteCatalog = {
  pages: [
    { id: 'home', feature: 'contact', label: 'Home', route: '/', scope: 'organization', editor: 'tenant_pages' },
    { id: 'about', feature: 'contact', label: 'About', route: '/about', scope: 'organization', editor: 'tenant_pages' },
    { id: 'contact', feature: 'contact', label: 'Contact', route: '/contact', scope: 'organization', editor: 'tenant_pages' },
    { id: 'location', feature: 'locations', label: 'Location', route: '/locations/:location', scope: 'location', editor: 'tenant_pages' },
    { id: 'products', feature: 'products', label: 'Products', route: '/products', scope: 'organization', editor: 'tenant_pages' },
    { id: 'reservations', feature: 'reservations', label: 'Reservations', route: '/reservations', scope: 'organization', editor: 'tenant_pages' },
    { id: 'services', feature: 'services', label: 'Practice areas & consultations', route: '/services', scope: 'organization', editor: 'tenant_pages' },
    { id: 'pricing', feature: 'services', label: 'Pricing', route: '/pricing', scope: 'organization', editor: 'tenant_pages' },
    { id: 'donate', feature: 'services', label: 'Donate', route: '/donate', scope: 'organization', editor: 'tenant_pages' },
    { id: 'schedule', feature: 'services', label: 'Schedule', route: '/schedule', scope: 'organization', editor: 'tenant_pages' },
  ],
  managers: [
    { key: 'organization.blog', id: 'blog', label: 'Blog', section: 'collections', route: 'blog', scope: 'organization' },
    { key: 'organization.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: 'qa', scope: 'organization' },
    { key: 'organization.locations', id: 'locations', label: 'Locations', section: 'locations', route: '', scope: 'organization' },
    { key: 'organization.services', id: 'services', label: 'Practice areas & consultations', section: 'collections', route: 'products/services', scope: 'organization' },
    { key: 'location.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: ':location/qa', scope: 'location' },
    { key: 'location.posts', id: 'posts', label: 'Posts', section: 'collections', route: ':location/posts', scope: 'location' },
    { key: 'location.photos', id: 'photos', label: 'Photos', section: 'media', route: ':location/photos', scope: 'location' },
    { key: 'organization.settings', id: 'settings', label: 'Brand', section: 'organization', route: 'settings', scope: 'organization' },
    { key: 'location.settings', id: 'settings', label: 'Location settings', section: 'organization', route: ':location/settings', scope: 'location' },
    { key: 'location.products', id: 'products', label: 'Products', section: 'collections', route: ':location/products', scope: 'location' },
    { key: 'location.reservations', id: 'reservations', label: 'Reservations', section: 'collections', route: ':location/reservations', scope: 'location' },
  ],
  locationVocabularyDefault: 'location',
}

// KrabiClaw's own site. Its documentation is ordinary page documents under /docs,
// so the pages index lists them without a catalog entry per page. The platform
// owner's operations (organizations, every domain, platform analytics, staff) are
// dashboard pages gated on this site, not content managers.
const platformSiteCatalog: CmsSiteCatalog = {
  pages: [
    { id: 'home', feature: 'contact', label: 'Home', route: '/', scope: 'organization', editor: 'tenant_pages' },
    { id: 'contact', feature: 'contact', label: 'Help', route: '/help', scope: 'organization', editor: 'tenant_pages' },
  ],
  managers: [
    { key: 'organization.blog', id: 'blog', label: 'Blog', section: 'collections', route: 'blog', scope: 'organization' },
    { key: 'organization.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: 'qa', scope: 'organization' },
    { key: 'organization.settings', id: 'settings', label: 'Brand', section: 'organization', route: 'settings', scope: 'organization' },
  ],
  locationVocabularyDefault: 'office/service area',
}

// A customer site's editors are its vertical's: a legal practice edits its
// practice pages, every other vertical its venue pages. KrabiClaw's own site has its own.
function catalogFor(site: SiteSurface): CmsSiteCatalog {
  return site === 'platform' ? platformSiteCatalog : customerSiteCatalog
}

// Which (vertical, site) pairs are real products today: KrabiClaw's own site is a service site.
const supportedCombinations: Record<OrganizationVertical, readonly SiteSurface[]> = {
  restaurant: ['tenant'],
  experience: ['tenant'],
  service: ['tenant', 'platform'],
  lodging: ['tenant'],
}

// Always-on features: 'contact'/'locations'/'settings' are infra; 'blog'/'qa'/
// 'reviews'/'posts'/'photos' are content managers — never business modules. An empty content
// manager still needs to be reachable so an owner can create the first item (turning it off
// because it's empty creates a circular UX problem). resolveCmsCapabilities unions them into
// every vertical's feature set.
export const ALWAYS_ON_FEATURES: readonly ProductFeature[] = [
  'contact', 'locations', 'settings',
  'blog', 'qa', 'reviews', 'posts', 'photos',
]

// Real business-module defaults only — content managers are handled uniformly via
// ALWAYS_ON_FEATURES above, not per-vertical here.
const verticalDefaultFeatures: Record<OrganizationVertical, readonly ProductFeature[]> = {
  // A restaurant that also runs classes and a studio that only runs them have
  // the same modules: a Product is a Product, and booking is a capability it
  // may have. The difference between these verticals is vocabulary (menu vs
  // products), not which modules exist.
  restaurant: ['products', 'reservations'],
  experience: ['products', 'reservations'],
  service: ['services'],
  // Stays are the places to stay module, not a CMS module; what a rental sells
  // here are its extras and experiences, so it has products and no table reservations.
  lodging: ['products'],
}

// Vocabulary/label differences that are purely cosmetic (same underlying feature, different
// wording per vertical) live here instead of duplicating whole catalog objects.
const verticalLabelOverrides: Partial<Record<OrganizationVertical, Partial<Record<ProductFeature, string>>>> = {
  experience: { reservations: 'Bookings' },
  service: { locations: 'Offices / practice locations' },
}

function effectiveLabel(vertical: OrganizationVertical, feature: ProductFeature, fallback: string): string {
  return verticalLabelOverrides[vertical]?.[feature] ?? fallback
}

export function resolveCmsCapabilities(
  vertical: OrganizationVertical,
  site: SiteSurface,
  organization: { hasStayProduct: boolean } | null,
): CmsCapabilityDefinition {
  if (!supportedCombinations[vertical]?.includes(site)) {
    throw new Error(`Unsupported CMS capability combination: ${vertical}/${site}`)
  }
  const catalog = catalogFor(site)
  const features = new Set<ProductFeature>([...verticalDefaultFeatures[vertical], ...ALWAYS_ON_FEATURES])

  if (vertical === 'lodging' || organization?.hasStayProduct) features.add('stays')

  const productPresentation = resolveProductPresentation(vertical)
  const pages = catalog.pages
    .filter(page => features.has(page.feature))
    .map(page => page.feature === 'products' && productPresentation
      ? { ...page, label: productPresentation.collectionLabel, route: productPresentation.collectionPath }
      : { ...page, label: effectiveLabel(vertical, page.feature, page.label) })

  const managers = catalog.managers
    .filter(manager => features.has(manager.id))
    .map(manager => manager.id === 'products' && productPresentation
      ? { ...manager, label: productPresentation.collectionLabel }
      : { ...manager, label: effectiveLabel(vertical, manager.id, manager.label) })

  return {
    vertical,
    site,
    locationVocabulary: isLegalPractice(vertical) ? 'office/service area' : catalog.locationVocabularyDefault,
    pages,
    managers,
    features: [...features],
  }
}

/** All manager keys a site can ever produce across every vertical it supports. */
export function allGuardableManagerKeys(): readonly string[] {
  const keys = new Set<string>()
  for (const catalog of [customerSiteCatalog, platformSiteCatalog]) {
    for (const manager of catalog.managers) keys.add(manager.key)
  }
  return [...keys]
}
