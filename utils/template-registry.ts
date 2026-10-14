import type { LayoutKey } from 'nuxt/app'
import type { PlatformIconName } from '~/components/platform/PlatformIcon.vue'
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
   * template sets it, Krabiclaw's own included, because Krabiclaw is a site row
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
    verticals: ['restaurant', 'experience'],
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
  // Krabiclaw's own site: the marketing pages, documentation and blog. It is an
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
    // Krabiclaw's own marketing pages are ordinary page documents on the
    // platform site, read by the same loader every customer site uses (#903).
    // The routes that are not editorial — /blog, /docs, /help, /templates —
    // are absent on purpose: they render their own data, and a document stored
    // at one of them would never be shown.
    pageDocuments: {
      recipes: { home: '/', about: '/about', pricing: '/pricing' },
      optionalLocalizedPaths: [],
      // Only a path a route file still claims needs naming here. /experiences is
      // the Saya catalog's route on a customer host and Krabiclaw's own page on
      // this one. Everything else Krabiclaw publishes is an unclaimed path the
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

  // Krabiclaw's own template is only ever selected by its theme id; a vertical
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
  icon: PlatformIconName
  label: string
  description: string
}

export interface TemplateMarketingSpec {
  label: string
  value: string
}

export type TemplateMarketingStatus = 'available' | 'coming_soon'

export interface TemplateMarketingSeo {
  title: string
  description: string
}

export type MarketedTemplateSlug = Exclude<PublicTemplateSlug, 'platform'>

export interface TemplateMarketingMetadata {
  slug: MarketedTemplateSlug
  displayName: string
  tagline: string
  /** Short positioning copy for the /templates index card. */
  summary: string
  /** Longer positioning copy for the /templates/[slug] detail page. */
  description: string
  /** Human-readable vertical labels for card/detail display (see publicTemplateRegistry.verticals for the machine-matched values). */
  supportedVerticals: string[]
  status: TemplateMarketingStatus
  /**
   * Marketing-visibility gate. False keeps a registry entry usable for
   * tenant rendering while excluding it from the public /templates index
   * and from resolving a /templates/[slug] detail route (404 instead).
   */
  published: boolean
  priceLabel: string
  priceNote: string
  /**
   * Structured-data price backing `priceLabel`'s schema.org Offer. Null when
   * the template is a paid-plan benefit rather than a separately free offer.
   */
  schemaOffer: { price: string, priceCurrency: string } | null
  /**
   * Canonical live-demo destination.
   * - Blawby: the NCLS-approved production showcase, a literal URL —
   *   `https://www.northcarolinalegalservices.org` — presented as an approved customer
   *   site, not a synthetic fixture.
   * - Saya: null. Saya's demo runs on an ephemeral seeded subdomain that
   *   differs between dev and production (`demo.<platformHostname>`), so
   *   the route component resolves it at runtime the same way
   *   pages/templates.vue always has, rather than this static registry
   *   hardcoding an environment-dependent host.
   */
  demoUrl: string | null
  demoLabel: string
  /**
   * Root-relative path to a real screenshot of this template's live demo site,
   * shown as the /templates index card's visual (see pages/templates/index.vue).
   * Null falls back to a letter-avatar placeholder.
   */
  previewImageUrl: string | null
  /**
   * Root-relative or absolute URL to this template's brand logo, shown in the
   * small avatar badges on the /templates index card and /templates/[slug]
   * detail page (preview banner, sticky nav, sidebar). Null falls back to the
   * same letter-avatar placeholder as `previewImageUrl` above.
   */
  logoUrl: string | null
  ctaLabel: string
  ctaTo: string
  features: TemplateMarketingFeature[]
  included: string[]
  specs: TemplateMarketingSpec[]
  /** Ascending sort order for the /templates index. */
  sortOrder: number
  /**
   * SEO copy for this template's detail page. Consumed as-is by
   * useSocialMetadata (the shared public-page metadata composer, itself a thin
   * adapter over the #259 composeSocialMetadata contract) — this is data,
   * not a new metadata/OG pipeline.
   */
  seo: TemplateMarketingSeo
}

