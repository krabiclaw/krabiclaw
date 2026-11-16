/** Public starting designs marketed by KrabiClaw; never used to select site runtime behavior. */
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
  /** False hides this starting design from the marketing pages. */
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
      description: 'Build a restaurant, experience or lodging website with Saya. Show menus, home listings and nightly availability. Template included on every plan.',
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
