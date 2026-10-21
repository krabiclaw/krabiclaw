import assert from 'node:assert/strict'
import { creationRequestHash } from '../../server/utils/organization-events.ts'
import { createHmac } from 'node:crypto'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { threadPayloadForGuest, requestInsertQueries, getGuestRequest } from '../../server/domain/requests.ts'
import { upsertLocationReservationConfig } from '../../server/utils/reservations.ts'
import test, { mock } from 'node:test'
import { Miniflare } from 'miniflare'
import { createDeliveryReceipt, getDeliveryById, isVisibleDeliveryFailure, listThreadDeliveries, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { listGuestThreads, updateThreadProjectionIfLatestEntry } from '../../server/domain/guest-threads/repository.ts'
import { requestBookingChange, respondToBookingChange } from '../../server/domain/guest-threads/booking-changes.ts'
import { notifyContactSubmitted, notifyFinancialNotification, notifyStayCancelled } from '../../server/utils/notifications.ts'
import { createProduct, getProduct, updateProduct } from '../../server/utils/product-management.ts'
import { buildPublicResourceCacheKey } from '../../server/utils/public-resource-cache.ts'
import { cancelStay, createStay, getStay } from '../../server/domain/stays.ts'
import { organizationAdapter } from '../../server/utils/member-access.ts'
import { createCanonicalNotification } from '../../server/utils/notification-center.ts'
import { buildNotificationVisibilityFilter, type NotificationVisibilityPrincipal } from '../../server/utils/notification-access.ts'
import { acknowledgeNotification } from '../../server/utils/notification-acknowledgement.ts'
import { setNotificationPreference } from '../../server/domain/notification-preferences.ts'
import { registerDevice } from '../../server/domain/devices.ts'
import { guestPaymentMessage, ownerPaymentMessage } from '../../server/notifications/payment-events.ts'
import { getResendClient, resendData } from '../../server/utils/resend.ts'
import { getReviewBookingContext } from '../../server/utils/review-requests.ts'
import { sendReviewRequestForBooking } from '../../server/utils/review-request-delivery.ts'
import { renderNotificationEmail } from '../../server/emails/render.ts'
import { reviewRequestMessage } from '../../server/notifications/guest-events.ts'
import { formatTimestamp } from '../../utils/timezone.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

test('a guest-thread email is sent once per event: replays send nothing, a failed send goes again, and a late reply never moves the thread', async () => {
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
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-proof', 'Proof', 'proof', 'proof', 'USD', 'UTC')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('proof-en', 'org-proof', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('user-proof', 'Proof Owner', 'owner@proof.example')",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-proof','org-proof','user-proof','owner')",
    ]) await db.prepare(statement).run()
    const now = new Date().toISOString()
    const opening = requestInsertQueries({ id: 'contact-proof', kind: 'contact', organization_id: 'org-proof', location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: { guest: { name: 'Proof Guest', email: 'guest@proof.example', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null }, created_at: now, updated_at: now })
    await db.batch(opening.map(write => db.prepare(write.query).bind(...write.params)))
    await Promise.all([0, 1].map(() => notifyContactSubmitted(env, db, { organizationId: 'org-proof', organizationName: 'Proof', locationId: null,
      contactId: 'contact-proof', guestName: 'Proof Guest', email: 'guest@proof.example', subject: null, message: 'Hello' })))
    assert.equal((await listGuestThreads(db, 'org-proof', { userId: 'user-proof', unreadOnly: true }))[0]?.id, 'contact-proof')
    assert.deepEqual((await db.prepare("SELECT d.purpose,d.status FROM guest_thread_deliveries d JOIN activity_entries e ON e.id=d.entry_id WHERE e.request_id='contact-proof' ORDER BY d.purpose").all()).results,
      [{ purpose: 'guest_acknowledgement', status: 'sent' }, { purpose: 'owner_alert', status: 'sent' }])

    // Push is a channel of the same owner alert: one delivery per signed-in
    // device, routed to that token's APNs environment, every outcome recorded.
    await db.prepare("INSERT INTO session (id, expiresAt, token, userId) VALUES ('session-proof', unixepoch() + 3600, 'session-token-proof', 'user-proof')").run()
    const deviceToken = 'ab'.repeat(32)
    await registerDevice(db, { token: deviceToken, environment: 'sandbox', userId: 'user-proof', sessionId: 'session-proof' })
    const notifyPushContact = async (contactEnv: typeof env, id: string) => {
      const writes = requestInsertQueries({ id, kind: 'contact', organization_id: 'org-proof', location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: { guest: { name: 'Proof Guest', email: 'guest@proof.example', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null }, created_at: now, updated_at: now })
      await db.batch(writes.map(write => db.prepare(write.query).bind(...write.params)))
      await notifyContactSubmitted(contactEnv, db, { organizationId: 'org-proof', organizationName: 'Proof', locationId: null, contactId: id, guestName: 'Proof Guest', email: 'guest@proof.example', subject: null, message: 'Hello' })
    }
    const pushDelivery = (id: string) => db.prepare("SELECT d.provider, d.status, d.error, d.provider_message_id FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id WHERE e.request_id = ? AND d.channel = 'push'").bind(id).all().then(result => result.results)
    // An owner alert that fails is recorded on its delivery and does not fail the guest's submission.
    await notifyPushContact(env, 'push-unconfigured')
    assert.deepEqual(await pushDelivery('push-unconfigured'), [{ provider: 'apns', status: 'failed', error: 'APNS_CONFIG_REQUIRED: APNS_KEY_ID is not configured for APNs delivery', provider_message_id: null }])
    const signingKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', signingKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`
    const apnsEnv = { ...env, APNS_KEY_ID: 'PROOFKEY01', APNS_TEAM_ID: 'PROOFTEAM1', APNS_BUNDLE_ID: 'com.krabiclaw.app', APNS_PRIVATE_KEY: pem }
    const apnsRequests: Array<{ url: string; apnsId: string | null; topic: string | null }> = []
    const apnsAnswers = [new Response(null, { status: 200 }), new Response('{"reason":"Unregistered","timestamp":1760000000000}', { status: 410 })]
    const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      apnsRequests.push({ url, apnsId: headers.get('apns-id'), topic: headers.get('apns-topic') })
      const answer = apnsAnswers.shift()
      assert(answer, `unexpected request to ${url}`)
      return answer
    })
    try {
      await notifyPushContact(apnsEnv, 'push-delivered')
      const [delivered] = await pushDelivery('push-delivered')
      assert.deepEqual(apnsRequests[0], { url: `https://api.sandbox.push.apple.com/3/device/${deviceToken}`, apnsId: delivered?.provider_message_id, topic: 'com.krabiclaw.app' })
      assert.deepEqual({ ...delivered, provider_message_id: typeof delivered?.provider_message_id }, { provider: 'apns', status: 'sent', error: null, provider_message_id: 'string' })
      // Apple's 410 retires the token, and the delivery to that device still records the failure.
      await notifyPushContact(apnsEnv, 'push-retired')
      assert.deepEqual(await pushDelivery('push-retired'), [{ provider: 'apns', status: 'failed', error: 'APNs sandbox 410 Unregistered; device token removed', provider_message_id: null }])
      assert.equal(await db.prepare('SELECT count(*) AS count FROM device_tokens').first('count'), 0)
      assert.equal(apnsRequests.length, 2)
    } finally {
      fetchMock.mock.restore()
    }

    await db.prepare("INSERT INTO business_locations (id,organization_id,slug,title,timezone,max_capacity,opening_hours) VALUES ('booking-location','org-proof','booking','Booking','Asia/Bangkok',10,?)")
      .bind(JSON.stringify({ periods: [{ open: { day: 1, hour: 16, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }] })).run()
    const booking = requestInsertQueries({ id: 'change-proof', kind: 'reservation', organization_id: 'org-proof', location_id: 'booking-location',
      user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
      payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example', phone: '+66812345678' }), created_at: now, updated_at: now })
    await db.batch(booking.map(write => db.prepare(write.query).bind(...write.params)))
    // The seats live on the reservation, not the thread: a change proposal is
    // read from and applied to this row.
    await upsertLocationReservationConfig(db, { organizationId: 'org-proof', locationId: 'booking-location', patch: { slot_capacity: 10, duration_minutes: 120 }, actorId: 'user-proof' })
    await db.prepare(`INSERT INTO reservations (id,organization_id,location_id,request_id,timezone,starts_at,ends_at,party_size,status,policy_json)
      VALUES ('reservation-change-proof','org-proof','booking-location','change-proof','Asia/Bangkok','2099-01-05T09:00:00.000Z','2099-01-05T11:00:00.000Z',1,'confirmed',?)`).bind(JSON.stringify({reschedule_allowed:true,reschedule_cutoff_minutes:0,free_cancellation_until_minutes:0})).run()
    const propose = async (key: string, partySize: number) => {
      const current = await getGuestRequest(db, 'change-proof')
      assert(current)
      await requestBookingChange(db, env, current, 'user-proof', { kind: 'reservation', bookingDate: '2099-01-05', bookingTime: '16:00', partySize, locationId: 'booking-location', expectedUpdatedAt: current.updated_at }, key)
      const requestId = await db.prepare('SELECT id FROM activity_entries WHERE dedupe_key=?').bind(`booking-change-request:change-proof:${key}`).first<string>('id')
      assert(requestId)
      return { threadId: 'change-proof', requestId, token: createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`booking-change:v1:change-proof:${requestId}`).digest('hex'), decision: 'accept' as const }
    }
    const proposal = await propose('first-change', 2)
    assert.equal((await respondToBookingChange(db, env, proposal)).status, 'accepted')
    assert.equal((await respondToBookingChange(db, env, proposal)).status, 'accepted')
    assert.equal(await db.prepare("SELECT party_size FROM reservations WHERE request_id='change-proof'").first('party_size'), 2)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE request_id='change-proof' AND event_name='booking_change.accepted'").first('count'), 1)
    const stale = await propose('stale-change', 3)
    // Anything that moves the record makes the open proposal stale. What moved
    // it is not the subject; that it moved is.
    await db.prepare("UPDATE reservations SET party_size = 5, updated_at = ? WHERE request_id = 'change-proof'").bind(new Date(Date.now() + 1000).toISOString()).run()
    await assert.rejects(respondToBookingChange(db, env, stale), /changed since the request/)
    const concurrent = await propose('concurrent-change', 4)
    const [decision, cancellation] = await Promise.allSettled([respondToBookingChange(db, env, concurrent), executeGuestThreadOperation(db, {
      threadId: 'change-proof', action: 'cancel', actorUserId: 'user-proof', idempotencyKey: 'owner-cancel', env })])
    // Name the reason when the owner's cancel loses: a bare falsy assertion hid
    // which side of the race failed in CI.
    assert.equal(cancellation.status, 'fulfilled', `cancel rejected: ${cancellation.status === 'rejected' ? String(cancellation.reason) : ''}`)
    assert(cancellation.value.ok, `cancel refused: ${JSON.stringify(cancellation.value)}`)
    if (decision.status === 'fulfilled') assert.equal(decision.value.status, 'accepted')
    else assert.match(String(decision.reason), /changed|no longer/)
    assert.equal(await db.prepare("SELECT status FROM reservations WHERE request_id='change-proof'").first('status'), 'cancelled')
    assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE request_id='change-proof' AND event_name='reservation.cancel'").first('count'), 1)
    assert.equal(await db.prepare(`SELECT count(*) AS count FROM activity_entries accepted JOIN activity_entries cancelled ON cancelled.request_id=accepted.request_id
      WHERE accepted.request_id='change-proof' AND accepted.event_name='booking_change.accepted' AND cancelled.event_name='reservation.cancel' AND accepted.sequence>cancelled.sequence`).first('count'), 0)
    await db.prepare("INSERT INTO activity_entries (id,request_id,kind,scope_kind,actor_kind,channel,dedupe_key,sequence,occurred_at) VALUES ('entry-proof','contact-proof','message','request','guest','email','proof',2,'2026-09-05T00:00:00.000Z')").run()


    const reply = (body: string, idempotencyKey: string) => executeGuestThreadOperation(db, {
      threadId: 'contact-proof', action: 'reply', actorUserId: 'user-proof', body, idempotencyKey, env })
    const deliveryRow = (id: string) => db.prepare('SELECT status, provider_message_id FROM guest_thread_deliveries WHERE id = ?').bind(id).first<{ status: string; provider_message_id: string | null }>()

    // A reply is sent, and its receipt carries the provider's message id.
    const operationKey = 'reply-proof'
    const operationDedupeKey = `guest-thread-operation:contact-proof:${operationKey}`
    const deliveryId = `guest-thread-email:contact-proof:${operationKey}`
    assert.deepEqual(await reply('A reply', operationKey).then(outcome => ({ ok: outcome.ok, status: outcome.status })), { ok: true, status: 200 })
    const sent = await deliveryRow(deliveryId)
    assert.equal(sent?.status, 'sent')
    assert.match(sent?.provider_message_id ?? '', /^log-only:email:/)
    assert.equal((await db.prepare('SELECT conversation_state FROM requests WHERE id = ?').bind('contact-proof').first<{ conversation_state: string }>())?.conversation_state, 'waiting_on_guest')

    // Replaying the same reply sends nothing: the receipt keeps its message id.
    assert.equal((await reply('A reply', operationKey)).ok, true)
    assert.equal((await deliveryRow(deliveryId))?.provider_message_id, sent?.provider_message_id)

    // A thread reaches 'resolved' through its record's own lifecycle, which
    // writes the state alongside the entry that caused it. Both halves matter
    // here: the projection only follows the LATEST entry, so what keeps the
    // replay below from dragging the state back is that a newer entry exists.
    const resolvingEntry = await appendEntry(db, {
      threadId: 'contact-proof',
      kind: 'operation',
      actorKind: 'system',
      eventName: 'thread.completed',
      dedupeKey: 'lifecycle-resolve-proof',
    })
    await updateThreadProjectionIfLatestEntry(db, 'contact-proof', resolvingEntry.id, { conversationState: 'resolved' })
    assert.equal((await reply('A reply', operationKey)).ok, true)
    assert.equal((await db.prepare('SELECT conversation_state FROM requests WHERE id = ?').bind('contact-proof').first<{ conversation_state: string }>())?.conversation_state, 'resolved')

    // A reply whose send completes after a newer guest message leaves the
    // thread on that message.
    const delayedOperationKey = 'delayed-reply-proof'
    const delayedReplyEntry = await appendEntry(db, {
      threadId: 'contact-proof',
      kind: 'message',
      actorKind: 'member',
      actorUserId: 'user-proof',
      channel: 'email',
      body: 'A delayed reply',
      payloadJson: { request_hash: await creationRequestHash({body:'A delayed reply',photos:[]}) },
      eventName: 'thread.member_reply',
      dedupeKey: `guest-thread-operation:contact-proof:${delayedOperationKey}`,
    })
    await createDeliveryReceipt(db, {
      entryId: delayedReplyEntry.id,
      channel: 'email',
      provider: 'log_only',
      purpose: 'member_reply',
      idempotencyKey: `guest-thread-email:contact-proof:${delayedOperationKey}`,
    })
    const inboundEntry = await appendEntry(db, {
      threadId: 'contact-proof',
      kind: 'message',
      actorKind: 'guest',
      channel: 'email',
      body: 'A newer guest reply',
      dedupeKey: 'email:newer-guest-reply-proof',
    })
    await updateThreadProjectionIfLatestEntry(db, 'contact-proof', inboundEntry.id, { conversationState: 'needs_attention' })
    assert.deepEqual(await reply('A delayed reply', delayedOperationKey).then(outcome => ({ ok: outcome.ok, status: outcome.status })), { ok: true, status: 200 })
    assert.equal((await deliveryRow(`guest-thread-email:contact-proof:${delayedOperationKey}`))?.status, 'sent')
    assert.equal((await db.prepare('SELECT conversation_state FROM requests WHERE id = ?').bind('contact-proof').first<{ conversation_state: string }>())?.conversation_state, 'needs_attention')

    // A failed send shows on the thread, and replaying the reply sends it again.
    const failedOperationKey = 'failed-reply-proof'
    const failedEntry = await appendEntry(db, {
      threadId: 'contact-proof',
      kind: 'message',
      actorKind: 'member',
      actorUserId: 'user-proof',
      channel: 'email',
      body: 'A failed reply',
      payloadJson: { request_hash: await creationRequestHash({body:'A failed reply',photos:[]}) },
      eventName: 'thread.member_reply',
      dedupeKey: `guest-thread-operation:contact-proof:${failedOperationKey}`,
    })
    const failedReceipt = await createDeliveryReceipt(db, {
      entryId: failedEntry.id,
      channel: 'email',
      provider: 'log_only',
      purpose: 'member_reply',
      idempotencyKey: `guest-thread-email:contact-proof:${failedOperationKey}`,
    })
    await recordDeliveryOutcome(db, { deliveryId: failedReceipt.id, status: 'failed', error: 'provider rejected request' })
    assert.equal((await listThreadDeliveries(db, 'contact-proof')).filter(isVisibleDeliveryFailure).some(delivery => delivery.id === failedReceipt.id), true)
    assert.equal((await reply('A failed reply', failedOperationKey)).ok, true)
    const resent = await getDeliveryById(db, failedReceipt.id)
    assert.deepEqual({ status: resent?.status, error: resent?.error }, { status: 'sent', error: null })
    assert.equal(isVisibleDeliveryFailure(resent!), false)

    assert.equal((await db.prepare('SELECT count(*) count FROM activity_entries WHERE dedupe_key = ?').bind(operationDedupeKey).first<{ count: number }>())?.count, 1)
    assert.equal((await db.prepare('SELECT count(*) count FROM guest_thread_deliveries WHERE id = ?').bind(deliveryId).first<{ count: number }>())?.count, 1)
  } finally {
    await runtime.dispose()
  }
})

