import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { getAnalyticsReport } from '../../server/utils/analytics-report.ts'

test('a business and its locations carry their own clock and currency; nothing supplies one for them', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'required-facts-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await assert.rejects(db.prepare("INSERT INTO organization (id, name, slug, default_currency) VALUES ('no-clock', 'n', 'no-clock', 'USD')").run(), /NOT NULL constraint failed: organization.timezone/)
    await assert.rejects(db.prepare("INSERT INTO organization (id, name, slug, timezone) VALUES ('no-currency', 'n', 'no-currency', 'Asia/Bangkok')").run(), /NOT NULL constraint failed: organization.default_currency/)
    await assert.rejects(db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('blank', 'n', 'blank', 'USD', '')").run(), /organization_timezone_check/)
    await db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone, analytics_data_start_at) VALUES ('org', 'Org', 'org', 'THB', 'Asia/Bangkok', '2026-09-01T00:00:00.000Z')").run()
    assert.equal(await db.prepare("SELECT settings_json FROM organization WHERE id = 'org'").first('settings_json'), '{}')
    await assert.rejects(db.prepare("INSERT INTO business_locations (id, organization_id, slug, title) VALUES ('placeless', 'org', 'placeless', 'Placeless')").run(), /NOT NULL constraint failed: business_locations.timezone/)
    await db.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('location', 'org', 'location', 'Location', 'America/New_York')").run()
    // Analytics days are the business's own clock, not its location's.
    const report = await getAnalyticsReport(db, { organizationId: 'org', startDate: '2026-09-05', endDate: '2026-09-06', now: new Date('2026-09-06T12:00:00Z') })
    assert.equal(report.period.timezone, 'Asia/Bangkok')
  } finally { await runtime.dispose() }
})
