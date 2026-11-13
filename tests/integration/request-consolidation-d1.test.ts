import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { threadPayloadForGuest, requestInsertQueries, cancelBookingRequest, getGuestRequest, getThreadOperationalRecord } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { archiveConversation, countUnreadConversations, listConversations, reconcileConversationTasks } from '../../server/domain/guest-threads/repository.ts'
import { getInboxThreadDetails } from '../../server/domain/guest-threads/inbox.ts'
import { appendMessage, markConversationRead, markConversationUnread } from '../../server/domain/conversations.ts'
import { createDeliveryReceipt, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { CapacityUnavailableError, claimSessionCapacity } from '../../server/utils/availability.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

const ORG = 'org-proof'
const LOCATION = 'location-proof'
const ACTOR = 'user-proof'
const NOW = '2026-09-11T00:00:00.000Z'
/** The owner, as every dashboard and MCP read is scoped: through their membership. */
const OWNER = memberAccessPrincipal({ userId: ACTOR, organizationId: ORG, role: 'owner' }, { env: {} as CloudflareEnv })
/** The read the inbox and MCP share: conversations with an open reply task, the business's reply owed. */
const needsReply = (db: D1Database) => listConversations(db, ORG, { principal: OWNER, userId: ACTOR, needsReply: true })
/** A guest's message, and the reply work it makes, as the inbound writers record it. */
const guestWrites = async (db: D1Database, conversationId: string, body: string, occurredAt: string) => {
  const message = await appendMessage(db, { conversationId, authorKind: 'guest', authorUserId: null, channel: 'email', body, occurredAt })
  await reconcileConversationTasks(db, conversationId)
  return message
}

/**
 * A thread carries the conversation; a booking holds the seats.
 *
 * These are the invariants of that split: the two rows commit together, the
 * seat-holding row is the only place a status lives, and a guest's
 * cancellation token can be spent exactly once no matter how many times it is
 * presented.
 */
test('a thread and the record it refers to commit and cancel as one', { timeout: 120_000 }, async () => {
  const start = Date.now()
  const at = (day: number, hour = 0) => new Date(start + (day * 24 + hour) * 3_600_000).toISOString()
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
      `INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('member-proof','${ORG}','${ACTOR}','owner',1)`,
      `INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('${LOCATION}','${ORG}','proof','Proof','Asia/Bangkok')`,
      `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('experience', 'product-proof','${ORG}','Pottery Class','pottery-class','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('variant-proof','${ORG}','product-proof','Standard','${ACTOR}','${ACTOR}')`,
      // The branch offers it: a session at a location takes seats only while
      // that location is still selling the product.
      `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${ORG}','product-proof','${LOCATION}',1,1,'${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_booking_configs (product_id,organization_id,unit,duration_minutes,default_capacity,scheduling_mode,created_by,updated_by) VALUES ('product-proof','${ORG}','slot',120,1,'business','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
        VALUES ('session-proof','${ORG}','product-proof','${LOCATION}','Asia/Bangkok','${at(8, 7)}','${at(8, 9)}',1,'scheduled','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
        VALUES ('session-token','${ORG}','product-proof','${LOCATION}','Asia/Bangkok','${at(9, 9)}','${at(9, 11)}',1,'scheduled','${ACTOR}','${ACTOR}')`,
    ].map(statement => db.prepare(statement)))

    // One seat, two guests: the claim carries its own capacity predicate, and
    // the thread is written only where that claim landed. Exactly as the public
    // booking route writes it — claim first, thread conditional on it, then the
    // booking takes the thread's id.
    const env = { ...await runtime.getBindings<CloudflareEnv>(), DB: db } as CloudflareEnv
    const policyJson = JSON.stringify({ advance_notice_minutes: null, party_size_min: null, party_size_max: null, minimum_guest_age: null, accessibility_contact_required: false, payment: null, cancellation: null })
    async function bookSession(id: string, sessionId = 'session-proof', cancellation: { token_hash: string | null; expires_at: string | null; used_at: null } = { token_hash: null, expires_at: null, used_at: null }) {
      return claimSessionCapacity(db, {
        env, organizationId: ORG, productId: 'product-proof', sessionId,
        productVariantId: 'variant-proof', partySize: 1, userId: null, policyJson,
        following: bookingId => requestInsertQueries({
          id, kind: 'booking', organization_id: ORG, location_id: LOCATION, booking_id: bookingId,
          user_id: null, payload: { ...threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example', phone: '+66812345678' }), cancellation },
          created_at: at(0),
        }, { query: 'SELECT 1 FROM bookings WHERE id = ?', params: [bookingId] }, { opening: 'Pottery Class for 1', note: null }),
      }).then(() => true, error => { if (error instanceof CapacityUnavailableError) return false; throw error })
    }
    const claims = await Promise.all([bookSession('booking-first'), bookSession('booking-second')])
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(await db.prepare('SELECT count(*) FROM bookings').first('count(*)'), 1)
    // Nothing to clean up after the guest who lost the seat: the conversation and
    // its opening message are conditional on the claim, so neither was written.
    assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 1)
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE event_name='thread.opening'").first('count(*)'), 1)

    const winner = await db.prepare('SELECT c.id FROM conversations c JOIN bookings b ON b.id = c.booking_id').first<string>('id')
    assert.ok(winner)
    assert.deepEqual((await db.prepare('SELECT conversation_id, user_id, role FROM conversation_participants').all()).results,
      [{ conversation_id: winner, user_id: ACTOR, role: 'member' }])
    // The thread holds no copy of when or for how many; the booking does.
    const record = await getThreadOperationalRecord(db, winner)
    assert.equal(record?.unit, 'slot')
    assert.equal(record?.party_size, 1)
    assert.equal(record?.starts_at, at(8, 7))

    const inbox = await listConversations(db, ORG, { userId: ACTOR, principal: OWNER, locationId: LOCATION, type: 'booking', q: 'guest' })
    assert.deepEqual(inbox.map(item => item.id), [winner])
    assert.deepEqual(await listConversations(db, ORG, { userId: ACTOR, principal: OWNER, locationId: LOCATION, type: 'booking', q: 'nobody' }), [])

    // Cancelling is idempotent: the same operation key twice writes one message.
    // A booking arrives confirmed and is complete once its end passes, so
    // cancelling is the only transition a person makes.
    await db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind(record!.id).run()
    const operation = { threadId: winner, organizationId: ORG, action: 'cancel', actorUserId: ACTOR, idempotencyKey: 'cancel-proof', env: { NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } }
    assert.equal((await executeGuestThreadOperation(db, operation)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, operation)).ok, true)
    const bookingStatus = (conversationId: string) => db.prepare('SELECT b.status FROM bookings b JOIN conversations c ON c.booking_id = b.id WHERE c.id = ?').bind(conversationId).first('status')
    assert.equal(await bookingStatus(winner), 'cancelled')
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE conversation_id=? AND event_name='booking.cancel'").bind(winner).first('count(*)'), 1)

    // A booking the guest holds an emailed cancellation token for: its seat and
    // its thread commit together, and the seat it holds is the session's last.
    const tokenThread = 'token-proof'
    assert.equal(await bookSession(tokenThread, 'session-token', { token_hash: 'hash', expires_at: at(7), used_at: null }), true)
    assert.equal(await bookSession('token-second', 'session-token'), false)
    assert.equal(await db.prepare("SELECT count(*) FROM bookings WHERE product_session_id='session-token'").first('count(*)'), 1)
    await guestWrites(db, tokenThread, 'Could we sit outside?', at(1))

    // The token is spendable exactly once, however many times it is presented.
    const cancellations = await Promise.all([1, 2].map(() => cancelBookingRequest(db, {
      id: tokenThread, organizationId: ORG, kind: 'booking', tokenHash: 'hash', now: at(2), env,
    })))
    // Both authorized retries observe success; only one spends the capability
    // and changes the record. This also lets failed notification delivery retry.
    assert.equal(cancellations.filter(value => value?.changed).length, 1)
    assert.equal(cancellations.filter(value => value && !value.changed).length, 1)
    assert.equal(await bookingStatus(tokenThread), 'cancelled')
    // The guest's cancellation is one message in the conversation, however the owners are told about it.
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE conversation_id=? AND event_name='booking.cancel'").bind(tokenThread).first('count(*)'), 1)
    const cancelledThread = await getGuestRequest(db, tokenThread)
    assert.equal(cancelledThread?.payload.cancellation.used_at, at(2))
    // The cancellation answers the question asked before it: no reply is owed.
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [])

    await guestWrites(db, tokenThread, 'When will my refund arrive?', at(3))
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [tokenThread])
    const retry = await cancelBookingRequest(db, { id: tokenThread, organizationId: ORG, kind: 'booking', tokenHash: 'hash', now: at(4), env })
    assert.equal(retry?.changed, false)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [tokenThread], 'a replayed cancellation does not answer a question asked after it')
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE conversation_id=? AND event_name='booking.cancel'").bind(tokenThread).first('count(*)'), 1)

    // A saved reply that failed to send does not answer the guest, even
    // though it is now the last message in the ledger.
    const failedReply = await appendMessage(db, { conversationId: tokenThread, authorKind: 'member', authorUserId: ACTOR, channel: 'email', eventName: 'thread.member_reply', body: 'Your refund is on its way.', occurredAt: at(5) })
    const receipt = await createDeliveryReceipt(db, { subject: { messageId: failedReply.id }, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'cancelled-reply-delivery' })
    await recordDeliveryOutcome(db, { deliveryId: receipt.id, status: 'failed', error: 'Delivery refused' })
    await reconcileConversationTasks(db, tokenThread)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [tokenThread])
    await recordDeliveryOutcome(db, { deliveryId: receipt.id, status: 'sent', providerMessageId: 'delivered-cancelled-reply' })
    await reconcileConversationTasks(db, tokenThread)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [])
    await guestWrites(db, tokenThread, 'Thank you. Can you send the receipt?', at(6))
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [tokenThread])
    await appendMessage(db, { conversationId: tokenThread, authorKind: 'member', authorUserId: ACTOR, channel: 'web', eventName: 'thread.member_reply', body: 'Here is your receipt.', occurredAt: at(7) })
    await reconcileConversationTasks(db, tokenThread)
    assert.deepEqual((await needsReply(db)).map(thread => thread.id), [], 'a committed web reply needs no external delivery receipt')

    // An audit entry belongs to the organization it describes and goes with it.
    await db.batch([
      "INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('org-other','Other','other', 'USD', 'UTC')",
      `INSERT INTO activity_entries (id,organization_id,actor_kind,event_name,payload_json,dedupe_key,occurred_at) VALUES ('audit-proof','org-other','system','organization.changed','{}','audit-proof','2026-09-01T00:00:00.000Z')`,
    ].map(statement => db.prepare(statement)))
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE id='audit-proof'").first('count(*)'), 1)
    await db.prepare("DELETE FROM organization WHERE id='org-other'").run()
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE id='audit-proof'").first('count(*)'), 0)
  } finally {
    clearTimeout(deadline)
    await runtime.dispose()
  }
})

