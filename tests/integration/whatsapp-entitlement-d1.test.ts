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
import { createStay } from '../../server/domain/stays.ts'
import { whatsAppServiceWindowOpen } from '../../server/utils/mcp-context.ts'
import { createTeamThread, listTeamMessages, sendTeamMessage, teamAccessFor } from '../../server/domain/team-messages.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'

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
        await db.batch(requestInsertQueries({ id, kind: 'contact', organization_id: organizationId, location_id: null, user_id: null, review_id: null, payload: { guest: { name: 'Guest', email: 'guest@proof.example', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null }, created_at: now, updated_at: now }).map(write => db.prepare(write.query).bind(...write.params)))
        const before = metaCalls
        await notifyContactSubmitted(providerEnv, db, { organizationId, organizationName: organizationId, vertical: 'restaurant', locationId: null, contactId: id, guestName: 'Guest', email: 'guest@proof.example', subject: null, message: 'Hello' })
        assert.equal(metaCalls - before, organizationId === 'paid' ? 1 : 0)
        const entry = await appendEntry(db, { threadId: id, kind: 'message', actorKind: 'guest', channel: 'email', body: 'Reply', dedupeKey: `reply-${id}` })
        const replyBefore = metaCalls
        await notifyGuestThreadReply(providerEnv, db, { organizationId, threadId: id, sourceEntryId: entry.id, submissionType: 'contact', submissionId: id, participantLabel: 'Guest', guestEmail: 'guest@proof.example', inboundChannel: 'email' })
        assert.equal(metaCalls - replyBefore, organizationId === 'paid' ? 1 : 0)
        const rows = (await db.prepare('SELECT d.channel,d.status FROM guest_thread_deliveries d JOIN activity_entries e ON e.id=d.entry_id WHERE e.request_id=?').bind(id).all<{ channel: string; status: string }>()).results
        assert(rows.some(row => row.channel === 'email' && row.status === 'sent'), 'email fallback persists')
        assert.equal(rows.filter(row => row.channel === 'whatsapp').length, organizationId === 'paid' ? 2 : 0)
        assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE kind='notification' AND organization_id=?").bind(organizationId).first('count'), organizationId === 'paid' ? 4 : 3, 'dashboard alerts persist independently of WhatsApp')
      }
      await db.prepare("UPDATE user_notification_preferences SET whatsapp_enabled=0 WHERE category='messages'").run()
      const entry = await appendEntry(db, { threadId: 'contact-paid', kind: 'message', actorKind: 'guest', channel: 'email', body: 'Opted out', dedupeKey: 'reply-optout' })
      const before = metaCalls
      await notifyGuestThreadReply(providerEnv, db, { organizationId: 'paid', threadId: 'contact-paid', sourceEntryId: entry.id, submissionType: 'contact', submissionId: 'contact-paid', participantLabel: 'Guest', inboundChannel: 'email' })
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

