import { captureEvents } from './support/events.ts'
import assert from 'node:assert/strict'
import { creationRequestHash } from '../../server/utils/organization-events.ts'
import { createHmac } from 'node:crypto'
import { threadPayloadForGuest, requestInsertQueries, getGuestRequest, getThreadOperationalRecord, readBookedRecord } from '../../server/domain/requests.ts'
import { sendConversationMessage } from '../../server/domain/send-conversation-message.ts'
import { claimSessionCapacity, listBookableSessions } from '../../server/utils/availability.ts'
import { createTables } from './support/table-product.ts'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { createDeliveryReceipt, getDeliveryById, isVisibleDeliveryFailure, listThreadDeliveries, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { appendMessage, resolveConversationAccess } from '../../server/domain/conversations.ts'
import { executeGuestThreadOperation, sendGuestThreadReply } from '../../server/domain/guest-threads/operations.ts'
import { listConversations, readGuestInbox } from '../../server/domain/guest-threads/repository.ts'
import { moveBooking, requestBookingChange, respondToBookingChange } from '../../server/domain/guest-threads/booking-changes.ts'
import { notifyContactSubmitted, notifyFinancialNotification, notifyStayCancelled, notifyBookingCreated } from '../../server/utils/notifications.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay } from '../../server/domain/stays.ts'
import { buildBuyerRequestActivityUrl } from '../../server/utils/dashboard-notification-links.ts'
import { setNotificationPreference } from '../../server/domain/notification-preferences.ts'
import { registerDevice } from '../../server/domain/devices.ts'
import { guestPaymentMessage, ownerPaymentMessage } from '../../server/notifications/payment-events.ts'
import { addLocalDays, formatCalendarDate, formatTimestamp, localDateAt, localDateTimeToInstant } from '../../utils/timezone.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { applySchema } from './support/schema.ts'

async function guestUnread(db: Parameters<typeof readGuestInbox>[0], userId: string) {
  const inbox = await readGuestInbox(db, { userId, mailbox: 'current' })
  const unread = inbox.threads.filter(row => row.unread).length
  assert.equal(inbox.has_unread, unread > 0, 'the dot is the rows marked unread')
  return unread
}


test('a guest-thread email is sent once per event: replays send nothing, a failed send goes again, and a late reply never moves the thread', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'guest-delivery-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'guest-delivery-proof', exportName: 'Hub' } },
  } }] })

  try {
    const db = await runtime.getD1Database('DB')
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: queue.binding, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await applySchema(db)
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-proof', 'Proof', 'proof', 'proof', 'USD', 'UTC')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('proof-en', 'org-proof', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('user-proof', 'Proof Owner', 'owner@proof.example')",
      "INSERT INTO user (id, name, email, emailVerified) VALUES ('guest-proof', 'Proof Guest', 'guest@proof.example', 1)",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-proof','org-proof','user-proof','owner')",
    ]) await db.prepare(statement).run()
    const now = new Date().toISOString()
    const opening = requestInsertQueries({ id: 'contact-proof', kind: 'contact', organization_id: 'org-proof', location_id: null, booking_id: null, user_id: 'guest-proof', payload: { guest: { name: 'Proof Guest', email: 'guest@proof.example', phone: null }, subject: null, consent_at: null, ip_hash: null, answers: [] }, created_at: now }, undefined, { words: 'Hello' })
    await db.batch(opening.map(write => db.prepare(write.query).bind(...write.params)))
    await Promise.all([0, 1].map(() => notifyContactSubmitted(env, db, { organizationId: 'org-proof', organizationName: 'Proof', vertical: 'restaurant', locationId: null,
      contactId: 'contact-proof', guestName: 'Proof Guest', email: 'guest@proof.example', subject: null, message: 'Hello' })))
    assert.equal((await listConversations(db, 'org-proof', { userId: 'user-proof', unreadOnly: true }))[0]?.id, 'contact-proof')
    // The guest wrote it: their own words are not unread to them.
    assert.equal(await guestUnread(db, 'guest-proof'), 0)

    assert.deepEqual((await db.prepare("SELECT d.purpose,d.status FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id='contact-proof' ORDER BY d.purpose").all()).results,
      [{ purpose: 'guest_acknowledgement', status: 'sent' }, { purpose: 'owner_alert', status: 'sent' }])

    await db.prepare("INSERT INTO business_locations (id,organization_id,slug,title,timezone,opening_hours) VALUES ('booking-location','org-proof','booking','Booking','Asia/Bangkok',?)")
      .bind(JSON.stringify({ periods: [{ open: { day: 1, hour: 16, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }] })).run()
    // The restaurant's tables, and a Monday seating at 16:00: the seats live on
    // the booking of that seating, not the thread, so a change proposal is read
    // from and applied to the booking.
    const tables = await createTables(db, env, { organizationId: 'org-proof', locationId: 'booking-location', actorId: 'user-proof', memberId: 'member-proof', name: 'Booking table',
      durationMinutes: 120, seats: 10, weekdays: [1], open: '16:00', lastSeating: '20:00' })
    // Read a full future week so the first Monday starts with its opening seating.
    const firstFullDay = addLocalDays(localDateAt(new Date(now), 'Asia/Bangkok'), 1)
    const [seating] = await listBookableSessions(db, { env, organizationId: 'org-proof', productId: tables.id,
      fromInstant: localDateTimeToInstant(firstFullDay, '00:00', 'Asia/Bangkok').toISOString(),
      toInstant: localDateTimeToInstant(addLocalDays(firstFullDay, 7), '00:00', 'Asia/Bangkok').toISOString(),
    })
    assert.equal(seating && formatTimestamp(seating.starts_at, 'en', 'Asia/Bangkok', { weekday: 'long', hour: 'numeric', minute: '2-digit' }), 'Monday 4:00 PM')
    const tablePolicy = JSON.stringify({ advance_notice_minutes: null, party_size_min: null, party_size_max: null, minimum_guest_age: null, accessibility_contact_required: false, payment: null })
    const { bookingId: createdBookingId } = await claimSessionCapacity(db, { websiteSource: null, env, organizationId: 'org-proof', productId: tables.id, sessionId: seating!.id, productVariantId: tables.variants[0]!.id, partySize: 1, userId: 'guest-proof', policyJson: tablePolicy,
      following: bookingId => requestInsertQueries({ id: 'change-proof', kind: 'booking', organization_id: 'org-proof', location_id: 'booking-location', booking_id: bookingId,
        user_id: 'guest-proof', payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example', phone: '+66812345678' }), created_at: now },
      { query: 'SELECT 1 FROM bookings WHERE id = ?', params: [bookingId] }, { opening: 'Table for 1', note: null }) })
    await notifyBookingCreated(env, db, { organizationId: 'org-proof', organizationName: 'Proof', vertical: 'restaurant', locationId: 'booking-location', status: 'confirmed',
      bookingId: 'change-proof', bookingRecordId: createdBookingId, guestName: 'Guest', email: 'guest@proof.example', guestPhone: '+66812345678', productId: tables.id, productKind: 'table', productTitle: tables.name,
      startsAt: seating!.starts_at, timezone: 'Asia/Bangkok', partySize: 1, partySizeIsMinimum: false, answers: [] })
    const createdEmail=await db.prepare("SELECT d.status,d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id='change-proof' AND d.purpose='guest_acknowledgement'").first<{status:string;email_json:string}>()
    assert.equal(createdEmail?.status,'sent')
    assert.match(JSON.parse(createdEmail!.email_json).message.html,/href="https:\/\/proof\.example\/dashboard\/account\/messages\/change-proof\/reservation"/)
    assert.equal(await buildBuyerRequestActivityUrl(env,db,{organizationId:'another-tenant',threadId:'change-proof'}),null,'another tenant cannot mint an account management link for this request')
    const propose = async (key: string, partySize: number) => {
      const current = await getGuestRequest(db, 'change-proof')
      assert(current)
      const booked = await db.prepare("SELECT version FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").first<number>('version')
      assert(booked)
      await requestBookingChange(db, env, current, 'user-proof', { kind: 'booking', product_session_id: seating!.id, party_size: partySize, version: booked }, key)
      await queue.drain(env, 'booking.change')
      const requestId = await db.prepare('SELECT id FROM messages WHERE dedupe_key = ?').bind(`booking-change-request:change-proof:${key}`).first<string>('id')
      assert(requestId)
      return { threadId: 'change-proof', requestId, token: createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`booking-change:v1:change-proof:${requestId}`).digest('hex'), decision: 'accept' as const }
    }
    const proposal = await propose('first-change', 2)
    // The proposal is Blawby's message in the guest's conversation, unread to them until they open it.
    assert.equal(await guestUnread(db, 'guest-proof'), 1)
    const proposalEmail = await db.prepare('SELECT status,email_json FROM guest_thread_deliveries WHERE message_id = ? AND purpose=\'status_update\'').bind(proposal.requestId).first<{status:string;email_json:string}>()
    assert.equal(proposalEmail?.status, 'sent')
    const proposalMessage = JSON.parse(proposalEmail!.email_json).message
    assert.equal(proposalMessage.to, 'guest@proof.example')
    assert.match(proposalMessage.html, new RegExp(`/booking-changes/change-proof/${proposal.requestId}`))
    assert.match(proposalMessage.html,/href="https:\/\/proof\.example\/dashboard\/account\/messages\/change-proof\/reservation"/,'review mail preserves its signed review action and adds account management')
    assert.equal(await db.prepare("SELECT party_size FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").first('party_size'), 1, 'notification leaves the original booking unchanged while awaiting the buyer')
    const proposalThread = await getGuestRequest(db, 'change-proof')
    assert(proposalThread)
    const proposalRevision = await db.prepare("SELECT json_extract(payload_json, '$.version') AS revision FROM messages WHERE id = ?").bind(proposal.requestId).first<number>('revision')
    assert(proposalRevision)
    const replayProposal = () => requestBookingChange(db, env, proposalThread, 'user-proof', {
      kind: 'booking', product_session_id: seating!.id, party_size: 2, version: proposalRevision,
    }, 'first-change')
    // The original request may finish while the guest answers it. A late
    // proposal projection must not reopen the completed conversation.
    const [accepted] = await Promise.all([respondToBookingChange(db, env, proposal), replayProposal()])
    assert.equal(accepted.status, 'accepted')
    await queue.drain(env, 'booking.change')
    const acceptedThread = await getGuestRequest(db, 'change-proof')
    const acceptedDeliveries = (await db.prepare('SELECT d.* FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id = ? ORDER BY d.id').bind('change-proof').all()).results
    assert.deepEqual(await replayProposal(), { changeStatus: 'accepted' })
    assert.deepEqual(await getGuestRequest(db, 'change-proof'), acceptedThread)
    assert.deepEqual((await db.prepare('SELECT d.* FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id = ? ORDER BY d.id').bind('change-proof').all()).results, acceptedDeliveries)
    assert.equal((await respondToBookingChange(db, env, proposal)).status, 'accepted')
    const acceptedMail=await db.prepare("SELECT d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id='change-proof' AND e.event_name='booking_change.accepted' AND d.purpose='status_update'").first<string>('email_json')
    assert(acceptedMail)
    assert.match(JSON.parse(acceptedMail).message.html,/href="https:\/\/proof\.example\/dashboard\/account\/messages\/change-proof\/reservation"/)
    assert.equal(await db.prepare("SELECT party_size FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").first('party_size'), 2)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM messages WHERE conversation_id = 'change-proof' AND event_name='booking_change.accepted'").first('count'), 1)

    const stale = await propose('stale-change', 3)
    // Anything that moves the record makes the open proposal stale. What moved
    // it is not the subject; that it moved is.
    await db.prepare("UPDATE bookings SET party_size = 5, version = version + 1, updated_at = ? WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").bind(new Date(Date.now() + 1000).toISOString()).run()
    await assert.rejects(respondToBookingChange(db, env, stale), /changed since the request/)
    const concurrent = await propose('concurrent-change', 4)
    const [decision, cancellation] = await Promise.allSettled([respondToBookingChange(db, env, concurrent), executeGuestThreadOperation(db, {
      threadId: 'change-proof', organizationId: 'org-proof', action: 'cancel', actorUserId: 'user-proof', idempotencyKey: 'owner-cancel', env })])
    // Name the reason when the owner's cancel loses: a bare falsy assertion hid
    // which side of the race failed in CI.
    assert.equal(cancellation.status, 'fulfilled', `cancel rejected: ${cancellation.status === 'rejected' ? String(cancellation.reason) : ''}`)
    if (cancellation.value.ok) {
      await queue.drain(env, 'booking.status_changed')
      assert.equal(await db.prepare("SELECT status FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").first('status'),'cancelled')
      assert.equal(await db.prepare("SELECT count(*) count FROM messages WHERE conversation_id = 'change-proof' AND event_name='booking.cancel'").first('count'),1)
      if (decision.status==='fulfilled') assert.equal(decision.value.status,'accepted')
      else assert.match(String(decision.reason),/changed|no longer/)
      const cancellationSnapshot=await db.prepare("SELECT json_extract(payload_json,'$.booking.party_size') party_size FROM messages WHERE conversation_id = 'change-proof' AND event_name='booking.cancel'").first<{party_size:number}>()
      assert.equal(await db.prepare("SELECT party_size FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").first('party_size'),cancellationSnapshot!.party_size,'a committed cancellation announces the actual source it cancelled')
      const cancellationDelivery=await db.prepare("SELECT d.status,d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id='change-proof' AND e.event_name='booking.cancel' AND d.purpose='status_update'").first<{status:string;email_json:string}>()
      assert.equal(cancellationDelivery?.status,'sent','a cancellation never commits with a superseded notification snapshot')
      assert.match(JSON.parse(cancellationDelivery!.email_json).message.html,/href="https:\/\/proof\.example\/dashboard\/account\/messages\/change-proof\/reservation"/)
    } else {
      assert.equal(cancellation.value.status,409)
      assert.equal(cancellation.value.reason,'invalid_transition')
      assert.equal(decision.status,'fulfilled','the acceptance must be the successful competing source change')
      assert.equal((decision as PromiseFulfilledResult<Awaited<ReturnType<typeof respondToBookingChange>>>).value.status,'accepted')
      assert.deepEqual(await db.prepare("SELECT status,party_size FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='change-proof')").first(),{status:'confirmed',party_size:4},'a conflicting cancellation leaves the accepted appointment intact')
      assert.equal(await db.prepare("SELECT count(*) count FROM messages WHERE conversation_id = 'change-proof' AND event_name='booking.cancel'").first('count'),0,'the losing cancellation writes neither a transition nor an email intent')
    }
    assert.equal(await db.prepare(`SELECT count(*) AS count FROM messages accepted JOIN messages cancelled ON cancelled.conversation_id=accepted.conversation_id
      WHERE accepted.conversation_id='change-proof' AND accepted.event_name='booking_change.accepted' AND cancelled.event_name='booking.cancel' AND accepted.sequence>cancelled.sequence`).first('count'),0)
    await appendMessage(db, { id: 'entry-proof', conversationId: 'contact-proof', authorKind: 'guest', authorUserId: 'guest-proof', channel: 'email', dedupeKey: 'proof', body: 'Thanks', occurredAt: '2026-09-05T00:00:00.000Z' })


    const reply = (body: string, idempotencyKey: string) => sendGuestThreadReply(db, {
      threadId: 'contact-proof', organizationId: 'org-proof', actorUserId: 'user-proof', body, idempotencyKey, env })
    const deliveryRow = (id: string) => db.prepare('SELECT status, provider_message_id, email_json, email_message_id FROM guest_thread_deliveries WHERE id = ?').bind(id).first<{ status: string; provider_message_id: string | null; email_json: string | null; email_message_id: string | null }>()

    // A reply is sent, and its receipt carries the provider's message id.
    const operationKey = 'reply-proof'
    const operationDedupeKey = `guest-thread-operation:contact-proof:${operationKey}`
    const deliveryId = `guest-thread-email:contact-proof:${operationKey}`
    assert.deepEqual(await reply('A reply', operationKey).then(outcome => ({ ok: outcome.ok, status: outcome.status })), { ok: true, status: 200 })
    const sent = await deliveryRow(deliveryId)
    assert.equal(sent?.status, 'sent')
    assert.match(sent?.provider_message_id ?? '', /^log-only:email:/)
    assert.equal(sent?.email_message_id, null, 'log-only delivery has no actual RFC Message-ID')
    assert(sent?.email_json)
    const recordedReply = JSON.parse(sent.email_json)
    assert.equal(recordedReply.message.to, 'guest@proof.example')
    assert.equal(recordedReply.message.inReplyTo, undefined, 'messages without genuine RFC ancestry do not invent a parent')
    assert.equal(recordedReply.message.references, undefined)
    assert.ok(recordedReply.message.html.includes('A reply'))
    assert.ok(recordedReply.message.text.includes('A reply'))
    // Replaying the same reply sends nothing: the receipt keeps its message id.
    assert.equal((await reply('A reply', operationKey)).ok, true)
    assert.equal((await deliveryRow(deliveryId))?.provider_message_id, sent?.provider_message_id)
    assert.equal((await deliveryRow(deliveryId))?.email_json, sent.email_json, 'replaying a staff reply preserves its frozen email request')
    // The business's reply is unread to the guest until they open it, once however often it is replayed.
    assert.equal(await guestUnread(db, 'guest-proof'), 2)


    // A delayed delivery cannot replace a newer guest message in the inbox.
    const delayedOperationKey = 'delayed-reply-proof'
    const delayedReplyEntry = await appendMessage(db, {
      conversationId: 'contact-proof',
      authorKind: 'member', authorUserId: 'user-proof',
      channel: 'email',
      body: 'A delayed reply',
      payload: { request_hash: await creationRequestHash({body:'A delayed reply',photos:[]}) },
      eventName: 'thread.member_reply',
      dedupeKey: `guest-thread-operation:contact-proof:${delayedOperationKey}`,
    })
    await createDeliveryReceipt(db, {
      subject: { messageId: delayedReplyEntry.id },
      channel: 'email',
      provider: 'log_only',
      purpose: 'member_reply',
      idempotencyKey: `guest-thread-email:contact-proof:${delayedOperationKey}`,
    })
    await appendMessage(db, {
      conversationId: 'contact-proof',
      authorKind: 'guest', authorUserId: 'guest-proof',
      channel: 'email',
      body: 'A newer guest reply',
      dedupeKey: 'email:newer-guest-reply-proof',
    })
    assert.deepEqual(await reply('A delayed reply', delayedOperationKey).then(outcome => ({ ok: outcome.ok, status: outcome.status })), { ok: true, status: 200 })
    assert.equal((await deliveryRow(`guest-thread-email:contact-proof:${delayedOperationKey}`))?.status, 'sent')
    const [inboxRow] = await listConversations(db, 'org-proof', { userId: 'user-proof', unreadOnly: true, conversationIds: ['contact-proof'] })
    assert.equal(inboxRow?.preview, 'A newer guest reply')

    // A failed send shows on the thread, and replaying the reply sends it again.
    const failedOperationKey = 'failed-reply-proof'
    const failedEntry = await appendMessage(db, {
      conversationId: 'contact-proof',
      authorKind: 'member', authorUserId: 'user-proof',
      channel: 'email',
      body: 'A failed reply',
      payload: { request_hash: await creationRequestHash({body:'A failed reply',photos:[]}) },
      eventName: 'thread.member_reply',
      dedupeKey: `guest-thread-operation:contact-proof:${failedOperationKey}`,
    })
    const failedReceipt = await createDeliveryReceipt(db, {
      subject: { messageId: failedEntry.id },
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

    assert.equal((await db.prepare('SELECT count(*) count FROM messages WHERE dedupe_key = ?').bind(operationDedupeKey).first<{ count: number }>())?.count, 1)
    assert.equal((await db.prepare('SELECT count(*) count FROM guest_thread_deliveries WHERE id = ?').bind(deliveryId).first<{ count: number }>())?.count, 1)
  } finally {
    await runtime.dispose()
  }
})

