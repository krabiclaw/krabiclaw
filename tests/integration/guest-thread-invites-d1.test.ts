import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, type StayAccess } from '../../server/domain/stays.ts'
import { claimGuestThreadInvite, createGuestThreadInvite, describeGuestThreadInvite, GUEST_INVITE_LIFETIME_MS } from '../../server/domain/guest-threads/invites.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { anonymousLinkQueries } from '../../server/utils/guest-accounts.ts'
import { inviteLinkTokenHash } from '../../server/utils/invite-links.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A phone-only guest is reached by the link their host shares: whoever opens it
// and signs in takes the conversation, by the link and never by a contact
// match, and the host's replies reach their account inbox from then on.

const ORG = 'org'
const OWNER = 'owner-user'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

test('a host invites a phone-only guest into their conversation and replies reach their account inbox', { timeout: 120000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'guest-invites-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'guest-invites-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Cabin Co', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    const users: Array<[string, string, number, number]> = [
      [OWNER, 'owner@example.test', 1, 0], ['jane', 'jane@example.test', 1, 0], ['bob', 'bob@example.test', 1, 0], ['dana', 'dana@example.test', 1, 0],
      ['anon-a', 'anon-a@customers.krabiclaw.local', 0, 1], ['anon-c', 'anon-c@customers.krabiclaw.local', 0, 1],
    ]
    for (const [id, email, verified, anonymous] of users) {
      await db.prepare('INSERT INTO user (id, name, email, "emailVerified", "isAnonymous", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, 0)').bind(id, id, email, verified, anonymous).run()
    }
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Pine Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 30_000 })
    const deeThread = dee.request_id!
    const tokenOf = (url: string) => new URL(url).pathname.replace('/guest-invite/', '')
    const holders = (requestId: string) => db.prepare('SELECT r.user_id AS request_user, s.user_id AS stay_user FROM requests r JOIN stays s ON s.request_id = r.id WHERE r.id = ?').bind(requestId).first()
    const refused = (status: number, code: string, field: string) => ({ status, data: { code, field } })

    // Before the guest has joined, a reply has nowhere to go and names the invite.
    assert.deepEqual(await executeGuestThreadOperation(db, { threadId: deeThread, organizationId: ORG, action: 'reply', body: 'Hi Dee', actorUserId: OWNER, idempotencyKey: 'before-invite', env }),
      { ok: false, status: 409, reason: 'guest_invite_required', code: 'GUEST_INVITE_REQUIRED', field: 'request_id', message: 'This guest has no email on file. Invite them to the conversation first.' })
    assert.equal((await getGuestThreadDetail(db, deeThread, ORG))?.guestAccountLinked, false)

    // A link is a random token on the platform, valid fourteen days, stored only as its hash.
    const before = Date.now()
    const first = await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: deeThread, actorUserId: OWNER })
    assert.match(first.url, /^https:\/\/proof\.example\/guest-invite\/[A-Za-z0-9_-]{43}$/u)
    assert.ok(Math.abs(Date.parse(first.expires_at) - before - GUEST_INVITE_LIFETIME_MS) < 60_000)
    const firstToken = tokenOf(first.url)
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM guest_thread_invites WHERE token_hash = ?').bind(firstToken).first('n'), 0)
    assert.equal(await db.prepare('SELECT request_id FROM guest_thread_invites WHERE token_hash = ?').bind(await inviteLinkTokenHash(firstToken)).first('request_id'), deeThread)
    assert.deepEqual(await describeGuestThreadInvite(db, firstToken), { organization_name: 'Cabin Co', location_title: 'Pine Cabin', expires_at: first.expires_at })

    // A newer link revokes the unused one; an unknown or malformed link does not exist.
    const second = await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: deeThread, actorUserId: OWNER })
    const secondToken = tokenOf(second.url)
    await assert.rejects(describeGuestThreadInvite(db, firstToken), refused(410, 'GUEST_INVITE_REVOKED', 'token'))
    await assert.rejects(claimGuestThreadInvite(db, { token: firstToken, userId: 'anon-a' }), refused(410, 'GUEST_INVITE_REVOKED', 'token'))
    await assert.rejects(claimGuestThreadInvite(db, { token: 'A'.repeat(43), userId: 'anon-a' }), refused(404, 'GUEST_INVITE_NOT_FOUND', 'token'))
    await assert.rejects(describeGuestThreadInvite(db, 'not-a-token'), refused(404, 'GUEST_INVITE_NOT_FOUND', 'token'))
    assert.deepEqual(await holders(deeThread), { request_user: null, stay_user: null })

    // An expired link ends too, without changing the conversation.
    await db.prepare('UPDATE guest_thread_invites SET expires_at = ? WHERE token_hash = ?').bind(new Date(Date.now() - 1000).toISOString(), await inviteLinkTokenHash(secondToken)).run()
    await assert.rejects(claimGuestThreadInvite(db, { token: secondToken, userId: 'anon-a' }), refused(410, 'GUEST_INVITE_EXPIRED', 'token'))
    assert.deepEqual(await holders(deeThread), { request_user: null, stay_user: null })

    // A guest who continues without an account takes the conversation by the link.
    const third = await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: deeThread, actorUserId: OWNER })
    const thirdToken = tokenOf(third.url)
    const landed = { thread_id: deeThread, path: `/dashboard/account/messages/${deeThread}` }
    assert.deepEqual(await claimGuestThreadInvite(db, { token: thirdToken, userId: 'anon-a' }), landed)
    assert.deepEqual(await holders(deeThread), { request_user: 'anon-a', stay_user: 'anon-a' })
    assert.deepEqual((await listGuestThreads(db, null, { userId: 'anon-a', buyerAudience: true })).map(row => row.id), [deeThread])
    assert.equal((await getGuestThreadDetail(db, deeThread, ORG, { buyerUserId: 'anon-a' }))?.id, deeThread)
    // Opening the spent link again as that guest lands on the same conversation; anyone else finds it used.
    assert.deepEqual(await claimGuestThreadInvite(db, { token: thirdToken, userId: 'anon-a' }), landed)
    await assert.rejects(claimGuestThreadInvite(db, { token: thirdToken, userId: 'bob' }), refused(410, 'GUEST_INVITE_USED', 'token'))
    await assert.rejects(describeGuestThreadInvite(db, thirdToken), refused(410, 'GUEST_INVITE_USED', 'token'))
    assert.deepEqual(await holders(deeThread), { request_user: 'anon-a', stay_user: 'anon-a' })

    // The host's reply now succeeds and is in the guest's inbox. An anonymous
    // guest has no verified address, so nothing is sent and no delivery is recorded.
    const reply = await executeGuestThreadOperation(db, { threadId: deeThread, organizationId: ORG, action: 'reply', body: 'The gate code is 1234.', actorUserId: OWNER, idempotencyKey: 'after-claim', env })
    assert.deepEqual([reply.ok, reply.status], [true, 200])
    const replies = () => db.prepare(`SELECT e.channel, e.body, (SELECT COUNT(*) FROM guest_thread_deliveries d WHERE d.entry_id = e.id) AS deliveries
      FROM activity_entries e WHERE e.request_id = ? AND e.event_name = 'thread.member_reply' ORDER BY e.sequence`).bind(deeThread).all().then(result => result.results)
    assert.deepEqual(await replies(), [{ channel: 'web', body: 'The gate code is 1234.', deliveries: 0 }])
    assert.equal(await db.prepare('SELECT conversation_state FROM requests WHERE id = ?').bind(deeThread).first('conversation_state'), 'waiting_on_guest')
    assert.equal((await getGuestThreadDetail(db, deeThread, ORG))?.guestAccountLinked, true)
    const guestView = (userId: string) => getGuestThreadDetail(db, deeThread, ORG, { buyerUserId: userId })
    assert.deepEqual((await guestView('anon-a'))?.entries.filter(entry => entry.eventName === 'thread.member_reply').map(entry => entry.body), ['The gate code is 1234.'])
    const [unread] = await listGuestThreads(db, null, { userId: 'anon-a', buyerAudience: true, unreadOnly: true })
    assert.equal(unread?.id, deeThread)
    // The same key again is the same reply.
    const retried = await executeGuestThreadOperation(db, { threadId: deeThread, organizationId: ORG, action: 'reply', body: 'The gate code is 1234.', actorUserId: OWNER, idempotencyKey: 'after-claim', env })
    assert.deepEqual([retried.ok, retried.status], [true, 200])
    assert.equal((await replies()).length, 1)
    const buyerAlerts = () => db.prepare("SELECT target_user_id, json_extract(payload_json,'$.deep_link') AS destination FROM activity_entries WHERE kind='notification' AND scope_kind='global' AND event_name='guest_thread_event' ORDER BY id").all().then(result => result.results)
    assert.deepEqual(await buyerAlerts(), [{ target_user_id: 'anon-a', destination: `/dashboard/account/messages/${deeThread}` }])


    // Signing in links the anonymous identity, stay and all, to the account;
    // its verified email now receives the replies too.
    await db.batch(anonymousLinkQueries('anon-a', 'jane', new Date().toISOString()).map(({ query, params }) => db.prepare(query).bind(...(params ?? []))))
    assert.deepEqual(await holders(deeThread), { request_user: 'jane', stay_user: 'jane' })
    assert.equal((await guestView('jane'))?.id, deeThread)
    assert.deepEqual(await buyerAlerts(), [{ target_user_id: 'jane', destination: `/dashboard/account/messages/${deeThread}` }])
    const emailed = await executeGuestThreadOperation(db, { threadId: deeThread, organizationId: ORG, action: 'reply', body: 'Check-in is at four.', actorUserId: OWNER, idempotencyKey: 'after-link', env })
    assert.deepEqual([emailed.ok, emailed.status], [true, 200])
    assert.deepEqual((await replies()).at(-1), { channel: 'email', body: 'Check-in is at four.', deliveries: 1 })
    assert.deepEqual(await db.prepare(`SELECT d.channel, d.status FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
      WHERE e.request_id = ? AND e.body = 'Check-in is at four.'`).bind(deeThread).first(), { channel: 'email', status: 'sent' })

    // A conversation a named account holds is that guest's: no new link is made for it.
    await assert.rejects(createGuestThreadInvite(db, env, { organizationId: ORG, threadId: deeThread, actorUserId: OWNER }), refused(409, 'GUEST_THREAD_ALREADY_CLAIMED', 'request_id'))

    // A guest who lost their anonymous session is invited again and the new
    // account takes the conversation from that identity; a link left open when
    // a named account took it meanwhile is refused to anyone else.
    const fay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'fay', check_in_date: day(10), check_out_date: day(12), adults: 1, guest_name: 'Fay', guest_phone: '+61491570152', total_minor: 30_000 })
    const fayThread = fay.request_id!
    await claimGuestThreadInvite(db, { token: tokenOf((await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: fayThread, actorUserId: OWNER })).url), userId: 'anon-c' })
    const again = tokenOf((await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: fayThread, actorUserId: OWNER })).url)
    await db.batch(anonymousLinkQueries('anon-c', 'dana', new Date().toISOString()).map(({ query, params }) => db.prepare(query).bind(...(params ?? []))))
    await assert.rejects(describeGuestThreadInvite(db, again), refused(409, 'GUEST_THREAD_ALREADY_CLAIMED', 'request_id'))
    assert.equal((await describeGuestThreadInvite(db, again, 'dana')).organization_name, 'Cabin Co')
    await assert.rejects(claimGuestThreadInvite(db, { token: again, userId: 'bob' }), refused(409, 'GUEST_THREAD_ALREADY_CLAIMED', 'request_id'))
    assert.deepEqual(await holders(fayThread), { request_user: 'dana', stay_user: 'dana' })
    assert.deepEqual(await claimGuestThreadInvite(db, { token: again, userId: 'dana' }), { thread_id: fayThread, path: `/dashboard/account/messages/${fayThread}` })

    const gus = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'gus', check_in_date: day(20), check_out_date: day(22), adults: 1, guest_name: 'Gus', guest_phone: '+61491570153', total_minor: 30_000 })
    await claimGuestThreadInvite(db, { token: tokenOf((await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: gus.request_id!, actorUserId: OWNER })).url), userId: 'anon-c' })
    const regain = tokenOf((await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: gus.request_id!, actorUserId: OWNER })).url)
    assert.deepEqual(await claimGuestThreadInvite(db, { token: regain, userId: 'bob' }), { thread_id: gus.request_id, path: `/dashboard/account/messages/${gus.request_id}` })
    assert.deepEqual(await holders(gus.request_id!), { request_user: 'bob', stay_user: 'bob' })

    // Only a stay kept in KrabiClaw is handed over this way.
    await db.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, conversation_state, payload_json, created_at, updated_at)
      VALUES ('contact-1', 'contact', ?, 'cabin-site', 'needs_attention', ?, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`)
      .bind(ORG, JSON.stringify({ guest: { name: 'Hal', email: 'hal@example.test', phone: null }, message: 'Hello' })).run()
    await assert.rejects(createGuestThreadInvite(db, env, { organizationId: ORG, threadId: 'contact-1', actorUserId: OWNER }), refused(409, 'GUEST_INVITE_UNSUPPORTED', 'request_id'))
    await assert.rejects(createGuestThreadInvite(db, env, { organizationId: 'other-org', threadId: deeThread, actorUserId: OWNER }), refused(404, 'THREAD_NOT_FOUND', 'request_id'))
  } finally {
    await runtime.dispose()
  }
})
