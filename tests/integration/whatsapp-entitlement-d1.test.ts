import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { sendWhatsAppNotification } from '../../server/utils/whatsapp.ts'
import { hasOrganizationEntitlement } from '../../server/utils/billing.ts'
import { notifyDomainLifecycle } from '../../server/utils/domain-notifications.ts'
import type { DomainRecord } from '../../server/utils/domains.ts'
import { notifyContactSubmitted, notifyGuestThreadReply } from '../../server/utils/notifications.ts'
import { requestInsertQueries } from '../../server/domain/requests.ts'
import { createDeliveryReceipt, getDeliveryById, isDeliverySent, isVisibleDeliveryFailure, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import whatsappWebhook from '../../server/api/whatsapp/webhook.post.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, getStay, updateStay } from '../../server/domain/stays.ts'
import { getWhatsAppWorkspaceState } from '../../server/utils/mcp-context.ts'

// Real D1 billing, membership, preferences and notification persistence. Only
// the external Meta HTTP boundary is intercepted; no live messages are sent.
test('organization messaging entitlement fences Meta calls while preserving notification fallbacks', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'guest-delivery-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'guest-delivery-proof', exportName: 'Hub' } },
  } }] })

  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))

    const providerEnv = { ...env, WHATSAPP_DELIVERY_MODE: 'provider', WHATSAPP_PHONE_NUMBER_ID: 'local-proof-phone-id', WHATSAPP_ACCESS_TOKEN: 'local-proof-no-live-token' }
    for (const id of ['free', 'paid']) {
      await db.prepare(`INSERT INTO organization (id,name,slug,subdomain, default_currency, timezone) VALUES (?,?,?,?, 'USD', 'UTC')`).bind(id, id, id, id).run()
      await db.prepare("INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES (?,?,'en',1,'published')").bind(`${id}-en`, id).run()
    }
    await db.prepare("INSERT INTO user (id,name,email,phoneNumber,phoneNumberVerified) VALUES ('owner','Owner','owner@proof.example','+66812345678',1)").run()
    for (const id of ['free', 'paid']) {
      await db.prepare("INSERT INTO member (id,organizationId,userId,role) VALUES (?,?,'owner','owner')").bind(`member-${id}`, id).run()
    }
    await db.prepare("INSERT INTO subscription (id,plan,referenceId,status,periodEnd) VALUES ('paid-sub','growth','paid','active',?)").bind(Math.floor(Date.now() / 1000) + 86400).run()
    let metaCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /^https:\/\/graph\.facebook\.com\//)
      assert.equal(init?.method, 'POST')
      metaCalls++
      return Response.json({ messages: [{ id: `meta-proof-${metaCalls}` }] })
    }
    try {
      const send = (organizationId: string) => sendWhatsAppNotification(providerEnv, { organizationId, toPhone: '+66812345678', template: 'domain_update', vars: { domain: 'proof.example', status: 'active', dashboard_url: 'https://proof.example/dashboard/paid/settings' } })
      const skipped = { success: true, status: 'skipped', reason: 'messaging_not_enabled' }
      assert.deepEqual(await send('free'), skipped)
      assert.equal(metaCalls, 0)
      assert.equal((await send('paid')).status, 'sent')
      assert.equal(metaCalls, 1)
      assert.equal(await hasOrganizationEntitlement(providerEnv, 'paid', 'messaging'), true)
      // An eligibility check made earlier cannot authorize a downgraded send.
      for (const status of ['past_due', 'canceled', 'incomplete', 'unpaid']) {
        await db.prepare("UPDATE subscription SET status=? WHERE id='paid-sub'").bind(status).run()
        assert.deepEqual(await send('paid'), skipped)
      }
      await db.prepare("UPDATE subscription SET status='active',periodEnd=? WHERE id='paid-sub'").bind(Math.floor(Date.now() / 1000) - 60).run()
      assert.deepEqual(await send('paid'), skipped)
      assert.equal(metaCalls, 1)
      await db.prepare("UPDATE subscription SET status='trialing',periodEnd=? WHERE id='paid-sub'").bind(Math.floor(Date.now() / 1000) + 86400).run()
      assert.equal((await send('paid')).status, 'sent')
      assert.equal(metaCalls, 2)
      await db.prepare("UPDATE subscription SET status='active' WHERE id='paid-sub'").run()

      // The same owner belongs to both organizations: eligibility is per org.
      for (const category of ['organization_and_billing', 'messages', 'reservations_bookings']) {
        await db.prepare('INSERT INTO user_notification_preferences (user_id,category,email_enabled,whatsapp_enabled,push_enabled) VALUES (?,?,1,1,0)').bind('owner', category).run()
      }
      const domain = (organizationId: string, status: DomainRecord['status']) => notifyDomainLifecycle(providerEnv, db, { organizationId, event: 'synced', domain: { domain: 'proof.example', type: 'custom', status } as DomainRecord, dashboardUrl: `https://proof.example/dashboard/${organizationId}/settings` })
      await domain('free', 'pending')
      assert.equal(metaCalls, 2)
      await domain('paid', 'active')
      assert.equal(metaCalls, 3)
      await db.prepare("UPDATE user_notification_preferences SET whatsapp_enabled=0 WHERE category='organization_and_billing'").run()
      await domain('paid', 'verifying')
      assert.equal(metaCalls, 3)

      for (const organizationId of ['free', 'paid']) {
        const id = `contact-${organizationId}`
        const now = new Date().toISOString()
        await db.batch(requestInsertQueries({ id, kind: 'contact', organization_id: organizationId, location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: { guest: { name: 'Guest', email: 'guest@proof.example', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null }, created_at: now, updated_at: now }).map(write => db.prepare(write.query).bind(...write.params)))
        const before = metaCalls
        await notifyContactSubmitted(providerEnv, db, { organizationId, organizationName: organizationId, vertical: 'restaurant', locationId: null, contactId: id, guestName: 'Guest', email: 'guest@proof.example', subject: null, message: 'Hello' })
        assert.equal(metaCalls - before, organizationId === 'paid' ? 1 : 0)
        const entry = await appendEntry(db, { threadId: id, kind: 'message', actorKind: 'guest', channel: 'email', body: 'Reply', dedupeKey: `reply-${id}` })
        const replyBefore = metaCalls
        await notifyGuestThreadReply(providerEnv, db, { organizationId, threadId: id, sourceEntryId: entry.id, submissionType: 'contact', submissionId: id, participantLabel: 'Guest', guestEmail: 'guest@proof.example', inboundChannel: 'email', messagePreview: 'Reply' })
        assert.equal(metaCalls - replyBefore, organizationId === 'paid' ? 1 : 0)
        const rows = (await db.prepare('SELECT d.channel,d.status FROM guest_thread_deliveries d JOIN activity_entries e ON e.id=d.entry_id WHERE e.request_id=?').bind(id).all<{ channel: string; status: string }>()).results
        assert(rows.some(row => row.channel === 'email' && row.status === 'sent'), 'email fallback persists')
        assert.equal(rows.filter(row => row.channel === 'whatsapp').length, organizationId === 'paid' ? 2 : 0)
        assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE kind='notification' AND organization_id=?").bind(organizationId).first('count'), organizationId === 'paid' ? 4 : 3, 'dashboard alerts persist independently of WhatsApp')
      }
      await db.prepare("UPDATE user_notification_preferences SET whatsapp_enabled=0 WHERE category='messages'").run()
      const entry = await appendEntry(db, { threadId: 'contact-paid', kind: 'message', actorKind: 'guest', channel: 'email', body: 'Opted out', dedupeKey: 'reply-optout' })
      const before = metaCalls
      await notifyGuestThreadReply(providerEnv, db, { organizationId: 'paid', threadId: 'contact-paid', sourceEntryId: entry.id, submissionType: 'contact', submissionId: 'contact-paid', participantLabel: 'Guest', inboundChannel: 'email', messagePreview: 'Opted out' })
      assert.equal(metaCalls, before)
      // A notification whose organization downgrades is explicitly skipped,
      // not represented as a failed or sent delivery.
      const receipt = await createDeliveryReceipt(db, { entryId: entry.id, channel: 'whatsapp', provider: 'meta', purpose: 'owner_alert', idempotencyKey: 'downgrade-proof' })
      await db.prepare("UPDATE subscription SET status='canceled' WHERE id='paid-sub'").run()
      const result = await send('paid')
      assert.equal(result.status, 'skipped')
      if (result.status !== 'skipped') assert.fail('Expected a skipped result')
      await recordDeliveryOutcome(db, { deliveryId: receipt.id, status: result.status, error: result.reason })
      const persisted = await getDeliveryById(db, receipt.id)
      assert(persisted)
      assert.equal(persisted.status, 'skipped')
      assert.equal(persisted.provider_message_id, null)
      assert.equal(isVisibleDeliveryFailure(persisted), false)
      assert.equal(isDeliverySent(persisted), false)
      assert.equal(metaCalls, before)
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    await runtime.dispose()
  }
})

