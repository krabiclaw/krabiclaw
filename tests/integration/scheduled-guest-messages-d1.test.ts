import assert from 'node:assert/strict'
import { appendMessage } from '../../server/domain/conversations.ts'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, type StayAccess } from '../../server/domain/stays.ts'
import { cancelScheduledGuestMessage, deleteMessageTemplate, saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { sendDueScheduledGuestMessages } from '../../server/domain/scheduled-guest-messages.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import type { DashboardInvalidation } from '../../shared/dashboard-invalidations.ts'

// The production cron sends what its plan made due, through each conversation's
// own address, and records every outcome on the scheduled message itself.

const ORG = 'org'
const OWNER = 'owner-user'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

test('the cron sends due messages, leaves future ones pending and records failures and review outcomes', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'scheduled-messages-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(ctx) { this.storage = ctx.storage }
      async fetch(request) {
        if (new URL(request.url).pathname === '/observed') return Response.json(await this.storage.get('events') ?? [])
        await this.storage.put('events', [...await this.storage.get('events') ?? [], await request.json()])
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'scheduled-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'm-owner' },
    } })

    // Saved before the stays arrive: a welcome five minutes after each new direct
    // reservation, and an arrival note at noon on check-in day.
    const welcome = await saveMessageTemplate(db, env, manager, null, { title: 'Welcome', body: 'Thanks for booking the cabin.', schedule: { trigger: 'booking_received', delay_minutes: 5, product_ids: [cabin.id] } })
    const arrival = await saveMessageTemplate(db, env, manager, null, { title: 'Arrival', body: 'See you today.', schedule: { trigger: 'check_in', offset_days: 0, local_time: '12:00', product_ids: [cabin.id] } })
    const ana = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'ana', check_in_date: day(3), check_out_date: day(5), adults: 2, guest_name: 'Ana', guest_email: 'ana@example.test', total_minor: 30_000 })
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(10), check_out_date: day(11), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 15_000 })
    const cy = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'cy', check_in_date: day(20), check_out_date: day(21), adults: 1, guest_name: 'Cy', guest_email: 'cy@example.test', total_minor: 15_000 })
    const eve = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'eve', check_in_date: day(30), check_out_date: day(31), adults: 1, guest_name: 'Eve', guest_email: 'eve@example.test', total_minor: 15_000 })
    const planned = (stayId: string, templateId: string) => db.prepare('SELECT * FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(stayId, templateId).first<Record<string, string | null>>()
    for (const stay of [ana, dee, cy, eve]) {
      assert.equal((await planned(stay.id, welcome.id))?.status, 'pending')
      assert.equal((await planned(stay.id, arrival.id))?.status, 'pending')
    }

    // A send recorded under Cy's key with other words cannot be reconciled
    // automatically; it goes to review rather than being sent again.
    const cyWelcome = (await planned(cy.id, welcome.id))!
    await appendMessage(db, { id: 'earlier-attempt', conversationId: cy.conversation_id, authorKind: 'krabiclaw', authorUserId: null, channel: 'email', body: 'Different words',
      eventName: 'thread.scheduled_message', payload: { request_hash: 'other' }, dedupeKey: `guest-thread-operation:${cy.conversation_id}:scheduled-guest-message:${cyWelcome.id}` })

    // Eve's conversation is addressed through Channex. The provider's answer to
    // the read before any send is malformed, so nothing is sent and the
    // message fails with the provider's typed facts instead of staying sending.
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing', 'channel', 'property', 'room', 'rate', 'complete', 1)`).bind(ORG, cabin.id).run()
    await db.prepare(`INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, conversation_id, external_booking_id, provider_updated_at)
      VALUES ('channex', 'thread-eve', ?, ?, ?, NULL, '2026-10-16T00:00:00')`).bind(ORG, cabin.id, eve.conversation_id).run()
    const channexEnv = { ...env, CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-provider-key' } as CloudflareEnv
    const realFetch = globalThis.fetch
    const providerCalls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      providerCalls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    // Ten minutes later every welcome is due and no arrival note is.
    const later = new Date(Date.now() + 10 * 60_000).toISOString()
    try {
      assert.deepEqual(await sendDueScheduledGuestMessages(db, channexEnv, later), { sent: 1, failed: 2, needs_review: 1 })
    } finally { globalThis.fetch = realFetch }
    assert.deepEqual(providerCalls.filter(call => call.startsWith('POST')), [])
    const providerFailed = (await planned(eve.id, welcome.id))!
    assert.deepEqual([providerFailed.status, providerFailed.error_code, providerFailed.error_field, providerFailed.message_id, providerFailed.sent_at], ['failed', 'INVALID_PROVIDER_RESPONSE', 'data', null, null])
    assert.ok(providerFailed.reason)

    const sent = (await planned(ana.id, welcome.id))!
    assert.equal(sent.status, 'sent')
    assert.ok(sent.sent_at && sent.message_id)
    assert.deepEqual(await db.prepare('SELECT e.conversation_id, e.author_kind, e.author_user_id, e.event_name, e.body, d.channel, d.purpose, d.status FROM messages e JOIN guest_thread_deliveries d ON d.message_id = e.id WHERE e.id = ?').bind(sent.message_id).first(), {
      conversation_id: ana.conversation_id, author_kind: 'krabiclaw', author_user_id: null, event_name: 'thread.scheduled_message', body: 'Thanks for booking the cabin.', channel: 'email', purpose: 'scheduled_message', status: 'sent',
    })
    // Phone alone, with no email and no KrabiClaw account, is nowhere to send: the failure is recorded with its own facts.
    const failed = (await planned(dee.id, welcome.id))!
    assert.deepEqual([failed.status, failed.error_code, failed.error_field, failed.reason, failed.message_id, failed.sent_at],
      ['failed', 'GUEST_UNREACHABLE', 'conversation_id', 'This guest has no email or KrabiClaw account to reply to.', null, null])
    const review = (await planned(cy.id, welcome.id))!
    assert.deepEqual([review.status, review.error_code, review.error_field, review.sent_at], ['needs_review', 'IDEMPOTENCY_CONFLICT', 'idempotencyKey', null])
    assert.ok(review.reason)
    for (const stay of [ana, dee, cy, eve]) assert.equal((await planned(stay.id, arrival.id))?.status, 'pending')

    // A repeated run sends nothing again and changes no recorded outcome.
    assert.deepEqual(await sendDueScheduledGuestMessages(db, channexEnv, later), { sent: 0, failed: 0, needs_review: 0 })
    assert.equal(await db.prepare("SELECT count(*) AS n FROM messages WHERE event_name = 'thread.scheduled_message'").first('n'), 2)

    // A schedule saved after its event has passed records the miss instead of sending late.
    const lateNote = await saveMessageTemplate(db, env, manager, null, { title: 'Pre-arrival', body: 'Your stay is a week away.', schedule: { trigger: 'check_in', offset_days: -7, local_time: '09:00', product_ids: [cabin.id] } })
    const missed = (await planned(ana.id, lateNote.id))!
    assert.deepEqual([missed.status, missed.reason], ['skipped', 'This event was already in the past when the schedule or stay changed.'])
    assert.equal((await planned(cy.id, lateNote.id))?.status, 'pending')

    // Editing and cancelling future automatic work reaches every affected
    // conversation's open dashboard through the same canonical event.
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    const publications = async () => await (await hub.fetch('https://hub/observed')).json() as DashboardInvalidation[]
    let observed = (await publications()).length
    const changed = await saveMessageTemplate(db, env, manager, lateNote.id, { title: 'Pre-arrival', body: 'Your stay is coming up.', version: lateNote.version,
      schedule: { trigger: 'check_in', offset_days: -6, local_time: '09:00', product_ids: [cabin.id] } })
    assert.equal((await planned(cy.id, lateNote.id))?.body, 'Your stay is coming up.')
    assert.deepEqual((await publications()).slice(observed).filter(event => event.type === 'MESSAGE_UPDATE').map(event => 'conversation_id' in event ? event.conversation_id : null).sort(), [ana, dee, cy, eve].map(stay => stay.conversation_id).sort())
    observed = (await publications()).length
    const cyNote = (await planned(cy.id, lateNote.id))!
    await cancelScheduledGuestMessage(db, env, manager, cyNote.id!)
    assert.equal((await planned(cy.id, lateNote.id))?.status, 'cancelled')
    assert.deepEqual((await publications()).slice(observed).map(event => [event.type, 'conversation_id' in event ? event.conversation_id : null]), [['MESSAGE_UPDATE', cy.conversation_id]])
    observed = (await publications()).length
    await deleteMessageTemplate(db, env, manager, lateNote.id, changed.version)
    assert.equal(await db.prepare('SELECT count(*) FROM message_templates WHERE id = ?').bind(lateNote.id).first('count(*)'), 0)
    assert.deepEqual(await db.prepare('SELECT template_id, status FROM scheduled_guest_messages WHERE id = ?').bind(cyNote.id).first(), { template_id: null, status: 'cancelled' })
    assert.deepEqual((await publications()).slice(observed).map(event => 'conversation_id' in event ? event.conversation_id : null).sort(), [ana, dee, cy, eve].map(stay => stay.conversation_id).sort())
  } finally {
    await runtime.dispose()
  }
})
