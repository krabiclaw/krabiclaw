import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { recordTenantPageview, updateTenantPageviewDuration, type TenantPageviewInput } from '../../server/utils/pageview-tracking.ts'
import { aggregateOrganizationAnalyticsDate, getAnalyticsReport } from '../../server/utils/analytics-report.ts'
import { queryOrganizationAnalytics } from '../../server/utils/analytics-query.ts'

test('analytics preserves duplicate, attribution, summary semantics on D1', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'analytics-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, analytics_data_start_at, default_currency, timezone)
      VALUES ('org-proof', 'Proof', 'proof', 'proof', '{}', '2026-09-04T17:00:00.000Z', 'USD', 'Asia/Bangkok')`).run()
    const input: TenantPageviewInput = {
      eventId: 'event-first', organizationId: 'org-proof', pagePath: '/menu', locale: 'en',
      referrerHost: 'google.com', attribution: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'first' },
      internalHosts: ['proof.example'], userAgent: 'Desktop', ipHash: 'proof-hash', sessionId: 'session-first',
      visitorId: 'visitor', country: 'th', region: 'Krabi', city: 'Krabi', locationId: null,
      pageId: null, pageType: 'menu', recipe: null, now: '2026-09-05T02:00:00.000Z',
    }
    await Promise.all([recordTenantPageview(db, input), recordTenantPageview(db, input)])
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE kind = 'pageview'").first('count(*)'), 1)
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_summaries WHERE kind = 'session'").first('count(*)'), 1)
    await recordTenantPageview(db, { ...input, eventId: 'event-direct', referrerHost: null, attribution: {}, now: '2026-09-05T02:01:00.000Z' })
    assert.equal(await db.prepare("SELECT json_extract(payload_json, '$.attribution.campaign') campaign FROM analytics_summaries WHERE kind = 'session'").first('campaign'), 'first')
    await recordTenantPageview(db, { ...input, eventId: 'event-new-touch', attribution: { utm_source: 'newsletter', utm_medium: 'email' }, now: '2026-09-05T02:02:00.000Z' })
    const attribution = await db.prepare("SELECT json_extract(payload_json, '$.attribution') attribution FROM analytics_summaries WHERE kind = 'session'").first<string>('attribution')
    assert(attribution)
    assert.deepEqual(JSON.parse(attribution), { source: 'newsletter', medium: 'email', campaign: null, term: null, content: null,
      referrerHost: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null })
    await Promise.all([
      updateTenantPageviewDuration(db, { eventId: 'event-first', organizationId: 'org-proof', sessionId: 'session-first', durationSeconds: 12, now: input.now }),
      updateTenantPageviewDuration(db, { eventId: 'event-direct', organizationId: 'org-proof', sessionId: 'session-first', durationSeconds: 8, now: input.now }),
    ])
    assert.equal(await db.prepare("SELECT json_extract(payload_json, '$.duration_seconds') duration FROM analytics_summaries WHERE kind = 'session'").first('duration'), 20)
    await recordTenantPageview(db, { ...input, eventId: 'returning', sessionId: 'returning-session', now: '2026-09-06T02:00:00.000Z' })
    const period = { organizationId: 'org-proof', startDate: '2026-09-05', endDate: '2026-09-06', now: new Date('2026-09-06T12:00:00Z') }
    // The business's own analytics began at local midnight on September 5: a range before then has
    // nothing native to report, and one that starts earlier reports from that moment.
    await assert.rejects(getAnalyticsReport(db, { ...period, startDate: '2026-08-01', endDate: '2026-09-04' }), (error: { statusCode?: number; data?: { code?: string } }) =>
      error.statusCode === 422 && error.data?.code === 'NO_NATIVE_COVERAGE')
    assert.equal((await getAnalyticsReport(db, { ...period, startDate: '2026-09-01' })).period.nativeCoverage, 'partial')
    assert.equal((await getAnalyticsReport(db, period)).period.nativeCoverage, 'full')
    const before = await getAnalyticsReport(db, period)
    assert.equal(before.metrics.pageViews, 4)
    assert.equal(before.metrics.uniqueSessions, 2)
    assert.equal(before.countries[0]?.countryCode, 'TH')
    for (const date of ['2026-09-05', '2026-09-06']) await aggregateOrganizationAnalyticsDate(db, 'org-proof', date)
    assert.equal(await db.prepare(`SELECT json_extract(payload_json, '$.returning_visitors') returning_count
      FROM analytics_summaries WHERE organization_id = 'org-proof' AND kind = 'organization_day' AND date = '2026-09-06'`).first('returning_count'), 1)
    const after = await getAnalyticsReport(db, period)
    assert.deepEqual(after, before)
    await aggregateOrganizationAnalyticsDate(db, 'org-proof', '2026-09-05')
    assert.deepEqual(await getAnalyticsReport(db, period), before)
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_summaries WHERE kind = 'session'").first('count(*)'), 2)
    const conversion = JSON.stringify({ event_name: 'contact_submit', stage: 'submitted', entity_type: 'request', entity_id: 'request-proof',
      attributed_at: '2026-09-05T18:03:00.000Z', attribution: { source: 'google', medium: 'cpc', campaign: 'first' } })
    const insert = "INSERT OR IGNORE INTO analytics_events (id, kind, organization_id, session_id, visitor_id, payload_json, created_at) VALUES (?, 'conversion', 'org-proof', 'session-first', 'visitor', ?, '2026-09-05T18:03:00.000Z')"
    await Promise.all(['conversion-first', 'conversion-duplicate'].map(id => db.prepare(insert).bind(id, conversion).run()))
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE kind = 'conversion'").first('count(*)'), 1)
    assert.deepEqual((await getAnalyticsReport(db, period)).conversions, [{
      eventName: 'contact_submit', stage: 'submitted', conversionType: null, events: 1,
      distinctEntities: 1, convertingSessions: 1, nonbrowserEvents: 0, sessionConversionRate: 50,
    }])
    assert.deepEqual((await getAnalyticsReport(db, period)).dailyConversions, [
      { date: '2026-09-05', events: 0 },
      { date: '2026-09-06', events: 1 },
    ])
    assert.equal((await getAnalyticsReport(db, { ...period, now: new Date('2029-01-06T12:00:00Z') })).metrics.pageViews, 4)
    // Historical collector rows have session/visitor IDs but predate session summaries.
    await db.prepare(`INSERT INTO analytics_events (id, kind, organization_id, session_id, visitor_id, page_path, payload_json, created_at)
      VALUES ('historical-view', 'pageview', 'org-proof', 'historical-session', 'historical-visitor', '/menu', '{}', '2026-09-05T03:00:00.000Z')`).run()
    const historical = await getAnalyticsReport(db, period)
    assert.equal(historical.metrics.uniqueSessions, 3)
    assert.equal(historical.metrics.uniqueVisitors, 2)
    assert.equal(historical.attribution.find(row => row.source === 'Attribution not recorded')?.sessions, 1)
  } finally { await runtime.dispose() }
})

test('distinct-entity counts agree between report and query and never synthesize entities for absent references', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'analytics-entity-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, analytics_data_start_at, default_currency, timezone)
      VALUES ('org-entity', 'Entity Proof', 'entity-proof', 'entity-proof', '{}', '2026-09-04T17:00:00.000Z', 'USD', 'Asia/Bangkok')`).run()

    // 50 checkout_start events: 49 without entity reference, 1 referencing a product.
    // 39 distinct sessions.
    const insert = "INSERT INTO analytics_events (id, kind, organization_id, session_id, visitor_id, payload_json, created_at) VALUES (?, 'conversion', 'org-entity', ?, 'visitor', ?, '2026-09-05T12:00:00.000Z')"
    for (let i = 1; i <= 49; i++) {
      const sessionId = `session-${(i % 39) + 1}`
      const payload = JSON.stringify({ event_name: 'checkout_start', stage: 'started', entity_type: null, entity_id: null, attribution: null, attributed_at: null })
      await db.prepare(insert).bind(`checkout-${i}`, sessionId, payload).run()
    }
    await db.prepare(insert).bind('checkout-50', 'session-1', JSON.stringify({ event_name: 'checkout_start', stage: 'started', entity_type: 'product', entity_id: 'prod-single', attribution: null, attributed_at: null })).run()

    const period = { organizationId: 'org-entity', startDate: '2026-09-05', endDate: '2026-09-05', now: new Date('2026-09-06T12:00:00Z') }
    const report = await getAnalyticsReport(db, period)
    const conversion = report.conversions.find(c => c.eventName === 'checkout_start')
    assert.ok(conversion)
    assert.equal(conversion.events, 50)
    assert.equal(conversion.distinctEntities, 1)
    assert.equal(conversion.convertingSessions, 39)

    const query = await queryOrganizationAnalytics(db, {
      organizationId: 'org-entity',
      mode: 'breakdown',
      startDate: '2026-09-05',
      endDate: '2026-09-05',
      filters: { event_name: 'checkout_start' },
      dimensions: ['event_name'],
      metrics: ['events', 'entities', 'sessions'],
    })
    assert.equal(query.rows.length, 1)
    const metrics = query.rows[0]?.metrics as { events: number; entities: number; sessions: number }
    assert.equal(metrics.events, 50)
    assert.equal(metrics.entities, 1)
    assert.equal(metrics.sessions, 39)

    // Events with no entity references retain event count and yield 0 distinct entities across both tools
    await db.prepare("DELETE FROM analytics_events WHERE id = 'checkout-50'").run()
    await db.prepare(insert).bind('checkout-50', 'session-1', JSON.stringify({ event_name: 'checkout_start', stage: 'started', entity_type: null, entity_id: null, attribution: null, attributed_at: null })).run()

    const reportNoEntities = await getAnalyticsReport(db, period)
    const conversionNoEntities = reportNoEntities.conversions.find(c => c.eventName === 'checkout_start')
    assert.ok(conversionNoEntities)
    assert.equal(conversionNoEntities.events, 50)
    assert.equal(conversionNoEntities.distinctEntities, 0)

    const queryNoEntities = await queryOrganizationAnalytics(db, {
      organizationId: 'org-entity',
      mode: 'breakdown',
      startDate: '2026-09-05',
      endDate: '2026-09-05',
      filters: { event_name: 'checkout_start' },
      dimensions: ['event_name'],
      metrics: ['events', 'entities', 'sessions'],
    })
    const metricsNoEntities = queryNoEntities.rows[0]?.metrics as { events: number; entities: number; sessions: number }
    assert.equal(metricsNoEntities.events, 50)
    assert.equal(metricsNoEntities.entities, 0)

    // Different entity types sharing the same entity_id count as distinct entities
    await db.prepare("DELETE FROM analytics_events").run()
    await db.prepare(insert).bind('order-event', 'session-1', JSON.stringify({ event_name: 'purchase', stage: 'occurred', entity_type: 'order', entity_id: 'shared-id', value: { basis: 'purchase', currency: 'USD', amount_minor: 1000, collected_minor: 1000 }, attribution: { source: 'google', medium: 'cpc' }, attributed_at: '2026-09-05T12:00:00.000Z' })).run()
    await db.prepare(insert).bind('product-event', 'session-1', JSON.stringify({ event_name: 'purchase', stage: 'occurred', entity_type: 'product', entity_id: 'shared-id', value: { basis: 'purchase', currency: 'USD', amount_minor: 1000, collected_minor: 1000 }, attribution: { source: 'google', medium: 'cpc' }, attributed_at: '2026-09-05T12:00:00.000Z' })).run()

    const reportSharedId = await getAnalyticsReport(db, period)
    const conversionSharedId = reportSharedId.conversions.find(c => c.eventName === 'purchase')
    assert.ok(conversionSharedId)
    assert.equal(conversionSharedId.events, 2)
    assert.equal(conversionSharedId.distinctEntities, 2)

    const outcomeSharedId = reportSharedId.outcomeAttribution.find(o => o.eventName === 'purchase')
    assert.ok(outcomeSharedId)
    assert.equal(outcomeSharedId.events, 2)
    assert.equal(outcomeSharedId.distinctEntities, 2)

    const querySharedId = await queryOrganizationAnalytics(db, {
      organizationId: 'org-entity',
      mode: 'breakdown',
      startDate: '2026-09-05',
      endDate: '2026-09-05',
      filters: { event_name: 'purchase' },
      dimensions: ['event_name'],
      metrics: ['events', 'entities'],
    })
    const metricsSharedId = querySharedId.rows[0]?.metrics as { events: number; entities: number }
    assert.equal(metricsSharedId.events, 2)
    assert.equal(metricsSharedId.entities, 2)
  } finally {
    await runtime.dispose()
  }
})