// The signature is the webhook's only authentication, so a deployment that
// cannot check it accepts nothing.
test('the WhatsApp webhook accepts only what Meta signed with the configured app secret', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'whatsapp-webhook-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const bindings = await runtime.getBindings<CloudflareEnv>()
    const app = new H3()
    app.post('/api/whatsapp/webhook', whatsappWebhook)
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })
    const deliver = (env: Record<string, unknown>, signature?: string) => app.request(Object.assign(new Request('https://proof.example/api/whatsapp/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(signature && { 'x-hub-signature-256': signature }) }, body,
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

    const unconfigured = await deliver({ ...bindings }, sign('whatsapp-secret'))
    assert.equal(unconfigured.status, 500)
    assert.deepEqual(await unconfigured.json(), { error: 'Missing WHATSAPP_APP_SECRET configuration' })

    const configured = { ...bindings, WHATSAPP_APP_SECRET: 'whatsapp-secret' }
    for (const signature of [undefined, sign('another-secret'), 'sha256=not-hex']) {
      const refused = await deliver(configured, signature)
      assert.equal(refused.status, 403)
      assert.deepEqual(await refused.json(), { error: 'Invalid signature' })
    }
    const accepted = await deliver(configured, sign('whatsapp-secret'))
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { success: true })
  } finally {
    await runtime.dispose()
  }
})

