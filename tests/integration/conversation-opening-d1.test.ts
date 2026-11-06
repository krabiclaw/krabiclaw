import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { backfillOpeningMessages, openingSentence } from '../../server/domain/guest-threads/opening.ts'
import { getInboxThread } from '../../server/domain/guest-threads/inbox.ts'
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
        ...requestInsertQueries({ id, kind: 'reservation', organization_id: ORG, location_id: 'loc', user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload, created_at: CREATED, updated_at: CREATED }, undefined, opening),
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

    // Created before: it opened empty; the backfill writes the same messages once, first in the conversation.
    await reservation('old', null)
    assert.deepEqual(await messages('old'), [])
    await db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, event_name, body, payload_json, dedupe_key, sequence, occurred_at, created_at)
      VALUES ('review', 'old', 'operation', 'request', 'system', 'review.requested', 'Review invitation sent', '{}', 'review-old', 2, '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z')`).run()
    assert.deepEqual(await backfillOpeningMessages(db, ORG), { written: 1, skipped: 0 })
    const stream = (await getInboxThread(db, 'old', ORG, viewer, new Date('2026-11-05T00:00:00.000Z')))!.stream
    assert.deepEqual(stream.filter(item => item.type !== 'day').map(item => item.type === 'message' ? item.body : item.type === 'event' ? item.text : item.type), [sentence, 'Review invitation sent'])
    assert.deepEqual(await backfillOpeningMessages(db, ORG), { written: 0, skipped: 0 })
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE request_id = 'old' AND event_name = 'thread.opening'").first('count(*)'), 1)
  } finally {
    await runtime.dispose()
  }
})
