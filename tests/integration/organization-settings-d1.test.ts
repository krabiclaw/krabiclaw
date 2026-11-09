import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { getConfig, setConfig } from '../../server/utils/organization-config.ts'
import { deleteIntegration, listIntegrations, readIntegration, storeIntegration } from '../../server/utils/organization-integrations.ts'
import { lastWhatsAppInboundId, recordWhatsAppInbound, whatsAppServiceWindowOpen, getMcpWorkspacePreference, upsertMcpWorkspacePreference } from '../../server/utils/mcp-context.ts'

test('organization settings and workspace patches preserve independent owners and hold no provider credentials', async () => {
  const miniflare = new Miniflare({ workers: [{ config: {
    name: 'owner-settings-test', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }',
    } } }, env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await miniflare.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization(id,name,slug,subdomain, default_currency, timezone) VALUES('org','Org','org','org', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO user(id,name,email) VALUES('user','User','user@example.test')").run()
    await setConfig(db, 'org', 'press_email', 'press@example.test')
    assert.equal((await getConfig(db, 'org')).press_email, 'press@example.test')
    // The measurement id is the Analytics integration's, and choosing a GA4
    // property is the only thing that writes it — so it is readable here and
    // there is no settings key that sets it.
    await storeIntegration(db, 'org', 'google_analytics', { account_id: 'google-account', target_id: '100', target_name: 'OAuth', measurement_id: 'G-OAUTH' })
    assert.equal((await getConfig(db, 'org')).google_analytics_measurement_id, 'G-OAUTH')
    await assert.rejects(db.prepare("UPDATE organization SET consultation_settings_json=json('{}') WHERE id='org'").run(), /organization_consultation_settings_check/)
    await assert.rejects(setConfig(db, 'other', 'press_email', 'other@example.test'))
    assert.equal(await deleteIntegration(db, 'org', 'google_analytics'), true)
    const selection = { account_id: 'google-account', target_id: '123', target_name: 'Site', measurement_id: 'G-SELECTED' }
    // Two selections landing together: the revision guard means one wins.
    const attempts = await Promise.allSettled([storeIntegration(db, 'org', 'google_analytics', selection, { revision: null }), storeIntegration(db, 'org', 'google_analytics', selection, { revision: null })])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    // The organization keeps its selection and the Better Auth account it was
    // made through, and no credential of its own.
    const stored = await readIntegration(db, 'org', 'google_analytics')
    assert.equal(stored?.account_id, 'google-account')
    assert.equal(stored?.measurement_id, 'G-SELECTED')
    assert.equal(stored?.revision, attempts.find(result => result.status === 'fulfilled')?.value)
    assert.deepEqual((await listIntegrations(db, 'org')).map(integration => integration.provider), ['google_analytics'])
    // A failed older verification must not remove the selection that replaced it.
    assert.equal(await deleteIntegration(db, 'org', 'google_analytics', { revision: 'stale-verification' }), false)
    assert.equal((await readIntegration(db, 'org', 'google_analytics'))?.measurement_id, 'G-SELECTED')
    assert.equal(await deleteIntegration(db, 'org', 'google_analytics', { revision: stored!.revision }), true)
    assert.equal(await readIntegration(db, 'org', 'google_analytics'), null)
    await setConfig(db, 'org', 'press_email', 'desk@example.test')

    // A member's WhatsApp message and their MCP workspace share a row; neither write clobbers the other.
    const sentAt = new Date().toISOString()
    await Promise.all([recordWhatsAppInbound(db, { userId: 'user', messageId: 'inbound', sentAt }), upsertMcpWorkspacePreference(db, { userId: 'user', organizationId: 'org', locationId: null })])
    assert.equal(await lastWhatsAppInboundId(db, 'user'), 'inbound')
    assert.equal((await getMcpWorkspacePreference(db, 'user'))?.organization_id, 'org')
    // Meta's service window is the 24 hours after the member's own message.
    assert.equal(await whatsAppServiceWindowOpen(db, 'user', new Date(Date.parse(sentAt) + 23 * 3_600_000)), true)
    assert.equal(await whatsAppServiceWindowOpen(db, 'user', new Date(Date.parse(sentAt) + 24 * 3_600_000)), false)
    assert.equal(await whatsAppServiceWindowOpen(db, 'nobody'), false)
  } finally { await miniflare.dispose() }
})
