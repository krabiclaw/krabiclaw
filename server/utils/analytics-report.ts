import { z } from 'zod'
import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { enumerateLocalDates, localDateBounds, parseAnalyticsRange } from '~/server/utils/analytics-calendar'
import { addLocalDays, localDateAt } from '~/utils/timezone'
import { CONVERSION_EVENT_CATALOG, ORGANIZATION_CONVERSION_EVENT_NAMES, type ConversionEventDefinition, type FunnelStep } from '~/utils/organization-conversion-events'
import { ATTRIBUTION_CHANNELS, attributionChannel, type AttributionChannel } from '~/utils/analytics-attribution'
import { readIntegration } from './organization-integrations'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { getGoogleAdsPerformanceSummary } from './google-ads'

import { analyticsReportSchema, dashboardAnalyticsReportSchema, type AnalyticsReport, type DashboardAnalyticsReport } from '~/shared/analytics-report'
export type { AnalyticsReport } from '~/shared/analytics-report'

export interface OrganizationAnalyticsContext {
  organizationId: string
  timezone: string
  analyticsDataStartAt: string | null
}

interface DailySlice {
  date: string
  pageViews: number
  sessions: number
  visitors: number
  returningVisitors: number
  avgDuration: number
  pagesPerSession: number
  pages: Array<{ value: string; views: number }>
  dimensions: Array<{ dimension: string; value: string; subvalue: string; views: number }>
}

const n = (value: unknown) => Number(value || 0)
const text = (value: unknown) => value ? String(value) : null

const rate = (count: number, of: number) => of ? Math.round(count / of * 10_000) / 100 : null

const eventList = (predicate: (definition: typeof CONVERSION_EVENT_CATALOG[keyof typeof CONVERSION_EVENT_CATALOG]) => boolean) =>
  ORGANIZATION_CONVERSION_EVENT_NAMES.filter(name => predicate(CONVERSION_EVENT_CATALOG[name])).map(name => `'${name}'`).join(', ')
const OUTCOME_EVENT_NAMES = new Set<string>(ORGANIZATION_CONVERSION_EVENT_NAMES.filter(name => CONVERSION_EVENT_CATALOG[name].outcome))
const OUTCOME_EVENT_SQL_LIST = eventList(definition => definition.outcome)
const SERVER_DELIVERED_EVENT_SQL_LIST = eventList(definition => definition.ga4 !== null && definition.ga4Sender !== 'browser')

