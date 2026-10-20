import { getCookie, setCookie } from 'nitro/h3'
import type { H3Event } from 'nitro'
import type { AppDb } from '~/server/db'
import { executeBatch, queryAll, queryFirst } from '~/server/db'
import { resolvePublishedTenantPageIdentity as resolveCanonicalTenantPageIdentity } from '~/server/utils/content/pages'
import { observeAttribution, resolveAttributionTouch, type AttributionParams, type ObservedAttribution } from '~/utils/analytics-attribution'
import { resolveTenantLocalePath } from '~/utils/tenant-locale-path'
import { parseSiteProductPath } from '~/utils/product-presentation'
import type { CloudflareEnv } from '~/server/utils/auth'
import { findPublishedProductAtRoute, getOrganizationVertical, parseProductRouteSegments, resolveLocalizedPublicRoute } from '~/server/utils/localization'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { publicTemplateRegistry, resolvePublicTemplate } from '~/utils/template-registry'
import type { PublicTemplateDefinition } from '~/utils/template-registry'
import { templateRendersPageDocumentAt } from '~/shared/tenant-page-paths'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import { isLocalizedPublicAliasPath } from '~/shared/public-locale-routes'
export { isTrackablePath, PAGEVIEW_SKIP_PREFIXES } from '~/utils/pageview-path'

export const VISITOR_COOKIE = 'kc_visitor_id'
export const SESSION_COOKIE = 'kc_session_id'
const VISITOR_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2
const SESSION_MAX_AGE_SECONDS = 60 * 30
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BOT_PATTERN = /bot|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|headlesschrome|lighthouse|pagespeed/i

function analyticsCookie(event: H3Event, name: string, maxAge: number): string {
  const existing = getCookie(event, name)
  const value = existing && UUID_PATTERN.test(existing) ? existing : crypto.randomUUID()
  setCookie(event, name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: event.url.protocol === 'https:',
    path: '/',
    maxAge,
  })
  return value
}

export function getOrCreateVisitorId(event: H3Event): string {
  return analyticsCookie(event, VISITOR_COOKIE, VISITOR_MAX_AGE_SECONDS)
}

export function getOrCreateSessionId(event: H3Event): string {
  return analyticsCookie(event, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS)
}

export function isCanonicalEventId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isKnownBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_PATTERN.test(userAgent)
}

