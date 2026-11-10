import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { cancelScheduledGuestMessage, deleteMessageTemplate, saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { sendDueScheduledGuestMessages } from '../../server/domain/scheduled-guest-messages.ts'
import { cancelSendLaterMessage, createSendLaterMessage, listSendLaterMessages, sendDueSendLaterMessages, updateSendLaterMessage } from '../../server/domain/send-later.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import type { DashboardInvalidation } from '../../shared/dashboard-invalidations.ts'
import { requestInsertQueries } from '../../server/domain/requests.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { applyResendEmailEvent, createDeliveryReceipt, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { executeGuestThreadOperation, operationDedupeKey } from '../../server/domain/guest-threads/operations.ts'
import { creationRequestHash } from '../../server/utils/organization-events.ts'

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
    assert.deepEqual([(await checkIn(cy.id))?.status, (await checkIn(cy.id))?.request_id], ['pending', cy.request_id])

    // The automatic message's name is reserved, and every automatic message needs a schedule.
    await assert.rejects(saveMessageTemplate(db, env, manager, null, { title: 'Check-in instructions', body: 'x', schedule: { trigger: 'check_in', offsetDays: 0, localTime: '09:00', productIds: [cabin.id] } }), { data: { code: 'MESSAGE_TITLE_RESERVED', field: 'title' } })
    await assert.rejects(saveMessageTemplate(db, env, manager, null, { title: 'Hello', body: 'x', schedule: null }), { data: { code: 'MESSAGE_SCHEDULE_REQUIRED', field: 'schedule' } })

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
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    const publications = async () => await (await hub.fetch('https://hub/observed')).json() as DashboardInvalidation[]
    await assert.rejects(createSendLaterMessage(db, owner, ana.request_id!, { body: 'Too late', sendAt: minutes(-1) }), { data: { code: 'SEND_LATER_IN_PAST', field: 'sendAt' } })
    const reply = await createSendLaterMessage(db, owner, ana.request_id!, { body: 'Enjoy the hot tub tonight!', sendAt: minutes(60) })
    const createdEvent = (await publications()).at(-1)!
    assert.deepEqual([createdEvent.type, createdEvent.organizationId, 'locationId' in createdEvent ? createdEvent.locationId : null, 'threadId' in createdEvent ? createdEvent.threadId : null], ['thread.changed', ORG, 'cabin-site', ana.request_id])
    assert.deepEqual(await db.prepare('SELECT request_id, body, status FROM send_later_messages WHERE id = ?').bind(reply.id).first(), { request_id: ana.request_id, body: 'Enjoy the hot tub tonight!', status: 'pending' })
    assert.deepEqual((await listSendLaterMessages(db, owner, ana.request_id!)).map(message => message.id), [reply.id])
    assert.deepEqual(await listSendLaterMessages(db, admin, null), [])
    await assert.rejects(cancelSendLaterMessage(db, admin, reply.id), { data: { code: 'SEND_LATER_NOT_FOUND', field: 'messageId' } })
    const edited = await updateSendLaterMessage(db, owner, reply.id, { body: 'Enjoy the hot tub!', sendAt: minutes(30), expectedVersion: 1 })
    assert.equal((await publications()).at(-1)?.type, 'thread.changed')
    assert.deepEqual(await db.prepare('SELECT body, due_at, version FROM send_later_messages WHERE id = ?').bind(edited.id).first(), { body: edited.body, due_at: edited.sendAt, version: 2 })
    await assert.rejects(updateSendLaterMessage(db, owner, reply.id, { body: 'x', sendAt: minutes(30), expectedVersion: 1 }), { data: { code: 'SEND_LATER_VERSION_CONFLICT', field: 'expectedVersion' } })

    // The admin schedules one too, then loses their membership before it is due.
    const orphaned = await createSendLaterMessage(db, admin, ana.request_id!, { body: 'From the admin', sendAt: minutes(20) })
    const cancelled = await createSendLaterMessage(db, owner, ana.request_id!, { body: 'Never mind', sendAt: minutes(25) })
    assert.equal((await cancelSendLaterMessage(db, owner, cancelled.id)).status, 'cancelled')
    assert.equal((await publications()).at(-1)?.type, 'thread.changed')
    assert.equal(await db.prepare('SELECT status FROM send_later_messages WHERE id = ?').bind(cancelled.id).first('status'), 'cancelled')

    // A committed schedule whose dashboard publication failed is reported as
    // committed, so the caller reloads it instead of creating a duplicate.
    await hub.fetch('https://hub/failure', { method: 'PUT' })
    let committedId: string | null = null
    await assert.rejects(createSendLaterMessage(db, owner, ana.request_id!, { body: 'Saved despite publication failure', sendAt: minutes(26) }), error => {
      const data = (error as { data?: { code: string; committed: boolean; message_id: string } }).data
      assert.equal(data?.code, 'DASHBOARD_PUBLICATION_FAILED')
      assert.equal(data?.committed, true)
      committedId = data!.message_id
      return true
    })
    assert.deepEqual(await db.prepare('SELECT status, body FROM send_later_messages WHERE id = ?').bind(committedId).first(), { status: 'pending', body: 'Saved despite publication failure' })
    await hub.fetch('https://hub/failure', { method: 'DELETE' })
    await cancelSendLaterMessage(db, owner, committedId!)
    await db.prepare("DELETE FROM member WHERE userId = ?").bind(ADMIN).run()

    // Not yet due, nothing goes out; at its time the owner's goes out as the owner's own reply.
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(10)), { sent: 0, failed: 0, needs_review: 0 })
    const beforeSending = (await publications()).length
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(31)), { sent: 1, failed: 1, needs_review: 0 })
    const delivered = await db.prepare('SELECT * FROM send_later_messages WHERE id = ?').bind(edited.id).first<Record<string, string | null>>()
    assert.equal(delivered?.status, 'sent')
    assert.deepEqual(await db.prepare('SELECT request_id, actor_kind, actor_user_id, body FROM activity_entries WHERE id = ?').bind(delivered?.entry_id).first(), {
      request_id: ana.request_id, actor_kind: 'member', actor_user_id: OWNER, body: 'Enjoy the hot tub!',
    })
    const refused = await db.prepare('SELECT status, error_code, entry_id FROM send_later_messages WHERE id = ?').bind(orphaned.id).first()
    assert.deepEqual(refused, { status: 'failed', error_code: 'SEND_LATER_ACCESS_REVOKED', entry_id: null })
    assert.ok((await publications()).slice(beforeSending).some(event => event.type === 'thread.changed' && 'threadId' in event && event.threadId === ana.request_id), 'a typed failure with no activity entry still refreshes its conversation')
    assert.equal((await db.prepare('SELECT status FROM send_later_messages WHERE id = ?').bind(cancelled.id).first('status')), 'cancelled')

    // A repeated run sends nothing again.
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(40)), { sent: 0, failed: 0, needs_review: 0 })

    // A stay's automatic messages belong to its conversation, so their changes refresh that conversation.
    const threadChanges = (events: DashboardInvalidation[]) => events.flatMap(event => event.type === 'thread.changed' && 'threadId' in event ? [event.threadId] : [])
    let beforeChange = (await publications()).length
    const automatic = await saveMessageTemplate(db, env, manager, null, { title: 'After your stay', body: 'Thanks for staying.',
      schedule: { trigger: 'check_out', offsetDays: 7, localTime: '09:00', productIds: [cabin.id] } })
    const automaticRow = await db.prepare('SELECT id, request_id, status FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(cy.id, automatic.id).first<{ id: string; request_id: string; status: string }>()
    assert.deepEqual([automaticRow?.request_id, automaticRow?.status], [cy.request_id, 'pending'])
    assert.ok(threadChanges((await publications()).slice(beforeChange)).includes(cy.request_id))
    beforeChange = (await publications()).length
    const updatedAutomatic = await saveMessageTemplate(db, env, manager, automatic.id, { title: 'After your stay', body: 'Thank you for visiting.', expectedVersion: automatic.version,
      schedule: { trigger: 'check_out', offsetDays: 7, localTime: '09:00', productIds: [cabin.id] } })
    assert.equal(await db.prepare('SELECT body FROM scheduled_guest_messages WHERE id = ?').bind(automaticRow!.id).first('body'), 'Thank you for visiting.')
    assert.ok(threadChanges((await publications()).slice(beforeChange)).includes(cy.request_id))
    beforeChange = (await publications()).length
    await cancelScheduledGuestMessage(db, env, manager, automaticRow!.id)
    assert.equal(await db.prepare('SELECT status FROM scheduled_guest_messages WHERE id = ?').bind(automaticRow!.id).first('status'), 'cancelled')
    assert.deepEqual(threadChanges((await publications()).slice(beforeChange)), [cy.request_id])
    beforeChange = (await publications()).length
    await deleteMessageTemplate(db, env, manager, automatic.id, updatedAutomatic.version)
    assert.equal(await db.prepare('SELECT count(*) n FROM message_templates WHERE id = ?').bind(automatic.id).first('n'), 0)
    assert.ok(threadChanges((await publications()).slice(beforeChange)).includes(cy.request_id))

    // When the note is due it goes out through each stay's own conversation: Ana's, Bo's and Cy's.
    const afterCheckout = await saveMessageTemplate(db, env, manager, null, { title: 'After checkout', body: 'We hope you enjoyed your stay.',
      schedule: { trigger: 'check_out', offsetDays: 7, localTime: '11:00', productIds: [cabin.id] } })
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, `${day(18)}T23:59:00.000Z`), { sent: 3, failed: 0, needs_review: 0 })
    const cySent = await db.prepare('SELECT status, entry_id, request_id FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(cy.id, afterCheckout.id).first<{ status: string; entry_id: string; request_id: string }>()
    assert.deepEqual([cySent?.status, cySent?.request_id], ['sent', cy.request_id])
    assert.deepEqual(await db.prepare('SELECT request_id, body FROM activity_entries WHERE id = ?').bind(cySent!.entry_id).first(), { request_id: cy.request_id, body: 'We hope you enjoyed your stay.' })
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
    await db.batch(requestInsertQueries({ id: 'recovery-thread', kind: 'contact', organization_id: ORG, location_id: null, user_id: null, review_id: null,
      payload: { guest: { name: 'Test inbox', email: 'delivered@resend.dev', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null },
      created_at: now, updated_at: now }).map(write => db.prepare(write.query).bind(...write.params)))
    const owner = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: OWNER }))!, { env })
    const historical = await appendEntry(db, { threadId: 'recovery-thread', kind: 'message', actorKind: 'member', actorUserId: OWNER, channel: 'email', body: 'Old reply', eventName: 'thread.member_reply' })
    const expired = await createDeliveryReceipt(db, { entryId: historical.id, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'expired-history' })
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
    const schedule = (body: string) => createSendLaterMessage(db, owner, 'recovery-thread', { body, sendAt: minutes(1) })
    const saved = (id: string) => db.prepare('SELECT status, reason, error_code, entry_id, sent_at FROM send_later_messages WHERE id = ?').bind(id).first<{ status: string; reason: string | null; error_code: string | null; entry_id: string | null; sent_at: string | null }>()
    const retry = (body: string, id: string) => executeGuestThreadOperation(db, { threadId: 'recovery-thread', organizationId: ORG, action: 'reply', actorUserId: ADMIN, body, idempotencyKey: `send-later:${id}`, env })

    // Resend refuses the send: the job is failed with Resend's error and its exact entry, not left Sending.
    const reply = await schedule('Your request is handled.')
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(2)), { sent: 0, failed: 1, needs_review: 0 })
    const failed = (await saved(reply.id))!
    assert.equal(failed.status, 'failed')
    assert.match(failed.reason!, /Resend is unavailable/u)
    assert.equal(failed.error_code, 'DELIVERY_FAILED')
    assert.ok(failed.entry_id)
    const message = await db.prepare('SELECT actor_user_id, body, dedupe_key FROM activity_entries WHERE id = ?').bind(failed.entry_id).first<{ actor_user_id: string; body: string; dedupe_key: string }>()
    assert.deepEqual(message, { actor_user_id: OWNER, body: reply.body, dedupe_key: operationDedupeKey({ threadId: reply.threadId, idempotencyKey: `send-later:${reply.id}` }) })
    assert.equal((await listSendLaterMessages(db, owner, reply.threadId))[0]?.entryId, failed.entry_id)
    assert.equal(posts.length, 0)
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(3)), { sent: 0, failed: 0, needs_review: 0 })
    assert.equal(posts.length, 0, 'a failed job is not resent by the next run')

    // Inbox Retry sends the same reply under the same key. Another admin can
    // retry it; ownership remains with the original immutable author.
    assert.equal((await retry(reply.body, reply.id)).ok, true)
    const completed = (await saved(reply.id))!
    assert.deepEqual([completed.status, completed.reason, completed.error_code, completed.entry_id], ['sent', null, null, failed.entry_id])
    assert.ok(completed.sent_at)
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.headers?.['In-Reply-To'], undefined, 'missing historical RFC metadata does not produce an invented parent')
    assert.equal(posts[0]?.headers?.References, undefined)
    // Resend's webhook records the email's RFC Message-ID, which later replies answer.
    assert.equal(await applyResendEmailEvent(db, env, { type: 'email.sent', created_at: now,
      data: { email_id: 'sent-1', created_at: now, from: 'hello@krabiclaw.com', to: ['delivered@resend.dev'], subject: posts[0]!.subject, message_id: '<sent-1@resend.dev>' } } as Parameters<typeof applyResendEmailEvent>[2]), 'unchanged')
    assert.equal(await db.prepare('SELECT email_message_id FROM guest_thread_deliveries WHERE entry_id = ?').bind(failed.entry_id).first('email_message_id'), '<sent-1@resend.dev>')
    assert.deepEqual(await listSendLaterMessages(db, owner, reply.threadId), [], 'completed scheduled work disappears from the author’s outstanding work')
    assert.equal((await retry(reply.body, reply.id)).ok, true)
    assert.equal(posts.length, 1)
    assert.equal(await db.prepare('SELECT count(*) count FROM activity_entries WHERE dedupe_key = ?').bind(message!.dedupe_key).first('count'), 1)
    await appendEntry(db, { threadId: reply.threadId, kind: 'message', actorKind: 'guest', channel: 'email', body: 'A new question',
      payloadJson: { email: { from: 'delivered@resend.dev', messageId: '<guest-question@resend.dev>', subject: null } } })

    // A legacy interruption left Sending with no job entry link, but already
    // wrote the immutable entry and pending receipt. Retry repairs the actual
    // lifecycle through those same records, with exactly one provider POST.
    const legacy = await schedule('Legacy scheduled reply.')
    await db.prepare("UPDATE send_later_messages SET status = 'sending', started_at = ? WHERE id = ?").bind(now, legacy.id).run()
    const original = await appendEntry(db, { threadId: legacy.threadId, kind: 'message', actorKind: 'member', actorUserId: OWNER, channel: 'email', body: legacy.body, eventName: 'thread.member_reply',
      dedupeKey: operationDedupeKey({ threadId: legacy.threadId, idempotencyKey: `send-later:${legacy.id}` }), payloadJson: { request_hash: await creationRequestHash({ body: legacy.body, photos: [] }) } })
    await createDeliveryReceipt(db, { entryId: original.id, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: `guest-thread-email:${legacy.threadId}:send-later:${legacy.id}` })
    assert.equal((await retry(legacy.body, legacy.id)).ok, true)
    assert.deepEqual([(await saved(legacy.id))?.status, (await saved(legacy.id))?.entry_id], ['sent', original.id])
    assert.equal(posts.length, 2)
    assert.equal(posts[1]?.headers?.['In-Reply-To'], '<guest-question@resend.dev>', 'the latest genuine inbound RFC ID supplies the parent')
    assert.equal(posts[1]?.headers?.References, '<sent-1@resend.dev> <guest-question@resend.dev>', 'references contain only retained inbound and outbound RFC IDs')
    assert.equal((await retry(legacy.body, legacy.id)).ok, true)
    assert.equal(posts.length, 2, 'the original pending receipt sends once and settled retry sends nothing')

    // Resend's accepted id proves the send. An interrupted dispatcher's saved error still has to
    // clear through that dispatcher, or Today would keep showing the completed job as attention.
    await db.prepare("UPDATE guest_thread_deliveries SET error = 'Interrupted after Resend accepted it' WHERE entry_id = ?").bind(original.id).run()
    assert.equal((await retry(legacy.body, legacy.id)).ok, true)
    assert.equal(await db.prepare('SELECT error FROM guest_thread_deliveries WHERE entry_id = ?').bind(original.id).first('error'), null)
    assert.equal(posts.length, 2)

    const notStarted = await schedule('Not due yet.')
    await assert.rejects(retry(notStarted.body, notStarted.id), /already-started scheduled message/)
    await cancelSendLaterMessage(db, owner, notStarted.id)
    await assert.rejects(retry(notStarted.body, notStarted.id), /already-started scheduled message/)
    assert.equal(posts.length, 2, 'pending and cancelled scheduled replies cannot be started by Retry')

    // Corrupt recorded RFC metadata fails before dispatch: the job is failed with the actual entry and
    // reason, the run reports the error, and a later cron does not resend it.
    await appendEntry(db, { threadId: reply.threadId, kind: 'message', actorKind: 'guest', channel: 'email', body: 'Bad metadata', payloadJson: { email: { from: 'delivered@resend.dev', messageId: 'invalid-rfc-id', subject: 'Question' } } })
    const invalid = await schedule('Cannot use corrupt metadata.')
    await assert.rejects(sendDueSendLaterMessages(db, env, minutes(2)), /Received conversation email has invalid threading metadata/u)
    const refused = (await saved(invalid.id))!
    assert.deepEqual([refused.status, refused.reason, refused.error_code], ['failed', 'Received conversation email has invalid threading metadata', 'SEND_LATER_DELIVERY_FAILED'])
    assert.ok(refused.entry_id)
    assert.equal(await db.prepare('SELECT body FROM activity_entries WHERE id = ?').bind(refused.entry_id).first('body'), invalid.body)
    assert.deepEqual(await sendDueSendLaterMessages(db, env, minutes(3)), { sent: 0, failed: 0, needs_review: 0 })
    assert.equal(posts.length, 2)
  } finally {
    await runtime.dispose()
  }
})
