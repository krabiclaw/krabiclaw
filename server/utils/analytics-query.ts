import type { DbClient } from '~/server/db'
import { queryAll, queryFirst } from '~/server/db'
import { localDateBounds, parseAnalyticsRange } from '~/server/utils/analytics-calendar'
import { resolveOrganizationAnalyticsContext } from '~/server/utils/analytics-report'
import { CONVERSION_EVENT_CATALOG, ORGANIZATION_CONVERSION_EVENT_NAMES } from '~/utils/organization-conversion-events'

/**
 * The one native analytics query implementation. MCP, the dashboard API and the CMS all call it, so
 * a question asked through any of them is answered by the same code over the same D1 rows.
 *
 * Three modes read what the collector stored, never a projection of it:
 *  - events: individual events with every observation the collector kept;
 *  - sessions: the native session records and their derived last-touch state;
 *  - breakdown: complete grouped results over the whole filtered population;
 *  - daily_summaries: the daily summary rows (organization, page and dimension days) at their
 *    own grain. They outlive raw pageview detail, so a period past it is answered from them, and each
 *    row says it is a summary, not events.
 *
 * Everything the caller can name comes from the field, filter and metric registries below. There is
 * no SQL, expression, table or JSON path in the request: an unknown name is rejected, not passed on.
 */

export class AnalyticsQueryError extends Error {}

export type AnalyticsQueryMode = 'events' | 'sessions' | 'breakdown' | 'daily_summaries'
export type AttributionBasis = 'observed' | 'event_snapshot' | 'session_last_touch'

const PAGE_SIZE_DEFAULT = 50
const PAGE_SIZE_MAX = 200

const invalid = (message: string): never => { throw new AnalyticsQueryError(message) }

/**
 * The query window is server-computed (a range from the organization's calendar and an `as_of` from
 * the server clock or a signed cursor), never caller text. SQL fragments name it with `@start`,
 * `@end` and `@asof`, and it is bound as a validated instant literal.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
function bindWindow(sql: string, window: { start: string; end: string; asOf: string }): string {
  for (const value of [window.start, window.end, window.asOf]) if (!INSTANT.test(value)) invalid('Invalid query window.')
  return sql.replaceAll('@start', `'${window.start}'`).replaceAll('@end', `'${window.end}'`).replaceAll('@asof', `'${window.asOf}'`)
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

const ATTRIBUTION_FIELDS = {
  source: 'source', medium: 'medium', campaign: 'campaign', content: 'content', term: 'term',
  referrer_host: 'referrerHost', gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', fbclid: 'fbclid', msclkid: 'msclkid',
} as const
type AttributionField = keyof typeof ATTRIBUTION_FIELDS

interface EventField {
  /** SQL over the event alias `e` (and the session alias `s` for the session-last-touch basis). */
  sql: (basis: AttributionBasis) => string
  description: string
}

const payload = (path: string) => `json_extract(e.payload_json, '${path}')`
const EVENT_NAME_SQL = `CASE WHEN e.kind = 'pageview' THEN 'pageview' ELSE ${payload('$.event_name')} END`
const LOCALE_SQL = `COALESCE(${payload('$.locale')}, ${payload('$.page.locale')})`
const DEVICE_SQL = `CASE WHEN ${payload('$.user_agent')} IS NULL OR ${payload('$.user_agent')} = '' THEN NULL
  WHEN lower(${payload('$.user_agent')}) LIKE '%ipad%' OR lower(${payload('$.user_agent')}) LIKE '%tablet%' THEN 'Tablet'
  WHEN lower(${payload('$.user_agent')}) LIKE '%mobile%' OR lower(${payload('$.user_agent')}) LIKE '%android%' THEN 'Mobile' ELSE 'Desktop' END`

function attributionSql(field: AttributionField): EventField['sql'] {
  const key = ATTRIBUTION_FIELDS[field]
  return (basis) => basis === 'observed' ? payload(`$.observed.${key}`)
    : basis === 'event_snapshot' ? payload(`$.attribution.${key}`)
      : sessionTouchAsOf(key, 'e')
}

/**
 * The session's last touch as it stood at the query's `as_of` boundary, not as it is now. A session
 * record that has not changed since the boundary is exact; one that has changed is rebuilt from the
 * pageviews that had been received by then (the latest one that carried a touch of its
 * own), so a touch that arrives between two pages of a result never moves earlier events between
 * groups. A session with no touch by the boundary was Direct.
 */
/** A session record that no event has touched since the boundary is exactly what it was at the boundary. */
const SESSION_UNCHANGED = `NOT EXISTS (SELECT 1 FROM analytics_events u WHERE u.organization_id = s.organization_id AND u.session_id = s.key AND u.received_at > @asof)`

function sessionTouchAsOf(key: string, eventAlias: string | null): string {
  const session = eventAlias ? `t.session_id = ${eventAlias}.session_id` : 't.session_id = s.key'
  const rebuilt = `(SELECT json_extract(t.payload_json, '$.attribution.${key}') FROM analytics_events t
    WHERE t.organization_id = s.organization_id AND ${session} AND t.kind = 'pageview'
      AND json_extract(t.payload_json, '$.attribution_basis') = 'own_touch' AND t.received_at <= @asof
    ORDER BY t.created_at DESC, t.id DESC LIMIT 1)`
  const none = key === 'source' ? `'Direct'` : key === 'medium' ? `'(none)'` : 'NULL'
  return `CASE WHEN ${SESSION_UNCHANGED} THEN json_extract(s.payload_json, '$.attribution.${key}') ELSE COALESCE(${rebuilt}, ${none}) END`
}