test('a replayed status email sends its recorded content and refuses a superseded booking', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T10:00:00Z') })
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'status-retry-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'status-retry-proof', exportName: 'Hub' } },
  } }] })
  const requests: { to: string[]; subject: string; text: string; html: string; headers?: Record<string, string> }[] = []
  let reject = true
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === 'https://api.resend.com/emails/status-proof' && init.method === 'GET') {
      const sent = requests.at(-1)!
      return Response.json({ id: 'status-proof', message_id: '<status-proof@provider-proof.com>', to: sent.to, subject: sent.subject, html: sent.html, text: sent.text })
    }
    assert.equal(url, 'https://api.resend.com/emails')
    requests.push(JSON.parse(String(init.body)))
    return reject ? Response.json({ name: 'application_error', message: 'Provider rejected' }, { status: 503 }) : Response.json({ id: 'status-proof' })
  })
  try {
    const db = await runtime.getD1Database('DB')
    await applySchema(db)
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-status', 'Proof', 'proof', 'proof', 'USD', 'UTC')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('status-en', 'org-status', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('user-status', 'Proof Owner', 'owner@proof.example')",
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('location-status', 'org-status', 'proof', 'Proof', 'UTC')",
      "INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('table', 'table-status', 'org-status', 'Dining room', 'dining-room', 'user-status', 'user-status')",
      "INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('table-status-variant', 'org-status', 'table-status', 'Table', 'user-status', 'user-status')",
      "INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES ('org-status', 'table-status', 'location-status', 1, 1, 'user-status', 'user-status')",
      "INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, created_by, updated_by) VALUES ('table-status', 'org-status', 'slot', 120, 10, 'business', 'user-status', 'user-status')",
    ]) await db.prepare(statement).run()
    const now = new Date().toISOString()
    // The instant and the zone the guest agreed to live on the table's seating;
    // the confirmation email is formatted from them, never from a server clock.
    await db.prepare(`INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
      VALUES ('seating-status','org-status','table-status','location-status','Asia/Bangkok','2098-10-01T11:00:00.000Z','2098-10-01T13:00:00.000Z',10,'scheduled','user-status','user-status')`).run()
    await db.prepare(`INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,party_size,policy_json,status,location_id,starts_at,ends_at,timezone)
      SELECT 'reservation-status','org-status','table-status','seating-status','table-status-variant',2,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed',location_id,starts_at,ends_at,timezone FROM product_sessions WHERE id = 'seating-status'`).run()
    const opening = requestInsertQueries({ id: 'booking-status', kind: 'booking', organization_id: 'org-status', location_id: 'location-status', booking_id: 'reservation-status', user_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@provider-proof.com', phone: '123' }), created_at: now }, undefined, { opening: 'Table for 2', note: null })
    await db.batch(opening.map(write => db.prepare(write.query).bind(...write.params)))

    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), DB: db, EVENTS: queue.binding, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 'controlled-provider-only', EMAIL_FROM: 'Blawby <hello@krabiclaw.com>', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'status-retry-proof', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example' }
    const input = {
      threadId: 'booking-status', organizationId: 'org-status', actorUserId: 'user-status',
      env,
    }
    const cancel = { ...input, action: 'cancel', idempotencyKey: 'cancel-status' }
    assert.equal((await executeGuestThreadOperation(db, cancel)).status, 200)
    assert.equal(requests.length, 0, 'the booking mutation leaves email delivery to EVENTS')
    await assert.rejects(queue.runNext(env, 'booking.status_changed'), /Provider rejected/)
    assert.equal(await db.prepare("SELECT status FROM bookings WHERE id='reservation-status'").first('status'), 'cancelled')
    assert.equal(requests.length, 1)
    const deliveryId = 'guest-thread-email:booking-status:cancel-status'
    assert.equal((await getDeliveryById(db, deliveryId))!.status, 'failed')
    const frozenRequest = (await getDeliveryById(db, deliveryId))!.email_json
    assert(frozenRequest)
    const original = requests[0]!
    const guestBody = 'Proof · Oct 1, 2098, 6:00 PM GMT+7 · 2 guests'
    // A table reads as a reservation, named by what was booked.
    assert.equal(original.subject, 'Reservation Cancelled — Dining room')
    assert.ok(original.text.includes(guestBody), original.text)
    assert.ok(original.html.includes(guestBody), original.html)
    const emailReason = 'You received this email because there is an update to your request with Proof.'
    assert.ok(original.html.includes(emailReason), original.html)
    assert.ok(original.text.replace(/\s+/g, ' ').includes(emailReason), original.text)
    assert.doesNotMatch(original.html, /unsubscribe|\/signup/i)
    assert.doesNotMatch(original.text, /unsubscribe|\/signup/i)
    assert.equal(original.headers, undefined, 'a cancellation is transactional and has no mailing-list headers')
    assert.doesNotMatch(original.html,/dashboard\/account\/messages\//,'an unowned legacy request has no fabricated account management action')
    // A later display edit cannot change the copy already recorded for this
    // cancellation. Retrying sends the exact first email again.
    await db.prepare("UPDATE organization SET name='Changed after cancellation' WHERE id='org-status'").run()
    await assert.rejects(queue.runNext(env, 'booking.status_changed'), /Provider rejected/)
    assert.deepEqual(requests[1], original)
    assert.equal((await getDeliveryById(db, deliveryId))!.email_json, frozenRequest)

    // Moving the booking is what makes the pending send stale — the thread
    // carries no copy of the time to move. The booking holds its time as a move writes it.
    await db.prepare("UPDATE bookings SET starts_at = '2098-10-02T11:00:00.000Z', ends_at = '2098-10-02T13:00:00.000Z', version = version + 1 WHERE id = 'reservation-status'").run()
    const attemptsBefore = requests.length
    await queue.runNext(env, 'booking.status_changed')
    assert.equal(requests.length, attemptsBefore)
    // Cancelling is the one transition, so a second one has nothing to move:
    // the record is already cancelled and the stale send stays refused.
    reject = false
    const afterCancellation = requests.length
    assert.equal((await executeGuestThreadOperation(db, { ...input, action: 'cancel', idempotencyKey: 'cancel-again' })).status, 409)
    assert.equal(requests.length, afterCancellation)
    assert.equal((await getDeliveryById(db, deliveryId))!.status, 'skipped')
    const entry = await db.prepare('SELECT body, payload_json FROM messages WHERE id = ?')
      .bind((await getDeliveryById(db, deliveryId))!.message_id).first<{ body: string; payload_json: string }>()
    assert.equal(entry!.body, guestBody)
    assert.equal(JSON.parse(entry!.payload_json).subject, original.subject)
  } finally {
    await runtime.dispose()
  }
})