// A manager replying from WhatsApp is offered exactly the conversations the inbox
// shows a composer for, and a conversation that changed after it was offered is
// refused with the reason the reply operation gives. Only Meta's HTTP boundary is intercepted.
test('a WhatsApp reply offers the conversations the inbox can write to and refuses one that changed', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'whatsapp-reply-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'whatsapp-reply-proof', exportName: 'Hub' } },
  } }] })
  const originalFetch = globalThis.fetch
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'provider', WHATSAPP_PHONE_NUMBER_ID: 'local-proof-phone-id', WHATSAPP_ACCESS_TOKEN: 'local-proof-no-live-token',
      WHATSAPP_APP_SECRET: 'whatsapp-secret' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES ('paid', 'Cabins', 'cabins', 'cabins', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).run()
    await db.prepare("INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES ('paid-en','paid','en',1,'published')").run()
    await db.prepare("INSERT INTO user (id,name,email,emailVerified,phoneNumber,phoneNumberVerified) VALUES ('owner','Owner','owner@proof.example',1,'+66812345678',1)").run()
    await db.prepare("INSERT INTO member (id,organizationId,userId,role) VALUES ('member-paid','paid','owner','owner')").run()
    await db.prepare("INSERT INTO subscription (id,plan,referenceId,status,periodEnd) VALUES ('paid-sub','growth','paid','active',?)").bind(Math.floor(Date.now() / 1000) + 86400).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', 'paid', 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).run()
    const manager = { organizationId: 'paid', actorId: 'owner', manage: true }
    const cabin = await createProduct(db, { env, organizationId: 'paid', actor: { actorId: 'owner' }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    // Ana and Bo can be emailed; Dee left only a phone and has no KrabiClaw account, so the inbox shows her no composer.
    const ana = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'ana', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Ana', guest_email: 'ana@example.test', guest_phone: '+61491570150', total_minor: 30_000 })
    const bo = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'bo', check_in_date: day(6), check_out_date: day(8), adults: 1, guest_name: 'Bo', guest_email: 'bo@example.test', guest_phone: '+61491570152', total_minor: 30_000 })
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(10), check_out_date: day(12), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 30_000 })
    // Each guest wrote, and the owner was alerted on WhatsApp about each.
    for (const [stay, name] of [[ana, 'ana'], [bo, 'bo'], [dee, 'dee']] as const) {
      const entry = await appendEntry(db, { threadId: stay.request_id!, kind: 'message', actorKind: 'guest', channel: 'email', body: `Hi from ${name}`, dedupeKey: `guest-${name}` })
      const alert = await createDeliveryReceipt(db, { entryId: entry.id, channel: 'whatsapp', provider: 'meta', purpose: 'owner_alert', idempotencyKey: `alert-${name}` })
      await recordDeliveryOutcome(db, { deliveryId: alert.id, status: 'sent', providerMessageId: `meta-alert-${name}` })
    }
    const sent: string[] = []
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith('https://graph.facebook.com/')) return originalFetch(input, init)
      sent.push(JSON.parse(String(init?.body)).text.body)
      return Response.json({ messages: [{ id: `meta-out-${sent.length}` }] })
    }
    const app = new H3()
    app.post('/api/whatsapp/webhook', whatsappWebhook)
    let inbound = 0
    const write = async (text: string, quoting?: string) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `wamid-${++inbound}`, from: '66812345678', type: 'text', text: { body: text }, ...(quoting && { context: { id: quoting } }) }] } }] }] })
      const response = await app.request(Object.assign(new Request('https://proof.example/api/whatsapp/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'whatsapp-secret').update(body).digest('hex')}` }, body,
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(response.status, 200, await response.clone().text())
      return sent.at(-1)!
    }
    const pending = async () => (await getWhatsAppWorkspaceState(db, 'owner'))?.pending_confirmation
    const pick = (list: string, name: string) => list.split('\n').find(line => line.endsWith(`from ${name}`))!.split('.')[0]!

    // Quoting Dee's alert names her conversation: it cannot be replied to, and the manager is told why, not offered another.
    assert.equal(await write('Hello Dee', 'meta-alert-dee'), 'Reply not sent: This guest has no email or KrabiClaw account to reply to.')
    assert.equal(await pending(), null)
    // Dee is never offered either: there is nothing to reply to her through.
    const offered = await write('Can I reply?')
    assert.match(offered, /Reply to which\?/u)
    assert.match(offered, /from Ana/u)
    assert.match(offered, /from Bo/u)
    assert.doesNotMatch(offered, /Dee/u)
    // Picking Ana says where the reply goes, as the reply operation would send it.
    assert.equal(await write(pick(offered, 'Ana')), 'Type your reply now — it will be sent by email to a***@example.test.')
    assert.equal(await write('See you at 4'), 'This reply will be sent by email to a***@example.test. Reply YES to send.')
    // The host takes Ana's email off her stay before YES: the reply operation refuses, and its reason reaches the manager.
    await updateStay(db, env, manager, ana.id, { expected_version: ana.version, guest_email: null })
    assert.equal(await write('YES'), 'Reply not sent: This guest has no email or KrabiClaw account to reply to.')
    assert.equal(await pending(), null)
    // Ana is no longer offered. Bo loses his email after the list and before the pick: refused the same way.
    const again = await write('Another reply')
    assert.doesNotMatch(again, /Ana/u)
    await updateStay(db, env, manager, bo.id, { expected_version: bo.version, guest_email: null })
    assert.equal(await write(pick(again, 'Bo')), 'Reply not sent: This guest has no email or KrabiClaw account to reply to.')
    assert.equal(await pending(), null)
    // A member removed after the pick is told their access ended before their reply is read, and nothing of the
    // conversation (where it would go, or why it could not) reaches them.
    await updateStay(db, env, manager, bo.id, { expected_version: (await getStay(db, manager, bo.id)).version, guest_email: 'bo@example.test' })
    const third = await write('One more')
    assert.equal(await write(pick(third, 'Bo')), 'Type your reply now — it will be sent by email to b***@example.test.')
    await db.prepare("DELETE FROM member WHERE id = 'member-paid'").run()
    const removed = await write('Here is my reply')
    assert.equal(removed, 'Your WhatsApp access has been revoked. Please contact your organization administrator.')
    assert.doesNotMatch(removed, /b\*\*\*@|email|KrabiClaw account/u)
    assert.equal(await pending(), null)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
  }
})
