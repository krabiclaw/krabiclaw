import { parseCookies } from 'better-auth/cookies'
import type { DbClient } from '~/server/db'
import { execute, queryFirst } from '~/server/db'
import { getClientIp } from '~/server/utils/hourly-rate-limit'
import { deliverForVisitor, type MeasurementProtocolEnv } from '~/server/utils/ga4-delivery'
import { deliverMetaCapiForEvent } from '~/server/utils/meta-capi-delivery'
import { projectConversionToGa4 } from '~/utils/ga4-projection'
import { SESSION_COOKIE, VISITOR_COOKIE, hashIp, isCanonicalEventId } from '~/server/utils/pageview-tracking'
import type { AttributionTouch, ObservedAttribution } from '~/utils/analytics-attribution'
import {
  CONVERSION_EVENT_CATALOG,
  type ConversionEntityType,
  type ConversionEventDefinition,
  type ConversionStage,
  type ConversionValue,
  type OrganizationConversionEventName,
} from '~/utils/organization-conversion-events'

export type { ConversionEntityType, ConversionStage }

export type ConversionSurface = 'website' | 'dashboard' | 'mcp' | 'auth' | 'stripe'

export interface OrganizationConversionInput {
  /** The business whose outcome is measured — not necessarily the subject's own organization. */
  organizationId: string
  eventName: OrganizationConversionEventName
  stage: ConversionStage
  locationId?: string | null
  /** The product and variant this event is about, when it is about one (a booking's selection, a product view). */
  productId?: string | null
  variantId?: string | null
  entityType?: ConversionEntityType | null
  entityId?: string | null
  pageType?: string | null
  /** The public path the action happened on, when the server knows it. A verified origin pageview's path always wins. */
  pagePath?: string | null
  /** The business route that handled the action (a form endpoint's own label); never a substitute for the visited path. */
  routePath?: string | null
  ctaDestination?: string | null
  metadata?: ApiRecord | null
  value?: ConversionValue | null
  surface: ConversionSurface
  /** The staff member, agent or signed-in user who performed the action, when it is not the subject. */
  actor?: { type: 'staff' | 'agent' | 'user'; id: string } | null
  /**
   * A stable identity chosen by the producer of an interaction, so the same interaction delivered
   * twice is one event and two interactions are two. Server outcomes take their identity from the
   * business entity instead.
   */
  id?: string
  /** The flat scalars an interaction carries; only the catalog's allowlisted names are kept. */
  properties?: Record<string, unknown> | null
  /**
   * The pageview this outcome or interaction happened on, as the browser reports it. It is only
   * believed when that pageview exists, belongs to this organization, and was recorded for the same
   * visitor session as this request; otherwise the reference is dropped and the context stays
   * unknown. It gives the event the page, language and event-time attribution of that visit rather
   * than whatever the session became by the time of the report.
   */
  originEventId?: string | null
  /**
   * An attribution snapshot captured earlier through a real relationship (the checkout that
   * started a subscription). Used only when the request carries no browser session; it does not
   * create one.
   */
  attribution?: { touch: AttributionTouch; attributedAt: string } | null
  /** Overrides the event time; defaults to now. Provider events carry their own occurrence time. */
  occurredAt?: string
}

interface PageContext {
  path: string
  source_path: string | null
  locale: string | null
  page_id: string | null
  page_type: string | null
  document_id: string | null
  product_id: string | null
  location_id: string | null
}

interface VerifiedOriginEvent {
  id: string
  page: PageContext
  observed: ObservedAttribution | null
  attribution: AttributionTouch | null
  attributedAt: string | null
  basis: string
}

/**
 * The pageview an outcome claims to have happened on, believed only when it is this organization's
 * own pageview recorded for this very visitor session. Anything else — an unknown id, another
 * tenant's event, another visitor's — is not context and is dropped rather than trusted.
 */