const EVENT_FIELDS: Record<string, EventField> = {
  kind: { sql: () => 'e.kind', description: 'pageview, conversion (a business outcome) or interaction' },
  event_name: { sql: () => EVENT_NAME_SQL, description: 'pageview, or the catalog event name' },
  stage: { sql: () => payload('$.stage'), description: 'outcome or interaction stage' },
  surface: { sql: () => payload('$.surface'), description: 'the surface that produced the event' },
  page_path: { sql: () => 'e.page_path', description: 'the public path exactly as visited (localized visits keep their prefix)' },
  source_path: { sql: () => payload('$.source_path'), description: 'the locale-bare path documents are stored under' },
  page_id: { sql: () => `COALESCE(${payload('$.page_id')}, ${payload('$.page.page_id')})`, description: 'the canonical page document' },
  page_type: { sql: () => `COALESCE(${payload('$.page_type')}, ${payload('$.page.page_type')})`, description: 'the page type' },
  product_id: { sql: () => `COALESCE(${payload('$.product_id')}, ${payload('$.page.product_id')})`, description: 'the product the event is about' },
  variant_id: { sql: () => payload('$.variant_id'), description: 'the product variant the event is about' },
  location_id: { sql: () => 'e.location_id', description: 'the business location' },
  locale: { sql: () => LOCALE_SQL, description: 'the language of the visit' },
  entity_type: { sql: () => payload('$.entity_type'), description: 'the business subject type of an outcome or interaction' },
  entity_id: { sql: () => payload('$.entity_id'), description: 'the business subject of an outcome or interaction' },
  session_id: { sql: () => 'e.session_id', description: 'the native session; null for a server outcome with no browser' },
  visitor_id: { sql: () => 'e.visitor_id', description: 'the native visitor; null for a server outcome with no browser' },
  device: { sql: () => DEVICE_SQL, description: 'device class derived from the user agent' },
  country: { sql: () => `upper(${payload('$.country')})`, description: 'ISO country code' },
  region: { sql: () => payload('$.region'), description: 'region' },
  city: { sql: () => payload('$.city'), description: 'city' },
  currency: { sql: () => payload('$.value.currency'), description: 'currency of a monetary outcome' },
  value_basis: { sql: () => payload('$.value.basis'), description: 'quoted, purchase or refund' },
  conversion_type: { sql: () => payload('$.conversion_type'), description: 'contact, reservation, booking or subscription' },
  attribution_basis: { sql: () => payload('$.attribution_basis'), description: 'how the event snapshot arose: own_touch, inherited, session_current, checkout or none' },
  actor_id: { sql: () => payload('$.actor.id'), description: 'the staff member, agent or user who acted, when not the subject' },
  member_id: { sql: () => payload('$.properties.member_id'), description: 'the team member a paid booking or booking decision is with' },
  tenant_organization_id: { sql: () => payload('$.properties.tenant_organization_id'), description: 'on the platform organization: the business a Payments volume or fee invoice belongs to' },
  ga4_delivery_status: { sql: () => payload('$.ga4_delivery.status'), description: 'the outcome of the optional GA4 delivery' },
  ...Object.fromEntries((Object.keys(ATTRIBUTION_FIELDS) as AttributionField[]).map(field => [field, {
    sql: attributionSql(field),
    description: `${field} on the requested attribution_basis (observed: as the event carried it; event_snapshot: the attribution in force for the event when it happened; session_last_touch: the session's current last touch)`,
  } satisfies EventField])),
}

export const ANALYTICS_QUERY_FIELDS = Object.fromEntries(Object.entries(EVENT_FIELDS).map(([name, field]) => [name, field.description]))
const ENUM_FILTERS: Record<string, readonly string[]> = {
  kind: ['pageview', 'conversion', 'interaction'],
  value_basis: ['quoted', 'purchase', 'refund'],
  event_name: ['pageview', ...ORGANIZATION_CONVERSION_EVENT_NAMES],
  attribution_basis: ['own_touch', 'inherited', 'session_current', 'checkout', 'none'],
  ga4_delivery_status: ['sent', 'dispatched', 'not_configured', 'disconnected', 'no_consent_context', 'consent_rejected', 'failed'],
}
const FILTER_KEYS = new Set([...Object.keys(EVENT_FIELDS), 'path_prefix', 'campaign_prefix', 'outcome_event'])
export const ANALYTICS_QUERY_DIMENSIONS = Object.keys(EVENT_FIELDS)

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

const OUTCOME_LIST = ORGANIZATION_CONVERSION_EVENT_NAMES.filter(name => CONVERSION_EVENT_CATALOG[name].outcome).map(name => `'${name}'`).join(', ')
/** Whether the event's own session completed the selected outcome in the range: an attribute of the session, evaluated for the pageview that makes the session eligible. */
const SESSION_HAS_OUTCOME = `EXISTS (SELECT 1 FROM analytics_events o WHERE o.organization_id = e.organization_id AND o.session_id = e.session_id
  AND o.kind IN ('conversion', 'interaction') AND json_extract(o.payload_json, '$.event_name') = @outcome
  AND o.created_at >= @start AND o.created_at < @end AND o.received_at <= @asof)`
const valueSum = (basis: string, column: string) => `COALESCE(SUM(CASE WHEN ${payload('$.value.basis')} = '${basis}' THEN ${payload(column)} END), 0)`

/** Whether the checkout this started-event is about was paid. */
const CHECKOUT_PAID = `EXISTS (SELECT 1 FROM analytics_events p WHERE p.organization_id = e.organization_id AND p.kind = 'conversion'
  AND json_extract(p.payload_json, '$.event_name') = 'payment_paid' AND json_extract(p.payload_json, '$.entity_id') = ${payload('$.entity_id')} AND p.received_at <= @asof)`
