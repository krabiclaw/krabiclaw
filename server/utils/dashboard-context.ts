import { HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3';

import type { H3Event } from 'nitro'

import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession, type CloudflareEnv } from '~/server/utils/auth'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { assertOrganizationWideAccess, ASSIGNED_SERVICE_SQL, memberAccessPrincipal, resolveUserOrganization, type ResolvedMembership } from '~/server/utils/member-access'
import { getOrganizationPlan } from '~/server/utils/billing-access'

import { parsePostalAddress } from '~/utils/postal-address'
import { readMediaPlacements } from '~/server/utils/media-asset-manager'
import { loadPublicSocialMedia, type PublicSocialMedia } from '~/server/utils/public-social-image'
import { mediaStillUrl, resolveOwnerPicture } from '~/shared/media-placement-contract'

/**
 * The tenant's own configuration, read from the `organization` row.
 *
 * These columns used to live on a `sites` row hanging off the organization, so
 * every dashboard request resolved a membership and then a second row to learn
 * what the business actually is. There is one row now, and `name` on the
 * membership carries what `sites.brand_name` carried.
 */
export interface DashboardOrganizationConfig {
  theme_id: string
  vertical: string | null
  subdomain: string | null
  custom_domain: string | null
  public_url: string | null
  status: string
  onboarding_status: string
  default_currency: string
}

export type DashboardOrganizationRow = ResolvedMembership & {
  id: string
  name: string
  slug: string
} & DashboardOrganizationConfig

const ORGANIZATION_CONFIG_SELECT = `
  SELECT id, theme_id, vertical, subdomain,
         (SELECT domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain,
         (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url,
         status, onboarding_status, default_currency
  FROM organization`
const ORGANIZATION_CONFIG_BY_ID_SQL = `${ORGANIZATION_CONFIG_SELECT} WHERE id = ? LIMIT 1`
const ORGANIZATION_CONFIG_BY_SLUG_SQL = `${ORGANIZATION_CONFIG_SELECT} WHERE slug = ? LIMIT 1`

// The dashboard shows the business's mark and nothing else of its media: the
// sidebar avatar is its `logo`, or no avatar at all.
export type DashboardOrganizationMedia = Array<{ asset_id: string, slot: string, public_url: string | null, thumbnail_url: string | null, kind: string | null }>

/** The presentation the tenant card needs: the plan and the logo, one read each. */
export interface DashboardOrganizationCard {
  effective_plan: string
  media: DashboardOrganizationMedia
}

export async function loadDashboardOrganizationCard(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
): Promise<DashboardOrganizationCard> {
  const [effectivePlan, placements] = await Promise.all([
    getOrganizationPlan(env, organizationId),
    readMediaPlacements(db, { organizationId, ownerType: 'organization', ownerIds: [organizationId], slot: 'logo' }),
  ])
  const media = (placements.get(organizationId) ?? []).map(item => ({
    asset_id: item.asset_id, slot: item.slot, public_url: item.public_url, thumbnail_url: item.thumbnail_url, kind: item.kind,
  }))
  return { effective_plan: effectivePlan, media }
}

export interface DashboardLocationRow {
  id: string
  slug: string
  title: string
  status: string
  timezone: string | null
  address: string | null
  media: PublicSocialMedia['media']
  social_image: PublicSocialMedia['social_image']
}

export interface DashboardLocationContextRow {
  id: string
  organization_id: string
  slug: string
  title: string
  address: string | null
  phone: string | null
  email: string | null
  website_url: string | null
  maps_url: string | null
  opening_hours: string | null
  rating: number | null
  review_count: number | null
  status: string
  last_synced_at: string | null
  description: string | null
  short_description: string | null
  price_level: string | null
  google_place_id: string | null
  google_review_url: string | null
  timezone: string | null
}

export interface DashboardContextOptions {
  requireOrganization?: boolean
  organizationSlug?: string | null
}

export interface ResolveOrganizationOptions {
  organizationSlug?: string | null
  // From an explicit caller-supplied param (e.g. billing's body/query organizationId).
  // Still membership-checked — never trusted outright.
  explicitOrganizationId?: string | null
  // The Better Auth session's session.activeOrganizationId, if the caller wants it
  // considered at all. Pass null/undefined to make this resolution strictly
  // query-param/explicit-param-only (the required behavior for billing and any other
  // URL-scoped route — a stale session-wide active org must never silently stand
  // in for the org actually named in the request).
  activeOrganizationId?: string | null
}

// The dashboard SPA's route (/dashboard/{orgSlug}/...) is the only source of
// truth for which org a request is for. dashboardFetch (composables/dashboardFetch.ts)
// sends that route context on every /api/dashboard/* request as an explicit,
// visible `org` query param rather than a bespoke request header.
export function dashboardOrgQueryParam(event: H3Event): string | null {
  const value = getQuery(event).org
  return typeof value === 'string' && value ? value : null
}

