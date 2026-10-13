/* eslint-disable @typescript-eslint/no-explicit-any -- rows are read back as untyped JSON */
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { recordTenantPageview, type TenantPageviewInput } from '../../server/utils/pageview-tracking.ts'
import { measurementOutcome, recordOrganizationConversionEvent } from '../../server/utils/organization-conversions.ts'
import { handleAnalyticsTools } from '../../server/utils/mcp-tools/analytics.ts'
import type { queryOrganizationAnalytics } from '../../server/utils/analytics-query.ts'

const SECRET = 'test-secret'
const ORG = 'org-a'
const OTHER = 'org-b'
const cookieFor = (session: string, visitor: string) => ({ headers: new Headers({ cookie: `kc_session_id=${session}; kc_visitor_id=${visitor}`, 'user-agent': 'Desktop' }) })
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function openDb() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'native-analytics', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  return { runtime, db }
}

// The MCP tool exactly as the executor runs it.
async function mcp(db: unknown, organizationId: string, args: Record<string, unknown>) {
  return await handleAnalyticsTools({ toolName: 'query_organization_analytics', args, organization: { db, organizationId, env: { BETTER_AUTH_SECRET: SECRET } } } as never) as Awaited<ReturnType<typeof queryOrganizationAnalytics>>
}

function pageview(over: Partial<TenantPageviewInput> & { eventId: string; sessionId: string; visitorId: string }): TenantPageviewInput {
  return {
    organizationId: ORG, pagePath: '/', locale: 'en', referrerHost: null, attribution: {}, internalHosts: ['a.example'],
    userAgent: 'Desktop', ipHash: 'h', country: 'th', region: null, city: null, locationId: null, pageId: null, pageType: null, recipe: null,
    now: '2026-09-10T03:00:00.000Z', ...over,
  }
}

