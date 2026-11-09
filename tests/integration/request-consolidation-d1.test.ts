import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { threadPayloadForGuest, requestInsertQueries, cancelBookingRequest, getGuestRequest, getThreadOperationalRecord } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { countUnreadInboxThreads, listGuestThreads, listOrganizationGuestThreads, mailboxTransitionQueries, updateThreadProjectionIfLatestEntry } from '../../server/domain/guest-threads/repository.ts'
import { getInboxThreadDetails } from '../../server/domain/guest-threads/inbox.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { createDeliveryReceipt, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { claimReservation, requireLocationReservationConfig, upsertLocationReservationConfig } from '../../server/utils/reservations.ts'
import { CapacityUnavailableError, claimSessionCapacity, setBookingStatus } from '../../server/utils/availability.ts'
import { buildCanonicalNotificationInsert } from '../../server/utils/notification-center.ts'
import { acknowledgeNotification, acknowledgeThreadNotifications } from '../../server/utils/notification-acknowledgement.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

const ORG = 'org-proof'
const LOCATION = 'location-proof'
const ACTOR = 'user-proof'
const NOW = '2026-09-11T00:00:00.000Z'
/** The owner, as every dashboard and MCP read is scoped: through their membership. */
const OWNER = memberAccessPrincipal({ userId: ACTOR, organizationId: ORG, role: 'owner' }, { env: {} as CloudflareEnv })
/** The read the inbox and MCP share: conversations with an open reply task, the business's reply owed. */
const needsReply = (db: D1Database) => listOrganizationGuestThreads(db, { organizationId: ORG, principal: OWNER, userId: ACTOR, needsReply: true })

/**
 * A thread carries the conversation; a booking or reservation holds the seats.
 *
 * These are the invariants of that split: the two rows commit together, the
 * seat-holding row is the only place a status lives, and a guest's
 * cancellation token can be spent exactly once no matter how many times it is
 * presented.
 */
