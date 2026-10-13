export const PUBLIC_SOURCE_ROUTE_ROOTS = new Set([
  'about', 'article', 'blog', 'booking-changes', 'bookings', 'contact', 'docs', 'experiences', 'help', 'links', 'locations',
  'donate', 'menu', 'photos', 'policies', 'posts', 'pricing', 'privacy', 'products',
  'qa', 'reservations', 'reviews', 'schedule', 'services', 'terms', 'third-party-notices',
])

export const RESERVED_PUBLIC_ROUTE_ROOTS = new Set(['admin', 'api', 'dashboard', 'preview'])

export function isPublicSourceRouteRoot(value: string): boolean {
  return PUBLIC_SOURCE_ROUTE_ROOTS.has(value)
}

/** The route's locale-bare identity, independently of any optional page document. */
export function routeSourcePath(page: string | null): string | null {
  if (!page) return null
  if (page === 'home') return '/'
  if (isPublicSourceRouteRoot(page)) return `/${page}`
  return null
}

/** These complete built-in routes may display an optional translated CMS overlay. */
export function allowsMissingLocalizedTenantPage(page: string | null): boolean {
  return page === 'location' || page === 'contact' || page === 'reservations'
}

export function isLocalizedPublicAliasPath(path: string): boolean {
  if (path === '/') return true
  const root = path.split('/')[1]
  return Boolean(root && isPublicSourceRouteRoot(root))
}
