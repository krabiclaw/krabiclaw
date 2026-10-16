import type { OrganizationVertical } from '~/utils/vertical-copy'
import type { PublicTemplateSlug } from '~/utils/template-registry'
import { resolveProductPresentation } from '~/utils/product-presentation'

export type CmsSectionId = 'pages' | 'collections' | 'locations' | 'media' | 'organization'

// Explicit module identifiers a vertical/template/site/location can turn on.
// 'consultations' and 'appointments' are declared (not yet wired to any catalog entry below) because
// no distinct manager/route exists for them yet, and blawby's practice management lives
// entirely on the single 'services' page. Reservation policies belong to locations because every
// reservation is location-owned. Booking is a capability of a Product, configured where the
// Product is, so it needs no module of its own. Wire distinct manager entries only when their
// routes provide distinct customer-facing UX.
export type ProductFeature =
  | 'contact' | 'locations' | 'settings'
  | 'products' | 'reservations'
  | 'services' | 'consultations' | 'appointments'
  | 'blog' | 'qa' | 'reviews' | 'posts' | 'photos'

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
  template: PublicTemplateSlug
  locationVocabulary: 'location' | 'office/service area'
  pages: readonly CmsPageCapability[]
  managers: readonly CmsManagerCapability[]
}

interface CmsTemplateCatalog {
  pages: readonly CmsPageCapability[]
  managers: readonly CmsManagerCapability[]
  locationVocabularyDefault: 'location' | 'office/service area'
}

const sayaCorePages: readonly CmsPageCapability[] = [
    { id: 'home', feature: 'contact', label: 'Home', route: '/', scope: 'organization', editor: 'tenant_pages' },
    { id: 'about', feature: 'contact', label: 'About', route: '/about', scope: 'organization', editor: 'tenant_pages' },
    { id: 'contact', feature: 'contact', label: 'Contact', route: '/contact', scope: 'organization', editor: 'tenant_pages' },
  { id: 'location', feature: 'locations', label: 'Location', route: '/locations/:location', scope: 'location', editor: 'tenant_pages' },
]

