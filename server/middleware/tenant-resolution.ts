import { PUBLIC_CACHE_REVISION_SQL, publicCacheRevision } from '~/server/utils/edge-cache'
// Tenant resolution middleware: every host, Blawby's own included, resolves
// to an organization. The organization's site decides whether it renders as
// the platform (marketing, docs, blog) or as a customer site.

import { HTTPError, defineHandler  } from 'nitro';
import type { H3Event } from 'nitro';
import { getCookie, getQuery, redirect, setResponseHeader } from 'nitro/h3';
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from "~/server/db";
import { TENANT_TYPES } from "~/utils/tenant-routing";
import { cloudflareEnv, isInternalSelfFetch } from "../utils/api-response";
import {
  BLAWBY_FREE_SITE_HOST, environmentTenantAliasSlug, isNonProductionHost, LEGACY_FREE_SITE_HOST, normalizeHost,
  hostnameOf,
  isPlatformHost,
  usesTenantHeader,
} from "../utils/tenant-hosts";
import { clearPreviewAuthorization, previewSecretOf, PREVIEW_COOKIE_NAME, PREVIEW_TOKEN_QUERY, PUBLIC_WEBSITE_QUERY, resolvePreviewAuthorization } from "../utils/preview-token";
import { PLATFORM_SITE, resolvePublicSite } from "~/utils/site-routing";
import { organizationSocialMediaFromJson } from '~/server/utils/public-social-image'
import { resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette, resolveSitePalette } from '~/shared/site-palette'
import { parseSiteRecipe } from '~/shared/site-recipe'
import { LOGO_SLOTS, ORIGINAL_LOGO_PRESENTATION, parseLogoPresentation, type SiteLogo } from '~/shared/media-placement-contract'
import { publicTenantPageSql } from '~/server/utils/content/pages'
import { buildLoginUrl } from '~/shared/auth/return-target'
import { BROWSER_ERROR_PATH } from '~/shared/error-telemetry'
import type { DashboardAuthRead } from '~/server/utils/auth'
import { dashboardOrganizationFrom, getDashboardSession, readDashboardMembership } from '~/server/utils/dashboard-context'
import { prepareDashboardWorkspaceAccess, readDashboardWorkspaceAccess } from '~/server/utils/dashboard-context-service'
import { membershipBySlugQuery, BATCH_VIEWER, withViewer } from '~/server/utils/member-access'
import { prepareToday } from '~/server/domain/today'
import { staffAccessWritesEnabled } from '~/server/domain/listing-access'
import { readDashboardTodayDocument } from '~/server/utils/dashboard-today'
import { readPublicSourceLocale, sourceLocaleQuery } from '~/server/utils/localization'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { calendarCoverageQuery } from '~/server/domain/member-scheduling'
import { calendarConnectionQuery, calendarSettingsFromRows, readCalendarSettingsDocument } from '~/server/utils/google-calendar'
import { prepareConnectionSummary } from '~/server/utils/organization-settings'
import { readDashboardConnectionsDocument } from '~/server/utils/dashboard-connections'
import { prepareDashboardCatalog, readDashboardCatalogDocument } from '~/server/utils/dashboard-catalog'
import { setDashboardSocketScope } from '~/server/utils/dashboard-socket-scope'
import { prepareDashboardBookingRead, readDashboardBookingDocument } from '~/server/utils/dashboard-bookings'
import { publicBaseColumns, seedPublicBase, type PublicBase } from '~/server/utils/public-base'
import { placesPresenceQuery } from '~/server/domain/places'
import { prepareDashboardAgendaDocument } from '~/server/utils/dashboard-agenda-reader'
import { isValidCalendarDate } from '~/utils/timezone'
import { parseDate } from '@internationalized/date'
import { prepareDashboardEarningsDocument } from '~/server/utils/dashboard-earnings'
import { PUBLIC_CONFIG_COLUMNS, type PublicConfigRow } from '~/server/utils/organization-config'
import { publicTenantRedirectQuery, type PublicTenantRedirect } from '~/server/utils/public-redirects'
import { preparePublicShellRows, type PublicDocumentShell } from '~/server/utils/public-shell-query'