async function verifiedOriginEvent(db: DbClient, organizationId: string, browser: { sessionId: string; visitorId: string }, originEventId: string | null | undefined): Promise<VerifiedOriginEvent | null> {
  if (!originEventId || !isCanonicalEventId(originEventId)) return null
  const row = await queryFirst<{ id: string; page_path: string; location_id: string | null; payload_json: string }>(db, `SELECT id, page_path, location_id, payload_json FROM analytics_events
    WHERE id = ? AND kind = 'pageview' AND organization_id = ? AND session_id = ? AND visitor_id = ?`, [originEventId, organizationId, browser.sessionId, browser.visitorId])
  if (!row) return null
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>
  const text = (key: string) => typeof payload[key] === 'string' ? payload[key] as string : null
  return {
    id: row.id,
    page: { path: row.page_path, source_path: text('source_path'), locale: text('locale'), page_id: text('page_id'), page_type: text('page_type'),
      document_id: text('document_id'), product_id: text('product_id'), location_id: row.location_id },
    observed: (payload.observed as ObservedAttribution | null | undefined) ?? null,
    attribution: (payload.attribution as AttributionTouch | null | undefined) ?? null,
    attributedAt: text('attributed_at'),
    basis: text('attribution_basis') ?? 'none',
  }
}

/** The pageview a form submission says it came from, or null when the claim is not even shaped like one. Whether it is believed is decided when the event is recorded. */
export function readPageEventId(value: unknown): string | null {
  return isCanonicalEventId(value) ? value : null
}