interface Metric { sql: string; unit: string; monetary?: boolean; needsOutcome?: boolean; nullable?: boolean; description: string }
const METRICS: Record<string, Metric> = {
  events: { sql: 'COUNT(*)', unit: 'events', description: 'every matching event' },
  page_views: { sql: `COALESCE(SUM(e.kind = 'pageview'), 0)`, unit: 'page views', description: 'matching pageview events' },
  interactions: { sql: `COALESCE(SUM(e.kind = 'interaction'), 0)`, unit: 'interactions', description: 'matching interaction events (not outcomes)' },
  outcomes: { sql: `COALESCE(SUM(e.kind = 'conversion' AND ${EVENT_NAME_SQL} IN (${OUTCOME_LIST})), 0)`, unit: 'outcome events', description: 'matching business outcome events' },
  sessions: { sql: 'COUNT(DISTINCT e.session_id)', unit: 'distinct sessions', description: 'distinct sessions at the requested grain' },
  visitors: { sql: 'COUNT(DISTINCT e.visitor_id)', unit: 'distinct visitors', description: 'distinct visitors at the requested grain' },
  entities: { sql: `COUNT(DISTINCT CASE WHEN ${payload('$.entity_id')} IS NOT NULL THEN ${payload('$.entity_type')} || ':' || ${payload('$.entity_id')} END)`, unit: 'distinct business subjects', description: 'distinct entities (request, user, organization, invoice, refund, product) the events are about' },
  quoted_value_minor: { sql: valueSum('quoted', '$.value.amount_minor'), unit: 'minor units of the group currency', monetary: true, description: 'quoted booking value: the price shown, not revenue' },
  purchase_value_minor: { sql: valueSum('purchase', '$.value.amount_minor'), unit: 'minor units of the group currency', monetary: true, description: 'verified purchase value excluding tax' },
  collected_minor: { sql: valueSum('purchase', '$.value.collected_minor'), unit: 'minor units of the group currency', monetary: true, description: 'cash collected by verified purchases, tax included' },
  refunded_minor: { sql: valueSum('refund', '$.value.collected_minor'), unit: 'minor units of the group currency', monetary: true, description: 'cash returned by verified refunds, tax included' },
  net_collected_minor: { sql: `${valueSum('purchase', '$.value.collected_minor')} - ${valueSum('refund', '$.value.collected_minor')}`, unit: 'minor units of the group currency', monetary: true, description: 'collected minus refunded cash' },
  converting_sessions: { sql: `COUNT(DISTINCT CASE WHEN e.kind = 'pageview' AND ${SESSION_HAS_OUTCOME} THEN e.session_id END)`, unit: 'distinct eligible sessions that completed the selected outcome in the range', needsOutcome: true, description: 'sessions in the group with a pageview that also completed outcome_event in the range; always a subset of eligible_sessions' },
  eligible_sessions: { sql: `COUNT(DISTINCT CASE WHEN e.kind = 'pageview' THEN e.session_id END)`, unit: 'distinct sessions with a pageview', description: 'the denominator population: sessions with a pageview in the group' },
  session_conversion_rate: { sql: `CASE WHEN COUNT(DISTINCT CASE WHEN e.kind = 'pageview' THEN e.session_id END) = 0 THEN NULL ELSE 100.0 * COUNT(DISTINCT CASE WHEN e.kind = 'pageview' AND ${SESSION_HAS_OUTCOME} THEN e.session_id END) / COUNT(DISTINCT CASE WHEN e.kind = 'pageview' THEN e.session_id END) END`, unit: 'percent: converting sessions / eligible sessions, over the same sessions', needsOutcome: true, nullable: true, description: 'converting_sessions / eligible_sessions within the group, computed over one session population; null when the group has no eligible session' },
  checkouts_started: { sql: `COALESCE(SUM(${EVENT_NAME_SQL} = 'payment_checkout_started'), 0)`, unit: 'checkouts', description: 'Stripe Checkouts started for a paid booking or order' },
  payments_paid: { sql: `COALESCE(SUM(${EVENT_NAME_SQL} = 'payment_paid'), 0)`, unit: 'payments', description: 'payments captured' },
  refunds_sent: { sql: `COALESCE(SUM(${EVENT_NAME_SQL} = 'payment_refunded'), 0)`, unit: 'refunds', description: 'refunds that reached the buyer' },
  checkout_conversion_rate: { sql: `CASE WHEN SUM(${EVENT_NAME_SQL} = 'payment_checkout_started') = 0 THEN NULL ELSE 100.0 * SUM(${EVENT_NAME_SQL} = 'payment_checkout_started' AND ${CHECKOUT_PAID}) / SUM(${EVENT_NAME_SQL} = 'payment_checkout_started') END`, unit: 'percent: checkouts started that were paid / checkouts started', nullable: true, description: 'share of the checkouts started in the group that were paid; null with no checkout' },
  refund_rate: { sql: `CASE WHEN SUM(${EVENT_NAME_SQL} = 'payment_paid') = 0 THEN NULL ELSE 100.0 * SUM(${EVENT_NAME_SQL} = 'payment_refunded') / SUM(${EVENT_NAME_SQL} = 'payment_paid') END`, unit: 'percent: refunds sent / payments captured', nullable: true, description: 'refunds sent per payment captured in the group; null with no payment' },
  payments_volume_minor: { sql: `COALESCE(SUM(CASE WHEN ${EVENT_NAME_SQL} = 'payments_volume_billed' THEN ${payload('$.properties.volume_minor')} END), 0)`, unit: 'minor units of the group currency', monetary: true, description: 'on the platform organization: captured volume businesses reported for their Payments fee' },
  avg_decision_seconds: { sql: `AVG(CASE WHEN ${EVENT_NAME_SQL} IN ('booking_confirmed', 'booking_declined') THEN ${payload('$.properties.decision_seconds')} END)`, unit: 'seconds', nullable: true, description: 'average time from a booking request to the business confirming or declining it' },
}
export const ANALYTICS_QUERY_METRICS = Object.fromEntries(Object.entries(METRICS).map(([name, metric]) => [name, { unit: metric.unit, description: metric.description }]))

// ---------------------------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------------------------

interface CursorBody { v: 1; org: string; q: string; asOf: string; key: unknown[] }

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const unb64 = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0))

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))))
}

async function digest(text: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).slice(0, 22)
}

async function encodeCursor(secret: string, body: CursorBody): Promise<string> {
  const text = b64(new TextEncoder().encode(JSON.stringify(body)))
  return `${text}.${await hmac(secret, text)}`
}

/** A cursor is valid only for the tenant, the exact query, the sort and the dataset boundary it was issued for, and only if it is untampered. */
async function decodeCursor(secret: string, cursor: string, organizationId: string, queryHash: string): Promise<CursorBody> {
  const [text, signature] = cursor.split('.')
  if (!text || !signature || signature !== await hmac(secret, text)) return invalid('Invalid pagination cursor. Read the first page again.')
  let body: CursorBody
  try { body = JSON.parse(new TextDecoder().decode(unb64(text))) as CursorBody } catch { return invalid('Invalid pagination cursor. Read the first page again.') }
  if (body.v !== 1 || body.org !== organizationId) return invalid('Pagination cursor does not belong to this organization.')
  if (body.q !== queryHash) return invalid('Pagination cursor does not belong to this query. Repeat the same request with the cursor.')
  if (!Array.isArray(body.key) || typeof body.asOf !== 'string') return invalid('Invalid pagination cursor. Read the first page again.')
  return body
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

export interface AnalyticsQueryInput {
  organizationId: string
  mode: AnalyticsQueryMode
  startDate?: string
  endDate?: string
  filters?: Record<string, unknown>
  attributionBasis?: AttributionBasis
  sort?: { metric?: string; direction?: 'asc' | 'desc' } | 'occurred_at_desc' | 'occurred_at_asc'
  limit?: number
  cursor?: string
  dimensions?: string[]
  metrics?: string[]
  /** The outcome event that converting_sessions and session_conversion_rate measure. */
  outcomeEvent?: string
  now?: Date
  /** The secret that signs cursors. */
  cursorSecret: string
}

interface ResolvedFilters { where: string[]; params: unknown[]; echo: Record<string, string>; needsSession: boolean }

function resolveFilters(mode: AnalyticsQueryMode, raw: Record<string, unknown> | undefined, basis: AttributionBasis): ResolvedFilters {
  const where: string[] = []
  const params: unknown[] = []
  const echo: Record<string, string> = {}
  let needsSession = false
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!FILTER_KEYS.has(name)) invalid(`Unknown filter "${name}". Supported filters: ${[...FILTER_KEYS].sort().join(', ')}.`)
    if (name === 'outcome_event') continue
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) invalid(`Filter "${name}" must be a non-empty string of at most 512 characters.`)
    const text = value as string
    if (ENUM_FILTERS[name] && !ENUM_FILTERS[name]!.includes(text)) invalid(`Filter "${name}" must be one of: ${ENUM_FILTERS[name]!.join(', ')}.`)
    echo[name] = text
    if (name === 'campaign_prefix') {
      if (basis === 'session_last_touch') needsSession = true
      where.push(`substr(${EVENT_FIELDS.campaign!.sql(basis)}, 1, length(?)) = ?`)
      params.push(text, text)
      continue
    }
    if (name === 'path_prefix') {
      if (!text.startsWith('/')) invalid('path_prefix must start with "/".')
      where.push(`(e.page_path = ? OR e.page_path LIKE ? ESCAPE '\\')`)
      params.push(text.replace(/\/$/, '') || '/', `${text.replace(/[\\%_]/g, '\\$&')}%`)
      continue
    }
    if (name in ATTRIBUTION_FIELDS && basis === 'session_last_touch') needsSession = true
    where.push(`${EVENT_FIELDS[name]!.sql(basis)} = ?`)
    params.push(text)
  }
  return { where, params, echo, needsSession }
}