test('a guest-cancelled stay alerts owners with the whole stay and the member looking after the home with its turnover', async (t) => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-member-alert-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-member-alert-proof', exportName: 'Hub' } },
  } }] })
  const emails: Array<{ to: string[]; subject: string; text: string; html: string }> = []
  const pushes: Array<{ url: string; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.sandbox.push.apple.com/')) {
      pushes.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(null, { status: 200 })
    }
    assert.equal(url, 'https://api.resend.com/emails')
    emails.push(JSON.parse(String(init.body)))
    return Response.json({ id: `sent-${emails.length}` })
  })
  try {
    const db = await runtime.getD1Database('DB')
    const signingKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', signingKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: queue.binding, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'provider', WHATSAPP_DELIVERY_MODE: 'log_only',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', RESEND_API_KEY: 'controlled-provider-only', EMAIL_FROM: 'Blawby <hello@krabiclaw.com>',
      APNS_KEY_ID: 'PROOFKEY01', APNS_TEAM_ID: 'PROOFTEAM1', APNS_BUNDLE_ID: 'com.krabiclaw.app', APNS_PRIVATE_KEY: pem }
    await applySchema(db)
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone, vertical, theme_id) VALUES ('org-turnover', 'Turnover Retreat', 'turnover', 'turnover', 'USD', 'Asia/Bangkok', 'lodging', 'tenant-theme-v1')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('turnover-en', 'org-turnover', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('owner-turnover', 'Owner', 'owner@provider-proof.com'), ('cleaner-turnover', 'Cleaner', 'cleaner@provider-proof.com'), ('unassigned-turnover', 'Unassigned', 'unassigned@provider-proof.com')",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-owner-turnover', 'org-turnover', 'owner-turnover', 'owner'), ('member-cleaner-turnover', 'org-turnover', 'cleaner-turnover', 'member'), ('member-unassigned-turnover', 'org-turnover', 'unassigned-turnover', 'member')",
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone, status) VALUES ('location-turnover', 'org-turnover', 'retreat', 'Retreat', 'Asia/Bangkok', 'active')",
      "INSERT INTO session (id, expiresAt, token, userId) VALUES ('session-cleaner', unixepoch() + 3600, 'session-token-cleaner', 'cleaner-turnover'), ('session-unassigned', unixepoch() + 3600, 'session-token-unassigned', 'unassigned-turnover')",
    ]) await db.prepare(statement).run()
    const deviceToken = 'cd'.repeat(32)
    await registerDevice(db, { kind: 'apns', token: deviceToken, environment: 'sandbox', userId: 'cleaner-turnover', sessionId: 'session-cleaner' })
    await registerDevice(db, { kind: 'apns', token: 'ef'.repeat(32), environment: 'sandbox', userId: 'unassigned-turnover', sessionId: 'session-unassigned' })
    const access = { organizationId: 'org-turnover', actorId: 'owner-turnover', manage: true as const }
    const home = await createProduct(db, { env, organizationId: access.organizationId, actor: { actorId: access.actorId }, product: {
      kind: 'stay', name: 'Turnover Cabin', variants: [{ name: 'Turnover Cabin', prices: [{ unit_amount: 15000, currency: 'USD' }] }],
      stay: { location_id: 'location-turnover', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: 'member-cleaner-turnover' },
    } })
    // A site checkout saves the guest's whole name in guest_name.
    const checkIn = addLocalDays(localDateAt(new Date(), 'Asia/Bangkok'), 14)
    const checkOut = addLocalDays(checkIn, 2)
    const stay = await createStay(db, env, access, { product_id: home.id, idempotency_key: 'turnover-alert', check_in_date: checkIn, check_out_date: checkOut, arrival_time: '15:30',
      adults: 2, children: 1, guest_name: 'Ana Silva', guest_email: 'guest@provider-proof.com', private_notes: 'Door code 4411', total_minor: 30000 })
    assert(stay.conversation_id)
    await notifyStayCancelled(env, db, access.organizationId, stay.id, 'guest', 12345)

    const to = (address: string) => emails.filter(email => email.to.includes(address))
    assert.equal(to('owner@provider-proof.com').length, 1)
    assert.equal(to('cleaner@provider-proof.com').length, 1)
    assert.equal(to('unassigned@provider-proof.com').length, 0)
    const [ownerEmail] = to('owner@provider-proof.com')
    const [memberEmail] = to('cleaner@provider-proof.com')
    const subjectDay = formatCalendarDate(checkIn, 'en-US', { month: 'short', day: 'numeric' })
    const dateLabel = (date: string) => formatCalendarDate(date, 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    const checkInLabel = `${dateLabel(checkIn)} · 4:00 PM`
    const checkOutLabel = `${dateLabel(checkOut)} · 10:00 AM`
    const memberSubject = `Reservation canceled - Ana, ${subjectDay}`
    assert.equal(ownerEmail!.subject, `Reservation canceled - Ana Silva, ${subjectDay}`)
    for (const fact of ['guest@provider-proof.com', '$123.45', '3:30 PM']) assert(ownerEmail!.text.includes(fact), `the owner's alert states ${fact}`)
    assert.equal(memberEmail!.subject, memberSubject)
    for (const fact of ['Place to stay\nTurnover Cabin', 'Guest\nAna\n', `Check-in\n${checkInLabel}`, `Check-out\n${checkOutLabel}`, 'Arriving\n3:30 PM', 'Guests\n3\n', `https://proof.example/dashboard/turnover/messages/${stay.conversation_id}`]) assert(memberEmail!.text.includes(fact), `the member's alert states ${fact}`)
    for (const secret of ['Silva', 'guest@provider-proof.com', '$123.45', 'Door code']) {
      assert(!memberEmail!.text.includes(secret) && !memberEmail!.html.includes(secret), `the member's alert leaves out ${secret}`)
    }
    // The assigned member's phone opens the guest conversation.
    assert.equal(pushes.length, 1)
    assert.equal(pushes[0]!.url, `https://api.sandbox.push.apple.com/3/device/${deviceToken}`)
    // A system cancellation alone does not put a stay in the unread inbox.
    assert.deepEqual(pushes[0]!.body, {
      aps: { alert: { title: memberSubject, body: `Turnover Cabin · ${checkInLabel} – ${checkOutLabel}` }, sound: 'default', badge: 0, 'thread-id': stay.conversation_id },
      organization_id: access.organizationId, user_id: 'cleaner-turnover', kind: 'guest', conversation_id: stay.conversation_id,
    })
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
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: queue.binding, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await applySchema(db)
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
      "INSERT INTO user (id,name,email,emailVerified) VALUES ('guest-move','Guest','guest@move.example',1)",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-move','org-move','user-move','owner')",
      "INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('loc-move','org-move','move','Move','Asia/Bangkok')",
      "INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('experience', 'prod-move','org-move','Class','class','user-move','user-move')",
      "INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('var-move','org-move','prod-move','Adult','user-move','user-move')",
      "INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, created_by, updated_by) VALUES ('prod-move','org-move', 'slot',60,4,'business','user-move','user-move')",
      // The branch offers it: a session at a location only takes seats while
      // that location is still selling the product.
      "INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES ('org-move','prod-move','loc-move',1,1,'user-move','user-move')",
      // The destination has room when proposed; another party fills it before acceptance.
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES ('session-from','org-move','prod-move','loc-move','Asia/Bangkok','${soon}','${soonEnd}',4,'scheduled','user-move','user-move')`,
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES ('session-to','org-move','prod-move','loc-move','Asia/Bangkok','${later}','${laterEnd}',2,'scheduled','user-move','user-move')`,
      `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,party_size,policy_json,status,location_id,starts_at,ends_at,timezone) SELECT 'booking-other','org-move','prod-move','session-to','var-move',1,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed',location_id,starts_at,ends_at,timezone FROM product_sessions WHERE id = 'session-to'`,
    ]) await db.prepare(statement).run()
    await db.prepare(`INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,user_id,party_size,policy_json,status,location_id,starts_at,ends_at,timezone)
      SELECT 'booking-move','org-move','prod-move','session-from','var-move','guest-move',1,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed',location_id,starts_at,ends_at,timezone FROM product_sessions WHERE id = 'session-from'`).run()
    const thread = requestInsertQueries({ id: 'move-proof', kind: 'booking', organization_id: 'org-move', location_id: 'loc-move', booking_id: 'booking-move',
      user_id: 'guest-move', payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@move.example', phone: '+66812345678' }), created_at: now }, undefined, { opening: 'Class for 1', note: null })
    await db.batch(thread.map(write => db.prepare(write.query).bind(...write.params)))

    await notifyBookingCreated(env,db,{organizationId:'org-move',organizationName:'Move',bookingId:'move-proof',bookingRecordId:'booking-move',productId:'prod-move',productKind:'experience',productTitle:'Class',vertical:'experience',locationId:'loc-move',guestName:'Guest',email:'guest@move.example',startsAt:soon,timezone:'Asia/Bangkok',partySize:1,partySizeIsMinimum:false,status:'confirmed',answers:[]})
    const classMail=await db.prepare("SELECT d.status,d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id='move-proof' AND d.purpose='guest_acknowledgement'").first<{status:string;email_json:string}>()
    assert.equal(classMail?.status,'sent')
    assert.match(JSON.parse(classMail!.email_json).message.html,/href="https:\/\/proof\.example\/dashboard\/account\/messages\/move-proof\/reservation"/)
    const current = await getGuestRequest(db, 'move-proof')
    assert(current)
    const booked = await db.prepare("SELECT version FROM bookings WHERE id='booking-move'").first<number>('version')
    assert(booked)
    await requestBookingChange(db, env, current, 'user-move', { kind: 'booking', product_session_id: 'session-to', party_size: 1, version: booked }, 'full-session')
    await db.prepare("UPDATE bookings SET party_size=2 WHERE id='booking-other'").run()
    const requestId = await db.prepare('SELECT id FROM messages WHERE dedupe_key = ?').bind('booking-change-request:move-proof:full-session').first<string>('id')
    assert(requestId)
    const token = createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`booking-change:v1:move-proof:${requestId}`).digest('hex')

    await assert.rejects(
      respondToBookingChange(db, env, { threadId: 'move-proof', requestId, token, decision: 'accept' }),
      /filled up/,
      'a full destination refuses the move',
    )
    // Nothing about the original may have moved: not its session, not its
    // status, not the thread it answers.
    const original = await db.prepare("SELECT b.product_session_id, b.status, c.id AS request_id FROM bookings b JOIN conversations c ON c.booking_id = b.id WHERE b.id='booking-move'").first<{ product_session_id: string; status: string; request_id: string | null }>()
    assert.deepEqual(original, { product_session_id: 'session-from', status: 'confirmed', request_id: 'move-proof' })
    assert.equal(await db.prepare("SELECT count(*) AS count FROM bookings WHERE product_session_id='session-to'").first('count'), 1,
      'no replacement seat was taken in the full session')
    assert.equal(await db.prepare("SELECT count(*) AS count FROM messages WHERE conversation_id = 'move-proof' AND event_name='booking_change.accepted'").first('count'), 0,
      'the decision was not recorded for a move that did not happen')
    await db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id='booking-other'").run()
    await respondToBookingChange(db, env, { threadId: 'move-proof', requestId, token, decision: 'accept' })
    await respondToBookingChange(db, env, { threadId: 'move-proof', requestId, token, decision: 'accept' })
    const moved = await db.prepare("SELECT b.id, b.product_session_id, b.status, c.id AS request_id FROM bookings b JOIN conversations c ON c.booking_id = b.id WHERE b.id='booking-move'").first()
    assert.deepEqual(moved, { id: 'booking-move', product_session_id: 'session-to', status: 'confirmed', request_id: 'move-proof' })
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM bookings WHERE id=(SELECT booking_id FROM conversations WHERE id='move-proof')").first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = 'move-proof' AND event_name='booking_change.accepted'").first('n'), 1)
    const cancelled=await executeGuestThreadOperation(db,{threadId:'move-proof',organizationId:'org-move',actorUserId:'user-move',action:'cancel',idempotencyKey:'ordinary-class-cancellation',env})
    assert.equal(cancelled.ok,true,'an ordinary confirmed experience cancels through the same guarded operation')
    assert.equal(cancelled.status,200)
    assert.deepEqual(await db.prepare("SELECT id,status,party_size,product_session_id FROM bookings WHERE id='booking-move'").first(),{id:'booking-move',status:'cancelled',party_size:1,product_session_id:'session-to'})
    await queue.drain(env, 'booking.status_changed')
    const cancellationEmail=await db.prepare("SELECT d.status,d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id='move-proof' AND e.event_name='booking.cancel' AND d.purpose='status_update'").first<{status:string;email_json:string}>()
    assert.equal(cancellationEmail?.status,'sent')
    assert.match(JSON.parse(cancellationEmail!.email_json).message.html,/href="https:\/\/proof\.example\/dashboard\/account\/messages\/move-proof\/reservation"/)


  } finally { await runtime.dispose() }
})