function allowlistedProperties(rule: ConversionEventDefinition, properties: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> | null {
  if (!properties || !rule.properties) return null
  const kept: Record<string, string | number | boolean> = {}
  for (const name of rule.properties) {
    const value = properties[name]
    if (typeof value === 'string' && value.length > 0) kept[name] = value.slice(0, 255)
    else if (typeof value === 'number' && Number.isFinite(value)) kept[name] = value
    else if (typeof value === 'boolean') kept[name] = value
  }
  return Object.keys(kept).length > 0 ? kept : null
}

/** A UUID-shaped identity derived from an event's organization, name and entity. */
async function entityEventId(organizationId: string, eventName: string, entityId: string): Promise<string> {
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${organizationId}:${eventName}:${entityId}`)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Records one conversion for `input.organizationId`.
 *
 * `origin` is the request (`event.req`) made by the person who produced the outcome, or null
 * when nobody was there (webhook, MCP, scheduled work). Only a request that
 * already carries this platform's own analytics cookies gives the event a
 * browser session and attribution snapshot; anything else is recorded as a
 * nonbrowser outcome with no attribution. A browser session is never minted
 * here.
 */
export async function recordOrganizationConversionEvent(db: DbClient, origin: { headers: Headers } | null, input: OrganizationConversionInput) {
  const rule: ConversionEventDefinition = CONVERSION_EVENT_CATALOG[input.eventName]
  if (!(rule.stages as readonly ConversionStage[]).includes(input.stage)) throw new Error(`Invalid stage for ${input.eventName}`)
  if (rule.entityType !== null && input.entityType !== rule.entityType) throw new Error(`Invalid entity type for ${input.eventName}`)
  if ((input.entityType && !input.entityId) || (!input.entityType && input.entityId)) throw new Error('entityType and entityId must be supplied together')
  // Every checkout is a product's, a table's included.
  if (input.eventName === 'checkout_start' && input.entityType !== 'product') throw new Error('Checkout requires a product')
  if (input.eventName === 'consultation_cta_click') {
    const validScheduleEntity = input.entityType === undefined || input.entityType === null || input.entityType === 'content_document'
    if (input.stage === 'schedule_navigation' && !validScheduleEntity) throw new Error('Invalid entity type for consultation_cta_click')
    if (input.stage === 'external_booking_handoff' && (input.entityType || input.entityId)) throw new Error('External consultation handoffs cannot include an entity')
  }
  if (input.value) {
    if (rule.valueBasis !== input.value.basis) throw new Error(`${input.eventName} cannot carry a ${input.value.basis} value`)
    if (!Number.isSafeInteger(input.value.amount_minor) || (input.value.basis === 'refund' ? input.value.amount_minor <= 0 : input.value.amount_minor < 0)) {
      throw new Error(`Invalid ${input.eventName} value amount`)
    }
    if (!/^[A-Z]{3}$/.test(input.value.currency)) throw new Error(`Invalid ${input.eventName} value currency`)
    if (input.value.basis !== 'quoted' && !input.value.transaction_id) throw new Error(`${input.eventName} requires a transaction identity`)
  }

  if (input.id !== undefined && !isCanonicalEventId(input.id)) throw new Error('An event id must be a canonical UUID')
  // A server interaction about an entity happens once per entity, so its identity comes from that entity, as an outcome's does.
  const identity = input.id ?? (rule.producer === 'server' && rule.kind === 'interaction' && input.entityId
    ? await entityEventId(input.organizationId, input.eventName, input.entityId) : undefined)
  const properties = allowlistedProperties(rule, input.properties)

  const now = input.occurredAt ?? new Date().toISOString()
  const cookies = parseCookies(origin?.headers.get('cookie') ?? '')
  const sessionId = cookies.get(SESSION_COOKIE)
  const visitorId = cookies.get(VISITOR_COOKIE)
  const browser = isCanonicalEventId(sessionId) && isCanonicalEventId(visitorId) ? { sessionId, visitorId } : null

  let attribution: unknown = input.attribution?.touch ?? null
  let attributedAt: string | null = input.attribution?.attributedAt ?? null
  let attributionBasis: string = input.attribution ? 'checkout' : 'none'
  let origin_: VerifiedOriginEvent | null = null
  if (browser) {
    const session = await queryFirst<{ attribution: string; last_touch_at: string | null }>(db, `INSERT INTO analytics_summaries (
      id, kind, organization_id, date, key, payload_json, created_at, updated_at
    ) VALUES (?, 'session', ?, '', ?, ?, ?, ?)
    ON CONFLICT(organization_id, kind, date, key) DO UPDATE SET
      payload_json = json_set(analytics_summaries.payload_json,
        '$.started_at', MIN(json_extract(analytics_summaries.payload_json, '$.started_at'), json_extract(excluded.payload_json, '$.started_at')),
        '$.last_seen_at', MAX(json_extract(analytics_summaries.payload_json, '$.last_seen_at'), json_extract(excluded.payload_json, '$.last_seen_at'))),
      updated_at = MAX(analytics_summaries.updated_at, excluded.updated_at)
    RETURNING json_extract(payload_json, '$.attribution') attribution, json_extract(payload_json, '$.last_touch_at') last_touch_at`, [
      crypto.randomUUID(), input.organizationId, browser.sessionId,
      JSON.stringify({ visitor_id: browser.visitorId, started_at: now, last_seen_at: now,
        landing_path: input.pagePath?.startsWith('/') ? input.pagePath : '/', duration_seconds: 0,
        attribution: { source: 'Direct', medium: '(none)', campaign: null, term: null, content: null,
          referrerHost: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null }, last_touch_at: null }), now, now,
    ])
    if (!session) throw new Error('Analytics session unavailable')
    attribution = JSON.parse(session.attribution)
    attributedAt = session.last_touch_at ?? now
    attributionBasis = session.last_touch_at ? 'session_current' : 'none'
    origin_ = await verifiedOriginEvent(db, input.organizationId, browser, input.originEventId)
    if (origin_) {
      // The visit this happened on keeps its own context, including having none: a later campaign
      // touch on the same session is not the context of an earlier visit.
      attribution = origin_.attribution
      attributedAt = origin_.attributedAt
      attributionBasis = origin_.basis
    }
  }

  const id = identity ?? crypto.randomUUID()
  const ipHash = origin ? await hashIp(getClientIp({ req: origin })) : null
  const payload = JSON.stringify({ event_name: input.eventName, stage: input.stage, entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null, page_type: input.pageType ?? null, route_path: input.routePath ?? null, cta_destination: input.ctaDestination ?? null,
    conversion_type: rule.conversionType, surface: input.surface, actor: input.actor ?? null,
    attribution, attributed_at: attributedAt, attribution_basis: attributionBasis, observed: origin_?.observed ?? null,
    origin_event_id: origin_?.id ?? null, page: origin_?.page ?? null, properties,
    product_id: input.productId ?? (input.entityType === 'product' ? input.entityId : null) ?? null, variant_id: input.variantId ?? null,
    value: input.value ?? null, metadata: input.metadata ?? null,
    ip_hash: ipHash, user_agent: (origin?.headers.get('user-agent') || '').slice(0, 1024) || null })
  const inserted = await execute(db, `INSERT OR IGNORE INTO analytics_events (
    id, kind, organization_id, session_id, visitor_id, location_id, page_path, payload_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id, rule.kind, input.organizationId, browser?.sessionId ?? null, browser?.visitorId ?? null, input.locationId ?? origin_?.page.location_id ?? null, origin_?.page.path ?? input.pagePath ?? null, payload, now,
  ])
  if (Number(inserted.meta?.changes ?? 0) === 1) return { id, created: true }

  // An interaction with a supplied identity that already exists is the same interaction delivered
  // again. The identity must be this organization's own: another tenant's event is never returned.
  if (identity) {
    const same = await queryFirst<{ organization_id: string }>(db, 'SELECT organization_id FROM analytics_events WHERE id = ?', [id])
    if (same?.organization_id !== input.organizationId) throw new Error('Analytics event id belongs to another organization')
    return { id, created: false }
  }

  // The insert was ignored by the entity-uniqueness index: the outcome is
  // already recorded, and its persisted identity is the answer.
  const existing = await queryFirst<{ id: string }>(db, `SELECT id FROM analytics_events
    WHERE kind IN ('conversion', 'interaction') AND organization_id = ? AND (payload_json ->> '$.event_name') = ?
      AND (payload_json ->> '$.entity_type') = ? AND (payload_json ->> '$.entity_id') = ?`,
  [input.organizationId, input.eventName, input.entityType ?? null, input.entityId ?? null])
  if (!existing) throw new Error(`Conversion ${input.eventName} was neither inserted nor found`)
  return { id: existing.id, created: false }
}