const FROM = (needsSession: boolean) => `analytics_events e${needsSession ? ` LEFT JOIN analytics_summaries s ON s.organization_id = e.organization_id AND s.kind = 'session' AND s.date = '' AND s.key = e.session_id` : ''}`

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

export interface AnalyticsQueryResult {
  mode: AnalyticsQueryMode
  rows: Array<Record<string, unknown>>
  next_cursor: string | null
  query: Record<string, unknown>
  totals: Record<string, { value: number | null; unit: string }> & { by_currency?: Array<Record<string, unknown>> }
  coverage: Record<string, unknown>
}

export async function queryOrganizationAnalytics(db: DbClient, input: AnalyticsQueryInput): Promise<AnalyticsQueryResult> {
  const now = input.now ?? new Date()
  const context = await resolveOrganizationAnalyticsContext(db, input.organizationId)
  const range = parseAnalyticsRange({ startDate: input.startDate, endDate: input.endDate, timeZone: context.timezone, now })
  const start = localDateBounds(range.startDate, context.timezone).start
  const end = localDateBounds(range.endDate, context.timezone).end
  const limit = input.limit ?? PAGE_SIZE_DEFAULT
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) invalid(`limit must be an integer between 1 and ${PAGE_SIZE_MAX}.`)
  const basis: AttributionBasis = input.attributionBasis ?? (input.mode === 'sessions' ? 'session_last_touch' : 'event_snapshot')
  if (input.mode === 'sessions' && basis !== 'session_last_touch') invalid('Sessions carry only their derived last touch: attribution_basis must be session_last_touch.')

  const resolved: Record<string, unknown> = {
    mode: input.mode, start_date: range.startDate, end_date: range.endDate, timezone: context.timezone, range_start: start, range_end: end,
    attribution_basis: basis,
  }
  const summaryFilters = input.mode === 'daily_summaries' ? resolveSummaryFilters(input) : null
  const filters = summaryFilters ? { where: [], params: [], echo: summaryFilters.echo, needsSession: false } : resolveFilters(input.mode, input.filters, basis)
  resolved.filters = filters.echo
  const outcomeEvent = input.outcomeEvent ?? (typeof input.filters?.outcome_event === 'string' ? input.filters.outcome_event : undefined)
  if (outcomeEvent !== undefined && !(ORGANIZATION_CONVERSION_EVENT_NAMES as readonly string[]).includes(outcomeEvent)) invalid(`outcome_event must be one of: ${ORGANIZATION_CONVERSION_EVENT_NAMES.join(', ')}.`)

  const hashBasis = JSON.stringify({ ...resolved, sort: input.sort ?? null, limit, dimensions: input.dimensions ?? null, metrics: input.metrics ?? null, outcomeEvent: outcomeEvent ?? null })
  const queryHash = await digest(hashBasis)
  const cursor = input.cursor ? await decodeCursor(input.cursorSecret, input.cursor, input.organizationId, queryHash) : null
  // The dataset boundary: what the server had accepted when the first page was read. Every later page
  // reads the same boundary, so a late event lands in a later query, never in the middle of this one.
  const asOf = cursor?.asOf ?? now.toISOString()
  resolved.as_of = asOf

  const coverage = await coverageFor(db, input.organizationId, { start, end, now, analyticsDataStartAt: context.analyticsDataStartAt, filters, basis })
  const issue = async (key: unknown[] | null) => key ? await encodeCursor(input.cursorSecret, { v: 1, org: input.organizationId, q: queryHash, asOf, key }) : null

  if (input.mode === 'daily_summaries') {
    const result = await summariesMode(db, input, { start, end, asOf, limit, filters, cursorKey: cursor?.key ?? null, resolved }, summaryFilters!, { startDate: range.startDate, endDate: range.endDate })
    return { mode: 'daily_summaries', rows: result.rows, next_cursor: await issue(result.nextKey), query: resolved, totals: result.totals, coverage: { ...coverage, summary_source: result.source } }
  }
  if (input.mode === 'events') {
    const result = await eventsMode(db, input, { start, end, asOf, limit, basis, filters, cursorKey: cursor?.key ?? null, resolved })
    return { mode: 'events', rows: result.rows, next_cursor: await issue(result.nextKey), query: resolved, totals: result.totals, coverage }
  }
  if (input.mode === 'sessions') {
    const result = await sessionsMode(db, input, { start, end, asOf, limit, filters, cursorKey: cursor?.key ?? null, resolved })
    return { mode: 'sessions', rows: result.rows, next_cursor: await issue(result.nextKey), query: resolved, totals: result.totals, coverage }
  }
  const result = await breakdownMode(db, input, { start, end, asOf, limit, basis, filters, cursorKey: cursor?.key ?? null, resolved, outcomeEvent })
  return { mode: 'breakdown', rows: result.rows, next_cursor: await issue(result.nextKey), query: resolved, totals: result.totals, coverage }
}

interface ModeContext { start: string; end: string; asOf: string; limit: number; filters: ResolvedFilters; cursorKey: unknown[] | null; resolved: Record<string, unknown> }

const populationWhere = (ctx: { start: string; end: string; asOf: string; filters: ResolvedFilters }) => ({
  sql: bindWindow(`e.organization_id = ? AND e.created_at >= ? AND e.created_at < ? AND e.received_at <= ?${ctx.filters.where.length ? ` AND ${ctx.filters.where.join(' AND ')}` : ''}`, ctx),
  params: (organizationId: string) => [organizationId, ctx.start, ctx.end, ctx.asOf, ...ctx.filters.params],
})

const j = (text: unknown) => typeof text === 'string' ? JSON.parse(text) as unknown : null

async function eventsMode(db: DbClient, input: AnalyticsQueryInput, ctx: ModeContext & { basis: AttributionBasis }) {
  if (input.dimensions || input.metrics) invalid('dimensions and metrics apply to breakdown mode only.')
  const direction = input.sort === 'occurred_at_asc' ? 'asc' : (input.sort === undefined || input.sort === 'occurred_at_desc') ? 'desc' : invalid('sort for events must be occurred_at_desc or occurred_at_asc.')
  ctx.resolved.sort = `occurred_at_${direction}`
  const where = populationWhere(ctx)
  const keyset = ctx.cursorKey ? `AND (e.created_at, e.id) ${direction === 'desc' ? '<' : '>'} (?, ?)` : ''
  const rows = await queryAll<Record<string, unknown>>(db, `SELECT e.id, e.kind, e.created_at, e.received_at, e.session_id, e.visitor_id, e.location_id, e.page_path, e.duration_seconds, e.payload_json
    FROM ${FROM(ctx.filters.needsSession)} WHERE ${where.sql} ${keyset}
    ORDER BY e.created_at ${direction}, e.id ${direction} LIMIT ?`, [...where.params(input.organizationId), ...(ctx.cursorKey ?? []), ctx.limit + 1])
  const page = rows.slice(0, ctx.limit)
  const last = page.at(-1)
  const totals = await totalsFor(db, input.organizationId, ctx, ['events', 'page_views', 'interactions', 'outcomes', 'sessions', 'visitors'])
  return {
    rows: page.map(eventRow),
    nextKey: rows.length > ctx.limit && last ? [last.created_at, last.id] : null,
    totals,
  }
}

