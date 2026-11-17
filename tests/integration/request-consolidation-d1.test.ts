import assert from 'node:assert/strict'
import test from 'node:test'
import { captureEvents } from './support/events.ts'
import { Miniflare } from 'miniflare'
import { threadPayloadForGuest, requestInsertQueries, cancelBookingRequest, getGuestRequest, getThreadOperationalRecord } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { listConversations } from '../../server/domain/guest-threads/repository.ts'
import { appendMessage } from '../../server/domain/conversations.ts'
import { CapacityUnavailableError, claimSessionCapacity } from '../../server/utils/availability.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { applySchema } from './support/schema.ts'

const ORG = 'org-proof'
const LOCATION = 'location-proof'
const ACTOR = 'user-proof'
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
    await applySchema(db)
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
    const env = { ...await runtime.getBindings<CloudflareEnv>(), DB: db, EVENTS: captureEvents().binding } as CloudflareEnv
    const policyJson = JSON.stringify({ advance_notice_minutes: null, party_size_min: null, party_size_max: null, minimum_guest_age: null, accessibility_contact_required: false, payment: null, cancellation: null })
    async function bookSession(id: string, sessionId = 'session-proof', cancellation: { token_hash: string | null; expires_at: string | null; used_at: null } = { token_hash: null, expires_at: null, used_at: null }) {
      return claimSessionCapacity(db, { websiteSource: null, 
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

    const inbox = await listConversations(db, ORG, { userId: ACTOR, locationId: LOCATION, type: 'booking', q: 'guest' })
    assert.deepEqual(inbox.map(item => item.id), [winner])
    assert.deepEqual(await listConversations(db, ORG, { userId: ACTOR, locationId: LOCATION, type: 'booking', q: 'nobody' }), [])

    // Cancelling is idempotent: the same operation key twice writes one message.
    // A booking arrives confirmed and is complete once its end passes, so
    // cancelling is the only transition a person makes.
    await db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind(record!.id).run()
    const operation = { threadId: winner, organizationId: ORG, action: 'cancel', actorUserId: ACTOR, idempotencyKey: 'cancel-proof', env: { ...env, NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } }
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
    // The canceled booking remains a conversation. A cancellation retry cannot
    // write another message or discard a later question.
    const question = await appendMessage(db, { conversationId: tokenThread, authorKind: 'guest', authorUserId: null, channel: 'email', body: 'When will my refund arrive?', occurredAt: at(3) })
    const retry = await cancelBookingRequest(db, { id: tokenThread, organizationId: ORG, kind: 'booking', tokenHash: 'hash', now: at(4), env })
    assert.equal(retry?.changed, false)
    const newest = await db.prepare('SELECT id, body FROM messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1').bind(tokenThread).first()
    assert.deepEqual(newest, { id: question.id, body: question.body })
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE conversation_id=? AND event_name='booking.cancel'").bind(tokenThread).first('count(*)'), 1)
    assert.equal((await listConversations(db, ORG, { userId: ACTOR, unreadOnly: true, conversationIds: [tokenThread] }))[0]?.id, tokenThread)

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
