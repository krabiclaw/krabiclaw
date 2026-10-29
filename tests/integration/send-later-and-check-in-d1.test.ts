import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { sendDueScheduledGuestMessages } from '../../server/domain/scheduled-guest-messages.ts'
import { cancelSendLaterMessage, createSendLaterMessage, listSendLaterMessages, sendDueSendLaterMessages, updateSendLaterMessage } from '../../server/domain/send-later.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// Every confirmed stay is sent its home's check-in instructions on its own, and
// a member's send-later reply goes out as their reply at its time, visible only
// to them until then.

const ORG = 'org'
const OWNER = 'owner-user'
const ADMIN = 'admin-user'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const minutes = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString()

test('check-in instructions reach every confirmed stay, and send-later replies go out as their author', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'send-later-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'send-later-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin']]) {
      await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)").bind(id, id, `${id}@example.test`).run()
      await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)").bind(`m-${id}`, ORG, id, role).run()
    }
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const checkIn = (stayId: string) => db.prepare("SELECT * FROM scheduled_guest_messages WHERE stay_id = ? AND template_id IS NULL AND template_title = 'Check-in instructions'").bind(stayId).first<Record<string, string | null>>()

    // A home with no instructions sends nothing.
    const ana = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'ana', check_in_date: day(5), check_out_date: day(7), adults: 2, guest_name: 'Ana', guest_email: 'ana@example.test', total_minor: 30_000 })
    assert.equal(await checkIn(ana.id), null)

    // Once the home has instructions, the next run plans them for Ana at 10:00
    // the day before arrival, and a later edit reaches the plan before it is sent.
    await updateStayHome(env, db, manager, cabin.id, { check_in_instructions: 'The key is in the lockbox.' })
    await sendDueScheduledGuestMessages(db, env, minutes(1))
    const planned = (await checkIn(ana.id))!
    assert.deepEqual([planned.status, planned.body, planned.due_at?.slice(0, 10)], ['pending', 'The key is in the lockbox.', day(4)])
    await updateStayHome(env, db, manager, cabin.id, { check_in_instructions: 'The lockbox code is 4821.' })
    await sendDueScheduledGuestMessages(db, env, minutes(2))
    assert.equal((await checkIn(ana.id))?.body, 'The lockbox code is 4821.')

    // Removing the instructions cancels the plan; bringing them back plans it again.
    await updateStayHome(env, db, manager, cabin.id, { check_in_instructions: null })
    await sendDueScheduledGuestMessages(db, env, minutes(3))
    assert.deepEqual([(await checkIn(ana.id))?.status, (await checkIn(ana.id))?.reason], ['cancelled', 'The home has no check-in instructions.'])
    await updateStayHome(env, db, manager, cabin.id, { check_in_instructions: 'The lockbox code is 4821.' })
    await sendDueScheduledGuestMessages(db, env, minutes(4))
    assert.deepEqual([(await checkIn(ana.id))?.status, (await checkIn(ana.id))?.body], ['pending', 'The lockbox code is 4821.'])

    // Booked after that time, Bo is sent them at once: arriving today before
    // 16:00 in Denver, or tomorrow once today's 10:00 there has passed.
    const boArrives = new Date().getUTCHours() < 21 ? 0 : 1
    const bo = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'bo', check_in_date: day(boArrives), check_out_date: day(boArrives + 1), adults: 1, guest_name: 'Bo', guest_email: 'bo@example.test', total_minor: 15_000 })
    const boPlan = (await checkIn(bo.id))!
    assert.equal(boPlan.status, 'pending')
    assert.ok(boPlan.due_at! <= minutes(1))
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(3)), { sent: 1, failed: 0, needs_review: 0 })
    assert.equal((await checkIn(bo.id))?.status, 'sent')

    // A stay with no guest conversation has nowhere to send them: its plan is
    // cancelled with that reason, and returns once a conversation is attached.
    const cy = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'cy', check_in_date: day(10), check_out_date: day(11), adults: 1, guest_name: 'Cy', guest_email: 'cy@example.test', total_minor: 15_000 })
    assert.equal((await checkIn(cy.id))?.status, 'pending')
    await db.prepare('UPDATE stays SET request_id = NULL WHERE id = ?').bind(cy.id).run()
    await sendDueScheduledGuestMessages(db, env, minutes(5))
    assert.deepEqual([(await checkIn(cy.id))?.status, (await checkIn(cy.id))?.reason], ['cancelled', 'The stay has no guest conversation to send through.'])
    await db.prepare('UPDATE stays SET request_id = ? WHERE id = ?').bind(cy.request_id, cy.id).run()
    await sendDueScheduledGuestMessages(db, env, minutes(6))
    assert.equal((await checkIn(cy.id))?.status, 'pending')

    // The automatic message's name is reserved, and every automatic message needs a schedule.
    await assert.rejects(saveMessageTemplate(db, manager, null, { title: 'Check-in instructions', body: 'x', schedule: { trigger: 'check_in', offsetDays: 0, localTime: '09:00', productIds: [cabin.id] } }), { data: { code: 'MESSAGE_TITLE_RESERVED', field: 'title' } })
    await assert.rejects(saveMessageTemplate(db, manager, null, { title: 'Hello', body: 'x', schedule: null }), { data: { code: 'MESSAGE_SCHEDULE_REQUIRED', field: 'schedule' } })

    // Ana's arrives on time through her conversation, as the business.
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, `${day(4)}T23:59:00.000Z`), { sent: 1, failed: 0, needs_review: 0 })
    const sent = (await checkIn(ana.id))!
    assert.equal(sent.status, 'sent')
    assert.deepEqual(await db.prepare('SELECT request_id, actor_kind, body FROM activity_entries WHERE id = ?').bind(sent.entry_id).first(), {
      request_id: ana.request_id, actor_kind: 'system', body: 'The lockbox code is 4821.',
    })

    // Send later: the owner schedules a reply in Ana's conversation; only the owner sees it.
    const owner = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: OWNER }))!, { env })
    const admin = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: ADMIN }))!, { env })
    await assert.rejects(createSendLaterMessage(db, owner, ana.request_id!, { body: 'Too late', sendAt: minutes(-1) }), { data: { code: 'SEND_LATER_IN_PAST', field: 'sendAt' } })
    const reply = await createSendLaterMessage(db, owner, ana.request_id!, { body: 'Enjoy the hot tub tonight!', sendAt: minutes(60) })
    assert.deepEqual((await listSendLaterMessages(db, owner, ana.request_id!)).map(message => message.id), [reply.id])
    assert.deepEqual(await listSendLaterMessages(db, admin, null), [])
    await assert.rejects(cancelSendLaterMessage(db, admin, reply.id), { data: { code: 'SEND_LATER_NOT_FOUND', field: 'messageId' } })
    const edited = await updateSendLaterMessage(db, owner, reply.id, { body: 'Enjoy the hot tub!', sendAt: minutes(30), expectedVersion: 1 })
    await assert.rejects(updateSendLaterMessage(db, owner, reply.id, { body: 'x', sendAt: minutes(30), expectedVersion: 1 }), { data: { code: 'SEND_LATER_VERSION_CONFLICT', field: 'expectedVersion' } })

    // The admin schedules one too, then loses their membership before it is due.
    const orphaned = await createSendLaterMessage(db, admin, ana.request_id!, { body: 'From the admin', sendAt: minutes(20) })
    const cancelled = await createSendLaterMessage(db, owner, ana.request_id!, { body: 'Never mind', sendAt: minutes(25) })
    assert.equal((await cancelSendLaterMessage(db, owner, cancelled.id)).status, 'cancelled')
    await db.prepare("DELETE FROM member WHERE userId = ?").bind(ADMIN).run()

    // Not yet due, nothing goes out; at its time the owner's goes out as the owner's own reply.
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(10)), { sent: 0, failed: 0, needs_review: 0 })
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(31)), { sent: 1, failed: 1, needs_review: 0 })
    const delivered = await db.prepare('SELECT * FROM send_later_messages WHERE id = ?').bind(edited.id).first<Record<string, string | null>>()
    assert.equal(delivered?.status, 'sent')
    assert.deepEqual(await db.prepare('SELECT request_id, actor_kind, actor_user_id, body FROM activity_entries WHERE id = ?').bind(delivered?.entry_id).first(), {
      request_id: ana.request_id, actor_kind: 'member', actor_user_id: OWNER, body: 'Enjoy the hot tub!',
    })
    const refused = await db.prepare('SELECT status, error_code, entry_id FROM send_later_messages WHERE id = ?').bind(orphaned.id).first()
    assert.deepEqual(refused, { status: 'failed', error_code: 'SEND_LATER_ACCESS_REVOKED', entry_id: null })
    assert.equal((await db.prepare('SELECT status FROM send_later_messages WHERE id = ?').bind(cancelled.id).first('status')), 'cancelled')

    // A repeated run sends nothing again.
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(40)), { sent: 0, failed: 0, needs_review: 0 })
  } finally {
    await runtime.dispose()
  }
})
