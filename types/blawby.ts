import type { GoogleReviewMetadata } from '~/shared/google-review'
import type { SocialImageSource } from '~/utils/social-metadata'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'



export type BlawbyShieldVariant = 'about' | 'blog' | 'contact' | 'pricing' | 'schedule' | 'confirmation' | 'donate' | 'privacy' | 'terms' | 'third-party-notices'

/**
 * Which shield a page opens under. The page says, because the page is what
 * differs. It lives here because two components ask the same question — the
 * hero that draws the shield and the divider that repeats its fill — and a
 * second copy of this map is a second answer waiting to disagree.
 */
const SHIELDS: Record<string, BlawbyShieldVariant> = {
  '/about': 'about', '/contact': 'contact', '/schedule': 'schedule', '/donate': 'donate', '/pricing': 'pricing',
  '/blog': 'blog', '/policies/privacy': 'privacy', '/policies/terms': 'terms',
  '/third-party-notices': 'third-party-notices',
}

export function blawbyShieldVariant(path: string): BlawbyShieldVariant {
  return SHIELDS[path] ?? 'about'
}

/**
 * The colour a page opens on. The hero paints it and the shield beneath cuts
 * its own shape out of it, so they are one answer: they were two switches on
 * the same variant, in two components, and the shield's had no case for the
 * legal pages at all.
 *
 * The legal pages open on the plain surface. They are long documents, and the
 * tint the other pages use behind a short hero ran the whole length of the terms.
 */
export function blawbySurface(variant: BlawbyShieldVariant): string {
  if (variant === 'schedule') return 'var(--blawby-primary-800)'
  if (variant === 'privacy' || variant === 'terms' || variant === 'third-party-notices') return 'var(--ui-bg-elevated)'
  // Every other band is the one warm band tint.
  return 'var(--blawby-accent-200)'
}

/**
 * The prose block the service overview draws inside its own column.
 *
 * This page is one two-column section: the pictures on the left, and on the
 * right the name, the whole body copy and the buttons. The body is its own
 * `markdown` block, so the hero draws it there and the renderer skips it —
 * one answer read by both, rather than drawing the block twice or folding an
 * article into `subtitle`, which is a one-line summary the cards also use.
 */
export function blawbyHeroProseBlockId(page: {
  path: string
  blocks: ReadonlyArray<{ id: string; type: string }>
  media: ReadonlyArray<{ kind: string | null; slot: string }>
}): string | null {
  if (page.path === '/') return null
  if (!page.media.some(item => item.kind === 'image' && (item.slot === 'cover' || item.slot === 'gallery'))) return null
  const heroIndex = page.blocks.findIndex(block => block.type === 'hero')
  if (heroIndex < 0) return null
  const next = page.blocks[heroIndex + 1]
  return next?.type === 'markdown' ? next.id : null
}

/**
 * A heading cut into the part before its emphasised phrase, the phrase, and the
 * part after — so the phrase can carry colour where it actually sits rather
 * than being repeated at the end. The hero and every section heading ask the
 * same question of their own title, and they answered it twice: the section
 * heading appended the accent instead of cutting it out, which is why the
 * practice-area FAQ heading read "Frequently asked questions questions".
 *
 * A title that does not contain the phrase keeps no accent, so a heading in a
 * locale the phrase was never translated into reads whole rather than gaining a
 * stray English word.
 */
export function blawbySplitAccent(title: string, accent?: string | null): { before: string; accent: string; after: string } {
  const phrase = accent ?? ''
  const index = phrase ? title.indexOf(phrase) : -1
  return index >= 0
    ? { before: title.slice(0, index), accent: phrase, after: title.slice(index + phrase.length) }
    : { before: title, accent: '', after: '' }
}


export interface PublicBlawbyPageLink {
  id: string
  path: string
  title: string
}


export interface PublicOrganizationReview {
  source: string | null
  original_reference: string | null
  google_review_metadata: GoogleReviewMetadata | null
  id: string
  author_name: string
  media: Array<{ asset_id: string; slot: string; public_url: string; thumbnail_url: string | null; kind: string; alt_text: string | null }>
  rating: number
  title: string | null
  content: string
  original_review_date: string | null
  verified: boolean
}

export const BLAWBY_ROUTE_RECIPES = [
  'home',
  'links',
  'services',
  'about',
  'pricing',
  'contact',
  'confirmation',
  'schedule',
  'blog',
  'article',
  'donate',
  'privacy',
  'terms',
  'third-party-notices',
  // The short-post feed and a post, which read the posts themselves.
  'posts',
  'experiences',
  // Any other page this site publishes, addressed by its own path. The named
  // recipes above are pages with branded sections; this one is the page.
  'page',
] as const

export type BlawbyRouteRecipe = typeof BLAWBY_ROUTE_RECIPES[number]

// 'article' is every article-collection route — an article, the docs index and
// a doc. The article page reads the article itself, the same way on every
// template, so the Blawby document carries only the site's chrome for it.
export const BLAWBY_SHELL_ONLY_ROUTE_RECIPES = ['links', 'article', 'posts', 'experiences'] as const

export type BlawbyShellOnlyRouteRecipe = typeof BLAWBY_SHELL_ONLY_ROUTE_RECIPES[number]

export function isBlawbyShellOnlyRouteRecipe(recipe: BlawbyRouteRecipe): recipe is BlawbyShellOnlyRouteRecipe {
  return (BLAWBY_SHELL_ONLY_ROUTE_RECIPES as readonly string[]).includes(recipe)
}

export interface PublicBlawbyRouteData {
  recipe: BlawbyRouteRecipe
  localeRepresentations: PublicLocaleRepresentation[]
  page: PublicTenantPage | null
}

export type PublicTenantPage = import('~/server/utils/public-tenant-pages').PublicTenantPage

export interface PublicConsultationSettings {
  mode: 'native' | 'external_url' | 'native_disabled'
  cta_label: string
  external_url: string | null
  schedule_path: string
  confirmation_path: string
  tracking_enabled: boolean
}

export interface PublicComplianceContactPoint {
  contact_type: string | null
  telephone: string | null
  email: string | null
  area_served: string | null
  available_language: string[] | string | null
  url: string | null
}

export interface PublicCompliance {
  entity_name: string | null
  dba_name: string | null
  entity_type: string | null
  /** Raw stored value — already normalized to a schema.org enum URL (e.g. https://schema.org/Nonprofit501c3) by the canonical write layer. */
  nonprofit_status: string | null
  registration_number: string | null
  service_area: string | null
  /** schema.org areaServed @type, e.g. 'State', 'City', 'Country'. */
  service_area_type: string | null
  disclaimer: string | null
  footer_disclaimer: string | null
  media: Array<{
    asset_id: string
    slot: string
    public_url: string | null
    kind: string | null
    alt_text: string | null
    file_name: string | null
  }>
  founder_name: string | null
  founding_date: string | null
  same_as: string[]
  contact_points: PublicComplianceContactPoint[]
  address_visibility: 'visible' | 'hidden'
}

export interface PublicBlawbyIdentity {
  name: string
  brand_description: string | null
  media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string | null }>
  social_image: SocialImageSource | null
  phone: string | null
}

export interface PublicBlawbyShellData {
  identity: PublicBlawbyIdentity
  consultation: PublicConsultationSettings
  canSchedule: boolean
  compliance: PublicCompliance | null
  pageLinks: PublicBlawbyPageLink[]
  /** The Search Console META token, served while Google needs to see it. */
  searchConsoleVerification: string | null
}
