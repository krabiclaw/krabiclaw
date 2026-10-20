export const PUBLIC_SOURCE_ROUTE_ROOTS = new Set([
  'about', 'article', 'blog', 'booking-changes', 'bookings', 'contact', 'docs', 'experiences', 'help', 'links', 'locations',
  'donate', 'menu', 'photos', 'policies', 'posts', 'pricing', 'privacy', 'products',
  'qa', 'reservations', 'reviews', 'schedule', 'services', 'terms', 'third-party-notices',
])

export const RESERVED_PUBLIC_ROUTE_ROOTS = new Set(['admin', 'api', 'dashboard', 'preview'])

export function isPublicSourceRouteRoot(value: string): boolean {
  return PUBLIC_SOURCE_ROUTE_ROOTS.has(value)
}

export function isLocalizedPublicAliasPath(path: string): boolean {
  if (path === '/') return true
  const root = path.split('/')[1]
  return Boolean(root && isPublicSourceRouteRoot(root))
}
