/* eslint-disable @typescript-eslint/no-explicit-any -- rows are read back as untyped JSON */
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { recordTenantPageview, type TenantPageviewInput } from '../../server/utils/pageview-tracking.ts'
import { measurementOutcome, recordOrganizationConversionEvent } from '../../server/utils/organization-conversions.ts'

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

// An event as the producer stored it, read back by its id.
async function stored(db: D1Database, id: string) {
  const row = await db.prepare('SELECT organization_id, kind, session_id, page_path, payload_json FROM analytics_events WHERE id = ?').bind(id).first<{ organization_id: string; kind: string; session_id: string | null; page_path: string | null; payload_json: string }>()
  assert.ok(row, `event ${id} is stored`)
  return { ...row, payload: JSON.parse(row.payload_json) as Record<string, any> }
}

function pageview(over: Partial<TenantPageviewInput> & { eventId: string; sessionId: string; visitorId: string }): TenantPageviewInput {
  return {
    organizationId: ORG, timezone: 'Asia/Bangkok', pagePath: '/', locale: 'en', referrerHost: null, attribution: {}, internalHosts: ['a.example'],
    userAgent: 'Desktop', ipHash: 'h', country: 'th', region: null, city: null, locationId: null, pageId: null, pageType: null, recipe: null,
    now: '2026-09-10T03:00:00.000Z', ...over,
  }
}

test('native analytics: each producer stores its event with the context it happened in', { timeout: 120_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    for (const id of [ORG, OTHER]) await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES (?, ?, ?, ?, '{}', 'USD', 'Asia/Bangkok')`).bind(id, id, id, id).run()

    // Campaign A then B in one session; B partial (campaign only, no source).
    const S1 = uuid(1), V1 = uuid(2)
    await recordTenantPageview(db, pageview({ eventId: uuid(10), sessionId: S1, visitorId: V1, pagePath: '/pricing', attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'A' }, now: '2026-09-10T03:00:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(11), sessionId: S1, visitorId: V1, pagePath: '/th/pricing', sourcePath: '/pricing', locale: 'th', attribution: { utm_campaign: 'B' }, now: '2026-09-10T03:05:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(12), sessionId: S1, visitorId: V1, pagePath: '/ja/pricing', sourcePath: '/pricing', locale: 'ja', now: '2026-09-10T03:06:00.000Z' }))
    // The same pageview delivered twice changes nothing.
    await recordTenantPageview(db, pageview({ eventId: uuid(11), sessionId: S1, visitorId: V1, pagePath: '/th/pricing', sourcePath: '/pricing', locale: 'th', attribution: { utm_campaign: 'C' }, now: '2026-09-10T04:00:00.000Z' }))
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE kind = 'pageview'").first('count(*)'), 3)
    assert.equal((await stored(db, uuid(10))).payload.attribution.campaign, 'A')
    assert.equal((await stored(db, uuid(11))).payload.attribution.campaign, 'B', 'the event keeps the campaign it carried, and a duplicate rewrites nothing')
    assert.equal((await stored(db, uuid(11))).payload.attribution.source, '(not set)', 'a partial touch is kept as a touch with unknown source')
    assert.equal((await stored(db, uuid(12))).payload.attribution.campaign, 'B', 'an untouched later visit inherits the touch in force at that moment')
    assert.equal((await stored(db, uuid(12))).payload.attribution_basis, 'inherited')

    // Interactions: same id once, new id twice.
    const view = { organizationId: ORG, eventName: 'announcement_view', stage: 'viewed', surface: 'website', originEventId: uuid(11), pagePath: '/th/pricing' } as const
    const at = (occurredAt: string) => ({ occurredAt })
    const a = await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, id: uuid(20), ...at('2026-09-10T03:06:00.000Z') })
    const b = await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, id: uuid(20), ...at('2026-09-10T03:06:00.000Z') })
    const c = await recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, id: uuid(21), ...at('2026-09-10T03:07:00.000Z') })
    assert.deepEqual([a.created, b.created, c.created], [true, false, true])
    // The submission response names the native event a GA projection may mirror; a failure names none.
    assert.deepEqual(measurementOutcome({ status: 'fulfilled', value: a }), { status: 'recorded', event_id: uuid(20) })
    assert.deepEqual(measurementOutcome({ status: 'rejected', reason: new Error('quote unresolved') }), { status: 'failed', reason: 'quote unresolved' })
    await assert.rejects(recordOrganizationConversionEvent(db, cookieFor(S1, V1), { ...view, organizationId: OTHER, id: uuid(20) }), /another organization/)
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE organization_id = ? AND (payload_json ->> '$.event_name') = 'announcement_view'").bind(ORG).first('count(*)'), 2)
    const first = await stored(db, uuid(20))
    assert.equal(first.kind, 'interaction')
    assert.equal(first.payload.page.locale, 'th', 'the interaction carries the origin visit language')
    assert.equal(first.payload.attribution.campaign, 'B', 'the interaction carries the origin visit snapshot, not the session as it later became')

    // An origin reference from another visitor is dropped: the context stays unknown.
    const foreign = await recordOrganizationConversionEvent(db, cookieFor(uuid(3), uuid(4)), { ...view, id: uuid(22), originEventId: uuid(11), ...at('2026-09-10T03:08:00.000Z') })
    assert.ok(foreign.created)
    const foreignRow = await stored(db, uuid(22))
    assert.equal(foreignRow.session_id, uuid(3))
    assert.equal(foreignRow.payload.page, null)

    // A verified origin keeps its own public path and its own (empty) attribution, whatever the session became.
    const S = uuid(5000), V = uuid(5001)
    await recordTenantPageview(db, pageview({ eventId: uuid(5010), sessionId: S, visitorId: V, pagePath: '/th/contact', sourcePath: '/contact', locale: 'th', now: '2026-09-11T02:00:00.000Z' }))
    await recordTenantPageview(db, pageview({ eventId: uuid(5011), sessionId: S, visitorId: V, pagePath: '/pricing', attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'B' }, now: '2026-09-11T02:05:00.000Z' }))
    const contact = await recordOrganizationConversionEvent(db, cookieFor(S, V), { organizationId: ORG, eventName: 'contact_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: 'req-th', originEventId: uuid(5010), routePath: '/contact', occurredAt: '2026-09-11T02:10:00.000Z' })
    const row = await stored(db, contact.id)
    assert.equal(row.page_path, '/th/contact', 'the conversion carries the visited /th/contact path')
    assert.equal(row.payload.page.locale, 'th')
    assert.equal(row.payload.attribution, null, 'the visit had no attribution; the later campaign is not its context')
    assert.equal(row.payload.attribution_basis, 'none')
  } finally {
    await runtime.dispose()
  }
})