interface TenantRow extends Omit<PublicBase['organization'], 'theme_id' | 'name'>, Omit<PublicConfigRow, 'default_currency'> {
  id: string;
  public_cache_revision: string | null;
  theme_id: string | null;
  subdomain: string;
  status: string;
  onboarding_status: string;
  canonical_domain: string | null;
  name: string;
  brand_description: string | null;
  media_json: string;
  vertical: string | null;
  timezone: string;
  facebook_page_id: string | null;
  instagram_username: string | null;
  privacy_policy: number;
  terms_policy: number;
  acceptable_use_policy: number;
  font_preset: unknown;
  font_preset_type: string | null;
  palette: string | null;
  button_shape: string | null;
  button_casing: string | null;
  button_color: string | null;
  heading_casing: string | null;
  source_locale_rows: string;
  published_locales: string;
  has_payment_account: number;
  redirect_json?: string | null;
}

const TENANT_MEDIA_SELECT_SQL = `(SELECT COALESCE(json_group_array(json_object(
  'asset_id', ordered.asset_id, 'slot', ordered.slot, 'public_url', ordered.public_url,
  'thumbnail_url', ordered.thumbnail_url, 'kind', ordered.kind, 'mime_type', ordered.mime_type,
  'width', ordered.width, 'height', ordered.height, 'presentation', json(ordered.presentation_json)
)), json('[]')) FROM (
  SELECT mp.asset_id, mp.slot, ma.public_url, ma.thumbnail_url, ma.kind, ma.mime_type, ma.width, ma.height, mp.presentation_json, mp.id
  FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
  WHERE mp.organization_id = o.id AND mp.owner_type = 'organization' AND mp.owner_id = o.id AND mp.status = 'active'
  ORDER BY mp.slot, mp.sort_order, mp.id
) ordered)`

const TENANT_SELECT_SQL = `SELECT ${publicBaseColumns('o')},
             ${PUBLIC_CACHE_REVISION_SQL} AS public_cache_revision, o.subdomain, o.status, o.onboarding_status,
             ${TENANT_MEDIA_SELECT_SQL} AS media_json, o.timezone,
             EXISTS (SELECT 1 FROM stripe_connected_accounts account WHERE account.organization_id = o.id
               AND account.stripe_account_id IS NOT NULL) AS has_payment_account,
             (SELECT json_group_array(json_object('id', src.id, 'organization_id', src.organization_id,
               'locale', src.locale, 'label', src.label, 'is_source', src.is_source, 'status', src.status,
               'created_at', src.created_at, 'updated_at', src.updated_at))
               FROM (${sourceLocaleQuery({ sql: 'o.id' }).query}) src) AS source_locale_rows,
             (SELECT json_group_array(locale) FROM (SELECT locale FROM organization_locales
               WHERE organization_id = o.id AND is_source = 0 AND status = 'published' ORDER BY locale)) AS published_locales,
             (SELECT i.target_id FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'facebook') AS facebook_page_id,
             (SELECT i.target_name FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'instagram') AS instagram_username,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/privacy' AND ${publicTenantPageSql('d')}) AS privacy_policy,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/terms' AND ${publicTenantPageSql('d')}) AS terms_policy,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/acceptable-use' AND ${publicTenantPageSql('d')}) AS acceptable_use_policy,
             ${PUBLIC_CONFIG_COLUMNS}`

function tenantSelectFor(event: H3Event) {
  const path = normalizedPath(event.url.pathname)
  if (!['GET', 'HEAD'].includes(event.method) || !/^\/(?:[A-Za-z-]+\/)?(?:menu|reviews)$/.test(path)) {
    return { query: TENANT_SELECT_SQL, params: [] }
  }
  const redirect = publicTenantRedirectQuery({ sql: 'o.id' }, path)
  return { query: `${TENANT_SELECT_SQL}, (SELECT json_object('toPath', toPath, 'statusCode', statusCode, 'behavior', behavior)
    FROM (${redirect.query})) AS redirect_json`, params: redirect.params }
}