export async function resolveOrganizationAnalyticsContext(db: DbClient, organizationId: string): Promise<OrganizationAnalyticsContext> {
  const row = await queryFirst<{ organization_id: string; analytics_data_start_at: string | null; timezone: string }>(db, `
    SELECT s.id AS organization_id, s.analytics_data_start_at, s.timezone
    FROM organization s
    WHERE s.id = ? LIMIT 1
  `, [organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return {
    organizationId: row.organization_id,
    timezone: row.timezone,
    analyticsDataStartAt: row.analytics_data_start_at,
  }
}

// Events are the complete record, including visits collected before session
// summaries existed. A summary contributes last-touch context, never eligibility.
const sessionFactsSql = (organization: string, candidates: string) => `SELECT e.organization_id, e.session_id, e.visitor_id,
  MIN(e.created_at) started_at, MAX(e.created_at) last_seen_at,
  SUM(e.duration_seconds) duration_seconds,
  COALESCE(s.payload_json ->> '$.attribution.source', 'Attribution not recorded') source,
  COALESCE(s.payload_json ->> '$.attribution.medium', '(not recorded)') medium,
  (s.payload_json ->> '$.attribution.campaign') campaign,
  (s.payload_json ->> '$.attribution.content') content
  FROM analytics_events e LEFT JOIN analytics_summaries s ON s.organization_id = e.organization_id
    AND s.kind = 'session' AND s.date = '' AND s.key = e.session_id
  WHERE e.organization_id = ${organization} AND e.kind = 'pageview' AND e.session_id IN (${candidates})
  GROUP BY e.organization_id, e.session_id`

// `views` is materialized: inlined, the planner folded it into the
// returning-visitor subquery and scanned every organization's pageviews on every
// date for each session, 12M rows for one day of one tenant. The session
// candidates' earlier-pageview check is pinned to the session index: on its
// created_at index it read every earlier pageview per candidate, 16.7M rows and
// 11s for one unsummarized day of the platform tenant (#1278).
const daySummariesSql = `WITH input AS (SELECT ? organization_id, ? starts_at, ? ends_at),
  views AS MATERIALIZED (
    SELECT e.*, (payload_json ->> '$.country') country,
      (payload_json ->> '$.region') region, (payload_json ->> '$.city') city,
      (payload_json ->> '$.user_agent') user_agent, (payload_json ->> '$.referrer') referrer
    FROM analytics_events e JOIN input i ON e.organization_id = i.organization_id
    WHERE e.kind = 'pageview' AND e.created_at >= i.starts_at AND e.created_at < i.ends_at
  ), session_candidates AS MATERIALIZED (
    SELECT DISTINCT candidate.session_id FROM analytics_events candidate JOIN input i ON candidate.organization_id = i.organization_id
    WHERE candidate.kind = 'pageview' AND candidate.created_at >= i.starts_at
      AND EXISTS (SELECT 1 FROM analytics_events previous INDEXED BY analytics_events_org_session_idx WHERE previous.organization_id = candidate.organization_id
        AND previous.kind = 'pageview' AND previous.session_id = candidate.session_id AND previous.created_at < i.ends_at)
  ), sessions AS (${sessionFactsSql('(SELECT organization_id FROM input)', 'SELECT session_id FROM session_candidates')}),
  metrics AS (SELECT COUNT(*) page_views, COUNT(DISTINCT session_id) unique_sessions,
    COUNT(DISTINCT visitor_id) unique_visitors FROM views),
  dimensions AS (
    SELECT 'country' dimension, CASE WHEN country GLOB '[A-Za-z][A-Za-z]' THEN upper(country) ELSE 'XX' END value, '' subvalue FROM views
    UNION ALL SELECT 'city', COALESCE(NULLIF(city, ''), 'Unknown'),
      COALESCE(region, '') || '|' || CASE WHEN country GLOB '[A-Za-z][A-Za-z]' THEN upper(country) ELSE 'XX' END FROM views
    UNION ALL SELECT 'device', CASE
      WHEN lower(user_agent) LIKE '%ipad%' OR lower(user_agent) LIKE '%tablet%' THEN 'Tablet'
      WHEN lower(user_agent) LIKE '%mobile%' OR lower(user_agent) LIKE '%android%' THEN 'Mobile'
      WHEN user_agent IS NULL OR user_agent = '' THEN 'Unknown' ELSE 'Desktop' END, '' FROM views
    UNION ALL SELECT 'referrer', CASE
      WHEN v.referrer IS NULL OR v.referrer = '' THEN 'Direct'
      WHEN EXISTS (SELECT 1 FROM organization_domains d WHERE d.organization_id = v.organization_id AND d.status = 'active' AND lower(d.domain) = lower(v.referrer)) THEN 'Internal'
      ELSE lower(v.referrer) END, '' FROM views v
  )
  SELECT 'organization_day' kind, '' key, json_object(
    'page_views', page_views, 'unique_sessions', unique_sessions, 'unique_visitors', unique_visitors,
    'returning_visitors', (SELECT COUNT(DISTINCT current.visitor_id) FROM views current WHERE EXISTS (
      SELECT 1 FROM analytics_events previous INDEXED BY analytics_events_org_visitor_idx WHERE previous.organization_id = current.organization_id
        AND previous.kind = 'pageview' AND previous.visitor_id = current.visitor_id
        AND previous.session_id <> current.session_id AND previous.created_at < (SELECT starts_at FROM input))),
    'avg_session_duration', COALESCE((SELECT ROUND(AVG(duration_seconds)) FROM sessions
      WHERE started_at < (SELECT ends_at FROM input) AND last_seen_at >= (SELECT starts_at FROM input) AND duration_seconds > 0), 0),
    'pages_per_session', CASE WHEN unique_sessions = 0 THEN 0 ELSE ROUND(CAST(page_views AS REAL) / unique_sessions, 2) END
  ) payload_json FROM metrics
  UNION ALL SELECT 'page_day', page_path, json_object('page_views', COUNT(*)) FROM views GROUP BY page_path
  UNION ALL SELECT 'dimension_day', json_array(dimension, value, subvalue), json_object('page_views', COUNT(*))
    FROM dimensions GROUP BY dimension, value, subvalue`

interface AnalyticsSummaryRow {
  kind: 'organization_day' | 'page_day' | 'dimension_day'
  date: string
  key: string
  payload_json: string
}

const dayMetricsSchema = z.object({
  page_views: z.number().nonnegative(), unique_sessions: z.number().nonnegative(),
  unique_visitors: z.number().nonnegative(), returning_visitors: z.number().nonnegative(),
  avg_session_duration: z.number().nonnegative(), pages_per_session: z.number().nonnegative(),
})
const viewCountSchema = z.object({ page_views: z.number().nonnegative() })
const dimensionKeySchema = z.tuple([z.enum(['country', 'city', 'device', 'referrer']), z.string(), z.string()])

function dailySlice(date: string, rows: Omit<AnalyticsSummaryRow, 'date'>[]): DailySlice {
  const summary = rows.find(row => row.kind === 'organization_day')
  if (!summary) throw new Error(`Analytics day summary missing: ${date}`)
  const metrics = dayMetricsSchema.parse(JSON.parse(summary.payload_json))
  return {
    date, pageViews: metrics.page_views, sessions: metrics.unique_sessions, visitors: metrics.unique_visitors,
    returningVisitors: metrics.returning_visitors, avgDuration: metrics.avg_session_duration, pagesPerSession: metrics.pages_per_session,
    pages: rows.filter(row => row.kind === 'page_day').map(row => ({ value: row.key, views: viewCountSchema.parse(JSON.parse(row.payload_json)).page_views })),
    dimensions: rows.filter(row => row.kind === 'dimension_day').map(row => {
      const [dimension, value, subvalue] = dimensionKeySchema.parse(JSON.parse(row.key))
      return { dimension, value, subvalue, views: viewCountSchema.parse(JSON.parse(row.payload_json)).page_views }
    }),
  }
}

export async function aggregateOrganizationAnalyticsDate(db: DbClient, organizationId: string, date: string): Promise<void> {
  const context = await resolveOrganizationAnalyticsContext(db, organizationId)
  const { start, end } = localDateBounds(date, context.timezone)
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: "DELETE FROM analytics_summaries WHERE organization_id = ? AND date = ? AND kind IN ('page_day', 'dimension_day')", params: [organizationId, date] },
    {
      query: `INSERT INTO analytics_summaries (id, kind, organization_id, date, key, payload_json, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), kind, ?, ?, key, payload_json, ?, ? FROM (${daySummariesSql}) WHERE true
        ON CONFLICT(organization_id, kind, date, key) DO UPDATE SET organization_id = excluded.organization_id,
          payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      params: [context.organizationId, date, now, now, organizationId, start, end],
    },
  ], { operation: `aggregate analytics for ${organizationId} ${date}` })
}

type Row = Record<string, unknown>
const read = (query: string, params: unknown[]): BatchQuery => ({ query, params })

interface ConversionReportWindow { start: string; end: string; observedEnd: string; dates: string[]; timezone: string }

// Signups in the window; outcomes that follow them are linked through the originating owner
// recorded on the onboarding and purchase events, never through current membership.
const signupsSql = `WITH signups AS (
      SELECT e.created_at signed_at, (e.payload_json ->> '$.entity_id') user_id, (e.payload_json ->> '$.attribution.source') source, (e.payload_json ->> '$.attribution.medium') medium,
        (e.payload_json ->> '$.attribution.campaign') campaign, (e.payload_json ->> '$.attribution.content') content
      FROM analytics_events e WHERE e.kind = 'conversion' AND e.organization_id = ? AND (e.payload_json ->> '$.event_name') = 'sign_up' AND e.created_at >= ? AND e.created_at < ?)`
const followedBy = (alias: string, eventFilter: string) => `EXISTS (SELECT 1 FROM analytics_events ${alias} WHERE ${alias}.kind = 'conversion' AND ${alias}.organization_id = ?
    AND ${eventFilter} AND (${alias}.payload_json ->> '$.metadata.originating_user_id') = signups.user_id AND ${alias}.created_at >= signups.signed_at AND ${alias}.created_at < ?)`

/** The signup cohort by its signup attribution. */
function signupCohortRead(organizationId: string, { start, end, observedEnd }: ConversionReportWindow) {
  return read(`${signupsSql}
      SELECT source, medium, campaign, content, COUNT(*) signups,
        SUM(${followedBy('o', "(o.payload_json ->> '$.event_name') = 'onboarding_complete'")}) onboarded,
        SUM(${followedBy('p', "(p.payload_json ->> '$.event_name') = 'purchase' AND (p.payload_json ->> '$.metadata.purchase_type') = 'initial_subscription'")}) first_paid
      FROM signups GROUP BY 1,2,3,4 ORDER BY signups DESC`, [organizationId, start, end, organizationId, observedEnd, organizationId, observedEnd])
}

/** The conversion detail only the MCP report returns, in the order composeConversionDetail reads it. */
function conversionDetailReads(organizationId: string, window: ConversionReportWindow): BatchQuery[] {
  const { start, end, observedEnd } = window
  const inRange = `kind IN ('conversion', 'interaction') AND organization_id = ? AND created_at >= ? AND created_at < ?`
  const eventName = `(payload_json ->> '$.event_name')`
  // Calendar dates and their UTC boundaries are produced by the validated range
  // and timezone helpers. Bucket in SQL without assuming a fixed UTC offset.
  const localDay = `CASE ${window.dates.map(date => `WHEN created_at < '${localDateBounds(addLocalDays(date, 1), window.timezone).start}' THEN '${date}'`).join(' ')} END`
  const snapshot = `(payload_json ->> '$.attribution.source') source, (payload_json ->> '$.attribution.medium') medium,
    (payload_json ->> '$.attribution.campaign') campaign, (payload_json ->> '$.attribution.content') content`
  return [
    read(`SELECT ${localDay} date, COUNT(*) events
      FROM analytics_events WHERE ${inRange} AND ${eventName} IN (${OUTCOME_EVENT_SQL_LIST}) GROUP BY 1`, [organizationId, start, end]),
    read(`SELECT ${eventName} event_name, (payload_json ->> '$.stage') stage, (payload_json ->> '$.conversion_type') conversion_type,
        COUNT(*) events, COUNT(DISTINCT CASE WHEN (payload_json ->> '$.entity_id') IS NOT NULL THEN (payload_json ->> '$.entity_type') || ':' || (payload_json ->> '$.entity_id') END) entities, COUNT(DISTINCT session_id) sessions, SUM(session_id IS NULL) nonbrowser
      FROM analytics_events WHERE ${inRange} GROUP BY 1,2,3 ORDER BY events DESC, event_name`, [organizationId, start, end]),
    read(`SELECT ${snapshot}, ${eventName} event_name, COUNT(*) events, COUNT(DISTINCT CASE WHEN (payload_json ->> '$.entity_id') IS NOT NULL THEN (payload_json ->> '$.entity_type') || ':' || (payload_json ->> '$.entity_id') END) entities
      FROM analytics_events WHERE ${inRange} AND json_type(payload_json, '$.attribution.source') IS 'text' AND ${eventName} IN (${OUTCOME_EVENT_SQL_LIST}) GROUP BY 1,2,3,4,5`, [organizationId, start, end]),
    read(`SELECT ${eventName} event_name, (payload_json ->> '$.value.basis') basis, (payload_json ->> '$.value.currency') currency,
        COUNT(*) events, SUM(payload_json ->> '$.value.amount_minor') value_minor, SUM(payload_json ->> '$.value.collected_minor') collected_minor, COUNT(payload_json ->> '$.value.collected_minor') collected_events
      FROM analytics_events WHERE ${inRange} AND json_type(payload_json, '$.value.amount_minor') IS 'integer'
      GROUP BY 1,2,3 ORDER BY event_name, currency`, [organizationId, start, end]),
    read(`SELECT ${snapshot}, (payload_json ->> '$.value.currency') currency,
        SUM(${eventName} = 'purchase') purchases,
        COALESCE(SUM(CASE WHEN ${eventName} = 'purchase' THEN payload_json ->> '$.value.collected_minor' END), 0) collected,
        COALESCE(SUM(CASE WHEN ${eventName} = 'refund' THEN payload_json ->> '$.value.collected_minor' END), 0) refunded
      FROM analytics_events WHERE ${inRange} AND ${eventName} IN ('purchase', 'refund') GROUP BY 1,2,3,4,5`, [organizationId, start, end]),
    read(`SELECT location_id, (payload_json ->> '$.value.items[0].item_id') product_id, (payload_json ->> '$.value.items[0].item_name') product_name,
        (payload_json ->> '$.value.currency') currency, COUNT(*) bookings, COUNT(payload_json ->> '$.value.amount_minor') valued, COALESCE(SUM(payload_json ->> '$.value.amount_minor'), 0) quoted_minor
      FROM analytics_events WHERE ${inRange} AND ${eventName} = 'booking_submit'
      GROUP BY 1,2,3,4 ORDER BY bookings DESC, product_name`, [organizationId, start, end]),
    read(`${signupsSql}
      SELECT signups.source, signups.medium, signups.campaign, signups.content, (v.payload_json ->> '$.value.currency') currency,
        COALESCE(SUM(CASE WHEN (v.payload_json ->> '$.event_name') = 'purchase' THEN v.payload_json ->> '$.value.collected_minor' END), 0) collected,
        COALESCE(SUM(CASE WHEN (v.payload_json ->> '$.event_name') = 'refund' THEN v.payload_json ->> '$.value.collected_minor' END), 0) refunded
      FROM signups JOIN analytics_events v ON v.kind = 'conversion' AND v.organization_id = ? AND (v.payload_json ->> '$.event_name') IN ('purchase', 'refund')
        AND (v.payload_json ->> '$.metadata.originating_user_id') = signups.user_id AND v.created_at >= signups.signed_at AND v.created_at < ?
      GROUP BY 1,2,3,4,5`, [organizationId, start, end, organizationId, observedEnd]),
    read(`SELECT
        (SELECT COUNT(DISTINCT payload_json ->> '$.entity_id') FROM analytics_events WHERE ${inRange} AND ${eventName} = 'onboarding_complete') onboarded,
        (SELECT COUNT(DISTINCT payload_json ->> '$.metadata.subscribing_organization_id') FROM analytics_events WHERE ${inRange} AND ${eventName} = 'purchase'
          AND (payload_json ->> '$.metadata.purchase_type') = 'initial_subscription') first_paid`, [organizationId, start, end, organizationId, start, end]),
    read(`SELECT
        (SELECT MIN(created_at) FROM analytics_events WHERE kind = 'conversion' AND organization_id = ? AND json_type(payload_json, '$.surface') IS 'text') started_at,
        (SELECT COUNT(*) FROM analytics_events WHERE ${inRange} AND json_type(payload_json, '$.attribution.source') IS NOT 'text'
          AND ${eventName} IN (${OUTCOME_EVENT_SQL_LIST})) unattributed`, [organizationId, organizationId, start, end]),
    read(`SELECT ${eventName} event_name, COALESCE(payload_json ->> '$.ga4_delivery.status', 'unrecorded') status, COUNT(*) count FROM analytics_events
      WHERE ${inRange} AND ${eventName} IN (${SERVER_DELIVERED_EVENT_SQL_LIST})
      GROUP BY 1,2 ORDER BY event_name, status`, [organizationId, start, end]),
  ]
}

function composeConversionDetail(results: Row[][], cohortRows: Row[], window: ConversionReportWindow, uniqueSessions: number) {
  const [dailyRows, conversionRows, outcomeRows, valueRows, attributedRows, bookingValueRows, cohortRevenueRows, [businessStats], [coverageRows], deliveryRows] = results as [
    Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[]]
  const { observedEnd } = window
  const cohortRevenue = (row: Row) => cohortRevenueRows
    .filter(revenue => revenue.source === row.source && revenue.medium === row.medium && revenue.campaign === row.campaign && revenue.content === row.content)
    .map(revenue => ({ currency: String(revenue.currency), collected_minor: n(revenue.collected), refunded_minor: n(revenue.refunded), net_minor: n(revenue.collected) - n(revenue.refunded) }))
  return {
    daily_conversions: window.dates.map(date => ({ date, events: n(dailyRows.find(row => row.date === date)?.events) })),
    outcome_attribution: outcomeRows.map(row => ({ source: String(row.source), medium: String(row.medium), campaign: text(row.campaign), content: text(row.content), event_name: String(row.event_name), events: n(row.events), distinct_entities: n(row.entities) })),
    attributed_value: attributedRows.map(row => ({ source: text(row.source), medium: text(row.medium), campaign: text(row.campaign), content: text(row.content), currency: String(row.currency),
      purchases: n(row.purchases), collected_minor: n(row.collected), refunded_minor: n(row.refunded), net_minor: n(row.collected) - n(row.refunded) })),
    conversions: conversionRows.map(row => ({
      event_name: String(row.event_name), stage: String(row.stage), conversion_type: text(row.conversion_type),
      events: n(row.events), distinct_entities: n(row.entities), converting_sessions: n(row.sessions), nonbrowser_events: n(row.nonbrowser),
      // Only a business outcome has a session conversion rate. A click or a view is an interaction.
      session_conversion_rate: OUTCOME_EVENT_NAMES.has(String(row.event_name)) ? rate(n(row.sessions), uniqueSessions) : null,
    })),
    values: valueRows.map(row => ({
      event_name: String(row.event_name), basis: row.basis as 'quoted' | 'purchase' | 'refund', currency: String(row.currency), events: n(row.events),
      value_minor: n(row.value_minor), collected_minor: n(row.collected_events) > 0 ? n(row.collected_minor) : null,
    })),
    booking_value: bookingValueRows.map(row => ({
      product_id: text(row.product_id), product_name: text(row.product_name), location_id: text(row.location_id), currency: text(row.currency),
      bookings: n(row.bookings), valued_bookings: n(row.valued), quoted_value_minor: n(row.quoted_minor),
    })),
    net: netByCurrency(valueRows),
    signup_cohort: {
      observed_through: observedEnd,
      signups: cohortRows.reduce((sum, row) => sum + n(row.signups), 0),
      onboarded_signups: cohortRows.reduce((sum, row) => sum + n(row.onboarded), 0),
      first_paid_signups: cohortRows.reduce((sum, row) => sum + n(row.first_paid), 0),
      by_signup_attribution: cohortRows.map(row => ({
        source: text(row.source), medium: text(row.medium), campaign: text(row.campaign), content: text(row.content),
        signups: n(row.signups), onboarded_signups: n(row.onboarded), first_paid_signups: n(row.first_paid), revenue: cohortRevenue(row),
      })),
      onboarded_businesses: n(businessStats?.onboarded),
      first_paid_businesses: n(businessStats?.first_paid),
    },
    coverage: {
      measurement_contract_started_at: text(coverageRows?.started_at),
      outcome_events_without_attribution: n(coverageRows?.unattributed),
      ga4_delivery: deliveryRows.map(row => ({ event_name: String(row.event_name), status: String(row.status), count: n(row.count) })),
    },
  }
}

type FunnelCounts = Omit<AnalyticsReport['funnel'], 'by_source' | 'by_location'>
const FUNNEL_EVENTS = ORGANIZATION_CONVERSION_EVENT_NAMES.flatMap((name) => {
  const step: FunnelStep | undefined = (CONVERSION_EVENT_CATALOG[name] as ConversionEventDefinition).funnel
  return step ? [{ name, step }] : []
})
const FUNNEL_STEP_SQL = `CASE (payload_json ->> '$.event_name') ${FUNNEL_EVENTS.map(({ name, step }) => `WHEN '${name}' THEN '${step}'`).join(' ')} END`
const FUNNEL_EVENT_SQL_LIST = FUNNEL_EVENTS.map(({ name }) => `'${name}'`).join(', ')
const FUNNEL_SUBMIT_SQL_LIST = FUNNEL_EVENTS.filter(({ step }) => step === 'submitted').map(({ name }) => `'${name}'`).join(', ')

// One business's site funnel over the range. Each step is counted where it is recorded: visits are
// pageview sessions, viewed and intent are the browser's events, submitted is the request the
// guest made, confirmed is that request's booking or stay standing confirmed now,
// and paid is the payment captured. A request made through checkout has no submit event: its
// payment is how it was made, so a paid payment whose request was never submitted counts as that
// request's submission too. Sources are each event's own attribution snapshot; a visit's is its
// session's last touch, the same population as the attribution table.
function funnelReads(organizationId: string, start: string, end: string): BatchQuery[] {
  return [
    read(`SELECT location_id, source, medium, step, currency, COUNT(*) events, SUM(submits) submitted,
        SUM(submits AND EXISTS (SELECT 1 FROM conversations c JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id WHERE c.id = thread_id AND b.organization_id = ? AND b.status = 'confirmed')) confirmed,
        SUM(collected_minor) collected_minor
      FROM (SELECT *, step = 'submitted' OR (step = 'paid' AND thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM analytics_events s
            WHERE s.organization_id = ? AND s.kind = 'conversion' AND (s.payload_json ->> '$.event_name') IN (${FUNNEL_SUBMIT_SQL_LIST})
              AND (s.payload_json ->> '$.entity_type') = 'request' AND (s.payload_json ->> '$.entity_id') = thread_id)) submits
        FROM (SELECT location_id, (payload_json ->> '$.attribution.source') source, (payload_json ->> '$.attribution.medium') medium,
            ${FUNNEL_STEP_SQL} step, (payload_json ->> '$.value.currency') currency, (payload_json ->> '$.value.collected_minor') collected_minor,
            CASE WHEN (payload_json ->> '$.event_name') = 'payment_paid' THEN (SELECT c.id FROM payments p
                LEFT JOIN conversations c ON p.subject_type = 'booking' AND c.booking_id = p.subject_id AND c.kind = 'booking' AND c.organization_id = p.organization_id
                WHERE p.id = (analytics_events.payload_json ->> '$.entity_id') AND p.organization_id = analytics_events.organization_id)
              ELSE (payload_json ->> '$.entity_id') END thread_id
          FROM analytics_events WHERE kind IN ('conversion', 'interaction') AND organization_id = ? AND created_at >= ? AND created_at < ?
            AND (payload_json ->> '$.event_name') IN (${FUNNEL_EVENT_SQL_LIST})))
      GROUP BY 1,2,3,4,5`, [organizationId, organizationId, organizationId, start, end]),
    read(`SELECT location_id, COUNT(DISTINCT session_id) sessions FROM analytics_events
      WHERE organization_id = ? AND kind = 'pageview' AND created_at >= ? AND created_at < ? GROUP BY 1`, [organizationId, start, end]),
  ]
}

function composeFunnel([eventRows, locationVisitRows]: Row[][], visits: { total: number; bySource: Array<{ source: string; medium: string; sessions: number }> }) {
  const empty = (): FunnelCounts => ({ visits: 0, viewed: 0, intent: 0, submitted: 0, confirmed: 0, paid: 0, paid_collected: [] })
  const add = (counts: FunnelCounts, row: Row) => {
    const step = row.step as FunnelStep
    if (step !== 'submitted') counts[step] += n(row.events)
    counts.submitted += n(row.submitted)
    counts.confirmed += n(row.confirmed)
    if (step === 'paid' && row.currency) {
      const entry = counts.paid_collected.find(paid => paid.currency === row.currency)
      if (entry) entry.collected_minor += n(row.collected_minor)
      else counts.paid_collected.push({ currency: row.currency as FunnelCounts['paid_collected'][number]['currency'], collected_minor: n(row.collected_minor) })
    }
  }
  const total = { ...empty(), visits: visits.total }
  const bySource = new Map<AttributionChannel, FunnelCounts>()
  const byLocation = new Map<string | null, FunnelCounts>()
  const sourceOf = (channel: AttributionChannel) => bySource.get(channel) ?? bySource.set(channel, empty()).get(channel)!
  const locationOf = (locationId: string | null) => byLocation.get(locationId) ?? byLocation.set(locationId, empty()).get(locationId)!
  // The sessions table labels a session without a touch; that is a visit whose source was not recorded.
  for (const row of visits.bySource) sourceOf(row.medium === '(not recorded)' ? 'Not recorded' : attributionChannel(row.source, row.medium)).visits += row.sessions
  for (const row of locationVisitRows!) locationOf(text(row.location_id)).visits += n(row.sessions)
  for (const row of eventRows!) {
    add(total, row)
    add(sourceOf(attributionChannel(text(row.source), text(row.medium))), row)
    add(locationOf(text(row.location_id)), row)
  }
  return {
    ...total,
    by_source: ATTRIBUTION_CHANNELS.filter(channel => bySource.has(channel)).map(channel => ({ channel, ...bySource.get(channel)! })),
    by_location: Array.from(byLocation, ([locationId, counts]) => ({ location_id: locationId, ...counts })).sort((a, b) => b.visits - a.visits),
  }
}
function netByCurrency(valueRows: Array<Record<string, unknown>>) {
  const byCurrency = new Map<string, { collected_minor: number; refunded_minor: number }>()
  for (const row of valueRows) {
    if (row.basis !== 'purchase' && row.basis !== 'refund') continue
    const entry = byCurrency.get(String(row.currency)) ?? { collected_minor: 0, refunded_minor: 0 }
    // Cash both ways, tax included: the tax-exclusive value of a refund is not what was returned.
    if (row.basis === 'purchase') entry.collected_minor += n(row.collected_minor)
    else entry.refunded_minor += n(row.collected_minor)
    byCurrency.set(String(row.currency), entry)
  }
  return Array.from(byCurrency, ([currency, entry]) => ({ currency, ...entry, net_minor: entry.collected_minor - entry.refunded_minor }))
}

/**
 * One read of the report, in one D1 batch. Sessions and visitors are the stored session summaries
 * every pageview maintains. Page views and their breakdowns are the stored daily summaries of the
 * range and of the period before it: a day the daily aggregation has not summarized (today, and
 * yesterday until it runs) has none. The MCP report adds what is read from the events.
 */
async function readAnalyticsReport(db: DbClient, context: OrganizationAnalyticsContext, input: { startDate?: string; endDate?: string; now?: Date }, conversionDetail: boolean) {
  const { organizationId, timezone, analyticsDataStartAt } = context
  const now = input.now ?? new Date()
  const range = parseAnalyticsRange({ startDate: input.startDate, endDate: input.endDate, timeZone: timezone, now })
  const { start } = localDateBounds(range.startDate, timezone)
  const { end } = localDateBounds(range.endDate, timezone)
  const nowIso = now.toISOString()
  const observedEnd = end < nowIso ? end : nowIso
  // Native collection began when the business went live. A range wholly before that has nothing native
  // to report, and zeros would read as a business nobody visited; one that straddles it reports from then.
  if (!analyticsDataStartAt) {
    throw new HTTPError({ statusCode: 422, statusMessage: 'This business\'s own analytics begin when its site goes live.', data: { code: 'NO_NATIVE_COVERAGE' } })
  }
  if (end <= analyticsDataStartAt) {
    throw new HTTPError({ statusCode: 422, statusMessage: `This business's own analytics begin ${analyticsDataStartAt}; ${range.startDate} to ${range.endDate} is before them. Earlier periods are in Google Ads, Google Analytics and Search Console.`, data: { code: 'NO_NATIVE_COVERAGE' } })
  }
  const nativeCoverage = start < analyticsDataStartAt ? 'partial' as const : 'full' as const
  const previousDates = localDateBounds(range.previousStartDate, timezone).start >= analyticsDataStartAt
    ? enumerateLocalDates(range.previousStartDate, range.previousEndDate)
    : []
  const window: ConversionReportWindow = { start, end, observedEnd, dates: range.dates, timezone }
  const funnelQueries = conversionDetail ? funnelReads(organizationId, start, end) : []
  const detailQueries = conversionDetail ? conversionDetailReads(organizationId, window) : []
  const results = (await executeBatch(db, [
    // The previous period is read only for its page views; it ends the day before the range starts.
    read(`SELECT kind, date, key, payload_json FROM analytics_summaries
      WHERE organization_id = ? AND kind IN ('organization_day', 'page_day', 'dimension_day') AND date BETWEEN ? AND ?
        AND (kind = 'organization_day' OR date >= ?)`, [organizationId, previousDates[0] ?? range.startDate, range.endDate, range.startDate]),
    // The period's sessions and visitors, from each session's own summary, which every pageview keeps current.
    read(`WITH sessions AS (SELECT key, (payload_json ->> '$.visitor_id') visitor_id, (payload_json ->> '$.duration_seconds') duration_seconds
        FROM analytics_summaries WHERE organization_id = ? AND kind = 'session' AND (payload_json ->> '$.last_seen_at') >= ? AND (payload_json ->> '$.started_at') < ?)
      SELECT COUNT(*) sessions, COUNT(DISTINCT visitor_id) visitors,
        COALESCE(ROUND(AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds END)), 0) avg_duration,
        (SELECT COUNT(DISTINCT current.visitor_id) FROM sessions current WHERE EXISTS (SELECT 1 FROM analytics_summaries earlier
          WHERE earlier.organization_id = ? AND earlier.kind = 'session' AND (earlier.payload_json ->> '$.visitor_id') = current.visitor_id
            AND (earlier.payload_json ->> '$.started_at') < ? AND earlier.key <> current.key)) returning_visitors
      FROM sessions`, [organizationId, start, end, organizationId, start]),
    ...(conversionDetail ? [
      // Sessions and their converting sessions are counted over the same population: each session
      // grouped by its current last touch, converting when it has an outcome event in the range.
      read(`SELECT source, medium, campaign, content, COUNT(*) sessions,
          SUM(EXISTS (SELECT 1 FROM analytics_events e WHERE e.kind = 'conversion' AND e.organization_id = facts.organization_id AND e.session_id = facts.session_id
            AND e.created_at >= ? AND e.created_at < ? AND (e.payload_json ->> '$.event_name') IN (${OUTCOME_EVENT_SQL_LIST}))) converting,
          COALESCE(SUM((SELECT COUNT(*) FROM analytics_events e WHERE e.kind = 'conversion' AND e.organization_id = facts.organization_id AND e.session_id = facts.session_id
            AND e.created_at >= ? AND e.created_at < ? AND (e.payload_json ->> '$.event_name') IN (${OUTCOME_EVENT_SQL_LIST}))), 0) outcome_events
        FROM (${sessionFactsSql('?', `SELECT DISTINCT session_id FROM analytics_events
          WHERE organization_id = ? AND kind = 'pageview' AND created_at >= ? AND created_at < ?`)}) facts
        GROUP BY 1,2,3,4`, [start, end, start, end, organizationId, organizationId, start, end]),
      signupCohortRead(organizationId, window),
      ...funnelQueries,
      ...detailQueries,
    ] : []),
  ], { operation: 'Read analytics report' })).map(result => result.results as Row[])
  const summaryRows = results[0] as unknown as AnalyticsSummaryRow[]
  const sessionStats = results[1]![0]!

  const summarized = new Map<string, Omit<AnalyticsSummaryRow, 'date'>[]>()
  for (const row of summaryRows) summarized.set(row.date, [...summarized.get(row.date) ?? [], row])
  const sliceOf = (date: string): DailySlice => {
    const rows = summarized.get(date)
    return rows?.some(row => row.kind === 'organization_day')
      ? dailySlice(date, rows)
      : { date, pageViews: 0, sessions: 0, visitors: 0, returningVisitors: 0, avgDuration: 0, pagesPerSession: 0, pages: [], dimensions: [] }
  }
  const slices = range.dates.map(sliceOf)
  const total = (value: (slice: DailySlice) => number) => slices.reduce((sum, slice) => sum + value(slice), 0)
  const pageViews = total(slice => slice.pageViews)
  const uniqueSessions = n(sessionStats.sessions)
  const summarizedSessions = total(slice => slice.sessions)
  const previousViews = previousDates.reduce((sum, date) => sum + sliceOf(date).pageViews, 0)
  const changePercent = previousDates.length && previousViews ? Math.round((pageViews - previousViews) / previousViews * 100) : null

  const pageMap = new Map<string, number>()
  const dimensionMaps = new Map<string, Map<string, number>>()
  for (const slice of slices) {
    for (const page of slice.pages) pageMap.set(page.value, (pageMap.get(page.value) ?? 0) + page.views)
    for (const dimension of slice.dimensions) {
      const map = dimensionMaps.get(dimension.dimension) ?? new Map<string, number>()
      const key = `${dimension.value}\u0000${dimension.subvalue}`
      map.set(key, (map.get(key) ?? 0) + dimension.views)
      dimensionMaps.set(dimension.dimension, map)
    }
  }
  const percent = (views: number) => pageViews ? Math.round(views / pageViews * 100) : 0
  const dimensionRows = (name: string) => Array.from(dimensionMaps.get(name) ?? []).map(([key, views]) => {
    const [value, subvalue = ''] = key.split('\u0000')
    return { value: value!, subvalue, views }
  }).sort((a, b) => b.views - a.views)

  const report = {
    period: { start_date: range.startDate, end_date: range.endDate, timezone, analytics_data_start_at: analyticsDataStartAt, native_coverage: nativeCoverage },
    // Page views are the summarized days'; sessions and visitors are current. Pages per session
    // divides the summarized days' page views by the same days' sessions.
    metrics: {
      page_views: pageViews,
      unique_sessions: uniqueSessions,
      unique_visitors: n(sessionStats.visitors),
      returning_visitors: n(sessionStats.returning_visitors),
      avg_session_duration: n(sessionStats.avg_duration),
      pages_per_session: summarizedSessions ? Math.round(pageViews / summarizedSessions * 100) / 100 : 0,
      change_percent: changePercent,
    },
    daily_data: slices.map(slice => ({ date: slice.date, page_views: slice.pageViews, sessions: slice.sessions, avg_duration: slice.avgDuration })),
    top_pages: Array.from(pageMap, ([path, views]) => ({ path, views, percent_of_total: percent(views) })).sort((a, b) => b.views - a.views).slice(0, 10),
    countries: dimensionRows('country').slice(0, 12).map(row => ({ country: row.value, country_code: row.value, views: row.views, percent_of_total: percent(row.views) })),
    cities: dimensionRows('city').slice(0, 10).map(row => {
      const [region, countryCode = 'XX'] = row.subvalue.split('|')
      return { city: row.value, region: region || null, country_code: countryCode, views: row.views }
    }),
    referrers: dimensionRows('referrer').slice(0, 10).map(row => ({ source: row.value, views: row.views, percent_of_total: percent(row.views) })),
    devices: dimensionRows('device').map(row => ({ type: row.value, views: row.views, percent_of_total: percent(row.views) })),
  }
  if (!conversionDetail) return { report, detail: null }
  const [attributionRows, cohortRows] = [results[2]!, results[3]!]
  const funnelResults = results.slice(4, 4 + funnelQueries.length)
  const detailResults = results.slice(4 + funnelQueries.length)
  // The events' own sessions in the range: every one has its last touch in the attribution rows.
  const eventSessions = attributionRows.reduce((sum, row) => sum + n(row.sessions), 0)
  return {
    report,
    detail: {
      attribution: attributionRows.map(row => {
        const sessions = n(row.sessions)
        return { source: String(row.source), medium: String(row.medium), campaign: row.campaign ? String(row.campaign) : null, content: row.content ? String(row.content) : null,
          sessions, outcome_events: n(row.outcome_events), converting_sessions: n(row.converting), session_conversion_rate: rate(n(row.converting), sessions) }
      }).sort((a, b) => b.sessions - a.sessions),
      funnel: composeFunnel(funnelResults, { total: eventSessions, bySource: attributionRows.map(row => ({ source: String(row.source), medium: String(row.medium), sessions: n(row.sessions) })) }),
      ...composeConversionDetail(detailResults, cohortRows, window, eventSessions),
    },
  }
}

