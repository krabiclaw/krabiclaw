export const PAGEVIEW_SKIP_PREFIXES = [
  '/api/', '/dashboard', '/auth/', '/preview/', '/booking-changes', '/_nuxt/', '/assets/', '/_ipx/',
  '/oauth/', '/accept-invitation', '/login', '/forgot-password', '/reset-password',
  '/favicon', '/apple-touch-icon',
]

export function isTrackablePath(pathname: string): boolean {
  if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#') || pathname.length > 2048) return false
  if (PAGEVIEW_SKIP_PREFIXES.some((value) => {
    const prefix = value.endsWith('/') ? value.slice(0, -1) : value
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })) return false
  return !/\.[a-zA-Z0-9]+$/.test(pathname)
}
