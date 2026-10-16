import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { createStay, listStayHomes, setMemberHomes, stayAccessFor, type StayAccess } from '../../server/domain/stays.ts'
import { createTeamThread, listTeamMembers, listTeamMessages, listTeamThreads, markTeamThreadRead, sendTeamMessage, teamAccessFor } from '../../server/domain/team-messages.ts'
import { setNotificationPreference } from '../../server/domain/notification-preferences.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// Team conversations are their members' alone: a seat is a current membership,
// a message is written once per idempotency key, every push it was sent as is
// recorded on it, and a home's one assigned member is set from the member's side.

const ORG = 'org'
const OTHER = 'other-org'
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

test('members talk in team conversations, see unread state and receive recorded pushes', { timeout: 120000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'team-messages-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'team-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    for (const [id, slug] of [[ORG, 'org'], [OTHER, 'other']]) {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
        VALUES (?, ?, ?, ?, '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(id, slug, slug, slug).run()
      await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").bind(`${id}-en`, id).run()
    }
    for (const id of ['owner', 'cleaner', 'cook', 'outsider']) {
      await db.prepare('INSERT INTO user (id, name, email, "emailVerified", createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@example.test`).run()
    }
    for (const [id, organizationId, userId, role] of [['m-owner', ORG, 'owner', 'owner'], ['m-cleaner', ORG, 'cleaner', 'member'], ['m-cook', ORG, 'cook', 'member'], ['m-outsider', OTHER, 'outsider', 'owner']]) {
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(id, organizationId, userId, role).run()
    }
    // The owner's phone is signed in; APNs is not configured here, so its push is a recorded failure.
    await db.prepare("INSERT INTO session (id, expiresAt, token, userId) VALUES ('owner-session', unixepoch() + 3600, 'owner-session-token', 'owner')").run()
    await db.prepare("INSERT INTO device_tokens (token, user_id, session_id, environment) VALUES ('ab12', 'owner', 'owner-session', 'sandbox')").run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Pine Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: 'owner' }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const manager: StayAccess = { organizationId: ORG, actorId: 'owner', manage: true }
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Dee', guest_phone: '+15557770000', total_minor: 30_000 })

    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, role, organizationId: ORG } as never, { env })
    const team = (userId: string, role: string, memberId: string, action: 'read' | 'send' = 'send') => teamAccessFor(principal(userId, role), memberId, action)
    const owner = await team('owner', 'owner', 'm-owner')
    const cleaner = await team('cleaner', 'member', 'm-cleaner')
    const cook = await team('cook', 'member', 'm-cook')
    const refused = (status: number, code: string, field: string) => ({ status, data: { code, field } })

    // Everyone in the organization, owners first; nobody from another one.
    assert.deepEqual((await listTeamMembers(env, cleaner)).map(member => [member.memberId, member.id, member.role, member.image]),
      [['m-owner', 'owner', 'owner', null], ['m-cleaner', 'cleaner', 'member', null], ['m-cook', 'cook', 'member', null]])

    // A conversation has another current member of this organization in it, and is reused for the same people.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['outsider'] }), refused(422, 'INVALID_TEAM_MEMBERS', 'memberIds'))
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['cleaner'] }), refused(422, 'TEAM_THREAD_MEMBERS_REQUIRED', 'memberIds'))
    const direct = await createTeamThread(env, db, cleaner, { memberIds: ['owner'] })
    assert.equal(direct.created, true)
    assert.deepEqual(await createTeamThread(env, db, owner, { memberIds: ['cleaner'] }), { id: direct.id, created: false })

    // A stay conversation needs a stay the caller can see: a member sees only the homes they look after.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'], stayId: stay.id }), refused(404, 'STAY_NOT_FOUND', 'stayId'))
    const ownerStays = await stayAccessFor(principal('owner', 'owner'))
    await assert.rejects(setMemberHomes(env, db, ownerStays, 'm-owner', [cabin.id]), refused(409, 'MEMBER_SEES_ALL_HOMES', 'memberId'))
    await assert.rejects(setMemberHomes(env, db, ownerStays, 'm-outsider', [cabin.id]), refused(404, 'MEMBER_NOT_FOUND', 'memberId'))
    await assert.rejects(setMemberHomes(env, db, ownerStays, 'm-cleaner', ['not-a-home']), refused(422, 'INVALID_HOME_IDS', 'productIds'))
    await assert.rejects(setMemberHomes(env, db, await stayAccessFor(principal('cook', 'member')), 'm-cleaner', [cabin.id]), { status: 403, data: { code: 'STAY_ROLE_REQUIRED' } })
    assert.deepEqual(await setMemberHomes(env, db, ownerStays, 'm-cleaner', [cabin.id]), { memberId: 'm-cleaner', productIds: [cabin.id] })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-cleaner')
    const about = await createTeamThread(env, db, cleaner, { memberIds: ['owner'], stayId: stay.id })
    assert.equal(about.created, true)
    assert.notEqual(about.id, direct.id)

    // One message per key; the same key with different words is refused.
    await assert.rejects(sendTeamMessage(env, db, cleaner, direct.id, { body: '  ', photos: [], idempotencyKey: 'empty', senderName: 'cleaner' }), refused(422, 'EMPTY_MESSAGE', 'body'))
    await assert.rejects(sendTeamMessage(env, db, cleaner, direct.id, { body: 'hi', photos: [], idempotencyKey: undefined, senderName: 'cleaner' }), refused(400, 'MISSING_IDEMPOTENCY_KEY', 'idempotencyKey'))
    const sent = await sendTeamMessage(env, db, cleaner, direct.id, { body: ' Towels are out ', photos: [], idempotencyKey: 'k1', senderName: 'cleaner' })
    assert.equal(sent.created, true)
    assert.equal(sent.message.body, 'Towels are out')
    assert.equal(sent.message.senderId, 'cleaner')
    // The owner's device was tried and Apple's refusal is recorded on the message.
    assert.equal(sent.message.deliveries.length, 1)
    assert.equal(sent.message.deliveries[0]!.status, 'failed')
    assert.match(sent.message.deliveries[0]!.error ?? '', /^APNS_CONFIG_REQUIRED: /)
    const replay = await sendTeamMessage(env, db, cleaner, direct.id, { body: 'Towels are out', photos: [], idempotencyKey: 'k1', senderName: 'cleaner' })
    assert.deepEqual({ id: replay.message.id, created: replay.created, deliveries: replay.message.deliveries.length }, { id: sent.message.id, created: false, deliveries: 1 })
    await assert.rejects(sendTeamMessage(env, db, cleaner, direct.id, { body: 'Different', photos: [], idempotencyKey: 'k1', senderName: 'cleaner' }), refused(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyKey'))

    // Unread is the recipient's, until they read it; the sender has read their own.
    const ownerView = (await listTeamThreads(env, db, owner)).find(thread => thread.id === direct.id)!
    assert.deepEqual({ unread: ownerView.unread, unreadCount: ownerView.unreadCount, last: ownerView.lastMessage?.body, stay: ownerView.stay },
      { unread: true, unreadCount: 1, last: 'Towels are out', stay: null })
    assert.deepEqual(ownerView.participants.map(participant => participant.id).sort(), ['cleaner', 'owner'])
    assert.equal((await listTeamThreads(env, db, cleaner)).find(thread => thread.id === direct.id)?.unreadCount, 0)
    const stayView = (await listTeamThreads(env, db, owner)).find(thread => thread.id === about.id)!
    assert.deepEqual(stayView.stay, { id: stay.id, productId: cabin.id, homeName: 'Cabin', checkInDate: day(3), checkOutDate: day(5), status: stay.status })
    await markTeamThreadRead(db, owner, direct.id)
    assert.equal((await listTeamThreads(env, db, owner)).find(thread => thread.id === direct.id)?.unreadCount, 0)

    // A member switched team pushes off gets none, and nothing is recorded for them.
    await setNotificationPreference(db, env as never, 'owner', 'team_messages', { email: false, whatsapp: false, push: false })
    await assert.rejects(setNotificationPreference(db, env as never, 'owner', 'team_messages', { email: true, whatsapp: false, push: true }), /push only/)
    const quiet = await sendTeamMessage(env, db, cleaner, direct.id, { body: 'Second', photos: [], idempotencyKey: 'k2', senderName: 'cleaner' })
    assert.deepEqual(quiet.message.deliveries, [])
    await sendTeamMessage(env, db, owner, direct.id, { body: 'Thanks', photos: [], idempotencyKey: 'k3', senderName: 'owner' })

    // Newest first, paged back from the oldest loaded message.
    const page = await listTeamMessages(db, owner, direct.id, { limit: '2' })
    assert.deepEqual({ bodies: page.messages.map(message => message.body), hasMore: page.hasMore }, { bodies: ['Thanks', 'Second'], hasMore: true })
    const oldest = page.messages.at(-1)!
    const earlier = await listTeamMessages(db, owner, direct.id, { limit: '2', before: oldest.createdAt, beforeId: oldest.id })
    assert.deepEqual({ bodies: earlier.messages.map(message => message.body), hasMore: earlier.hasMore }, { bodies: ['Towels are out'], hasMore: false })
    await assert.rejects(listTeamMessages(db, owner, direct.id, { before: oldest.createdAt }), refused(422, 'INVALID_CURSOR', 'beforeId'))

    // Someone without a seat cannot read or write it, and does not see it.
    await assert.rejects(listTeamMessages(db, cook, direct.id, {}), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    await assert.rejects(sendTeamMessage(env, db, cook, direct.id, { body: 'hi', photos: [], idempotencyKey: 'cook', senderName: 'cook' }), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual(await listTeamThreads(env, db, cook), [])

    // Reassigning the home to another member clears it from the first.
    await setMemberHomes(env, db, ownerStays, 'm-cook', [cabin.id])
    assert.deepEqual((await setMemberHomes(env, db, ownerStays, 'm-cleaner', [])).productIds, [])
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-cook')

    // Leaving the organization ends the seat; what they wrote stays, sent by their user.
    await db.prepare("DELETE FROM member WHERE id = 'm-cleaner'").run()
    const after = (await listTeamThreads(env, db, owner)).find(thread => thread.id === direct.id)!
    assert.deepEqual(after.participants.map(participant => participant.id), ['owner'])
    assert.equal((await listTeamMessages(db, owner, direct.id, {})).messages.find(message => message.body === 'Towels are out')?.senderId, 'cleaner')
  } finally {
    await runtime.dispose()
  }
})