async function readTenantFromHost(event: H3Event, db: DbClient, canonicalDomain: string, selection: string, parameters: string[]) {
  const read = tenantSelectFor(event)
  const host = { query: `${read.query}, ${canonicalDomain} AS canonical_domain ${selection} LIMIT 1`, params: [...read.params, ...parameters] }
  const path = normalizedPath(event.url.pathname)
  const includeMenu = path === '/menu'
  const includeReviews = path === '/reviews'
  if (event.method !== 'GET' || (!includeMenu && !includeReviews)
    || event.url.searchParams.has(PREVIEW_TOKEN_QUERY) || getCookie(event, PREVIEW_COOKIE_NAME)) {
    return queryFirst<TenantRow>(db, host.query, host.params)
  }

  const authorized = { query: `SELECT o.id ${selection}
    AND o.status = 'active' AND o.onboarding_status = 'active' LIMIT 1`, params: parameters }
  const organization = { sql: '(SELECT id FROM viewer)' }
  const locale = { sql: `(SELECT locale FROM organization_locales WHERE organization_id = ${organization.sql} AND is_source = 1)` }
  const plan = preparePublicShellRows(organization, locale, { includeMenu, includeReviews, previewMenu: false })
  const [hostRows, ...results] = await executeBatch(db, [host, ...plan.queries.map(query => withViewer(authorized, query))], {
    operation: includeMenu ? 'Read the public Menu document' : 'Read the public Reviews document',
  })
  const tenant = hostRows?.results[0] as TenantRow | undefined
  if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
    const source = JSON.parse(tenant.source_locale_rows) as { locale: string }[]
    if (source.length === 1) {
      event.context.publicDocumentShell = {
        organizationId: tenant.id, locale: source[0]!.locale, includeMenu, includeReviews, plan, results,
      } satisfies PublicDocumentShell
    }
  }
  return tenant ?? null
}

// Blawby's own tenant is the one active organization running the platform
// site. Platform hosts differ per environment (localhost, staging, the
// apex), so the host itself is not the key; the site is.
function platformTenantQuery() {
  return { query: `
      ${TENANT_SELECT_SQL},
             canonical.domain AS canonical_domain
      FROM organization o
      LEFT JOIN organization_domains canonical
        ON canonical.organization_id = o.id AND canonical.role = 'canonical' AND canonical.status = 'active'
      WHERE o.theme_id = ? AND o.status = 'active' AND o.onboarding_status = 'active'
      LIMIT 1
    `, params: [PLATFORM_SITE.themeId] }
}

async function resolvePlatformTenant(db: DbClient): Promise<TenantRow | null> {
  const { query, params } = platformTenantQuery()
  return queryFirst<TenantRow>(db, query, params)
}

async function resolveDashboardTenant(event: H3Event, slug: string, panel: string) {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return null
  let plan: ReturnType<typeof prepareDashboardTenant> | undefined
  const read: DashboardAuthRead = {
    queries(token) {
      plan = prepareDashboardTenant(event, db, env, membershipBySlugQuery(slug, {
        query: '(SELECT "userId" FROM session WHERE token = ? AND "expiresAt" >= unixepoch())', params: [token],
      }), slug, panel)
      return plan.queries
    },
  }
  const session = await getDashboardSession(event, env, read)
  if (!session?.user.id) return null
  plan ??= prepareDashboardTenant(event, db, env, membershipBySlugQuery(slug, session.user.id), slug, panel)
  const results = read.results ?? await executeBatch(db, plan.queries, { operation: 'Read the dashboard document' })
  return plan.present(results, session)
}