// The one place "which org is this request for" gets decided. Both explicit params
// and the `org` query param are membership-checked before being trusted;
// if both are present and disagree, that's a client bug (stale cached org id vs.
// current URL) and must fail loudly rather than silently pick one. activeOrganizationId
// is the last resort and only consulted when the caller explicitly passes it in —
// callers that have URL context (any /dashboard/{orgSlug}/... or billing/integration
// route reachable from one) must never pass it.
export async function resolveRequestedOrganization(
  event: H3Event,
  _db: DbClient,
  userId: string,
  options: ResolveOrganizationOptions = {}
) {
  const organizationSlug = options.organizationSlug ?? dashboardOrgQueryParam(event)
  const explicitOrganizationId = options.explicitOrganizationId ?? null
  const env = cloudflareEnv(event)

  const headerOrg = organizationSlug
    ? await resolveUserOrganization(env, { userId, organizationSlug }, event)
    : null

  if (explicitOrganizationId) {
    if (headerOrg && headerOrg.id !== explicitOrganizationId) {
      throw new HTTPError({
        statusCode: 400,
        message: 'Organization context conflict: the requested organization does not match the current dashboard context.',
        data: { code: 'ORGANIZATION_CONTEXT_CONFLICT', field: 'org' },
      })
    }
    if (headerOrg) return headerOrg

    return await resolveUserOrganization(env, { userId, organizationId: explicitOrganizationId }, event)
  }

  if (headerOrg) return headerOrg

  const activeOrganizationId = options.activeOrganizationId ?? null
  if (!activeOrganizationId) return null

  return await resolveUserOrganization(env, { userId, organizationId: activeOrganizationId }, event)
}

export async function getDashboardMemberContext(
  _event: H3Event,
  _options: DashboardContextOptions & { requireOrganization: false }
): Promise<{
  env: ReturnType<typeof cloudflareEnv>
  db: D1Database
  session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>
  userId: string
  organization: DashboardOrganizationRow | null
}>
export async function getDashboardMemberContext(
  _event: H3Event,
  _options?: DashboardContextOptions
): Promise<{
  env: ReturnType<typeof cloudflareEnv>
  db: D1Database
  session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>
  userId: string
  organization: DashboardOrganizationRow
}>
export async function getDashboardMemberContext(event: H3Event, options: DashboardContextOptions = {}): Promise<{
  env: ReturnType<typeof cloudflareEnv>
  db: D1Database
  session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>
  userId: string
  organization: DashboardOrganizationRow | null
}> {
  const env = cloudflareEnv(event)
  const db = env.DB

  if (!db) {
    throw new HTTPError({ statusCode: 503, message: 'Database not available', data: { code: 'DATABASE_UNAVAILABLE', field: 'DB' } })
  }

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) {
    throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  }

  // Session-wide activeOrganizationId is only ever considered when this specific
  // caller has declared it has no URL-scoped org context (requireOrganization: false —
  // the dashboard boot-discovery endpoint and the notifications badge, both of which
  // run outside any /dashboard/{orgSlug}/... route). Every other caller must resolve
  // strictly from the `org` query param; a missing one there is a real error, not
  // a cue to guess from a session field that can be stale relative to the URL.
  const sessionRecord = session.session as typeof session.session & { activeOrganizationId?: string | null }
  const activeOrganizationId = options.requireOrganization === false && typeof sessionRecord.activeOrganizationId === 'string'
    ? sessionRecord.activeOrganizationId
    : null

  // The route names the organization by slug, so its configuration row is read
  // beside the membership resolution instead of after it: one round trip fewer
  // on every dashboard call. The row only counts once the membership confirms
  // it is the same organization.
  const requestedSlug = options.organizationSlug ?? dashboardOrgQueryParam(event)
  const [membership, configBySlug] = await Promise.all([
    resolveRequestedOrganization(event, db, session.user.id, {
      activeOrganizationId,
      organizationSlug: options.organizationSlug,
    }),
    requestedSlug ? queryFirst<DashboardOrganizationConfig & { id: string }>(db, ORGANIZATION_CONFIG_BY_SLUG_SQL, [requestedSlug]) : null,
  ])

  if (!membership) {
    if (options.requireOrganization === false) {
      return { env, db, session, userId: session.user.id, organization: null }
    }
    const hasQueryParam = Boolean(options.organizationSlug ?? dashboardOrgQueryParam(event))
    throw new HTTPError({
      statusCode: hasQueryParam ? 404 : 400,
      message: hasQueryParam
        ? 'Organization not found'
        : 'Organization context is required. Use /dashboard/{orgSlug} routes.',
      data: { code: hasQueryParam ? 'ORGANIZATION_NOT_FOUND' : 'ORGANIZATION_REQUIRED', field: 'org' },
    })
  }

  // Better Auth owns the membership and the organization's identity; its own
  // adapter does not return the tenant configuration columns beside them, so
  // they are read here from the same row and carried on one object.
  const configRow = configBySlug?.id === membership.id
    ? configBySlug
    : await queryFirst<DashboardOrganizationConfig & { id: string }>(db, ORGANIZATION_CONFIG_BY_ID_SQL, [membership.id])
  if (!configRow) {
    throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  }
  const { id: _configId, ...config } = configRow
  const organization: DashboardOrganizationRow = Object.assign(membership, config)

  return { env, db, session, userId: session.user.id, organization }
}

