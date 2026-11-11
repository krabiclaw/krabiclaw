import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, stayAccessFor, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { cancelScheduledGuestMessage, deleteMessageTemplate, listScheduledGuestMessages, saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { scheduleGuestReply, sendDueScheduledGuestMessages } from '../../server/domain/scheduled-guest-messages.ts'
import { memberAccessPrincipal, resolveMembership, type MemberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import type { DashboardInvalidation } from '../../shared/dashboard-invalidations.ts'
import { requestInsertQueries } from '../../server/domain/requests.ts'
import { appendMessage } from '../../server/domain/conversations.ts'
import { applyResendEmailEvent, createDeliveryReceipt, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { executeGuestThreadOperation, operationDedupeKey } from '../../server/domain/guest-threads/operations.ts'
import { creationRequestHash } from '../../server/utils/organization-events.ts'
import { getInboxThread } from '../../server/domain/guest-threads/inbox.ts'

// Every confirmed stay is sent its home's check-in instructions on its own, and
// a member's send-later reply goes out as their reply at its time, visible only
// to them until then. Both are one outbox: one list, one cancel, one sender.

const ORG = 'org'
const OWNER = 'owner-user'
const ADMIN = 'admin-user'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const minutes = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString()
/** The outbox as one member reads it, optionally for one conversation. */
const outbox = async (db: Parameters<typeof listScheduledGuestMessages>[0], principal: MemberAccessPrincipal, threadId: string | null) =>
  (await listScheduledGuestMessages(db, await stayAccessFor(principal), { limit: 100, offset: 0 }, threadId)).messages
/** A member's own send-later replies in the outbox. */
const ownReplies = async (db: Parameters<typeof listScheduledGuestMessages>[0], principal: MemberAccessPrincipal, threadId: string | null) =>
  (await outbox(db, principal, threadId)).filter(message => message.author_user_id === principal.userId)

test('check-in instructions reach every confirmed stay, and send-later replies go out as their author', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'send-later-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(ctx) { this.storage = ctx.storage }
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/observed') return Response.json(await this.storage.get('events') ?? [])
        if (path === '/failure') { await this.storage.put('failure', request.method === 'PUT'); return new Response(null, { status: 204 }) }
        const event = await request.json()
        if (await this.storage.get('failure')) return new Response('Publication refused', { status: 503 })
        await this.storage.put('events', [...await this.storage.get('events') ?? [], event])
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
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
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: `m-${OWNER}` },
    } })
    const checkIn = (stayId: string) => db.prepare("SELECT * FROM scheduled_guest_messages WHERE booking_id = ? AND template_id IS NULL AND template_title = 'Check-in instructions'").bind(stayId).first<Record<string, string | null>>()

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

    // Every stay has its guest conversation to send them through.
    const cy = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'cy', check_in_date: day(10), check_out_date: day(11), adults: 1, guest_name: 'Cy', guest_email: 'cy@example.test', total_minor: 15_000 })
    assert.equal((await checkIn(cy.id))?.status, 'pending')

    // The automatic message's name is reserved, and every automatic message needs a schedule.
    await assert.rejects(saveMessageTemplate(db, env, manager, null, { title: 'Check-in instructions', body: 'x', schedule: { trigger: 'check_in', offset_days: 0, local_time: '09:00', product_ids: [cabin.id] } }), { data: { code: 'MESSAGE_TITLE_RESERVED', field: 'title' } })
    await assert.rejects(saveMessageTemplate(db, env, manager, null, { title: 'Hello', body: 'x', schedule: null }), { data: { code: 'MESSAGE_SCHEDULE_REQUIRED', field: 'schedule' } })

    // Ana's arrives on time through her conversation, as the business.
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, `${day(4)}T23:59:00.000Z`), { sent: 1, failed: 0, needs_review: 0 })
    const sent = (await checkIn(ana.id))!
    assert.equal(sent.status, 'sent')
    assert.deepEqual(await db.prepare('SELECT conversation_id, author_kind, author_user_id, body FROM messages WHERE id = ?').bind(sent.message_id).first(), {
      conversation_id: ana.conversation_id, author_kind: 'krabiclaw', author_user_id: null, body: 'The lockbox code is 4821.',
    })

    // Send later: the owner schedules a reply in Ana's conversation; only the owner sees it.
    const owner = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: OWNER }))!, { env })
    const admin = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: ADMIN }))!, { env })
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    const publications = async () => await (await hub.fetch('https://hub/observed')).json() as DashboardInvalidation[]
    await assert.rejects(scheduleGuestReply(db, owner, ana.conversation_id!, { body: 'Too late', due_at: minutes(-1) }), { data: { code: 'SEND_LATER_IN_PAST', field: 'due_at' } })
    const dueAt = minutes(30)
    const edited = await scheduleGuestReply(db, owner, ana.conversation_id!, { body: 'Enjoy the hot tub!', due_at: dueAt })
    assert.deepEqual([edited.conversation_id, edited.due_at], [ana.conversation_id, dueAt])
    const createdEvent = (await publications()).at(-1)!
    assert.deepEqual([createdEvent.type, createdEvent.organizationId, 'locationId' in createdEvent ? createdEvent.locationId : null, 'conversationId' in createdEvent ? createdEvent.conversationId : null], ['MESSAGE_UPDATE', ORG, 'cabin-site', ana.conversation_id])
    assert.deepEqual(await db.prepare('SELECT conversation_id, author_user_id, booking_id, template_title, body, status FROM scheduled_guest_messages WHERE id = ?').bind(edited.id).first(),
      { conversation_id: ana.conversation_id, author_user_id: OWNER, booking_id: null, template_title: null, body: 'Enjoy the hot tub!', status: 'pending' })
    assert.deepEqual((await ownReplies(db, owner, ana.conversation_id!)).map(message => message.id), [edited.id])
    // The admin manages the business's messages, yet another member's reply is not in their outbox and is not theirs to cancel.
    assert.ok((await outbox(db, admin, ana.conversation_id!)).some(message => message.author_user_id === null))
    assert.equal((await outbox(db, admin, null)).some(message => message.id === edited.id), false)
    await assert.rejects(cancelScheduledGuestMessage(db, env, await stayAccessFor(admin), edited.id), { data: { code: 'SCHEDULED_MESSAGE_NOT_FOUND', field: 'scheduled_message_id' } })

    // The admin schedules one too, then loses their membership before it is due.
    const orphaned = await scheduleGuestReply(db, admin, ana.conversation_id!, { body: 'From the admin', due_at: minutes(20) })
    const cancelled = await scheduleGuestReply(db, owner, ana.conversation_id!, { body: 'Never mind', due_at: minutes(25) })
    assert.equal((await cancelScheduledGuestMessage(db, env, await stayAccessFor(owner), cancelled.id)).status, 'cancelled')
    assert.equal((await publications()).at(-1)?.type, 'MESSAGE_UPDATE')
    assert.deepEqual(await db.prepare('SELECT status, reason FROM scheduled_guest_messages WHERE id = ?').bind(cancelled.id).first(), { status: 'cancelled', reason: 'Cancelled by its author.' })

    // A committed schedule whose dashboard publication failed is reported as
    // committed, so the caller reloads it instead of creating a duplicate.
    await hub.fetch('https://hub/failure', { method: 'PUT' })
    let committedId: string | null = null
    await assert.rejects(scheduleGuestReply(db, owner, ana.conversation_id!, { body: 'Saved despite publication failure', due_at: minutes(26) }), error => {
      const data = (error as { data?: { code: string; committed: boolean; scheduled_message_id: string } }).data
      assert.equal(data?.code, 'DASHBOARD_PUBLICATION_FAILED')
      assert.equal(data?.committed, true)
      committedId = data!.scheduled_message_id
      return true
    })
    assert.deepEqual(await db.prepare('SELECT status, body FROM scheduled_guest_messages WHERE id = ?').bind(committedId).first(), { status: 'pending', body: 'Saved despite publication failure' })
    await hub.fetch('https://hub/failure', { method: 'DELETE' })
    await cancelScheduledGuestMessage(db, env, await stayAccessFor(owner), committedId!)
    await db.prepare("DELETE FROM member WHERE userId = ?").bind(ADMIN).run()

    // Not yet due, nothing goes out; at its time the owner's goes out as the owner's own reply.
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(10)), { sent: 0, failed: 0, needs_review: 0 })
    const beforeSending = (await publications()).length
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(31)), { sent: 1, failed: 1, needs_review: 0 })
    const delivered = await db.prepare('SELECT * FROM scheduled_guest_messages WHERE id = ?').bind(edited.id).first<Record<string, string | null>>()
    assert.equal(delivered?.status, 'sent')
    assert.deepEqual(await db.prepare('SELECT conversation_id, author_kind, author_user_id, body FROM messages WHERE id = ?').bind(delivered?.message_id).first(), {
      conversation_id: ana.conversation_id, author_kind: 'member', author_user_id: OWNER, body: 'Enjoy the hot tub!',
    })
    const refused = await db.prepare('SELECT status, error_code, message_id FROM scheduled_guest_messages WHERE id = ?').bind(orphaned.id).first()
    assert.deepEqual(refused, { status: 'failed', error_code: 'SEND_LATER_ACCESS_REVOKED', message_id: null })
    assert.ok((await publications()).slice(beforeSending).some(event => event.type === 'MESSAGE_UPDATE' && event.conversationId === ana.conversation_id), 'a typed failure with no message still refreshes its conversation')
    assert.equal((await db.prepare('SELECT status FROM scheduled_guest_messages WHERE id = ?').bind(cancelled.id).first('status')), 'cancelled')
    // An author's failed reply is theirs to see in its conversation; it is no one's Today task.
    assert.equal(await db.prepare('SELECT count(*) n FROM tasks WHERE subject_id = ?').bind(orphaned.id).first('n'), 0)

    // A repeated run sends nothing again.
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(40)), { sent: 0, failed: 0, needs_review: 0 })

    // A stay's automatic messages belong to its conversation, so their changes refresh that conversation.
    const threadChanges = (events: DashboardInvalidation[]) => events.flatMap(event => event.type === 'MESSAGE_UPDATE' ? [event.conversationId] : [])
    let beforeChange = (await publications()).length
    const automatic = await saveMessageTemplate(db, env, manager, null, { title: 'After your stay', body: 'Thanks for staying.',
      schedule: { trigger: 'check_out', offset_days: 7, local_time: '09:00', product_ids: [cabin.id] } })
    const automaticRow = await db.prepare('SELECT id, status FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(cy.id, automatic.id).first<{ id: string; status: string }>()
    assert.equal(automaticRow?.status, 'pending')
    assert.ok(threadChanges((await publications()).slice(beforeChange)).includes(cy.conversation_id))
    beforeChange = (await publications()).length
    const updatedAutomatic = await saveMessageTemplate(db, env, manager, automatic.id, { title: 'After your stay', body: 'Thank you for visiting.', version: automatic.version,
      schedule: { trigger: 'check_out', offset_days: 7, local_time: '09:00', product_ids: [cabin.id] } })
    assert.equal(await db.prepare('SELECT body FROM scheduled_guest_messages WHERE id = ?').bind(automaticRow!.id).first('body'), 'Thank you for visiting.')
    assert.ok(threadChanges((await publications()).slice(beforeChange)).includes(cy.conversation_id))
    // One outbox: the owner's own reply in Cy's conversation is listed beside the automatic message, through the one list.
    const cyReply = await scheduleGuestReply(db, owner, cy.conversation_id!, { body: 'Your hot tub is ready.', due_at: minutes(90) })
    const cyCheckIn = (await checkIn(cy.id))!.id!
    assert.deepEqual((await outbox(db, owner, cy.conversation_id!)).filter(message => message.status === 'pending').map(message => [message.id, message.author_user_id, message.template_title]).sort(),
      [[automaticRow!.id, null, 'After your stay'], [cyCheckIn, null, 'Check-in instructions'], [cyReply.id, OWNER, null]].sort())
    // The inbox draws them above the composer from the same rows.
    const ownerViewer = { audience: 'member' as const, userId: OWNER, principal: owner }
    assert.deepEqual((await getInboxThread(db, cy.conversation_id!, ORG, ownerViewer))!.pending.map(item => [item.id, item.source, item.cancellable]).sort(),
      [[automaticRow!.id, 'automatic', true], [cyCheckIn, 'automatic', true], [cyReply.id, 'later', true]].sort())
    // One cancel operation cancels either kind; each is read back through the database.
    beforeChange = (await publications()).length
    await cancelScheduledGuestMessage(db, env, manager, automaticRow!.id)
    assert.deepEqual(await db.prepare('SELECT status, reason FROM scheduled_guest_messages WHERE id = ?').bind(automaticRow!.id).first(), { status: 'cancelled', reason: 'Cancelled by a workspace manager.' })
    assert.deepEqual(threadChanges((await publications()).slice(beforeChange)), [cy.conversation_id])
    await cancelScheduledGuestMessage(db, env, await stayAccessFor(owner), cyReply.id)
    assert.deepEqual(await db.prepare('SELECT status, reason FROM scheduled_guest_messages WHERE id = ?').bind(cyReply.id).first(), { status: 'cancelled', reason: 'Cancelled by its author.' })
    assert.deepEqual((await getInboxThread(db, cy.conversation_id!, ORG, ownerViewer))!.pending.map(item => item.id), [cyCheckIn])
    await assert.rejects(cancelScheduledGuestMessage(db, env, manager, cyReply.id), { status: 409, data: { code: 'SCHEDULED_MESSAGE_NOT_PENDING', field: 'status' } })
    beforeChange = (await publications()).length
    await deleteMessageTemplate(db, env, manager, automatic.id, updatedAutomatic.version)
    assert.equal(await db.prepare('SELECT count(*) n FROM message_templates WHERE id = ?').bind(automatic.id).first('n'), 0)
    assert.ok(threadChanges((await publications()).slice(beforeChange)).includes(cy.conversation_id))

    // When the note is due it goes out through each stay's own conversation: Ana's, Bo's and Cy's.
    const afterCheckout = await saveMessageTemplate(db, env, manager, null, { title: 'After checkout', body: 'We hope you enjoyed your stay.',
      schedule: { trigger: 'check_out', offset_days: 7, local_time: '11:00', product_ids: [cabin.id] } })
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, `${day(18)}T23:59:00.000Z`), { sent: 3, failed: 0, needs_review: 0 })
    const cySent = await db.prepare('SELECT status, message_id FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(cy.id, afterCheckout.id).first<{ status: string; message_id: string }>()
    assert.equal(cySent?.status, 'sent')
    assert.deepEqual(await db.prepare('SELECT conversation_id, body FROM messages WHERE id = ?').bind(cySent!.message_id).first(), { conversation_id: cy.conversation_id, body: 'We hope you enjoyed your stay.' })
  } finally {
    await runtime.dispose()
  }
})