function prepareDashboardTenant(event: H3Event, db: D1Database, env: ReturnType<typeof cloudflareEnv>, membership: BatchQuery, slug: string, panel: string) {
  const user = { sql: BATCH_VIEWER.user }
  const host = platformTenantQuery()
  const workspace = prepareDashboardWorkspaceAccess({ sql: BATCH_VIEWER.organization }, user, true)
  const today = panel === '' ? prepareToday(db, {
    slug, membership, now: new Date(), range: event.url.searchParams.get('range') === 'upcoming' ? 'upcoming' : 'today',
    staffAccessWrites: staffAccessWritesEnabled(env),
  }) : null
  const managedOrg = { sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 THEN ${BATCH_VIEWER.organization} END` }
  const connections = /^\/integrations(?:\/|$)/.test(panel) ? prepareConnectionSummary(managedOrg) : null
  const google = panel === '/integrations/google-calendar' ? [
    calendarConnectionQuery(managedOrg),
    calendarCoverageQuery({ organization: managedOrg.sql, user: BATCH_VIEWER.user,
      admin: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ members: ['read'] })) }),
  ] : null
  const query = getQuery(event)
  const catalogRead = { products: ['read'] } as const
  const catalogRoles = [...rolesAllowing({ products: ['read'] }), ...rolesAllowing({ products: ['assigned'] })]
  const catalog = panel === '/products' && query.view !== 'menu' && query.view !== 'section'
    ? prepareDashboardCatalog({
      organizationId: { sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, catalogRoles)} THEN ${BATCH_VIEWER.organization} END` },
      assignedUserId: { user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: [...catalogRead.products] })) },
    }, query) : null
  const bookingId = /^\/bookings\/([^/]+)$/.exec(panel)?.[1]
  const booking = bookingId && bookingId !== 'new' ? prepareDashboardBookingRead(membership, bookingId) : null
  const calendar = /^\/calendar(?:\/|$)/.test(panel)
    ? withViewer(membership, placesPresenceQuery({ query: BATCH_VIEWER.organization, params: [] }, user)) : null
  const day = /^\/calendar\/(\d{4}-\d{2}-\d{2})$/.exec(panel)?.[1]
  // Calendar uses the workspace's local month. Before reading its zone the two
  // UTC offsets bound the possible months, including across New Year's Day.
  const now = Date.now()
  const earlyMonth = new Date(now - 12 * 3_600_000).toISOString().slice(0, 7)
  const lateMonth = new Date(now + 14 * 3_600_000).toISOString().slice(0, 7)
  const chosenMonth = day?.slice(0, 7) ?? (typeof query.month === 'string' ? query.month : null)
  const month = day || panel === '/calendar' ? `${chosenMonth ?? earlyMonth}-01` : null
  const agenda = month && isValidCalendarDate(month) && (!day || isValidCalendarDate(day)) && !query.product_id && query.view !== 'year'
    ? prepareDashboardAgendaDocument(db, membership, slug, {
      from: month, to: parseDate(chosenMonth ? month : `${lateMonth}-01`).add({ months: 1 }).subtract({ days: 1 }).toString(),
      location_id: query.location_id === '__all__' ? undefined : query.location_id,
      assigned_member_id: query.assigned_member_id === '__all__' ? undefined : query.assigned_member_id,
      kinds: query.kinds === '__all__' ? undefined : query.kinds,
    })
    : null
  const earningsMonths = new Set([new Date().toISOString().slice(0, 7)])
  if (panel === '/earnings/performance' && typeof query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)) earningsMonths.add(query.month)
  const earnings = /^\/earnings(?:\/|$)/.test(panel) ? prepareDashboardEarningsDocument(membership, earningsMonths) : null
  const queries = [
    host, membership,
    ...workspace.queries.map(query => withViewer(membership, query)),
    ...(today?.queries.slice(1) ?? []),
    ...(connections?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(google?.map(query => withViewer(membership, query)) ?? []),
    ...(catalog?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(booking?.queries ?? []),
    ...(calendar ? [calendar, ...agenda?.queries ?? []] : []),
    ...(earnings?.queries ?? []),
  ]
  return { queries, present }

  async function present([tenantResult, viewerResult, ...rest]: D1Result[], session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>) {
    const tenant = tenantResult!.results[0] as TenantRow | undefined
    if (!tenant) return null
    await readPublicSourceLocale(event, db, tenant.id, JSON.parse(tenant.source_locale_rows) as unknown[])
    const viewer = viewerResult!.results[0]
    const organization = dashboardOrganizationFrom(viewer)
    const userId = session.user.id
    if (organization.userId !== userId) throw new Error('Dashboard membership does not match the Better Auth session')
    await readDashboardMembership(event, slug, async () => viewer)
    await readDashboardWorkspaceAccess(event, { db, env, organization }, true, workspace.read(rest.slice(0, workspace.queries.length), organization.id))
    const panelRows = rest.slice(workspace.queries.length)
    if (today) await readDashboardTodayDocument(event, slug, () => today.read([viewerResult!, ...panelRows]))
    if (connections && (viewer as { organization_wide: number }).organization_wide === 1) {
      await readDashboardConnectionsDocument(event, slug, connections.read(panelRows))
      if (google) await readCalendarSettingsDocument(event, slug, calendarSettingsFromRows(panelRows.slice(connections.queries.length)))
    }
    if (catalog) await readDashboardCatalogDocument(event, slug, catalog.read(panelRows, organization.id))
    if (booking && bookingId) await readDashboardBookingDocument(event, { orgSlug: slug, bookingId }, [viewerResult!, ...panelRows])
    if (calendar) {
      event.context.dashboardCalendarPresence = { slug, has_places: (panelRows[0]!.results[0] as { has_places: number }).has_places === 1 }
      if (agenda) await agenda.apply(event, panelRows.slice(1), { env, organization })
    }
    if (earnings && panelRows[2]?.results.length) earnings.apply(event, panelRows, organization)
    setResponseHeader(event, 'cache-control', 'private, no-store')
    await setDashboardSocketScope(event, env, { slug, organizationId: organization.id, sessionId: session.session.id, userId })
    return tenant
  }
}

function publicTenantMedia(tenant: Pick<TenantRow, 'media_json'>) {
  return organizationSocialMediaFromJson(tenant.media_json)
}

/** The site's logo and its optional dark-ground logo, each as its placement presents it. */
function siteLogos(mediaJson: string): SiteLogo[] {
  const placements = JSON.parse(mediaJson) as Array<{ slot: string; public_url: string | null; presentation: unknown }>
  return placements
    .filter(item => (LOGO_SLOTS as readonly string[]).includes(item.slot) && item.public_url)
    .map(item => ({
      slot: item.slot as SiteLogo['slot'],
      url: item.public_url!,
      presentation: item.presentation == null ? ORIGINAL_LOGO_PRESENTATION : parseLogoPresentation(item.presentation),
    }))
}

/** The profiles a site links to are the accounts connected in Integrations, and only those. */
function connectedSocialProfiles(tenant: Pick<TenantRow, 'facebook_page_id' | 'instagram_username'>) {
  return [
    ...(tenant.facebook_page_id ? [{ network: 'facebook' as const, url: `https://www.facebook.com/${encodeURIComponent(tenant.facebook_page_id)}` }] : []),
    ...(tenant.instagram_username ? [{ network: 'instagram' as const, url: `https://www.instagram.com/${encodeURIComponent(tenant.instagram_username)}/` }] : []),
  ]
}

export interface SpentSubdomainResolution {
  spent: true
  successorDomain: string | null
}

function isSpentSubdomainResolution(
  value: TenantRow | SpentSubdomainResolution,
): value is SpentSubdomainResolution {
  return 'spent' in value
}

function normalizedPath(pathname: string) {
  return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}

function requireTenantMetadata(tenant: Pick<TenantRow, 'theme_id' | 'vertical' | 'name'>, source: string) {
  const themeId = tenant.theme_id?.trim()
  const vertical = tenant.vertical?.trim()
  const name = tenant.name?.trim()
  if (!themeId || !vertical || !name) {
    throw new HTTPError({
      statusCode: 500,
      statusMessage: `Tenant ${source} is missing canonical identity or site metadata`,
      data: { code: 'TENANT_METADATA_INCOMPLETE' },
    })
  }
  return { themeId, vertical, name }
}

async function resolveRegisteredSubdomainTenant(
  event: H3Event,
  db: DbClient,
  tenantSlug: string,
): Promise<TenantRow | null> {
  return readTenantFromHost(event, db, 'canonical.domain', `
      FROM organization o
      JOIN organization_domains requested
        ON requested.organization_id = o.id
       AND requested.type = 'subdomain'
       AND requested.status = 'active'
      LEFT JOIN organization_domains canonical
        ON canonical.organization_id = o.id
       AND canonical.role = 'canonical'
       AND canonical.status = 'active'
      WHERE o.subdomain = ?
    `, [tenantSlug])
}

/**
 * The one place `organization.status` decides anything. A tenant is served
 * publicly only when it is Live and provisioning has finished; a Draft tenant,
 * or one still provisioning, is served to a holder of a valid preview token for
 * it — which is what "preview" means everywhere in this product: the real site,
 * on its real host, rendered by the real templates, with unpublished content
 * and no caching.
 *
 * `suspended` is Blawby's own hold and is nobody's to look past, the owner's
 * preview token included.
 *
 * Returns false when the request may not see this tenant at all.
 */
async function authorizeTenant(event: H3Event, tenant: TenantRow): Promise<boolean> {
  if (tenant.status === 'suspended') {
    event.context.previewAuthorized = false
    return false
  }
  const previewSecret = previewSecretOf(cloudflareEnv(event))
  const authorized = await resolvePreviewAuthorization(event, tenant.id, previewSecret)
  event.context.previewAuthorized = authorized
  // A live site is public either way; the flag still travels, because preview
  // also means "show me the drafts" — an unpublished article on a site that is
  // already live is previewed the same way.
  return (tenant.status === 'active' && tenant.onboarding_status === 'active') || authorized
}

function setResolvedTenantContext(
  event: H3Event,
  tenant: TenantRow,
  host: string,
  canonicalDomain: string | null,
) {
  const metadata = requireTenantMetadata(tenant, tenant.id)
  const socialMedia = publicTenantMedia(tenant)
  const resolvedSite = resolvePublicSite({ themeId: metadata.themeId})
  const siteSurface = resolvedSite.slug
  const isPlatform = siteSurface === 'platform'
  const logos = siteLogos(tenant.media_json)
  const fontPreset = resolveOrganizationFontPreset(tenant.font_preset_type === null ? undefined : tenant.font_preset)
  const palette = !isPlatform
    ? resolveSitePalette(tenant.palette === null ? undefined : parseSitePalette(JSON.parse(tenant.palette)))
    : null
  const recipe = parseSiteRecipe(tenant)

  event.context.organizationId = tenant.id
  event.context.themeId = metadata.themeId
  event.context.tenantType = isPlatform ? TENANT_TYPES.PLATFORM : TENANT_TYPES.TENANT
  event.context.tenantHost = hostnameOf(host)
  event.context.canonicalDomain = canonicalDomain
  event.context.organization = {
    id: tenant.id,
    subdomain: tenant.subdomain,
    name: metadata.name,
    brand_description: tenant.brand_description,
    theme_id: metadata.themeId,
    vertical: metadata.vertical,
    // The business's own clock: a visit is counted on its local day.
    timezone: tenant.timezone,
    has_payment_account: tenant.has_payment_account === 1,
    site: resolvedSite,
    fontPreset,
    palette,
    recipe,
    logos,
    social_profiles: connectedSocialProfiles(tenant),
    policies: [
      ...(tenant.privacy_policy ? ['privacy' as const] : []),
      ...(tenant.terms_policy ? ['terms' as const] : []),
      ...(tenant.acceptable_use_policy ? ['acceptable-use' as const] : []),
    ],
    ...socialMedia,
  }
}

const SESSION_SCOPED_API_PREFIXES = ["/api/dashboard", "/api/organizations", "/api/messages", "/api/mcp", "/api/integrations/channex"] as const;

export default defineHandler(async (event) => {
  // Nested self-fetches (i18n/icon/internal API calls during SSR) never carry
  // tenant context downstream handlers rely on — the real inbound request
  // already resolved tenant type/host before triggering these. Skip the DB
  // lookup and host parsing entirely rather than redoing it per phantom request.
  // Nuxt carries the resolved public organization in its native error payload.
  // Error rendering must not repeat the operation that produced the error.
  if (isInternalSelfFetch(event)) {
    return;
  }

  const url = event.url;
  // Domain verification belongs to the request host and does not read a site.
  if (url.pathname === '/.well-known/openai-apps-challenge') return;
  const tenantPath = normalizedPath(url.pathname);
  // Diagnostics must still reach operational logs when tenant/D1 resolution fails.
  if (tenantPath === BROWSER_ERROR_PATH) return;
  if (tenantPath === "/api/auth" || tenantPath.startsWith("/api/auth/")) return;
  // The health check pings D1 and reads no tenant; local E2E routes assert their
  // own access and never read one either. A fresh database has no platform
  // organization until the E2E seed's bootstrap creates it.
  if (tenantPath === "/api/health" || tenantPath.startsWith("/api/dev/")) return;
  // The dashboard, organization, Messages and MCP APIs are scoped by the session and the
  // organization the request names, never by the host. Resolving the platform
  // site for them cost every call its tenant row, its redirect lookups and the
  // preview check before authentication ran: six D1 statements and 100-190 ms
  // on a 401. Nothing on these paths reads the resolved tenant; the one shared
  // helper, resolvePublicOrigin, answers the platform origin without it.
  if (SESSION_SCOPED_API_PREFIXES.some(prefix => tenantPath === prefix || tenantPath.startsWith(`${prefix}/`))) return;
  // `/api/public/**` used to be skipped here because each of those routes
  // carried its own site id in the path. That id was a second answer to "which
  // tenant", arriving beside the host that already knew — and a route reachable
  // with one tenant's id on another tenant's domain. The id is gone and the
  // host is the only answer, so the public API resolves here like everything
  // else and reads `event.context.organizationId`.
  const host = (event.req.headers.get("host")) || "";
  const env = cloudflareEnv(event);
  // Dashboard deep links must first reach the host that owns the OAuth cookie.
  const dashboard = tenantPath === '/dashboard' || tenantPath.startsWith('/dashboard/')
  const browserEntry = event.method === 'HEAD' || (event.method === 'GET' && event.req.headers.get('accept')?.includes('text/html'))
  if (browserEntry && (dashboard || tenantPath === '/login' || tenantPath === '/signup'
    || tenantPath === '/forgot-password' || /^\/accept-invitation\/[^/]+$/.test(tenantPath))) {
    const authOrigin = env.BETTER_AUTH_URL && new URL(env.BETTER_AUTH_URL)
    const freeSiteHost = normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
    if (authOrigin && authOrigin.protocol === 'https:' && !isNonProductionHost(authOrigin.hostname)
      && authOrigin.hostname !== url.hostname && (url.hostname === freeSiteHost
        || (freeSiteHost === BLAWBY_FREE_SITE_HOST && url.hostname === LEGACY_FREE_SITE_HOST))) {
      return redirect(`${authOrigin.origin}${url.pathname}${url.search}`, 302)
    }
  }

  // The local harness and the staging alias name the tenant explicitly.
  // An unresolvable selector must never become the platform's homepage.
  const previewSlug = usesTenantHeader(host) ? event.req.headers.get("x-preview-tenant") : null
  const aliasSlug = environmentTenantAliasSlug(host, env)
  const requestedSlug = previewSlug ?? aliasSlug
  const isPlatformRequest = requestedSlug === null && isPlatformHost(host, env)
  const workspaceSlug = isPlatformRequest && event.method === 'GET'
    ? /^\/dashboard\/([a-z0-9-]+)(?:\/|$)/.exec(tenantPath)?.[1] : undefined
  const workspaceDocument = workspaceSlug && !['account', 'app', 'onboarding', 'select-organization'].includes(workspaceSlug)
  const workspaceTenant = workspaceDocument
    ? await resolveDashboardTenant(event, workspaceSlug, tenantPath.slice(`/dashboard/${workspaceSlug}`.length)) : undefined
  if (event.method === 'GET' && dashboard && !(await getDashboardSession(event, env))?.user.id) {
    return redirect(buildLoginUrl({ redirect: `${url.pathname}${url.search}` }), 302)
  }

  const tenant = workspaceDocument ? workspaceTenant
    : requestedSlug !== null
      ? env.db && /^[a-z0-9-]+$/.test(requestedSlug) ? await resolveRegisteredSubdomainTenant(event, env.db, requestedSlug) : null
      : isPlatformRequest ? env.db ? await resolvePlatformTenant(env.db) : null : await resolveTenant(host, event)

  if (tenant && isSpentSubdomainResolution(tenant)) {
    if (tenant.successorDomain) {
      const status = event.method === 'GET' || event.method === 'HEAD' ? 301 : 308
      return redirect(`https://${tenant.successorDomain}${url.pathname}${url.search}`, status)
    }
    throw new HTTPError({ statusCode: 410, statusMessage: 'Gone' })
  }

  if (tenant && !isPlatformRequest && event.method === 'GET' && tenantPath === '/' && url.search === PUBLIC_WEBSITE_QUERY) {
    clearPreviewAuthorization(event)
    setResponseHeader(event, 'cache-control', 'private, no-store')
    return redirect('/', 303)
  }

  if (tenant && await authorizeTenant(event, tenant)) {
    try {
      await publicCacheRevision(event, env.db!, tenant.id, tenant.public_cache_revision)
      setResolvedTenantContext(event, tenant, host, requestedSlug !== null ? hostnameOf(host) : tenant.canonical_domain)
      const { id, default_currency, contact_email, contact_phone, vertical, brand_description, seo_title,
        seo_description, canonical_url, search_console_verification, has_compliance, name } = tenant
      await seedPublicBase(event, {
        id, default_currency, contact_email, contact_phone, vertical, brand_description, seo_title, seo_description, canonical_url,
        search_console_verification, has_compliance, theme_id: tenant.theme_id!, name,
      }, event.context.previewAuthorized === true)
      event.context.tenantSourceLocaleRows = { organizationId: tenant.id, rows: JSON.parse(tenant.source_locale_rows) as unknown[],
        published: JSON.parse(tenant.published_locales) as string[] }
      event.context.tenantConfigRow = tenant
      if (tenant.redirect_json !== undefined) event.context.tenantRedirect = tenant.redirect_json ? JSON.parse(tenant.redirect_json) as PublicTenantRedirect : null
    } catch (error) {
      if (HTTPError.isError(error)) throw error
      throw new HTTPError({
        statusCode: 500,
        statusMessage: 'Tenant metadata is invalid',
        cause: error,
        data: { code: 'TENANT_METADATA_INVALID', reason: error instanceof Error ? error.message : String(error) },
      })
    }
    return
  }

  if (isPlatformRequest) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'No active organization runs the platform site', data: { code: 'PLATFORM_TENANT_MISSING' } })
  }
  throw new HTTPError({ statusCode: 404, statusMessage: 'Organization Not Found' })
});