export async function getDashboardContext(
  _event: H3Event,
  _options: DashboardContextOptions & { requireOrganization: false }
): Promise<{
  env: ReturnType<typeof cloudflareEnv>
  db: D1Database
  session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>
  userId: string
  organization: DashboardOrganizationRow | null
}>
export async function getDashboardContext(
  _event: H3Event,
  _options?: DashboardContextOptions
): Promise<{
  env: ReturnType<typeof cloudflareEnv>
  db: D1Database
  session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>
  userId: string
  organization: DashboardOrganizationRow
}>
export async function getDashboardContext(event: H3Event, options: DashboardContextOptions = {}) {
  const context = await getDashboardMemberContext(event, options)
  if (context.organization) await assertOrganizationWideAccess(context.db, memberAccessPrincipal(context.organization, { env: context.env, event }))
  return context
}

export async function getDashboardLocationContext(event: H3Event, locationId: string): Promise<{
  env: ReturnType<typeof cloudflareEnv>
  db: D1Database
  session: NonNullable<Awaited<ReturnType<typeof getAuthSession>>>
  userId: string
  organization: DashboardOrganizationRow
  location: DashboardLocationContextRow
}> {
  const env = cloudflareEnv(event)
  const db = env.DB

  if (!db) {
    throw new HTTPError({ statusCode: 503, message: 'Database not available' })
  }

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) {
    throw new HTTPError({ statusCode: 401, message: 'Authentication required' })
  }

  const row = await queryFirst<DashboardLocationContextRow>(db, `
    SELECT bl.id, bl.organization_id, bl.slug, bl.title, bl.address, bl.phone, bl.website_url, bl.maps_url,
           bl.latitude, bl.longitude, bl.opening_hours, bl.categories, bl.rating, bl.review_count, bl.status,
           bl.last_synced_at, bl.description, bl.short_description, bl.special_hours, bl.price_level, bl.email,
           bl.google_place_id, bl.google_review_url, bl.created_at, bl.updated_at, bl.timezone, bl.max_capacity,
           bl.seo_title, bl.seo_description, bl.canonical_url
    FROM business_locations bl
    WHERE bl.id = ?
    LIMIT 1
  `, [locationId])

  if (!row) {
    throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  }

  // The location row already names its organization, so the membership and the
  // configuration row are read in the same round trip.
  const [membership, configRow] = await Promise.all([
    resolveUserOrganization(env, { userId: session.user.id, organizationId: row.organization_id }, event),
    queryFirst<DashboardOrganizationConfig & { id: string }>(db, ORGANIZATION_CONFIG_BY_ID_SQL, [row.organization_id]),
  ])
  if (!membership) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  if (!configRow) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  const { id: _configId, ...config } = configRow

  return {
    env,
    db,
    session,
    userId: session.user.id,
    organization: Object.assign(membership, config),
    location: row,
  }
}

export async function listDashboardLocations(
  db: DbClient,
  organizationId: string,
  assignedUserId?: string,
  includeInactive = false,
) {

  const locations = await queryAll<Omit<DashboardLocationRow, 'media' | 'social_image' | 'address'> & { address: string | null }>(db, `
    SELECT l.id, l.slug, l.title, l.status, l.timezone, l.address
    FROM business_locations l
    WHERE l.organization_id = ? ${includeInactive ? '' : "AND l.status = 'active'"}
      ${assignedUserId ? `AND EXISTS (SELECT 1 FROM product_locations pl JOIN products p ON p.id = pl.product_id AND p.organization_id = pl.organization_id
        WHERE pl.organization_id = l.organization_id AND pl.location_id = l.id AND (${ASSIGNED_SERVICE_SQL}))` : ''}
    ORDER BY l.title ASC
  `, assignedUserId ? [organizationId, assignedUserId, assignedUserId] : [organizationId])
  const [media, organizationPlacements] = await Promise.all([
    loadPublicSocialMedia(db, organizationId, 'business_location', locations.map(location => location.id)),
    readMediaPlacements(db, { organizationId, ownerType: 'organization', ownerIds: [organizationId], slot: 'social_share' }),
  ])
  const organizationMedia = organizationPlacements.get(organizationId) ?? []

  return locations.map((location) => {
    const locationMedia = media.get(location.id)
    if (!locationMedia) throw new Error(`Location ${location.id} media was not loaded`)
    const hero = locationMedia.media.filter(item => item.slot === 'hero')
    return {
      ...location,
      address: parsePostalAddress(location.address),
      // The location tile shows its hero; the rest of its media is its own screens'.
      media: hero,
      // The tile's picture, decided by resolveOwnerPicture like every other
      // owner picture: a hero photo, else the brand's share image, else a
      // video's poster frame.
      picture_url: mediaStillUrl(resolveOwnerPicture('business_location', hero, organizationMedia)),
      social_image: locationMedia.social_image,
    }
  })
}
