// Shared registry for dashboard deep-links, used by both the client/tenant
// MCP (server/utils/mcp-tools) and ChowBot's own tool executor
// (server/utils/chowbot-agent.ts) — two otherwise-separate tool-calling
// implementations that should still produce identical dashboard URLs.
export const DASHBOARD_DESTINATIONS = {
  'settings.billing': 'payments?tab=plan',
  'settings.members': 'team',
  'organization.overview': '',
  'organization.locations.new': 'locations/new',
  'organization.domains': 'website/domains',
  'organization.settings': 'menu',
  'location.overview': 'locations/:locationSlug',
  'location.settings': 'locations/:locationSlug/settings',
  support: 'support',
} as const

export type DashboardDestination = keyof typeof DASHBOARD_DESTINATIONS

export interface DashboardLinkOrgContext {
  env: { NUXT_PUBLIC_PLATFORM_DOMAIN?: string }
  organizationId: string
  organizationSlug?: string
  locationSlug?: string | null
}

function requiredDashboardSegment(
  value: string | null | undefined,
  label: 'organizationSlug' | 'locationSlug',
  destination: DashboardDestination,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    throw new Error(`Dashboard destination ${destination} requires explicit ${label} context`)
  }
  return encodeURIComponent(trimmed)
}

export function buildDashboardUrl(organization: DashboardLinkOrgContext, destination: DashboardDestination): string {
  const platformDomain = organization.env.NUXT_PUBLIC_PLATFORM_DOMAIN
  if (!platformDomain) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  const orgSlug = requiredDashboardSegment(organization.organizationSlug, 'organizationSlug', destination)
  const path = DASHBOARD_DESTINATIONS[destination]
    .replace(/^\/+/, '')
    .replaceAll(':locationSlug', pathRequiresLocationSlug(destination) ? requiredDashboardSegment(organization.locationSlug ?? null, 'locationSlug', destination) : '')
  if (path.includes('//') || path.endsWith('/')) {
    throw new Error(`Dashboard destination ${destination} requires explicit location context`)
  }
  // The organization root is the dashboard's own path, with nothing under it.
  return path ? `${platformDomain}/dashboard/${orgSlug}/${path}` : `${platformDomain}/dashboard/${orgSlug}`
}

function pathRequiresLocationSlug(destination: DashboardDestination): boolean {
  return DASHBOARD_DESTINATIONS[destination].includes(':locationSlug')
}

// ---------------------------------------------------------------------------
// One editor URL per record, relative to the platform host. Dashboard search,
// MCP's edit URLs and the dashboard's own cross-workspace links all build them
// here, so every entry point opens the same record in the same editor.
// ---------------------------------------------------------------------------

function organizationBase(orgSlug: string): string {
  return `/dashboard/${encodeURIComponent(orgSlug)}`
}

/** A location's scope on a shared manager, which it reaches by its id. */
function scopedTo(path: string, locationId: string | null | undefined): string {
  return locationId ? `${path}?location_id=${encodeURIComponent(locationId)}` : path
}

export function catalogPath(orgSlug: string, locationId?: string | null): string {
  return scopedTo(`${organizationBase(orgSlug)}/products`, locationId)
}

export function productEditorPath(orgSlug: string, productId: string, locationId?: string | null): string {
  return scopedTo(`${organizationBase(orgSlug)}/products/${encodeURIComponent(productId)}`, locationId)
}

export function collectionEditorPath(orgSlug: string, collectionId: string, locationId?: string | null): string {
  return scopedTo(`${organizationBase(orgSlug)}/products/menu/${encodeURIComponent(collectionId)}`, locationId)
}

/** Every page is edited in Pages, including the page a Product owns. */
export function pageEditorPath(orgSlug: string, page: { id: string }): string {
  return `${organizationBase(orgSlug)}/website/pages/${encodeURIComponent(page.id)}`
}

export function blogEditorPath(orgSlug: string, articleId: string): string {
  return `${organizationBase(orgSlug)}/website/blog/${encodeURIComponent(articleId)}`
}

export function blogCreatePath(orgSlug: string): string {
  return `${blogEditorPath(orgSlug, 'new')}/headline`
}

/** Prepare a draft from this article; opening it never publishes anything. */
export function articleFacebookPostPath(orgSlug: string, articleId: string, locationId?: string | null): string {
  const query = new URLSearchParams({ article_id: articleId, channel: 'facebook' })
  if (locationId) query.set('location_id', locationId)
  return `${organizationBase(orgSlug)}/website/posts/new/body?${query}`
}

export function insightsPath(orgSlug: string, range?: { startDate: string; endDate: string }): string {
  const path = `${organizationBase(orgSlug)}/insights`
  return range ? `${path}?${new URLSearchParams(range)}` : path
}

export function bookingEditorPath(orgSlug: string, kind: 'reservation' | 'booking', requestId: string): string {
  return `${organizationBase(orgSlug)}/bookings/${kind}/${encodeURIComponent(requestId)}`
}

export function guestConversationPath(orgSlug: string, requestId: string): string {
  return `${organizationBase(orgSlug)}/messages/${encodeURIComponent(requestId)}`
}

export function articleCategoryEditorPath(orgSlug: string, categoryId: string): string {
  return `${organizationBase(orgSlug)}/website/blog/categories/${encodeURIComponent(categoryId)}`
}

export function brandEditorPath(orgSlug: string): string {
  return `${organizationBase(orgSlug)}/website/brand`
}

export function linksEditorPath(orgSlug: string): string {
  return `${organizationBase(orgSlug)}/website/pages/links`
}

export function postEditorPath(orgSlug: string, postId: string, locationId?: string | null): string {
  return scopedTo(`${organizationBase(orgSlug)}/website/posts/${encodeURIComponent(postId)}`, locationId)
}

export function qaEditorPath(orgSlug: string, qaId: string, locationId?: string | null): string {
  return scopedTo(`${organizationBase(orgSlug)}/website/qa/${encodeURIComponent(qaId)}`, locationId)
}

/** A review is a row of the Reviews tab beside Q&A, listed per scope, so its location rides along. */
export function reviewEditorPath(orgSlug: string, reviewId: string, locationId?: string | null): string {
  return scopedTo(`${organizationBase(orgSlug)}/website/qa/reviews/${encodeURIComponent(reviewId)}`, locationId)
}

export function locationEditorPath(orgSlug: string, locationSlug: string): string {
  return `${organizationBase(orgSlug)}/locations/${encodeURIComponent(locationSlug)}`
}
