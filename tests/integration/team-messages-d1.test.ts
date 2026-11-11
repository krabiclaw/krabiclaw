import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import sharp from 'sharp'
import * as schema from '../../server/db/schema.ts'
import { createDb } from '../../server/db/index.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createTables } from './support/table-product.ts'
import { listOrganizationNotificationMembers, memberAccessPrincipal, reconcileResponsibilities } from '../../server/utils/member-access.ts'
import { assertConversationAccess, markConversationRead, markConversationUnread } from '../../server/domain/conversations.ts'
import { listConversations } from '../../server/domain/guest-threads/repository.ts'
import { createStay, listStayHomes, stayAccessFor, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { receiveMemberEmail } from '../../server/domain/guest-threads/inbound-email.ts'
import { InboundEmailRejection, parseReplyToAddress } from '../../server/utils/reply-address.ts'
import { createTeamThread, getTeamThread, listTeamMembers, listTeamMessages, operateTeamGroup, sendTeamMessage, teamAccessFor, type TeamAccess } from '../../server/domain/team-messages.ts'
import { setNotificationPreference } from '../../server/domain/notification-preferences.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'

// Team conversations are their members' alone: a seat is a participant who is a
// current member, a message is written once per idempotency key, every push it
// was sent as is recorded on it, unread is the conversation's one statement, and
// a home's one assigned member is set from the member's side.

const ORG = 'org'
const OTHER = 'other-org'
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

test('members talk in team conversations, see unread state and receive recorded pushes', { timeout: 120000 }, async (context) => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'team-messages-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(state, env) { this.env = env }
      async fetch(request) {
        const event = await request.json()
        if ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && event.team || event.type === 'CONVERSATION_LEAVE') {
          const cache = this.env.ORGANIZATION_CACHE
          await cache.put('team-publication:last', JSON.stringify(event))
          await cache.put('team-publication:count', String(Number(await cache.get('team-publication:count') ?? '0') + 1))
          if (await cache.get('team-publication:refuse')) return new Response(null, { status: 503 })
        }
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'team-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), MEDIA_BASE_URL: 'https://media.example.test', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', EMAIL_REPLY_SECRET: 'team-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    for (const [id, slug] of [[ORG, 'org'], [OTHER, 'other']]) {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
        VALUES (?, ?, ?, ?, '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(id, slug, slug, slug).run()
      await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").bind(`${id}-en`, id).run()
    }
    for (const id of ['owner', 'cleaner', 'cook', 'outsider']) {
      await db.prepare('INSERT INTO user (id, name, email, "emailVerified", createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@example.test`).run()
    }
    for (const [id, organizationId, userId, role] of [['m-owner', ORG, 'owner', 'owner'], ['m-cleaner', ORG, 'cleaner', 'member'], ['m-cook', ORG, 'cook', 'member'], ['m-outsider', OTHER, 'outsider', 'owner']]) {
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(id, organizationId, userId, role).run()
    }
    // The owner's phone is signed in; APNs is not configured here, so its push is a recorded failure.
    await setNotificationPreference(db, env, 'owner', 'messages', { email: false, whatsapp: false, push: true })
    await db.prepare("INSERT INTO session (id, expiresAt, token, userId) VALUES ('owner-session', unixepoch() + 3600, 'owner-session-token', 'owner')").run()
    await db.prepare("INSERT INTO device_tokens (token, kind, user_id, session_id, environment) VALUES ('ab12', 'apns', 'owner', 'owner-session', 'sandbox')").run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Pine Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: 'owner' }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'm-owner' },
    } })
    const manager: StayAccess = { organizationId: ORG, actorId: 'owner', manage: true }
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 30_000 })

    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, role, organizationId: ORG } as never, { env })
    const team = (userId: string, role: string, memberId: string, action: 'read' | 'send' = 'send') => teamAccessFor(principal(userId, role), memberId, action)
    const owner = await team('owner', 'owner', 'm-owner')
    const cleaner = await team('cleaner', 'member', 'm-cleaner')
    const cook = await team('cook', 'member', 'm-cook')
    const refused = (status: number, code: string, field: string) => ({ status, data: { code, field } })
    // The caller's team conversations, each as its conversation screen reads it.
    const teamThreads = async (access: TeamAccess) => Promise.all((await db.prepare(`SELECT c.id FROM conversations c JOIN conversation_participants seat ON seat.conversation_id = c.id
      WHERE c.organization_id = ? AND c.kind = 'team' AND seat.user_id = ? ORDER BY c.last_message_at DESC, c.id DESC`).bind(ORG, access.userId).all<{ id: string }>()).results.map(row => getTeamThread(env, db, access, row.id)))
    const teamThread = (access: TeamAccess, id: string) => getTeamThread(env, db, access, id)

    // Everyone in the organization, owners first; nobody from another one.
    assert.deepEqual((await listTeamMembers(env, cleaner)).map(member => [member.memberId, member.id, member.role, member.image]),
      [['m-owner', 'owner', 'owner', null], ['m-cleaner', 'cleaner', 'member', null], ['m-cook', 'cook', 'member', null]])

    // A conversation has another current member of this organization in it, and is reused for the same people.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['outsider'] }), refused(422, 'INVALID_TEAM_MEMBERS', 'memberIds'))
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['cleaner'] }), refused(422, 'TEAM_THREAD_MEMBERS_REQUIRED', 'memberIds'))
    const publicationCache = await runtime.getKVNamespace('ORGANIZATION_CACHE')
    await publicationCache.put('team-publication:refuse', 'true')
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'] }), (error: unknown) => {
      const failure = error as { status: number; data: unknown }
      assert.equal(failure.status, 503)
      assert.partialDeepStrictEqual(failure.data, { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true })
      return true
    })
    const firstPublication = await publicationCache.get<{ conversationId: string; eventId: string }>('team-publication:last', 'json')
    assert.ok(firstPublication)
    const committedThread = (await teamThreads(owner))[0]!
    assert.equal(committedThread.id, firstPublication.conversationId)
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ?').bind(committedThread.id).first('n'), 2)
    await publicationCache.delete('team-publication:refuse')
    const direct = await createTeamThread(env, db, cleaner, { memberIds: ['owner'] })
    assert.deepEqual(direct, { id: committedThread.id, created: false })
    const retriedPublication = await publicationCache.get<{ conversationId: string; eventId: string }>('team-publication:last', 'json')
    assert.equal(retriedPublication?.conversationId, committedThread.id)
    assert.notEqual(retriedPublication?.eventId, firstPublication.eventId, 'reusing the saved thread completes the failed publication')
    assert.equal(await publicationCache.get('team-publication:count'), '2')
    assert.deepEqual(await createTeamThread(env, db, owner, { memberIds: ['cleaner'] }), { id: direct.id, created: false })
    // Two starts of the same new conversation at once make one conversation.
    const raced = await Promise.all([createTeamThread(env, db, cleaner, { memberIds: ['cook'] }), createTeamThread(env, db, cook, { memberIds: ['cleaner'] })])
    assert.equal(raced[0].id, raced[1].id)
    assert.deepEqual(raced.map(result => result.created).sort(), [false, true])
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ?').bind(raced[0].id).first('n'), 2)

    // A stay conversation needs a stay the caller can see: a member sees only the homes they look after.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'], bookingId: stay.id }), refused(404, 'BOOKING_NOT_FOUND', 'bookingId'))
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-owner' })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-owner', 'an owner can hold explicit business responsibility')
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-outsider' }), refused(422, 'INVALID_RESPONSIBILITY', 'assigned_member_id'))
    await assert.rejects(updateStayHome(env, db, await stayAccessFor(principal('cook', 'member')), cabin.id, { assigned_member_id: 'm-cook' }), { status: 403, data: { code: 'STAY_ROLE_REQUIRED' } })
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner' })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-cleaner')
    const stayConversation = await db.prepare("SELECT id FROM conversations WHERE booking_id = ? AND kind = 'booking'").bind(stay.id).first<string>('id')
    assert.ok(stayConversation)
    // A stay's guest conversation is owners' and admins': the member looking after the home reads its turnover.
    await assert.rejects(assertConversationAccess(db, principal('cleaner', 'member'), stayConversation), refused(404, 'THREAD_NOT_FOUND', 'conversationId'))
    assert.deepEqual((await listOrganizationNotificationMembers(env, ORG, { requestId: stayConversation })).map(member => member.userId).sort(), ['owner'], 'a stay conversation alerts owner oversight, not the member looking after the home')
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner' })
    const about = await createTeamThread(env, db, cleaner, { memberIds: ['owner'], bookingId: stay.id })
    assert.equal(about.created, true)
    assert.notEqual(about.id, direct.id)

    // A location conversation needs a location the caller can see, and reuses the existing thread.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'], locationId: 'nonexistent-location' }), refused(404, 'LOCATION_NOT_FOUND', 'locationId'))
    // cook handles nothing at cabin-site yet, so cook cannot start a location conversation for it
    await assert.rejects(createTeamThread(env, db, cook, { memberIds: ['owner'], locationId: 'cabin-site' }), refused(404, 'LOCATION_NOT_FOUND', 'locationId'))
    const floorChat = await createTeamThread(env, db, owner, { memberIds: ['cook'], locationId: 'cabin-site' })
    assert.equal(floorChat.created, true)
    assert.notEqual(floorChat.id, direct.id)
    assert.notEqual(floorChat.id, about.id)

    // Giving cook the site's tables gives cook access to reuse and view the location conversation
    await createTables(db, env, { organizationId: ORG, locationId: 'cabin-site', actorId: 'owner', memberId: 'm-cook', name: 'Cabin tables', durationMinutes: 90, seats: 12, open: '18:00', lastSeating: '20:00', idempotencyKey: 'cabin-tables' })
    await assert.rejects(assertConversationAccess(db, principal('cook', 'member'), stayConversation), refused(404, 'THREAD_NOT_FOUND', 'conversationId'))
    assert.deepEqual((await listOrganizationNotificationMembers(env, ORG, { requestId: stayConversation })).map(member => member.userId).sort(), ['owner'], 'handling the site\'s tables does not reach a lodging conversation either')
    assert.deepEqual(await createTeamThread(env, db, cook, { memberIds: ['owner'], locationId: 'cabin-site' }), { id: floorChat.id, created: false })
    const cookFloorView = await teamThread(cook, floorChat.id)
    assert.equal(cookFloorView.locationId, 'cabin-site')
    assert.deepEqual(cookFloorView.location, { id: 'cabin-site', title: 'Pine Cabin', slug: 'cabin', timezone: 'America/Denver' })

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
    const ownerView = await teamThread(owner, direct.id)
    assert.deepEqual({ unread: ownerView.unread, last: ownerView.lastMessage?.body, stay: ownerView.stay }, { unread: true, last: 'Towels are out', stay: null })
    assert.deepEqual(ownerView.participants.map(participant => participant.id).sort(), ['cleaner', 'owner'])
    assert.equal((await teamThread(cleaner, direct.id)).unread, false)
    // The one list says the same, with the same statement.
    const ownerRow = (await listConversations(db, ORG, { userId: 'owner', principal: owner.principal, kind: 'team' })).find(row => row.id === direct.id)
    assert.deepEqual([ownerRow?.kind, ownerRow?.unread, ownerRow?.preview], ['team', true, 'Towels are out'])
    const stayView = await teamThread(owner, about.id)
    assert.deepEqual(stayView.stay, { id: stay.id, productId: cabin.id, homeName: 'Cabin', checkInDate: day(3), checkOutDate: day(5), status: stay.status })
    await markConversationRead(db, { organizationId: ORG, conversationId: direct.id, userId: 'owner' })
    assert.equal((await teamThread(owner, direct.id)).unread, false)
    // Marked unread from the list: the cleaner's newest message counts as new again, then read again.
    assert.equal((await markConversationUnread(db, { organizationId: ORG, conversationId: direct.id, userId: 'owner' })).read, false)
    assert.equal((await teamThread(owner, direct.id)).unread, true)
    await markConversationRead(db, { organizationId: ORG, conversationId: direct.id, userId: 'owner' })
    assert.equal((await teamThread(owner, direct.id)).unread, false)
    // Nobody else has written to the cleaner here, so there is nothing to be unread.
    await assert.rejects(markConversationUnread(db, { organizationId: ORG, conversationId: direct.id, userId: 'cleaner' }), refused(409, 'NOTHING_TO_MARK', 'conversationId'))

    // A member switched team pushes off gets none, and nothing is recorded for them.
    await setNotificationPreference(db, env as never, 'owner', 'messages', { email: false, whatsapp: false, push: false })
    const quiet = await sendTeamMessage(env, db, cleaner, direct.id, { body: 'Second', photos: [], idempotencyKey: 'k2', senderName: 'cleaner' })
    assert.deepEqual(quiet.message.deliveries, [])
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM guest_thread_deliveries WHERE message_id = ?').bind(quiet.message.id).first('n'), 0)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM guest_thread_deliveries WHERE message_id = ? AND status = 'failed'").bind(sent.message.id).first('n'), 1)
    await sendTeamMessage(env, db, owner, direct.id, { body: 'Thanks', photos: [], idempotencyKey: 'k3', senderName: 'owner' })

    // Newest first, paged back from the oldest loaded message.
    const page = await listTeamMessages(db, owner, direct.id, { limit: '2' })
    assert.deepEqual({ bodies: page.messages.map(message => message.body), hasMore: page.hasMore }, { bodies: ['Thanks', 'Second'], hasMore: true })
    const oldest = page.messages.at(-1)!
    const earlier = await listTeamMessages(db, owner, direct.id, { limit: '2', before: oldest.createdAt, beforeId: oldest.id })
    assert.deepEqual({ bodies: earlier.messages.map(message => message.body), hasMore: earlier.hasMore }, { bodies: ['Towels are out'], hasMore: false })
    await assert.rejects(listTeamMessages(db, owner, direct.id, { before: oldest.createdAt }), refused(422, 'INVALID_CURSOR', 'beforeId'))

    // A committed host photo can finish publication after its download URL expires.
    const photoBytes = Uint8Array.from(await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2563eb' } }).avif().toBuffer())
    let resolutions = 0
    const hostPhoto = { body: 'The entry photo', idempotencyKey: 'host-photo', senderName: 'cleaner', photos: {
      sourceIds: ['host-entry-photo'], resolve: async () => { resolutions += 1; return [{ bytes: photoBytes, filename: 'entry.avif' }] },
    } }
    await publicationCache.put('team-publication:refuse', 'true')
    await assert.rejects(sendTeamMessage(env, db, cleaner, direct.id, hostPhoto), (error: unknown) => {
      const failure = error as { status: number; data: unknown }
      assert.equal(failure.status, 503)
      assert.partialDeepStrictEqual(failure.data, { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, thread_id: direct.id })
      return true
    })
    const committedPhoto = (await listTeamMessages(db, owner, direct.id, { limit: 1 })).messages[0]!
    assert.equal(committedPhoto.body, hostPhoto.body)
    assert.equal(committedPhoto.attachments.length, 1)
    const photoAsset = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id
      WHERE mp.owner_type = 'message' AND mp.owner_id = ? AND mp.status = 'active' AND ma.organization_id = ?`).bind(committedPhoto.id, ORG).first<{ id: string; r2_key: string; public_url: string }>()
    assert.ok(photoAsset)
    assert.deepEqual(committedPhoto.attachments.map(photo => [photo.id, photo.url]), [[photoAsset.id, photoAsset.public_url]])
    const storedPhoto = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(photoAsset.r2_key)
    assert.ok(storedPhoto)
    assert.deepEqual(new Uint8Array(await storedPhoto.arrayBuffer()), photoBytes)
    const photoPublication = await publicationCache.get<{ eventId: string }>('team-publication:last', 'json')
    await publicationCache.delete('team-publication:refuse')
    const expiredPhoto = { ...hostPhoto, photos: { sourceIds: ['host-entry-photo'], resolve: async () => { throw new Error('Host download has expired') } } }
    const photoReplay = await sendTeamMessage(env, db, cleaner, direct.id, expiredPhoto)
    assert.deepEqual({ id: photoReplay.message.id, created: photoReplay.created, attachments: photoReplay.message.attachments }, { id: committedPhoto.id, created: false, attachments: committedPhoto.attachments })
    assert.notEqual((await publicationCache.get<{ eventId: string }>('team-publication:last', 'json'))?.eventId, photoPublication?.eventId)
    await assert.rejects(sendTeamMessage(env, db, cleaner, direct.id, { ...expiredPhoto, photos: { ...expiredPhoto.photos, sourceIds: ['different-host-photo'] } }), refused(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyKey'))
    assert.equal(resolutions, 1)
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND dedupe_key = ?').bind(direct.id, `team:${direct.id}:host-photo`).first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ? AND status = 'active'").bind(ORG).first('n'), 1)
    const nativePhoto = await sendTeamMessage(env, db, cleaner, direct.id, { body: '', photos: [{ bytes: photoBytes, filename: 'native.avif' }], idempotencyKey: 'native-photo', senderName: 'cleaner' })
    const nativeSaved = (await listTeamMessages(db, owner, direct.id, { limit: 100 })).messages.find(message => message.id === nativePhoto.message.id)
    assert.ok(nativeSaved)
    assert.deepEqual({ id: nativeSaved.id, threadId: nativeSaved.threadId, senderId: nativeSaved.senderId, body: nativeSaved.body, photos: nativeSaved.attachments.length }, { id: nativePhoto.message.id, threadId: direct.id, senderId: 'cleaner', body: '', photos: 1 })
    const nativeAsset = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id
      WHERE mp.owner_type = 'message' AND mp.owner_id = ? AND mp.status = 'active' AND ma.organization_id = ?`).bind(nativeSaved.id, ORG).first<{ id: string; r2_key: string; public_url: string }>()
    assert.ok(nativeAsset)
    assert.deepEqual(nativeSaved.attachments.map(photo => [photo.id, photo.url]), [[nativeAsset.id, nativeAsset.public_url]])
    const storedNativePhoto = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(nativeAsset.r2_key)
    assert.ok(storedNativePhoto)
    assert.deepEqual(new Uint8Array(await storedNativePhoto.arrayBuffer()), photoBytes)
    const nativeReplay = await sendTeamMessage(env, db, cleaner, direct.id, { body: '', photos: [{ bytes: photoBytes, filename: 'renamed.avif' }], idempotencyKey: 'native-photo', senderName: 'cleaner' })
    assert.deepEqual({ id: nativeReplay.message.id, created: nativeReplay.created, attachments: nativeReplay.message.attachments }, { id: nativePhoto.message.id, created: false, attachments: nativePhoto.message.attachments }, 'native photo replay retains its byte identity independently of a filename')
    assert.deepEqual((await listTeamMessages(db, owner, direct.id, { limit: 100 })).messages.filter(message => message.id === nativeSaved.id), [nativeSaved])
    assert.deepEqual((await db.prepare('SELECT id, author_user_id, body FROM messages WHERE organization_id = ? AND conversation_id = ? AND dedupe_key = ?').bind(ORG, direct.id, `team:${direct.id}:native-photo`).all()).results,
      [{ id: nativeSaved.id, author_user_id: 'cleaner', body: '' }])
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM media_placements WHERE owner_type = 'message' AND owner_id = ? AND asset_id = ?").bind(nativeSaved.id, nativeAsset.id).first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ? AND status = 'active'").bind(ORG).first('n'), 2)

    // Someone without a seat cannot read or write it, and does not see it.
    await assert.rejects(listTeamMessages(db, cook, direct.id, {}), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    await assert.rejects(sendTeamMessage(env, db, cook, direct.id, { body: 'hi', photos: [], idempotencyKey: 'cook', senderName: 'cook' }), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual((await teamThreads(cook)).map(thread => thread.id).sort(), [floorChat.id, raced[0].id].sort())
    await assert.rejects(teamThread(cook, direct.id), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))

    // A manual group has its own identity. Its roster may shrink, without
    // becoming a direct conversation or exposing another group's history.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner', 'cook'] }), refused(400, 'MISSING_IDEMPOTENCY_KEY', 'idempotencyKey'))
    const groupInput = { memberIds: ['owner', 'cook'], name: '  Cabin crew  ', idempotencyKey: 'crew' }
    const group = await createTeamThread(env, db, cleaner, groupInput)
    assert.deepEqual(await createTeamThread(env, db, cleaner, groupInput), { id: group.id, created: false })
    await assert.rejects(createTeamThread(env, db, cleaner, { ...groupInput, name: 'Different crew' }), refused(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyKey'))
    const separateGroup = await createTeamThread(env, db, cleaner, { ...groupInput, idempotencyKey: 'another-crew' })
    assert.notEqual(separateGroup.id, group.id)
    const groupView = async (access = owner) => (await teamThreads(access)).find(thread => thread.id === group.id)
    assert.deepEqual(await groupView().then(thread => thread && { name: thread.name, isGroup: thread.isGroup, creator: thread.createdByUserId, canManage: thread.canManage, canLeave: thread.canLeave, members: thread.participants.map(person => person.id).sort() }),
      { name: 'Cabin crew', isGroup: true, creator: 'cleaner', canManage: true, canLeave: true, members: ['cleaner', 'cook', 'owner'] })
    assert.equal((await groupView(cleaner))?.canManage, true)
    assert.equal((await groupView(cook))?.canManage, false)
    await assert.rejects(operateTeamGroup(env, db, cook, group.id, { action: 'rename', name: 'No permission', idempotencyKey: 'no-permission' }), refused(403, 'TEAM_GROUP_MANAGEMENT_REQUIRED', 'permissions'))
    await assert.rejects(operateTeamGroup(env, db, cleaner, direct.id, { action: 'leave', idempotencyKey: 'direct-leave' }), refused(409, 'TEAM_GROUP_PROTECTED', 'threadId'))
    const contextualGroup = await createTeamThread(env, db, owner, { memberIds: ['cleaner', 'cook'], locationId: 'cabin-site' })
    assert.deepEqual(await teamThread(owner, contextualGroup.id).then(thread => [thread.isGroup, thread.canManage, thread.canLeave]), [false, false, false])
    await assert.rejects(operateTeamGroup(env, db, owner, contextualGroup.id, { action: 'remove', userId: 'cook', idempotencyKey: 'context-remove' }), refused(409, 'TEAM_GROUP_PROTECTED', 'threadId'))
    await assert.rejects(operateTeamGroup(env, db, cleaner, group.id, { action: 'add', memberIds: ['outsider'], idempotencyKey: 'outsider-add' }), refused(422, 'INVALID_TEAM_MEMBERS', 'memberIds'))
    await assert.rejects(operateTeamGroup(env, db, cleaner, group.id, { action: 'rename', name: ' ', idempotencyKey: 'blank-name' }), refused(422, 'INVALID_GROUP_NAME', 'name'))
    const groupMessage = await sendTeamMessage(env, db, cook, group.id, { body: 'The three of us can see this', photos: [], idempotencyKey: 'group-message', senderName: 'cook' })
    assert.equal((await listTeamMessages(db, cleaner, group.id, {})).messages[0]?.id, groupMessage.message.id)
    // A team alert's email answers the team conversation as the member who replied, once.
    const alerted = await sendTeamMessage(env, db, cook, contextualGroup.id, { body: 'Is the cabin ready?', photos: [], idempotencyKey: 'email-reply-alert', senderName: 'cook' })
    const alertEmail = await db.prepare("SELECT email_json FROM guest_thread_deliveries WHERE message_id = ? AND channel = 'email' AND email_json LIKE '%cleaner@example.test%'")
      .bind(alerted.message.id).first<string>('email_json')
    const address = parseReplyToAddress(env, (JSON.parse(alertEmail!).message as { replyTo: string }).replyTo)
    // The reply address carries the message itself.
    assert.deepEqual([address.kind, address.messageId], ['member', alerted.message.id])
    // Another member writing in the same conversation is the same email thread for the cleaner: the first alert's subject, not a new one.
    const followUp = await sendTeamMessage(env, db, owner, contextualGroup.id, { body: 'Checking in too', photos: [], idempotencyKey: 'email-thread-follow-up', senderName: 'owner' })
    const cleanerAlert = async (messageId: string) => JSON.parse((await db.prepare(`SELECT email_json FROM guest_thread_deliveries
      WHERE message_id = ? AND channel = 'email' AND email_json LIKE '%cleaner@example.test%'`).bind(messageId).first<string>('email_json'))!).message as { subject: string }
    const firstSubject = (await cleanerAlert(alerted.message.id)).subject
    assert.match(firstSubject, /cook/iu)
    assert.equal((await cleanerAlert(followUp.message.id)).subject, firstSubject)
    const emailedReply = { entryId: address.messageId, token: address.token, from: 'Cleaner@example.test', body: 'On my way', files: [], messageId: '<team-reply@mail.example.test>' }
    const unexpectedReport = async (error: unknown) => { throw error }
    await receiveMemberEmail(env, emailedReply, unexpectedReport)
    await receiveMemberEmail(env, emailedReply, unexpectedReport)
    assert.deepEqual((await listTeamMessages(db, owner, contextualGroup.id, {})).messages.filter(message => message.body === 'On my way').map(message => message.senderId), ['cleaner'])
    // The reply saves but open apps cannot be told: the delivery fails so its redelivery finishes the work,
    // and the redelivery writes no second message.
    const hubs = env.GUEST_INBOX_HUBS!
    env.GUEST_INBOX_HUBS = { idFromName: (name: string) => hubs.idFromName(name), get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 500 })) }) } as unknown as typeof hubs
    const unfinished = { ...emailedReply, body: 'Keys are in the box', messageId: '<team-reply-unfinished@mail.example.test>' }
    // The send's own receipt is the first to tell open apps, so the failure arrives as that send's.
    await assert.rejects(receiveMemberEmail(env, unfinished, unexpectedReport), (error: unknown) => (error as { cause?: { data?: { code?: string } } }).cause?.data?.code === 'DASHBOARD_PUBLICATION_FAILED')
    env.GUEST_INBOX_HUBS = hubs
    await receiveMemberEmail(env, unfinished, unexpectedReport)
    assert.deepEqual((await listTeamMessages(db, owner, contextualGroup.id, {})).messages.filter(message => message.body === 'Keys are in the box').map(message => message.senderId), ['cleaner'])
    // The signature is the cleaner's: another member replying from their own address is refused.
    await assert.rejects(receiveMemberEmail(env, { ...emailedReply, from: 'owner@example.test', messageId: '<team-forged@mail.example.test>' }, unexpectedReport), InboundEmailRejection)
    assert.equal((await listTeamMessages(db, owner, contextualGroup.id, {})).messages.filter(message => message.body === 'On my way').length, 1)
    const readingDb = createDb(db)
    await context.test('revocation between a seat check and its transcript read exposes no later message', async () => {
      let interleaved = false
      const revokingDb = new Proxy(readingDb, { get(target, key) {
        if (key === 'get') return async (query: Parameters<typeof readingDb.get>[0]) => {
          const row = await target.get(query)
          if (!interleaved) {
            interleaved = true
            await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'remove', userId: 'cook', idempotencyKey: 'transcript-race-remove' })
            await sendTeamMessage(env, db, owner, separateGroup.id, { body: 'After transcript access ended', photos: [], idempotencyKey: 'transcript-race-message', senderName: 'owner' })
          }
          return row
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      try {
        await assert.rejects(listTeamMessages(revokingDb, cook, separateGroup.id, {}), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
        assert.equal(interleaved, true)
        assert.equal((await listTeamMessages(db, owner, separateGroup.id, {})).messages[0]?.body, 'After transcript access ended')
      } finally {
        await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'add', memberIds: ['cook'], idempotencyKey: 'transcript-race-readd' })
      }
    })
    await context.test('revocation after listing conversation IDs exposes neither the conversation nor its later preview', async () => {
      let interleaved = false
      const revokingDb = new Proxy(readingDb, { get(target, key) {
        if (key === 'all') return async (query: Parameters<typeof readingDb.all>[0]) => {
          const rows = await target.all(query)
          if (!interleaved) {
            interleaved = true
            await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'remove', userId: 'cook', idempotencyKey: 'list-race-remove' })
            await sendTeamMessage(env, db, owner, separateGroup.id, { body: 'After preview access ended', photos: [], idempotencyKey: 'list-race-message', senderName: 'owner' })
          }
          return rows
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      try {
        const rows = await listConversations(revokingDb, ORG, { userId: 'cook', principal: cook.principal, kind: 'team' })
        assert.equal(interleaved, true)
        assert.equal(JSON.stringify(rows).includes('After preview access ended'), false)
        await assert.rejects(getTeamThread(env, db, cook, separateGroup.id), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
        assert.equal((await listTeamMessages(db, owner, separateGroup.id, {})).messages[0]?.body, 'After preview access ended')
      } finally {
        await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'add', memberIds: ['cook'], idempotencyKey: 'list-race-readd' })
      }
    })
    await context.test('a text send losing its seat before commit changes no message, receipt or read state', async () => {
      let interleaved = false
      let afterRemoval: Record<string, unknown> | undefined
      let readsAfterRemoval: unknown
      const revokingDb = new Proxy(db, { get(target, key) {
        if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
          assert.equal(interleaved, false)
          interleaved = true
          await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'remove', userId: 'cook', idempotencyKey: 'send-race-remove' })
          afterRemoval = await db.prepare('SELECT id, last_message_at FROM conversations WHERE id = ?').bind(separateGroup.id).first<Record<string, unknown>>() ?? undefined
          readsAfterRemoval = (await db.prepare('SELECT user_id, last_read_message_id, archived_at FROM conversation_participants WHERE conversation_id = ? ORDER BY user_id').bind(separateGroup.id).all()).results
          return target.batch(statements)
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      try {
        await assert.rejects(sendTeamMessage(env, revokingDb, cook, separateGroup.id, { body: 'Must never be sent', photos: [], idempotencyKey: 'send-race-message', senderName: 'cook' }), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
        assert.equal(interleaved, true)
        assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE dedupe_key = ?').bind(`team:${separateGroup.id}:send-race-message`).first('n'), 0)
        assert.deepEqual(await db.prepare('SELECT id, last_message_at FROM conversations WHERE id = ?').bind(separateGroup.id).first(), afterRemoval)
        assert.deepEqual((await db.prepare('SELECT user_id, last_read_message_id, archived_at FROM conversation_participants WHERE conversation_id = ? ORDER BY user_id').bind(separateGroup.id).all()).results, readsAfterRemoval)
      } finally {
        await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'add', memberIds: ['cook'], idempotencyKey: 'send-race-readd' })
      }
    })
    await operateTeamGroup(env, db, cleaner, group.id, { action: 'rename', name: 'Turnover crew', idempotencyKey: 'rename-crew' })
    assert.equal((await groupView())?.name, 'Turnover crew')
    // Reusing one key with different concurrent mutations writes only the
    // winner's value; the other request cannot borrow its receipt.
    const renamed = await Promise.allSettled(['Crew A', 'Crew B'].map(name => operateTeamGroup(env, db, owner, group.id, { action: 'rename', name, idempotencyKey: 'concurrent-name' })))
    const winner = renamed.findIndex(result => result.status === 'fulfilled')
    assert.equal(renamed.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await groupView())?.name, ['Crew A', 'Crew B'][winner])
    const rejectedRename = renamed.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejectedRename.reason.status, 409)
    assert.deepEqual(rejectedRename.reason.data, { code: 'IDEMPOTENCY_KEY_REUSED', field: 'idempotencyKey' })
    await operateTeamGroup(env, db, owner, group.id, { action: 'remove', userId: 'cook', idempotencyKey: 'remove-cook' })
    await assert.rejects(listTeamMessages(db, cook, group.id, {}), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual(await groupView().then(thread => thread && [thread.isGroup, thread.canLeave, thread.participants.length]), [true, true, 2])
    await operateTeamGroup(env, db, cleaner, group.id, { action: 'add', memberIds: ['cook'], idempotencyKey: 'add-cook' })
    assert.equal((await listTeamMessages(db, cook, group.id, {})).messages[0]?.id, groupMessage.message.id)
    await operateTeamGroup(env, db, owner, group.id, { action: 'remove', userId: 'cleaner', idempotencyKey: 'remove-creator' })
    await assert.rejects(operateTeamGroup(env, db, cleaner, group.id, { action: 'add', memberIds: ['cleaner'], idempotencyKey: 'removed-creator-add' }), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    await assert.rejects(createTeamThread(env, db, cleaner, groupInput), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual((await groupView())?.participants.map(person => person.id).sort(), ['cook', 'owner'])
    await publicationCache.put('team-publication:refuse', 'true')
    const leaving = { action: 'leave', idempotencyKey: 'cook-leave' }
    await assert.rejects(operateTeamGroup(env, db, cook, group.id, leaving), (error: unknown) => {
      const failure = error as { status: number; data: unknown }
      assert.equal(failure.status, 503)
      assert.deepEqual(failure.data, { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, thread_id: group.id })
      return true
    })
    assert.equal(await groupView(cook), undefined)
    assert.partialDeepStrictEqual(await publicationCache.get('team-publication:last', 'json'), { type: 'CONVERSATION_LEAVE', conversationId: group.id, targetUserId: 'cook' })
    await publicationCache.delete('team-publication:refuse')
    assert.deepEqual(await operateTeamGroup(env, db, cook, group.id, leaving), { status: 'left', threadId: group.id })
    assert.equal((await listTeamMessages(db, owner, group.id, {})).messages[0]?.id, groupMessage.message.id)
    await operateTeamGroup(env, db, owner, group.id, { action: 'leave', idempotencyKey: 'last-person-leave' })
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ?').bind(group.id).first('n'), 0)
    assert.equal(await db.prepare('SELECT id FROM messages WHERE conversation_id = ?').bind(group.id).first('id'), groupMessage.message.id)

    // The home's one canonical assignment write retains its other details.
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook', check_in_time: '17:00', check_out_time: '11:00' })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-cook')
    assert.deepEqual(await db.prepare('SELECT assigned_member_id, check_in_time, check_out_time FROM product_booking_configs WHERE product_id = ?').bind(cabin.id).first(), {
      assigned_member_id: 'm-cook', check_in_time: '17:00', check_out_time: '11:00',
    })

    // A creation that already committed can finish its publication after an
    // original recipient leaves the workspace; it never recreates their seat.
    const retainedCreation = { memberIds: ['cleaner', 'cook'], name: 'Retained group', idempotencyKey: 'retained-creation' }
    await publicationCache.put('team-publication:refuse', 'true')
    await assert.rejects(createTeamThread(env, db, owner, retainedCreation), (error: unknown) => {
      const failure = error as { status: number; data: Record<string, unknown> }
      assert.equal(failure.status, 503)
      assert.equal(failure.data.committed, true)
      return true
    })
    const retainedGroup = (await teamThreads(owner)).find(thread => thread.name === 'Retained group')!
    assert.equal(retainedGroup.participants.length, 3)
    // Leaving the organization ends the seat; what they wrote stays, sent by their user.
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner' })
    const auth = createAuth(env)
    const headers = new Headers({ authorization: 'Bearer owner-session-token' })
    const removedMember = await auth.api.removeMember({ headers, body: { organizationId: ORG, memberIdOrEmail: 'm-cleaner' } })
    assert.equal(removedMember.member.id, 'm-cleaner')
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, null, 'Better Auth removal releases current responsibility through its real organization hook')
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook' })
    await publicationCache.delete('team-publication:refuse')
    assert.deepEqual(await createTeamThread(env, db, owner, retainedCreation), { id: retainedGroup.id, created: false })
    assert.deepEqual((await teamThread(owner, retainedGroup.id)).participants.map(person => person.id).sort(), ['cook', 'owner'])
    const after = await teamThread(owner, direct.id)
    assert.deepEqual(after.participants.map(participant => participant.id), ['owner'])
    // The departed member keeps no seat or read position in this organization's conversations.
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM conversation_participants WHERE organization_id = ? AND user_id = 'cleaner'").bind(ORG).first('n'), 0)
    assert.equal((await listTeamMessages(db, owner, direct.id, {})).messages.find(message => message.body === 'Towels are out')?.senderId, 'cleaner')

    // Only departed/dangling current targets are released. Promotion preserves explicit responsibility.
    const assignee = async () => (await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id
    await reconcileResponsibilities(env, db, { organizationId: ORG })
    assert.equal(await assignee(), 'm-cook')
    await db.prepare("DELETE FROM member WHERE id = 'm-cook'").run()
    // An edit that leaves responsibility alone saves while the departed assignee is still recorded, and keeps it for reconciliation to release.
    await updateStayHome(env, db, manager, cabin.id, { max_guests: 4 })
    assert.equal(await assignee(), 'm-cook')
    await reconcileResponsibilities(env, db, { organizationId: ORG })
    assert.equal(await assignee(), null)
    // A home nobody looks after takes no booking-setting edit until someone is given it.
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { max_guests: 3 }), { status: 422 })
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-cook', ?, 'cook', 'member', 0)").bind(ORG).run()
    assert.deepEqual(await db.prepare('SELECT assigned_member_id, default_capacity, check_in_time, check_out_time FROM product_booking_configs WHERE product_id = ?').bind(cabin.id).first(), {
      assigned_member_id: null, default_capacity: 4, check_in_time: '17:00', check_out_time: '11:00',
    })
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook' })
    const promotedMember = await auth.api.updateMemberRole({ headers, body: { organizationId: ORG, memberId: 'm-cook', role: 'admin' } })
    assert.equal(promotedMember.role, 'admin')
    assert.equal(await assignee(), 'm-cook')
    // Each departure releases the home, the open turnover that followed the home's assignee, and the tables the cook handled.
    assert.deepEqual((await db.prepare("SELECT json_extract(payload_json, '$.entityType') AS entity, COUNT(*) AS n FROM activity_entries WHERE event_name = 'member.access_scope_revoked' AND actor_kind = 'system' AND organization_id = ? GROUP BY entity ORDER BY entity").bind(ORG).all()).results,
      [{ entity: 'product_booking_configs', n: 3 }, { entity: 'tasks', n: 2 }])
  } finally {
    await runtime.dispose()
  }
})
