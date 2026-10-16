import type { LayoutKey } from 'nuxt/app'
export type PublicTemplateSlug = 'saya' | 'blawby' | 'platform'

export interface PublicTemplateDefinition {
  slug: PublicTemplateSlug
  themeId: string
  layout: LayoutKey
  verticals: string[]
  serviceRoutes: {
    offeringsIndex: string | null
    offeringDetailPrefix: string | null
    articleIndex: string | null
    articleDetailPrefix: string
  }
  sitemap: {
    exactPaths: string[]
    dynamicPrefixes: string[]
  }
  nonIndexableExactPaths: string[]
  /**
   * Where this template renders a tenant page document.
   *
   * One declaration, read by the renderer that loads the document and by the
   * writer that decides whether a page may exist there. They used to be six
   * separate lists and they disagreed: /services was reserved against routes
   * deleted two commits earlier, /order and /reservations were reserved against
   * routes that do read a document, and /blog differs per template.
   *
   * `recipes` names the pages a template guarantees: the lookup a route loader
   * performs, and the set whose deletion the writer refuses. `paths` are the
   * documents a route still binds by path alone — only needed where a route
   * file claims the path, because a claimed path is one the catch-all cannot
   * reach. `prefixes` are subtrees served as documents. `catchAll` says whether
   * pages/[...tenantPath].vue renders unclaimed paths for this template; every
   * template sets it, KrabiClaw's own included, because KrabiClaw is a site row
   * like any other (#903).
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

export const publicTemplateRegistry: Record<PublicTemplateSlug, PublicTemplateDefinition> = {
  saya: {
    slug: 'saya',
    themeId: 'saya-theme-v1',
    layout: 'saya',
    verticals: ['restaurant', 'experience', 'lodging'],
    serviceRoutes: {
      offeringsIndex: null,
      offeringDetailPrefix: null,
      articleIndex: '/blog',
      articleDetailPrefix: '/blog',
    },
    sitemap: {
      exactPaths: ['/', '/menu', '/products', '/experiences', '/contact', '/blog', '/docs', '/locations', '/reservations', '/posts', '/photos', '/qa', '/reviews'],
      dynamicPrefixes: ['/blog/', '/docs/', '/experiences/', '/locations/', '/posts/'],
    },
    nonIndexableExactPaths: ['/contact/confirmed', '/bookings/cancel', '/bookings/confirmed', '/reservations/cancel', '/reservations/confirmed'],
    // Saya reads a document on the routes that request the 'content' dataset.
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
  },
  blawby: {
    slug: 'blawby',
    themeId: 'blawby-theme-v1',
    layout: 'blawby',
    verticals: ['service'],
    serviceRoutes: {
      offeringsIndex: '/services',
      offeringDetailPrefix: '/services',
      articleIndex: '/blog',
      articleDetailPrefix: '/article',
    },
    sitemap: {
      exactPaths: ['/', '/about', '/services', '/experiences', '/pricing', '/donate', '/schedule', '/contact', '/blog', '/docs', '/posts', '/third-party-notices'],
      dynamicPrefixes: ['/services/', '/experiences/', '/article/', '/blog/category/', '/docs/', '/posts/'],
    },
    nonIndexableExactPaths: ['/contact/confirmed', '/bookings/cancel', '/bookings/confirmed'],
    // The Blawby route loader looks a recipe up here. 'links', 'confirmation',
    // 'article' and 'page' are absent because they hold no document of their
    // own: the first two render from shell data, an article is a blog post, and
    // 'page' names its own path through the catch-all.
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
  },
  // KrabiClaw's own site: the marketing pages, documentation and blog. It is an
  // ordinary site row rendered by the platform layout; the platform host resolves
  // to whichever site owns the apex domain (see server/middleware/tenant-resolution.ts).
  platform: {
    slug: 'platform',
    themeId: 'krabiclaw-theme-v1',
    layout: 'platform',
    verticals: ['service'],
    serviceRoutes: {
      offeringsIndex: null,
      offeringDetailPrefix: null,
      articleIndex: '/blog',
      articleDetailPrefix: '/blog',
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
      // the Saya catalog's route on a customer host and KrabiClaw's own page on
      // this one. Everything else KrabiClaw publishes is an unclaimed path the
      // catch-all serves, the same as any tenant's.
      paths: ['/experiences', '/products'],
      prefixes: [],
      catchAll: true,
    },
  },
}

export const PLATFORM_TEMPLATE = publicTemplateRegistry.platform

export function isPlatformTemplate(input: { themeId?: string | null; vertical?: string | null }): boolean {
  return resolvePublicTemplate(input).slug === 'platform'
}

export const TENANT_NON_INDEXABLE_EXACT_PATHS = new Set(
  Object.values(publicTemplateRegistry).filter(template => template.slug !== 'platform').flatMap(template => template.nonIndexableExactPaths),
)

export function resolvePublicTemplate(input: {
  themeId?: string | null
  vertical?: string | null
}): PublicTemplateDefinition {
  const themeId = String(input.themeId ?? '').trim().toLowerCase()
  const vertical = String(input.vertical ?? '').trim().toLowerCase()

  if (!themeId && !vertical) {
    throw new Error('resolvePublicTemplate() requires a themeId or vertical selector.')
  }

  // KrabiClaw's own template is only ever selected by its theme id; a vertical
  // alone always names a customer template.
  const definitions = Object.values(publicTemplateRegistry).filter(definition => themeId || definition.slug !== 'platform')
  const match = definitions.find((definition) =>
    (!themeId || definition.themeId.toLowerCase() === themeId) &&
    (!vertical || definition.verticals.includes(vertical)),
  )

  if (!match) {
    throw new Error(`resolvePublicTemplate() found no compatible template for themeId="${themeId}" vertical="${vertical}".`)
  }
  return match
}

// The public Blawby API routes are a security gate, not just a rendering-path
// decision, so they require both a supported vertical and the exact theme id.
export function organizationSupportsBlawbyTemplate(input: {
  vertical?: string | null
  themeId?: string | null
}): boolean {
  const vertical = String(input.vertical ?? '').toLowerCase()
  const themeId = String(input.themeId ?? '').toLowerCase()
  return publicTemplateRegistry.blawby.verticals.includes(vertical) && themeId === publicTemplateRegistry.blawby.themeId
}

// ─────────────────────────────────────────────────────────────────────────
// Public marketing metadata — /templates index + /templates/[slug]
// ─────────────────────────────────────────────────────────────────────────
//
// Kept separate from publicTemplateRegistry above: that record is
// routing/rendering dispatch for *tenant* sites (which layout, which content
// model, which sitemap paths a live site running this template gets).
// publicTemplateMarketing is copy/positioning for the *platform marketing*
// pages that sell the template itself — a different audience (prospective
// customers browsing krabiclaw.com/templates) reading a different shape of
// data, but keyed by the same canonical slug so there is exactly one
// template identity to keep in sync.

export interface TemplateMarketingFeature {
  label: string
  description: string
}

export type TemplateMarketingStatus = 'available' | 'coming_soon'
export type MarketedTemplateSlug = Exclude<PublicTemplateSlug, 'platform'>

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
    summary: 'A website for the food you serve, the things you make, and the experiences people come back for.',
    description: 'Bring your restaurant or experience to life with generous photography, thoughtful menus, and a clear path to visit or book. Saya puts the details guests need alongside the story that makes your place yours.',
    supportedVerticals: ['Restaurants', 'Experiences'],
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
    ],
    included: [
      'Restaurant menus and dish pages',
      'Experience pages and booking flows',
      'Location pages with hours and directions',
      'Photos, reviews, and guest questions',
      'Posts, articles, and your brand story',
      'A responsive website for every screen',
    ],
    sortOrder: 1,
    seo: {
      title: 'Saya — Restaurant and Experience Website Template',
      description: 'Create a restaurant or experience website with Saya. Showcase menus, locations, and bookable experiences. Included on every KrabiClaw plan.',
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
