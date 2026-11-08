import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { backfillOpeningMessages, openingMessageQueries, openingSentence } from '../../server/domain/guest-threads/opening.ts'
import { getInboxThread } from '../../server/domain/guest-threads/inbox.ts'
import { listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// inbox-parity.md, Revision 2026-11-06: a reservation's conversation opens
// with real messages, the reservation's own sentence then the guest's note,
// written with the record; conversations created before that get them once.

const ORG = 'org', OWNER = 'owner'
const CREATED = '2026-11-03T09:00:00.000Z'

test('a reservation opens with its own message and the guest note, written once, and older conversations are backfilled once', { timeout: 120_000 }, async () => {
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
    const env = await runtime.getBindings<CloudflareEnv>()
    const principal = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const viewer = { audience: 'member' as const, userId: OWNER, principal }
    const reservation = async (id: string, notes: string | null, opening?: { body: string }) => {
      const payload = threadPayloadForGuest({ name: 'Filip Heurckmans', email: 'filip@example.test', phone: '+32475699444', locale: 'en', notes, ipHash: null, partySizeIsMinimum: false, answers: [] })
      await db.batch([
        ...requestInsertQueries({ id, kind: 'reservation', organization_id: ORG, location_id: 'loc', user_id: null, review_id: null, payload, created_at: CREATED, updated_at: CREATED }, undefined, opening),
        { query: `INSERT INTO reservations (id, request_id, organization_id, location_id, timezone, starts_at, ends_at, party_size, status, created_at, updated_at)
            VALUES (?, ?, ?, 'loc', 'Asia/Bangkok', '2026-11-04T07:00:00.000Z', '2026-11-04T09:00:00.000Z', 4, 'confirmed', ?, ?)`, params: [`res-${id}`, id, ORG, CREATED, CREATED] },
      ].map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    }
    const sentence = openingSentence({ kind: 'reservation', guestName: 'Filip Heurckmans', guestPhone: '+32475699444', answers: [], partySize: 4, partySizeIsMinimum: false,
      startsAt: '2026-11-04T07:00:00.000Z', timezone: 'Asia/Bangkok', placeTitle: 'Kikuzuki Krabi' })
    assert.match(sentence, /^Table for 4 on Wed, Nov 4 at 2:00 PM at Kikuzuki Krabi\. Filip Heurckmans, \+32 /)
    const messages = async (id: string) => (await getInboxThread(db, id, ORG, viewer, new Date('2026-11-05T00:00:00.000Z')))!.stream
      .flatMap(item => item.type === 'message' ? [[item.side, item.body]] : [])

    // Created now: the reservation's own message, then the guest's note, and nothing twice on a replay of the same batch.
    await reservation('new', 'Window seat if possible', { body: sentence })
    assert.deepEqual(await messages('new'), [['guest', sentence], ['guest', 'Window seat if possible']])

    // Created before: it opened with nothing but its submission, then the business and the guest wrote.
    // The backfill places the opening and the note right after the submission, ahead of everything said since,
    // and the conversation's latest message is still the guest's reply.
    await reservation('old', 'Window seat if possible')
    await db.batch([
      db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, event_name, body, payload_json, dedupe_key, sequence, occurred_at, created_at)
        VALUES ('review', 'old', 'operation', 'request', 'system', 'review.requested', 'Review invitation sent', '{}', 'review-old', 2, '2026-11-03T12:00:00.000Z', '2026-11-03T12:00:00.000Z')`),
      db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, channel, body, payload_json, dedupe_key, sequence, occurred_at, created_at)
        VALUES ('reply', 'old', 'message', 'request', 'guest', 'email', 'Running ten minutes late', '{}', 'reply-old', 3, '2026-11-04T06:50:00.000Z', '2026-11-04T06:50:00.000Z')`),
    ])
    assert.deepEqual(await messages('old'), [['guest', 'Running ten minutes late']])
    assert.deepEqual(await backfillOpeningMessages(db, ORG), { written: 1, skipped: 0 })
    const ledger = async () => (await db.prepare("SELECT sequence, COALESCE(event_name, kind) AS what FROM activity_entries WHERE request_id = 'old' ORDER BY sequence").all()).results
    const placed = [
      { sequence: 1, what: 'submission' }, { sequence: 2, what: 'thread.opening' }, { sequence: 3, what: 'thread.guest_note' },
      { sequence: 4, what: 'review.requested' }, { sequence: 5, what: 'message' },
    ]
    assert.deepEqual(await ledger(), placed)
    const stream = (await getInboxThread(db, 'old', ORG, viewer, new Date('2026-11-05T00:00:00.000Z')))!.stream
    assert.deepEqual(stream.filter(item => item.type !== 'day').map(item => item.type === 'message' ? item.body : item.type === 'event' ? item.text : item.type),
      [sentence, 'Window seat if possible', 'Review invitation sent', 'Running ten minutes late'])
    // A second run writes and moves nothing.
    assert.deepEqual(await backfillOpeningMessages(db, ORG), { written: 0, skipped: 0 })
    assert.deepEqual(await ledger(), placed)
    // In the list (Current: ended, but not quiet for 30 days) the reply is still the preview and its
    // time still orders the conversation ahead of the one whose newest message is its opening.
    const rows = await listGuestThreads(db, ORG, { userId: OWNER, mailbox: 'current' }, new Date('2026-11-05T00:00:00.000Z'))
    assert.deepEqual(rows.map(row => [row.id, row.previewFrom, row.preview]), [['old', 'Filip', 'Running ten minutes late'], ['new', 'Filip', 'Window seat if possible']])

    // The backfill says what the guest asked for when they asked. A table moved since opens with the
    // time and party before its first change, not the record's current ones, "2+" as it was asked.
    await reservation('moved', null)
    await db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      VALUES ('move', 'moved', 'operation', 'request', 'member', 'booking_change.moved', ?, 'move-moved', 2, '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z')`)
      .bind(JSON.stringify({ before: { recordKind: 'reservation', partySize: 2, partySizeIsMinimum: true, startsAt: '2026-11-04T05:00:00.000Z', endsAt: '2026-11-04T07:00:00.000Z', timezone: 'Asia/Bangkok', locationId: 'loc', productId: null, notes: null, guest: { name: 'Filip Heurckmans', phone: '+32475699444' } } })).run()
    // A checkout never captured has no reservation; its hold says what was asked.
    const held = threadPayloadForGuest({ name: 'Ana Ruiz', email: 'ana@example.test', phone: null, locale: 'en', notes: null, ipHash: null, partySizeIsMinimum: false, answers: [] })
    await db.batch([
      ...requestInsertQueries({ id: 'held', kind: 'reservation', organization_id: ORG, location_id: 'loc', user_id: null, review_id: null, payload: held, created_at: CREATED, updated_at: CREATED }),
      { query: `INSERT INTO payments (id, organization_id, buyer_user_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, captured_amount, state, stripe_payment_intent_id, price_snapshot_json, created_at, updated_at)
          VALUES ('held-pay', ?, NULL, 'acct', 0, 'reservation', NULL, 'loc', 'THB', 50000, 0, 'pending', 'pi_held', '{}', ?, ?)`, params: [ORG, CREATED, CREATED] },
      { query: `INSERT INTO payment_checkout_holds (id, organization_id, location_id, timezone, request_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at)
          VALUES ('hold', ?, 'loc', 'Asia/Bangkok', 'held', 'held-pay', 3, 50000, 'THB', '2026-11-06T11:00:00.000Z', '2026-11-06T13:00:00.000Z', 'released', ?, ?)`, params: [ORG, CREATED, CREATED] },
    ].map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    assert.deepEqual(await backfillOpeningMessages(db, ORG), { written: 2, skipped: 0 })
    const opened = async (id: string) => (await db.prepare("SELECT body FROM activity_entries WHERE request_id = ? AND event_name = 'thread.opening'").bind(id).first<{ body: string }>())!.body
    assert.deepEqual([await opened('moved'), await opened('held')], [
      'Table for 2+ on Wed, Nov 4 at 12:00 PM at Kikuzuki Krabi. Filip Heurckmans, +32 475 69 94 44.',
      'Table for 3 on Fri, Nov 6 at 6:00 PM at Kikuzuki Krabi. Ana Ruiz.',
    ])
    // Replaying the writes for a conversation opened without a note, now with one (a run that read it
    // after an edit), writes and moves nothing: the note goes only with the opening this batch wrote.
    const movedLedger = async () => (await db.prepare("SELECT sequence, COALESCE(event_name, kind) AS what FROM activity_entries WHERE request_id = 'moved' ORDER BY sequence").all()).results
    const before = await movedLedger()
    await db.batch(openingMessageQueries({ target: { requestId: 'moved' }, body: 'Replayed', note: 'Added since', guestUserId: null, at: CREATED })
      .map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    assert.deepEqual(await movedLedger(), before)

    // A table moved by a change that did not record whether its party was a minimum cannot say what the guest
    // asked for: the move reset the submission's flag. The backfill refuses rather than open it without the "+".
    await reservation('unrecorded', null)
    await db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      VALUES ('accept', 'unrecorded', 'operation', 'request', 'member', 'booking_change.accepted', ?, 'accept-unrecorded', 2, '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z')`)
      .bind(JSON.stringify({ before: { starts_at: '2026-11-04T05:00:00.000Z', ends_at: '2026-11-04T07:00:00.000Z', party_size: 2 } })).run()
    await assert.rejects(backfillOpeningMessages(db, ORG), /Reservation conversation unrecorded does not record whether the party size it was booked with is a minimum/)
    // Nor one whose first change does not record the time it replaced: the record's time is the changed one.
    await db.prepare("UPDATE activity_entries SET payload_json = ? WHERE id = 'accept'")
      .bind(JSON.stringify({ before: { recordKind: 'reservation', partySize: 2, partySizeIsMinimum: false, timezone: 'Asia/Bangkok', locationId: 'loc', productId: null } })).run()
    await assert.rejects(backfillOpeningMessages(db, ORG), /Conversation unrecorded has a change that does not record the time and party it was booked with/)
    // Nor one whose submission has lost its note field, or whose place no longer exists: neither opens as if absent.
    await db.prepare("UPDATE activity_entries SET payload_json = ? WHERE id = 'accept'")
      .bind(JSON.stringify({ before: { recordKind: 'reservation', startsAt: '2026-11-04T05:00:00.000Z', partySize: 2, partySizeIsMinimum: false, timezone: 'Asia/Bangkok', locationId: 'loc', productId: null } })).run()
    await db.prepare("UPDATE requests SET payload_json = json_remove(payload_json, '$.notes') WHERE id = 'unrecorded'").run()
    await assert.rejects(backfillOpeningMessages(db, ORG), /Conversation unrecorded does not record the guest's note/)
    await db.prepare("UPDATE requests SET payload_json = json_set(payload_json, '$.notes', json('null')) WHERE id = 'unrecorded'").run()
    await db.prepare("UPDATE activity_entries SET payload_json = json_set(payload_json, '$.before.locationId', 'gone') WHERE id = 'accept'").run()
    await assert.rejects(backfillOpeningMessages(db, ORG), /Conversation unrecorded was booked at location gone, which does not exist/)
  } finally {
    await runtime.dispose()
  }
})