function eventRow(row: Record<string, unknown>): Record<string, unknown> {
  const body = (j(row.payload_json) ?? {}) as Record<string, unknown>
  const has = (key: string) => key in body
  const value = body.value as Record<string, unknown> | null | undefined
  // Facts this event was recorded without: absent from the record itself, so an event that predates
  // the fact says so instead of reading as "none observed".
  const missing: string[] = []
  if (row.kind === 'pageview') {
    if (!has('observed')) missing.push('observed_attribution')
    if (!has('attribution_basis')) missing.push('attribution_snapshot')
    if (!has('source_path')) missing.push('page_identity')
  } else {
    if (!has('attribution_basis')) missing.push('attribution_basis')
    if (!has('page') && !has('observed')) missing.push('page_context')
  }
  return {
    event_id: row.id, kind: row.kind,
    event_name: row.kind === 'pageview' ? 'pageview' : body.event_name ?? null,
    occurred_at: row.created_at, received_at: row.received_at,
    stage: body.stage ?? null, surface: body.surface ?? null, conversion_type: body.conversion_type ?? null,
    page: { path: row.page_path ?? null, source_path: body.source_path ?? (body.page as Record<string, unknown> | null)?.source_path ?? null,
      locale: body.locale ?? (body.page as Record<string, unknown> | null)?.locale ?? null, page_id: body.page_id ?? (body.page as Record<string, unknown> | null)?.page_id ?? null,
      page_type: body.page_type ?? (body.page as Record<string, unknown> | null)?.page_type ?? null, document_id: body.document_id ?? (body.page as Record<string, unknown> | null)?.document_id ?? null },
    location_id: row.location_id ?? null,
    product_id: body.product_id ?? (body.page as Record<string, unknown> | null)?.product_id ?? null, variant_id: body.variant_id ?? null,
    session_id: row.session_id ?? null, visitor_id: row.visitor_id ?? null,
    subject: body.entity_type ? { type: body.entity_type, id: body.entity_id ?? null } : null, actor: body.actor ?? null,
    observed: has('observed') ? body.observed ?? null : undefined,
    attribution: has('attribution') ? { snapshot: body.attribution ?? null, basis: body.attribution_basis ?? 'none', attributed_at: body.attributed_at ?? null } : undefined,
    origin_event_id: body.origin_event_id ?? null,
    referrer_host: body.referrer ?? null,
    device: body.user_agent ? (String(body.user_agent).toLowerCase().match(/ipad|tablet/) ? 'Tablet' : String(body.user_agent).toLowerCase().match(/mobile|android/) ? 'Mobile' : 'Desktop') : null,
    geography: { country: body.country ?? null, region: body.region ?? null, city: body.city ?? null },
    duration_seconds: row.duration_seconds ?? null,
    value: value ?? null, properties: body.properties ?? null, metadata: body.metadata ?? null,
    ga4_delivery: body.ga4_delivery ?? null,
    missing,
  }
}

async function sessionsMode(db: DbClient, input: AnalyticsQueryInput, ctx: ModeContext) {
  if (input.dimensions || input.metrics) invalid('dimensions and metrics apply to breakdown mode only.')
  const supported = new Set(['session_id', 'visitor_id', 'source', 'medium', 'campaign', 'campaign_prefix', 'content', 'term', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'path_prefix'])
  for (const name of Object.keys(ctx.filters.echo)) if (!supported.has(name)) invalid(`Filter "${name}" does not apply to sessions. Supported: ${[...supported].join(', ')}.`)
  ctx.resolved.sort = 'started_at_desc'
  // Everything a session record says that later activity can change is read as it stood at `as_of`.
  const asOfState = (column: 'started_at' | 'last_seen_at', aggregate: 'MIN' | 'MAX') => `CASE WHEN ${SESSION_UNCHANGED} THEN json_extract(s.payload_json, '$.${column}')
    ELSE COALESCE((SELECT ${aggregate}(t.created_at) FROM analytics_events t WHERE t.organization_id = s.organization_id AND t.session_id = s.key AND t.received_at <= @asof), json_extract(s.payload_json, '$.${column}')) END`
  const startedAt = asOfState('started_at', 'MIN')
  const lastSeenAt = asOfState('last_seen_at', 'MAX')
  const where: string[] = []
  const params: unknown[] = []
  for (const [name, text] of Object.entries(ctx.filters.echo)) {
    if (name === 'campaign_prefix') { where.push(`substr(${sessionTouchAsOf('campaign', null)}, 1, length(?)) = ?`); params.push(text, text); continue }
    if (name === 'path_prefix') { where.push(`(json_extract(s.payload_json, '$.landing_path') = ? OR json_extract(s.payload_json, '$.landing_path') LIKE ? ESCAPE '\\')`); params.push(text.replace(/\/$/, '') || '/', `${text.replace(/[\\%_]/g, '\\$&')}%`); continue }
    where.push(name === 'session_id' ? 's.key = ?' : name === 'visitor_id' ? `json_extract(s.payload_json, '$.visitor_id') = ?` : `${sessionTouchAsOf(ATTRIBUTION_FIELDS[name as AttributionField], null)} = ?`)
    params.push(text)
  }
  const base = bindWindow(`s.organization_id = ? AND s.kind = 'session' AND s.date = '' AND s.created_at <= @asof
    AND ${startedAt} < @end AND ${lastSeenAt} >= @start${where.length ? ` AND ${where.join(' AND ')}` : ''}`, ctx)
  const baseParams = [input.organizationId, ...params]
  const keyset = ctx.cursorKey ? `AND (${startedAt}, s.key) < (?, ?)` : ''
  const rows = await queryAll<Record<string, unknown>>(db, bindWindow(`SELECT s.key AS session_id, s.created_at, s.payload_json,
      ${startedAt} AS started_at_asof, ${lastSeenAt} AS last_seen_at_asof,
      ${['source', 'medium', 'campaign', 'content', 'term', 'referrerHost', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid'].map(key => `${sessionTouchAsOf(key, null)} AS t_${key}`).join(', ')},
      (SELECT COUNT(*) FROM analytics_events e WHERE e.organization_id = s.organization_id AND e.session_id = s.key AND e.received_at <= @asof) AS events,
      (SELECT COALESCE(SUM(e.kind = 'pageview'), 0) FROM analytics_events e WHERE e.organization_id = s.organization_id AND e.session_id = s.key AND e.received_at <= @asof) AS page_views
    FROM analytics_summaries s WHERE ${base} ${keyset}
    ORDER BY started_at_asof DESC, s.key DESC LIMIT ?`, ctx), [...baseParams, ...(ctx.cursorKey ?? []), ctx.limit + 1])
  const page = rows.slice(0, ctx.limit)
  const last = page.at(-1)
  const totalRow = await queryFirst<Record<string, unknown>>(db, `SELECT COUNT(*) AS sessions, COUNT(DISTINCT json_extract(s.payload_json, '$.visitor_id')) AS visitors FROM analytics_summaries s WHERE ${base}`, baseParams)
  return {
    rows: page.map((row) => {
      const body = j(row.payload_json) as Record<string, unknown>
      return {
        session_id: row.session_id, visitor_id: body.visitor_id, started_at: row.started_at_asof, last_seen_at: row.last_seen_at_asof,
        duration_seconds: body.duration_seconds, landing_path: body.landing_path,
        // Derived view: the session's last touch as of the query boundary. Each event keeps the attribution it had.
        last_touch: { attribution: { source: row.t_source, medium: row.t_medium, campaign: row.t_campaign, term: row.t_term, content: row.t_content, referrerHost: row.t_referrerHost,
          gclid: row.t_gclid, gbraid: row.t_gbraid, wbraid: row.t_wbraid, fbclid: row.t_fbclid, msclkid: row.t_msclkid }, as_of: ctx.asOf, derived: true },
        events: Number(row.events), page_views: Number(row.page_views),
      }
    }),
    nextKey: rows.length > ctx.limit && last ? [last.started_at_asof, last.session_id] : null,
    totals: {
      sessions: { value: Number(totalRow?.sessions ?? 0), unit: 'sessions with any activity in the range' },
      visitors: { value: Number(totalRow?.visitors ?? 0), unit: 'distinct visitors (exact, not summed)' },
    } as AnalyticsQueryResult['totals'],
  }
}

