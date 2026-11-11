import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { linkGuestIdentitiesByVerifiedEmail } from '../../server/utils/guest-accounts.ts'
import { appendMessage } from '../../server/domain/conversations.ts'

const NOW = '2026-10-06T00:00:00.000Z'

test('a verified account gathers the guest identities that used only its email, and nothing else', { timeout: 120000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: { name: 'guest-accounts-proof', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare("INSERT INTO organization(id,name,slug,subdomain,status, default_currency, timezone) VALUES('pottery','Pottery','pottery','pottery','active', 'USD', 'UTC'),('kikuzuki','Kikuzuki','kikuzuki','kikuzuki','active', 'USD', 'UTC')").run()
    const users: Array<[string, string, number, number]> = [
      ['jane', 'Jane@Example.com', 1, 0], ['unverified', 'sam@example.com', 0, 0],
      ['guest-pottery', 'anon-1@customers.krabiclaw.local', 0, 1], ['guest-kikuzuki', 'anon-2@customers.krabiclaw.local', 0, 1],
      ['guest-shared', 'anon-3@customers.krabiclaw.local', 0, 1], ['guest-sam', 'anon-4@customers.krabiclaw.local', 0, 1],
    ]
    for (const [id, email, verified, anonymous] of users) await db.prepare('INSERT INTO user(id,name,email,"emailVerified","isAnonymous") VALUES(?,?,?,?,?)').bind(id, id, email, verified, anonymous).run()
    const request = (id: string, organization: string, user: string, email: string, kind = 'booking') => db.prepare(`INSERT INTO conversations(id,kind,organization_id,user_id,payload_json,last_message_at,created_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(id, kind, organization, user, JSON.stringify({ guest: { name: 'Jane', email, phone: null } }), NOW, NOW).run()
    await request('pottery-booking', 'pottery', 'guest-pottery', 'jane@example.com')
    await request('pottery-question', 'pottery', 'guest-pottery', 'JANE@example.com', 'contact')
    await request('kikuzuki-booking', 'kikuzuki', 'guest-kikuzuki', 'jane@example.com')
    // One browser booked for Jane and for someone else: whose it is cannot be told from the inbox.
    await request('shared-jane', 'pottery', 'guest-shared', 'jane@example.com')
    await request('shared-alex', 'pottery', 'guest-shared', 'alex@example.com')
    await request('sam-booking', 'kikuzuki', 'guest-sam', 'sam@example.com')
    // What the guest identity wrote, and how far it read, is the account's after the link.
    const written = await appendMessage(db as never, { conversationId: 'pottery-question', authorKind: 'guest', authorUserId: 'guest-pottery', channel: 'web', body: 'Hello' })
    await appendMessage(db as never, { conversationId: 'pottery-question', authorKind: 'member', authorUserId: null, body: 'Hi Jane' })
    await db.prepare("INSERT INTO user_notification_preferences(user_id,category,email_enabled,whatsapp_enabled,push_enabled,updated_at) VALUES('guest-pottery','product_news',0,1,1,?)").bind(NOW).run()

    await linkGuestIdentitiesByVerifiedEmail(db as never, { id: 'unverified', email: 'sam@example.com', emailVerified: false, isAnonymous: false })
    await linkGuestIdentitiesByVerifiedEmail(db as never, { id: 'jane', email: 'Jane@Example.com', emailVerified: true, isAnonymous: false })

    const owners = Object.fromEntries((await db.prepare('SELECT id, user_id FROM conversations ORDER BY id').all<{ id: string; user_id: string }>()).results.map(row => [row.id, row.user_id]))
    assert.deepEqual(owners, {
      'kikuzuki-booking': 'jane', 'pottery-booking': 'jane', 'pottery-question': 'jane',
      'sam-booking': 'guest-sam', 'shared-alex': 'guest-shared', 'shared-jane': 'guest-shared',
    })
    assert.equal(await db.prepare('SELECT author_user_id FROM messages WHERE id = ?').bind(written.id).first('author_user_id'), 'jane')
    assert.deepEqual(await db.prepare("SELECT user_id, last_read_message_id FROM conversation_participants WHERE conversation_id = 'pottery-question'").all().then(result => result.results), [{ user_id: 'jane', last_read_message_id: written.id }])
    // The guest identity's opt-out is Jane's now too.
    assert.deepEqual(await db.prepare("SELECT user_id, email_enabled FROM user_notification_preferences WHERE category='product_news'").all().then(result => result.results), [{ user_id: 'jane', email_enabled: 0 }])

    // A second sign-in finds nothing left to move.
    await linkGuestIdentitiesByVerifiedEmail(db as never, { id: 'jane', email: 'jane@example.com', emailVerified: true, isAnonymous: false })
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id='jane'").first<{ n: number }>())!.n, 3)
  } finally {
    await runtime.dispose()
  }
})