export async function hashIp(ip: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

interface CloudflareGeo { country?: string; region?: string; city?: string }

export function getCloudflareGeo(event: H3Event): CloudflareGeo {
  const request = (event.req.runtime?.cloudflare as { request?: Request & { cf?: CloudflareGeo } } | undefined)?.request
  if (request?.cf) return request.cf
  const country = event.req.headers.get('cf-ipcountry')
  return country && country !== 'XX' ? { country } : {}
}

export async function resolveLocationIdFromPath(db: AppDb, organizationId: string, pagePath: string): Promise<string | null> {
  const slug = pagePath.match(/^\/locations\/([^/]+)/)?.[1]
  if (!slug) return null
  return (await queryFirst<{ id: string }>(db, 'SELECT id FROM business_locations WHERE organization_id = ? AND slug = ? LIMIT 1', [organizationId, slug]))?.id ?? null
}

/** The facts a valid public route identifies. Each describes a different thing: the path the visitor requested, the locale-bare path its document is stored under, the language, and the entities behind it. */
export interface PublicPageIdentity {
  /** The path exactly as requested (a localized visit keeps its prefix). */
  publicPath: string
  /** The locale-bare path documents and routes are stored under. */
  sourcePath: string
  locale: string
  locationId: string | null
  pageId: string | null
  pageType: string | null
  recipe: string | null
  documentId: string | null
  productId: string | null
}

async function publishedTranslatedLocales(db: AppDb, organizationId: string): Promise<string[]> {
  const rows = await queryAll<{ locale: string }>(db, `SELECT locale FROM organization_locales
    WHERE organization_id = ? AND is_source = 0 AND status = 'published' ORDER BY locale`, [organizationId])
  return rows.map(row => row.locale)
}

/**
 * Whether this is a valid public route of the organization, and what it identifies. A localized
 * visit is validated by the same authoritative resolver the public site serves it with (published
 * locale, entitlement, published representation); a source-language visit by its published
 * document, its published product route, or a code-owned route of the theme. Anything else — an
 * unpublished representation, an unsupported locale, an entity of another tenant — is not a public
 * page and yields null. The path is never rewritten to make a lookup succeed.
 */
export async function resolvePublicPageIdentity(env: CloudflareEnv, db: AppDb, input: {
  organizationId: string; pagePath: string; requestedLocale: string | null; themeId: string | null | undefined; vertical: string | null | undefined
}): Promise<PublicPageIdentity | null> {
  const { organizationId, pagePath } = input
  const routing = resolveTenantLocalePath(pagePath, await publishedTranslatedLocales(db, organizationId))
  const base = { publicPath: pagePath, sourcePath: routing.sourcePath, locationId: await resolveLocationIdFromPath(db, organizationId, routing.sourcePath) }

  if (routing.localeSegment) {
    if (input.requestedLocale && input.requestedLocale !== routing.localeSegment) return null
    const template = resolvePublicTemplate({ themeId: input.themeId, vertical: input.vertical })
    const derivesLocaleRoute = isLocalizedPublicAliasPath(routing.sourcePath)
      && (template.sitemap.exactPaths.includes(routing.sourcePath)
      || template.nonIndexableExactPaths.includes(routing.sourcePath))
      && (!templateRendersPageDocumentAt(template, routing.sourcePath)
        || template.pageDocuments.optionalLocalizedPaths.includes(routing.sourcePath))
    if (derivesLocaleRoute) {
      const representations = await listPublicLocaleRepresentations(env, db, {
        organizationId, sourcePath: routing.sourcePath, publishedLocaleRoute: true,
      })
      if (!representations.some(item => item.locale === routing.localeSegment && item.route_path === pagePath)) return null
      const page = await resolveCanonicalTenantPageIdentity(db, organizationId, routing.sourcePath, routing.localeSegment)
      return { ...base, locale: routing.localeSegment, pageId: page?.page_id ?? null,
        documentId: page?.id ?? null, pageType: page?.page_type ?? null, recipe: page?.recipe ?? null, productId: null }
    }
    let route: Awaited<ReturnType<typeof resolveLocalizedPublicRoute>>
    try {
      route = await resolveLocalizedPublicRoute(env, db, organizationId, pagePath)
    } catch (error) {
      // The route resolver answers 404 for "this is not a published localized route"; that is the
      // visit being invalid, not a failure. Every other failure is real and propagates.
      if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404) return null
      throw error
    }
    const representation = route.representation
    if (representation.kind === 'document') {
      const root = await queryFirst<{ page_type: string | null; recipe: string | null }>(db, `SELECT json_extract(metadata_json, '$.page_type') AS page_type, json_extract(metadata_json, '$.recipe') AS recipe
        FROM content_documents WHERE id = ? AND organization_id = ? LIMIT 1`, [representation.resource_id, organizationId])
      return { ...base, locale: route.locale, pageId: representation.resource_id, documentId: representation.document_id, pageType: root?.page_type ?? null, recipe: root?.recipe ?? null, productId: null }
    }
    return { ...base, locale: route.locale, pageId: null, pageType: null, recipe: null, documentId: null, productId: representation.resource_type === 'product' ? representation.resource_id : null }
  }

  const sourceLocale = await getSourceLocale(db, organizationId)
  if (input.requestedLocale && input.requestedLocale !== sourceLocale) return null
  const page = await resolveCanonicalTenantPageIdentity(db, organizationId, routing.sourcePath, sourceLocale)
  if (page) return { ...base, locale: sourceLocale, pageId: page.page_id, pageType: page.page_type, recipe: page.recipe, documentId: null, productId: null }

  const siteProduct = parseSiteProductPath(routing.sourcePath)
  if (siteProduct) {
    const { loadPublicSiteProductDetail } = await import('~/server/utils/public-products')
    const detail = await loadPublicSiteProductDetail(env, db, organizationId, siteProduct.surface, false, siteProduct.slug, sourceLocale)
    if (!detail) return null
    return { ...base, locale: sourceLocale, locationId: detail.location?.id ?? null, pageId: null, pageType: 'product', recipe: null, documentId: null, productId: detail.product.id }
  }

  const productRoute = parseProductRouteSegments(routing.sourcePath, input.vertical ?? await getOrganizationVertical(db, organizationId))
  const product = productRoute ? await findPublishedProductAtRoute(db, organizationId, productRoute) : null
  if (product) return { ...base, locale: sourceLocale, locationId: product.location_id, pageId: null, pageType: 'product', recipe: null, documentId: null, productId: product.id }

  if (!isKnownTenantPublicPath(routing.sourcePath, { themeId: input.themeId, vertical: input.vertical })) return null
  return { ...base, locale: sourceLocale, pageId: null, pageType: null, recipe: null, documentId: null, productId: null }
}

