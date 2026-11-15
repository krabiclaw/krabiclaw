import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { readInsightsPage } from '../../server/domain/insights.ts'

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
    const page = await readInsightsPage(db, { organizationId: 'org', timezone: 'Asia/Bangkok', defaultCurrency: 'THB', userId: 'owner', analytics: true }, 'conversion/page-views', {}, new Date('2026-09-06T12:00:00Z'))
    assert.deepEqual(page.period, { start_date: '2026-08-08', end_date: '2026-09-06', timezone: 'Asia/Bangkok' })
    assert.equal(page.recorded_since, '2026-09-01')
  } finally { await runtime.dispose() }
})