/** The report the dashboard shows, for the organization the dashboard context already read. */
export async function getDashboardAnalyticsReport(db: DbClient, context: OrganizationAnalyticsContext, input: { startDate?: string; endDate?: string; now?: Date }): Promise<DashboardAnalyticsReport> {
  return dashboardAnalyticsReportSchema.parse((await readAnalyticsReport(db, context, input, false)).report)
}

/** The whole report MCP returns: the dashboard's traffic, attribution, the site funnel, conversion detail and, given env, Google Ads spend. */
export async function getAnalyticsReport(db: DbClient, input: {
  organizationId: string; startDate?: string; endDate?: string; now?: Date
}, env?: CloudflareEnv): Promise<AnalyticsReport> {
  const { report, detail } = await readAnalyticsReport(db, await resolveOrganizationAnalyticsContext(db, input.organizationId), input, true)

  let adSpend: {
    total_spend_micros: number
    clicks: number
    impressions: number
    conversions: number
    cost_per_click_micros: number
    error?: string | null
  } | undefined = undefined

  if (env) {
    try {
      const integration = await readIntegration(db, input.organizationId, 'google_ads')
      if (integration?.account_id && integration.target_id) {
        const { accessToken } = await linkedAccountAccessToken(env, integration.account_id)
        const summary = await getGoogleAdsPerformanceSummary(
          accessToken,
          env.GOOGLE_ADS_DEVELOPER_TOKEN,
          integration.target_id,
          report.period.start_date,
          report.period.end_date,
        )
        adSpend = {
          total_spend_micros: summary.costMicros,
          clicks: summary.clicks,
          impressions: summary.impressions,
          conversions: summary.conversions,
          cost_per_click_micros: summary.averageCpcMicros,
          error: null,
        }
      }
    } catch (error) {
      adSpend = {
        total_spend_micros: 0,
        clicks: 0,
        impressions: 0,
        conversions: 0,
        cost_per_click_micros: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return analyticsReportSchema.parse({ ...report, ...detail, ...(adSpend ? { ad_spend: adSpend } : {}) })
}

export async function aggregatePreviousLocalDateForAllOrganizations(db: DbClient, now = new Date()): Promise<string[]> {
  const organizations = await queryAll<{ id: string; timezone: string }>(db, `SELECT s.id, s.timezone FROM organization s WHERE s.status = 'active'`)
  const aggregated: string[] = []
  for (const organization of organizations) {
    const timezone = organization.timezone
    const date = addLocalDays(localDateAt(now, timezone), -1)
    await aggregateOrganizationAnalyticsDate(db, organization.id, date)
    aggregated.push(`${organization.id}:${date}`)
  }
  return aggregated
}
