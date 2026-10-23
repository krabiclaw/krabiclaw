import type { LayoutKey } from 'nuxt/app'

/**
 * Which renderer a site runs: KrabiClaw's own marketing site, or a customer
 * site. Every customer site — restaurant, experience, lodging or legal
 * practice — draws the same blocks with the same components; its look is its
 * own settings (palette, fonts, site recipe), and its vertical decides only
 * which built-in routes it has.
 */
export type PublicTemplateSlug = 'tenant' | 'platform'

/** KrabiClaw's own site is the one organization on this theme id. Every other id is a customer site. */
export const PLATFORM_THEME_ID = 'krabiclaw-theme-v1'
/** The theme id provisioning gives a customer site. */
export const TENANT_THEME_ID = 'tenant-theme-v1'

export interface PublicTemplateDefinition {
  slug: PublicTemplateSlug
  themeId: string
  layout: LayoutKey
  serviceRoutes: {
    offeringsIndex: string | null
    offeringDetailPrefix: string | null
  }
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
   * reach. `prefixes` are subtrees served as documents. `catchAll` says whether
   * pages/[...tenantPath].vue renders unclaimed paths; every site sets it,
   * KrabiClaw's own included, because KrabiClaw is a site row like any other (#903).
   */
  pageDocuments: {
    recipes: Record<string, string> & { home: string }
    /** Complete built-in routes whose authored overlay may lack a translation. */
    optionalLocalizedPaths: string[]
    paths: string[]
    patterns?: string[]
    prefixes: string[]
    catchAll: boolean
  }
}

type TenantRoutes = Omit<PublicTemplateDefinition, 'slug' | 'themeId' | 'layout'>

/** A legal practice's built-in routes: practice areas, consultations, fees, giving and its notices. */
const LEGAL_PRACTICE_ROUTES: TenantRoutes = {
  serviceRoutes: {
    offeringsIndex: '/services',
    offeringDetailPrefix: '/services',
  },
  sitemap: {
    exactPaths: ['/', '/about', '/services', '/experiences', '/pricing', '/donate', '/schedule', '/contact', '/blog', '/docs', '/posts', '/third-party-notices'],
    dynamicPrefixes: ['/services/', '/experiences/', '/blog/', '/docs/', '/posts/'],
  },
  nonIndexableExactPaths: ['/contact/confirmed', '/bookings/cancel', '/bookings/confirmed'],
  // 'links', 'confirmation', 'article' and 'page' are absent because they hold
  // no document of their own: the first two render from shell data, an article
  // is a blog post, and 'page' names its own path through the catch-all.
  pageDocuments: {
    recipes: {
      home: '/', services: '/services', about: '/about', pricing: '/pricing', contact: '/contact',
      schedule: '/schedule', blog: '/blog', donate: '/donate',
      privacy: '/policies/privacy', terms: '/policies/terms',
      'third-party-notices': '/third-party-notices',
    },
    optionalLocalizedPaths: [],
    paths: [],
    prefixes: ['/services/'],
    catchAll: true,
  },
}