test('a scheduled reply keeps its exact failure and Inbox retry completes the same job without sending twice', async t => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'send-later-recovery', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'send-later-recovery', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'provider', EMAIL_FROM: 'KrabiClaw <hello@krabiclaw.com>', RESEND_API_KEY: 're_controlled_http', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES (?, 'Org', 'org', 'org', 'USD', 'UTC')").bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin']]) {
      await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)").bind(id, id, `${id}@example.test`).run()
      await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)").bind(`m-${id}`, ORG, id, role).run()
    }
    const now = new Date().toISOString()
    await db.batch(requestInsertQueries({ id: 'recovery-thread', kind: 'contact', organization_id: ORG, location_id: null, booking_id: null, user_id: null,
      payload: { guest: { name: 'Test inbox', email: 'delivered@resend.dev', phone: null }, subject: null, consent_at: null, ip_hash: null, answers: [] },
      created_at: now }, undefined, { words: 'Hello' }).map(write => db.prepare(write.query).bind(...write.params)))
    const owner = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: OWNER }))!, { env })
    const historical = await appendMessage(db, { conversationId: 'recovery-thread', authorKind: 'member', authorUserId: OWNER, channel: 'email', body: 'Old reply', eventName: 'thread.member_reply' })
    const expired = await createDeliveryReceipt(db, { subject: { messageId: historical.id }, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'expired-history' })
    await recordDeliveryOutcome(db, { deliveryId: expired.id, status: 'sent', providerMessageId: 'expired-history' })

    let refuseNext = true
    const posts: Array<{ subject: string; to: string[]; headers?: Record<string, string>; html: string; text: string }> = []
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      // Only sends: nothing reads an email back from Resend.
      assert.equal(url, 'https://api.resend.com/emails')
      assert.equal(init.method, 'POST')
      if (refuseNext) {
        refuseNext = false
        return Response.json({ statusCode: 503, name: 'application_error', message: 'Resend is unavailable' }, { status: 503 })
      }
      posts.push(JSON.parse(String(init.body)))
      return Response.json({ id: `sent-${posts.length}` })
    })
    const schedule = async (body: string) => { const message = await scheduleGuestReply(db, owner, 'recovery-thread', { body, due_at: minutes(1) }); return { ...message, threadId: message.conversation_id! } }
    const saved = (id: string) => db.prepare('SELECT status, reason, error_code, message_id, sent_at FROM scheduled_guest_messages WHERE id = ?').bind(id).first<{ status: string; reason: string | null; error_code: string | null; message_id: string | null; sent_at: string | null }>()
    const retry = (body: string, id: string) => executeGuestThreadOperation(db, { threadId: 'recovery-thread', organizationId: ORG, action: 'reply', actorUserId: ADMIN, body, idempotencyKey: `send-later:${id}`, env })

    // Resend refuses the send: the job is failed with Resend's error and its exact entry, not left Sending.
    const reply = await schedule('Your request is handled.')
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(2)), { sent: 0, failed: 1, needs_review: 0 })
    const failed = (await saved(reply.id))!
    assert.equal(failed.status, 'failed')
    assert.match(failed.reason!, /Resend is unavailable/u)
    assert.equal(failed.error_code, 'DELIVERY_FAILED')
    assert.ok(failed.message_id)
    const message = await db.prepare('SELECT author_user_id, body, dedupe_key FROM messages WHERE id = ?').bind(failed.message_id).first<{ author_user_id: string; body: string; dedupe_key: string }>()
    assert.deepEqual(message, { author_user_id: OWNER, body: reply.body, dedupe_key: operationDedupeKey({ threadId: reply.threadId, idempotencyKey: `send-later:${reply.id}` }) })
    assert.equal((await ownReplies(db, owner, reply.threadId))[0]?.message_id, failed.message_id)
    assert.equal(posts.length, 0)
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(3)), { sent: 0, failed: 0, needs_review: 0 })
    assert.equal(posts.length, 0, 'a failed job is not resent by the next run')

    // Inbox Retry sends the same reply under the same key. Another admin can
    // retry it; ownership remains with the original immutable author.
    assert.equal((await retry(reply.body, reply.id)).ok, true)
    const completed = (await saved(reply.id))!
    assert.deepEqual([completed.status, completed.reason, completed.error_code, completed.message_id], ['sent', null, null, failed.message_id])
    assert.ok(completed.sent_at)
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.headers?.['In-Reply-To'], undefined, 'missing historical RFC metadata does not produce an invented parent')
    assert.equal(posts[0]?.headers?.References, undefined)
    // Resend's webhook records the email's RFC Message-ID, which later replies answer.
    assert.equal(await applyResendEmailEvent(db, env, { type: 'email.sent', created_at: now,
      data: { email_id: 'sent-1', created_at: now, from: 'hello@krabiclaw.com', to: ['delivered@resend.dev'], subject: posts[0]!.subject, message_id: '<sent-1@resend.dev>' } } as Parameters<typeof applyResendEmailEvent>[2]), 'unchanged')
    assert.equal(await db.prepare('SELECT email_message_id FROM guest_thread_deliveries WHERE message_id = ?').bind(failed.message_id).first('email_message_id'), '<sent-1@resend.dev>')
    assert.deepEqual((await ownReplies(db, owner, reply.threadId)).map(message => [message.id, message.status]), [[reply.id, 'sent']], 'the outbox shows the completed reply as sent')
    assert.equal((await retry(reply.body, reply.id)).ok, true)
    assert.equal(posts.length, 1)
    assert.equal(await db.prepare('SELECT count(*) count FROM messages WHERE dedupe_key = ?').bind(message!.dedupe_key).first('count'), 1)
    await appendMessage(db, { conversationId: reply.threadId, authorKind: 'guest', authorUserId: null, channel: 'email', body: 'A new question',
      payload: { email: { from: 'delivered@resend.dev', messageId: '<guest-question@resend.dev>', subject: null } } })

    // A legacy interruption left Sending with no job entry link, but already
    // wrote the immutable entry and pending receipt. Retry repairs the actual
    // lifecycle through those same records, with exactly one provider POST.
    const legacy = await schedule('Legacy scheduled reply.')
    await db.prepare("UPDATE scheduled_guest_messages SET status = 'sending', started_at = ? WHERE id = ?").bind(now, legacy.id).run()
    const original = await appendMessage(db, { conversationId: legacy.threadId, authorKind: 'member', authorUserId: OWNER, channel: 'email', body: legacy.body, eventName: 'thread.member_reply',
      dedupeKey: operationDedupeKey({ threadId: legacy.threadId, idempotencyKey: `send-later:${legacy.id}` }), payload: { request_hash: await creationRequestHash({ body: legacy.body, photos: [] }) } })
    await createDeliveryReceipt(db, { subject: { messageId: original.id }, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: `guest-thread-email:${legacy.threadId}:send-later:${legacy.id}` })
    assert.equal((await retry(legacy.body, legacy.id)).ok, true)
    assert.deepEqual([(await saved(legacy.id))?.status, (await saved(legacy.id))?.message_id], ['sent', original.id])
    assert.equal(posts.length, 2)
    assert.equal(posts[1]?.headers?.['In-Reply-To'], '<guest-question@resend.dev>', 'the latest genuine inbound RFC ID supplies the parent')
    assert.equal(posts[1]?.headers?.References, '<sent-1@resend.dev> <guest-question@resend.dev>', 'references contain only retained inbound and outbound RFC IDs')
    assert.equal((await retry(legacy.body, legacy.id)).ok, true)
    assert.equal(posts.length, 2, 'the original pending receipt sends once and settled retry sends nothing')

    // Resend's accepted id proves the send. An interrupted dispatcher's saved error still has to
    // clear through that dispatcher, or Today would keep showing the completed job as attention.
    await db.prepare("UPDATE guest_thread_deliveries SET error = 'Interrupted after Resend accepted it' WHERE message_id = ?").bind(original.id).run()
    assert.equal((await retry(legacy.body, legacy.id)).ok, true)
    assert.equal(await db.prepare('SELECT error FROM guest_thread_deliveries WHERE message_id = ?').bind(original.id).first('error'), null)
    assert.equal(posts.length, 2)

    const notStarted = await schedule('Not due yet.')
    await assert.rejects(retry(notStarted.body, notStarted.id), /already-started scheduled message/)
    await cancelScheduledGuestMessage(db, env, await stayAccessFor(owner), notStarted.id)
    await assert.rejects(retry(notStarted.body, notStarted.id), /already-started scheduled message/)
    assert.equal(posts.length, 2, 'pending and cancelled scheduled replies cannot be started by Retry')

    // Corrupt recorded RFC metadata fails before dispatch: the job is failed with the actual entry and
    // reason, the run reports the error, and a later cron does not resend it.
    await appendMessage(db, { conversationId: reply.threadId, authorKind: 'guest', authorUserId: null, channel: 'email', body: 'Bad metadata', payload: { email: { from: 'delivered@resend.dev', messageId: 'invalid-rfc-id', subject: 'Question' } } })
    const invalid = await schedule('Cannot use corrupt metadata.')
    await assert.rejects(sendDueScheduledGuestMessages(db, env, minutes(2)), /Received conversation email has invalid threading metadata/u)
    const refused = (await saved(invalid.id))!
    assert.deepEqual([refused.status, refused.reason, refused.error_code], ['failed', 'Received conversation email has invalid threading metadata', 'SCHEDULED_MESSAGE_DELIVERY_FAILED'])
    assert.ok(refused.message_id)
    assert.equal(await db.prepare('SELECT body FROM messages WHERE id = ?').bind(refused.message_id).first('body'), invalid.body)
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, minutes(3)), { sent: 0, failed: 0, needs_review: 0 })
    assert.equal(posts.length, 2)
  } finally {
    await runtime.dispose()
  }
})
