import type { LocationRecord } from '~/server/utils/location-management'
import { oncePerRequest } from '~/server/utils/request-scope'
import { timeRequestPhase } from '~/server/utils/request-metrics'
import { HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3';

import type { H3Event } from 'nitro'

import { cloudflareEnv } from '~/server/utils/api-response'
import { dashboardSessionUserQuery, getAuthSession, type DashboardAuthRead } from '~/server/utils/auth'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertOrganizationWideAccess, assignedOfferingCondition, BATCH_VIEWER, withViewer, locationAccessSql, type ViewerTerms, joinedMembership, memberAccessPrincipal, membershipByIdQuery, membershipBySlugQuery, resolveUserOrganization, type OfferingReadScope, type ResolvedMembership } from '~/server/utils/member-access'

import { parsePostalAddress } from '~/utils/postal-address'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { publicLocationSocialMediaFromPlacements, type PublicSocialMedia } from '~/server/utils/public-social-image'
import { publicLocationProtectedSql } from '~/server/utils/public-location-privacy'
import { mediaStillUrl, resolveOwnerPicture } from '~/shared/media-placement-contract'
import type { StayMapSharing } from '~/shared/stay-listing'

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
  /** The business's own clock, which its reports count days in. */
  timezone: string
}

export type DashboardOrganizationRow = ResolvedMembership & {
  id: string
  name: string
  slug: string
  /** The caller's Better Auth member row in this organization. */
  memberId: string
} & DashboardOrganizationConfig

export interface DashboardLocationRow {
  id: string
  slug: string
  title: string
  stay_map_sharing: StayMapSharing
  status: string
  timezone: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  media: PublicSocialMedia['media']
  social_image: PublicSocialMedia['social_image']
}

export interface DashboardLocationContextRow extends LocationRecord {
  organization_id: string
  last_synced_at: string | null
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

export async function readDashboardMemberResources(event: H3Event, organization: string | { slug: string } | BatchQuery, statements: BatchQuery[] = []) {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, message: 'Database unavailable' })
  const member = (user: string | BatchQuery) => typeof organization === 'object' && 'slug' in organization
    ? membershipBySlugQuery(organization.slug, user) : membershipByIdQuery(organization, user)
  const queries = (membership: BatchQuery) => [membership, ...statements.map(query => withViewer(membership, query))]
  const auth: DashboardAuthRead = {
    queries: token => queries(member(dashboardSessionUserQuery(token))),
  }
  const session = await getAuthSession(event, env, { document: auth, forwardCookies: true })
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required' })
  const [viewer, ...rows] = auth.results ?? await executeBatch(
    db, queries(member(session.user.id)), { operation: 'Read the authorized CMS resource' },
  )
  const resolved = dashboardOrganizationFrom(viewer!.results[0])
  if (resolved.userId !== session.user.id) throw new Error('CMS membership does not match the Better Auth session')
  return { env, db, session, organization: resolved, userId: session.user.id, rows }
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
  const context = await dashboardSessionContext(event)
  const slug = options.organizationSlug ?? dashboardOrgQueryParam(event)
  if (options.requireOrganization !== false && !slug) throw dashboardOrganizationRequired()
  // Only callers outside a tenant URL may use the session's active organization.
  const sessionRecord = context.session.session as typeof context.session.session & { activeOrganizationId?: string | null }
  const activeId = typeof sessionRecord.activeOrganizationId === 'string' ? sessionRecord.activeOrganizationId : null
  const membership = slug ? membershipBySlugQuery(slug, context.userId)
    : activeId ? membershipByIdQuery(activeId, context.userId) : null
  let row = membership && await (slug && event.req.method === 'GET'
    ? readDashboardMembership(event, slug, () => queryFirst(context.db, membership.query, membership.params))
    : queryFirst(context.db, membership.query, membership.params))
  if (!row && options.requireOrganization === false && slug && activeId) {
    const activeMembership = membershipByIdQuery(activeId, context.userId)
    row = await queryFirst(context.db, activeMembership.query, activeMembership.params)
  }
  if (!row && options.requireOrganization === false) return { ...context, organization: null }
  return { ...context, organization: dashboardOrganizationFrom(row) }
}