test('a replayed status email sends its recorded content and refuses a superseded booking', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T10:00:00Z') })
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'status-retry-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const requests: { subject: string; text: string; html: string }[] = []
  let reject = true
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    requests.push(JSON.parse(String(init.body)))
    return reject ? new Response('Provider rejected', { status: 503 }) : Response.json({ id: 'status-proof' })
  })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-status', 'Proof', 'proof', 'proof', 'USD', 'UTC')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('status-en', 'org-status', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('user-status', 'Proof Owner', 'owner@proof.example')",
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('location-status', 'org-status', 'proof', 'Proof', 'UTC')",
    ]) await db.prepare(statement).run()
    const now = new Date().toISOString()
    const opening = requestInsertQueries({ id: 'booking-status', kind: 'reservation', organization_id: 'org-status', location_id: 'location-status', user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@provider-proof.com', phone: '123' }), created_at: now, updated_at: now })
    await db.batch(opening.map(write => db.prepare(write.query).bind(...write.params)))
    // The instant and the zone the guest agreed to live on the reservation; the
    // confirmation email is formatted from them, never from a server clock.
    await db.prepare(`INSERT INTO reservations (id,organization_id,location_id,request_id,timezone,starts_at,ends_at,party_size,status)
      VALUES ('reservation-status','org-status','location-status','booking-status','Asia/Bangkok','2098-10-01T11:00:00.000Z','2098-10-01T13:00:00.000Z',2,'confirmed')`).run()

    const input = {
      threadId: 'booking-status', actorUserId: 'user-status',
      env: { EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 'controlled-provider-only', EMAIL_FROM: 'KrabiClaw <hello@krabiclaw.com>', NUXT_PUBLIC_PLATFORM_DOMAIN: 'proof.example' },
    }
    const cancel = { ...input, action: 'cancel', idempotencyKey: 'cancel-status' }
    assert.deepEqual(await executeGuestThreadOperation(db, cancel), {
      ok: false, status: 502, reason: 'delivery_failed', code: 'DELIVERY_FAILED', field: 'delivery',
      message: 'Booking is cancelled, but the guest email failed. Retry with the same idempotency key.',
      mutation_applied: true, operation_completed: false, request_id: 'booking-status', retry_with_same_idempotency_key: true,
      record: {
        kind: 'reservation', id: 'reservation-status', status: 'cancelled', party_size: 2,
        starts_at: '2098-10-01T11:00:00.000Z', ends_at: '2098-10-01T13:00:00.000Z', timezone: 'Asia/Bangkok',
        location_id: 'location-status', product_id: null, product_name: null, assigned_member_id: null, check_in_date: null, check_out_date: null,
        organization_id: 'org-status', user_id: null,
      },
    })
    assert.equal(await db.prepare("SELECT status FROM reservations WHERE id='reservation-status'").first('status'), 'cancelled')
    assert.equal(requests.length, 1)
    const deliveryId = 'guest-thread-email:booking-status:cancel-status'
    assert.equal((await getDeliveryById(db, deliveryId))!.status, 'failed')
    const original = requests[0]!
    const guestBody = 'Proof · Oct 1, 2098, 6:00 PM GMT+7 · 2 guests'
    assert.equal(original.subject, 'Reservation Cancelled — Proof')
    assert.ok(original.text.includes(guestBody), original.text)
    assert.ok(original.html.includes(guestBody), original.html)
    // A later display edit cannot change the copy already recorded for this
    // cancellation. Retrying sends the exact first email again.
    await db.prepare("UPDATE organization SET name='Changed after cancellation' WHERE id='org-status'").run()
    assert.equal((await executeGuestThreadOperation(db, cancel)).status, 502)
    assert.deepEqual(requests[1], original)

    // Moving the reservation is what makes the pending send stale — the thread
    // carries no copy of the time to move.
    await db.prepare("UPDATE reservations SET starts_at = '2098-10-02T11:00:00.000Z', ends_at = '2098-10-02T13:00:00.000Z' WHERE request_id = 'booking-status'").run()
    const attemptsBefore = requests.length
    assert.equal((await executeGuestThreadOperation(db, cancel)).status, 409)
    assert.equal(requests.length, attemptsBefore)
    // Cancelling is the one transition, so a second one has nothing to move:
    // the record is already cancelled and the stale send stays refused.
    reject = false
    const afterCancellation = requests.length
    for (const request of [{ ...input, action: 'cancel', idempotencyKey: 'cancel-again' }, cancel]) {
      assert.equal((await executeGuestThreadOperation(db, request)).status, 409)
    }
    assert.equal(requests.length, afterCancellation)
    assert.equal((await getDeliveryById(db, deliveryId))!.status, 'failed')
    const entry = await db.prepare('SELECT body, payload_json FROM activity_entries WHERE id = ?')
      .bind((await getDeliveryById(db, deliveryId))!.entry_id).first<{ body: string; payload_json: string }>()
    assert.equal(entry!.body, guestBody)
    assert.equal(JSON.parse(entry!.payload_json).subject, original.subject)
  } finally {
    await runtime.dispose()
  }
})

