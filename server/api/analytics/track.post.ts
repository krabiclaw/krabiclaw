import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { execute, queryFirst } from '~/server/db'
import { getClientIp } from '~/server/utils/hourly-rate-limit'
import {
  getCloudflareGeo,
  getOrCreateSessionId,
  getOrCreateVisitorId,
  getOrganizationInternalHosts,
  hashIp,
  isCanonicalEventId,
  isKnownBot,
  isTrackablePath,
  recordTenantPageview,
  boundedOccurrence,
  resolvePublicPageIdentity,
  updateTenantPageviewDuration,
  SESSION_COOKIE,
} from '~/server/utils/pageview-tracking'
import { normalizeLocale } from '~/server/utils/organization-i18n'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import { normalizeReferrerHost, sanitizeAttributionParams } from '~/utils/analytics-attribution'
import { defineHandler } from 'nitro'
import { getCookie, readBody } from 'nitro/h3'
import { recordZarazPageviewReceipt, zarazPageviewDelivery } from '~/server/utils/ga4-delivery'

interface PageviewRequest {
  event_id?: unknown
  event_type?: unknown
  page_path?: unknown
  locale?: unknown
  referrer_host?: unknown
  attribution?: unknown
  duration_seconds?: unknown
  occurred_at?: unknown
  delivery_status?: unknown
}

const RATE_LIMIT_MAX = 120
const RATE_LIMIT_WINDOW_SECONDS = 60

export default defineHandler(async (event) => {
  const db = cloudflareEnv(event).db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  try {
    const body = await readBody(event) as PageviewRequest
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Invalid analytics payload' }, { status: 400 })
    }

    const eventType = body.event_type === 'duration' ? 'duration' : body.event_type === 'pageview' ? 'pageview' : body.event_type === 'ga4_delivery' ? 'ga4_delivery' : null
    if (!eventType || !isCanonicalEventId(body.event_id)) {
      return jsonResponse({ error: 'event_id and a valid event_type are required' }, { status: 400 })
    }

    const pagePath = typeof body.page_path === 'string' ? body.page_path.trim() : ''
    if (!isTrackablePath(pagePath)) return jsonResponse({ error: 'Page path is not trackable' }, { status: 400 })

    const tenantType = event.context.tenantType
    const isTenant = tenantType === TENANT_TYPES.TENANT
    const organizationId = typeof event.context.organizationId === 'string' ? event.context.organizationId : ''
    if ((!isTenant && tenantType !== TENANT_TYPES.PLATFORM) || !organizationId) {
      return jsonResponse({ error: 'Active organization context is required' }, { status: 400 })
    }
    const userAgent = (event.req.headers.get('user-agent') || '').slice(0, 1024)
    if (isKnownBot(userAgent)) return jsonResponse({ ok: true, ignored: true })

    const rawDuration = Number(body.duration_seconds)
    const durationSeconds = Number.isFinite(rawDuration) && rawDuration >= 0 && rawDuration <= 86_400
      ? Math.round(rawDuration)
      : null
    if (eventType === 'duration' && durationSeconds === null) {
      return jsonResponse({ error: 'duration_seconds must be between 0 and 86400' }, { status: 400 })
    }

    const rawLocale = typeof body.locale === 'string' ? body.locale.trim() : ''
    const locale = rawLocale ? normalizeLocale(rawLocale) : null
    if (rawLocale && !locale) {
      return jsonResponse({ error: 'locale must be a valid BCP-47 locale' }, { status: 400 })
    }

    const ipHash = await hashIp(getClientIp(event))
    const now = new Date().toISOString()
    const windowEndsAt = new Date(Date.now() + RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString()
    const rateKey = `analytics-track:${organizationId}:${ipHash}`
    await execute(db, `INSERT INTO rate_limits (key, count, updated_at, expires_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN COALESCE(rate_limits.expires_at, '') <= excluded.updated_at THEN 1 ELSE rate_limits.count + 1 END,
        updated_at = excluded.updated_at,
        expires_at = CASE WHEN COALESCE(rate_limits.expires_at, '') <= excluded.updated_at THEN excluded.expires_at ELSE rate_limits.expires_at END`,
    [rateKey, now, windowEndsAt])
    const rateState = await queryFirst<{ count: number; expires_at: string }>(db, 'SELECT count, expires_at FROM rate_limits WHERE key = ? LIMIT 1', [rateKey])
    if (Number(rateState?.count || 0) > RATE_LIMIT_MAX && String(rateState?.expires_at || '') > now) {
      return jsonResponse({ error: 'Too many requests' }, { status: 429 })
    }

    if (eventType === 'duration' || eventType === 'ga4_delivery') {
      const sessionId = getCookie(event, SESSION_COOKIE)
      if (!isCanonicalEventId(sessionId)) {
        return jsonResponse({ error: 'A valid analytics session is required' }, { status: 400 })
      }
      if (eventType === 'ga4_delivery') {
        if (body.delivery_status !== 'dispatched' && body.delivery_status !== 'failed') return jsonResponse({ error: 'Invalid GA4 delivery receipt' }, { status: 400 })
        const accepted = await recordZarazPageviewReceipt(db, { eventId: body.event_id, organizationId, sessionId, status: body.delivery_status })
        return accepted ? jsonResponse({ ok: true }) : jsonResponse({ error: 'GA4 delivery receipt does not match this session' }, { status: 409 })
      }
      await updateTenantPageviewDuration(db, { eventId: body.event_id, organizationId, sessionId, durationSeconds: durationSeconds!, now })
      return jsonResponse({ ok: true })
    }

    const visitorId = getOrCreateVisitorId(event)
    const sessionId = getOrCreateSessionId(event)

    const referrerHost = typeof body.referrer_host === 'string'
      ? normalizeReferrerHost(`https://${body.referrer_host}`)
      : null
    const geo = getCloudflareGeo(event)
    const organization = event.context.organization as { vertical?: string | null } | undefined
    const [identity, internalHosts] = await Promise.all([
      resolvePublicPageIdentity(cloudflareEnv(event) as never, db, {
        organizationId, pagePath, requestedLocale: locale,
        themeId: event.context.themeId as string | null | undefined, vertical: organization?.vertical,
      }),
      getOrganizationInternalHosts(db, organizationId, event.url.hostname),
    ])
    if (!identity) return jsonResponse({ error: 'Page path is not a published public route' }, { status: 400 })
    await recordTenantPageview(db, {
      eventId: body.event_id,
      organizationId,
      pagePath,
      sourcePath: identity.sourcePath,
      locale: identity.locale,
      referrerHost,
      attribution: sanitizeAttributionParams(body.attribution),
      internalHosts,
      userAgent,
      ipHash,
      sessionId,
      visitorId,
      country: geo.country ?? null,
      region: geo.region ?? null,
      city: geo.city ?? null,
      locationId: identity.locationId,
      pageId: identity.pageId,
      pageType: identity.pageType,
      recipe: identity.recipe,
      documentId: identity.documentId,
      productId: identity.productId,
      occurredAt: boundedOccurrence(body.occurred_at, now),
      now,
    })
    const ga4Delivery = await zarazPageviewDelivery(db, { eventId: body.event_id, organizationId, sessionId, cookieHeader: event.req.headers.get('cookie') ?? '' })
    return jsonResponse({ ok: true, ga4_delivery: ga4Delivery })
  } catch (error) {
    console.error('Analytics track error:', error instanceof Error ? error.message : String(error))
    return jsonResponse({ error: 'Failed to log analytics event' }, { status: 500 })
  }
})
