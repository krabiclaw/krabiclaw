import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, updateStay, type StayAccess } from '../../server/domain/stays.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { findSubmissionByPhone } from '../../server/utils/submission-messages.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A stay's guest conversation lives in the one inbox: a host stay with a guest
// email or phone opens it, the member who looks after
// the home sees it, it moves to Past after check-out, it is answered like any
// thread, and a stay is changed from its own screen rather than its thread.

const ORG = 'org'
const OWNER = 'owner-user'
const CLEANER = 'cleaner-user'
const OUTSIDER = 'outsider-user'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
}

test('a stay opens its guest conversation in the one inbox', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-threads-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-threads-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    for (const [id, role] of [[OWNER, 'owner'], [CLEANER, 'member'], [OUTSIDER, 'member']] as const) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@example.test`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
    }
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: `m-${CLEANER}`, assigned_team_id: null },
    } })
    const thread = (requestId: string) => db.prepare('SELECT kind, location_id, conversation_state, payload_json FROM requests WHERE id = ?').bind(requestId).first<{ kind: string; location_id: string; conversation_state: string; payload_json: string }>()
    const opening = (requestId: string) => db.prepare("SELECT actor_kind, actor_user_id, channel FROM activity_entries WHERE request_id = ? AND kind = 'submission'").bind(requestId).first()

    // A host stay with a guest email opens a thread the host opened, waiting on the guest.
    const ana = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'ana', check_in_date: day(3), check_out_date: day(6), adults: 2,
      guest_name: 'Ana', guest_surname: 'Silva', guest_email: 'ana@example.test', guest_phone: '+61491570150', total_minor: 45_000 })
    assert.ok(ana.request_id)
    const anaThread = await thread(ana.request_id)
    assert.deepEqual({ ...anaThread, payload_json: JSON.parse(anaThread!.payload_json) }, {
      kind: 'stay', location_id: 'cabin-site', conversation_state: 'waiting_on_guest',
      payload_json: { guest: { name: 'Ana Silva', email: 'ana@example.test', phone: '+61491570150' } },
    })
    assert.deepEqual(await opening(ana.request_id), { actor_kind: 'member', actor_user_id: OWNER, channel: 'system' })

    // A guest reachable by phone alone has a thread too; until they join it through an invite a reply has nowhere to go and says so.
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(30), check_out_date: day(31), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 15_000 })
    assert.ok(dee.request_id)
    assert.deepEqual(JSON.parse((await thread(dee.request_id))!.payload_json).guest, { name: 'Dee', email: null, phone: '+61491570151' })
    assert.deepEqual(await executeGuestThreadOperation(db, { threadId: dee.request_id, organizationId: ORG, action: 'reply', body: 'Hi', actorUserId: OWNER, idempotencyKey: 'dee-reply', env }),
      { ok: false, status: 409, reason: 'guest_invite_required', code: 'GUEST_INVITE_REQUIRED', field: 'request_id', message: 'This guest has no email on file. Invite them to the conversation first.' })

    // With neither an email nor a phone there is nothing to converse through; adding an email later opens it.
    const bo = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'bo', check_in_date: day(10), check_out_date: day(12), adults: 1, guest_name: 'Bo', total_minor: 30_000 })
    assert.equal(bo.request_id, null)
    const boWithEmail = await updateStay(db, env, manager, bo.id, { expected_version: bo.version, guest_email: 'bo@example.test' })
    assert.ok(boWithEmail.request_id)
    assert.equal((await thread(boWithEmail.request_id))?.kind, 'stay')
    // A further edit does not open a second one, and the thread takes the stay's current guest.
    const boAgain = await updateStay(db, env, manager, bo.id, { expected_version: boWithEmail.version, guest_surname: 'Lee', guest_phone: '+61491570153' })
    assert.equal(boAgain.request_id, boWithEmail.request_id)
    assert.deepEqual(JSON.parse((await thread(boAgain.request_id!))!.payload_json).guest, { name: 'Bo Lee', email: 'bo@example.test', phone: '+61491570153' })
    // Clearing one contact is reflected exactly; clearing the last is refused before either row changes.
    const boByEmail = await updateStay(db, env, manager, bo.id, { expected_version: boAgain.version, guest_phone: null })
    assert.deepEqual(JSON.parse((await thread(boByEmail.request_id!))!.payload_json).guest, { name: 'Bo Lee', email: 'bo@example.test', phone: null })
    const boByPhone = await updateStay(db, env, manager, bo.id, { expected_version: boByEmail.version, guest_email: null, guest_phone: '+61491570153' })
    assert.deepEqual(JSON.parse((await thread(boByPhone.request_id!))!.payload_json).guest, { name: 'Bo Lee', email: null, phone: '+61491570153' })
    await assert.rejects(updateStay(db, env, manager, bo.id, { expected_version: boByPhone.version, guest_phone: null }), {
      status: 422, data: { code: 'STAY_THREAD_CONTACT_REQUIRED', fields: ['guest_email', 'guest_phone'] },
    })
    assert.deepEqual(await db.prepare('SELECT guest_email, guest_phone, request_id, version FROM stays WHERE id = ?').bind(bo.id).first(), {
      guest_email: null, guest_phone: '+61491570153', request_id: boByPhone.request_id, version: boByPhone.version,
    })
    assert.deepEqual(JSON.parse((await thread(boByPhone.request_id!))!.payload_json).guest, { name: 'Bo Lee', email: null, phone: '+61491570153' })
    // Two edits race on one version, one bringing an address and one not. Whichever is saved, the
    // thread follows the stay as saved: none when no address was saved, never the losing edit's.
    const cy = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'cy', check_in_date: day(14), check_out_date: day(16), adults: 1, guest_name: 'Cy', total_minor: 30_000 })
    const raced = await Promise.allSettled([{ adults: 2 }, { guest_email: 'cy@example.test' }].map(change => updateStay(db, env, manager, cy.id, { expected_version: cy.version, ...change })))
    assert.deepEqual(raced.map(result => result.status).sort(), ['fulfilled', 'rejected'])
    const saved = await db.prepare('SELECT guest_email, request_id, version FROM stays WHERE id = ?').bind(cy.id).first<{ guest_email: string | null; request_id: string | null; version: number }>()
    assert.ok(saved)
    if (saved.guest_email === null) assert.equal(saved.request_id, null)
    else {
      assert.equal(saved.guest_email, 'cy@example.test')
      assert.ok(saved.request_id)
      assert.equal(JSON.parse((await thread(saved.request_id))!.payload_json).guest.email, saved.guest_email)
    }
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM requests WHERE kind = 'stay' AND json_extract(payload_json, '$.guest.name') = 'Cy'").first('n'), saved.request_id ? 1 : 0)
    // Add the address only if its racing edit lost; reuse the winning thread otherwise.
    const cyThread = saved.guest_email === null
      ? (await updateStay(db, env, manager, cy.id, { expected_version: saved.version, guest_email: 'cy@example.test' })).request_id
      : saved.request_id
    assert.ok(cyThread)
    assert.deepEqual(await db.prepare('SELECT guest_email, request_id FROM stays WHERE id = ?').bind(cy.id).first(), { guest_email: 'cy@example.test', request_id: cyThread })

    // The inbox lists them with their nights; the member who looks after the home sees them, another member does not.
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, role, organizationId: ORG }, { env })
    const listed = await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay' })
    assert.deepEqual(listed.map(row => row.id).sort(), [ana.request_id, boWithEmail.request_id, cyThread, dee.request_id].sort())
    const anaRow = listed.find(row => row.id === ana.request_id)!
    assert.equal(anaRow.productId, cabin.id)
    assert.equal(anaRow.stayChannel, 'direct')
    const nights = (from: string, to: string) => [from, to].map(date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`)))
    const [anaIn, anaOut] = nights(day(3), day(6))
    assert.deepEqual([anaRow.submissionType, anaRow.whenLabel, anaRow.operationalStatusLabel, anaRow.mailbox], ['stay', `${anaIn} – ${anaOut} · 2 guests`, 'Confirmed', 'current'])
    assert.equal((await listGuestThreads(db, ORG, { userId: CLEANER, principal: principal(CLEANER, 'member') })).length, 4)
    assert.deepEqual(await listGuestThreads(db, ORG, { userId: OUTSIDER, principal: principal(OUTSIDER, 'member') }), [])

    // The thread is answered like any other; a stay is changed from its own screen, not its thread.
    const detail = (await getGuestThreadDetail(db, ana.request_id, ORG))!
    assert.deepEqual([detail.submissionType, detail.operationalRecord?.id, detail.operationalRecord?.kind, detail.availableActions], ['stay', ana.id, 'stay', []])
    const reply = await executeGuestThreadOperation(db, { threadId: ana.request_id, organizationId: ORG, action: 'reply', body: 'The gate code is in your confirmation.', actorUserId: OWNER, idempotencyKey: 'reply-1', env })
    assert.deepEqual([reply.ok, reply.status], [true, 200])
    assert.deepEqual(await db.prepare(`SELECT d.channel, d.status FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
      WHERE e.request_id = ? AND d.purpose = 'member_reply'`).bind(ana.request_id).first(), { channel: 'email', status: 'sent' })
    const cancel = await executeGuestThreadOperation(db, { threadId: ana.request_id, organizationId: ORG, action: 'cancel', actorUserId: OWNER, idempotencyKey: 'cancel-1', env })
    assert.deepEqual(cancel, { ok: false, status: 409, reason: 'invalid_transition', message: '"cancel" is not a valid action for the current state' })
    assert.equal(await db.prepare('SELECT status FROM stays WHERE id = ?').bind(ana.id).first('status'), 'confirmed')

    // A stay's thread leaves Current two days after its check-out date, after check-out everywhere.
    await db.prepare('UPDATE stays SET check_in_date = ?, check_out_date = ? WHERE id = ?').bind(day(-5), day(-1), ana.id).run()
    assert.equal((await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'current' })).some(row => row.id === ana.request_id), true)
    await db.prepare('UPDATE stays SET check_in_date = ?, check_out_date = ? WHERE id = ?').bind(day(-6), day(-2), ana.id).run()
    assert.equal((await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'past' })).some(row => row.id === ana.request_id), true)
    assert.equal((await getGuestThreadDetail(db, ana.request_id, ORG))?.mailbox, 'past')

    // A guest's WhatsApp number finds their stay's thread; a cancelled stay's thread is not found.
    assert.deepEqual(await findSubmissionByPhone(db, '+61491570150'), { submissionType: 'stay', submissionId: ana.request_id, organizationId: ORG })
    await db.prepare("UPDATE stays SET status = 'cancelled', cancelled_at = '2026-10-15T00:00:00.000Z' WHERE id = ?").bind(ana.id).run()
    assert.equal(await findSubmissionByPhone(db, '+61491570150'), undefined)

  } finally {
    await runtime.dispose()
  }
})
