import { parseCookie } from 'cookie-es'
import type { DbClient } from '~/server/db'
import { execute, queryFirst } from '~/server/db'
import { ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME } from '~/utils/zaraz-consent'
import { parseGaClientId, parseGaSessionId } from '~/utils/ga-cookies'
import type { Ga4Projection } from '~/utils/ga4-projection'

/**
 * Google Analytics delivery for outcomes the server produces. Exactly one
 * sender owns each outcome: the browser (Zaraz web API) owns what the visitor
 * does on the page, and Measurement Protocol owns everything the server
 * records (signup, onboarding and the Stripe subscription family). The destination is always the
 * measuring organization's own connected property, resolved from its canonical
 * host; there is no environment-level property and no synthetic client.
 *
 * The outcome of every attempt is written onto the native event
 * (`payload.ga4_delivery`), so reporting can tell an unconfigured or
 * consent-rejected outcome from a provider failure without inventing zeros.
 */
export type Ga4DeliveryStatus = 'sending' | 'sent' | 'dispatched' | 'not_configured' | 'no_consent_context' | 'consent_rejected' | 'failed'
export interface Ga4Delivery {
  transport: 'measurement_protocol' | 'zaraz'
  status: Ga4DeliveryStatus
  detail?: string
  claimId?: string
  leaseExpiresAt?: string
}

interface Ga4Destination { measurementId: string; host: string }

type DestinationResult = { destination: Ga4Destination } | { status: 'not_configured'; detail: string }

async function resolveGa4Destination(db: DbClient, organizationId: string): Promise<DestinationResult> {
  const row = await queryFirst<{ measurement_id: string | null; host: string | null }>(db, `
    SELECT (SELECT i.measurement_id FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'google_analytics') AS measurement_id,
           (SELECT d.domain FROM organization_domains d WHERE d.organization_id = o.id AND d.role = 'canonical' AND d.status = 'active') AS host
      FROM organization o WHERE o.id = ? LIMIT 1`, [organizationId])
  if (!row) throw new Error(`Organization ${organizationId} not found`)
  if (!row.measurement_id) return { status: 'not_configured', detail: 'no_google_analytics_integration' }
  if (!row.host) return { status: 'not_configured', detail: 'no_canonical_host' }
  return { destination: { measurementId: row.measurement_id, host: row.host } }
}

export async function readGa4Delivery(db: DbClient, eventId: string): Promise<Ga4Delivery | null> {
  const row = await queryFirst<{ delivery: string | null }>(db, `SELECT json_extract(payload_json, '$.ga4_delivery') AS delivery FROM analytics_events WHERE id = ?`, [eventId])
  return row?.delivery ? JSON.parse(row.delivery) as Ga4Delivery : null
}

async function recordGa4Delivery(db: DbClient, eventId: string, delivery: Ga4Delivery, claimId?: string): Promise<Ga4Delivery> {
  const updated = await execute(db, `UPDATE analytics_events SET payload_json = json_set(payload_json, '$.ga4_delivery', json(?)) WHERE id = ?
    AND (? IS NULL OR json_extract(payload_json, '$.ga4_delivery.claimId') = ?)`, [JSON.stringify(delivery), eventId, claimId ?? null, claimId ?? null])
  if (updated.meta.changes === 0) {
    const existing = await readGa4Delivery(db, eventId)
    if (!existing) throw new Error(`GA4 delivery event ${eventId} not found`)
    return existing
  }
  if (delivery.status === 'failed') console.error('ga4_delivery_failed', { eventId, ...delivery })
  return delivery
}