test('a failed stay cancellation email retries its recorded content after display edits and sends once', async (t) => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-cancellation-delivery-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-cancellation-delivery-proof', exportName: 'Hub' } },
  } }] })
  const requests: Array<{ body: { subject: string; text: string; html: string }; idempotencyKey: string | null }> = []
  let reject = true
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    requests.push({ body: JSON.parse(String(init.body)), idempotencyKey: new Headers(init.headers).get('idempotency-key') })
    return reject
      ? Response.json({ name: 'application_error', message: 'Cancellation delivery rejected' }, { status: 503 })
      : Response.json({ id: 'stay-cancellation-delivered' })
  })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'provider', WHATSAPP_DELIVERY_MODE: 'log_only',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', RESEND_API_KEY: 'controlled-provider-only', EMAIL_FROM: 'KrabiClaw <hello@krabiclaw.com>' }
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone, vertical, theme_id) VALUES ('org-stay-cancel', 'Original Retreat', 'stay-cancel', 'stay-cancel', 'USD', 'Asia/Bangkok', 'lodging', 'tenant-theme-v1')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('stay-cancel-en', 'org-stay-cancel', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('owner-stay-cancel', 'Owner', 'owner@proof.example')",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-stay-cancel', 'org-stay-cancel', 'owner-stay-cancel', 'owner')",
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone, status) VALUES ('location-stay-cancel', 'org-stay-cancel', 'retreat', 'Retreat', 'Asia/Bangkok', 'active')",
    ]) await db.prepare(statement).run()
    const access = { organizationId: 'org-stay-cancel', actorId: 'owner-stay-cancel', manage: true }
    const home = await createProduct(db, { env, organizationId: access.organizationId, actor: { actorId: access.actorId }, product: {
      kind: 'stay', name: 'Original Cabin', variants: [{ name: 'Original Cabin', prices: [{ unit_amount: 15000, currency: 'USD' }] }],
      stay: { location_id: 'location-stay-cancel', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: null, assigned_team_id: null },
    } })
    const stay = await createStay(db, env, access, { product_id: home.id, idempotency_key: 'stay-cancellation-email', check_in_date: '2098-10-01', check_out_date: '2098-10-03',
      adults: 2, guest_name: 'Ana', guest_email: 'guest@provider-proof.com', total_minor: 30000 })
    await cancelStay(db, env, access, stay.id, { expected_version: stay.version })
    assert.equal((await getStay(db, access, stay.id)).status, 'cancelled')
    await assert.rejects(notifyStayCancelled(env, db, access.organizationId, stay.id, 'host', 0), (error: AggregateError) => {
      assert(error instanceof AggregateError)
      assert.match(error.message, /sendEmailNotification/u)
      assert.equal(error.errors.length, 1)
      assert.match(error.errors[0].message, /RESEND_REJECTED: .*Cancellation delivery rejected/u)
      return true
    })
    assert.equal(requests.length, 1)
    const original = requests[0]!
    assert.match(original.body.subject, /Original Cabin/u)
    for (const body of [original.body.text, original.body.html]) {
      assert.match(body, /Original Retreat/u)
      assert.match(body, /Original Cabin/u)
      assert.match(body, /2098/u)
    }
    const entry = await db.prepare('SELECT * FROM activity_entries WHERE dedupe_key = ?').bind(`stay-cancellation:${stay.id}`).first<{ id: string; body: string; payload_json: string; event_name: string }>()
    assert(entry)
    assert.equal(entry.event_name, 'stay.host_cancelled')
    assert.equal(entry.body, original.body.text)
    const recorded = JSON.parse(entry.payload_json)
    assert.equal(recorded.subject, original.body.subject)
    assert.deepEqual({ to: recorded.email.to, fromName: recorded.email.fromName, html: recorded.email.html, text: recorded.email.text }, {
      to: 'guest@provider-proof.com', fromName: 'Original Retreat', html: original.body.html, text: original.body.text,
    })
    const receipts = await db.prepare('SELECT id FROM guest_thread_deliveries WHERE entry_id = ?').bind(entry.id).all<{ id: string }>()
    assert.equal(receipts.results.length, 1)
    const deliveryId = receipts.results[0]!.id
    assert.equal(original.idempotencyKey, deliveryId)
    assert.equal((await getDeliveryById(db, deliveryId))!.status, 'failed')
    assert.match((await getDeliveryById(db, deliveryId))!.error!, /Cancellation delivery rejected/u)

    assert(env.ORGANIZATION_CACHE)
    const cachedPageKey = buildPublicResourceCacheKey(access.organizationId, { contract: 'page', page: 'stays', location: null, datasets: ['products'], blogSlug: null, locale: 'en' })
    await env.ORGANIZATION_CACHE.put(cachedPageKey, JSON.stringify({ product: home }))
    await updateProduct(db, { env, organizationId: access.organizationId, productId: home.id, actor: { actorId: access.actorId }, patch: { name: 'Renamed Cabin' } })
    assert.equal(await env.ORGANIZATION_CACHE.get(cachedPageKey), null)
    await (await organizationAdapter(env)).updateOrganization(access.organizationId, { name: 'Renamed Retreat' })
    assert.equal((await getProduct(db, access.organizationId, home.id)).name, 'Renamed Cabin')
    assert.equal(await db.prepare('SELECT name FROM organization WHERE id = ?').bind(access.organizationId).first('name'), 'Renamed Retreat')
    reject = false
    await notifyStayCancelled(env, db, access.organizationId, stay.id, 'host', 0)
    assert.deepEqual(requests, [original, original])
    const settled = await getDeliveryById(db, deliveryId)
    assert.deepEqual({ status: settled!.status, error: settled!.error, providerMessageId: settled!.provider_message_id }, { status: 'sent', error: null, providerMessageId: 'stay-cancellation-delivered' })
    await notifyStayCancelled(env, db, access.organizationId, stay.id, 'host', 0)
    assert.equal(requests.length, 2)
    assert.deepEqual(await db.prepare('SELECT * FROM activity_entries WHERE dedupe_key = ?').bind(`stay-cancellation:${stay.id}`).first(), entry)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE request_id = ? AND event_name = 'stay.host_cancelled'").bind(stay.request_id).first('count'), 1)
    assert.equal(await db.prepare('SELECT count(*) AS count FROM guest_thread_deliveries WHERE entry_id = ?').bind(entry.id).first('count'), 1)
    assert.equal((await getStay(db, access, stay.id)).version, stay.version + 1)
  } finally {
    await runtime.dispose()
  }
})