test('a thread and the record it refers to commit and cancel as one', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'request-consolidation-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const deadline = setTimeout(() => { void runtime.dispose() }, 110_000)
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.batch([
      `INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('${ORG}','Proof','proof', 'USD', 'UTC')`,
      `INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES ('proof-en','${ORG}','en',1,'published')`,
      `INSERT INTO user (id,name,email) VALUES ('${ACTOR}','Proof','owner@proof.example')`,
      `INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('${LOCATION}','${ORG}','proof','Proof','Asia/Bangkok')`,
      `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('experience', 'product-proof','${ORG}','Pottery Class','pottery-class','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('variant-proof','${ORG}','product-proof','Standard','${ACTOR}','${ACTOR}')`,
      // The branch offers it: a session at a location takes seats only while
      // that location is still selling the product.
      `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${ORG}','product-proof','${LOCATION}',1,1,'${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_booking_configs (product_id,organization_id,duration_minutes,default_capacity,created_by,updated_by) VALUES ('product-proof','${ORG}',120,1,'${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
        VALUES ('session-proof','${ORG}','product-proof','${LOCATION}','Asia/Bangkok','2099-01-05T07:00:00.000Z','2099-01-05T09:00:00.000Z',1,'scheduled','${ACTOR}','${ACTOR}')`,
    ].map(statement => db.prepare(statement)))

    // One seat, two guests: the claim carries its own capacity predicate, and
    // the thread is written only where that claim landed. Exactly as the public
    // booking route writes it — claim first, thread conditional on it, then the
    // booking takes the thread's id.
    const env = { ...await runtime.getBindings<CloudflareEnv>(), DB: db } as CloudflareEnv
    async function bookSession(id: string) {
      return claimSessionCapacity(db, {
        env, organizationId: ORG, productId: 'product-proof', sessionId: 'session-proof',
        productVariantId: 'variant-proof', partySize: 1, userId: null, requestId: null,
        following: bookingId => [
          ...requestInsertQueries({
            id, kind: 'booking', organization_id: ORG, location_id: LOCATION,
            user_id: null, review_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example', phone: '+66812345678' }),
            created_at: NOW, updated_at: NOW,
          }, { query: 'SELECT 1 FROM bookings WHERE id = ?', params: [bookingId] }),
          {
            query: 'UPDATE bookings SET request_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM requests WHERE id = ?)',
            params: [id, NOW, bookingId, id],
          },
        ],
      }).then(() => true, error => { if (error instanceof CapacityUnavailableError) return false; throw error })
    }
    const claims = await Promise.all([bookSession('booking-first'), bookSession('booking-second')])
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(await db.prepare('SELECT count(*) FROM bookings').first('count(*)'), 1)
    // Nothing to clean up after the guest who lost the seat: the thread and its
    // opening entry are conditional on the claim, so neither was written.
    assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 1)
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE kind='submission'").first('count(*)'), 1)

    const winner = await db.prepare('SELECT request_id FROM bookings').first<string>('request_id')
    assert.ok(winner)
    // The thread holds no copy of when or for how many; the booking does.
    const record = await getThreadOperationalRecord(db, winner)
    assert.equal(record?.kind, 'booking')
    assert.equal(record?.party_size, 1)
    assert.equal(record?.starts_at, '2099-01-05T07:00:00.000Z')

    const inbox = await listGuestThreads(db, ORG, { userId: ACTOR, locationId: LOCATION, type: 'booking', q: 'guest' })
    assert.deepEqual(inbox.map(item => item.id), [winner])
    assert.deepEqual(await listGuestThreads(db, ORG, { userId: ACTOR, locationId: LOCATION, type: 'booking', q: 'nobody' }), [])

    // Cancelling is idempotent: the same operation key twice writes one entry.
    // A booking arrives confirmed and is complete once its end passes, so
    // cancelling is the only transition a person makes.
    await setBookingStatus(db, { organizationId: ORG, bookingId: record!.id, status: 'confirmed' })
    const operation = { threadId: winner, organizationId: ORG, action: 'cancel', actorUserId: ACTOR, idempotencyKey: 'cancel-proof', env: { NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } }
    assert.equal((await executeGuestThreadOperation(db, operation)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, operation)).ok, true)
    assert.equal(await db.prepare("SELECT status FROM bookings WHERE request_id=?").bind(winner).first('status'), 'cancelled')
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE request_id=? AND kind='operation'").bind(winner).first('count(*)'), 1)

    // A reservation is the other half of the same split: a location policy is
    // what opens reservations, and the claim commits the thread with the row.
    await assert.rejects(requireLocationReservationConfig(db, { organizationId: ORG, locationId: LOCATION }), { statusCode: 404, data: { code: 'RESERVATION_POLICY_NOT_FOUND' } })
    const policy = await upsertLocationReservationConfig(db, { organizationId: ORG, locationId: LOCATION, patch: { slot_capacity: 1 }, actorId: ACTOR })
    assert.deepEqual(await db.prepare('SELECT duration_minutes,slot_capacity FROM location_reservation_configs WHERE location_id=?').bind(LOCATION).first(), { duration_minutes: 120, slot_capacity: 1 }, 'ordinary table reservations retain their two-hour default')
    await upsertLocationReservationConfig(db, { organizationId: ORG, locationId: LOCATION, patch: { slot_capacity: 1, duration_minutes: 120 }, actorId: ACTOR, expectedUpdatedAt: policy.updated_at })
    const reservationThread = 'reservation-proof'
    await db.batch(requestInsertQueries({
      id: reservationThread, kind: 'reservation', organization_id: ORG, location_id: LOCATION,
      user_id: null, review_id: null, payload: {
        ...threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example', phone: '+66812345678' }),
        cancellation: { token_hash: 'hash', expires_at: '2099-01-01T00:00:00.000Z', used_at: null },
      },
      created_at: NOW, updated_at: NOW,
    }).map(write => db.prepare(write.query).bind(...write.params)))
    const reserved = await claimReservation(db, {
      organizationId: ORG, locationId: LOCATION, reservationId: 'reservation-row-proof',
      timezone: 'Asia/Bangkok', startsAt: '2099-01-06T09:00:00.000Z', endsAt: '2099-01-06T11:00:00.000Z',
      date: '2099-01-06', timeSlot: '16:00',
      partySize: 1, userId: null, requestId: reservationThread,
    }).then(() => true, () => false)
    assert.equal(reserved, true)
    // The location seats one party per slot, so the second claim is refused
    // rather than silently overbooking the same start instant.
    const secondClaim = await claimReservation(db, {
      organizationId: ORG, locationId: LOCATION, reservationId: 'reservation-row-second',
      timezone: 'Asia/Bangkok', startsAt: '2099-01-06T09:00:00.000Z', endsAt: '2099-01-06T11:00:00.000Z',
      date: '2099-01-06', timeSlot: '16:00',
      partySize: 1, userId: null, requestId: null,
    }).then(() => true, () => false)
    assert.equal(secondClaim, false)
    assert.equal(await db.prepare('SELECT count(*) FROM reservations').first('count(*)'), 1)
    await appendEntry(db, { threadId: reservationThread, kind: 'message', actorKind: 'guest', channel: 'email', body: 'Could we sit outside?', occurredAt: '2097-12-31T00:00:00.000Z' })

    // The token is spendable exactly once, however many times it is presented.
    const cancellations = await Promise.all([1, 2].map(() => cancelBookingRequest(db, {
      id: reservationThread, organizationId: ORG, kind: 'reservation', tokenHash: 'hash', now: '2098-01-01T00:00:00.000Z',
    })))
    // Both authorized retries observe success; only one spends the capability
    // and changes the record. This also lets failed notification delivery retry.
    assert.equal(cancellations.filter(value => value?.changed).length, 1)
    assert.equal(cancellations.filter(value => value && !value.changed).length, 1)
    assert.equal(await db.prepare('SELECT status FROM reservations WHERE request_id=?').bind(reservationThread).first('status'), 'cancelled')
    const cancelledThread = await getGuestRequest(db, reservationThread)
    assert.equal(cancelledThread?.payload.cancellation.used_at, '2098-01-01T00:00:00.000Z')
    // The cancellation answers the question asked before it: no reply is owed.
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [])
    assert.equal((await listOrganizationGuestThreads(db, { organizationId: ORG, principal: OWNER, userId: ACTOR })).find(thread => thread.id === reservationThread)?.operationalStatus, 'cancelled')

    const guestReply = await appendEntry(db, { threadId: reservationThread, kind: 'message', actorKind: 'guest', channel: 'email', body: 'When will my refund arrive?', occurredAt: '2098-01-02T00:00:00.000Z' })
    await updateThreadProjectionIfLatestEntry(db, reservationThread, guestReply.id)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [reservationThread])
    const retry = await cancelBookingRequest(db, { id: reservationThread, organizationId: ORG, kind: 'reservation', tokenHash: 'hash', now: '2098-01-03T00:00:00.000Z' })
    assert.equal(retry?.changed, false)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [reservationThread], 'a replayed cancellation does not answer a question asked after it')
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE request_id=? AND event_name='reservation.cancel'").bind(reservationThread).first('count(*)'), 1)

    // A saved reply that failed to send does not answer the guest, even
    // though it is now the last message in the ledger.
    const failedReply = await appendEntry(db, { threadId: reservationThread, kind: 'message', actorKind: 'member', actorUserId: ACTOR, channel: 'email', eventName: 'thread.member_reply', body: 'Your refund is on its way.', occurredAt: '2098-01-04T00:00:00.000Z' })
    const receipt = await createDeliveryReceipt(db, { entryId: failedReply.id, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'cancelled-reply-delivery' })
    await recordDeliveryOutcome(db, { deliveryId: receipt.id, status: 'failed', error: 'Delivery refused' })
    const stillNeedsReply = await needsReply(db)
    assert.deepEqual(stillNeedsReply.map(thread => thread.id), [reservationThread])
    assert.equal(stillNeedsReply[0]?.latestMessageFromGuest, false)
    await recordDeliveryOutcome(db, { deliveryId: receipt.id, status: 'sent', providerMessageId: 'delivered-cancelled-reply' })
    // The reply operation projects its entry once its delivery is recorded.
    await updateThreadProjectionIfLatestEntry(db, reservationThread, failedReply.id)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [])
    const nextQuestion = await appendEntry(db, { threadId: reservationThread, kind: 'message', actorKind: 'guest', channel: 'email', body: 'Thank you. Can you send the receipt?', occurredAt: '2098-01-05T00:00:00.000Z' })
    await updateThreadProjectionIfLatestEntry(db, reservationThread, nextQuestion.id)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [reservationThread])
    const webReply = await appendEntry(db, { threadId: reservationThread, kind: 'message', actorKind: 'member', actorUserId: ACTOR, channel: 'web', eventName: 'thread.member_reply', body: 'Here is your receipt.', occurredAt: '2098-01-06T00:00:00.000Z' })
    await updateThreadProjectionIfLatestEntry(db, reservationThread, webReply.id)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [], 'a committed web reply needs no external delivery receipt')

    // A notification is acknowledged only by someone the visibility filter
    // admits, and the acknowledgement is an entry of its own.
    const entryId = await db.prepare("SELECT id FROM activity_entries WHERE request_id=? LIMIT 1").bind(winner).first<string>('id')
    const notification = buildCanonicalNotificationInsert({ scope: 'organization', organizationId: ORG, title: 'Reply', template: 'submission_reply_email', sourceEntryId: entryId }, 'notification-proof')
    await db.prepare(notification.query).bind(...notification.params).run()
    const visibility = { userId: ACTOR, whereSql: 'n.organization_id = ?', whereParams: [ORG] }
    assert.deepEqual(await acknowledgeNotification(db, visibility, notification.id), { newlyRead: true })
    assert.equal(await acknowledgeNotification(db, { ...visibility, whereParams: ['another-org'] }, notification.id), null)
    // Reading it again reads nothing new, so nothing announces a read.
    assert.deepEqual(await acknowledgeNotification(db, visibility, notification.id), { newlyRead: false })
    assert.equal(await acknowledgeThreadNotifications(db, visibility, winner), 0)
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE kind='acknowledgement' AND parent_id=? AND actor_user_id=?").bind(notification.id, ACTOR).first('count(*)'), 1)

    // An audit entry belongs to the organization it describes and goes with it.
    await db.batch([
      "INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('org-other','Other','other', 'USD', 'UTC')",
      `INSERT INTO activity_entries (id,kind,scope_kind,organization_id,actor_kind,event_name,payload_json,dedupe_key,occurred_at) VALUES ('audit-proof','audit','organization','org-other','system','organization.changed','{}','audit-proof','2026-09-01T00:00:00.000Z')`,
    ].map(statement => db.prepare(statement)))
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE id='audit-proof'").first('count(*)'), 1)
    await db.prepare("DELETE FROM organization WHERE id='org-other'").run()
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE id='audit-proof'").first('count(*)'), 0)
  } finally {
    clearTimeout(deadline)
    await runtime.dispose()
  }
})

