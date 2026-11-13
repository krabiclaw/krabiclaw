import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { openingSentence } from '../../server/domain/guest-threads/opening.ts'
import { appendMessage, markConversationRead, resolveConversationAccess } from '../../server/domain/conversations.ts'
import { loadConversationPage } from '../../server/domain/conversation-history.ts'
import { acceptConversationGuestInvite, createConversationGuestInvite } from '../../server/domain/conversation-participants.ts'
import { getInboxThread } from '../../server/domain/guest-threads/inbox.ts'
import { countUnreadAsGuest, listConversations } from '../../server/domain/guest-threads/repository.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// inbox-parity.md, Revision 2026-11-06: a table booking's conversation opens
// with real messages, the booking's own sentence then the guest's note,
// written with the record.

const ORG = 'org', OWNER = 'owner'
const CREATED = '2026-11-03T09:00:00.000Z'

test('a table booking opens with its own message and the guest note, written once', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'conversation-opening', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Kikuzuki', 'kikuzuki', 'kikuzuki', '{}', 'tenant-theme-v1', 'THB', 'active', 'active', 'flat', 'restaurant', ?, 'Asia/Bangkok')`).bind(ORG, CREATED).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner Person', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('loc', ?, 'krabi', 'Kikuzuki Krabi', 'active', 'Asia/Bangkok', ?, ?)`).bind(ORG, CREATED, CREATED).run()
    // Kikuzuki Krabi's tables, and the seatings these conversations booked.
    await db.batch([
      `INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('table', 'tables', '${ORG}', 'Krabi tables', 'krabi-tables', '${OWNER}', '${OWNER}')`,
      `INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('tables-v', '${ORG}', 'tables', 'Table', '${OWNER}', '${OWNER}')`,
      `INSERT INTO prices (id, organization_id, product_variant_id, currency, unit_amount, created_by, updated_by) VALUES ('tables-price', '${ORG}', 'tables-v', 'THB', 50000, '${OWNER}', '${OWNER}')`,
      `INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('${ORG}', 'tables', 'loc', '${OWNER}', '${OWNER}')`,
      `INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, payment_basis, assigned_member_id, created_by, updated_by) VALUES ('tables', '${ORG}', 'slot', 120, 20, 'business', 'per_booking', 'm-owner', '${OWNER}', '${OWNER}')`,
      ...[['seating', '2026-11-04T07:00:00.000Z', '2026-11-04T09:00:00.000Z'], ['held-seating', '2026-11-06T11:00:00.000Z', '2026-11-06T13:00:00.000Z']].map(([id, starts, ends]) =>
        `INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, created_by, updated_by) VALUES ('${id}', '${ORG}', 'tables', 'loc', 'Asia/Bangkok', '${starts}', '${ends}', 20, '${OWNER}', '${OWNER}')`),
    ].map(statement => db.prepare(statement)))
    const env = await runtime.getBindings<CloudflareEnv>()
    const principal = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const viewer = { audience: 'member' as const, userId: OWNER, principal }
    const reservation = async (id: string, note: string | null, opening: string, booker: string | null = null) => {
      const payload = threadPayloadForGuest({ name: 'Filip Heurckmans', email: 'filip@example.test', phone: '+32475699444', locale: 'en', ipHash: null })
      await db.batch([
        { query: `INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, policy_json, status, created_at, updated_at,location_id,starts_at,ends_at,timezone,user_id)
            SELECT ?, ?, 'tables', 'seating', 'tables-v', 4, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', 'confirmed', ?, ?,location_id,starts_at,ends_at,timezone,? FROM product_sessions WHERE id = 'seating'`, params: [`res-${id}`, ORG, CREATED, CREATED, booker] },
        ...requestInsertQueries({ id, kind: 'booking', organization_id: ORG, location_id: 'loc', booking_id: `res-${id}`, user_id: booker, payload, created_at: CREATED }, undefined, { opening, note }),
      ].map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    }
    const sentence = openingSentence({ kind: 'booking', vertical: 'restaurant', productKind: 'table', productTitle: 'Krabi tables', guestName: 'Filip Heurckmans', guestPhone: '+32475699444', answers: [], partySize: 4, partySizeIsMinimum: false,
      startsAt: '2026-11-04T07:00:00.000Z', timezone: 'Asia/Bangkok', placeTitle: 'Kikuzuki Krabi' })
    assert.match(sentence, /^Table for 4 on Wed, Nov 4 at 2:00 PM at Kikuzuki Krabi\. Filip Heurckmans, \+32 /)
    const messages = async (id: string) => (await getInboxThread(db, id, ORG, viewer, new Date('2026-11-05T00:00:00.000Z')))!.stream
      .flatMap(item => item.type === 'message' ? [[item.side, item.body]] : [])

    // Created: the booking's own message, then the guest's note, and nothing twice on a replay of the same batch.
    await reservation('new', 'Window seat if possible', sentence)
    assert.deepEqual(await messages('new'), [['guest', sentence], ['guest', 'Window seat if possible']])
    const ledger = async (id: string) => (await db.prepare('SELECT sequence, author_kind, event_name FROM messages WHERE conversation_id = ? ORDER BY sequence').bind(id).all()).results
    const opened = [{ sequence: 1, author_kind: 'krabiclaw', event_name: 'thread.opening' }, { sequence: 2, author_kind: 'guest', event_name: 'thread.guest_note' }]
    assert.deepEqual(await ledger('new'), opened)
    await db.batch(requestInsertQueries({ id: 'new', kind: 'booking', organization_id: ORG, location_id: 'loc', booking_id: 'res-new', user_id: null,
      payload: threadPayloadForGuest({ name: 'Filip Heurckmans', email: 'filip@example.test', phone: '+32475699444', locale: 'en', ipHash: null }), created_at: CREATED }, undefined, { opening: sentence, note: 'Window seat if possible' })
      .slice(1).map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    assert.deepEqual(await ledger('new'), opened)

    // Another conversation, opened the same way, where the guest wrote since: their reply is its preview, and its
    // time orders it ahead of the one whose newest message is its opening note.
    await reservation('old', 'Window seat if possible', sentence)
    await appendMessage(db, { conversationId: 'old', authorKind: 'guest', authorUserId: null, channel: 'email', body: 'Running ten minutes late', occurredAt: '2026-11-04T06:50:00.000Z' })
    const rows = await listConversations(db, ORG, { userId: OWNER, principal, mailbox: 'current' }, new Date('2026-11-05T00:00:00.000Z'))
    assert.deepEqual(rows.map(row => [row.id, row.preview_from, row.preview]), [['old', 'Filip', 'Running ten minutes late'], ['new', 'Filip', 'Window seat if possible']])

    // Accept through the normal write, then read using the request's canonical seat and transcript projection.
    const booker = { id: 'booker', email: 'filip@example.test', name: 'Filip Heurckmans', emailVerified: true }
    const traveler = { id: 'traveler', email: 'traveler@example.test', name: 'Taylor Traveler', emailVerified: true }
    await db.batch([booker, traveler].map(user => db.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, ?, ?, 1, 0, 0)`).bind(user.id, user.name, user.email)))
    await reservation('shared', 'Private booking note', sentence, booker.id)
    const invite = await createConversationGuestInvite(db, principal, { conversationId: 'shared', email: traveler.email })
    const publication = { GUEST_INBOX_HUBS: { idFromName: () => 'hub', get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }) } } as unknown as Parameters<typeof acceptConversationGuestInvite>[1]
    await acceptConversationGuestInvite(db, publication, { token: invite.token, user: traveler })
    const page = async (userId: string, before: number | null = null, limit = 40) => loadConversationPage(db, {
      ...await resolveConversationAccess(db, userId, 'shared'), userId, principal: null,
    }, { before, limit })
    const list = (q?: string) => listConversations(db, null, { userId: traveler.id, buyerAudience: true, q })
    const privateWords = 'Private card receipt'
    const payment = await appendMessage(db, { conversationId: 'shared', authorKind: 'krabiclaw', authorUserId: null, eventName: 'payment.payment_captured', body: privateWords })
    const privatePage = await page(traveler.id)
    assert.deepEqual(privatePage.entries, [])
    assert.deepEqual(privatePage.page.booking_actions, [])
    assert.deepEqual([privatePage.conversation.booking_id, privatePage.conversation.when, privatePage.conversation.activity_path], [null, null, null])
    const [travelerRow] = await list()
    assert.deepEqual([travelerRow?.id, travelerRow?.preview, travelerRow?.when, travelerRow?.unread], ['shared', '', null, false])
    assert.deepEqual(await list('Private booking note'), [])
    assert.deepEqual(await list(privateWords), [])
    assert.equal(await countUnreadAsGuest(db, traveler.id), 0)
    await assert.rejects(markConversationRead(db, { organizationId: ORG, conversationId: 'shared', userId: traveler.id, throughMessageId: payment.id }), { statusCode: 422 })

    const publicMessage = await appendMessage(db, { conversationId: 'shared', authorKind: 'guest', authorUserId: booker.id, channel: 'web', body: 'Meet at the table' })
    assert.equal(await countUnreadAsGuest(db, traveler.id), 1)
    assert.deepEqual(await markConversationRead(db, { organizationId: ORG, conversationId: 'shared', userId: traveler.id }), { read: true, last_read_message_id: publicMessage.id })
    assert.equal(await countUnreadAsGuest(db, traveler.id), 0)
    const travelerMessage = await appendMessage(db, { conversationId: 'shared', authorKind: 'guest', authorUserId: traveler.id, channel: 'web', body: 'I will be there' })
    const latestPayment = await appendMessage(db, { conversationId: 'shared', authorKind: 'krabiclaw', authorUserId: null, eventName: 'payment.payment_captured', body: 'Another private payment' })
    const first = await page(traveler.id, null, 1)
    const shown = first.entries.filter(entry => entry.type === 'message')
    assert.deepEqual(shown.map(entry => [entry.id, entry.author]), [[travelerMessage.id, 'You']])
    assert.equal(first.page.before, travelerMessage.sequence)
    assert.equal(first.page.newest, travelerMessage.sequence)
    const previous = await page(traveler.id, first.page.before, 1)
    assert.deepEqual(previous.entries.filter(entry => entry.type === 'message').map(entry => entry.id), [publicMessage.id])
    assert.equal(previous.page.before, null)
    assert.equal(await countUnreadAsGuest(db, traveler.id), 0)
    assert.deepEqual((await list()).map(row => [row.preview, row.preview_from, row.unread]), [['I will be there', 'You', false]])
    const original = await page(booker.id)
    assert.equal(original.conversation.booking_id, 'res-shared')
    assert.equal(original.page.newest, latestPayment.sequence)
    assert(original.entries.some(entry => entry.type === 'message' && entry.body === sentence))
    assert(original.entries.some(entry => entry.type === 'event' && entry.id === payment.id))
    assert(original.entries.some(entry => entry.type === 'message' && entry.id === travelerMessage.id && entry.author === traveler.name))
  } finally {
    await runtime.dispose()
  }
})