test('a booking move into a full session leaves the original booking exactly as it was', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'booking-move-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'booking-move-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    const now = new Date().toISOString()
    // Both sessions sit inside the window a change request looks at.
    const at = (days: number, hours = 0) => new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString()
    const soon = at(30)
    const soonEnd = at(30, 1)
    const later = at(60)
    const laterEnd = at(60, 1)
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-move', 'Move', 'move', 'move', 'USD', 'UTC')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('move-en', 'org-move', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('user-move', 'Owner', 'owner@move.example')",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-move','org-move','user-move','owner')",
      "INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('loc-move','org-move','move','Move','Asia/Bangkok')",
      "INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('experience', 'prod-move','org-move','Class','class','user-move','user-move')",
      "INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('var-move','org-move','prod-move','Adult','user-move','user-move')",
      "INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, created_by, updated_by) VALUES ('prod-move','org-move',60,4,'user-move','user-move')",
      // The branch offers it: a session at a location only takes seats while
      // that location is still selling the product.
      "INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES ('org-move','prod-move','loc-move',1,1,'user-move','user-move')",
      // The destination holds two seats and already has both taken.
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES ('session-from','org-move','prod-move','loc-move','Asia/Bangkok','${soon}','${soonEnd}',4,'scheduled','user-move','user-move')`,
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES ('session-to','org-move','prod-move','loc-move','Asia/Bangkok','${later}','${laterEnd}',2,'scheduled','user-move','user-move')`,
      "INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,party_size,status) VALUES ('booking-other','org-move','prod-move','session-to','var-move',2,'confirmed')",
    ]) await db.prepare(statement).run()
    const thread = requestInsertQueries({ id: 'move-proof', kind: 'booking', organization_id: 'org-move', location_id: 'loc-move',
      user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
      payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@move.example', phone: '+66812345678' }), created_at: now, updated_at: now })
    await db.batch(thread.map(write => db.prepare(write.query).bind(...write.params)))
    await db.prepare(`INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,request_id,party_size,status)
      VALUES ('booking-move','org-move','prod-move','session-from','var-move','move-proof',1,'confirmed')`).run()

    const current = await getGuestRequest(db, 'move-proof')
    assert(current)
    await requestBookingChange(db, env, current, 'user-move', { kind: 'booking', sessionId: 'session-to', partySize: 1, expectedUpdatedAt: current.updated_at }, 'full-session')
    const requestId = await db.prepare('SELECT id FROM activity_entries WHERE dedupe_key=?').bind('booking-change-request:move-proof:full-session').first<string>('id')
    assert(requestId)
    const token = createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`booking-change:v1:move-proof:${requestId}`).digest('hex')

    await assert.rejects(
      respondToBookingChange(db, env, { threadId: 'move-proof', requestId, token, decision: 'accept' }),
      /filled up/,
      'a full destination refuses the move',
    )
    // Nothing about the original may have moved: not its session, not its
    // status, not the thread it answers.
    const original = await db.prepare("SELECT product_session_id, status, request_id FROM bookings WHERE id='booking-move'").first<{ product_session_id: string; status: string; request_id: string | null }>()
    assert.deepEqual(original, { product_session_id: 'session-from', status: 'confirmed', request_id: 'move-proof' })
    assert.equal(await db.prepare("SELECT count(*) AS count FROM bookings WHERE product_session_id='session-to'").first('count'), 1,
      'no replacement seat was taken in the full session')
    assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE request_id='move-proof' AND event_name='booking_change.accepted'").first('count'), 0,
      'the decision was not recorded for a move that did not happen')
    await db.prepare("UPDATE bookings SET status='cancelled' WHERE id='booking-other'").run()
    await respondToBookingChange(db, env, { threadId: 'move-proof', requestId, token, decision: 'accept' })
    await respondToBookingChange(db, env, { threadId: 'move-proof', requestId, token, decision: 'accept' })
    const moved = await db.prepare("SELECT id, product_session_id, status, request_id FROM bookings WHERE id='booking-move'").first()
    assert.deepEqual(moved, { id: 'booking-move', product_session_id: 'session-to', status: 'confirmed', request_id: 'move-proof' })
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM bookings WHERE request_id='move-proof'").first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE request_id='move-proof' AND event_name='booking_change.accepted'").first('n'), 1)

  } finally { await runtime.dispose() }
})

