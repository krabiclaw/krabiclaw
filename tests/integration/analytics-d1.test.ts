import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { recordTenantPageview, updateTenantPageviewDuration, type TenantPageviewInput } from '../../server/utils/pageview-tracking.ts'
import { queryOrganizationAnalytics } from '../../server/utils/analytics-query.ts'

async function database(name: string) {
  const runtime = new Miniflare({ workers: [{ config: {
    name, compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  return { runtime, db }
}

test('the visit write keeps sessions and adds each new visit to its local day counts once', { timeout: 60_000 }, async () => {
  const { runtime, db } = await database('analytics-proof')
  try {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, analytics_data_start_at, default_currency, timezone)
      VALUES ('org-proof', 'Proof', 'proof', 'proof', '{}', '2026-09-04T17:00:00.000Z', 'USD', 'Asia/Bangkok')`).run()
    const input: TenantPageviewInput = {
      eventId: 'event-first', organizationId: 'org-proof', timezone: 'Asia/Bangkok', pagePath: '/menu', locale: 'en',
      referrerHost: 'google.com', attribution: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'first' },
      internalHosts: ['proof.example'], userAgent: 'Desktop', ipHash: 'proof-hash', sessionId: 'session-first',
      visitorId: 'visitor', country: 'th', region: 'Krabi', city: 'Krabi', locationId: null,
      pageId: null, pageType: 'menu', recipe: null, now: '2026-09-05T02:00:00.000Z',
    }
    // The same event delivered twice at once is one event, one session and one count.
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

    // An offering's page is counted for the offering too. A second session that arrives with no
    // touch is a direct visit. 23:59:59 in Krabi is still September 5; one second later is the 6th.
    await recordTenantPageview(db, { ...input, eventId: 'offering-view', sessionId: 'session-direct', referrerHost: null, attribution: {}, pagePath: '/experiences/boat',
      productId: 'product-boat', now: '2026-09-05T16:59:59.000Z' })
    await recordTenantPageview(db, { ...input, eventId: 'next-day', sessionId: 'session-direct', referrerHost: null, attribution: {}, pagePath: '/experiences/boat',
      productId: 'product-boat', now: '2026-09-05T17:00:00.000Z' })
    // A duplicate of an earlier event, delivered later, adds nothing.
    await recordTenantPageview(db, { ...input, now: '2026-09-05T03:00:00.000Z' })
    // A deferred delivery is counted on the day it happened.
    await recordTenantPageview(db, { ...input, eventId: 'deferred', sessionId: 'session-deferred', occurredAt: '2026-09-05T05:00:00.000Z', now: '2026-09-06T04:00:00.000Z' })

    const counts = await db.prepare(`SELECT kind, date, key, CAST(payload_json ->> '$.page_views' AS INTEGER) AS views FROM analytics_summaries
      WHERE organization_id = 'org-proof' AND kind <> 'session' ORDER BY kind, date, key`).all<{ kind: string; date: string; key: string; views: number }>()
    assert.deepEqual(counts.results, [
      { kind: 'dimension_day', date: '2026-09-05', key: '["product","product-boat",""]', views: 1 },
      { kind: 'dimension_day', date: '2026-09-05', key: '["visit_source","Direct",""]', views: 1 },
      { kind: 'dimension_day', date: '2026-09-05', key: '["visit_source","Google Ads",""]', views: 2 },
      { kind: 'dimension_day', date: '2026-09-05', key: '["visit_source","Other",""]', views: 0 },
      { kind: 'dimension_day', date: '2026-09-06', key: '["product","product-boat",""]', views: 1 },
      { kind: 'dimension_day', date: '2026-09-06', key: '["visit_source","Direct",""]', views: 0 },
      { kind: 'organization_day', date: '2026-09-05', key: '', views: 5 },
      { kind: 'organization_day', date: '2026-09-06', key: '', views: 1 },
      { kind: 'page_day', date: '2026-09-05', key: '/experiences/boat', views: 1 },
      { kind: 'page_day', date: '2026-09-05', key: '/menu', views: 4 },
      { kind: 'page_day', date: '2026-09-06', key: '/experiences/boat', views: 1 },
    ])
    // Countries, cities, devices and referrers are kept on each event and counted nowhere else.
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_summaries WHERE kind = 'dimension_day' AND (key ->> '$[0]') IN ('country', 'city', 'device', 'referrer')").first('count(*)'), 0)
    assert.equal(await db.prepare("SELECT json_extract(payload_json, '$.country') AS country FROM analytics_events WHERE id = 'event-first'").first('country'), 'th')
  } finally { await runtime.dispose() }
})

test('distinct-entity counts never synthesize entities for absent references', { timeout: 60_000 }, async () => {
  const { runtime, db } = await database('analytics-entity-proof')
  try {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, analytics_data_start_at, default_currency, timezone)
      VALUES ('org-entity', 'Entity Proof', 'entity-proof', 'entity-proof', '{}', '2026-09-04T17:00:00.000Z', 'USD', 'Asia/Bangkok')`).run()

    // 50 checkout_start events: 49 without entity reference, 1 referencing a product. 39 distinct sessions.
    const insert = "INSERT INTO analytics_events (id, kind, organization_id, session_id, visitor_id, payload_json, created_at) VALUES (?, 'conversion', 'org-entity', ?, 'visitor', ?, '2026-09-05T12:00:00.000Z')"
    for (let i = 1; i <= 49; i++) {
      const payload = JSON.stringify({ event_name: 'checkout_start', stage: 'started', entity_type: null, entity_id: null, attribution: null, attributed_at: null })
      await db.prepare(insert).bind(`checkout-${i}`, `session-${(i % 39) + 1}`, payload).run()
    }
    await db.prepare(insert).bind('checkout-50', 'session-1', JSON.stringify({ event_name: 'checkout_start', stage: 'started', entity_type: 'product', entity_id: 'prod-single', attribution: null, attributed_at: null })).run()
    const breakdown = async (eventName: string) => {
      const query = await queryOrganizationAnalytics(db, { organizationId: 'org-entity', mode: 'breakdown', startDate: '2026-09-05', endDate: '2026-09-05',
        filters: { event_name: eventName }, dimensions: ['event_name'], metrics: ['events', 'entities', 'sessions'] })
      assert.equal(query.rows.length, 1)
      return query.rows[0]?.metrics as { events: number; entities: number; sessions: number }
    }
    assert.deepEqual(await breakdown('checkout_start'), { events: 50, entities: 1, sessions: 39 })

    // Events with no entity references keep their count and yield 0 distinct entities.
    await db.prepare("DELETE FROM analytics_events WHERE id = 'checkout-50'").run()
    await db.prepare(insert).bind('checkout-50', 'session-1', JSON.stringify({ event_name: 'checkout_start', stage: 'started', entity_type: null, entity_id: null, attribution: null, attributed_at: null })).run()
    assert.deepEqual(await breakdown('checkout_start'), { events: 50, entities: 0, sessions: 39 })

    // Different entity types sharing the same entity_id count as distinct entities.
    await db.prepare('DELETE FROM analytics_events').run()
    for (const [id, type] of [['order-event', 'order'], ['product-event', 'product']]) {
      await db.prepare(insert).bind(id, 'session-1', JSON.stringify({ event_name: 'purchase', stage: 'occurred', entity_type: type, entity_id: 'shared-id', value: { basis: 'purchase', currency: 'USD', amount_minor: 1000, collected_minor: 1000 }, attribution: { source: 'google', medium: 'cpc' }, attributed_at: '2026-09-05T12:00:00.000Z' })).run()
    }
    assert.deepEqual(await breakdown('purchase'), { events: 2, entities: 2, sessions: 1 })
    // The daily summaries are no longer a mode of the query.
    await assert.rejects(queryOrganizationAnalytics(db, { organizationId: 'org-entity', mode: 'daily_summaries' as never, startDate: '2026-09-05', endDate: '2026-09-05' }), /mode must be one of: events, sessions, breakdown/)
  } finally { await runtime.dispose() }
})