export async function resolveTenant(
  host: string,
  event: H3Event,
): Promise<TenantRow | SpentSubdomainResolution | null> {
  const runtimeEnv = cloudflareEnv(event);
  const db = runtimeEnv.db;
  const hostname = hostnameOf(host);

  if (!db || !hostname) return null;

  // Local development support (e.g., demo.localhost)
  if (hostname.includes(".localhost")) {
    const subdomain = hostname.split(".")[0];
    if (!subdomain) return null
    return await readTenantFromHost(event, db, "o.subdomain || '.localhost'", `
      FROM organization o
      WHERE o.subdomain = ?
    `, [subdomain]);
  }

  const tenant = await readTenantFromHost(event, db, 'COALESCE(canonical.domain, sd.domain)', `
    FROM organization o
    JOIN organization_domains sd ON o.id = sd.organization_id
    LEFT JOIN organization_domains canonical
      ON canonical.organization_id = o.id AND canonical.role = 'canonical' AND canonical.status = 'active'
    WHERE sd.domain = ? AND sd.type IN ('custom', 'subdomain') AND sd.status = 'active'
  `, [hostname])
  if (tenant) return tenant

  const spent = await queryFirst<{ successor_domain: string | null }>(
    db,
    "SELECT successor_domain FROM organization_domains WHERE domain = ? AND status = 'retired' LIMIT 1",
    [hostname],
  )
  return spent
    ? { spent: true, successorDomain: spent.successor_domain }
    : null
}