test('a review request reads the visit from the record that holds it', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'review-request-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'review-request-proof', exportName: 'Hub' } },
  } }] })

  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    const now = new Date().toISOString()
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-review', 'Kikuzuki', 'review', 'review', 'USD', 'UTC')",
      "INSERT INTO organization_domains (id, organization_id, domain, role, status, type) VALUES ('domain-review','org-review','review.example','canonical','active','custom')",
      "INSERT INTO business_locations (id,organization_id,slug,title,timezone,max_capacity) VALUES ('loc-review','org-review','main','Main Room','Asia/Bangkok',40)",
      // The guest is an anonymous Better Auth user; what they typed is on the thread.
      "INSERT INTO user (id, name, email, isAnonymous) VALUES ('guest-review','Anonymous','anon-guest-review@customers.krabiclaw.local',1)",
      // Better Auth's subscription table is the only store of plan entitlement.
      "INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub-review','growth','org-review','active',4102444800)",
    ]) await db.prepare(statement).run()
    const thread = requestInsertQueries({ id: 'reservation-review', kind: 'reservation', organization_id: 'org-review', location_id: 'loc-review',
      user_id: 'guest-review', review_id: null, conversation_state: 'resolved', resolved_at: now,
      payload: { ...threadPayloadForGuest({ name: 'Sivan', email: 'sivan@proof.example', phone: null }), completion: { at: now, source: 'auto' } }, created_at: now, updated_at: now })
    await db.batch(thread.map(write => db.prepare(write.query).bind(...write.params)))
    // The visit is the reservation's, in the reservation's zone. 13:00Z in
    // Asia/Bangkok is 8:00 PM, and nothing else in the system knows that.
    // Complete is the clock: confirmed, and an end that has passed.
    await db.prepare(`INSERT INTO reservations (id,organization_id,location_id,user_id,request_id,timezone,starts_at,ends_at,party_size,status)
      VALUES ('res-review','org-review','loc-review','guest-review','reservation-review','Asia/Bangkok','2026-09-11T13:00:00.000Z','2026-09-11T15:00:00.000Z',6,'confirmed')`).run()

    const context = await getReviewBookingContext(db, 'reservation', 'reservation-review')
    assert(context, 'the thread and its reservation resolve to one context')
    assert.deepEqual(
      { status: context.status, visit_starts_at: context.visit_starts_at, visit_timezone: context.visit_timezone, party_size: context.party_size },
      { status: 'confirmed', visit_starts_at: '2026-09-11T13:00:00.000Z', visit_timezone: 'Asia/Bangkok', party_size: 6 },
      'status and the visit come from the reservation, not from the thread payload',
    )

    const result = await sendReviewRequestForBooking(env, db, 'reservation', 'reservation-review')
    assert.deepEqual({ sent: result.sent, error: result.error }, { sent: true, error: undefined })
    // The email states the visit. A row that reads "your reservation" is the
    // headline fragment leaking into a value, which is what this guards — the
    // message carries no such phrase at all now, so the check is that the real
    // visit is what the facts show.
    const { html } = await renderNotificationEmail(reviewRequestMessage({
      guestName: 'Sivan', organizationName: 'Kikuzuki', locationName: 'Main Room',
      visitAt: formatTimestamp(context.visit_starts_at, 'en', context.visit_timezone), partySize: '6 guests',
      reviewUrl: 'https://review.example/r',
    }), { platformDomain: 'proof.example' })
    assert.match(html, /Sep 11, 2026, 8:00\s?PM/, 'the visit renders in the reservation timezone')
    assert.match(html, /6 guests/)
    assert.doesNotMatch(html, />\s*your reservation\s*</, 'the headline phrase is never rendered as a detail value')
  } finally { await runtime.dispose() }
})

