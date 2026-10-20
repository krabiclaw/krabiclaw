// tenant_page_variants.path is stored locale-bare (the CMS writes the same
// '/', '/about', etc. for every translation). Callers that classify public
// routes must use resolveTenantLocalePath with the tenant's published locales;
// splitLocalePrefix is reserved for syntax validation and normalization.
export interface TenantLocalePath {
  localeSegment: string | null
  sourcePath: string
  publicPath: string
}

/**
 * Syntax only: whether a first segment *could* be a language tag.
 *
 * `Intl` accepts any well-formed subtag, and plenty of our own top-level routes
 * are well-formed language tags — `dev`, `api`, `faq`, `qa` all pass. So this
 * answers "is this shaped like a locale", never "is this a locale"; a caller
 * routing on the answer must check it against real locales, the way
 * resolveTenantLocalePath checks the tenant's published ones.
 */
export function isLocaleShapedSegment(segment: string | undefined): boolean {
  if (!segment || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(segment)) return false
  try {
    const canonical = Intl.getCanonicalLocales(segment)
    return canonical.length === 1 && canonical[0] === segment
  } catch {
    return false
  }
}

export function splitLocalePrefix(path: string): TenantLocalePath {
  const first = path.split('/')[1]
  const localeSegment = isLocaleShapedSegment(first) ? first! : null
  const sourcePath = localeSegment ? (path.slice(localeSegment.length + 1) || '/') : path
  return { localeSegment, sourcePath, publicPath: path }
}

export function formatTenantLocalePath(path: string, locale: string, sourceLocale: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || locale === sourceLocale) return path
  if (path === `/${locale}` || path.startsWith(`/${locale}/`)) return path
  if (path === '/') return `/${locale}`
  return `/${locale}${path}`
}

export function resolveTenantLocalePath(path: string, publishedLocales: readonly string[]): TenantLocalePath {
  const first = path.split('/')[1] ?? ''
  const localeSegment = publishedLocales.includes(first) ? first : null
  const sourcePath = localeSegment ? path.slice(localeSegment.length + 1) || '/' : path
  return { localeSegment, sourcePath, publicPath: path }
}