/** A metric's SQL with the query window bound, and the parameters its `@outcome` placeholders take. */
const metricSql = (name: string, ctx: { start: string; end: string; asOf: string; outcomeEvent?: string }) => {
  const sql = METRICS[name]!.sql
  return { sql: bindWindow(sql, ctx).replaceAll('@outcome', '?'), params: Array(sql.split('@outcome').length - 1).fill(ctx.outcomeEvent) as unknown[] }
}

interface SummaryFilters { kind: 'organization_day' | 'page_day' | 'dimension_day'; dimension?: string; value?: string; pathPrefix?: string; echo: Record<string, string> }

const SUMMARY_KINDS = ['organization_day', 'page_day', 'dimension_day'] as const
const SUMMARY_DIMENSIONS = ['country', 'city', 'device', 'referrer'] as const

function resolveSummaryFilters(input: AnalyticsQueryInput): SummaryFilters {
  if (input.dimensions || input.metrics || input.attributionBasis) invalid('daily_summaries takes summary_kind, dimension, value and path_prefix filters only.')
  const raw = input.filters ?? {}
  for (const name of Object.keys(raw)) if (!['summary_kind', 'dimension', 'value', 'path_prefix'].includes(name)) invalid(`Filter "${name}" does not apply to daily_summaries. Supported: summary_kind, dimension, value, path_prefix.`)
  const text = (name: string) => raw[name] === undefined ? undefined : typeof raw[name] === 'string' && (raw[name] as string).length > 0 && (raw[name] as string).length <= 512 ? raw[name] as string : invalid(`Filter "${name}" must be a non-empty string of at most 512 characters.`)
  const kind = text('summary_kind') ?? invalid(`daily_summaries requires filters.summary_kind: ${SUMMARY_KINDS.join(', ')}.`)
  if (!(SUMMARY_KINDS as readonly string[]).includes(kind)) invalid(`summary_kind must be one of: ${SUMMARY_KINDS.join(', ')}.`)
  const dimension = text('dimension'); const value = text('value'); const pathPrefix = text('path_prefix')
  if (dimension && !(SUMMARY_DIMENSIONS as readonly string[]).includes(dimension)) invalid(`dimension must be one of: ${SUMMARY_DIMENSIONS.join(', ')}.`)
  if (kind !== 'dimension_day' && (dimension || value)) invalid('dimension and value apply to summary_kind dimension_day only.')
  if (value && !dimension) invalid('value requires dimension.')
  if (kind !== 'page_day' && pathPrefix) invalid('path_prefix applies to summary_kind page_day only.')
  if (pathPrefix && !pathPrefix.startsWith('/')) invalid('path_prefix must start with "/".')
  return { kind: kind as SummaryFilters['kind'], dimension, value, pathPrefix, echo: Object.fromEntries(Object.entries({ summary_kind: kind, dimension, value, path_prefix: pathPrefix }).filter(([, v]) => v !== undefined)) as Record<string, string> }
}

const SUMMARY_METRICS = {
  organization_day: { page_views: 'page views that day', unique_sessions: 'distinct sessions that day', unique_visitors: 'distinct visitors that day', returning_visitors: 'distinct visitors with an earlier session', avg_session_duration: 'average session duration in seconds', pages_per_session: 'page views per session' },
  page_day: { page_views: 'page views of the path that day' },
  dimension_day: { page_views: 'page views in the dimension value that day' },
} as const

/**
 * The daily summaries, complete and paginated at their stored grain: one row per day
 * (organization_day), per day and page path (page_day) or per day and dimension value
 * (dimension_day). Nothing is reconstructed into events, and distinct counts are those the summary
 * stored for its own grain, not sums of other rows. A summary rewritten after `as_of` makes the
 * cursor stale, since the rows it would continue through are no longer the ones it started over.
 */