/**
 * Records a server-produced outcome and, the first time it is recorded, sends
 * its GA4 projection through Measurement Protocol, with the consent and GA client of the visitor's own request. A repeat of the same
 * outcome returns the persisted event and sends nothing: one outcome, one GA
 * event. The outcome of the send lives on the event (`ga4_delivery`).
 */
export async function recordAndDeliverConversion(env: MeasurementProtocolEnv, db: DbClient, origin: { headers: Headers } | null, input: OrganizationConversionInput) {
  const recorded = await recordOrganizationConversionEvent(db, origin, input)
  if (recorded.created) {
    await deliverForVisitor(env, db, {
      eventId: recorded.id, organizationId: input.organizationId, origin,
      projection: projectConversionToGa4({ eventName: input.eventName, value: input.value }),
    })
    await deliverMetaCapiForEvent(env as never, db, {
      eventId: recorded.id, organizationId: input.organizationId, origin, input,
    })
  }
  return recorded
}

/**
 * The person an organization's acquisition is attributed to. Once any event has recorded it
 * (onboarding or a payment), that established relationship is the answer for every later event of
 * that organization: an ownership transfer never reassigns a payment or refund to a new owner.
 * Only the first recording falls back to the first owner the organization ever had (the one who
 * created it), read from membership. Cohorts follow this, so a later ownership change never
 * rewrites a historical campaign result.
 */
export async function originatingOwnerId(db: DbClient, measuringOrganizationId: string, organizationId: string): Promise<string | null> {
  const recorded = await queryFirst<{ id: string }>(db, `SELECT (payload_json ->> '$.metadata.originating_user_id') AS id FROM analytics_events
    WHERE kind = 'conversion' AND organization_id = ? AND json_type(payload_json, '$.metadata.originating_user_id') IS 'text'
      AND (((payload_json ->> '$.event_name') = 'onboarding_complete' AND (payload_json ->> '$.entity_id') = ?)
        OR ((payload_json ->> '$.event_name') = 'purchase' AND (payload_json ->> '$.metadata.subscribing_organization_id') = ?))
    ORDER BY created_at, id LIMIT 1`, [measuringOrganizationId, organizationId, organizationId])
  if (recorded) return recorded.id
  const first = await queryFirst<{ userId: string }>(db,
    `SELECT "userId" FROM member WHERE "organizationId" = ? AND role = 'owner' ORDER BY "createdAt", id LIMIT 1`, [organizationId])
  return first?.userId ?? null
}

/**
 * Measurement is recorded after the business transition has committed, so its
 * failure is reported next to the committed result and never in place of it:
 * a guest told their confirmed booking failed would book again.
 */
export function measurementOutcome(result: PromiseSettledResult<unknown>): { status: 'recorded'; event_id?: string } | { status: 'failed'; reason: string } {
  // `event_id` is the canonical native event a Google Analytics projection may mirror: a browser
  // sends its GA copy only for a recorded event, and carries this id so both name one fact.
  const id = result.status === 'fulfilled' && result.value && typeof result.value === 'object' && 'id' in result.value && typeof result.value.id === 'string' ? result.value.id : undefined
  return result.status === 'fulfilled'
    ? { status: 'recorded', ...(id ? { event_id: id } : {}) }
    : { status: 'failed', reason: result.reason instanceof Error ? result.reason.message : String(result.reason) }
}
