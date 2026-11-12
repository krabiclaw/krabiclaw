import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { appendMessage, markConversationRead, markConversationUnread } from '../../server/domain/conversations.ts'
import { countUnreadAsGuest, countUnreadConversations, listConversations, unreadBadge } from '../../server/domain/guest-threads/repository.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// Unread is one statement (conversations.ts unreadSql): a message from someone
// else newer than the person's read position. Every surface reads it: the list
// rows, the Unread filter, the filter counts and the app badge, for a guest's
// conversation and the team's alike.

const ORG = 'org', OWNER = 'owner', CLEANER = 'cleaner', GUEST = 'guest'
const NOW = '2026-11-01T00:00:00.000Z'

test('unread is a message from someone else after your read position, the same count everywhere, for guest and team conversations alike', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'conversation-unread-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.batch([
      `INSERT INTO organization (id,name,slug,default_currency,timezone) VALUES ('${ORG}','Proof','proof','USD','UTC')`,
      ...[[OWNER, 'Owner'], [CLEANER, 'Cleaner'], [GUEST, 'Guest']].map(([id, name]) => `INSERT INTO user (id,name,email,emailVerified) VALUES ('${id}','${name}','${id}@proof.example',1)`),
      `INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m-owner','${ORG}','${OWNER}','owner',0), ('m-cleaner','${ORG}','${CLEANER}','member',0)`,
      `INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('loc','${ORG}','loc','Studio','UTC')`,
      `INSERT INTO products (kind,id,organization_id,name,slug,created_by,updated_by) VALUES ('experience','class','${ORG}','Class','class','${OWNER}','${OWNER}')`,
      `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('seat','${ORG}','class','Seat','${OWNER}','${OWNER}')`,
      `INSERT INTO product_booking_configs (product_id,organization_id,unit,duration_minutes,default_capacity,scheduling_mode,assigned_member_id,created_by,updated_by) VALUES ('class','${ORG}','slot',60,4,'business','m-owner','${OWNER}','${OWNER}')`,
      `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES ('session','${ORG}','class','loc','UTC','2099-01-01T10:00:00.000Z','2099-01-01T11:00:00.000Z',4,'scheduled','${OWNER}','${OWNER}')`,
      `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,location_id,starts_at,ends_at,timezone,user_id,party_size,policy_json,status,created_at,updated_at)
        SELECT 'booking','${ORG}','class',id,'seat',location_id,starts_at,ends_at,timezone,'${GUEST}',1,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed','${NOW}','${NOW}' FROM product_sessions WHERE id = 'session'`,
    ].map(statement => db.prepare(statement)))
    const env = await runtime.getBindings<CloudflareEnv>()
    const owner = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const cleaner = memberAccessPrincipal({ userId: CLEANER, organizationId: ORG, role: 'member' }, { env })

    /** Every surface's reading of one person's unread state, which must agree. */
    const surfaces = async (principal: typeof owner) => {
      const rows = await listConversations(db, ORG, { userId: principal.userId, principal, mailbox: 'current' })
      const filtered = await listConversations(db, ORG, { userId: principal.userId, principal, mailbox: 'current', unreadOnly: true })
      const counts = await countUnreadConversations(db, ORG, { userId: principal.userId, principal })
      const badge = await unreadBadge(env, db, principal.userId)
      const unread = rows.filter(row => row.unread).map(row => row.id)
      assert.deepEqual(filtered.map(row => row.id), unread, 'the Unread filter is the rows marked unread')
      assert.equal(counts.all, unread.length, 'the filter counts are the rows marked unread')
      assert.equal(counts.guests + counts.support + counts.team, counts.all)
      assert.equal(badge, counts.all, 'the app badge is the same count')
      return unread.sort()
    }

    // A booking's opening message is KrabiClaw's, written as the guest booked: unread to the business until opened, never to the guest.
    await db.batch(requestInsertQueries({ id: 'booking-conversation', kind: 'booking', organization_id: ORG, location_id: 'loc', booking_id: 'booking', user_id: GUEST,
      payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@proof.example' }), created_at: NOW }, undefined, { opening: 'Class for 1 on Jan 1', note: null })
      .map(write => db.prepare(write.query).bind(...write.params)))
    const opening = (await db.prepare("SELECT id FROM messages WHERE conversation_id = 'booking-conversation' AND event_name = 'thread.opening'").first<string>('id'))!
    assert.deepEqual(await surfaces(owner), ['booking-conversation'])
    assert.equal(await countUnreadAsGuest(db, GUEST), 0, 'the guest booked it: its opening is theirs')
    // Opening it reads it through the newest message shown.
    await markConversationRead(db, { organizationId: ORG, conversationId: 'booking-conversation', userId: OWNER, throughMessageId: opening })
    assert.deepEqual(await surfaces(owner), [])

    // KrabiClaw's messages count as unread: an event in the conversation (here a payment) is unread to the business and the guest.
    await appendMessage(db, { conversationId: 'booking-conversation', authorKind: 'krabiclaw', authorUserId: null, eventName: 'payment.payment_captured', body: 'Payment received' })
    assert.deepEqual(await surfaces(owner), ['booking-conversation'])
    assert.equal(await countUnreadAsGuest(db, GUEST), 1)
    // A business reply is the guest's to read; the member who wrote it has read it.
    await appendMessage(db, { conversationId: 'booking-conversation', authorKind: 'member', authorUserId: OWNER, eventName: 'thread.member_reply', body: 'See you then', channel: 'web' })
    assert.deepEqual(await surfaces(owner), [])
    assert.equal(await countUnreadAsGuest(db, GUEST), 1)

    // Mark unread works anywhere there is a message from someone else: the newest one is unread again.
    await markConversationUnread(db, { organizationId: ORG, conversationId: 'booking-conversation', userId: OWNER })
    assert.deepEqual(await surfaces(owner), ['booking-conversation'])
    await markConversationRead(db, { organizationId: ORG, conversationId: 'booking-conversation', userId: OWNER })
    assert.deepEqual(await surfaces(owner), [])
    // A conversation nobody else wrote in has nothing to mark.
    await db.batch(requestInsertQueries({ id: 'own-contact', kind: 'contact', organization_id: ORG, location_id: null, booking_id: null, user_id: null,
      payload: { guest: { name: 'Walk-in', email: 'walk@proof.example', phone: null }, subject: null, consent_at: null, ip_hash: null, answers: [] }, created_at: NOW })
      .map(write => db.prepare(write.query).bind(...write.params)))
    await assert.rejects(markConversationUnread(db, { organizationId: ORG, conversationId: 'own-contact', userId: OWNER }), { status: 409, data: { code: 'NOTHING_TO_MARK', field: 'conversation_id' } })

    // A team conversation behaves alike: a teammate's message is unread until read, mark unread brings it back, and
    // KrabiClaw's automatic message (a job reminder) is unread too. Who sees it is its participants.
    await db.batch([
      db.prepare(`INSERT INTO conversations (id,organization_id,kind,is_group,participants_key,created_by_user_id,last_message_at,created_at) VALUES ('team','${ORG}','team',0,'owner|cleaner','${OWNER}','${NOW}','${NOW}')`),
      db.prepare(`INSERT INTO conversation_participants (conversation_id,organization_id,user_id) VALUES ('team','${ORG}','${OWNER}'), ('team','${ORG}','${CLEANER}')`),
    ])
    assert.deepEqual([await surfaces(owner), await surfaces(cleaner)], [[], []])
    await appendMessage(db, { conversationId: 'team', authorKind: 'member', authorUserId: CLEANER, body: 'Towels are out' })
    assert.deepEqual([await surfaces(owner), await surfaces(cleaner)], [['team'], []])
    await markConversationRead(db, { organizationId: ORG, conversationId: 'team', userId: OWNER })
    assert.deepEqual(await surfaces(owner), [])
    await markConversationUnread(db, { organizationId: ORG, conversationId: 'team', userId: OWNER })
    assert.deepEqual(await surfaces(owner), ['team'])
    await markConversationRead(db, { organizationId: ORG, conversationId: 'team', userId: OWNER })
    await appendMessage(db, { conversationId: 'team', authorKind: 'krabiclaw', authorUserId: null, body: 'The turnover starts at 11:00' })
    assert.deepEqual([await surfaces(owner), await surfaces(cleaner)], [['team'], ['team']])
    // The guest conversation is the business's, never the cleaner's.
    assert.equal((await listConversations(db, ORG, { userId: CLEANER, principal: cleaner })).some(row => row.kind !== 'team'), false)
  } finally {
    await runtime.dispose()
  }
})