test('archive and unarchive file a conversation for one person without touching its booking, state or activity order', { timeout: 120_000 }, async (t) => {
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
    // this runs. The ongoing booking started long ago and ends long after.
    const ENDED = ['2000-01-01T19:00:00.000Z', '2000-01-01T21:00:00.000Z']
    const FUTURE = ['2099-01-01T19:00:00.000Z', '2099-01-01T21:00:00.000Z']
    const ONGOING = ['2000-01-01T19:30:00.000Z', '2099-01-01T21:00:00.000Z']
    const guest = (name: string, contact: boolean) => JSON.stringify({
      guest: { name, email: `${name.toLowerCase()}@proof.example`, phone: '+66812345678' },
      ...(contact
        ? { subject: null, consent_at: null, ip_hash: null }
        : { ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }),
    })
    // A conversation's activity is its last message, or its opening when nobody has written since.
    const thread = (id: string, kind: string, openedAt: string) =>
      `INSERT INTO conversations (id,kind,organization_id,location_id,booking_id,payload_json,last_message_at,created_at)
       VALUES ('${id}','${kind}','${ORG}','${LOCATION}',${kind === 'booking' ? `'row-${id}'` : 'NULL'},'${guest(id, kind === 'contact')}','${openedAt}','${openedAt}')`
    const session = (id: string, [startsAt, endsAt]: string[]) =>
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
       VALUES ('${id}','${ORG}','product-proof','${LOCATION}','Asia/Bangkok','${startsAt}','${endsAt}',4,'scheduled','${ACTOR}','${ACTOR}')`
    const booking = (id: string, sessionId: string, partySize = 1) =>
      `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,location_id,starts_at,ends_at,timezone,party_size,policy_json,created_at,updated_at)
       SELECT 'row-${id}','${ORG}','product-proof',id,'variant-proof',location_id,starts_at,ends_at,timezone,${partySize},'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','${NOW}','${NOW}'
         FROM product_sessions WHERE id = '${sessionId}'`
    await db.batch([
      `INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('${ORG}','Proof','proof', 'USD', 'UTC'), ('org-foreign','Foreign','foreign', 'USD', 'UTC')`,
      `INSERT INTO user (id,name,email) VALUES ('${ACTOR}','Proof','owner@proof.example')`,
      `INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('member-proof','${ORG}','${ACTOR}','owner',1)`,
      `INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('${LOCATION}','${ORG}','proof','Proof','Asia/Bangkok')`,
      `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('experience', 'product-proof','${ORG}','Pottery Class','pottery-class','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('variant-proof','${ORG}','product-proof','Standard','${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${ORG}','product-proof','${LOCATION}',1,1,'${ACTOR}','${ACTOR}')`,
      `INSERT INTO product_booking_configs (product_id,organization_id,unit,duration_minutes,default_capacity,scheduling_mode,created_by,updated_by) VALUES ('product-proof','${ORG}','slot',120,4,'business','${ACTOR}','${ACTOR}')`,
      session('session-ended', ENDED),
      session('session-future', FUTURE),
      session('session-ongoing', ONGOING),
      booking('future', 'session-future', 2),
      booking('ongoing', 'session-ongoing', 2),
      booking('ended', 'session-ended', 2),
      booking('ended-archived', 'session-ended', 2),
      booking('booking-future', 'session-future'),
      booking('booking-ended', 'session-ended'),
      thread('contact', 'contact', '2026-09-01T00:00:00.000Z'),
      thread('future', 'booking', '2026-09-02T00:00:00.000Z'),
      thread('ongoing', 'booking', '2026-09-03T00:00:00.000Z'),
      thread('ended', 'booking', '2026-09-04T00:00:00.000Z'),
      // Quiet for over 30 days: its last activity and its end are both behind NOW by more than that.
      thread('ended-archived', 'booking', '2026-08-05T00:00:00.000Z'),
      thread('booking-future', 'booking', '2026-09-06T00:00:00.000Z'),
      thread('booking-ended', 'booking', '2026-09-07T00:00:00.000Z'),
      // The newest real activity in the inbox, which filing others must not overtake.
      thread('newest', 'contact', '2026-09-10T00:00:00.000Z'),
      // The owner holds a seat in each fixture conversation and archived one while it was still to come.
      `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, archived_at)
        SELECT id, organization_id, '${ACTOR}', 'member', CASE WHEN id = 'ended-archived' THEN '1999-12-31T00:00:00.000Z' END FROM conversations`,
    ].map(statement => db.prepare(statement)))

    const ids = async (mailbox: 'current' | 'past', unreadOnly = false) => (await listConversations(db, ORG, { userId: ACTOR, principal: OWNER, mailbox, unreadOnly })).map(row => row.id)
    // What the conversation's sheet offers: Archive, or Move to messages.
    const filing = async (id: string) => {
      const details = await getInboxThreadDetails(db, id, ORG, { audience: 'member', userId: ACTOR, principal: OWNER })
      assert.ok(details, id)
      return { archive: details.actions.archive, unarchive: details.actions.unarchive }
    }
    const archivedAt = async (id: string) => (await db.prepare('SELECT archived_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').bind(id, ACTOR).first<{ archived_at: string | null }>())?.archived_at ?? null
    const activity = (id: string) => db.prepare('SELECT last_message_at FROM conversations WHERE id = ?').bind(id).first('last_message_at')
    const recordRow = (id: string) => db.prepare('SELECT * FROM bookings WHERE id = ?').bind(`row-${id}`).first()
    const counts = () => countUnreadConversations(db, ORG, { userId: ACTOR, principal: OWNER })
    const file = (conversationId: string, archived: boolean, organizationId = ORG) => archiveConversation(db, { organizationId, conversationId, userId: ACTOR, archived })

    // Ordered by conversation activity. An ended visit with recent activity stays Current, as Airbnb keeps an ended, read trip;
    // only a conversation quiet for 30 days is Past by the rule.
    const CURRENT = ['newest', 'booking-ended', 'booking-future', 'ended', 'ongoing', 'future', 'contact']
    assert.deepEqual(await ids('current'), CURRENT)
    assert.deepEqual(await ids('past'), ['ended-archived'])
    assert.deepEqual(await filing('ended-archived'), { archive: false, unarchive: false }, 'a conversation quiet for 30 days is Past whether or not it was archived, and cannot be moved back')
    for (const id of CURRENT) assert.deepEqual(await filing(id), { archive: true, unarchive: false }, id)
    // A guest who writes about a dinner that has ended brings it back to Current, unread and counted; the counts are Current's only.
    // Each message is written at its conversation's own activity time.
    for (const [id, at] of [['future', '2026-09-02T00:00:00.000Z'], ['ended', '2026-09-04T00:00:00.000Z']] as const) {
      await appendMessage(db, { conversationId: id, authorKind: 'guest', authorUserId: null, channel: 'email', body: 'Is parking nearby?', occurredAt: at })
    }
    assert.deepEqual(await ids('current'), CURRENT)
    assert.deepEqual([await ids('current', true), await ids('past', true)], [['ended', 'future'], []])
    assert.deepEqual(await counts(), { all: 2, guests: 2, support: 0, team: 0 })

    // Marked read and unread from the list, without opening it: the list and its counts read the same state back.
    await markConversationRead(db, { organizationId: ORG, conversationId: 'ended', userId: ACTOR })
    assert.deepEqual([await ids('current', true), await counts()], [['future'], { all: 1, guests: 1, support: 0, team: 0 }])
    await markConversationUnread(db, { organizationId: ORG, conversationId: 'ended', userId: ACTOR })
    assert.deepEqual([await ids('current', true), await counts()], [['ended', 'future'], { all: 2, guests: 2, support: 0, team: 0 }])
    // Unread twice is still one unread conversation; one nobody else wrote in cannot be marked either way.
    await markConversationUnread(db, { organizationId: ORG, conversationId: 'ended', userId: ACTOR })
    assert.deepEqual(await ids('current', true), ['ended', 'future'])
    await assert.rejects(markConversationUnread(db, { organizationId: ORG, conversationId: 'contact', userId: ACTOR }), { status: 409, data: { code: 'NOTHING_TO_MARK', field: 'conversation_id' } })
    await assert.rejects(markConversationRead(db, { organizationId: ORG, conversationId: 'contact', userId: ACTOR }), { status: 409, data: { code: 'NOTHING_TO_MARK', field: 'conversation_id' } })
    assert.deepEqual(await ids('current', true), ['ended', 'future'])

    // Archive a future booking, for the owner alone: Past at once, and nothing
    // about the booking, the conversation's activity or the order moves.
    const before = await activity('future')
    const bookingBefore = await recordRow('future')
    assert.deepEqual(await Promise.all([file('future', true), file('future', true)]), [{ archived: true }, { archived: true }])
    assert.equal(typeof await archivedAt('future'), 'string')
    assert.equal(await activity('future'), before)
    assert.deepEqual(await recordRow('future'), bookingBefore)
    assert.equal((await ids('current')).includes('future'), false)
    assert.equal((await ids('past')).includes('future'), true)
    assert.deepEqual(await filing('future'), { archive: false, unarchive: true })
    assert.deepEqual(await counts(), { all: 1, guests: 1, support: 0, team: 0 }, 'an archived conversation leaves the Current count')

    // Move to messages: back in Current, in its original place behind the conversation with newer activity.
    assert.deepEqual(await Promise.all([file('future', false), file('future', false)]), [{ archived: false }, { archived: false }])
    assert.equal(await archivedAt('future'), null)
    assert.equal(await activity('future'), before)
    assert.deepEqual(await recordRow('future'), bookingBefore)
    assert.deepEqual(await ids('current'), CURRENT)
    assert.deepEqual(await filing('future'), { archive: true, unarchive: false })
    assert.deepEqual(await counts(), { all: 2, guests: 2, support: 0, team: 0 })

    // Ongoing: being served, still archivable, and movable back before it ends.
    await file('ongoing', true)
    assert.equal((await ids('past')).includes('ongoing'), true)
    await file('ongoing', false)
    assert.equal((await ids('current')).includes('ongoing'), true)

    // A direct message: Current until archived, Past after, Current again.
    await file('contact', true)
    assert.equal((await ids('past')).includes('contact'), true)
    await file('contact', false)
    assert.equal((await ids('current')).includes('contact'), true)

    // A conversation the rule files in Past cannot be moved back, and nothing is written.
    const endedBefore = await archivedAt('ended-archived')
    await assert.rejects(file('ended-archived', false), { status: 409, message: 'This conversation is past because it has been quiet for 30 days', data: { code: 'INVALID_TRANSITION', field: 'archived' } })
    assert.equal(await archivedAt('ended-archived'), endedBefore)
    // One the guest wrote about after it ended is Current: it can be archived and moved back like any other,
    // and a new message from the guest brings an archived conversation back by itself.
    await file('ended', true)
    assert.deepEqual([(await ids('past')).includes('ended'), await filing('ended')], [true, { archive: false, unarchive: true }])
    await appendMessage(db, { conversationId: 'ended', authorKind: 'guest', authorUserId: null, channel: 'email', body: 'One more thing', occurredAt: '2026-09-04T00:00:00.000Z' })
    assert.equal(await archivedAt('ended'), null)
    assert.equal((await ids('current')).includes('ended'), true)

    // Another organization cannot reach the conversation at all.
    await assert.rejects(file('booking-future', true, 'org-foreign'), { status: 404, data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
    assert.equal(await archivedAt('booking-future'), null)

    // Nothing above moved the inbox order.
    assert.deepEqual(await ids('current'), CURRENT)
  } finally {
    clearTimeout(deadline)
    await runtime.dispose()
  }
})
