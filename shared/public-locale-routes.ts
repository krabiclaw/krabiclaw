export const DOCUMENT_ONLY_PUBLIC_PATHS = ['/menu', '/reviews', '/locations/:slug/menu', '/locations/:slug/reviews'] as const

export function isDocumentOnlyPublicPath(path: string): boolean {
  const source = path.replace(/\/$/, '')
  return DOCUMENT_ONLY_PUBLIC_PATHS.some(pattern => new RegExp(`^${pattern.replace(':slug', '[^/]+')}$`).test(source))
}

export const PUBLIC_SOURCE_ROUTE_ROOTS = new Set([
  'about', 'article', 'blog', 'booking-changes', 'bookings', 'contact', 'docs', 'experiences', 'help', 'locations',
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
