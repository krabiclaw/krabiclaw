import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, updateStay, type StayAccess } from '../../server/domain/stays.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { listConversations } from '../../server/domain/guest-threads/repository.ts'
import { findSubmissionByPhone } from '../../server/utils/submission-messages.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A stay's guest conversation lives in the one inbox: a host stay with a guest
// email or phone opens it, the member who looks after
// the home sees it, it moves to Past once quiet for 30 days after check-out, it is answered like any
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
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: `m-${CLEANER}` },
    } })
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, role, organizationId: ORG }, { env })
    const thread = (requestId: string) => db.prepare(`SELECT kind, location_id, payload_json,
      (SELECT count(*) FROM tasks WHERE kind = 'guest_reply' AND subject_type = 'conversation' AND subject_id = conversations.id AND status = 'open') AS open_replies
      FROM conversations WHERE id = ?`).bind(requestId).first<{ kind: string; location_id: string; payload_json: string; open_replies: number }>()
    const messageCount = (requestId: string) => db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id = ?').bind(requestId).first('n')

    // A host stay opens its guest conversation, with nothing said in it yet. Every booking has one.
    const unanswered = { ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }
    const ana = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'ana', check_in_date: day(3), check_out_date: day(6), adults: 2,
      guest_name: 'Ana Silva', guest_email: 'ana@example.test', guest_phone: '+61491570150', total_minor: 45_000 })
    const anaThread = await thread(ana.conversation_id)
    assert.deepEqual({ ...anaThread, payload_json: JSON.parse(anaThread!.payload_json) }, {
      kind: 'booking', location_id: 'cabin-site', open_replies: 0,
      payload_json: { guest: { name: 'Ana Silva', email: 'ana@example.test', phone: '+61491570150' }, ...unanswered },
    })
    assert.equal(await messageCount(ana.conversation_id), 0)
    // The guest is a Better Auth user: an anonymous one carrying the name the host gave, which owns the conversation.
    assert.deepEqual(await db.prepare('SELECT u.name, u."isAnonymous" AS anonymous, r.user_id = u.id AS owns FROM bookings b JOIN user u ON u.id = b.user_id JOIN conversations r ON r.booking_id = b.id AND r.kind = \'booking\' WHERE b.id = ?').bind(ana.id).first(),
      { name: 'Ana Silva', anonymous: 1, owns: 1 })

    // A guest reachable by phone alone has a thread too, but no email and no account anyone signs in to: a reply has nowhere to go and says so.
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(30), check_out_date: day(31), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 15_000 })
    assert.deepEqual(JSON.parse((await thread(dee.conversation_id))!.payload_json).guest, { name: 'Dee', email: null, phone: '+61491570151' })
    assert.deepEqual(await executeGuestThreadOperation(db, { threadId: dee.conversation_id, organizationId: ORG, action: 'reply', body: 'Hi', actorUserId: OWNER, idempotencyKey: 'dee-reply', env }),
      { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'conversation_id', message: 'This guest has no email or KrabiClaw account to reply to.' })

    // With neither an email nor a phone the guest still has their conversation, by name; contact added later is its contact.
    const bo = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'bo', check_in_date: day(10), check_out_date: day(12), adults: 1, guest_name: 'Bo', total_minor: 30_000 })
    assert.deepEqual(JSON.parse((await thread(bo.conversation_id))!.payload_json), { guest: { name: 'Bo', email: null, phone: null }, ...unanswered })
    const boWithEmail = await updateStay(db, env, manager, bo.id, { version: bo.version, guest_email: 'bo@example.test' })
    assert.equal(boWithEmail.conversation_id, bo.conversation_id)
    assert.equal((await thread(boWithEmail.conversation_id))?.kind, 'booking')
    // A further edit does not open a second one, and the thread takes the stay's current guest.
    const boAgain = await updateStay(db, env, manager, bo.id, { version: boWithEmail.version, guest_name: 'Bo Lee', guest_phone: '+61491570153' })
    assert.equal(boAgain.conversation_id, bo.conversation_id)
    assert.deepEqual(JSON.parse((await thread(boAgain.conversation_id))!.payload_json).guest, { name: 'Bo Lee', email: 'bo@example.test', phone: '+61491570153' })
    // Clearing a contact is reflected exactly, the last one too: the guest is known by name.
    const boByEmail = await updateStay(db, env, manager, bo.id, { version: boAgain.version, guest_phone: null })
    assert.deepEqual(JSON.parse((await thread(boByEmail.conversation_id))!.payload_json).guest, { name: 'Bo Lee', email: 'bo@example.test', phone: null })
    const boByPhone = await updateStay(db, env, manager, bo.id, { version: boByEmail.version, guest_email: null, guest_phone: '+61491570153' })
    assert.deepEqual(JSON.parse((await thread(boByPhone.conversation_id))!.payload_json).guest, { name: 'Bo Lee', email: null, phone: '+61491570153' })
    const boByName = await updateStay(db, env, manager, bo.id, { version: boByPhone.version, guest_phone: null })
    assert.deepEqual(await db.prepare("SELECT json_extract(r.payload_json, '$.guest') AS guest, r.id AS conversation_id, b.version FROM bookings b JOIN conversations r ON r.booking_id = b.id AND r.kind = 'booking' WHERE b.id = ?").bind(bo.id).first(), {
      guest: JSON.stringify({ name: 'Bo Lee', email: null, phone: null }), conversation_id: bo.conversation_id, version: boByName.version,
    })
    // Two edits race on one version, one bringing an address and one not. Whichever is saved, the
    // thread follows the stay as saved, never the losing edit's.
    const cy = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'cy', check_in_date: day(14), check_out_date: day(16), adults: 1, guest_name: 'Cy', total_minor: 30_000 })
    const raced = await Promise.allSettled([{ adults: 2 }, { guest_email: 'cy@example.test' }].map(change => updateStay(db, env, manager, cy.id, { version: cy.version, ...change })))
    assert.deepEqual(raced.map(result => result.status).sort(), ['fulfilled', 'rejected'])
    const saved = await db.prepare("SELECT b.adults, json_extract(r.payload_json, '$.guest.email') AS guest_email, r.id AS conversation_id, b.version FROM bookings b JOIN conversations r ON r.booking_id = b.id AND r.kind = 'booking' WHERE b.id = ?").bind(cy.id).first<{ adults: number; guest_email: string | null; conversation_id: string; version: number }>()
    assert.ok(saved)
    assert.equal(saved.conversation_id, cy.conversation_id)
    assert.deepEqual([saved.adults, saved.guest_email], saved.guest_email === null ? [2, null] : [1, 'cy@example.test'])
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE json_extract(payload_json, '$.guest.name') = 'Cy'").first('n'), 1)
    // Add the address only if its racing edit lost.
    if (saved.guest_email === null) await updateStay(db, env, manager, cy.id, { version: saved.version, guest_email: 'cy@example.test' })
    assert.deepEqual(await db.prepare("SELECT json_extract(r.payload_json, '$.guest.email') AS guest_email, r.id AS conversation_id FROM bookings b JOIN conversations r ON r.booking_id = b.id AND r.kind = 'booking' WHERE b.id = ?").bind(cy.id).first(), { guest_email: 'cy@example.test', conversation_id: cy.conversation_id })

    // A booking lands as a stay, not as a conversation: until someone writes, the inbox does not list it.
    assert.deepEqual(await listConversations(db, ORG, { userId: OWNER, principal: principal(OWNER, 'owner'), type: 'stay' }), [])

    // The thread is answered like any other; a stay is changed from its own screen, not its thread.
    const detail = (await getGuestThreadDetail(db, ana.conversation_id, ORG))!
    assert.deepEqual([detail.submissionType, detail.operationalRecord?.id, detail.operationalRecord?.unit, detail.availableActions], ['stay', ana.id, 'nights', []])
    const reply = await executeGuestThreadOperation(db, { threadId: ana.conversation_id, organizationId: ORG, action: 'reply', body: 'The gate code is in your confirmation.', actorUserId: OWNER, idempotencyKey: 'reply-1', env })
    assert.deepEqual([reply.ok, reply.status], [true, 200])
    assert.deepEqual(await db.prepare(`SELECT d.channel, d.status FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id
      WHERE e.conversation_id = ? AND d.purpose = 'member_reply'`).bind(ana.conversation_id).first(), { channel: 'email', status: 'sent' })

    // Once written to, the inbox lists it for owners and admins with the guest, the home and when the stay is, in the home's own clock.
    // A stay's guest conversation is not a member's, even the member who looks after the home: they read its stays as turnovers.
    const listed = await listConversations(db, ORG, { userId: OWNER, principal: principal(OWNER, 'owner'), type: 'stay' })
    assert.deepEqual(listed.map(row => row.id), [ana.conversation_id])
    const homeToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
    const arrivalIn = Math.round((Date.parse(`${day(3)}T00:00:00Z`) - Date.parse(`${homeToday}T00:00:00Z`)) / 86_400_000)
    assert.deepEqual({ ...listed[0]!, time: undefined }, { id: ana.conversation_id, kind: 'guest', guestName: 'Ana Silva', avatarInitial: 'A', channel: 'direct', home: 'Cabin',
      when: `In ${arrivalIn} days`, preview: 'The gate code is in your confirmation.', previewFrom: 'You', time: undefined, unread: false })
    assert.deepEqual(await db.prepare("SELECT b.product_id, b.channel, c.id AS conversation_id FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.id = ?").bind(ana.id).first(), { product_id: cabin.id, channel: 'direct', conversation_id: ana.conversation_id })
    assert.equal((await getGuestThreadDetail(db, ana.conversation_id, ORG))?.mailbox, 'current')
    assert.deepEqual(await listConversations(db, ORG, { userId: CLEANER, principal: principal(CLEANER, 'member') }), [])
    assert.deepEqual(await listConversations(db, ORG, { userId: OUTSIDER, principal: principal(OUTSIDER, 'member') }), [])
    const cancel = await executeGuestThreadOperation(db, { threadId: ana.conversation_id, organizationId: ORG, action: 'cancel', actorUserId: OWNER, idempotencyKey: 'cancel-1', env })
    assert.deepEqual(cancel, { ok: false, status: 409, reason: 'invalid_transition', message: '"cancel" is not a valid action for the current state' })
    assert.equal(await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(ana.id).first('status'), 'confirmed')

    // An ended stay stays in Current, as Airbnb keeps an ended trip; it leaves once quiet for 30 days.
    await db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = ?').bind(day(-6), day(-2), ana.id).run()
    assert.equal((await listConversations(db, ORG, { userId: OWNER, principal: principal(OWNER, 'owner'), type: 'stay', mailbox: 'current' })).some(row => row.id === ana.conversation_id), true)
    await db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = ?').bind(day(-45), day(-40), ana.id).run()
    await db.prepare('UPDATE messages SET occurred_at = ? WHERE conversation_id = ?').bind(`${day(-40)}T00:00:00.000Z`, ana.conversation_id).run()
    await db.prepare('UPDATE conversations SET created_at = ?, last_message_at = ? WHERE id = ?').bind(`${day(-50)}T00:00:00.000Z`, `${day(-40)}T00:00:00.000Z`, ana.conversation_id).run()
    assert.equal((await listConversations(db, ORG, { userId: OWNER, principal: principal(OWNER, 'owner'), type: 'stay', mailbox: 'past' })).some(row => row.id === ana.conversation_id), true)
    assert.equal((await getGuestThreadDetail(db, ana.conversation_id, ORG))?.mailbox, 'past')

    // A guest's WhatsApp number finds their stay's thread; a cancelled stay's thread is not found.
    assert.deepEqual(await findSubmissionByPhone(db, '+61491570150'), { submissionType: 'booking', submissionId: ana.conversation_id, organizationId: ORG })
    await db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = '2026-10-15T00:00:00.000Z' WHERE id = ?").bind(ana.id).run()
    assert.equal(await findSubmissionByPhone(db, '+61491570150'), undefined)

  } finally {
    await runtime.dispose()
  }
})
