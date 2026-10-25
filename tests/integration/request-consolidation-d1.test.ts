import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { threadPayloadForGuest, requestInsertQueries, cancelBookingRequest, getGuestRequest, getThreadOperationalRecord } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { getGuestThreadOperationSummary, listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { resolveGuestThreadMailbox } from '../../server/domain/guest-threads/mailbox.ts'
import { claimReservation, requireLocationReservationConfig, upsertLocationReservationConfig } from '../../server/utils/reservations.ts'
import { CapacityUnavailableError, claimSessionCapacity, setBookingStatus } from '../../server/utils/availability.ts'
import { buildCanonicalNotificationInsert } from '../../server/utils/notification-center.ts'
import { acknowledgeNotification, acknowledgeThreadNotifications } from '../../server/utils/notification-acknowledgement.ts'

const ORG = 'org-proof'
const LOCATION = 'location-proof'
const ACTOR = 'user-proof'
const NOW = '2026-09-11T00:00:00.000Z'

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
    async function bookSession(id: string) {
      return claimSessionCapacity(db, {
        organizationId: ORG, productId: 'product-proof', sessionId: 'session-proof',
        productVariantId: 'variant-proof', partySize: 1, userId: null, requestId: null,
        following: bookingId => [
          ...requestInsertQueries({
            id, kind: 'booking', organization_id: ORG, location_id: LOCATION,
            user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
            payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example', phone: '+66812345678' }),
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

    const inbox = await listGuestThreads(db, ORG, { userId: ACTOR, locationId: LOCATION, type: 'booking', search: 'guest@proof.example' })
    assert.deepEqual(inbox.map(item => item.id), [winner])

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
      user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
      payload: {
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

    // A notification is acknowledged only by someone the visibility filter
    // admits, and the acknowledgement is an entry of its own.
    const entryId = await db.prepare("SELECT id FROM activity_entries WHERE request_id=? LIMIT 1").bind(winner).first<string>('id')
    const notification = buildCanonicalNotificationInsert({ scope: 'organization', organizationId: ORG, title: 'Reply', template: 'guest.reply', sourceEntryId: entryId }, 'notification-proof')
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

/**
 * Current and Past, the way Airbnb files them: by when the occurrence ENDS,
 * or by a member's archive. Fixed instants, so the boundary is exact.
 */
test('a thread is Current until its occurrence ends or a member archives it', () => {
  const dinner = { ends_at: '2026-09-11T21:00:00.000Z' } // 19:00–21:00
  const live = { archived_at: null, blocked_at: null }
  const at = (now: string) => resolveGuestThreadMailbox(live, dinner, now)
  assert.equal(at('2026-09-11T18:59:00.000Z').mailbox, 'current', 'before it starts')
  assert.equal(at('2026-09-11T19:01:00.000Z').mailbox, 'current', 'once it has started')
  assert.equal(at('2026-09-11T20:59:00.000Z').mailbox, 'current', 'while it is being served')
  assert.deepEqual(at('2026-09-11T21:01:00.000Z'), {
    mailbox: 'past', manuallyArchived: false, occurrenceEnded: true, canArchive: false, canUnarchive: false,
  }, 'once it has ended')

  // A session is the same clock: its end, not its start.
  const session = { ends_at: '2026-09-12T09:00:00.000Z' }
  assert.equal(resolveGuestThreadMailbox(live, session, '2026-09-12T08:00:00.000Z').mailbox, 'current')
  assert.equal(resolveGuestThreadMailbox(live, session, '2026-09-12T09:00:01.000Z').mailbox, 'past')

  // A blocked guest's thread is Blocked, archived or not, until unblocked; the guest never sees it.
  const blocked = { archived_at: null, blocked_at: '2026-09-11T10:00:00.000Z' }
  assert.deepEqual(resolveGuestThreadMailbox(blocked, dinner, '2026-09-11T18:00:00.000Z'), {
    mailbox: 'blocked', manuallyArchived: false, occurrenceEnded: false, canArchive: false, canUnarchive: false,
  })
  assert.equal(resolveGuestThreadMailbox(blocked, dinner, '2026-09-11T18:00:00.000Z', 'buyer').mailbox, 'current')

  // A direct message has no occurrence and is Current until archived.
  assert.deepEqual(resolveGuestThreadMailbox(live, null, '2126-01-01T00:00:00.000Z'), {
    mailbox: 'current', manuallyArchived: false, occurrenceEnded: false, canArchive: true, canUnarchive: false,
  })
  const archived = { archived_at: '2026-09-11T10:00:00.000Z', blocked_at: null }
  assert.deepEqual(resolveGuestThreadMailbox(archived, null, '2026-09-11T11:00:00.000Z'), {
    mailbox: 'past', manuallyArchived: true, occurrenceEnded: false, canArchive: false, canUnarchive: true,
  })
  // Archived before it ended, then it ended: Past for good.
  assert.deepEqual(resolveGuestThreadMailbox(archived, dinner, '2026-09-11T22:00:00.000Z'), {
    mailbox: 'past', manuallyArchived: true, occurrenceEnded: true, canArchive: false, canUnarchive: false,
  })
})

test('archive and unarchive file a conversation without touching its booking, state or activity order', { timeout: 120_000 }, async () => {
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
    const thread = (id: string, kind: string, updatedAt: string) =>
      `INSERT INTO requests (id,kind,organization_id,location_id,conversation_state,payload_json,created_at,updated_at)
       VALUES ('${id}','${kind}','${ORG}','${LOCATION}','needs_attention','${guest(id, kind === 'contact' ? 'Hello' : undefined)}','${NOW}','${updatedAt}')`
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
      thread('ended-archived', 'reservation', '2026-09-05T00:00:00.000Z'),
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

    const list = async (mailbox: 'current' | 'past') => listGuestThreads(db, ORG, { userId: ACTOR, mailbox })
    const ids = async (mailbox: 'current' | 'past') => (await list(mailbox)).map(row => row.id)
    const row = (id: string) => db.prepare('SELECT archived_at, archived_by_user_id, conversation_state, resolved_at, updated_at FROM requests WHERE id=?').bind(id).first()
    const recordRow = (id: string) => db.prepare('SELECT * FROM reservations WHERE request_id=?').bind(id).first()
    const entries = (id: string, eventName: string) => db.prepare("SELECT count(*) AS n FROM activity_entries WHERE request_id=? AND kind='operation' AND event_name=?").bind(id, eventName).first('n')
    const env = { NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }
    const operate = (threadId: string, action: 'archive' | 'unarchive', idempotencyKey: string, organizationId = ORG) =>
      executeGuestThreadOperation(db, { threadId, organizationId, action, actorUserId: ACTOR, idempotencyKey, env })

    // Ordered by conversation activity, and split by the end of each occurrence.
    assert.deepEqual(await ids('current'), ['newest', 'booking-future', 'ongoing', 'future', 'contact'])
    assert.deepEqual(await ids('past'), ['booking-ended', 'ended-archived', 'ended'])
    const past = new Map((await list('past')).map(item => [item.id, item]))
    assert.deepEqual(
      [past.get('ended'), past.get('ended-archived')].map(item => [item?.mailbox, item?.manuallyArchived, item?.canArchive, item?.canUnarchive]),
      [['past', false, false, false], ['past', true, false, false]],
      'an ended occurrence is Past whether or not it was archived, and cannot be moved back',
    )
    assert.equal((await list('current')).every(item => item.mailbox === 'current' && item.canArchive && !item.canUnarchive), true)
    // The counts beside a mailbox are that mailbox's.
    assert.equal((await getGuestThreadOperationSummary(db, ORG, { userId: ACTOR, mailbox: 'current' })).openThreads, 5)
    assert.equal((await getGuestThreadOperationSummary(db, ORG, { userId: ACTOR, mailbox: 'past' })).openThreads, 3)

    // Archive a future reservation: Past at once, with who and when, and
    // nothing about the reservation, the conversation state or the order moves.
    const before = await row('future')
    const reservationBefore = await recordRow('future')
    const archived = await Promise.all([operate('future', 'archive', 'archive-future'), operate('future', 'archive', 'archive-future')])
    assert.deepEqual(archived.map(outcome => outcome.ok), [true, true])
    const afterArchive = await row('future')
    assert.equal(typeof afterArchive?.archived_at, 'string')
    assert.equal(afterArchive?.archived_by_user_id, ACTOR)
    assert.deepEqual(
      [afterArchive?.conversation_state, afterArchive?.resolved_at, afterArchive?.updated_at],
      [before?.conversation_state, before?.resolved_at, before?.updated_at],
    )
    assert.deepEqual(await recordRow('future'), reservationBefore)
    assert.equal(await entries('future', 'thread.archived'), 1)
    assert.equal((await ids('current')).includes('future'), false)
    assert.deepEqual((await list('past')).find(item => item.id === 'future'), {
      ...(await list('past')).find(item => item.id === 'future'), mailbox: 'past', manuallyArchived: true, canArchive: false, canUnarchive: true,
    })

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
    assert.deepEqual(await ids('current'), ['newest', 'booking-future', 'ongoing', 'future', 'contact'])
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

    // Ended occurrences cannot be moved back, archived or not, and nothing is written.
    const endedBefore = await row('ended-archived')
    const refused = await operate('ended-archived', 'unarchive', 'unarchive-ended')
    assert.deepEqual(refused, { ok: false, status: 409, reason: 'invalid_transition', message: 'This conversation is past because its booking has ended' })
    assert.deepEqual(await row('ended-archived'), endedBefore)
    assert.equal(await entries('ended-archived', 'thread.unarchived'), 0)
    const endedArchive = await operate('ended', 'archive', 'archive-ended')
    assert.equal(endedArchive.ok ? null : endedArchive.status, 409)
    assert.equal((await row('ended'))?.archived_at, null)

    // Another organization cannot reach the thread at all.
    const foreign = await operate('booking-future', 'archive', 'archive-foreign', 'org-foreign')
    assert.deepEqual(foreign, { ok: false, status: 404, reason: 'thread_not_found' })
    assert.equal((await row('booking-future'))?.archived_at, null)

    // Nothing above moved the inbox order.
    assert.deepEqual(await ids('current'), ['newest', 'booking-future', 'ongoing', 'future', 'contact'])
  } finally {
    clearTimeout(deadline)
    await runtime.dispose()
  }
})
