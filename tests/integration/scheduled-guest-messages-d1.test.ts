import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, type StayAccess } from '../../server/domain/stays.ts'
import { saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { sendDueScheduledGuestMessages } from '../../server/domain/scheduled-guest-messages.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// The production cron sends what its plan made due, through each conversation's
// own address, and records every outcome on the scheduled message itself.

const ORG = 'org'
const OWNER = 'owner-user'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

test('the cron sends due messages, leaves future ones pending and records failures and review outcomes', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'scheduled-messages-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'scheduled-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })

    // Saved before the stays arrive: a welcome five minutes after each new direct
    // reservation, and an arrival note at noon on check-in day.
    const welcome = await saveMessageTemplate(db, manager, null, { title: 'Welcome', body: 'Thanks for booking the cabin.', schedule: { trigger: 'booking_received', delayMinutes: 5, productIds: [cabin.id] } })
    const arrival = await saveMessageTemplate(db, manager, null, { title: 'Arrival', body: 'See you today.', schedule: { trigger: 'check_in', offsetDays: 0, localTime: '12:00', productIds: [cabin.id] } })
    const ana = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'ana', check_in_date: day(3), check_out_date: day(5), adults: 2, guest_name: 'Ana', guest_email: 'ana@example.test', total_minor: 30_000 })
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(10), check_out_date: day(11), adults: 1, guest_name: 'Dee', guest_phone: '+15557770000', total_minor: 15_000 })
    const cy = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'cy', check_in_date: day(20), check_out_date: day(21), adults: 1, guest_name: 'Cy', guest_email: 'cy@example.test', total_minor: 15_000 })
    const eve = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'eve', check_in_date: day(30), check_out_date: day(31), adults: 1, guest_name: 'Eve', guest_email: 'eve@example.test', total_minor: 15_000 })
    const planned = (stayId: string, templateId: string) => db.prepare('SELECT * FROM scheduled_guest_messages WHERE stay_id = ? AND template_id = ?').bind(stayId, templateId).first<Record<string, string | null>>()
    for (const stay of [ana, dee, cy, eve]) {
      assert.equal((await planned(stay.id, welcome.id))?.status, 'pending')
      assert.equal((await planned(stay.id, arrival.id))?.status, 'pending')
    }

    // A send recorded under Cy's key with other words cannot be reconciled
    // automatically; it goes to review rather than being sent again.
    const cyWelcome = (await planned(cy.id, welcome.id))!
    await db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      VALUES ('earlier-attempt', ?, 'message', 'request', 'system', 'email', 'Different words', 'thread.scheduled_message', '{"request_hash":"other"}', ?, 99, ?, ?)`)
      .bind(cy.request_id, `guest-thread-operation:${cy.request_id}:scheduled-guest-message:${cyWelcome.id}`, new Date().toISOString(), new Date().toISOString()).run()

    // Eve's conversation is addressed through Channex. The provider's answer to
    // the read before any send is malformed, so nothing is sent and the
    // message fails with the provider's typed facts instead of staying sending.
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing', 'channel', 'property', 'room', 'rate', 'complete', 1)`).bind(ORG, cabin.id).run()
    await db.prepare(`INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, request_id, external_booking_id, provider_updated_at)
      VALUES ('channex', 'thread-eve', ?, ?, ?, NULL, '2026-10-16T00:00:00')`).bind(ORG, cabin.id, eve.request_id).run()
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
    assert.deepEqual([providerFailed.status, providerFailed.error_code, providerFailed.error_field, providerFailed.entry_id, providerFailed.sent_at], ['failed', 'INVALID_PROVIDER_RESPONSE', 'data', null, null])
    assert.ok(providerFailed.reason)

    const sent = (await planned(ana.id, welcome.id))!
    assert.equal(sent.status, 'sent')
    assert.ok(sent.sent_at && sent.entry_id)
    assert.deepEqual(await db.prepare('SELECT e.request_id, e.actor_kind, e.actor_user_id, e.event_name, e.body, d.channel, d.purpose, d.status FROM activity_entries e JOIN guest_thread_deliveries d ON d.entry_id = e.id WHERE e.id = ?').bind(sent.entry_id).first(), {
      request_id: ana.request_id, actor_kind: 'system', actor_user_id: null, event_name: 'thread.scheduled_message', body: 'Thanks for booking the cabin.', channel: 'email', purpose: 'scheduled_message', status: 'sent',
    })
    // Phone alone, with no guest who joined through an invite, is nowhere to send: the failure is recorded with its own facts.
    const failed = (await planned(dee.id, welcome.id))!
    assert.deepEqual([failed.status, failed.error_code, failed.error_field, failed.reason, failed.entry_id, failed.sent_at],
      ['failed', 'GUEST_INVITE_REQUIRED', 'request_id', 'The stay has no guest email and its guest has not joined the conversation through an invite.', null, null])
    const review = (await planned(cy.id, welcome.id))!
    assert.deepEqual([review.status, review.error_code, review.error_field, review.sent_at], ['needs_review', 'IDEMPOTENCY_CONFLICT', 'idempotencyKey', null])
    assert.ok(review.reason)
    for (const stay of [ana, dee, cy, eve]) assert.equal((await planned(stay.id, arrival.id))?.status, 'pending')

    // A repeated run sends nothing again and changes no recorded outcome.
    assert.deepEqual(await sendDueScheduledGuestMessages(db, channexEnv, later), { sent: 0, failed: 0, needs_review: 0 })
    assert.equal(await db.prepare("SELECT count(*) AS n FROM activity_entries WHERE event_name = 'thread.scheduled_message'").first('n'), 2)

    // A schedule saved after its event has passed records the miss instead of sending late.
    const lateNote = await saveMessageTemplate(db, manager, null, { title: 'Pre-arrival', body: 'Your stay is a week away.', schedule: { trigger: 'check_in', offsetDays: -7, localTime: '09:00', productIds: [cabin.id] } })
    const missed = (await planned(ana.id, lateNote.id))!
    assert.deepEqual([missed.status, missed.reason], ['skipped', 'This event was already in the past when the schedule or stay changed.'])
    assert.equal((await planned(cy.id, lateNote.id))?.status, 'pending')
  } finally {
    await runtime.dispose()
  }
})
