import type { LayoutKey } from 'nuxt/app'

/**
 * Which renderer a site runs: KrabiClaw's own marketing site, or a customer
 * site. Every customer site — restaurant, experience, lodging or legal
 * practice — draws the same blocks with the same components; its look is its
 * own settings (palette, fonts and site recipe). Domain capabilities decide
 * which business features are available.
 */
export type SiteSurface = 'tenant' | 'platform'

/** KrabiClaw's own site is the one organization on this theme id. Every other id is a customer site. */
export const PLATFORM_THEME_ID = 'krabiclaw-theme-v1'
/** The theme id provisioning gives a customer site. */
export const TENANT_THEME_ID = 'tenant-theme-v1'

export interface PublicSiteDefinition {
  slug: SiteSurface
  themeId: string
  layout: LayoutKey
  sitemap: {
    exactPaths: string[]
    dynamicPrefixes: string[]
  }
  nonIndexableExactPaths: string[]
  /**
   * Where this site renders a tenant page document.
   *
   * One declaration, read by the renderer that loads the document and by the
   * writer that decides whether a page may exist there.
   *
   * `recipes` names the pages a site guarantees: the lookup a route loader
   * performs, and the set whose deletion the writer refuses. `paths` are the
   * documents a route still binds by path alone — only needed where a route
   * file claims the path, because a claimed path is one the catch-all cannot
   * reach. `prefixes` are subtrees served as documents. Unclaimed paths are
   * rendered by pages/[...tenantPath].vue on every site.
   */
  pageDocuments: {
    recipes: Record<string, string> & { home: string }
    /** Complete built-in routes whose authored overlay may lack a translation. */
    optionalLocalizedPaths: string[]
    paths: string[]
    patterns?: string[]
    prefixes: string[]
  }
}

/** All customer sites use these routes and the same page renderer. */
export const CUSTOMER_SITE: PublicSiteDefinition = {
  slug: 'tenant',
  themeId: TENANT_THEME_ID,
  layout: 'tenant',
  sitemap: {
    // Authored pages are listed from published documents, never assumed from a business type.
    exactPaths: ['/', '/menu', '/products', '/experiences', '/stays', '/contact', '/blog', '/docs', '/locations', '/reservations', '/posts', '/photos', '/qa', '/reviews'],
    dynamicPrefixes: ['/blog/', '/docs/', '/services/', '/experiences/', '/stays/', '/locations/', '/posts/'],
  },
  nonIndexableExactPaths: ['/contact/confirmed', '/bookings/cancel', '/bookings/confirmed', '/reservations/cancel', '/reservations/confirmed'],
  pageDocuments: {
    recipes: {
      home: '/', about: '/about', contact: '/contact', reservations: '/reservations',
      services: '/services', pricing: '/pricing', donate: '/donate', schedule: '/schedule',
      privacy: '/policies/privacy', terms: '/policies/terms', 'third-party-notices': '/third-party-notices',
    },
    optionalLocalizedPaths: ['/contact', '/reservations'],
    paths: [],
    patterns: ['/locations/:slug()'],
    prefixes: ['/services/'],
  },
}

/** Is this a legal practice? The `service` vertical is canonically legal services. */
export function isLegalPractice(vertical: string | null | undefined): boolean {
  return String(vertical ?? '').trim().toLowerCase() === 'service'
}

/**
 * Is this site a legal practice's? A security gate as well as a rendering
 * decision — the consultation, compliance and consent paths read it — so it
 * names KrabiClaw's own site out explicitly: that site is also `service`.
 */
export function isLegalPracticeSite(input: { themeId?: string | null; vertical?: string | null }): boolean {
  return String(input.themeId ?? '').trim().toLowerCase() !== PLATFORM_THEME_ID && isLegalPractice(input.vertical)
}

// KrabiClaw's own site: the marketing pages, documentation and blog. It is an
// ordinary site row rendered by the platform layout; the platform host resolves
// to whichever site owns the apex domain (see server/middleware/tenant-resolution.ts).
export const PLATFORM_SITE: PublicSiteDefinition = {
  slug: 'platform',
  themeId: PLATFORM_THEME_ID,
  layout: 'platform',
  sitemap: {
    // The editorial marketing routes are not listed here: they are published
    // page documents now, and the platform sitemap reads them from
    // content_documents (see server/plugins/sitemap.ts). What remains is the
    // set of code-owned platform routes that hold no document.
    exactPaths: ['/blog', '/docs', '/help', '/posts', '/signup', '/templates', '/templates/blawby', '/templates/saya'],
    dynamicPrefixes: ['/blog/', '/docs/', '/posts/'],
  },
  nonIndexableExactPaths: ['/login', '/forgot-password', '/reset-password', '/accept-invitation'],
  // KrabiClaw's own marketing pages are ordinary page documents on the
  // platform site, read by the same loader every customer site uses (#903).
  // The routes that are not editorial — /blog, /docs, /help, /templates —
  // are absent on purpose: they render their own data, and a document stored
  // at one of them would never be shown.
  pageDocuments: {
    recipes: { home: '/', about: '/about', pricing: '/pricing' },
    optionalLocalizedPaths: [],
    // Only a path a route file still claims needs naming here. /experiences is
    // the catalog's route on a customer host and KrabiClaw's own page on
    // this one. Everything else KrabiClaw publishes is an unclaimed path the
    // catch-all serves, the same as any tenant's.
    paths: ['/experiences', '/products'],
    prefixes: [],
  },
}

/** The platform shell and the shared customer shell. */
export const PUBLIC_SITES: readonly PublicSiteDefinition[] = [PLATFORM_SITE, CUSTOMER_SITE]

/** Is this KrabiClaw's own site? Its theme id alone says. */
export function isPlatformSite(input: { themeId?: string | null }): boolean {
  return String(input.themeId ?? '').trim().toLowerCase() === PLATFORM_THEME_ID
}

export const TENANT_NON_INDEXABLE_EXACT_PATHS = new Set(
  PUBLIC_SITES.filter(site => site.slug !== 'platform').flatMap(site => site.nonIndexableExactPaths),
)

/**
 * The renderer and routes for a site. KrabiClaw's own site is selected only by
 * its theme id; every customer site uses the same definition.
 */
export function resolvePublicSite(input: {
  themeId?: string | null
}): PublicSiteDefinition {
  const themeId = String(input.themeId ?? '').trim().toLowerCase()
  if (themeId === PLATFORM_THEME_ID) return PLATFORM_SITE
  return CUSTOMER_SITE
}