test('financial notification replay preserves per-recipient receipts and isolates personal, merchant and platform audiences', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'financial-notification-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'financial-notification-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.batch([
      "INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('merchant','Merchant','merchant', 'USD', 'UTC')",
      "INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('other-merchant','Other','other-merchant', 'USD', 'UTC')",
      ...['owner-a', 'owner-b', 'owner-off', 'buyer', 'other-user', 'staff'].map(id => `INSERT INTO user (id,name,email,emailVerified) VALUES ('${id}','${id}','${id}@proof.example',1)`),
      "INSERT INTO member (id,organizationId,userId,role) VALUES ('member-a','merchant','owner-a','owner')",
      "INSERT INTO member (id,organizationId,userId,role) VALUES ('member-b','merchant','owner-b','admin')",
      "INSERT INTO member (id,organizationId,userId,role) VALUES ('member-off','merchant','owner-off','owner')",
      "INSERT INTO member (id,organizationId,userId,role) VALUES ('member-staff','merchant','staff','member')",
      "INSERT INTO member (id,organizationId,userId,role) VALUES ('member-other','other-merchant','other-user','owner')",
    ].map(statement => db.prepare(statement)))
    assert.equal(await db.prepare('SELECT count(*) n FROM user').first('n'), 6)
    assert.deepEqual((await db.prepare("SELECT userId,role FROM member WHERE organizationId='merchant' ORDER BY userId").all()).results,
      [{ userId: 'owner-a', role: 'owner' }, { userId: 'owner-b', role: 'admin' }, { userId: 'owner-off', role: 'owner' }, { userId: 'staff', role: 'member' }])
    await setNotificationPreference(db, env, 'owner-off', 'organization_and_billing', { email: false, whatsapp: false, push: false })
    assert.deepEqual(await db.prepare("SELECT email_enabled,whatsapp_enabled,push_enabled FROM user_notification_preferences WHERE user_id='owner-off' AND category='organization_and_billing'").first(), { email_enabled: 0, whatsapp_enabled: 0, push_enabled: 0 })
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE kind='notification'").first('n'), 0)

    const eventKey = 'financial-proof:capture'
    const payment = { kind: 'payment_captured' as const, organizationName: 'Merchant', amount: 10000, currency: 'USD' as const, productTitle: 'Class' }
    const input = { organizationId: 'merchant', eventKey, ownerMessage: ownerPaymentMessage(payment),
      guest: { userId: 'buyer', email: 'buyer@proof.example', message: guestPaymentMessage(payment) } }
    await notifyFinancialNotification(env, db, input)
    const rows = (await db.prepare('SELECT id,scope_kind,organization_id,target_user_id,parent_id,request_id FROM activity_entries WHERE event_name=? ORDER BY scope_kind').bind(eventKey).all()).results
    assert.equal(rows.length, 2)
    const buyer = rows.find(row => row.scope_kind === 'global')!, merchant = rows.find(row => row.scope_kind === 'organization')!
    assert.deepEqual({ ...buyer, id: undefined }, { id: undefined, scope_kind: 'global', organization_id: null, target_user_id: 'buyer', parent_id: null, request_id: null })
    assert.deepEqual({ ...merchant, id: undefined }, { id: undefined, scope_kind: 'organization', organization_id: 'merchant', target_user_id: null, parent_id: null, request_id: null })
    assert.equal(await db.prepare('SELECT count(*) n FROM requests').first('n'), 0, 'a financial notification does not manufacture a guest conversation')
    const receipts = (await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results
    assert.equal(receipts.length, 3)
    assert.equal(new Set(receipts.map(row => row.id)).size, 3, 'eligible merchant recipients and the buyer have distinct delivery claims')
    assert.deepEqual(receipts.map(row => ({ entry_id: row.entry_id, purpose: row.purpose, channel: row.channel, provider: row.provider, status: row.status })).sort((a, b) => a.purpose.localeCompare(b.purpose)),
      [
        { entry_id: merchant.id, purpose: 'owner_alert', channel: 'email', provider: 'log_only', status: 'sent' },
        { entry_id: merchant.id, purpose: 'owner_alert', channel: 'email', provider: 'log_only', status: 'sent' },
        { entry_id: merchant.id, purpose: 'status_update', channel: 'email', provider: 'log_only', status: 'sent' },
      ])
    for (const receipt of receipts) {
      assert.ok(String(receipt.id).length <= 256, 'the durable financial key fits Resend\'s documented idempotency limit')
      assert.match(String(receipt.provider_message_id), /^log-only:email:/u)
    }
    await Promise.all([notifyFinancialNotification(env, db, input), notifyFinancialNotification(env, db, input)])
    assert.deepEqual((await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results, receipts, 'replays do not claim or send settled receipts again')
    assert.deepEqual((await db.prepare('SELECT id,scope_kind,organization_id,target_user_id,parent_id,request_id FROM activity_entries WHERE event_name=? ORDER BY scope_kind').bind(eventKey).all()).results, rows)

    await createCanonicalNotification(db, { scope: 'global', targetUserId: 'other-user', template: 'personal.other', title: 'Other buyer', idempotencyKey: 'personal-other' })
    await createCanonicalNotification(db, { scope: 'global', targetUserId: 'owner-a', template: 'personal.owner', title: 'Own purchase', idempotencyKey: 'personal-owner' })
    await createCanonicalNotification(db, { scope: 'global', template: 'platform.alert', title: 'Platform alert', idempotencyKey: 'platform-alert' })
    await createCanonicalNotification(db, { publishEnv: env, scope: 'organization', organizationId: 'other-merchant', template: 'merchant.other', title: 'Other merchant', idempotencyKey: 'other-merchant-alert' })
    const cases: Array<{ principal: NotificationVisibilityPrincipal; ids: unknown[] }> = [
      { principal: { userId: 'buyer', platformAdmin: false, organization: null }, ids: [buyer.id] },
      { principal: { userId: 'other-user', platformAdmin: false, organization: null }, ids: ['personal-other'] },
      { principal: { userId: 'owner-a', platformAdmin: false, organization: null }, ids: ['personal-owner'] },
      { principal: { userId: 'owner-a', platformAdmin: false, organization: { id: 'merchant', role: 'owner' } }, ids: [merchant.id] },
      { principal: { userId: 'other-user', platformAdmin: false, organization: { id: 'other-merchant', role: 'owner' } }, ids: ['other-merchant-alert'] },
      { principal: { userId: 'staff', platformAdmin: false, organization: { id: 'merchant', role: 'member' } }, ids: [] },
      { principal: { userId: 'buyer', platformAdmin: true, organization: null }, ids: [buyer.id, 'platform-alert'] },
      { principal: { userId: 'owner-a', platformAdmin: true, organization: { id: 'merchant', role: 'owner' } }, ids: [merchant.id] },
    ]
    for (const { principal, ids } of cases) {
      const filter = buildNotificationVisibilityFilter(principal)
      const actual = (await db.prepare(`SELECT n.id FROM activity_entries n WHERE ${filter.whereSql} ORDER BY n.id`).bind(...filter.whereParams).all()).results
      assert.deepEqual(actual.map(row => row.id), ids.sort(), JSON.stringify(principal))
    }
    const own = { userId: 'buyer', ...buildNotificationVisibilityFilter({ userId: 'buyer', platformAdmin: false, organization: null }) }
    const other = { userId: 'other-user', ...buildNotificationVisibilityFilter({ userId: 'other-user', platformAdmin: false, organization: null }) }
    assert.equal(await acknowledgeNotification(db, other, String(buyer.id)), false)
    assert.equal(await acknowledgeNotification(db, own, String(merchant.id)), false)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE kind='acknowledgement'").first('n'), 0)
    assert.equal(await acknowledgeNotification(db, own, String(buyer.id)), true)
    assert.deepEqual((await db.prepare("SELECT parent_id,actor_user_id FROM activity_entries WHERE kind='acknowledgement'").all()).results, [{ parent_id: buyer.id, actor_user_id: 'buyer' }])
    // One key names one alert: a replay with a different audience returns the first write and changes nothing.
    assert.equal(await createCanonicalNotification(db, { scope: 'organization', organizationId: 'other-merchant', template: eventKey, title: 'Changed audience', idempotencyKey: String(merchant.id) }), String(merchant.id))
    assert.equal(await db.prepare('SELECT organization_id FROM activity_entries WHERE id=?').bind(merchant.id).first('organization_id'), 'merchant')

    const differentlyCasedEvent = 'financial-proof:Capture'
    await notifyFinancialNotification(env, db, { ...input, eventKey: differentlyCasedEvent })
    assert.equal(await db.prepare('SELECT count(*) n FROM activity_entries WHERE event_name=?').bind(differentlyCasedEvent).first('n'), 2)
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries d JOIN activity_entries n ON n.id=d.entry_id WHERE n.event_name=?').bind(differentlyCasedEvent).first('n'), 3, 'case-sensitive event identities retain their own recipient receipts')
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries').first('n'), 6)

    const contactKey = 'financial-proof:contact'
    await notifyFinancialNotification(env, db, { ...input, eventKey: contactKey, guest: { ...input.guest, userId: null } })
    const contactRows = (await db.prepare('SELECT scope_kind,target_user_id FROM activity_entries WHERE event_name=?').bind(contactKey).all()).results
    assert.deepEqual(contactRows, [{ scope_kind: 'organization', target_user_id: null }], 'an email destination alone is not a personal audience')
    const contactReceipts = (await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results
    assert.equal(contactReceipts.length, 9)
    await notifyFinancialNotification(env, db, { ...input, eventKey: contactKey })
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name=? AND scope_kind='global' AND target_user_id='buyer'").bind(contactKey).first('n'), 1)
    assert.deepEqual((await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results, contactReceipts, 'an explicit buyer identity does not send the same contact email again')
    await db.prepare('DELETE FROM activity_entries WHERE id=?').bind(buyer.id).run()
    assert.equal(await db.prepare('SELECT id FROM activity_entries WHERE id=?').bind(buyer.id).first('id'), null)
    assert.deepEqual((await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results, contactReceipts, 'deleting a personal alert retains the merchant financial mail receipts')
    await notifyFinancialNotification(env, db, { ...input, guest: { ...input.guest, userId: null } })
    assert.deepEqual((await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results, contactReceipts, 'contact replay after personal deletion does not resend a settled email')
  } finally { await runtime.dispose() }
})

test('native Resend test transport persists one delivered financial email through dispatcher replay', {
  timeout: 60_000,
  skip: process.env.PAYMENTS_NATIVE_RESEND_TEST !== '1',
}, async (t) => {
  assert.ok(process.env.RESEND_API_KEY?.trim(), 'explicit native qualification requires the configured Resend credential')
  assert.ok(process.env.EMAIL_FROM?.trim(), 'explicit native qualification requires the configured sender')
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'native-financial-email-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO user (id,name,email,emailVerified) VALUES ('native-recipient','Native transport test','delivered@resend.dev',1)").run()
    assert.equal(await db.prepare('SELECT email FROM user WHERE id=?').bind('native-recipient').first('email'), 'delivered@resend.dev')
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries').first('n'), 0)
    const env = { ...await runtime.getBindings<CloudflareEnv>(), NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example',
      EMAIL_DELIVERY_MODE: 'provider', WHATSAPP_DELIVERY_MODE: 'log_only', RESEND_API_KEY: process.env.RESEND_API_KEY,
      EMAIL_FROM: process.env.EMAIL_FROM }
    const input = { organizationId: null, eventKey: `native-resend-transport:${crypto.randomUUID()}`,
      guest: { userId: 'native-recipient', email: 'delivered@resend.dev', message: guestPaymentMessage({ kind: 'payment_captured', organizationName: 'Sandbox transport qualification', amount: 10000, currency: 'USD' }) } }
    await notifyFinancialNotification(env, db, input)
    const receipt = await db.prepare('SELECT * FROM guest_thread_deliveries').first()
    assert(receipt)
    assert.equal(receipt.channel, 'email')
    assert.equal(receipt.provider, 'resend')
    assert.equal(receipt.purpose, 'status_update')
    assert.equal(receipt.status, 'sent')
    assert.equal(receipt.error, null)
    assert.ok(String(receipt.id).length <= 256)
    assert.match(String(receipt.provider_message_id), /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu)
    assert.deepEqual(await db.prepare('SELECT kind,scope_kind,target_user_id,organization_id,request_id FROM activity_entries WHERE id=?').bind(receipt.entry_id).first(),
      { kind: 'notification', scope_kind: 'global', target_user_id: 'native-recipient', organization_id: null, request_id: null })
    const client = getResendClient(env)
    let native = await resendData('native financial test email readback', () => client.emails.get(String(receipt.provider_message_id)))
    const deadline = Date.now() + 20_000
    while (native.last_event !== 'delivered' && Date.now() < deadline) {
      assert.ok(['queued', 'sent'].includes(native.last_event), `native test email reached ${native.last_event}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      native = await resendData('native financial test email readback', () => client.emails.get(String(receipt.provider_message_id)))
    }
    assert.equal(native.id, receipt.provider_message_id)
    assert.deepEqual(native.to, ['delivered@resend.dev'])
    assert.equal(native.subject, input.guest.message.title)
    assert.equal(native.last_event, 'delivered')
    assert.match(native.html ?? '', /100\.00 USD/u)
    await notifyFinancialNotification(env, db, input)
    assert.deepEqual(await db.prepare('SELECT * FROM guest_thread_deliveries').first(), receipt)
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries').first('n'), 1)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE kind='notification'").first('n'), 1)
    const replayReadback = await resendData('native financial test email replay readback', () => client.emails.get(String(receipt.provider_message_id)))
    assert.equal(replayReadback.id, native.id)
    assert.equal(replayReadback.last_event, 'delivered')
    t.diagnostic(JSON.stringify({ evidence: 'native Resend test transport', checked_at: new Date().toISOString(), recipient: 'delivered@resend.dev',
      email_id: native.id, last_event: native.last_event, receipt_id_length: String(receipt.id).length,
      persisted_notifications: 1, persisted_deliveries: 1, replay_provider_id_unchanged: true,
      actual_financial_trigger_qualified: false, actual_owner_inbox_qualified: false }))
  } finally { await runtime.dispose() }
})