/** Claim a single browser handoff after native persistence. Dispatched means Zaraz accepted it, not Google acknowledgement. */
export async function claimZarazPageview(db: DbClient, input: { eventId: string; organizationId: string; sessionId: string; cookieHeader: string }): Promise<{ claimId?: string; status: Ga4DeliveryStatus }> {
  const destination = await resolveGa4Destination(db, input.organizationId)
  const consent = readAnalyticsConsent(input.cookieHeader)
  const status: Ga4DeliveryStatus = 'status' in destination ? destination.status
    : consent === 'accepted' ? 'sending' : consent === 'rejected' ? 'consent_rejected' : 'no_consent_context'
  const claimId = crypto.randomUUID()
  const delivery: Ga4Delivery = { transport: 'zaraz', status, ...(status === 'sending' ? { claimId } : {}) }
  const claimed = await execute(db, `UPDATE analytics_events SET payload_json = json_set(payload_json, '$.ga4_delivery', json(?))
    WHERE id = ? AND organization_id = ? AND session_id = ? AND kind = 'pageview' AND json_extract(payload_json, '$.ga4_delivery') IS NULL`, [JSON.stringify(delivery), input.eventId, input.organizationId, input.sessionId])
  if (!claimed.meta.changes) {
    const existing = await queryFirst<{ status: Ga4DeliveryStatus }>(db, `SELECT json_extract(payload_json, '$.ga4_delivery.status') status
      FROM analytics_events WHERE id = ? AND organization_id = ? AND session_id = ? AND kind = 'pageview'`, [input.eventId, input.organizationId, input.sessionId])
    if (!existing?.status) throw new Error('Native pageview does not match the GA4 delivery context')
    return existing
  }
  return { status, ...(status === 'sending' ? { claimId } : {}) }
}

export async function finishZarazPageview(db: DbClient, input: { eventId: string; organizationId: string; sessionId: string; claimId: string; status: 'dispatched' | 'failed' }): Promise<boolean> {
  const result = await execute(db, `UPDATE analytics_events SET payload_json = json_set(payload_json, '$.ga4_delivery', json(?))
    WHERE id = ? AND organization_id = ? AND session_id = ? AND kind = 'pageview'
      AND json_extract(payload_json, '$.ga4_delivery.claimId') = ? AND json_extract(payload_json, '$.ga4_delivery.status') = 'sending'`,
  [JSON.stringify({ transport: 'zaraz', status: input.status }), input.eventId, input.organizationId, input.sessionId, input.claimId])
  return result.meta.changes === 1
}

/**
 * The visitor's own answer to the analytics purpose, from their Zaraz consent cookie. `absent`
 * means they have not answered (or the cookie is unreadable): that is not consent.
 */
export function readAnalyticsConsent(cookieHeader: string): 'accepted' | 'rejected' | 'absent' {
  const raw = parseCookie(cookieHeader)[ZARAZ_CONSENT_COOKIE_NAME]
  if (!raw) return 'absent'
  let purposes: unknown
  try { purposes = JSON.parse(raw) } catch { return 'absent' }
  if (typeof purposes !== 'object' || purposes === null) return 'absent'
  return (purposes as Record<string, unknown>)[ZARAZ_ANALYTICS_PURPOSE_ID] === true ? 'accepted' : 'rejected'
}

/** The visitor's consent and GA identity, read from their own request. Only the consent and `_ga` cookies are looked at. */
function visitorGaContext(origin: { headers: Headers } | null, nowSeconds: number):
  { status: 'no_consent_context' | 'consent_rejected' } | { clientId: string; sessionId: number | null; sessionCapturedAt: number | null } {
  if (!origin) return { status: 'no_consent_context' }
  const cookieHeader = origin.headers.get('cookie') ?? ''
  const consent = readAnalyticsConsent(cookieHeader)
  if (consent !== 'accepted') return { status: consent === 'rejected' ? 'consent_rejected' : 'no_consent_context' }
  const clientId = parseGaClientId(cookieHeader)
  if (!clientId) return { status: 'no_consent_context' }
  const sessionId = parseGaSessionId(cookieHeader)
  return { clientId, sessionId, sessionCapturedAt: sessionId ? nowSeconds : null }
}

export interface MeasurementProtocolEnv { GA4_API_SECRET?: string }

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60

export interface MeasurementProtocolInput {
  organizationId: string
  event: { name: string; params: Record<string, unknown> }
  clientId: string | null
  userId: string | null
  sessionId: number | null
  sessionCapturedAt: number | null
}

