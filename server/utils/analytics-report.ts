import { z } from 'zod'
import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { localDateBounds, parseAnalyticsRange } from '~/server/utils/analytics-calendar'
import { addLocalDays, localDateAt } from '~/utils/timezone'
import { CONVERSION_EVENT_CATALOG, ORGANIZATION_CONVERSION_EVENT_NAMES, type ConversionEventDefinition, type FunnelStep } from '~/utils/organization-conversion-events'
import { ATTRIBUTION_CHANNELS, attributionChannel, type AttributionChannel } from '~/utils/analytics-attribution'
import { readIntegration } from './organization-integrations'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { getGoogleAdsPerformanceSummary } from './google-ads'

import { analyticsReportSchema, type AnalyticsReport } from '~/shared/analytics-report'
export type { AnalyticsReport } from '~/shared/analytics-report'

interface OrganizationContext {
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

export async function resolveOrganizationAnalyticsContext(db: DbClient, organizationId: string): Promise<OrganizationContext> {
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

async function loadSlices(db: DbClient, organizationId: string, dates: string[], timezone: string, now: Date, cutoffDate: string | null): Promise<DailySlice[]> {
  if (dates.length === 0) return []
  const rows = await queryAll<AnalyticsSummaryRow>(db, `SELECT kind, date, key, payload_json FROM analytics_summaries
    WHERE organization_id = ? AND kind IN ('organization_day', 'page_day', 'dimension_day') AND date BETWEEN ? AND ?`, [organizationId, dates[0]!, dates.at(-1)!])
  const result: DailySlice[] = []
  for (const date of dates) {
    const dayRows = rows.filter(row => row.date === date)
    if (dayRows.some(row => row.kind === 'organization_day')) {
      result.push(dailySlice(date, dayRows))
      continue
    }
    if (cutoffDate && date < cutoffDate) {
      result.push({ date, pageViews: 0, sessions: 0, visitors: 0, returningVisitors: 0, avgDuration: 0, pagesPerSession: 0, pages: [], dimensions: [] })
      continue
    }
    const { start, end } = localDateBounds(date, timezone)
    result.push(dailySlice(date, await queryAll<Omit<AnalyticsSummaryRow, 'date'>>(db, daySummariesSql, [organizationId, start, end])))
  }
  return result
}

interface ConversionReportWindow { start: string; end: string; observedEnd: string; uniqueSessions: number; dates: string[]; timezone: string }

async function loadConversionReport(db: DbClient, organizationId: string, window: ConversionReportWindow) {
  const { start, end, observedEnd, uniqueSessions } = window
  const inRange = `kind IN ('conversion', 'interaction') AND organization_id = ? AND created_at >= ? AND created_at < ?`
  const eventName = `(payload_json ->> '$.event_name')`
  // Calendar dates and their UTC boundaries are produced by the validated range
  // and timezone helpers. Bucket in SQL without assuming a fixed UTC offset.
  const localDay = `CASE ${window.dates.map(date => `WHEN created_at < '${localDateBounds(addLocalDays(date, 1), window.timezone).start}' THEN '${date}'`).join(' ')} END`
  const snapshot = `(payload_json ->> '$.attribution.source') source, (payload_json ->> '$.attribution.medium') medium,
    (payload_json ->> '$.attribution.campaign') campaign, (payload_json ->> '$.attribution.content') content`
  // Signups in the window; outcomes that follow them are linked through the originating owner
  // recorded on the onboarding and purchase events, never through current membership.
  const signups = `WITH signups AS (
      SELECT e.created_at signed_at, (e.payload_json ->> '$.entity_id') user_id, (e.payload_json ->> '$.attribution.source') source, (e.payload_json ->> '$.attribution.medium') medium,
        (e.payload_json ->> '$.attribution.campaign') campaign, (e.payload_json ->> '$.attribution.content') content
      FROM analytics_events e WHERE e.kind = 'conversion' AND e.organization_id = ? AND (e.payload_json ->> '$.event_name') = 'sign_up' AND e.created_at >= ? AND e.created_at < ?)`
  const followedBy = (alias: string, eventFilter: string) => `EXISTS (SELECT 1 FROM analytics_events ${alias} WHERE ${alias}.kind = 'conversion' AND ${alias}.organization_id = ?
    AND ${eventFilter} AND (${alias}.payload_json ->> '$.metadata.originating_user_id') = signups.user_id AND ${alias}.created_at >= signups.signed_at AND ${alias}.created_at < ?)`
  const [dailyRows, conversionRows, outcomeRows, valueRows, attributedRows, bookingValueRows, cohortRows, cohortRevenueRows, businessStats, coverageRows, deliveryRows] = await Promise.all([
    queryAll<{ date: string; events: number }>(db, `SELECT ${localDay} date, COUNT(*) events
      FROM analytics_events WHERE ${inRange} AND ${eventName} IN (${OUTCOME_EVENT_SQL_LIST}) GROUP BY 1`, [organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `SELECT ${eventName} event_name, (payload_json ->> '$.stage') stage, (payload_json ->> '$.conversion_type') conversion_type,
        COUNT(*) events, COUNT(DISTINCT COALESCE(payload_json ->> '$.entity_id', id)) entities, COUNT(DISTINCT session_id) sessions, SUM(session_id IS NULL) nonbrowser
      FROM analytics_events WHERE ${inRange} GROUP BY 1,2,3 ORDER BY events DESC, event_name`, [organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `SELECT ${snapshot}, ${eventName} event_name, COUNT(*) events, COUNT(DISTINCT COALESCE(payload_json ->> '$.entity_id', id)) entities
      FROM analytics_events WHERE ${inRange} AND json_type(payload_json, '$.attribution.source') IS 'text' AND ${eventName} IN (${OUTCOME_EVENT_SQL_LIST}) GROUP BY 1,2,3,4,5`, [organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `SELECT ${eventName} event_name, (payload_json ->> '$.value.basis') basis, (payload_json ->> '$.value.currency') currency,
        COUNT(*) events, SUM(payload_json ->> '$.value.amount_minor') value_minor, SUM(payload_json ->> '$.value.collected_minor') collected_minor, COUNT(payload_json ->> '$.value.collected_minor') collected_events
      FROM analytics_events WHERE ${inRange} AND json_type(payload_json, '$.value.amount_minor') IS 'integer'
      GROUP BY 1,2,3 ORDER BY event_name, currency`, [organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `SELECT ${snapshot}, (payload_json ->> '$.value.currency') currency,
        SUM(${eventName} = 'purchase') purchases,
        COALESCE(SUM(CASE WHEN ${eventName} = 'purchase' THEN payload_json ->> '$.value.collected_minor' END), 0) collected,
        COALESCE(SUM(CASE WHEN ${eventName} = 'refund' THEN payload_json ->> '$.value.collected_minor' END), 0) refunded
      FROM analytics_events WHERE ${inRange} AND ${eventName} IN ('purchase', 'refund') GROUP BY 1,2,3,4,5`, [organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `SELECT location_id, (payload_json ->> '$.value.items[0].item_id') product_id, (payload_json ->> '$.value.items[0].item_name') product_name,
        (payload_json ->> '$.value.currency') currency, COUNT(*) bookings, COUNT(payload_json ->> '$.value.amount_minor') valued, COALESCE(SUM(payload_json ->> '$.value.amount_minor'), 0) quoted_minor
      FROM analytics_events WHERE ${inRange} AND ${eventName} = 'booking_submit'
      GROUP BY 1,2,3,4 ORDER BY bookings DESC, product_name`, [organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `${signups}
      SELECT source, medium, campaign, content, COUNT(*) signups,
        SUM(${followedBy('o', "(o.payload_json ->> '$.event_name') = 'onboarding_complete'")}) onboarded,
        SUM(${followedBy('p', "(p.payload_json ->> '$.event_name') = 'purchase' AND (p.payload_json ->> '$.metadata.purchase_type') = 'initial_subscription'")}) first_paid
      FROM signups GROUP BY 1,2,3,4 ORDER BY signups DESC`, [organizationId, start, end, organizationId, observedEnd, organizationId, observedEnd]),
    queryAll<Record<string, unknown>>(db, `${signups}
      SELECT signups.source, signups.medium, signups.campaign, signups.content, (v.payload_json ->> '$.value.currency') currency,
        COALESCE(SUM(CASE WHEN (v.payload_json ->> '$.event_name') = 'purchase' THEN v.payload_json ->> '$.value.collected_minor' END), 0) collected,
        COALESCE(SUM(CASE WHEN (v.payload_json ->> '$.event_name') = 'refund' THEN v.payload_json ->> '$.value.collected_minor' END), 0) refunded
      FROM signups JOIN analytics_events v ON v.kind = 'conversion' AND v.organization_id = ? AND (v.payload_json ->> '$.event_name') IN ('purchase', 'refund')
        AND (v.payload_json ->> '$.metadata.originating_user_id') = signups.user_id AND v.created_at >= signups.signed_at AND v.created_at < ?
      GROUP BY 1,2,3,4,5`, [organizationId, start, end, organizationId, observedEnd]),
    queryFirst<Record<string, unknown>>(db, `SELECT
        (SELECT COUNT(DISTINCT payload_json ->> '$.entity_id') FROM analytics_events WHERE ${inRange} AND ${eventName} = 'onboarding_complete') onboarded,
        (SELECT COUNT(DISTINCT payload_json ->> '$.metadata.subscribing_organization_id') FROM analytics_events WHERE ${inRange} AND ${eventName} = 'purchase'
          AND (payload_json ->> '$.metadata.purchase_type') = 'initial_subscription') first_paid`, [organizationId, start, end, organizationId, start, end]),
    queryFirst<Record<string, unknown>>(db, `SELECT
        (SELECT MIN(created_at) FROM analytics_events WHERE kind = 'conversion' AND organization_id = ? AND json_type(payload_json, '$.surface') IS 'text') started_at,
        (SELECT COUNT(*) FROM analytics_events WHERE ${inRange} AND json_type(payload_json, '$.attribution.source') IS NOT 'text'
          AND ${eventName} IN (${OUTCOME_EVENT_SQL_LIST})) unattributed`, [organizationId, organizationId, start, end]),
    queryAll<Record<string, unknown>>(db, `SELECT ${eventName} event_name, COALESCE(payload_json ->> '$.ga4_delivery.status', 'unrecorded') status, COUNT(*) count FROM analytics_events
      WHERE ${inRange} AND ${eventName} IN (${SERVER_DELIVERED_EVENT_SQL_LIST})
      GROUP BY 1,2 ORDER BY event_name, status`, [organizationId, start, end]),
  ])
  const cohortRevenue = (row: Record<string, unknown>) => cohortRevenueRows
    .filter(revenue => revenue.source === row.source && revenue.medium === row.medium && revenue.campaign === row.campaign && revenue.content === row.content)
    .map(revenue => ({ currency: String(revenue.currency), collectedMinor: n(revenue.collected), refundedMinor: n(revenue.refunded), netMinor: n(revenue.collected) - n(revenue.refunded) }))
  return {
    dailyConversions: window.dates.map(date => ({ date, events: dailyRows.find(row => row.date === date)?.events ?? 0 })),
    outcomeAttribution: outcomeRows.map(row => ({ source: String(row.source), medium: String(row.medium), campaign: text(row.campaign), content: text(row.content), eventName: String(row.event_name), events: n(row.events), distinctEntities: n(row.entities) })),
    attributedValue: attributedRows.map(row => ({ source: text(row.source), medium: text(row.medium), campaign: text(row.campaign), content: text(row.content), currency: String(row.currency),
      purchases: n(row.purchases), collectedMinor: n(row.collected), refundedMinor: n(row.refunded), netMinor: n(row.collected) - n(row.refunded) })),
    conversions: conversionRows.map(row => ({
      eventName: String(row.event_name), stage: String(row.stage), conversionType: text(row.conversion_type),
      events: n(row.events), distinctEntities: n(row.entities), convertingSessions: n(row.sessions), nonbrowserEvents: n(row.nonbrowser),
      // Only a business outcome has a session conversion rate. A click or a view is an interaction.
      sessionConversionRate: OUTCOME_EVENT_NAMES.has(String(row.event_name)) ? rate(n(row.sessions), uniqueSessions) : null,
    })),
    values: valueRows.map(row => ({
      eventName: String(row.event_name), basis: row.basis as 'quoted' | 'purchase' | 'refund', currency: String(row.currency), events: n(row.events),
      valueMinor: n(row.value_minor), collectedMinor: n(row.collected_events) > 0 ? n(row.collected_minor) : null,
    })),
    bookingValue: bookingValueRows.map(row => ({
      productId: text(row.product_id), productName: text(row.product_name), locationId: text(row.location_id), currency: text(row.currency),
      bookings: n(row.bookings), valuedBookings: n(row.valued), quotedValueMinor: n(row.quoted_minor),
    })),
    net: netByCurrency(valueRows),
    signupCohort: {
      observedThrough: observedEnd,
      signups: cohortRows.reduce((sum, row) => sum + n(row.signups), 0),
      onboardedSignups: cohortRows.reduce((sum, row) => sum + n(row.onboarded), 0),
      firstPaidSignups: cohortRows.reduce((sum, row) => sum + n(row.first_paid), 0),
      bySignupAttribution: cohortRows.map(row => ({
        source: text(row.source), medium: text(row.medium), campaign: text(row.campaign), content: text(row.content),
        signups: n(row.signups), onboardedSignups: n(row.onboarded), firstPaidSignups: n(row.first_paid), revenue: cohortRevenue(row),
      })),
      onboardedBusinesses: n(businessStats?.onboarded),
      firstPaidBusinesses: n(businessStats?.first_paid),
    },
    coverage: {
      measurementContractStartedAt: text(coverageRows?.started_at),
      outcomeEventsWithoutAttribution: n(coverageRows?.unattributed),
      ga4Delivery: deliveryRows.map(row => ({ eventName: String(row.event_name), status: String(row.status), count: n(row.count) })),
    },
  }
}

type FunnelCounts = Omit<AnalyticsReport['funnel'], 'bySource' | 'byLocation'>
const FUNNEL_EVENTS = ORGANIZATION_CONVERSION_EVENT_NAMES.flatMap((name) => {
  const step: FunnelStep | undefined = (CONVERSION_EVENT_CATALOG[name] as ConversionEventDefinition).funnel
  return step ? [{ name, step }] : []
})
const FUNNEL_STEP_SQL = `CASE (payload_json ->> '$.event_name') ${FUNNEL_EVENTS.map(({ name, step }) => `WHEN '${name}' THEN '${step}'`).join(' ')} END`
const FUNNEL_EVENT_SQL_LIST = FUNNEL_EVENTS.map(({ name }) => `'${name}'`).join(', ')
const FUNNEL_SUBMIT_SQL_LIST = FUNNEL_EVENTS.filter(({ step }) => step === 'submitted').map(({ name }) => `'${name}'`).join(', ')

// One business's site funnel over the range. Each step is counted where it is recorded: visits are
// pageview sessions, viewed and intent are the browser's events, submitted is the request the
// guest made, confirmed is that request's booking, reservation or stay standing confirmed now,
// and paid is the payment captured. A request made through checkout has no submit event: its
// payment is how it was made, so a paid payment whose request was never submitted counts as that
// request's submission too. Sources are each event's own attribution snapshot; a visit's is its
// session's last touch, the same population as the attribution table.
async function loadFunnel(db: DbClient, organizationId: string, start: string, end: string, visits: { total: number; bySource: Array<{ source: string; medium: string; sessions: number }> }) {
  const [eventRows, locationVisitRows] = await Promise.all([
    queryAll<Record<string, unknown>>(db, `SELECT location_id, source, medium, step, currency, COUNT(*) events, SUM(submits) submitted,
        SUM(submits AND (
          EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = thread_id AND b.organization_id = ? AND b.status = 'confirmed')
          OR EXISTS (SELECT 1 FROM reservations r WHERE r.request_id = thread_id AND r.organization_id = ? AND r.status = 'confirmed')
          OR EXISTS (SELECT 1 FROM stays st WHERE st.request_id = thread_id AND st.organization_id = ? AND st.status = 'confirmed'))) confirmed,
        SUM(collected_minor) collected_minor
      FROM (SELECT *, step = 'submitted' OR (step = 'paid' AND thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM analytics_events s
            WHERE s.organization_id = ? AND s.kind = 'conversion' AND (s.payload_json ->> '$.event_name') IN (${FUNNEL_SUBMIT_SQL_LIST})
              AND (s.payload_json ->> '$.entity_type') = 'request' AND (s.payload_json ->> '$.entity_id') = thread_id)) submits
        FROM (SELECT location_id, (payload_json ->> '$.attribution.source') source, (payload_json ->> '$.attribution.medium') medium,
            ${FUNNEL_STEP_SQL} step, (payload_json ->> '$.value.currency') currency, (payload_json ->> '$.value.collected_minor') collected_minor,
            CASE WHEN (payload_json ->> '$.event_name') = 'payment_paid' THEN (SELECT COALESCE(b.request_id, r.request_id, st.request_id) FROM payments p
                LEFT JOIN bookings b ON p.subject_type = 'booking' AND b.id = p.subject_id AND b.organization_id = p.organization_id
                LEFT JOIN reservations r ON p.subject_type = 'reservation' AND r.id = p.subject_id AND r.organization_id = p.organization_id
                LEFT JOIN stays st ON p.subject_type = 'stay' AND st.id = p.subject_id AND st.organization_id = p.organization_id
                WHERE p.id = (payload_json ->> '$.entity_id') AND p.organization_id = analytics_events.organization_id)
              ELSE (payload_json ->> '$.entity_id') END thread_id
          FROM analytics_events WHERE kind IN ('conversion', 'interaction') AND organization_id = ? AND created_at >= ? AND created_at < ?
            AND (payload_json ->> '$.event_name') IN (${FUNNEL_EVENT_SQL_LIST})))
      GROUP BY 1,2,3,4,5`, [organizationId, organizationId, organizationId, organizationId, organizationId, start, end]),
    queryAll<{ location_id: string | null; sessions: number }>(db, `SELECT location_id, COUNT(DISTINCT session_id) sessions FROM analytics_events
      WHERE organization_id = ? AND kind = 'pageview' AND created_at >= ? AND created_at < ? GROUP BY 1`, [organizationId, start, end]),
  ])
  const empty = (): FunnelCounts => ({ visits: 0, viewed: 0, intent: 0, submitted: 0, confirmed: 0, paid: 0, paidCollected: [] })
  const add = (counts: FunnelCounts, row: Record<string, unknown>) => {
    const step = row.step as FunnelStep
    if (step !== 'submitted') counts[step] += n(row.events)
    counts.submitted += n(row.submitted)
    counts.confirmed += n(row.confirmed)
    if (step === 'paid' && row.currency) {
      const entry = counts.paidCollected.find(paid => paid.currency === row.currency)
      if (entry) entry.collectedMinor += n(row.collected_minor)
      else counts.paidCollected.push({ currency: row.currency as FunnelCounts['paidCollected'][number]['currency'], collectedMinor: n(row.collected_minor) })
    }
  }
  const total = { ...empty(), visits: visits.total }
  const bySource = new Map<AttributionChannel, FunnelCounts>()
  const byLocation = new Map<string | null, FunnelCounts>()
  const sourceOf = (channel: AttributionChannel) => bySource.get(channel) ?? bySource.set(channel, empty()).get(channel)!
  const locationOf = (locationId: string | null) => byLocation.get(locationId) ?? byLocation.set(locationId, empty()).get(locationId)!
  // The sessions table labels a session without a touch; that is a visit whose source was not recorded.
  for (const row of visits.bySource) sourceOf(row.medium === '(not recorded)' ? 'Not recorded' : attributionChannel(row.source, row.medium)).visits += row.sessions
  for (const row of locationVisitRows) locationOf(row.location_id).visits += n(row.sessions)
  for (const row of eventRows) {
    add(total, row)
    add(sourceOf(attributionChannel(text(row.source), text(row.medium))), row)
    add(locationOf(text(row.location_id)), row)
  }
  return {
    ...total,
    bySource: ATTRIBUTION_CHANNELS.filter(channel => bySource.has(channel)).map(channel => ({ channel, ...bySource.get(channel)! })),
    byLocation: Array.from(byLocation, ([locationId, counts]) => ({ locationId, ...counts })).sort((a, b) => b.visits - a.visits),
  }
}
function netByCurrency(valueRows: Array<Record<string, unknown>>) {
  const byCurrency = new Map<string, { collectedMinor: number; refundedMinor: number }>()
  for (const row of valueRows) {
    if (row.basis !== 'purchase' && row.basis !== 'refund') continue
    const entry = byCurrency.get(String(row.currency)) ?? { collectedMinor: 0, refundedMinor: 0 }
    // Cash both ways, tax included: the tax-exclusive value of a refund is not what was returned.
    if (row.basis === 'purchase') entry.collectedMinor += n(row.collected_minor)
    else entry.refundedMinor += n(row.collected_minor)
    byCurrency.set(String(row.currency), entry)
  }
  return Array.from(byCurrency, ([currency, entry]) => ({ currency, ...entry, netMinor: entry.collectedMinor - entry.refundedMinor }))
}

export async function getAnalyticsReport(db: DbClient, input: {
  organizationId: string; startDate?: string; endDate?: string; now?: Date
}, env?: CloudflareEnv): Promise<AnalyticsReport> {
  const now = input.now ?? new Date()
  const context = await resolveOrganizationAnalyticsContext(db, input.organizationId)
  const range = parseAnalyticsRange({ startDate: input.startDate, endDate: input.endDate, timeZone: context.timezone, now })
  const { start } = localDateBounds(range.startDate, context.timezone)
  const { end } = localDateBounds(range.endDate, context.timezone)
  const nowIso = now.toISOString()
  const observedEnd = end < nowIso ? end : nowIso
  // Native collection began when the business went live. A range wholly before that has nothing native
  // to report, and zeros would read as a business nobody visited; one that straddles it reports from then.
  if (context.analyticsDataStartAt && end <= context.analyticsDataStartAt) {
    throw new HTTPError({ statusCode: 422, statusMessage: `This business's own analytics begin ${context.analyticsDataStartAt}; ${range.startDate} to ${range.endDate} is before them. Earlier periods are in Google Ads, Google Analytics and Search Console.`, data: { code: 'NO_NATIVE_COVERAGE' } })
  }
  const nativeCoverage = context.analyticsDataStartAt && start < context.analyticsDataStartAt ? 'partial' as const : 'full' as const
  const cutoffDate = context.analyticsDataStartAt ? localDateAt(new Date(context.analyticsDataStartAt), context.timezone) : null
  const [slices, sessionStats, returningStats, attributionRows] = await Promise.all([
    loadSlices(db, input.organizationId, range.dates, context.timezone, now, cutoffDate),
    queryFirst<Record<string, unknown>>(db, `SELECT COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT visitor_id) visitors,
      COALESCE(ROUND(AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds END)), 0) avg_duration
      FROM (SELECT session_id, visitor_id, SUM(duration_seconds) duration_seconds FROM analytics_events
        WHERE organization_id = ? AND kind = 'pageview' AND created_at >= ? AND created_at < ?
        GROUP BY session_id, visitor_id)`, [input.organizationId, start, end]),
    queryFirst<{ count: number }>(db, `SELECT COUNT(DISTINCT current.visitor_id) count FROM analytics_events current
      WHERE current.organization_id = ? AND current.kind = 'pageview' AND current.created_at >= ? AND current.created_at < ?
      AND EXISTS (SELECT 1 FROM analytics_events previous INDEXED BY analytics_events_org_visitor_idx WHERE previous.organization_id = current.organization_id
        AND previous.kind = 'pageview' AND previous.visitor_id = current.visitor_id
        AND previous.session_id <> current.session_id AND previous.created_at < ?)`, [input.organizationId, start, end, start]),
    // Sessions and their converting sessions are counted over the same population: each session
    // grouped by its current last touch, converting when it has an outcome event in the range.
    queryAll<Record<string, unknown>>(db, `SELECT source, medium, campaign, content, COUNT(*) sessions,
        SUM(EXISTS (SELECT 1 FROM analytics_events e WHERE e.kind = 'conversion' AND e.organization_id = facts.organization_id AND e.session_id = facts.session_id
          AND e.created_at >= ? AND e.created_at < ? AND (e.payload_json ->> '$.event_name') IN (${OUTCOME_EVENT_SQL_LIST}))) converting,
        COALESCE(SUM((SELECT COUNT(*) FROM analytics_events e WHERE e.kind = 'conversion' AND e.organization_id = facts.organization_id AND e.session_id = facts.session_id
          AND e.created_at >= ? AND e.created_at < ? AND (e.payload_json ->> '$.event_name') IN (${OUTCOME_EVENT_SQL_LIST}))), 0) outcome_events
      FROM (${sessionFactsSql('?', `SELECT DISTINCT session_id FROM analytics_events
        WHERE organization_id = ? AND kind = 'pageview' AND created_at >= ? AND created_at < ?`)}) facts
      GROUP BY 1,2,3,4`, [start, end, start, end, input.organizationId, input.organizationId, start, end]),
  ])
  const pageViews = slices.reduce((sum, slice) => sum + slice.pageViews, 0)
  const uniqueSessions = n(sessionStats?.sessions)
  const [conversionReport, funnel] = await Promise.all([
    loadConversionReport(db, input.organizationId, { start, end, observedEnd, uniqueSessions, dates: range.dates, timezone: context.timezone }),
    loadFunnel(db, input.organizationId, start, end, { total: uniqueSessions, bySource: attributionRows.map(row => ({ source: String(row.source), medium: String(row.medium), sessions: n(row.sessions) })) }),
  ])
  const previousStart = localDateBounds(range.previousStartDate, context.timezone).start
  const previousAvailable = !context.analyticsDataStartAt || previousStart >= context.analyticsDataStartAt
  let changePercent: number | null = null
  if (previousAvailable) {
    const previousDates = []
    for (let date = range.previousStartDate; date <= range.previousEndDate; date = addLocalDays(date, 1)) previousDates.push(date)
    const previousViews = (await loadSlices(db, input.organizationId, previousDates, context.timezone, now, cutoffDate)).reduce((sum, slice) => sum + slice.pageViews, 0)
    changePercent = previousViews === 0 ? null : Math.round((pageViews - previousViews) / previousViews * 100)
  }

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

  let adSpend: {
    totalSpendMicros: number
    clicks: number
    impressions: number
    conversions: number
    costPerClickMicros: number
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
          range.startDate,
          range.endDate,
        )
        adSpend = {
          totalSpendMicros: summary.costMicros,
          clicks: summary.clicks,
          impressions: summary.impressions,
          conversions: summary.conversions,
          costPerClickMicros: summary.averageCpcMicros,
          error: null,
        }
      }
    } catch (error) {
      adSpend = {
        totalSpendMicros: 0,
        clicks: 0,
        impressions: 0,
        conversions: 0,
        costPerClickMicros: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return analyticsReportSchema.parse({
    period: { startDate: range.startDate, endDate: range.endDate, timezone: context.timezone, analyticsDataStartAt: context.analyticsDataStartAt, nativeCoverage },
    metrics: {
      pageViews,
      uniqueSessions,
      uniqueVisitors: n(sessionStats?.visitors),
      returningVisitors: n(returningStats?.count),
      avgSessionDuration: n(sessionStats?.avg_duration),
      pagesPerSession: uniqueSessions ? Math.round(pageViews / uniqueSessions * 100) / 100 : 0,
      changePercent,
    },
    dailyData: slices.map(slice => ({ date: slice.date, pageViews: slice.pageViews, sessions: slice.sessions, avgDuration: slice.avgDuration })),
    topPages: Array.from(pageMap, ([path, views]) => ({ path, views, percentOfTotal: percent(views) })).sort((a, b) => b.views - a.views).slice(0, 10),
    attribution: attributionRows.map(row => {
      const sessions = n(row.sessions)
      return { source: String(row.source), medium: String(row.medium), campaign: row.campaign ? String(row.campaign) : null, content: row.content ? String(row.content) : null,
        sessions, outcomeEvents: n(row.outcome_events), convertingSessions: n(row.converting), sessionConversionRate: rate(n(row.converting), sessions) }
    }).sort((a, b) => b.sessions - a.sessions),
    ...conversionReport,
    funnel,
    countries: dimensionRows('country').slice(0, 12).map(row => ({ country: row.value, countryCode: row.value, views: row.views, percentOfTotal: percent(row.views) })),
    cities: dimensionRows('city').slice(0, 10).map(row => {
      const [region, countryCode = 'XX'] = row.subvalue.split('|')
      return { city: row.value, region: region || null, countryCode, views: row.views }
    }),
    referrers: dimensionRows('referrer').slice(0, 10).map(row => ({ source: row.value, views: row.views, percentOfTotal: percent(row.views) })),
    devices: dimensionRows('device').map(row => ({ type: row.value, views: row.views, percentOfTotal: percent(row.views) })),
    ...(adSpend ? { adSpend } : {}),
  })
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