test('a guest writing while the business edits a table booking does not refuse the change; a change to the booking itself does', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'table-change-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'table-change-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: queue.binding, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    await applySchema(db)
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone, vertical) VALUES ('org-table', 'Bistro', 'bistro', 'bistro', 'USD', 'UTC', 'restaurant')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('table-en', 'org-table', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('user-table', 'Owner', 'owner@table.example')",
      "INSERT INTO user (id,name,email,emailVerified) VALUES ('guest-table','Guest','guest@table.example',1)",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('member-table','org-table','user-table','owner')",
      "INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('loc-old-town','org-table','old-town','Old Town','Asia/Bangkok')",
    ]) await db.prepare(statement).run()
    // The tables, a seating every half hour from 17:00 to 20:00, set up as the dashboard sets them up.
    const oldTown = await createTables(db, env, { organizationId: 'org-table', locationId: 'loc-old-town', actorId: 'user-table', memberId: 'member-table', name: 'Old Town tables',
      durationMinutes: 90, seats: 8, open: '17:00', lastSeating: '20:00' })
    // One whole local day, two days out, in the branch's own clock.
    const day = addLocalDays(localDateAt(new Date(), 'Asia/Bangkok'), 2)
    const window = { fromInstant: localDateTimeToInstant(day, '00:00', 'Asia/Bangkok', 'compatible').toISOString(), toInstant: localDateTimeToInstant(addLocalDays(day, 1), '00:00', 'Asia/Bangkok', 'compatible').toISOString() }
    const oldTownSeatings = await listBookableSessions(db, { env, organizationId: 'org-table', productId: oldTown.id, ...window })
    // Seven seatings a day: 17:00 through 20:00 every 30 minutes.
    assert.deepEqual(oldTownSeatings.map(session => formatTimestamp(session.starts_at, 'en', 'Asia/Bangkok', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })),
      ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00'])
    const [first, , third] = oldTownSeatings
    assert(first && third)

    const policyJson = JSON.stringify({ advance_notice_minutes: null, party_size_min: null, party_size_max: null, minimum_guest_age: null, accessibility_contact_required: false, payment: null, cancellation: null })
    const now = new Date().toISOString()
    await claimSessionCapacity(db, { websiteSource: null, env, organizationId: 'org-table', productId: oldTown.id, sessionId: first.id, productVariantId: oldTown.variants[0]!.id, partySize: 2, userId: 'guest-table', policyJson,
      following: bookingId => requestInsertQueries({ id: 'table-thread', kind: 'booking', organization_id: 'org-table', location_id: 'loc-old-town', booking_id: bookingId,
        user_id: 'guest-table', payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@table.example', phone: '+66812345678' }), created_at: now },
      { query: 'SELECT 1 FROM bookings WHERE id = ?', params: [bookingId] }, { opening: 'Table for 2', note: null }) })
    const bookingId = (await getThreadOperationalRecord(db, 'table-thread'))!.id

    const sendGuestMessage = async (body: string, idempotencyKey: string) => sendConversationMessage(env, {
      ...await resolveConversationAccess(db, 'guest-table', 'table-thread'),
      userId: 'guest-table', senderName: 'Guest', body, photos: [], idempotencyKey,
    })
    // The owner opens the booking and reads its version; then the guest writes in the conversation.
    const read = await readBookedRecord(db, 'org-table', bookingId)
    assert(read)
    const threadBefore = (await getGuestRequest(db, 'table-thread'))!.last_message_at
    await sendGuestMessage('Could we have a window table?', 'guest-midedit-1')
    const thread = await getGuestRequest(db, 'table-thread')
    assert(thread)
    assert.notEqual(thread.last_message_at, threadBefore, 'the guest message moved the conversation')

    // The owner's change, sent with the booking version they read, is the booking's: it goes through.
    assert.deepEqual(await moveBooking(db, env, thread, { userId: 'user-table' }, { kind: 'booking', product_session_id: third.id, party_size: 4, version: read.version }, 'move-later'), { changeStatus: 'moved' })
    const moved = await getThreadOperationalRecord(db, 'table-thread')
    assert.deepEqual({ id: moved?.id, starts_at: moved?.starts_at, party_size: moved?.party_size, location_id: moved?.location_id, product_id: moved?.product_id },
      { id: bookingId, starts_at: third.starts_at, party_size: 4, location_id: 'loc-old-town', product_id: oldTown.id })

    // Again for a proposal: the guest writes, and the proposal made from the version the owner read still goes to the guest.
    const beforeProposal = await readBookedRecord(db, 'org-table', bookingId)
    assert(beforeProposal)
    await sendGuestMessage('Thank you!', 'guest-midedit-2')
    assert.deepEqual(await requestBookingChange(db, env, (await getGuestRequest(db, 'table-thread'))!, 'user-table', { kind: 'booking', product_session_id: first.id, party_size: 4, version: beforeProposal.version }, 'propose-earlier'),
      { changeStatus: 'awaiting_guest_acceptance' })
    assert.equal((await getThreadOperationalRecord(db, 'table-thread'))?.starts_at, third.starts_at, 'a proposal leaves the booking where it is until the guest accepts')

    // The booking itself changed after the owner read it: that change, and only that, refuses theirs.
    await assert.rejects(moveBooking(db, env, (await getGuestRequest(db, 'table-thread'))!, { userId: 'user-table' }, { kind: 'booking', product_session_id: first.id, party_size: 4, version: read.version }, 'move-stale'),
      { statusCode: 409, message: 'The booking changed. Reload before moving it.' })
    await assert.rejects(requestBookingChange(db, env, (await getGuestRequest(db, 'table-thread'))!, 'user-table', { kind: 'booking', product_session_id: first.id, party_size: 4, version: read.version }, 'propose-stale'),
      { statusCode: 409, message: 'The booking changed. Reload before sending a request.' })
    assert.equal((await readBookedRecord(db, 'org-table', bookingId))?.starts_at, third.starts_at, 'a refused change moved nothing')
  } finally { await runtime.dispose() }
})