const CLOCK_SKEW_FUTURE_MS = 5 * 60_000
const DEFERRED_DELIVERY_MAX_MS = 24 * 60 * 60_000

/**
 * The time an event happened. A browser reports it so a deferred delivery keeps its own moment;
 * the collector accepts it only when it is a valid instant no later than the receipt time (plus a
 * small clock skew) and no older than a day, and otherwise uses the receipt time. Receipt time
 * itself is always recorded separately by the database.
 */
export function boundedOccurrence(reported: unknown, receivedAt: string): string {
  if (typeof reported !== 'string') return receivedAt
  const at = Date.parse(reported)
  if (!Number.isFinite(at) || new Date(at).toISOString() !== reported) return receivedAt
  const received = Date.parse(receivedAt)
  return at <= received + CLOCK_SKEW_FUTURE_MS && at >= received - DEFERRED_DELIVERY_MAX_MS ? reported : receivedAt
}

export function isKnownTenantPublicPath(
  pathname: string,
  templateInput?: Parameters<typeof resolvePublicTemplate>[0],
): boolean {
  const templates: PublicTemplateDefinition[] = templateInput
    ? [resolvePublicTemplate(templateInput)]
    : Object.values(publicTemplateRegistry)
  return templates.some(template =>
    template.sitemap.exactPaths.includes(pathname)
    || template.nonIndexableExactPaths.includes(pathname)
    || template.sitemap.dynamicPrefixes.some(prefix => pathname.startsWith(prefix)),
  )
}

export async function getOrganizationInternalHosts(db: AppDb, organizationId: string, currentHost: string): Promise<string[]> {
  const rows = await queryAll<{ domain: string }>(db, `SELECT domain FROM organization_domains WHERE organization_id = ? AND status = 'active'`, [organizationId])
  return [currentHost.toLowerCase(), ...rows.map(row => String(row.domain || '').toLowerCase())]
}

export interface TenantPageviewInput {
  eventId: string
  organizationId: string
  pagePath: string
  locale: string | null
  referrerHost: string | null
  attribution: AttributionParams
  internalHosts: string[]
  userAgent: string
  ipHash: string
  sessionId: string
  visitorId: string
  country: string | null
  region: string | null
  city: string | null
  locationId: string | null
  pageId: string | null
  pageType: string | null
  recipe: string | null
  documentId?: string | null
  productId?: string | null
  /** The locale-bare path the document is stored under, when it differs from `pagePath`. */
  sourcePath?: string | null
  /** When the event happened (`boundedOccurrence`); defaults to `now`. */
  occurredAt?: string
  now: string
}

/**
 * Records one pageview and folds it into its session, atomically.
 *
 * The event keeps its own facts: the parameters and referrer it observed, exactly as they arrived
 * (`observed`), and the attribution in force for it when it happened (`attribution`, with
 * `attribution_basis`: `own_touch` when it carried a touch, `inherited` when it continued the
 * session's last touch as of that moment, `none` when there was none). The session's last-touch
 * record is a derived view over those events; updating it never rewrites an event. A duplicate
 * event ID changes nothing: the session update and the inherited snapshot are gated on the insert.
 * A touch replaces the session's last touch only when it is not older than the one already there,
 * so a delayed delivery cannot resurrect a stale campaign.
 */