const sayaCoreManagers: readonly CmsManagerCapability[] = [
  { key: 'organization.blog', id: 'blog', label: 'Blog', section: 'collections', route: 'blog', scope: 'organization' },
  { key: 'organization.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: 'qa', scope: 'organization' },
  { key: 'organization.locations', id: 'locations', label: 'Locations', section: 'locations', route: '', scope: 'organization' },
  { key: 'location.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: ':location/qa', scope: 'location' },
  { key: 'location.posts', id: 'posts', label: 'Posts', section: 'collections', route: ':location/posts', scope: 'location' },
  { key: 'location.photos', id: 'photos', label: 'Photos', section: 'media', route: ':location/photos', scope: 'location' },
  { key: 'organization.settings', id: 'settings', label: 'Brand', section: 'organization', route: 'settings', scope: 'organization' },
  { key: 'location.settings', id: 'settings', label: 'Location settings', section: 'organization', route: ':location/settings', scope: 'location' },
]

// Every feature a Saya site can EVER expose (restaurant + experience combined), tagged with its
// owning feature id. Vertical defaults below select which of these are on.
const sayaTemplateCatalog: CmsTemplateCatalog = {
  pages: [
    ...sayaCorePages,
    { id: 'products', feature: 'products', label: 'Products', route: '/products', scope: 'organization', editor: 'tenant_pages' },
    { id: 'reservations', feature: 'reservations', label: 'Reservations', route: '/reservations', scope: 'organization', editor: 'tenant_pages' },
  ],
  managers: [
    ...sayaCoreManagers,
    { key: 'location.products', id: 'products', label: 'Products', section: 'collections', route: ':location/products', scope: 'location' },
    { key: 'location.reservations', id: 'reservations', label: 'Reservations', section: 'collections', route: ':location/reservations', scope: 'location' },
  ],
  locationVocabularyDefault: 'location',
}

const blawbyTemplateCatalog: CmsTemplateCatalog = {
  pages: [
    { id: 'home', feature: 'contact', label: 'Home', route: '/', scope: 'organization', editor: 'tenant_pages' },
    { id: 'about', feature: 'contact', label: 'About', route: '/about', scope: 'organization', editor: 'tenant_pages' },
    { id: 'contact', feature: 'contact', label: 'Contact', route: '/contact', scope: 'organization', editor: 'tenant_pages' },
    { id: 'location', feature: 'locations', label: 'Office', route: '/locations/:location', scope: 'location', editor: 'tenant_pages' },
    { id: 'services', feature: 'services', label: 'Services', route: '/services', scope: 'organization', editor: 'tenant_pages' },
    { id: 'pricing', feature: 'services', label: 'Pricing', route: '/pricing', scope: 'organization', editor: 'tenant_pages' },
    { id: 'donate', feature: 'services', label: 'Donate', route: '/donate', scope: 'organization', editor: 'tenant_pages' },
    { id: 'schedule', feature: 'services', label: 'Schedule', route: '/schedule', scope: 'organization', editor: 'tenant_pages' },
  ],
  managers: [
    { key: 'organization.blog', id: 'blog', label: 'Blog', section: 'collections', route: 'blog', scope: 'organization' },
    { key: 'organization.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: 'qa', scope: 'organization' },
    { key: 'organization.locations', id: 'locations', label: 'Offices / service areas', section: 'locations', route: '', scope: 'organization' },
    { key: 'organization.services', id: 'services', label: 'Services', section: 'collections', route: 'products/services', scope: 'organization' },
    { key: 'location.qa', id: 'qa', label: 'Reviews and Q&A', section: 'collections', route: ':location/qa', scope: 'location' },
    { key: 'location.posts', id: 'posts', label: 'Posts', section: 'collections', route: ':location/posts', scope: 'location' },
    { key: 'location.photos', id: 'photos', label: 'Photos', section: 'media', route: ':location/photos', scope: 'location' },
    { key: 'organization.settings', id: 'settings', label: 'Brand', section: 'organization', route: 'settings', scope: 'organization' },
    { key: 'location.settings', id: 'settings', label: 'Location settings', section: 'organization', route: ':location/settings', scope: 'location' },
  ],
  locationVocabularyDefault: 'office/service area',
}

// KrabiClaw's own site. Its documentation is ordinary page documents under /docs,
// so the pages index lists them without a catalog entry per page. The platform
// owner's operations (organizations, every domain, platform analytics, staff) are
// dashboard pages gated on this template, not content managers.
const platformTemplateCatalog: CmsTemplateCatalog = {
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

export const templateCapabilityCatalog: Record<PublicTemplateSlug, CmsTemplateCatalog> = {
  saya: sayaTemplateCatalog,
  blawby: blawbyTemplateCatalog,
  platform: platformTemplateCatalog,
}

// Which (vertical, template) pairs are real products today. Not every catalog feature is
// reachable from every vertical — this plus verticalDefaultFeatures is what keeps
// resolveCmsCapabilities('restaurant', 'blawby') failing fast the way it always has.
const supportedCombinations: Record<OrganizationVertical, readonly PublicTemplateSlug[]> = {
  restaurant: ['saya'],
  experience: ['saya'],
  service: ['blawby', 'platform'],
  lodging: ['saya'],
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
  // Stays are booked in the lodging service; what a rental sells here are
  // its extras and experiences, so it has products and no table reservations.
  lodging: ['products'],
}

// Vocabulary/label differences that are purely cosmetic (same underlying feature, different
// wording per vertical) live here instead of duplicating whole catalog objects.
const verticalLabelOverrides: Partial<Record<OrganizationVertical, Partial<Record<ProductFeature, string>>>> = {
  experience: { reservations: 'Bookings' },
}

function effectiveLabel(vertical: OrganizationVertical, feature: ProductFeature, fallback: string): string {
  return verticalLabelOverrides[vertical]?.[feature] ?? fallback
}

export function resolveCmsCapabilities(
  vertical: OrganizationVertical,
  template: PublicTemplateSlug,
): CmsCapabilityDefinition {
  if (!supportedCombinations[vertical]?.includes(template)) {
    throw new Error(`Unsupported CMS capability combination: ${vertical}/${template}`)
  }
  const catalog = templateCapabilityCatalog[template]
  const features = new Set<ProductFeature>([...verticalDefaultFeatures[vertical], ...ALWAYS_ON_FEATURES])

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
    template,
    locationVocabulary: catalog.locationVocabularyDefault,
    pages,
    managers,
  }
}

/** Every (vertical, template) combination this product actually supports. */
export const cmsCapabilityRegistry: readonly CmsCapabilityDefinition[] = Object.entries(supportedCombinations)
  .flatMap(([vertical, templates]) => templates.map(template => resolveCmsCapabilities(vertical as OrganizationVertical, template)))

/** Validates one resolved definition's internal consistency — split out from
 *  validateCmsCapabilityRegistry so malformed fixtures can be exercised directly in tests instead
 *  of only ever validating the (always-valid-by-construction) real registry. */
export function validateCmsCapabilityDefinition(definition: CmsCapabilityDefinition): void {
  const combination = `${definition.vertical}/${definition.template}`

  const pageIds = new Set<string>()
  const pageRoutesByScope = { organization: new Set<string>(), location: new Set<string>() }
  for (const page of definition.pages) {
    if (pageIds.has(page.id)) throw new Error(`Duplicate CMS page id in ${combination}: ${page.id}`)
    if (pageRoutesByScope[page.scope].has(page.route)) throw new Error(`Duplicate CMS page route in ${combination}/${page.scope}: ${page.route}`)
    if (page.scope === 'location' && !page.route.includes(':location')) {
      throw new Error(`Location-scoped CMS page must declare :location: ${combination}/${page.id}`)
    }
    pageIds.add(page.id)
    pageRoutesByScope[page.scope].add(page.route)
  }

  const managerKeys = new Set<string>()
  const managerRoutesByScope = { organization: new Set<string>(), location: new Set<string>() }
  for (const manager of definition.managers) {
    if (managerKeys.has(manager.key)) throw new Error(`Duplicate CMS manager key in ${combination}: ${manager.key}`)
    if (manager.key !== `${manager.scope}.${manager.id}`) throw new Error(`CMS manager key must be \`\${scope}.\${id}\`: ${combination}/${manager.key}`)
    if (managerRoutesByScope[manager.scope].has(manager.route)) throw new Error(`Duplicate CMS manager route in ${combination}/${manager.scope}: ${manager.route}`)
    if (manager.scope === 'location' && !manager.route.includes(':location')) {
      throw new Error(`Location-scoped CMS manager must declare :location: ${combination}/${manager.key}`)
    }
    managerKeys.add(manager.key)
    managerRoutesByScope[manager.scope].add(manager.route)
  }
}

export function validateCmsCapabilityRegistry(): void {
  for (const [vertical, templates] of Object.entries(supportedCombinations) as [OrganizationVertical, readonly PublicTemplateSlug[]][]) {
    for (const template of templates) {
      validateCmsCapabilityDefinition(resolveCmsCapabilities(vertical, template))
    }
  }
}

/** All manager keys a template can ever produce across every vertical it supports. */
export function allGuardableManagerKeys(): readonly string[] {
  const keys = new Set<string>()
  for (const catalog of Object.values(templateCapabilityCatalog)) {
    for (const manager of catalog.managers) keys.add(manager.key)
  }
  return [...keys]
}