// An owner quoting their WhatsApp alert sends the inbox's own reply straight to
// the guest, as themself; anything unquoted gets one line of help. The guest
// email goes through the log-only receipt path; only Meta's HTTP boundary is intercepted.
test('an owner answers a guest by quoting their WhatsApp alert, with nothing asked first', async () => {
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
    // Messages Meta refuses, by how they begin: each attempt is still recorded in `sent`.
    const refuse = new Set<string>()
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith('https://graph.facebook.com/')) return originalFetch(input, init)
      // An alert goes as an approved template, which has no text body.
      const text = (JSON.parse(String(init?.body)).text?.body ?? '') as string
      sent.push(text)
      if ([...refuse].some(start => text.startsWith(start))) return Response.json({ error: { message: 'Meta refused the message' } }, { status: 400 })
      return Response.json({ messages: [{ id: `meta-out-${sent.length}` }] })
    }
    const app = new H3()
    app.post('/api/whatsapp/webhook', whatsappWebhook)
    let inbound = 0
    /** Delivers one owner message as Meta signs it, and returns what the owner was sent back. */
    const write = async (text: string, quoting?: string, id = `wamid-${++inbound}`, status = 200) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id, from: '66812345678', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(quoting && { context: { id: quoting } }) }] } }] }] })
      const before = sent.length
      const response = await app.request(Object.assign(new Request('https://proof.example/api/whatsapp/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'whatsapp-secret').update(body).digest('hex')}` }, body,
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(response.status, status, await response.clone().text())
      return sent.slice(before)
    }
    const replies = async (stay: { request_id: string | null }) => (await db.prepare("SELECT body FROM activity_entries WHERE request_id = ? AND event_name = 'thread.member_reply'")
      .bind(stay.request_id).all<{ body: string }>()).results.map(row => row.body)

    // A message that quotes no alert is answered with one line, and nothing is sent to anyone.
    assert.deepEqual(await write('Can I reply?'), ['To answer a message, reply to it.'])
    assert.deepEqual([...await replies(ana), ...await replies(bo), ...await replies(dee)], [])
    assert.equal(await whatsAppServiceWindowOpen(db, 'owner'), true, 'the owner\'s own message opens their service window')

    // Quoting Ana's alert sends the words to Ana at once, as the inbox would, and says so.
    assert.deepEqual(await write('See you at 4', 'meta-alert-ana', 'wamid-ana'), ['Reply sent.'])
    assert.deepEqual(await replies(ana), ['See you at 4'])
    const delivery = await db.prepare(`SELECT d.channel, d.purpose, json_extract(d.email_json, '$.message.to') AS recipient FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
      WHERE e.request_id = ? AND e.event_name = 'thread.member_reply'`).bind(ana.request_id).first<{ channel: string; purpose: string; recipient: string }>()
    assert.deepEqual(delivery, { channel: 'email', purpose: 'member_reply', recipient: 'ana@example.test' })
    // Meta redelivering that message answers nothing again and sends nothing again.
    assert.deepEqual(await write('See you at 4', 'meta-alert-ana', 'wamid-ana'), [])
    assert.deepEqual(await replies(ana), ['See you at 4'])
    // Redelivered after another message, the reply's key still names one reply: Ana gets it once.
    await write('Something else')
    assert.deepEqual(await write('See you at 4', 'meta-alert-ana', 'wamid-ana'), ['Reply sent.'])
    assert.deepEqual(await replies(ana), ['See you at 4'])

    // Dee can only be reached by phone: quoting her alert says why the reply cannot go, and writes nothing.
    assert.deepEqual(await write('Hello Dee', 'meta-alert-dee'), ['Reply not sent: This guest has no email or KrabiClaw account to reply to.'])
    assert.deepEqual(await replies(dee), [])

    // The reply went and Meta refused to carry its outcome: the message fails, so Meta delivers it again,
    // and the redelivery tells the member without sending the guest the reply twice.
    refuse.add('Reply sent.')
    assert.deepEqual(await write('The gate code is 4512', 'meta-alert-bo', 'wamid-gate', 500), ['Reply sent.'])
    refuse.delete('Reply sent.')
    assert.deepEqual(await write('The gate code is 4512', 'meta-alert-bo', 'wamid-gate'), ['Reply sent.'])
    assert.deepEqual(await replies(bo), ['The gate code is 4512'])

    // Quoting a teammate's alert posts to the team conversation as this member, once.
    await db.prepare("INSERT INTO user (id, name, email, \"emailVerified\", createdAt, updatedAt) VALUES ('teammate', 'Teammate', 'teammate@example.test', 1, 0, 0)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('member-mate', 'paid', 'teammate', 'member', 0)").run()
    const teamAccess = (userId: string, role: string, memberId: string) => teamAccessFor(memberAccessPrincipal({ userId, role, organizationId: 'paid' } as never, { env }), memberId, 'send')
    const [mate, ownerSeat] = await Promise.all([teamAccess('teammate', 'member', 'member-mate'), teamAccess('owner', 'owner', 'member-paid')])
    const teamThread = await createTeamThread(env, db, mate, { memberIds: ['owner'] })
    const teamAlerted = await sendTeamMessage(env, db, mate, teamThread.id, { body: 'Towels are out', photos: [], idempotencyKey: 'team-alert', senderName: 'Teammate' })
    const teamAlert = await db.prepare(`SELECT d.provider_message_id FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
      WHERE e.dedupe_key = ? AND d.channel = 'whatsapp' AND d.provider = 'meta'`).bind(`team-message:${teamAlerted.message.id}`).first<string>('provider_message_id')
    assert.ok(teamAlert)
    assert.deepEqual(await write('Thanks', teamAlert, 'wamid-team'), ['Reply sent.'])
    assert.deepEqual(await write('Thanks', teamAlert, 'wamid-team'), [])
    assert.deepEqual((await listTeamMessages(db, ownerSeat, teamThread.id, {})).messages.filter(message => message.body === 'Thanks').map(message => message.senderId), ['owner'])

    // A member removed from the business is told so, and nothing reaches the guest.
    await db.prepare("DELETE FROM member WHERE id = 'member-paid'").run()
    assert.deepEqual(await write('Here is my reply', 'meta-alert-bo'), ['Reply not sent: You are no longer a member of this business.'])
    assert.deepEqual(await replies(bo), ['The gate code is 4512'])
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
  }
})
