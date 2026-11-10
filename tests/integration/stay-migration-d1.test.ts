import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, getStay, readStayCalendar, updateStay, type StayAccess } from '../../server/domain/stays.ts'
import { getStayMigrationContext, importStayMigration, previewStayMigration, verifyStayMigration } from '../../server/domain/stay-migration.ts'
import { isMigrationContext, isMigrationPreview, isMigrationReceipt, isMigrationVerification, type MigrationInput } from '../../shared/stay-migration.ts'
import contextRoute from '../../server/api/dashboard/stays/migration/index.get.ts'
import previewRoute from '../../server/api/dashboard/stays/migration/preview.post.ts'
import importRoute from '../../server/api/dashboard/stays/migration/import.post.ts'

const ORG = 'migration-org'
const OWNER = 'migration-owner'
const NOW = '2026-11-05T12:00:00.000Z'
const access: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const columns = { source_id: 'Reservation ID', source_listing: 'Listing', guest_name: 'Guest name', check_in_date: 'Check-in', check_out_date: 'Check-out', adults: 'Adults', total: 'Total price', currency: 'Currency', status: 'Status', channel: 'Channel', payment_status: 'Payment status' } as const
const header = Object.values(columns).join(',')
const row = (id: string, start: string, end: string, extra: string[] = []) => [id, '70 0C', 'Dylan from 1A', start, end, '1', '3700.00', 'USD', 'New', 'Hostaway Direct', 'Unpaid', ...extra].join(',')
function input(productId: string, csv = `${header}\n${row('67459976', '2026-10-10', '2026-12-24')}`): MigrationInput {
  return { csv, columns, date_format: 'iso', decimal_format: 'dot', homes: { '70 0C': productId }, blocks: [], blocks_reviewed: [productId], overrides: {} }
}
async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-migration-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { constructor(ctx) { this.ctx = ctx } async fetch(request) { if (new URL(request.url).pathname === "/fail") { await this.ctx.storage.put("fail", request.method === "PUT"); return new Response(null, { status: 204 }) } if (await this.ctx.storage.get("fail")) return new Response("Publication refused", { status: 503 }); return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-migration-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'migration-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_migration_no_provider_requests' } as CloudflareEnv
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone) VALUES (?, 'Migration Org', 'migration-org', 'migration-org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')").bind(ORG, NOW).run()
    for (const [id, role] of [[OWNER, 'owner'], ['migration-member', 'member']] as const) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@example.test`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
    }
    await db.prepare("INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at) VALUES ('cabin', ?, 'cabin', 'Cabin', 'active', 'America/Denver', ?, ?)").bind(ORG, NOW, NOW).run()
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'stay', name: '0C', variants: [{ name: '0C', prices: [{ unit_amount: 15_000, currency: 'USD' }] }], stay: { location_id: 'cabin', check_in_time: '16:00', check_out_time: '11:00', max_guests: 4, min_nights: 2 } } })
    return { runtime, db, env, home }
  } catch (error) { await runtime.dispose(); throw error }
}

test('Hostaway export imports an ongoing unpaid stay, protects occupancy, preserves host edits on retry and reports unconnected verification', { timeout: 120_000 }, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { runtime, db, env, home } = await boot()
  try {
    const source = input(home.id)
    const discovery = await previewStayMigration(db, access, { ...source, columns: {}, homes: {}, date_format: null, decimal_format: null })
    assert(isMigrationPreview(discovery)); assert.equal(discovery.can_import, false)
    assert.equal(discovery.suggested_columns.source_id, 'Reservation ID')
    const preview = await previewStayMigration(db, access, source)
    assert.equal(preview.can_import, true, JSON.stringify(preview))
    assert.deepEqual(preview.counts, { ready: 1, existing: 0, skipped: 0, needs_attention: 0 })
    const receipt = await importStayMigration(db, env, access, { ...source, fingerprint: preview.fingerprint })
    assert(isMigrationReceipt(receipt)); assert.equal(receipt.imported, 1); assert.equal(receipt.has_more, false)
    const stayId = receipt.outcomes[0]!.stay_id!
    const saved = await getStay(db, access, stayId)
    assert.equal(saved.payment_status, 'unpaid'); assert.equal(saved.paid_minor, 0)
    assert.deepEqual([saved.check_in_date, saved.check_out_date, saved.channel, saved.owner], ['2026-10-10', '2026-12-24', 'direct', 'app'])
    assert.equal(await db.prepare('SELECT booking_received_at FROM stays WHERE id = ?').bind(stayId).first('booking_received_at'), null)
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM stay_nights WHERE stay_id = ?').bind(stayId).first('n'), 75)
    assert.equal((await readStayCalendar(db, access, { productId: home.id, from: '2026-11-05', to: '2026-11-06' })).nights[0]!.available, false)
    await updateStay(db, env, access, stayId, { expected_version: saved.version, guest_name: 'Dylan corrected by host' })
    const replay = await importStayMigration(db, env, access, { ...source, fingerprint: preview.fingerprint })
    assert.equal(replay.existing, 1); assert.equal(replay.imported, 0)
    assert.equal((await getStay(db, access, stayId)).guest_name, 'Dylan corrected by host')
    const verification = await verifyStayMigration(db, env, access, { ...source, fingerprint: preview.fingerprint, product_ids: [home.id] })
    assert(isMigrationVerification(verification)); assert.equal(verification.state, 'needs_attention')
    assert.equal(verification.homes[0]!.state, 'not_connected')
    const loaded = await getStayMigrationContext(db, access)
    assert(isMigrationContext(loaded)); assert.equal(loaded.recent_import!.receipt.existing, 1)
  } finally { await runtime.dispose() }
})

test('migration preview rejects missing financial facts, duplicate sources and overlaps and parses explicit CSV dates/decimals', { timeout: 120_000 }, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { runtime, db, env, home } = await boot()
  try {
    const source = input(home.id)
    assert.equal((await previewStayMigration(db, access, { ...source, blocks_reviewed: [] })).can_import, false)
    const duplicate = await previewStayMigration(db, access, { ...source, csv: `${source.csv}\n${row('67459976', '2026-12-25', '2026-12-29')}` })
    assert(duplicate.rows.every(row => row.issues.some(issue => issue.includes('more than once'))))
    const paid = { ...source, overrides: { '67459976': { payment_status: 'Paid' } } }
    assert((await previewStayMigration(db, access, paid)).rows[0]!.issues.some(issue => issue.includes('Amount already paid')))
    const paidFacts = { ...source, overrides: { '67459976': { payment_status: 'Paid', paid_amount: '3700.00', paid_on: '2026-10-10', payment_method: 'bank_transfer' } } }
    const paidPreview = await previewStayMigration(db, access, paidFacts)
    assert.equal(paidPreview.can_import, true)
    assert.equal(paidPreview.rows[0]!.stay!.payment!.amount_minor, 370_000)
    const localized = { ...source, date_format: 'dmy', decimal_format: 'comma', overrides: { '67459976': { check_in_date: '10/10/2026', check_out_date: '24/12/2026', total: '3.700,00' } } }
    assert.equal((await previewStayMigration(db, access, localized)).rows[0]!.stay!.total_minor, 370_000)
    const archived = await previewStayMigration(db, access, { ...source, homes: {}, blocks_reviewed: [], csv: `${header}\n${row('archived', '2026-01-10', '2026-01-20').replace('70 0C', 'Archived property')}` })
    assert.equal(archived.rows[0]!.state, 'skipped'); assert.deepEqual(archived.source_listings, [])
    await assert.rejects(previewStayMigration(db, access, { ...source, overrides: { '67459976': { notes: '"'.repeat(600_000) } } }), (error: { data?: { code?: string } }) => error.data?.code === 'MIGRATION_EVIDENCE_TOO_LARGE')

    await createStay(db, env, access, { product_id: home.id, idempotency_key: 'existing-live-booking', guest_name: 'Adam', adults: 1, total_minor: 10_000, check_in_date: '2026-11-06', check_out_date: '2026-11-13' })
    const conflict = await previewStayMigration(db, access, source)
    assert.equal(conflict.can_import, false); assert.match(conflict.rows[0]!.issues.join(' '), /Overlaps existing stay/)
    await assert.rejects(importStayMigration(db, env, access, { ...source, fingerprint: conflict.fingerprint }), (error: { data?: { code?: string } }) => error.data?.code === 'MIGRATION_NEEDS_ATTENTION')
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM stays WHERE idempotency_key LIKE 'hostaway:%'").first('n'), 0)
    await assert.rejects(previewStayMigration(db, access, { ...source, csv: 'A,A\n1,2' }), (error: { data?: { code?: string } }) => error.data?.code === 'MIGRATION_CSV_HEADERS')
    await assert.rejects(previewStayMigration(db, access, { ...source, csv: 'A,B\n"not closed,2' }), (error: { data?: { code?: string } }) => error.data?.code === 'MIGRATION_CSV_INVALID')
    const partialSource = { ...input(home.id, `${header}\n${row('partial-proof', '2027-01-01', '2027-01-05')}`), overrides: { 'partial-proof': { payment_status: 'Partially paid', paid_amount: '100.00', paid_on: '2026-10-10', payment_method: 'bank_transfer' } } }
    const partialPreview = await previewStayMigration(db, access, partialSource)
    const partialReceipt = await importStayMigration(db, env, access, { ...partialSource, fingerprint: partialPreview.fingerprint })
    assert.equal(partialReceipt.imported, 1)
    const partialStay = await getStay(db, access, partialReceipt.outcomes[0]!.stay_id!)
    assert.equal(partialStay.payment_status, 'partial'); assert.equal(partialStay.paid_minor, 10_000); assert.equal(partialStay.total_minor, 370_000)
    assert.deepEqual(await db.prepare('SELECT amount_minor, method, paid_on, reference FROM stay_payments WHERE stay_id = ?').bind(partialStay.id).first(), { amount_minor: 10_000, method: 'bank_transfer', paid_on: '2026-10-10', reference: 'partial-proof' })
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE subject_type = 'stay' AND subject_id = ?").bind(partialStay.id).first('n'), 0)

  } finally { await runtime.dispose() }
})

test('bounded migration batches resume from canonical stays and manual blocks and repair committed visibility failure', { timeout: 120_000 }, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { runtime, db, env, home } = await boot()
  try {
    const csv = `${header}\n${Array.from({ length: 6 }, (_, index) => row(`batch-${index}`, `2026-12-${String(index * 2 + 1).padStart(2, '0')}`, `2026-12-${String(index * 2 + 2).padStart(2, '0')}`)).join('\n')}`
    const source = { ...input(home.id, csv), blocks: [{ product_id: home.id, from: '2026-12-20', to: '2026-12-23', note: 'Owner stay' }] }
    const preview = await previewStayMigration(db, access, source)
    const first = await importStayMigration(db, env, access, { ...source, fingerprint: preview.fingerprint })
    assert.equal(first.imported, 5); assert.equal(first.remaining, 1); assert.equal(first.has_more, true)
    const second = await importStayMigration(db, env, access, { ...source, fingerprint: preview.fingerprint })
    assert.equal(second.imported, 1); assert.equal(second.existing, 5); assert.equal(second.remaining, 0)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM stays WHERE idempotency_key LIKE 'hostaway:%'").first('n'), 6)
    assert.equal((await readStayCalendar(db, access, { productId: home.id, from: '2026-12-20', to: '2026-12-23' })).nights.every(night => night.closed && !night.available), true)
    const failedSource = input(home.id, `${header}\n${row('repair', '2027-01-10', '2027-01-20')}`)
    const failedPreview = await previewStayMigration(db, access, failedSource)
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    await hub.fetch('https://inbox.test/fail', { method: 'PUT' })
    const failed = await importStayMigration(db, env, access, { ...failedSource, fingerprint: failedPreview.fingerprint })
    assert.equal(failed.failed, 1); assert.equal(failed.outcomes[0]!.committed, true)
    await hub.fetch('https://inbox.test/fail', { method: 'DELETE' })
    const repaired = await importStayMigration(db, env, access, { ...failedSource, fingerprint: failedPreview.fingerprint })
    assert.equal(repaired.failed, 0); assert.equal(repaired.existing, 1)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM stays WHERE idempotency_key = 'hostaway:repair'").first('n'), 1)
    const lostSource = input(home.id, `${header}\n${row('receipt-lost', '2027-02-10', '2027-02-20')}`)
    const lostPreview = await previewStayMigration(db, access, lostSource)
    await db.prepare("CREATE TRIGGER refuse_migration_receipt BEFORE INSERT ON activity_entries WHEN NEW.event_name = 'stay.migration_imported' BEGIN SELECT RAISE(ABORT, 'Injected receipt failure'); END").run()
    await hub.fetch('https://inbox.test/fail', { method: 'PUT' })
    await assert.rejects(importStayMigration(db, env, access, { ...lostSource, fingerprint: lostPreview.fingerprint }), (error: { data?: { code?: string; committed?: boolean } }) => error.data?.code === 'MIGRATION_RECEIPT_FAILED' && error.data.committed === true)
    const lostId = await db.prepare("SELECT id FROM stays WHERE idempotency_key = 'hostaway:receipt-lost'").first<string>('id')
    assert(lostId)
    await db.prepare('DROP TRIGGER refuse_migration_receipt').run()
    await hub.fetch('https://inbox.test/fail', { method: 'DELETE' })
    const lost = await getStay(db, access, lostId)
    await updateStay(db, env, access, lostId, { expected_version: lost.version, guest_name: 'Host correction after lost receipt' })
    const incomplete = await verifyStayMigration(db, env, access, { ...lostSource, fingerprint: lostPreview.fingerprint, product_ids: [home.id] })
    assert(incomplete.issues.some(issue => issue.includes('import completion retried')))
    const resumed = await importStayMigration(db, env, access, { ...lostSource, fingerprint: lostPreview.fingerprint })
    assert.equal(resumed.existing, 1); assert.equal(resumed.failed, 0); assert.equal(resumed.outcomes[0]!.committed, true)
    assert.equal((await getStay(db, access, lostId)).guest_name, 'Host correction after lost receipt')
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM stays WHERE idempotency_key = 'hostaway:receipt-lost'").first('n'), 1)
    const complete = await verifyStayMigration(db, env, access, { ...lostSource, fingerprint: lostPreview.fingerprint, product_ids: [home.id] })
    assert.equal(complete.issues.some(issue => issue.includes('import completion retried')), false)
    const lostBlockSource = { ...input(home.id, header), blocks: [{ product_id: home.id, from: '2027-03-01', to: '2027-03-04' }] }
    const lostBlockPreview = await previewStayMigration(db, access, lostBlockSource)
    await db.prepare("CREATE TRIGGER refuse_migration_receipt BEFORE INSERT ON activity_entries WHEN NEW.event_name = 'stay.migration_imported' BEGIN SELECT RAISE(ABORT, 'Injected receipt failure'); END").run()
    await hub.fetch('https://inbox.test/fail', { method: 'PUT' })
    await assert.rejects(importStayMigration(db, env, access, { ...lostBlockSource, fingerprint: lostBlockPreview.fingerprint }), (error: { data?: { code?: string; committed?: boolean } }) => error.data?.code === 'MIGRATION_RECEIPT_FAILED' && error.data.committed === true)
    assert.equal((await readStayCalendar(db, access, { productId: home.id, from: '2027-03-01', to: '2027-03-04' })).nights.every(night => night.closed), true)
    await db.prepare('DROP TRIGGER refuse_migration_receipt').run()
    await hub.fetch('https://inbox.test/fail', { method: 'DELETE' })
    const lostBlockVerification = await verifyStayMigration(db, env, access, { ...lostBlockSource, fingerprint: lostBlockPreview.fingerprint, product_ids: [home.id] })
    assert(lostBlockVerification.issues.some(issue => issue.includes('import completion retried')))
    const resumedBlock = await importStayMigration(db, env, access, { ...lostBlockSource, fingerprint: lostBlockPreview.fingerprint })
    assert.equal(resumedBlock.blocks[0]!.state, 'saved'); assert.equal(resumedBlock.blocks[0]!.committed, true)
    const stableBlock = await importStayMigration(db, env, access, { ...lostBlockSource, fingerprint: lostBlockPreview.fingerprint })
    assert.equal(stableBlock.blocks[0]!.committed, false)
    // A closure saved while disconnected must not count as delivered after a channel is connected.
    await db.prepare("INSERT INTO channex_connections (organization_id, status, group_id, channel_id, connected_at) VALUES (?, 'connected', 'migration-group', 'migration-airbnb', ?)").bind(ORG, NOW).run()
    await db.prepare("INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled) VALUES (?, ?, 'channex', 'migration-listing', 'migration-airbnb', 'migration-property', 'migration-room', 'migration-rate', 'complete', 1)").bind(ORG, home.id).run()
    const blocksOnly = { ...input(home.id, header), blocks: source.blocks }
    const blocksPreview = await previewStayMigration(db, access, blocksOnly)
    assert.equal(blocksPreview.can_import, true)
    const delivery = await importStayMigration(db, env, access, { ...blocksOnly, fingerprint: blocksPreview.fingerprint })
    assert.equal(delivery.blocks[0]!.state, 'failed')
    assert.match(delivery.blocks[0]!.detail!, /CHANNEX_BASE_URL and CHANNEX_API_KEY are required/)
    await db.prepare("INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, sent_json, updated_at) VALUES (?, ?, 'channex', '2026-12-20', 'pushed', '{\"stop_sell\":false}', ?)").bind(ORG, home.id, NOW).run()
    const stale = await importStayMigration(db, env, access, { ...blocksOnly, fingerprint: blocksPreview.fingerprint })
    assert.equal(stale.blocks[0]!.state, 'failed')


  } finally { await runtime.dispose() }
})

test('the authenticated migration route scopes discovery and writes to the selected owner organization', { timeout: 120_000 }, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { runtime, db, env, home } = await boot()
  try {
    const password = 'MigrationProof123!'
    for (const id of [OWNER, 'migration-member']) await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)").bind(`account-${id}`, id, id, await hashPassword(password)).run()
    const login = async (id: string) => {
      const response = await createAuth(env).api.signInEmail({ body: { email: `${id}@example.test`, password }, asResponse: true })
      assert.equal(response.status, 200)
      return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const app = new H3()
    app.get('/api/dashboard/stays/migration', contextRoute)
    app.post('/api/dashboard/stays/migration/preview', previewRoute)
    app.post('/api/dashboard/stays/migration/import', importRoute)
    const request = (cookie: string, path: string, body?: unknown, org = 'migration-org') => app.request(Object.assign(new Request(`https://proof.example/api/dashboard/stays/migration${path}?org=${org}`, { method: body ? 'POST' : 'GET', headers: { cookie, origin: 'https://proof.example', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal((await request('', '')).status, 401)
    const member = await login('migration-member')
    assert.equal((await request(member, '')).status, 403)
    const owner = await login(OWNER)
    assert.equal((await request(owner, '', undefined, 'another-business')).status, 404)
    const source = input(home.id)
    const previewResponse = await request(owner, '/preview', source)
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json() as { fingerprint: string }
    const imported = await request(owner, '/import', { ...source, fingerprint: preview.fingerprint })
    assert.equal(imported.status, 200, await imported.clone().text())
    const persisted = await db.prepare("SELECT product_id, guest_name FROM stays WHERE idempotency_key = 'hostaway:67459976'").first()
    assert.deepEqual(persisted, { product_id: home.id, guest_name: 'Dylan from 1A' })
  } finally { await runtime.dispose() }
})