test('native analytics: producers → D1 → MCP query contract', { timeout: 120_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    const settings = '{}'
    for (const id of [ORG, OTHER]) await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES (?, ?, ?, ?, ?, 'USD', 'Asia/Bangkok')`).bind(id, id, id, id, settings).run()
    const range = { start_date: '2026-09-10', end_date: '2026-09-12' }

    // Campaign A then B in one session; B partial (campaign only, no source).
    const S1 = uuid(1), V1 = uuid(2)
    await recordTenantPageview(db, pageview({ eventId: uuid(10), sessionId: S1, visitorId: V1, pagePath: '/pricing', attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'A' }, now: '2026-09-10T03:00:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(11), sessionId: S1, visitorId: V1, pagePath: '/th/pricing', sourcePath: '/pricing', locale: 'th', attribution: { utm_campaign: 'B' }, now: '2026-09-10T03:05:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(12), sessionId: S1, visitorId: V1, pagePath: '/ja/pricing', sourcePath: '/pricing', locale: 'ja', now: '2026-09-10T03:06:00.000Z' }))
    // The same pageview delivered twice changes nothing.
    await recordTenantPageview(db, pageview({ eventId: uuid(11), sessionId: S1, visitorId: V1, pagePath: '/th/pricing', sourcePath: '/pricing', locale: 'th', attribution: { utm_campaign: 'C' }, now: '2026-09-10T04:00:00.000Z' }))

    const events = await mcp(db, ORG, { mode: 'events', ...range, sort: 'occurred_at_asc' })
    assert.equal(events.rows.length, 3)
    const byId = new Map(events.rows.map(row => [row.event_id as string, row]))
    const snap = (id: string) => (byId.get(id) as Record<string, any>).attribution.snapshot
    assert.equal(snap(uuid(10)).campaign, 'A')
    assert.equal(snap(uuid(11)).campaign, 'B', 'the event keeps the campaign it carried, and a duplicate rewrites nothing')
    assert.equal(snap(uuid(11)).source, '(not set)', 'a partial touch is kept as a touch with unknown source')
    assert.equal(snap(uuid(12)).campaign, 'B', 'an untouched later visit inherits the touch in force at that moment')
    const observed = await mcp(db, ORG, { mode: 'events', ...range, attribution_basis: 'observed', filters: { campaign: 'B' } })
    assert.equal(observed.rows.length, 1, 'observed attribution is only what the event itself carried')
    const prefix = await mcp(db, ORG, { mode: 'events', ...range, attribution_basis: 'observed', filters: { campaign_prefix: 'B' } })
    assert.deepEqual(prefix.rows, observed.rows)
    assert.equal((await mcp(db, ORG, { mode: 'events', ...range, filters: { campaign_prefix: '%' } })).rows.length, 0, 'prefixes are literal, not SQL wildcards')

    // Session last touch is a derived view; it does not rewrite A's event.
    const sessions = await mcp(db, ORG, { mode: 'sessions', ...range })
    assert.equal(sessions.rows.length, 1)

    // Interactions: same id once, new id twice; no session cookie → none minted.
    const view = { organizationId: ORG, eventName: 'product_view', stage: 'viewed', surface: 'website', entityType: 'product', entityId: 'prod-1', productId: 'prod-1', originEventId: uuid(11), pagePath: '/th/pricing' } as const
    const at = (occurredAt: string) => ({ occurredAt })
    const a = await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, id: uuid(20), ...at('2026-09-10T03:06:00.000Z') })
    const b = await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, id: uuid(20), ...at('2026-09-10T03:06:00.000Z') })
    const c = await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, id: uuid(21), ...at('2026-09-10T03:07:00.000Z') })
    assert.deepEqual([a.created, b.created, c.created], [true, false, true])
    // The submission response names the native event a GA projection may mirror; a failure names none.
    assert.deepEqual(measurementOutcome({ status: 'fulfilled', value: a }), { status: 'recorded', event_id: uuid(20) })
    assert.deepEqual(measurementOutcome({ status: 'rejected', reason: new Error('quote unresolved') }), { status: 'failed', reason: 'quote unresolved' })
    await assert.rejects(recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, organizationId: OTHER, id: uuid(20) }), /another organization/)
    const views = await mcp(db, ORG, { mode: 'events', ...range, filters: { event_name: 'product_view' } })
    assert.equal(views.rows.length, 2)
    const first = views.rows.find(row => row.event_id === uuid(20)) as Record<string, any>
    assert.equal(first.page.locale, 'th', 'the interaction carries the origin visit language')
    assert.equal(first.attribution.snapshot.campaign, 'B', 'the interaction carries the origin visit snapshot, not the session as it later became')
    assert.equal(first.kind, 'interaction')

    // An origin reference from another visitor is dropped: the context stays unknown.
    const foreign = await recordOrganizationConversionEvent(db, cookieFor(uuid(3), uuid(4)), { ...view, id: uuid(22), originEventId: uuid(11), ...at('2026-09-10T03:08:00.000Z') })
    assert.ok(foreign.created)
    const foreignRow = (await mcp(db, ORG, { mode: 'events', ...range, filters: { event_name: 'product_view', session_id: uuid(3) } })).rows[0] as Record<string, any>
    assert.equal(foreignRow.page.locale ?? null, null)

    // Outcomes: a contact with origin context; a priced booking; a purchase and refund in two currencies.
    await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { organizationId: ORG, eventName: 'contact_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: 'req-1', originEventId: uuid(11), pagePath: '/th/contact', occurredAt: '2026-09-10T03:10:00.000Z' })
    await recordOrganizationConversionEvent(db, null, { organizationId: ORG, eventName: 'booking_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: 'req-2', pageType: 'product', occurredAt: '2026-09-10T03:11:00.000Z', value: { basis: 'quoted', amount_minor: 240000, currency: 'THB' } })
    const money = (id: string, currency: string, amount: number) => ({ organizationId: ORG, eventName: 'purchase', stage: 'completed', surface: 'stripe', entityType: 'invoice', entityId: id, occurredAt: '2026-09-11T03:00:00.000Z', value: { basis: 'purchase', amount_minor: amount, collected_minor: amount, currency, transaction_id: id } }) as const
    await recordOrganizationConversionEvent(db, null, money('in_1', 'USD', 4900))
    await recordOrganizationConversionEvent(db, null, money('in_2', 'THB', 170000))
    await recordOrganizationConversionEvent(db, null, { organizationId: ORG, eventName: 'refund', stage: 'completed', surface: 'stripe', entityType: 'refund', entityId: 're_1', occurredAt: '2026-09-11T05:00:00.000Z', value: { basis: 'refund', amount_minor: 1000, collected_minor: 1000, currency: 'USD', transaction_id: 'in_1' } })

    const outcomes = await mcp(db, ORG, { mode: 'breakdown', ...range, dimensions: ['currency'], metrics: ['purchase_value_minor', 'refunded_minor', 'net_collected_minor'], filters: { kind: 'conversion' } })
    const usd = outcomes.rows.find(row => row.dimensions.currency === 'USD') as Record<string, any>
    const thb = outcomes.rows.find(row => row.dimensions.currency === 'THB') as Record<string, any>
    assert.equal(usd.metrics.net_collected_minor, 3900)
    assert.equal(thb.metrics.purchase_value_minor, 170000)
    assert.equal(thb.metrics.refunded_minor, 0, 'currencies are never summed together')

    // Contact carries the origin visit context and the outcome rate is labeled.
    const contact = (await mcp(db, ORG, { mode: 'events', ...range, filters: { event_name: 'contact_submit' } })).rows[0] as Record<string, any>
    assert.equal(contact.page.locale, 'th')
    const rate = await mcp(db, ORG, { mode: 'breakdown', ...range, dimensions: ['campaign'], metrics: ['eligible_sessions', 'converting_sessions', 'session_conversion_rate'], outcome_event: 'contact_submit' })
    assert.deepEqual([...rate.rows].sort((a, b) => String(a.dimensions.campaign).localeCompare(String(b.dimensions.campaign))), [
      { dimensions: { campaign: 'A' }, metrics: { eligible_sessions: 1, converting_sessions: 1, session_conversion_rate: 100 } },
      { dimensions: { campaign: 'B' }, metrics: { eligible_sessions: 1, converting_sessions: 1, session_conversion_rate: 100 } },
      { dimensions: { campaign: null }, metrics: { eligible_sessions: 0, converting_sessions: 0, session_conversion_rate: null } },
    ])
    assert.match(rate.totals.session_conversion_rate!.unit, /converting sessions \/ eligible sessions/)

    // Pagination across the page limit: 130 more events, page size 50, traverse without loss or duplicates.
    const S2 = uuid(500), V2 = uuid(501)
    for (let i = 0; i < 130; i++) {
      await recordTenantPageview(db, pageview({ eventId: uuid(1000 + i), sessionId: S2, visitorId: V2, pagePath: `/p${i % 7}`, now: `2026-09-11T${String(1 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z` }))
    }
    const total = await mcp(db, ORG, { mode: 'events', ...range, limit: 200 })
    assert.equal(total.rows.length, 141)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await mcp(db, ORG, { mode: 'events', ...range, limit: 50, ...(cursor ? { cursor } : {}) })
      seen.push(...page.rows.map(row => row.event_id as string))
      cursor = page.next_cursor
      pages += 1
    } while (cursor)
    assert.equal(new Set(seen).size, seen.length, 'no duplicate across pages')
    assert.deepEqual([...seen].sort(), total.rows.map(row => row.event_id as string).sort(), 'pagination reads every event exactly once')
    assert.equal(pages, 3)

    // Tamper, cross-query and cross-tenant cursors are rejected.
    const firstPage = await mcp(db, ORG, { mode: 'events', ...range, limit: 50 })
    const cursorValue = firstPage.next_cursor!
    await assert.rejects(mcp(db, ORG, { mode: 'events', ...range, limit: 50, cursor: `${cursorValue.slice(0, -2)}xx` }), /cursor/i)
    await assert.rejects(mcp(db, ORG, { mode: 'events', ...range, limit: 50, filters: { locale: 'th' }, cursor: cursorValue }), /query/i)
    await assert.rejects(mcp(db, OTHER, { mode: 'events', ...range, limit: 50, cursor: cursorValue }), /organization/i)
    await assert.rejects(mcp(db, ORG, { mode: 'events', ...range, filters: { sql: '1=1' } }), /Unknown filter/)

    // Exact distinct counts by locale across the Bangkok midnight boundary (17:00Z).
    const S3 = uuid(900), V3 = uuid(901)
    await recordTenantPageview(db, pageview({ eventId: uuid(910), sessionId: S3, visitorId: V3, locale: 'th', pagePath: '/th/x', sourcePath: '/x', now: '2026-09-11T16:59:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(911), sessionId: S3, visitorId: V3, locale: 'th', pagePath: '/th/y', sourcePath: '/y', now: '2026-09-11T17:01:00.000Z' }))
    const across = await mcp(db, ORG, { mode: 'breakdown', ...range, dimensions: ['locale'], metrics: ['sessions', 'page_views'], filters: { session_id: S3 } })
    assert.deepEqual(across.rows.map((row: any) => [row.dimensions.locale, row.metrics.sessions, row.metrics.page_views]), [['th', 1, 2]])
    const perDay = await mcp(db, ORG, { mode: 'breakdown', ...range, dimensions: ['device'], metrics: ['sessions'], filters: { session_id: S3 } })
    assert.equal(perDay.totals.sessions!.value, 1, 'a session spanning midnight is one distinct session over the range')

    // Coverage describes the whole native history; nothing is expired.
    const coverage = events.coverage as Record<string, any>
    assert.equal(coverage.event_history.oldest_pageview_at, '2026-09-10T03:00:00.000Z')
    assert.equal(coverage.requested_range.pageview_detail_complete, undefined)
    assert.equal(coverage.event_detail, undefined)

    // A tenant never reads another tenant's events.
    assert.equal((await mcp(db, OTHER, { mode: 'events', ...range })).rows.length, 0)
  } finally {
    await runtime.dispose()
  }
})

test('native analytics: rates share one population, cursors survive attribution changes, summaries page completely, origins keep their own path and context', { timeout: 120_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    const settings = '{}'
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES (?, ?, ?, ?, ?, 'USD', 'Asia/Bangkok')`).bind(ORG, ORG, ORG, ORG, settings).run()
    const day2 = { start_date: '2026-09-11', end_date: '2026-09-11' }

    // Two sessions view a page just before Bangkok midnight (17:00Z) and convert just after; a third only views after midnight.
    const conv = async (n: number) => {
      const session = uuid(2000 + n), visitor = uuid(3000 + n)
      await recordTenantPageview(db, pageview({ eventId: uuid(4000 + n), sessionId: session, visitorId: visitor, now: '2026-09-11T16:58:00.000Z' }))
      await recordOrganizationConversionEvent(db, cookieFor(session, visitor), { organizationId: ORG, eventName: 'contact_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: `req-${n}`, originEventId: uuid(4000 + n), occurredAt: '2026-09-11T17:02:00.000Z' })
    }
    await conv(1); await conv(2)
    await recordTenantPageview(db, pageview({ eventId: uuid(4100), sessionId: uuid(2100), visitorId: uuid(3100), now: '2026-09-11T17:05:00.000Z' }))
    const day3 = { start_date: '2026-09-12', end_date: '2026-09-12' }
    const rate = await mcp(db, ORG, { mode: 'breakdown', ...day3, dimensions: ['device'], metrics: ['eligible_sessions', 'converting_sessions', 'session_conversion_rate'], outcome_event: 'contact_submit' })
    assert.deepEqual((rate.rows[0] as any).metrics, { eligible_sessions: 1, converting_sessions: 0, session_conversion_rate: 0 }, 'sessions that only viewed before the range are not counted as converting in it')
    const both = await mcp(db, ORG, { mode: 'breakdown', start_date: '2026-09-11', end_date: '2026-09-12', dimensions: ['device'], metrics: ['eligible_sessions', 'converting_sessions', 'session_conversion_rate'], outcome_event: 'contact_submit' })
    assert.deepEqual((both.rows[0] as any).metrics, { eligible_sessions: 3, converting_sessions: 2, session_conversion_rate: 100 * 2 / 3 })
    await assert.rejects(mcp(db, ORG, { mode: 'breakdown', ...day3, dimensions: ['device'], metrics: ['session_conversion_rate'], outcome_event: 'contact_submit', filters: { kind: 'conversion' } }), /pageview/)
    await assert.rejects(mcp(db, ORG, { mode: 'breakdown', ...day3, dimensions: ['device'], metrics: ['session_conversion_rate'], outcome_event: 'contact_submit', filters: { stage: 'submitted' } }), /only outcome events carry/)

    // A verified origin keeps its own public path and its own (empty) attribution, whatever the session became.
    const S = uuid(5000), V = uuid(5001)
    await recordTenantPageview(db, pageview({ eventId: uuid(5010), sessionId: S, visitorId: V, pagePath: '/th/contact', sourcePath: '/contact', locale: 'th', now: '2026-09-11T02:00:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(5011), sessionId: S, visitorId: V, pagePath: '/pricing', attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'B' }, now: '2026-09-11T02:05:00.000Z' }))
    await recordOrganizationConversionEvent(db, cookieFor(S, V), { organizationId: ORG, eventName: 'contact_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: 'req-th', originEventId: uuid(5010), routePath: '/contact', occurredAt: '2026-09-11T02:10:00.000Z' })
    const th = await mcp(db, ORG, { mode: 'events', ...day2, filters: { event_name: 'contact_submit', path_prefix: '/th/' } })
    assert.equal(th.rows.length, 1, 'the conversion carries the visited /th/contact path')
    const row = th.rows[0] as Record<string, any>
    assert.equal(row.page.path, '/th/contact')
    assert.equal(row.page.locale, 'th')
    assert.equal(row.attribution.snapshot, null, 'the visit had no attribution; the later campaign is not its context')
    assert.equal(row.attribution.basis, 'none')

    // Pagination by session_last_touch is stable while a session's touch changes between pages.
    const P = uuid(6000)
    const touch = (n: number, session: string, campaign: string | null, at: string) => recordTenantPageview(db, pageview({ eventId: uuid(6100 + n), sessionId: session, visitorId: uuid(6500 + n), pagePath: `/t${n}`, attribution: campaign ? { utm_source: 'x', utm_medium: 'y', utm_campaign: campaign } : {}, now: at }))
    await touch(1, P, 'A', '2026-09-10T03:00:00.000Z')
    await touch(2, P, null, '2026-09-10T03:01:00.000Z') // inherits A
    const Q = uuid(6001)
    await touch(3, Q, 'B', '2026-09-10T03:02:00.000Z')
    const request = { mode: 'breakdown', start_date: '2026-09-10', end_date: '2026-09-10', dimensions: ['campaign'], metrics: ['page_views'], attribution_basis: 'session_last_touch', filters: { kind: 'pageview', source: 'x' }, limit: 1 }
    const first = await mcp(db, ORG, request)
    assert.equal((first.rows[0] as any).dimensions.campaign, 'A')
    // Session P receives a new B touch after the first page was read.
    await touch(4, P, 'B', '2026-09-10T03:10:00.000Z')
    const second = await mcp(db, ORG, { ...request, cursor: first.next_cursor })
    assert.deepEqual((second.rows[0] as any).dimensions.campaign, 'B')
    assert.equal((second.rows[0] as any).metrics.page_views, 1, 'B is read as it stood at the first page: only its own session, not the moved events')
    assert.equal(second.next_cursor, null)

    // Retained daily summaries: complete, paginated, older than the raw window, at their own grain.
    for (let i = 0; i < 5; i++) {
      await recordTenantPageview(db, pageview({ eventId: uuid(7000 + i), sessionId: uuid(7100), visitorId: uuid(7101), pagePath: `/old${i}`, now: '2026-06-01T03:00:00.000Z' }))
    }
    const { aggregateOrganizationAnalyticsDate } = await import('../../server/utils/analytics-report.ts')
    await aggregateOrganizationAnalyticsDate(db, ORG, '2026-06-01')
    const readSummaries = async (filters: Record<string, string>) => {
      const rows: any[] = []
      let cursor: string | null = null
      do {
        const page = await mcp(db, ORG, { mode: 'daily_summaries', start_date: '2026-06-01', end_date: '2026-06-01', filters, limit: 2, ...(cursor ? { cursor } : {}) })
        rows.push(...page.rows); cursor = page.next_cursor
        assert.equal((page.coverage as any).summary_source.table, 'analytics_summaries')
      } while (cursor)
      return rows
    }
    const pages = await readSummaries({ summary_kind: 'page_day' })
    assert.deepEqual(pages.map(r => r.page_path), ['/old0', '/old1', '/old2', '/old3', '/old4'])
    assert.ok(pages.every(r => r.metrics.page_views === 1))
    assert.equal((await readSummaries({ summary_kind: 'organization_day' }))[0].metrics.page_views, 5)
    assert.deepEqual((await readSummaries({ summary_kind: 'dimension_day', dimension: 'device' }))
      .map(row => ({ device: row.value, pageViews: row.metrics.page_views })), [{ device: 'Desktop', pageViews: 5 }])
    // The raw events of that old day are still there, next to the summary of them.
    const oldEvents = await mcp(db, ORG, { mode: 'events', start_date: '2026-06-01', end_date: '2026-06-01' })
    assert.equal(oldEvents.rows.length, 5)
    // A summary rewritten between pages makes the cursor stale instead of skipping rows.
    const firstSummary = await mcp(db, ORG, { mode: 'daily_summaries', start_date: '2026-06-01', end_date: '2026-06-01', filters: { summary_kind: 'page_day' }, limit: 2 })
    await aggregateOrganizationAnalyticsDate(db, ORG, '2026-06-01')
    await assert.rejects(mcp(db, ORG, { mode: 'daily_summaries', start_date: '2026-06-01', end_date: '2026-06-01', filters: { summary_kind: 'page_day' }, limit: 2, cursor: firstSummary.next_cursor }), /rewritten/)
    await assert.rejects(mcp(db, ORG, { mode: 'daily_summaries', start_date: '2026-06-01', end_date: '2026-06-01' }), /summary_kind/)
  } finally {
    await runtime.dispose()
  }
})