/**
 * Posts one event to the measuring organization's property. The client ID is
 * the visitor's own GA client, and it exists in storage only because it was
 * captured while they consented and is erased when they withdraw
 * (`withdrawStripeGaIdentifiers`); without one nothing is sent, and a client is
 * never synthesized from a user ID.
 */
export async function sendMeasurementProtocol(env: MeasurementProtocolEnv, db: DbClient, input: MeasurementProtocolInput, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Omit<Ga4Delivery, 'transport'>> {
  const resolved = await resolveGa4Destination(db, input.organizationId)
  if ('status' in resolved) return resolved
  if (!env.GA4_API_SECRET) return { status: 'not_configured', detail: 'no_api_secret' }
  if (!input.clientId) return { status: 'no_consent_context' }

  const params = { ...input.event.params }
  const fresh = input.sessionId !== null && input.sessionCapturedAt !== null
    && nowSeconds - input.sessionCapturedAt >= 0 && nowSeconds - input.sessionCapturedAt <= SESSION_MAX_AGE_SECONDS
  if (fresh) {
    params.session_id = input.sessionId
    params.engagement_time_msec = 1
  }
  try {
    const response = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(resolved.destination.measurementId)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: input.clientId, ...(input.userId ? { user_id: input.userId } : {}), events: [{ name: input.event.name, params }] }),
      },
    )
    return response.ok ? { status: 'sent' } : { status: 'failed', detail: `measurement_protocol_${response.status}` }
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Measurement Protocol delivery of a recorded native event, with the outcome
 * written onto it. Only the holder of the atomic sending lease may send or
 * finish the attempt. A sent event is never claimed again; an abandoned attempt
 * can be retried after one minute. Callers can retry failed or busy deliveries.
 */
export async function deliverViaMeasurementProtocol(env: MeasurementProtocolEnv, db: DbClient, input: MeasurementProtocolInput & { eventId: string }): Promise<Ga4Delivery> {
  const now = new Date()
  const claimId = crypto.randomUUID()
  const claim: Ga4Delivery = {
    transport: 'measurement_protocol', status: 'sending', claimId,
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }
  const claimed = await execute(db, `UPDATE analytics_events SET payload_json = json_set(payload_json, '$.ga4_delivery', json(?))
    WHERE id = ? AND COALESCE(json_extract(payload_json, '$.ga4_delivery.status'), '') != 'sent'
      AND (COALESCE(json_extract(payload_json, '$.ga4_delivery.status'), '') != 'sending'
        OR COALESCE(json_extract(payload_json, '$.ga4_delivery.leaseExpiresAt'), '') <= ?)`,
  [JSON.stringify(claim), input.eventId, now.toISOString()])
  if (claimed.meta.changes === 0) {
    const existing = await readGa4Delivery(db, input.eventId)
    if (!existing) throw new Error(`GA4 delivery event ${input.eventId} not found`)
    return existing
  }
  return await recordGa4Delivery(db, input.eventId, { transport: 'measurement_protocol', ...await sendMeasurementProtocol(env, db, input) }, claimId)
}

/**
 * Delivers an outcome the visitor's own request produced (signup, onboarding).
 * Consent and the GA client come from that request; a request without a
 * consenting visitor sends nothing and records why.
 */
export async function deliverForVisitor(env: MeasurementProtocolEnv, db: DbClient, input: {
  eventId: string; organizationId: string; projection: Ga4Projection; origin: { headers: Headers } | null
}, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Ga4Delivery> {
  const visitor = visitorGaContext(input.origin, nowSeconds)
  if ('status' in visitor) return await recordGa4Delivery(db, input.eventId, { transport: 'measurement_protocol', status: visitor.status })
  return await deliverViaMeasurementProtocol(env, db, {
    eventId: input.eventId, organizationId: input.organizationId, event: input.projection,
    clientId: visitor.clientId, userId: null, sessionId: visitor.sessionId, sessionCapturedAt: visitor.sessionCapturedAt,
  })
}