export async function recordTenantPageview(db: AppDb, input: TenantPageviewInput): Promise<void> {
  const occurredAt = input.occurredAt ?? input.now
  const touch = resolveAttributionTouch(input.attribution, input.referrerHost, input.internalHosts)
  const observed: ObservedAttribution | null = observeAttribution(input.attribution, input.referrerHost)
  const initial = touch ?? {
    source: 'Direct', medium: '(none)', campaign: null, term: null, content: null, referrerHost: null,
    gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null,
  }
  await executeBatch(db, [
    {
      query: `INSERT OR IGNORE INTO analytics_events (
        id, kind, organization_id, location_id, page_path, session_id, visitor_id, payload_json, created_at
      ) VALUES (?, 'pageview', ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.eventId, input.organizationId, input.locationId, input.pagePath, input.sessionId, input.visitorId,
        JSON.stringify({ page_id: input.pageId, page_type: input.pageType, recipe: input.recipe,
          document_id: input.documentId ?? null, product_id: input.productId ?? null, source_path: input.sourcePath ?? input.pagePath,
          locale: input.locale, revision_id: null, referrer: input.referrerHost, observed,
          attribution: touch, attributed_at: touch ? occurredAt : null, attribution_basis: touch ? 'own_touch' : 'none',
          user_agent: input.userAgent, ip_hash: input.ipHash, country: input.country, region: input.region, city: input.city }), occurredAt,
      ],
    },
    {
      query: `INSERT INTO analytics_summaries (
        id, kind, organization_id, date, key, payload_json, created_at, updated_at
      ) SELECT ?, 'session', ?, '', ?, ?, ?, ?
        WHERE changes() = 1
      ON CONFLICT(organization_id, kind, date, key) DO UPDATE SET updated_at = excluded.updated_at,
        payload_json = json_set(analytics_summaries.payload_json,
          '$.started_at', MIN(json_extract(analytics_summaries.payload_json, '$.started_at'), json_extract(excluded.payload_json, '$.started_at')),
          '$.last_seen_at', MAX(json_extract(analytics_summaries.payload_json, '$.last_seen_at'), json_extract(excluded.payload_json, '$.last_seen_at')),
          '$.attribution', CASE WHEN json_extract(excluded.payload_json, '$.last_touch_at') IS NOT NULL
              AND (json_extract(analytics_summaries.payload_json, '$.last_touch_at') IS NULL
                OR json_extract(excluded.payload_json, '$.last_touch_at') >= json_extract(analytics_summaries.payload_json, '$.last_touch_at'))
            THEN json_extract(excluded.payload_json, '$.attribution') ELSE json_extract(analytics_summaries.payload_json, '$.attribution') END,
          '$.last_touch_at', CASE WHEN json_extract(excluded.payload_json, '$.last_touch_at') IS NOT NULL
              AND (json_extract(analytics_summaries.payload_json, '$.last_touch_at') IS NULL
                OR json_extract(excluded.payload_json, '$.last_touch_at') >= json_extract(analytics_summaries.payload_json, '$.last_touch_at'))
            THEN json_extract(excluded.payload_json, '$.last_touch_at') ELSE json_extract(analytics_summaries.payload_json, '$.last_touch_at') END)`,
      params: [
        crypto.randomUUID(), input.organizationId, input.sessionId,
        JSON.stringify({ visitor_id: input.visitorId, started_at: occurredAt, last_seen_at: occurredAt,
          landing_path: input.pagePath, duration_seconds: 0, attribution: initial, last_touch_at: touch ? occurredAt : null }),
        input.now, input.now,
      ],
    },
    // An event with no touch of its own continues the session's last touch as of its own moment.
    // A touch that happened after it is not the context this event was in.
    {
      query: `UPDATE analytics_events SET payload_json = json_set(payload_json,
          '$.attribution', json((SELECT json_extract(s.payload_json, '$.attribution') FROM analytics_summaries s WHERE s.organization_id = ? AND s.kind = 'session' AND s.date = '' AND s.key = ?)),
          '$.attributed_at', (SELECT json_extract(s.payload_json, '$.last_touch_at') FROM analytics_summaries s WHERE s.organization_id = ? AND s.kind = 'session' AND s.date = '' AND s.key = ?),
          '$.attribution_basis', 'inherited')
        WHERE id = ? AND changes() = 1 AND ? IS NULL
          AND EXISTS (SELECT 1 FROM analytics_summaries s WHERE s.organization_id = ? AND s.kind = 'session' AND s.date = '' AND s.key = ?
            AND json_extract(s.payload_json, '$.last_touch_at') IS NOT NULL AND json_extract(s.payload_json, '$.last_touch_at') <= ?)`,
      params: [input.organizationId, input.sessionId, input.organizationId, input.sessionId, input.eventId, touch ? 'touch' : null, input.organizationId, input.sessionId, occurredAt],
    },
  ], { operation: 'record tenant analytics pageview' })
}

export async function updateTenantPageviewDuration(db: AppDb, input: {
  eventId: string; organizationId: string; sessionId: string; durationSeconds: number; now: string
}): Promise<void> {
  await executeBatch(db, [
    {
      query: `UPDATE analytics_events SET duration_seconds = ? WHERE kind = 'pageview' AND id = ? AND organization_id = ? AND session_id = ?`,
      params: [input.durationSeconds, input.eventId, input.organizationId, input.sessionId],
    },
    {
      query: `UPDATE analytics_summaries SET payload_json = json_set(payload_json,
        '$.duration_seconds', COALESCE((SELECT SUM(duration_seconds) FROM analytics_events WHERE kind = 'pageview' AND organization_id = ? AND session_id = ?), 0),
        '$.last_seen_at', ?), updated_at = ? WHERE kind = 'session' AND organization_id = ? AND key = ? AND changes() = 1`,
      params: [input.organizationId, input.sessionId, input.now, input.now, input.organizationId, input.sessionId],
    },
  ], { operation: 'update exact tenant pageview duration' })
}