test('financial notification replay records each send once on the event it is about', { timeout: 120_000 }, async () => {
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
    await applySchema(db)
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

    const eventKey = 'financial-proof:capture'
    const payment = { kind: 'payment_captured' as const, organizationName: 'Merchant', amount: 10000, currency: 'USD' as const, productTitle: 'Class' }
    const input = { organizationId: 'merchant', eventKey, entity: { type: 'payment', id: 'payment-proof' }, ownerMessage: ownerPaymentMessage({ ...payment, action: { url: 'https://proof.example/dashboard/merchant/earnings', label: 'View details' } }),
      guest: { email: 'buyer@proof.example', message: guestPaymentMessage(payment) } }
    await notifyFinancialNotification(env, db, input)
    // A payment no conversation holds is recorded once, on the organization's audit log, and every send is that row's.
    const audit = (key: string) => db.prepare("SELECT id, organization_id, event_name FROM activity_entries WHERE dedupe_key = ?").bind(`alert:${key}:owner`).all().then(result => result.results)
    const rows = await audit(eventKey)
    assert.deepEqual(rows.map(row => ({ ...row, id: undefined })), [{ id: undefined, organization_id: 'merchant', event_name: 'owner.alerted' }])
    const merchant = rows[0]!
    assert.equal(await db.prepare('SELECT count(*) n FROM conversations').first('n'), 0, 'a financial notification does not manufacture a guest conversation')
    const receipts = (await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results
    assert.equal(receipts.length, 3)
    assert.equal(new Set(receipts.map(row => row.id)).size, 3, 'eligible merchant recipients and the buyer have distinct delivery claims')
    assert.deepEqual(receipts.map(row => ({ activity_entry_id: row.activity_entry_id, message_id: row.message_id, purpose: row.purpose, channel: row.channel, provider: row.provider, status: row.status })).sort((a, b) => a.purpose.localeCompare(b.purpose)),
      [
        { activity_entry_id: merchant.id, message_id: null, purpose: 'owner_alert', channel: 'email', provider: 'log_only', status: 'sent' },
        { activity_entry_id: merchant.id, message_id: null, purpose: 'owner_alert', channel: 'email', provider: 'log_only', status: 'sent' },
        { activity_entry_id: merchant.id, message_id: null, purpose: 'status_update', channel: 'email', provider: 'log_only', status: 'sent' },
      ])
    for (const receipt of receipts) {
      assert.ok(String(receipt.id).length <= 256, 'the durable financial key fits Resend\'s documented idempotency limit')
      assert.match(String(receipt.provider_message_id), /^log-only:email:/u)
    }
    await Promise.all([notifyFinancialNotification(env, db, input), notifyFinancialNotification(env, db, input)])
    assert.deepEqual((await db.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()).results, receipts, 'replays do not claim or send settled receipts again')
    assert.deepEqual(await audit(eventKey), rows)

    const differentlyCasedEvent = 'financial-proof:Capture'
    await notifyFinancialNotification(env, db, { ...input, eventKey: differentlyCasedEvent })
    const cased = await audit(differentlyCasedEvent)
    assert.equal(cased.length, 1)
    assert.notEqual(cased[0]!.id, merchant.id)
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries WHERE activity_entry_id = ?').bind(cased[0]!.id).first('n'), 3, 'case-sensitive event identities retain their own recipient receipts')
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries').first('n'), 6)
    // An event about no organization has nowhere to record its sends, and says so rather than sending unrecorded.
    await assert.rejects(notifyFinancialNotification(env, db, { ...input, organizationId: null, ownerMessage: undefined, eventKey: 'financial-proof:orphan' }),
      (error: AggregateError) => /has neither a conversation message nor an organization event/.test(String((error.cause as Error | undefined)?.message ?? error.errors?.[0]?.message)))
  } finally { await runtime.dispose() }
})