test('archive and unarchive file a conversation without touching its booking, state or activity order', { timeout: 120_000 }, async (t) => {
  // Contacts go Past after 30 quiet days, so the clock is fixed at NOW, ten days after the oldest one.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) })
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'guest-thread-mailbox-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const deadline = setTimeout(() => { void runtime.dispose() }, 110_000)
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))

    // Far past and far future, so "now" is unambiguous for every row whenever
    // this runs. The ongoing reservation started long ago and ends long after.
    const ENDED = ['2000-01-01T19:00:00.000Z', '2000-01-01T21:00:00.000Z']
    const FUTURE = ['2099-01-01T19:00:00.000Z', '2099-01-01T21:00:00.000Z']
    const ONGOING = ['2000-01-01T19:00:00.000Z', '2099-01-01T21:00:00.000Z']
    const guest = (name: string, message?: string) => JSON.stringify({
      guest: { name, email: `${name.toLowerCase()}@proof.example`, phone: '+66812345678' },
      ...(message
        ? { subject: null, message, consent_at: null, ip_hash: null }
        : { party_size_is_minimum: false, notes: null, ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }),
    })
    // A conversation's activity is its last message, or its opening when nobody has written since.
    const thread = (id: string, kind: string, openedAt: string) =>
      `INSERT INTO requests (id,kind,organization_id,location_id,payload_json,created_at,updated_at)
       VALUES ('${id}','${kind}','${ORG}','${LOCATION}','${guest(id, kind === 'contact' ? 'Hello' : undefined)}','${openedAt}','${openedAt}')`
    const reservation = (id: string, [startsAt, endsAt]: string[]) =>
      `INSERT INTO reservations (id,organization_id,location_id,request_id,timezone,starts_at,ends_at,party_size,created_at,updated_at)
       VALUES ('row-${id}','${ORG}','${LOCATION}','${id}','Asia/Bangkok','${startsAt}','${endsAt}',2,'${NOW}','${NOW}')`
    const session = (id: string, [startsAt, endsAt]: string[]) =>
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
       VALUES ('${id}','${ORG}','product-proof','${LOCATION}','Asia/Bangkok','${startsAt}','${endsAt}',4,'scheduled','${ACTOR}','${ACTOR}')`
    const booking = (id: string, sessionId: string) =>
      `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,request_id,party_size,created_at,updated_at)
       VALUES ('row-${id}','${ORG}','product-proof','${sessionId}','variant-proof','${id}',1,'${NOW}','${NOW}')`
    await db.batch([
      `INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('${ORG}','Proof','proof', 'USD', 'UTC'), ('org-foreign','Foreign','foreign', 'USD', 'UTC')`,
      `INSERT INTO user (id,name,email) VALUES ('${ACTOR}','Proof','owner@proof.example')`,
      `INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('member-proof','${ORG}','${ACTOR}','owner',0)`,
      `INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('${LOCATION}','${ORG}','proof','Proof','Asia/Bangkok')`,
      `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('experience', 'product-proof','${ORG}','Pottery Class','pottery-class','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('variant-proof','${ORG}','product-proof','Standard','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${ORG}','product-proof','${LOCATION}',1,1,'${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_booking_configs (product_id,organization_id,duration_minutes,default_capacity,created_by,updated_by) VALUES ('product-proof','${ORG}',120,4,'${ACTOR}','${ACTOR}')`,
      session('session-ended', ENDED),
      session('session-future', FUTURE),
      thread('contact', 'contact', '2026-09-01T00:00:00.000Z'),
      thread('future', 'reservation', '2026-09-02T00:00:00.000Z'),
      thread('ongoing', 'reservation', '2026-09-03T00:00:00.000Z'),
      thread('ended', 'reservation', '2026-09-04T00:00:00.000Z'),
      // Quiet for over 30 days: its last activity and its end are both behind NOW by more than that.
      thread('ended-archived', 'reservation', '2026-08-05T00:00:00.000Z'),
      thread('booking-future', 'booking', '2026-09-06T00:00:00.000Z'),
      thread('booking-ended', 'booking', '2026-09-07T00:00:00.000Z'),
      // The newest real activity in the inbox, which filing others must not overtake.
      thread('newest', 'contact', '2026-09-10T00:00:00.000Z'),
      reservation('future', FUTURE),
      reservation('ongoing', ONGOING),
      reservation('ended', ENDED),
      reservation('ended-archived', ENDED),
      booking('booking-future', 'session-future'),
      booking('booking-ended', 'session-ended'),
      // Archived while it was still to come; it has since ended.
      `UPDATE requests SET archived_at='1999-12-31T00:00:00.000Z', archived_by_user_id='${ACTOR}' WHERE id='ended-archived'`,
    ].map(statement => db.prepare(statement)))

    const ids = async (mailbox: 'current' | 'past', unreadOnly = false) => (await listGuestThreads(db, ORG, { userId: ACTOR, mailbox, unreadOnly })).map(row => row.id)
    // What the conversation's sheet offers: Archive, or Move to messages.
    const filing = async (id: string) => {
      const details = await getInboxThreadDetails(db, id, ORG, { audience: 'member', userId: ACTOR, principal: OWNER })
      assert.ok(details, id)
      return { archive: details.actions.archive, unarchive: details.actions.unarchive }
    }
    const row = (id: string) => db.prepare('SELECT archived_at, archived_by_user_id, updated_at FROM requests WHERE id=?').bind(id).first()
    const recordRow = (id: string) => db.prepare('SELECT * FROM reservations WHERE request_id=?').bind(id).first()
    const entries = (id: string, eventName: string) => db.prepare("SELECT count(*) AS n FROM activity_entries WHERE request_id=? AND kind='operation' AND event_name=?").bind(id, eventName).first('n')
    const env = { NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    const operate = (threadId: string, action: 'archive' | 'unarchive', idempotencyKey: string, organizationId = ORG) =>
      executeGuestThreadOperation(db, { threadId, organizationId, action, actorUserId: ACTOR, idempotencyKey, env })

    // Ordered by conversation activity. An ended visit with recent activity stays Current, as Airbnb keeps an ended, read trip;
    // only a conversation quiet for 30 days is Past by the rule.
    assert.deepEqual(await ids('current'), ['newest', 'booking-ended', 'booking-future', 'ended', 'ongoing', 'future', 'contact'])
    assert.deepEqual(await ids('past'), ['ended-archived'])
    assert.deepEqual(
      [await filing('ended-archived'), typeof (await row('ended-archived'))?.archived_at],
      [{ archive: false, unarchive: false }, 'string'],
      'a conversation quiet for 30 days is Past whether or not it was archived, and cannot be moved back',
    )
    for (const id of await ids('current')) assert.deepEqual(await filing(id), { archive: true, unarchive: false }, id)
    // A guest who writes about a dinner that has ended brings it back to Current, unread and counted; the counts are Current's only.
    // Each message is written at its conversation's own activity time.
    for (const [id, at] of [['future', '2026-09-02T00:00:00.000Z'], ['ended', '2026-09-04T00:00:00.000Z']] as const) {
      const message = await appendEntry(db, { threadId: id, kind: 'message', actorKind: 'guest', channel: 'email', body: 'Is parking nearby?', occurredAt: at })
      const alert = buildCanonicalNotificationInsert({ scope: 'organization', organizationId: ORG, title: 'Message', template: 'submission_reply_email', sourceEntryId: message.id }, `alert-${id}`)
      await db.prepare(alert.query).bind(...alert.params).run()
    }
    const CURRENT = ['newest', 'booking-ended', 'booking-future', 'ended', 'ongoing', 'future', 'contact']
    assert.deepEqual(await ids('current'), CURRENT)
    assert.deepEqual([await ids('current', true), await ids('past', true)], [['ended', 'future'], []])
    assert.deepEqual(await countUnreadInboxThreads(db, ORG, { userId: ACTOR }), { all: 2, guests: 2, support: 0 })

    // Archive a future reservation: Past at once, with who and when, and
    // nothing about the reservation, the conversation state or the order moves.
    const before = await row('future')
    const reservationBefore = await recordRow('future')
    const archived = await Promise.all([operate('future', 'archive', 'archive-future'), operate('future', 'archive', 'archive-future')])
    assert.deepEqual(archived.map(outcome => outcome.ok), [true, true])
    const afterArchive = await row('future')
    assert.equal(typeof afterArchive?.archived_at, 'string')
    assert.equal(afterArchive?.archived_by_user_id, ACTOR)
    assert.equal(afterArchive?.updated_at, before?.updated_at)
    assert.deepEqual(await recordRow('future'), reservationBefore)
    assert.equal(await entries('future', 'thread.archived'), 1)
    assert.equal((await ids('current')).includes('future'), false)
    assert.equal((await ids('past')).includes('future'), true)
    assert.deepEqual(await filing('future'), { archive: false, unarchive: true })
    assert.deepEqual(await countUnreadInboxThreads(db, ORG, { userId: ACTOR }), { all: 1, guests: 1, support: 0 }, 'an archived conversation leaves the Current count')

    // The same key again later changes nothing: not the time, not the actor, not the ledger.
    assert.equal((await operate('future', 'archive', 'archive-future')).ok, true)
    assert.deepEqual(await row('future'), afterArchive)
    assert.equal(await entries('future', 'thread.archived'), 1)
    // A key belongs to one request.
    const reused = await operate('future', 'unarchive', 'archive-future')
    assert.equal(reused.ok ? null : reused.status, 409)
    // Archiving what is already archived is refused, and writes nothing.
    const again = await operate('future', 'archive', 'archive-future-again')
    assert.equal(again.ok ? null : again.status, 409)
    assert.equal(await entries('future', 'thread.archived'), 1)

    // Move to messages, twice with one key: one entry, back in Current, in its
    // original place behind the conversation with newer activity.
    const moved = await Promise.all([operate('future', 'unarchive', 'unarchive-future'), operate('future', 'unarchive', 'unarchive-future')])
    assert.deepEqual(moved.map(outcome => outcome.ok), [true, true])
    assert.equal(await entries('future', 'thread.unarchived'), 1)
    assert.deepEqual(await row('future'), { ...before, archived_at: null, archived_by_user_id: null })
    assert.deepEqual(await recordRow('future'), reservationBefore)
    assert.deepEqual(await ids('current'), CURRENT)
    assert.deepEqual(await filing('future'), { archive: true, unarchive: false })
    assert.deepEqual(await countUnreadInboxThreads(db, ORG, { userId: ACTOR }), { all: 2, guests: 2, support: 0 })
    assert.equal((await operate('future', 'unarchive', 'unarchive-future')).ok, true)
    assert.equal(await entries('future', 'thread.unarchived'), 1)

    // Ongoing: being served, still archivable, and movable back before it ends.
    assert.equal((await operate('ongoing', 'archive', 'archive-ongoing')).ok, true)
    assert.equal((await ids('past')).includes('ongoing'), true)
    assert.equal((await operate('ongoing', 'unarchive', 'unarchive-ongoing')).ok, true)
    assert.equal((await ids('current')).includes('ongoing'), true)

    // A direct message: Current until archived, Past after, Current again.
    assert.equal((await operate('contact', 'archive', 'archive-contact')).ok, true)
    assert.equal((await ids('past')).includes('contact'), true)
    assert.equal((await operate('contact', 'unarchive', 'unarchive-contact')).ok, true)
    assert.equal((await ids('current')).includes('contact'), true)

    // A conversation the rule files in Past cannot be moved back, and nothing is written.
    const endedBefore = await row('ended-archived')
    const refused = await operate('ended-archived', 'unarchive', 'unarchive-ended')
    assert.deepEqual(refused, { ok: false, status: 409, reason: 'invalid_transition', message: 'This conversation is past because it has been quiet for 30 days' })
    assert.deepEqual(await row('ended-archived'), endedBefore)
    assert.equal(await entries('ended-archived', 'thread.unarchived'), 0)
    // The write itself refuses too, for a move whose check passed before the rule filed the thread in Past.
    const raced = await db.batch(mailboxTransitionQueries({ transition: 'unarchive', threadId: 'ended-archived', organizationId: ORG, actorUserId: ACTOR, entryId: 'raced', dedupeKey: 'raced-unarchive', now: NOW })
      .map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    assert.deepEqual(raced.map(result => result.meta.changes), [0, 0])
    assert.deepEqual(await row('ended-archived'), endedBefore)
    // One the guest wrote about after it ended is Current: it can be archived and moved back like any other.
    assert.equal((await operate('ended', 'archive', 'archive-ended')).ok, true)
    assert.deepEqual([(await ids('past')).includes('ended'), await filing('ended')], [true, { archive: false, unarchive: true }])
    assert.equal((await operate('ended', 'unarchive', 'unarchive-ended-current')).ok, true)
    assert.equal((await row('ended'))?.archived_at, null)

    // Another organization cannot reach the thread at all.
    const foreign = await operate('booking-future', 'archive', 'archive-foreign', 'org-foreign')
    assert.deepEqual(foreign, { ok: false, status: 404, reason: 'thread_not_found' })
    assert.equal((await row('booking-future'))?.archived_at, null)

    // Nothing above moved the inbox order.
    assert.deepEqual(await ids('current'), CURRENT)
  } finally {
    clearTimeout(deadline)
    await runtime.dispose()
  }
})