export const publicTemplateMarketing: Record<MarketedTemplateSlug, TemplateMarketingMetadata> = {
  saya: {
    slug: 'saya',
    displayName: 'Saya',
    tagline: 'Elegant & minimal, built for local businesses',
    summary: 'Editorial restaurant and experience websites with Google Places imports.',
    description: 'The flagship Krabiclaw theme. Editorial typography, location-centric navigation, and Google Places imports — designed for local businesses that want to look as good online as they do in person.',
    supportedVerticals: ['Restaurants', 'Experiences'],
    status: 'available',
    published: true,
    priceLabel: 'Free',
    priceNote: 'No purchase needed — start building immediately',
    schemaOffer: { price: '0', priceCurrency: 'USD' },
    demoUrl: null,
    previewImageUrl: '/templates/saya-preview.jpg',
    logoUrl: '/saya-logo.png',
    demoLabel: 'View live demo',
    ctaLabel: 'Get started free',
    ctaTo: '/signup',
    features: [
      {
        icon: 'map-pin',
        label: 'Location pages',
        description: 'Hours, map embed, address, offerings preview, reviews, photos, and Q&A — all under one location URL.',
      },
      {
        icon: 'star',
        label: 'Reviews & ratings',
        description: 'Star distribution histogram, owner replies, and a filterable review feed.',
      },
      {
        icon: 'list',
        label: 'Full offerings',
        description: 'Sections, item photos, prices, details, and availability — all editable through ChatGPT.',
      },
      {
        icon: 'sparkles',
        label: 'ChatGPT Plugin',
        description: 'Update content, generate descriptions, publish posts, and manage your site by chatting directly in ChatGPT.',
      },
    ],
    included: [
      'Homepage with hero, location grid, and review highlights',
      'Location sub-pages: offerings, reviews, photos, Q&A, contact',
      'Unified Inbox for reservations and inquiries',
      'Google Places imports (Growth plan)',
      'ChatGPT Plugin for content management',
      'Reservation form',
      'Brand story / about page',
      'SEO-optimised with schema markup',
      'Mobile-first responsive layout',
      'Dark mode support',
      'Multi-location support (Growth plan)',
      'Custom domain (Growth plan)',
    ],
    specs: [
      { label: 'Price', value: 'Free' },
      { label: 'Locations', value: '1 on Starter / multiple on Growth' },
      { label: 'Mobile', value: 'Fully responsive' },
      { label: 'Languages', value: 'EN / TH' },
    ],
    sortOrder: 1,
    seo: {
      title: 'Saya Theme',
      description: 'The Saya theme — editorial design, Google Places imports, AI content management. Free on all plans.',
    },
  },
  blawby: {
    slug: 'blawby',
    displayName: 'Blawby',
    tagline: 'Professional-service sites for firms and practices',
    summary: 'Service and practice-area pages, article publishing, and consultation-focused CTAs for professional-service businesses.',
    description: 'The Blawby theme is built for professional-service businesses — law firms, clinics, and consultancies — with dedicated service/practice-area pages, article publishing, compliance/policy content, and consultation-oriented calls to action. Approved live on North Carolina Legal Services’ production site.',
    supportedVerticals: ['Professional services', 'Legal & consulting'],
    status: 'available',
    published: true,
    priceLabel: 'Included on Growth',
    priceNote: 'Approved customer showcase: North Carolina Legal Services',
    schemaOffer: null,
    demoUrl: 'https://www.northcarolinalegalservices.org',
    previewImageUrl: '/templates/blawby-preview.jpg',
    logoUrl: 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/27bc2bf2-8582-4ed1-e77c-45d7a3215b00/public',
    demoLabel: 'View live customer site',
    ctaLabel: 'Get started',
    ctaTo: '/signup',
    features: [
      {
        icon: 'briefcase',
        label: 'Service & practice-area pages',
        description: 'Dedicated pages per service or practice area, each with its own canonical URL and structured data.',
      },
      {
        icon: 'file-text',
        label: 'Article publishing',
        description: 'A full blog/article system for legal updates, guidance, and firm news, editable through ChatGPT.',
      },
      {
        icon: 'shield-check',
        label: 'Compliance & policy pages',
        description: 'Privacy policy, terms, and third-party notices ready out of the box for regulated professional services.',
      },
      {
        icon: 'calendar',
        label: 'Consultation CTAs',
        description: 'Schedule and contact flows built around booking a consultation rather than a table or tour.',
      },
    ],
    included: [
      'Homepage with services overview and firm positioning',
      'Service / practice-area detail pages',
      'Article publishing for firm news and legal guidance',
      'About, pricing, and donate pages',
      'Consultation scheduling and contact flows',
      'Privacy, terms, and third-party notices pages',
      'ChatGPT Plugin for content management',
      'Professional-service structured data (schema.org)',
      'Mobile-first responsive layout',
      'Custom domain (Growth plan)',
    ],
    specs: [
      { label: 'Price', value: 'Included on Growth' },
      { label: 'Live showcase', value: 'www.northcarolinalegalservices.org' },
      { label: 'Mobile', value: 'Fully responsive' },
      { label: 'Structured data', value: 'ProfessionalService' },
    ],
    sortOrder: 2,
    seo: {
      title: 'Blawby Theme',
      description: 'The Blawby theme for professional-service businesses — service pages, article publishing, and consultation CTAs. See it live on North Carolina Legal Services.',
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