/** A restaurant's, experience's or place to stay's built-in routes: menu, catalog, stays, locations and reservations. */
const VENUE_ROUTES: TenantRoutes = {
  serviceRoutes: {
    offeringsIndex: null,
    offeringDetailPrefix: null,
  },
  sitemap: {
    exactPaths: ['/', '/menu', '/products', '/experiences', '/stays', '/contact', '/blog', '/docs', '/locations', '/reservations', '/posts', '/photos', '/qa', '/reviews'],
    dynamicPrefixes: ['/blog/', '/docs/', '/experiences/', '/stays/', '/locations/', '/posts/'],
  },
  nonIndexableExactPaths: ['/contact/confirmed', '/bookings/cancel', '/bookings/confirmed', '/reservations/cancel', '/reservations/confirmed'],
  // A venue reads a document on the routes that request the 'content' dataset.
  // Location overview routes render their location data with an optional
  // authored page overlay. Catalog and other location routes own their data.
  pageDocuments: {
    recipes: { home: '/', about: '/about', contact: '/contact', reservations: '/reservations' },
    optionalLocalizedPaths: ['/contact', '/reservations'],
    paths: [],
    patterns: ['/locations/:slug()'],
    prefixes: [],
    catchAll: true,
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

function tenantTemplate(vertical: string): PublicTemplateDefinition {
  return { slug: 'tenant', themeId: TENANT_THEME_ID, layout: 'tenant', ...(isLegalPractice(vertical) ? LEGAL_PRACTICE_ROUTES : VENUE_ROUTES) }
}

// KrabiClaw's own site: the marketing pages, documentation and blog. It is an
// ordinary site row rendered by the platform layout; the platform host resolves
// to whichever site owns the apex domain (see server/middleware/tenant-resolution.ts).
export const PLATFORM_TEMPLATE: PublicTemplateDefinition = {
  slug: 'platform',
  themeId: PLATFORM_THEME_ID,
  layout: 'platform',
  serviceRoutes: {
    offeringsIndex: null,
    offeringDetailPrefix: null,
  },
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
    catchAll: true,
  },
}

/** Every route table a site can have: KrabiClaw's, a legal practice's and a venue's. */
export const PUBLIC_TEMPLATES: readonly PublicTemplateDefinition[] = [PLATFORM_TEMPLATE, tenantTemplate('service'), tenantTemplate('restaurant')]

/** Is this KrabiClaw's own site? Its theme id alone says. */
export function isPlatformTemplate(input: { themeId?: string | null }): boolean {
  return String(input.themeId ?? '').trim().toLowerCase() === PLATFORM_THEME_ID
}

export const TENANT_NON_INDEXABLE_EXACT_PATHS = new Set(
  PUBLIC_TEMPLATES.filter(template => template.slug !== 'platform').flatMap(template => template.nonIndexableExactPaths),
)

/**
 * The renderer and routes for a site. KrabiClaw's own site is selected only by
 * its theme id; any other site is a customer site, and needs its vertical.
 */
export function resolvePublicTemplate(input: {
  themeId?: string | null
  vertical?: string | null
}): PublicTemplateDefinition {
  const themeId = String(input.themeId ?? '').trim().toLowerCase()
  if (themeId === PLATFORM_THEME_ID) return PLATFORM_TEMPLATE
  const vertical = String(input.vertical ?? '').trim().toLowerCase()
  if (!vertical) throw new Error('resolvePublicTemplate() requires the vertical of a customer site.')
  return tenantTemplate(vertical)
}

// ─────────────────────────────────────────────────────────────────────────
// Public marketing metadata — /templates index + /templates/[slug]
// ─────────────────────────────────────────────────────────────────────────
//
// Saya and Blawby are the names KrabiClaw sells its two starting recipes
// under at krabiclaw.com/templates — a restaurant, experience or lodging site, and a
// law firm site. They are marketing names only: a customer site built from
// either renders with the same components as every other.

export interface TemplateMarketingFeature {
  label: string
  description: string
}

export type TemplateMarketingStatus = 'available' | 'coming_soon'
/** The website recipes KrabiClaw markets at /templates: one for venues, one for law firms. */
export type MarketedTemplateSlug = 'saya' | 'blawby'

export interface TemplateMarketingMetadata {
  slug: MarketedTemplateSlug
  displayName: string
  tagline: string
  summary: string
  description: string
  supportedVerticals: string[]
  status: TemplateMarketingStatus
  /** False keeps a theme usable by tenants while hiding its marketing pages. */
  published: boolean
  priceLabel: string
  schemaOffer: { price: string, priceCurrency: string } | null
  /** Blawby uses its approved customer showcase; Saya resolves its demo host at runtime. */
  demoUrl: string | null
  demoLabel: string
  /** Real website screenshot, shared by the index and detail page. */
  previewImageUrl: string
  /** Original illustration for this theme's editorial story. */
  artworkUrl: string
  logoUrl: string | null
  ctaLabel: string
  ctaTo: string
  features: TemplateMarketingFeature[]
  included: string[]
  sortOrder: number
  seo: { title: string, description: string }
}

export const publicTemplateMarketing: Record<MarketedTemplateSlug, TemplateMarketingMetadata> = {
  saya: {
    slug: 'saya',
    displayName: 'Saya',
    tagline: 'Make your place\ntheir next stop.',
    summary: 'A website for the food you serve, the experiences you host, and the places your guests stay.',
    description: 'Bring your restaurant, experience or lodging business to life with photography, practical details, and a clear path to visit, book an experience or reserve a stay. Saya puts menus, home listings and the details guests need alongside the story that makes your place yours.',
    supportedVerticals: ['Restaurants', 'Experiences', 'Lodging'],
    status: 'available',
    published: true,
    priceLabel: 'Included on every plan',
    schemaOffer: { price: '0', priceCurrency: 'USD' },
    demoUrl: null,
    demoLabel: 'Explore the live demo',
    previewImageUrl: '/images/products/kikuzuki.png',
    artworkUrl: '/images/templates/saya-food-and-craft.png',
    logoUrl: '/saya-logo.png',
    ctaLabel: 'Start free',
    ctaTo: '/signup',
    features: [
      {
        label: 'A menu worth exploring.',
        description: 'Give each dish its own photos, description, and price. Organize your menu into sections so guests can find a favorite before they arrive.',
      },
      {
        label: 'The right place. The right details.',
        description: 'Keep each location’s hours, address, photos, and offerings together. Make it easy for guests to choose where to visit.',
      },
      {
        label: 'Make the next step obvious.',
        description: 'Introduce a class or experience with photos and practical details, then guide guests toward available times and booking. Give restaurant guests a clear way to request a table.',
      },
      {
        label: 'Welcome your next overnight guest.',
        description: 'Present each home with photos, amenities and stay details. Offer direct paid stay booking with Business and completed Stripe setup. Manage availability, arrivals, departures and guest conversations from your dashboard.',
      },
    ],
    included: [
      'Restaurant menus and dish pages',
      'Experience pages and booking flows',
      'Home listings and nightly availability',
      'Location pages with hours and directions',
      'Photos, reviews, and guest questions',
      'Posts, articles, and your brand story',
      'A responsive website for every screen',
    ],
    sortOrder: 1,
    seo: {
      title: 'Saya — Restaurant, Experience and Lodging Website Template',
      description: 'Create a restaurant, experience or lodging website with Saya. Showcase menus, bookable experiences and homes for direct stays. Included on every KrabiClaw plan.',
    },
  },
  blawby: {
    slug: 'blawby',
    displayName: 'Blawby',
    tagline: 'Your firm.\nA clear way forward.',
    summary: 'A focused website for solo lawyers and small law firms. Help people understand your practice and take the first step.',
    description: 'People looking for a lawyer need to know who you help, who they will work with, and how to get started. Blawby gives your practice areas, your people, and your consultation process room to speak clearly.',
    supportedVerticals: ['Solo lawyers', 'Small law firms'],
    status: 'available',
    published: true,
    priceLabel: 'Included on every plan',
    schemaOffer: { price: '0', priceCurrency: 'USD' },
    demoUrl: 'https://www.northcarolinalegalservices.org',
    previewImageUrl: '/images/products/ncls.jpg',
    artworkUrl: '/images/templates/blawby-law-office.png',
    logoUrl: 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/27bc2bf2-8582-4ed1-e77c-45d7a3215b00/public',
    demoLabel: 'Explore the live customer site',
    ctaLabel: 'Start free',
    ctaTo: '/signup',
    features: [
      {
        label: 'Help people find their kind of help.',
        description: 'Give each practice area a dedicated page. Explain the matters you handle, answer common questions, and show visitors how to contact your firm.',
      },
      {
        label: 'Put your people at the heart of it.',
        description: 'Introduce the lawyers behind your firm and explain how you work. Publish useful articles and firm news in your own voice.',
      },
      {
        label: 'A clear first step.',
        description: 'Bring consultation details, contact information, and scheduling links into a straightforward journey from reading about your firm to requesting a conversation.',
      },
    ],
    included: [
      'Practice-area and service pages',
      'Your firm’s story and people',
      'Consultation and contact pages',
      'Articles, legal updates, and firm news',
      'Privacy, terms, and notices pages',
      'A responsive website for every screen',
    ],
    sortOrder: 2,
    seo: {
      title: 'Blawby — Website Template for Lawyers and Law Firms',
      description: 'Build a law firm website with Blawby. Present your practice areas, introduce your people, and guide visitors toward a consultation. Included on every KrabiClaw plan.',
    },
  },
}

/** Publicly listable templates, in index sort order. Excludes unpublished/internal entries. */
export function listPublishedTemplateMarketing(): TemplateMarketingMetadata[] {
  return Object.values(publicTemplateMarketing)
    .filter(template => template.published)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Resolves marketing metadata for a /templates/[slug] route, or null for unknown/unpublished slugs (caller should 404). */
export function findPublishedTemplateMarketing(slug: string | null | undefined): TemplateMarketingMetadata | null {
  const normalized = String(slug ?? '').toLowerCase()
  const match = (Object.values(publicTemplateMarketing) as TemplateMarketingMetadata[])
    .find(template => template.slug === normalized)
  return match?.published ? match : null
}