async function summariesMode(db: DbClient, input: AnalyticsQueryInput, ctx: ModeContext, summary: SummaryFilters, days: { startDate: string; endDate: string }) {
  const direction = input.sort === 'occurred_at_asc' ? 'asc' : (input.sort === undefined || input.sort === 'occurred_at_desc') ? 'desc' : invalid('sort for daily_summaries must be occurred_at_desc or occurred_at_asc (by day).')
  ctx.resolved.sort = `date_${direction}`
  const where = ['organization_id = ?', 'kind = ?', 'date >= ?', 'date <= ?']
  const params: unknown[] = [input.organizationId, summary.kind, days.startDate, days.endDate]
  if (summary.dimension) { where.push(`key ->> '$[0]' = ?`); params.push(summary.dimension) }
  if (summary.value) { where.push(`key ->> '$[1]' = ?`); params.push(summary.value) }
  if (summary.pathPrefix) { where.push(`(key = ? OR key LIKE ? ESCAPE '\\')`); params.push(summary.pathPrefix.replace(/\/$/, '') || '/', `${summary.pathPrefix.replace(/[\\%_]/g, '\\$&')}%`) }
  const filtered = where.join(' AND ')
  if (ctx.cursorKey) {
    const changed = await queryFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM analytics_summaries WHERE ${filtered} AND updated_at > ?`, [...params, ctx.asOf])
    if (Number(changed?.n ?? 0) > 0) invalid('The daily summaries in this range were rewritten after the first page was read. Read the first page again.')
  }
  const keyset = ctx.cursorKey ? `AND (date ${direction === 'desc' ? '<' : '>'} ? OR (date = ? AND key > ?))` : ''
  const cursor = ctx.cursorKey ? [ctx.cursorKey[0], ctx.cursorKey[0], ctx.cursorKey[1]] : []
  const rows = await queryAll<{ date: string; key: string; payload_json: string; updated_at: string }>(db, `SELECT date, key, payload_json, updated_at FROM analytics_summaries
    WHERE ${filtered} ${keyset} ORDER BY date ${direction.toUpperCase()}, key ASC LIMIT ?`, [...params, ...cursor, ctx.limit + 1])
  const page = rows.slice(0, ctx.limit)
  const last = page.at(-1)
  const totalRow = await queryFirst<Record<string, unknown>>(db, `SELECT COUNT(*) AS summary_rows, COUNT(DISTINCT date) AS days, COALESCE(SUM(json_extract(payload_json, '$.page_views')), 0) AS page_views FROM analytics_summaries WHERE ${filtered}`, params)
  const summarizedDays = await queryFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM analytics_summaries WHERE organization_id = ? AND kind = 'organization_day' AND date >= ? AND date <= ?`, [input.organizationId, days.startDate, days.endDate])
  const daysInRange = Math.round((Date.parse(`${days.endDate}T00:00:00Z`) - Date.parse(`${days.startDate}T00:00:00Z`)) / 86_400_000) + 1
  const totals: AnalyticsQueryResult['totals'] = {
    summary_rows: { value: Number(totalRow?.summary_rows ?? 0), unit: 'summary rows matching the filters' },
    days_with_rows: { value: Number(totalRow?.days ?? 0), unit: 'days that have a matching row' },
  }
  // Page views add up exactly when the rows partition the views: one row kind of days or pages, or one dimension.
  if (summary.kind !== 'dimension_day' || summary.dimension) totals.page_views = { value: Number(totalRow?.page_views ?? 0), unit: 'page views (sum of the matching rows)' }
  return {
    rows: page.map((row) => {
      const body = j(row.payload_json) as Record<string, unknown>
      const identity = summary.kind === 'page_day' ? { page_path: row.key }
        : summary.kind === 'dimension_day' ? (() => { const [dimension, value, subvalue] = JSON.parse(row.key) as string[]; return { dimension, value, subvalue } })() : {}
      return { date: row.date, summary_kind: summary.kind, ...identity, metrics: body, summarized_at: row.updated_at }
    }),
    nextKey: rows.length > ctx.limit && last ? [last.date, last.key] : null,
    totals,
    source: {
      table: 'analytics_summaries', summary_kind: summary.kind, grain: summary.kind === 'organization_day' ? 'day' : summary.kind === 'page_day' ? 'day and public page path' : 'day and dimension value (country, city, device or referrer)',
      supported_metrics: SUMMARY_METRICS[summary.kind], derived_from: 'pageview events aggregated per local day; a derived view of the native events, not the events themselves',
      days_in_range: daysInRange, days_summarized: Number(summarizedDays?.n ?? 0),
      note: 'Days without an organization_day summary have not been aggregated (the current day, or a day the aggregation has not reached); their pageviews are in events and breakdown.',
    },
  }
}