export function readDashboardMembership(event: H3Event, slug: string, read: () => Promise<unknown>) {
  return oncePerRequest(event, `dashboard-membership:${slug}`, read)
}

export function getDashboardSession(event: H3Event, env: ReturnType<typeof cloudflareEnv>, document?: DashboardAuthRead) {
  return oncePerRequest(event, 'dashboard-session', () => timeRequestPhase(event, 'auth_session', () =>
    getAuthSession(event, env, { forwardCookies: event.url.pathname.startsWith('/dashboard/'), document })))
}

async function dashboardSessionContext(event: H3Event) {
  const env = cloudflareEnv(event)
  const db = env.DB

  if (!db) {
    throw new HTTPError({ statusCode: 503, message: 'Database not available', data: { code: 'DATABASE_UNAVAILABLE', field: 'DB' } })
  }

  const session = await getDashboardSession(event, env)
  if (!session?.user?.id) {
    throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  }

  return { env, db, session, userId: session.user.id }
}

function dashboardOrganizationRequired() {
  return new HTTPError({ statusCode: 400, message: 'Organization context is required. Use /dashboard/{orgSlug} routes.',
    data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
}

export function dashboardOrganizationFrom(row: unknown): DashboardOrganizationRow {
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  const { organization_id, member_id, user_id, role, organization_wide: _wide, ...organization } = row as DashboardOrganizationConfig & {
    organization_id: string; name: string; slug: string; member_id: string; user_id: string; role: string; organization_wide: number
  }
  return { ...joinedMembership({ organization_id, member_id, user_id, role }), id: organization_id, ...organization }
}

export async function dashboardMemberQuery(event: H3Event, slug = dashboardOrgQueryParam(event)) {
  const context = await dashboardSessionContext(event)
  if (!slug) throw dashboardOrganizationRequired()
  return { ...context, membership: membershipBySlugQuery(slug, context.userId), organizationFrom: dashboardOrganizationFrom }
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

export function dashboardLocationQuery(target: { id: string } | { slug: string }, organization?: string | { sql: string }, viewer?: ViewerTerms, privacy = false): BatchQuery {
  return {
    query: `SELECT bl.id, bl.organization_id, bl.slug, bl.title, bl.address, bl.stay_map_sharing, bl.phone, bl.website_url, bl.maps_url,
           bl.latitude, bl.longitude, bl.opening_hours, bl.categories, bl.rating, bl.review_count, bl.status,
           bl.last_synced_at, bl.description, bl.short_description, bl.special_hours, bl.price_level, bl.email,
           bl.google_place_id, bl.google_review_url, bl.created_at, bl.updated_at, bl.timezone,
           bl.seo_title, bl.seo_description, bl.canonical_url${privacy ? `, ${publicLocationProtectedSql('bl')} AS is_stay_location` : ''}
      FROM business_locations bl WHERE bl.${'id' in target ? 'id' : 'slug'} = ?
      ${organization ? `AND bl.organization_id = ${typeof organization === 'string' ? '?' : organization.sql}` : ''}
      ${viewer ? `AND ${locationAccessSql(viewer, 'bl')}` : ''} LIMIT 1`,
    params: ['id' in target ? target.id : target.slug, ...(typeof organization === 'string' ? [organization] : [])],
  }
}

/** The explicit route workspace and location are authorized together. */
export async function getDashboardLocationContext(event: H3Event, locationId: string) {
  const slug = dashboardOrgQueryParam(event)
  if (event.url.searchParams.has('org') && !slug) throw dashboardOrganizationRequired()
  const organization = slug ? { slug } : {
    query: '(SELECT organization_id FROM business_locations WHERE id = ?)', params: [locationId],
  }
  const query = dashboardLocationQuery({ id: locationId }, { sql: BATCH_VIEWER.organization }, BATCH_VIEWER)
  const context = await readDashboardMemberResources(event, organization, [query])
  const location = context.rows[0]!.results[0] as DashboardLocationContextRow | undefined
  if (!location) throw new HTTPError({ statusCode: 404, message: 'Location not found or access denied' })
  return { ...context, location }
}

export function prepareDashboardLocations(
  organizationId: string | { sql: string },
  assignedUserId?: OfferingReadScope,
  includeInactive = false,
  includeLogo = false,
) {
  const assignment = assignedUserId ? assignedOfferingCondition(assignedUserId) : null
  const params = [...(typeof organizationId === 'string' ? [organizationId] : []), ...assignment?.params ?? []]
  const visible = `FROM business_locations l
    WHERE l.organization_id = ${typeof organizationId === 'string' ? '?' : organizationId.sql} ${includeInactive ? '' : "AND l.status = 'active'"}
      ${assignment ? `AND (${assignment.unrestricted} OR EXISTS (SELECT 1 FROM products p WHERE p.organization_id = l.organization_id AND (${assignment.sql})
        AND (EXISTS (SELECT 1 FROM product_locations pl WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id AND pl.location_id = l.id)
          OR EXISTS (SELECT 1 FROM product_sessions ps WHERE ps.organization_id = p.organization_id AND ps.product_id = p.id AND ps.location_id = l.id))))` : ''}`
  type Location = Omit<DashboardLocationRow, 'media' | 'social_image' | 'address'> & { address: string | null; is_stay_location: number }
  const queries = [
    { query: `SELECT l.id, l.slug, l.title, l.status, l.timezone, l.address, l.stay_map_sharing, l.latitude, l.longitude,
      ${publicLocationProtectedSql('l')} AS is_stay_location ${visible} ORDER BY l.title ASC`, params },
    mediaPlacementsQuery({ organizationId, ownerType: 'business_location',
      owners: { sql: `SELECT l.id ${visible}`, params }, includeOrganizationFallback: true }),
    ...(includeLogo ? [mediaPlacementsQuery({ organizationId, ownerType: 'organization',
      owners: typeof organizationId === 'string' ? [organizationId] : { sql: `SELECT ${organizationId.sql}` }, slot: 'logo' })] : []),
  ]
  return { queries, read }

  function read([locations, media, logo]: Awaited<ReturnType<typeof executeBatch>>, resolvedId?: string) {
    const id = resolvedId ?? (typeof organizationId === 'string' ? organizationId : null)
    if (!id) throw new Error('Location read requires the resolved organization')
    const placements = groupMediaPlacements(media!.results)
    const organizationMedia = (placements.get(id) ?? []).filter(item => item.owner_type === 'organization')
    const rows = (locations!.results as Location[]).map(({ is_stay_location, ...location }) => {
      const ownMedia = (placements.get(location.id) ?? []).filter(item => item.owner_type === 'business_location')
      const locationMedia = publicLocationSocialMediaFromPlacements({ is_stay_location }, ownMedia, organizationMedia)
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
    const organizationLogo = groupMediaPlacements(includeLogo ? logo!.results : []).get(id) ?? []
    const organizationMediaForDashboard = organizationLogo.map(({ asset_id, slot, public_url, thumbnail_url, kind, presentation }) => ({
      asset_id, slot, public_url, thumbnail_url, kind, presentation,
    }))
    return { locations: rows, media: organizationMediaForDashboard }
  }
}

export async function readDashboardLocations(db: DbClient, organizationId: string, assignedUserId?: string, includeInactive = false, includeLogo = false) {
  const plan = prepareDashboardLocations(organizationId, assignedUserId, includeInactive, includeLogo)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read dashboard locations and pictures' }))
}

export async function listDashboardLocations(db: DbClient, organizationId: string, assignedUserId?: string, includeInactive = false) {
  return (await readDashboardLocations(db, organizationId, assignedUserId, includeInactive)).locations
}