async function totalsFor(db: DbClient, organizationId: string, ctx: ModeContext & { basis: AttributionBasis }, names: string[], outcomeEvent?: string): Promise<AnalyticsQueryResult['totals']> {
  const where = populationWhere(ctx)
  const bound = names.map(name => metricSql(name, { ...ctx, outcomeEvent }))
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT ${names.map((name, index) => `${bound[index]!.sql} AS "${name}"`).join(', ')} FROM ${FROM(ctx.filters.needsSession)} WHERE ${where.sql}`,
    [...bound.flatMap(item => item.params), ...where.params(organizationId)])
  const totals: AnalyticsQueryResult['totals'] = {}
  for (const name of names) totals[name] = { value: row?.[name] === null || row?.[name] === undefined ? null : Number(row[name]), unit: `${METRICS[name]!.unit}${['sessions', 'visitors'].includes(name) ? ' (exact over the whole filtered population, not summed)' : ''}` }
  return totals
}

async function breakdownMode(db: DbClient, input: AnalyticsQueryInput, ctx: ModeContext & { basis: AttributionBasis; outcomeEvent?: string }) {
  const dimensions = input.dimensions ?? invalid('breakdown requires dimensions.')
  const metrics = input.metrics ?? invalid('breakdown requires metrics.')
  if (dimensions.length === 0 || dimensions.length > 6) invalid('dimensions must list between 1 and 6 fields.')
  if (new Set(dimensions).size !== dimensions.length) invalid('dimensions must not repeat a field.')
  for (const name of dimensions) if (!(name in EVENT_FIELDS)) invalid(`Unknown dimension "${name}". Supported: ${Object.keys(EVENT_FIELDS).join(', ')}.`)
  if (metrics.length === 0 || metrics.length > 8 || new Set(metrics).size !== metrics.length) invalid('metrics must list between 1 and 8 distinct metrics.')
  for (const name of metrics) if (!(name in METRICS)) invalid(`Unknown metric "${name}". Supported: ${Object.keys(METRICS).join(', ')}.`)
  const needsOutcome = metrics.filter(name => METRICS[name]!.needsOutcome)
  if (needsOutcome.length > 0 && !ctx.outcomeEvent) invalid(`${needsOutcome.join(' and ')} require outcome_event: the selected outcome, the population is sessions with a pageview in each group.`)
  if (needsOutcome.length > 0) {
    // The rate is over sessions with a pageview. Filters or dimensions that only outcome events carry would empty
    // that population, so the request cannot mean what it says and is rejected instead of answered.
    const eventOnly = new Set(['stage', 'surface', 'entity_type', 'entity_id', 'currency', 'value_basis', 'conversion_type', 'actor_id', 'ga4_delivery_status'])
    for (const name of [...Object.keys(ctx.filters.echo), ...dimensions]) if (eventOnly.has(name)) invalid(`${needsOutcome.join(' and ')} measure sessions with a pageview; "${name}" only outcome events carry. Choose the outcome with outcome_event and filter the pageview population.`)
    for (const name of ['kind', 'event_name']) if (ctx.filters.echo[name] && ctx.filters.echo[name] !== 'pageview') invalid(`${needsOutcome.join(' and ')} measure sessions with a pageview: ${name} must be pageview or omitted; choose the outcome with outcome_event.`)
    if (dimensions.some(name => name === 'kind' || name === 'event_name')) invalid(`${needsOutcome.join(' and ')} cannot be grouped by kind or event_name; the population is pageviews.`)
  }
  const monetary = metrics.filter(name => METRICS[name]!.monetary)
  if (monetary.length > 0 && !dimensions.includes('currency')) invalid(`${monetary.join(', ')} are amounts: group by the currency dimension so currencies are never added together.`)
  if (dimensions.some(name => name in ATTRIBUTION_FIELDS) && ctx.basis === 'session_last_touch') ctx.filters.needsSession = true

  const sort = typeof input.sort === 'object' && input.sort ? input.sort : { metric: metrics[0], direction: 'desc' as const }
  const sortMetric = sort.metric ?? metrics[0]!
  if (!metrics.includes(sortMetric)) invalid('sort.metric must be one of the requested metrics.')
  const direction = sort.direction === 'asc' ? 'asc' : 'desc'
  ctx.resolved.sort = { metric: sortMetric, direction }
  ctx.resolved.dimensions = dimensions
  ctx.resolved.metrics = metrics
  if (ctx.outcomeEvent) ctx.resolved.outcome_event = ctx.outcomeEvent

  const where = populationWhere(ctx)
  const dimSql = dimensions.map(name => bindWindow(EVENT_FIELDS[name]!.sql(ctx.basis), ctx))
  const boundMetrics = metrics.map(name => metricSql(name, ctx))
  const select = [
    ...dimSql.map((sql, index) => `${sql} AS d${index}, (${sql}) IS NULL AS n${index}, COALESCE(${sql}, '') AS v${index}`),
    ...metrics.map((name, index) => `${boundMetrics[index]!.sql} AS "m_${name}"`),
  ].join(', ')
  const selectParams = boundMetrics.flatMap(item => item.params)
  const sortValue = `COALESCE("m_${sortMetric}", -1)`
  const keyColumns = dimensions.flatMap((_, index) => [`n${index}`, `v${index}`])
  const op = direction === 'desc' ? '<' : '>'
  const keyset = ctx.cursorKey ? `WHERE (${sortValue} ${op} ? OR (${sortValue} = ? AND (${keyColumns.join(', ')}) > (${keyColumns.map(() => '?').join(', ')})))` : ''
  const cursorParams = ctx.cursorKey ? [ctx.cursorKey[0], ctx.cursorKey[0], ...ctx.cursorKey.slice(1)] : []
  const sql = `WITH g AS (SELECT ${select} FROM ${FROM(ctx.filters.needsSession)} WHERE ${where.sql} GROUP BY ${dimSql.map((_, index) => `d${index}`).join(', ')})
    SELECT *, ${sortValue} AS sortv FROM g ${keyset} ORDER BY sortv ${direction.toUpperCase()}, ${keyColumns.map(column => `${column} ASC`).join(', ')} LIMIT ?`
  const rows = await queryAll<Record<string, unknown>>(db, sql, [...selectParams, ...where.params(input.organizationId), ...cursorParams, ctx.limit + 1])
  const page = rows.slice(0, ctx.limit)
  const last = page.at(-1)
  const groupCount = await queryFirst<{ groups: number }>(db, `SELECT COUNT(*) AS groups FROM (SELECT 1 FROM ${FROM(ctx.filters.needsSession)} WHERE ${where.sql} GROUP BY ${dimSql.join(', ')})`, where.params(input.organizationId))

  // Totals describe the whole filtered population at its own grain: distinct sessions and visitors are
  // counted once over all of it, never summed from the groups. Amounts are reported per currency.
  const plain = metrics.filter(name => !METRICS[name]!.monetary)
  const totals = plain.length > 0 ? await totalsFor(db, input.organizationId, ctx, plain, ctx.outcomeEvent) : {}
  totals.groups = { value: Number(groupCount?.groups ?? 0), unit: 'groups in the whole filtered population' }
  if (monetary.length > 0) {
    const perCurrency = await queryAll<Record<string, unknown>>(db, `SELECT ${payload('$.value.currency')} AS currency, ${monetary.map(name => `${metricSql(name, ctx).sql} AS "${name}"`).join(', ')}
      FROM ${FROM(ctx.filters.needsSession)} WHERE ${where.sql} AND ${payload('$.value.currency')} IS NOT NULL GROUP BY 1 ORDER BY 1`, where.params(input.organizationId))
    totals.by_currency = perCurrency.map(row => ({ currency: row.currency, ...Object.fromEntries(monetary.map(name => [name, Number(row[name])])), unit: 'minor units of the currency' }))
  }
  return {
    rows: page.map(row => ({
      dimensions: Object.fromEntries(dimensions.map((name, index) => [name, row[`d${index}`] ?? null])),
      metrics: Object.fromEntries(metrics.map(name => [name, row[`m_${name}`] === null ? null : Number(row[`m_${name}`])])),
    })),
    nextKey: rows.length > ctx.limit && last ? [last.sortv, ...keyColumns.map(column => last[column])] : null,
    totals,
  }
}

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

async function coverageFor(db: DbClient, organizationId: string, ctx: { start: string; end: string; now: Date; analyticsDataStartAt: string | null; filters: ResolvedFilters; basis: AttributionBasis }): Promise<Record<string, unknown>> {
  const first = await queryFirst<Record<string, unknown>>(db, `SELECT
      MIN(CASE WHEN json_type(payload_json, '$.observed') IS NOT NULL THEN created_at END) AS observed_from,
      MIN(CASE WHEN json_type(payload_json, '$.source_path') IS NOT NULL THEN created_at END) AS page_identity_from,
      MIN(CASE WHEN json_type(payload_json, '$.attribution_basis') IS NOT NULL THEN created_at END) AS snapshot_from,
      MIN(CASE WHEN kind = 'pageview' THEN created_at END) AS oldest_pageview,
      MIN(CASE WHEN kind IN ('conversion', 'interaction') THEN created_at END) AS oldest_outcome
    FROM analytics_events WHERE organization_id = ?`, [organizationId])
  const missing = await queryFirst<Record<string, unknown>>(db, `SELECT COUNT(*) AS total,
      COALESCE(SUM(json_type(e.payload_json, '$.observed') IS NULL), 0) AS observed,
      COALESCE(SUM(json_type(e.payload_json, '$.attribution_basis') IS NULL), 0) AS snapshot,
      COALESCE(SUM(e.kind = 'pageview' AND json_type(e.payload_json, '$.source_path') IS NULL), 0) AS page_identity,
      COALESCE(SUM(e.kind = 'pageview'), 0) AS pageviews
    FROM analytics_events e WHERE e.organization_id = ? AND e.created_at >= ? AND e.created_at < ?`, [organizationId, ctx.start, ctx.end])
  return {
    // Native events are never expired: the history is everything KrabiClaw has collected for the organization.
    event_history: {
      oldest_pageview_at: first?.oldest_pageview ?? null,
      oldest_outcome_or_interaction_at: first?.oldest_outcome ?? null,
    },
    summaries: { note: 'Daily summaries are derived from native events for faster reporting; they add nothing the events do not hold and are not a substitute for them.' },
    requested_range: { start: ctx.start, end: ctx.end, analytics_data_start_at: ctx.analyticsDataStartAt },
    instrumentation: {
      observed_attribution_recorded_from: first?.observed_from ?? null,
      page_identity_recorded_from: first?.page_identity_from ?? null,
      event_attribution_snapshot_recorded_from: first?.snapshot_from ?? null,
      note: 'Events recorded before these dates carry no per-event observations or snapshots; they are reported with the missing fact named, never reconstructed from current session state.',
    },
    missing_dimensions: [
      { dimension: 'observed_attribution', events_missing: Number(missing?.observed ?? 0), events_in_range: Number(missing?.total ?? 0) },
      { dimension: 'event_attribution_snapshot', events_missing: Number(missing?.snapshot ?? 0), events_in_range: Number(missing?.total ?? 0) },
      { dimension: 'page_identity', events_missing: Number(missing?.page_identity ?? 0), events_in_range: Number(missing?.pageviews ?? 0), applies_to: 'pageview events' },
    ],
    filtered: Object.keys(ctx.filters.echo).length > 0,
  }
}
