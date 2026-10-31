import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import sharp from 'sharp'
import { HTTPError } from 'nitro'
import * as schema from '../../server/db/schema.ts'
import { createDb } from '../../server/db/index.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { getLocation, updateLocation } from '../../server/utils/location-management.ts'
import { assertAssignedBookingAccess, listOrganizationNotificationMembers, memberAccessPrincipal, reconcileResponsibilities } from '../../server/utils/member-access.ts'
import { createStay, listStayHomes, stayAccessFor, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { createTeamThread, listTeamMembers, listTeamMessages, listTeamThreads, markTeamThreadRead, operateTeamGroup, sendTeamMessage, teamAccessFor } from '../../server/domain/team-messages.ts'
import { setNotificationPreference } from '../../server/domain/notification-preferences.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'

// Team conversations are their members' alone: a seat is a current membership,
// a message is written once per idempotency key, every push it was sent as is
// recorded on it, and a home's one assigned member is set from the member's side.

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
        if (event.type === 'team_thread.changed' || event.type === 'team_thread.access_ended') {
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
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
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
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const manager: StayAccess = { organizationId: ORG, actorId: 'owner', manage: true }
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Dee', guest_phone: '+61491570151', total_minor: 30_000 })

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
    const publicationCache = await runtime.getKVNamespace('ORGANIZATION_CACHE')
    await publicationCache.put('team-publication:refuse', 'true')
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'] }), (error: unknown) => {
      const failure = error as { status: number; data: unknown }
      assert.equal(failure.status, 503)
      assert.partialDeepStrictEqual(failure.data, { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true })
      return true
    })
    const firstPublication = await publicationCache.get<{ teamThreadId: string; eventId: string }>('team-publication:last', 'json')
    assert.ok(firstPublication)
    const committedThread = (await listTeamThreads(env, db, owner))[0]!
    assert.equal(committedThread.id, firstPublication.teamThreadId)
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM team_thread_members WHERE thread_id = ?').bind(committedThread.id).first('n'), 2)
    await publicationCache.delete('team-publication:refuse')
    const direct = await createTeamThread(env, db, cleaner, { memberIds: ['owner'] })
    assert.deepEqual(direct, { id: committedThread.id, created: false })
    const retriedPublication = await publicationCache.get<{ teamThreadId: string; eventId: string }>('team-publication:last', 'json')
    assert.equal(retriedPublication?.teamThreadId, committedThread.id)
    assert.notEqual(retriedPublication?.eventId, firstPublication.eventId, 'reusing the saved thread completes the failed publication')
    assert.equal(await publicationCache.get('team-publication:count'), '2')
    assert.deepEqual(await createTeamThread(env, db, owner, { memberIds: ['cleaner'] }), { id: direct.id, created: false })
    // Two starts of the same new conversation at once make one conversation.
    const raced = await Promise.all([createTeamThread(env, db, cleaner, { memberIds: ['cook'] }), createTeamThread(env, db, cook, { memberIds: ['cleaner'] })])
    assert.equal(raced[0].id, raced[1].id)
    assert.deepEqual(raced.map(result => result.created).sort(), [false, true])
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM team_thread_members WHERE thread_id = ?').bind(raced[0].id).first('n'), 2)

    // A stay conversation needs a stay the caller can see: a member sees only the homes they look after.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'], stayId: stay.id }), refused(404, 'STAY_NOT_FOUND', 'stayId'))
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-owner', assigned_team_id: null })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-owner', 'an owner can hold explicit business responsibility')
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-outsider' }), refused(422, 'INVALID_RESPONSIBILITY', 'assigned_member_id'))
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner', assigned_team_id: 'another-target' }), refused(422, 'RESPONSIBILITY_TARGET_CONFLICT', 'assigned_team_id'))
    await assert.rejects(updateStayHome(env, db, await stayAccessFor(principal('cook', 'member')), cabin.id, { assigned_member_id: 'm-cook' }), { status: 403, data: { code: 'STAY_ROLE_REQUIRED' } })
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner', assigned_team_id: null })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-cleaner')
    assert.ok(stay.request_id)
    // A stay's guest conversation is owners' and admins': the member looking after the home reads its turnover.
    await assert.rejects(assertAssignedBookingAccess(db, { ...principal('cleaner', 'member'), requestId: stay.request_id }), refused(404, 'THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual((await listOrganizationNotificationMembers(env, ORG, { requestId: stay.request_id })).map(member => member.userId).sort(), ['owner'], 'a stay conversation alerts owner oversight, not the member looking after the home')
    await db.prepare("INSERT INTO team(id,organizationId,name,createdAt) VALUES('operators',?,'Cabin operators',0),('outsider-team',?,'Other operators',0)").bind(ORG, OTHER).run()
    await db.prepare("INSERT INTO teamMember(id,teamId,userId,createdAt) VALUES('operators-cleaner','operators','cleaner',0),('operators-cook','operators','cook',0)").run()
    const unassignedLocation = (await getLocation(db, ORG, 'cabin-site'))!
    const locationAssignments = await Promise.allSettled([
      updateLocation(db, ORG, 'cabin-site', { assigned_member_id: 'm-cook' }, 'owner', env),
      updateLocation(db, ORG, 'cabin-site', { assigned_team_id: 'operators' }, 'owner', env),
    ])
    for (const result of locationAssignments) {
      if (result.status === 'fulfilled') assert.equal(result.value.status, 200)
      else {
        assert.ok(HTTPError.isError(result.reason))
        assert.equal(result.reason.status, 422)
        assert.deepEqual(result.reason.data, { code: 'RESPONSIBILITY_TARGET_CONFLICT', field: 'assigned_team_id' })
      }
    }
    const assignedLocation = (await getLocation(db, ORG, 'cabin-site'))!
    assert.ok((assignedLocation.assigned_member_id === 'm-cook' && assignedLocation.assigned_team_id === null)
      || (assignedLocation.assigned_member_id === null && assignedLocation.assigned_team_id === 'operators'), 'concurrent location assignments retain exactly one validated target')
    assert.deepEqual(await updateLocation(db, ORG, 'cabin-site', {
      assigned_member_id: null, assigned_team_id: 'operators', expected_updated_at: unassignedLocation.updated_at!,
    }, 'owner', env), { status: 409, data: { error: 'The location changed since it was read. Reload it and try again.', code: 'LOCATION_VERSION_CONFLICT', field: 'expected_updated_at' } },
    'an explicit stale revision keeps its version conflict instead of rebasing a responsibility change')
    const assignmentActivity = await db.prepare("SELECT actor_user_id, payload_json FROM activity_entries WHERE scope_kind = 'organization' AND organization_id = ? AND event_name = 'location.updated' AND json_extract(payload_json, '$.entityId') = 'cabin-site'").bind(ORG).all<{ actor_user_id: string | null; payload_json: string }>()
    assert.deepEqual(assignmentActivity.results.map(entry => ({ actorId: entry.actor_user_id, payload: JSON.parse(entry.payload_json) })), [{
      actorId: 'owner', payload: {
        entityType: 'business_location', entityId: 'cabin-site', actorType: 'member',
        beforeState: { updated_at: unassignedLocation.updated_at }, afterState: { updated_at: assignedLocation.updated_at },
        metadata: { title: 'Pine Cabin', changed_fields: [assignedLocation.assigned_member_id === 'm-cook' ? 'assigned_member_id' : 'assigned_team_id'], evidence_basis: 'persisted_change' },
      },
    }], 'only the winning assignment records its actual actor, field change and persisted revision')
    assert.equal((await updateLocation(db, ORG, 'cabin-site', { assigned_member_id: null, assigned_team_id: null }, 'owner', env)).status, 200)
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { assigned_team_id: 'operators' }), refused(422, 'RESPONSIBILITY_TARGET_CONFLICT', 'assigned_team_id'))
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { assigned_member_id: null, assigned_team_id: 'outsider-team' }), refused(422, 'INVALID_RESPONSIBILITY', 'assigned_team_id'))
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: null, assigned_team_id: 'operators' })
    await assert.rejects(assertAssignedBookingAccess(db, { ...principal('cook', 'member'), requestId: stay.request_id }), refused(404, 'THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual((await listOrganizationNotificationMembers(env, ORG, { requestId: stay.request_id })).map(member => member.userId).sort(), ['owner'], 'a responsible Better Auth team reaches the stay conversation no more than a responsible member')
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner', assigned_team_id: null })
    const about = await createTeamThread(env, db, cleaner, { memberIds: ['owner'], stayId: stay.id })
    assert.equal(about.created, true)
    assert.notEqual(about.id, direct.id)

    // A location conversation needs a location the caller can see, and reuses the existing thread.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner'], locationId: 'nonexistent-location' }), refused(404, 'LOCATION_NOT_FOUND', 'locationId'))
    // cook is not yet assigned to cabin-site, so cook cannot start a location conversation for it
    await assert.rejects(createTeamThread(env, db, cook, { memberIds: ['owner'], locationId: 'cabin-site' }), refused(404, 'LOCATION_NOT_FOUND', 'locationId'))
    const floorChat = await createTeamThread(env, db, owner, { memberIds: ['cook'], locationId: 'cabin-site' })
    assert.equal(floorChat.created, true)
    assert.notEqual(floorChat.id, direct.id)
    assert.notEqual(floorChat.id, about.id)

    // Assigning cook to cabin-site gives cook access to reuse and view the location conversation
    await db.prepare('UPDATE business_locations SET assigned_member_id = ? WHERE id = ?').bind('m-cook', 'cabin-site').run()
    await assert.rejects(assertAssignedBookingAccess(db, { ...principal('cook', 'member'), requestId: stay.request_id }), refused(404, 'THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual((await listOrganizationNotificationMembers(env, ORG, { requestId: stay.request_id })).map(member => member.userId).sort(), ['owner'], 'a location assignment does not reach a lodging conversation either')
    assert.deepEqual(await createTeamThread(env, db, cook, { memberIds: ['owner'], locationId: 'cabin-site' }), { id: floorChat.id, created: false })
    const cookFloorView = (await listTeamThreads(env, db, cook, { locationId: 'cabin-site' })).find(thread => thread.id === floorChat.id)!
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
    await setNotificationPreference(db, env as never, 'owner', 'messages', { email: false, whatsapp: false, push: false })
    const quiet = await sendTeamMessage(env, db, cleaner, direct.id, { body: 'Second', photos: [], idempotencyKey: 'k2', senderName: 'cleaner' })
    assert.deepEqual(quiet.message.deliveries, [])
    assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM guest_thread_deliveries d JOIN activity_entries a ON a.id = d.entry_id WHERE a.dedupe_key = ?`)
      .bind(`team-message:${quiet.message.id}`).first('n'), 0)
    assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM guest_thread_deliveries d JOIN activity_entries a ON a.id = d.entry_id WHERE a.dedupe_key = ? AND d.status = 'failed'`)
      .bind(`team-message:${sent.message.id}`).first('n'), 1)
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
      WHERE mp.owner_type = 'team_message' AND mp.owner_id = ? AND mp.status = 'active' AND ma.organization_id = ?`).bind(committedPhoto.id, ORG).first<{ id: string; r2_key: string; public_url: string }>()
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
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM team_messages WHERE thread_id = ? AND idempotency_key = 'host-photo'").bind(direct.id).first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ? AND status = 'active'").bind(ORG).first('n'), 1)
    const nativePhoto = await sendTeamMessage(env, db, cleaner, direct.id, { body: '', photos: [{ bytes: photoBytes, filename: 'native.avif' }], idempotencyKey: 'native-photo', senderName: 'cleaner' })
    const nativeSaved = (await listTeamMessages(db, owner, direct.id, { limit: 100 })).messages.find(message => message.id === nativePhoto.message.id)
    assert.ok(nativeSaved)
    assert.deepEqual({ id: nativeSaved.id, threadId: nativeSaved.threadId, senderId: nativeSaved.senderId, body: nativeSaved.body, photos: nativeSaved.attachments.length }, { id: nativePhoto.message.id, threadId: direct.id, senderId: 'cleaner', body: '', photos: 1 })
    const nativeAsset = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id
      WHERE mp.owner_type = 'team_message' AND mp.owner_id = ? AND mp.status = 'active' AND ma.organization_id = ?`).bind(nativeSaved.id, ORG).first<{ id: string; r2_key: string; public_url: string }>()
    assert.ok(nativeAsset)
    assert.deepEqual(nativeSaved.attachments.map(photo => [photo.id, photo.url]), [[nativeAsset.id, nativeAsset.public_url]])
    const storedNativePhoto = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(nativeAsset.r2_key)
    assert.ok(storedNativePhoto)
    assert.deepEqual(new Uint8Array(await storedNativePhoto.arrayBuffer()), photoBytes)
    const nativeReplay = await sendTeamMessage(env, db, cleaner, direct.id, { body: '', photos: [{ bytes: photoBytes, filename: 'renamed.avif' }], idempotencyKey: 'native-photo', senderName: 'cleaner' })
    assert.deepEqual({ id: nativeReplay.message.id, created: nativeReplay.created, attachments: nativeReplay.message.attachments }, { id: nativePhoto.message.id, created: false, attachments: nativePhoto.message.attachments }, 'native photo replay retains its byte identity independently of a filename')
    assert.deepEqual((await listTeamMessages(db, owner, direct.id, { limit: 100 })).messages.filter(message => message.id === nativeSaved.id), [nativeSaved])
    assert.deepEqual((await db.prepare("SELECT id, sender_user_id, body FROM team_messages WHERE organization_id = ? AND thread_id = ? AND idempotency_key = 'native-photo'").bind(ORG, direct.id).all()).results,
      [{ id: nativeSaved.id, sender_user_id: 'cleaner', body: '' }])
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM media_placements WHERE owner_type = 'team_message' AND owner_id = ? AND asset_id = ?").bind(nativeSaved.id, nativeAsset.id).first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ? AND status = 'active'").bind(ORG).first('n'), 2)

    // Someone without a seat cannot read or write it, and does not see it.
    await assert.rejects(listTeamMessages(db, cook, direct.id, {}), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    await assert.rejects(sendTeamMessage(env, db, cook, direct.id, { body: 'hi', photos: [], idempotencyKey: 'cook', senderName: 'cook' }), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
    assert.deepEqual((await listTeamThreads(env, db, cook)).map(thread => thread.id).sort(), [floorChat.id, raced[0].id].sort())

    // A manual group has its own identity. Its roster may shrink, without
    // becoming a direct conversation or exposing another group's history.
    await assert.rejects(createTeamThread(env, db, cleaner, { memberIds: ['owner', 'cook'] }), refused(400, 'MISSING_IDEMPOTENCY_KEY', 'idempotencyKey'))
    const groupInput = { memberIds: ['owner', 'cook'], name: '  Cabin crew  ', idempotencyKey: 'crew' }
    const group = await createTeamThread(env, db, cleaner, groupInput)
    assert.deepEqual(await createTeamThread(env, db, cleaner, groupInput), { id: group.id, created: false })
    await assert.rejects(createTeamThread(env, db, cleaner, { ...groupInput, name: 'Different crew' }), refused(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyKey'))
    const separateGroup = await createTeamThread(env, db, cleaner, { ...groupInput, idempotencyKey: 'another-crew' })
    assert.notEqual(separateGroup.id, group.id)
    const groupView = async (access = owner) => (await listTeamThreads(env, db, access)).find(thread => thread.id === group.id)
    assert.deepEqual(await groupView().then(thread => thread && { name: thread.name, isGroup: thread.isGroup, creator: thread.createdByUserId, canManage: thread.canManage, canLeave: thread.canLeave, members: thread.participants.map(person => person.id).sort() }),
      { name: 'Cabin crew', isGroup: true, creator: 'cleaner', canManage: true, canLeave: true, members: ['cleaner', 'cook', 'owner'] })
    assert.equal((await groupView(cleaner))?.canManage, true)
    assert.equal((await groupView(cook))?.canManage, false)
    await assert.rejects(operateTeamGroup(env, db, cook, group.id, { action: 'rename', name: 'No permission', idempotencyKey: 'no-permission' }), refused(403, 'TEAM_GROUP_MANAGEMENT_REQUIRED', 'permissions'))
    await assert.rejects(operateTeamGroup(env, db, cleaner, direct.id, { action: 'leave', idempotencyKey: 'direct-leave' }), refused(409, 'TEAM_GROUP_PROTECTED', 'threadId'))
    const contextualGroup = await createTeamThread(env, db, owner, { memberIds: ['cleaner', 'cook'], locationId: 'cabin-site' })
    assert.deepEqual((await listTeamThreads(env, db, owner)).filter(thread => thread.id === contextualGroup.id).map(thread => [thread.isGroup, thread.canManage, thread.canLeave]), [[false, false, false]])
    await assert.rejects(operateTeamGroup(env, db, owner, contextualGroup.id, { action: 'remove', userId: 'cook', idempotencyKey: 'context-remove' }), refused(409, 'TEAM_GROUP_PROTECTED', 'threadId'))
    await assert.rejects(operateTeamGroup(env, db, cleaner, group.id, { action: 'add', memberIds: ['outsider'], idempotencyKey: 'outsider-add' }), refused(422, 'INVALID_TEAM_MEMBERS', 'memberIds'))
    await assert.rejects(operateTeamGroup(env, db, cleaner, group.id, { action: 'rename', name: ' ', idempotencyKey: 'blank-name' }), refused(422, 'INVALID_GROUP_NAME', 'name'))
    const groupMessage = await sendTeamMessage(env, db, cook, group.id, { body: 'The three of us can see this', photos: [], idempotencyKey: 'group-message', senderName: 'cook' })
    assert.equal((await listTeamMessages(db, cleaner, group.id, {})).messages[0]?.id, groupMessage.message.id)
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
    await context.test('revocation after listing thread IDs exposes neither the thread nor its later preview', async () => {
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
        const threads = await listTeamThreads(env, revokingDb, cook)
        assert.equal(interleaved, true)
        assert.equal(threads.some(thread => thread.id === separateGroup.id), false)
        assert.equal(JSON.stringify(threads).includes('After preview access ended'), false)
        assert.equal((await listTeamMessages(db, owner, separateGroup.id, {})).messages[0]?.body, 'After preview access ended')
      } finally {
        await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'add', memberIds: ['cook'], idempotencyKey: 'list-race-readd' })
      }
    })
    await context.test('a text send losing its seat before commit changes no message, receipt, activity or read state', async () => {
      let interleaved = false
      let afterRemoval: Record<string, unknown> | undefined
      let readsAfterRemoval: unknown
      let receiptsAfterRemoval: unknown
      const revokingDb = new Proxy(db, { get(target, key) {
        if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
          assert.equal(interleaved, false)
          interleaved = true
          await operateTeamGroup(env, db, owner, separateGroup.id, { action: 'remove', userId: 'cook', idempotencyKey: 'send-race-remove' })
          afterRemoval = await db.prepare('SELECT id, last_message_at FROM team_threads WHERE id = ?').bind(separateGroup.id).first<Record<string, unknown>>() ?? undefined
          readsAfterRemoval = (await db.prepare('SELECT member_id, last_read_at FROM team_thread_members WHERE thread_id = ? ORDER BY member_id').bind(separateGroup.id).all()).results
          receiptsAfterRemoval = await db.prepare("SELECT COUNT(*) AS n FROM activity_entries WHERE organization_id = ? AND event_name = 'team.message_sent'").bind(ORG).first('n')
          return target.batch(statements)
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      try {
        await assert.rejects(sendTeamMessage(env, revokingDb, cook, separateGroup.id, { body: 'Must never be sent', photos: [], idempotencyKey: 'send-race-message', senderName: 'cook' }), refused(404, 'TEAM_THREAD_NOT_FOUND', 'threadId'))
        assert.equal(interleaved, true)
        assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM team_messages WHERE thread_id = ? AND idempotency_key = ?').bind(separateGroup.id, 'send-race-message').first('n'), 0)
        assert.deepEqual(await db.prepare('SELECT id, last_message_at FROM team_threads WHERE id = ?').bind(separateGroup.id).first(), afterRemoval)
        assert.deepEqual((await db.prepare('SELECT member_id, last_read_at FROM team_thread_members WHERE thread_id = ? ORDER BY member_id').bind(separateGroup.id).all()).results, readsAfterRemoval)
        assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activity_entries WHERE organization_id = ? AND event_name = 'team.message_sent'").bind(ORG).first('n'), receiptsAfterRemoval)
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
    assert.partialDeepStrictEqual(await publicationCache.get('team-publication:last', 'json'), { type: 'team_thread.access_ended', teamThreadId: group.id, targetUserId: 'cook' })
    await publicationCache.delete('team-publication:refuse')
    assert.deepEqual(await operateTeamGroup(env, db, cook, group.id, leaving), { status: 'left', threadId: group.id })
    assert.equal((await listTeamMessages(db, owner, group.id, {})).messages[0]?.id, groupMessage.message.id)
    await operateTeamGroup(env, db, owner, group.id, { action: 'leave', idempotencyKey: 'last-person-leave' })
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM team_thread_members WHERE thread_id = ?').bind(group.id).first('n'), 0)
    assert.equal(await db.prepare('SELECT id FROM team_messages WHERE thread_id = ?').bind(group.id).first('id'), groupMessage.message.id)

    // The home's one canonical assignment write retains its other details.
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook', assigned_team_id: null, check_in_time: '17:00', check_out_time: '11:00' })
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, 'm-cook')
    assert.deepEqual(await db.prepare('SELECT assigned_member_id, check_in_time, check_out_time FROM product_stay_configs WHERE product_id = ?').bind(cabin.id).first(), {
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
    const retainedGroup = (await listTeamThreads(env, db, owner)).find(thread => thread.name === 'Retained group')!
    assert.equal(retainedGroup.participants.length, 3)
    // Leaving the organization ends the seat; what they wrote stays, sent by their user.
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cleaner', assigned_team_id: null })
    const auth = createAuth(env)
    const headers = new Headers({ authorization: 'Bearer owner-session-token' })
    const removedMember = await auth.api.removeMember({ headers, body: { organizationId: ORG, memberIdOrEmail: 'm-cleaner' } })
    assert.equal(removedMember.member.id, 'm-cleaner')
    assert.equal((await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id, null, 'Better Auth removal releases current responsibility through its real organization hook')
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook', assigned_team_id: null })
    await publicationCache.delete('team-publication:refuse')
    assert.deepEqual(await createTeamThread(env, db, owner, retainedCreation), { id: retainedGroup.id, created: false })
    assert.deepEqual((await listTeamThreads(env, db, owner)).find(thread => thread.id === retainedGroup.id)?.participants.map(person => person.id).sort(), ['cook', 'owner'])
    const after = (await listTeamThreads(env, db, owner)).find(thread => thread.id === direct.id)!
    assert.deepEqual(after.participants.map(participant => participant.id), ['owner'])
    assert.equal((await listTeamMessages(db, owner, direct.id, {})).messages.find(message => message.body === 'Towels are out')?.senderId, 'cleaner')

    // Only departed/dangling current targets are released. Promotion preserves explicit responsibility.
    const assignee = async () => (await listStayHomes(db, manager)).find(home => home.product_id === cabin.id)?.assigned_member_id
    await reconcileResponsibilities(env, db, { organizationId: ORG })
    assert.equal(await assignee(), 'm-cook')
    await db.prepare("DELETE FROM member WHERE id = 'm-cook'").run()
    // An edit that leaves responsibility alone saves while the departed assignee is still recorded, and keeps it for reconciliation to release.
    await updateStayHome(env, db, manager, cabin.id, { max_guests: 4 })
    assert.equal(await assignee(), 'm-cook')
    await Promise.all([
      reconcileResponsibilities(env, db, { organizationId: ORG }),
      updateStayHome(env, db, manager, cabin.id, { max_guests: 3 }),
    ])
    assert.equal(await assignee(), null)
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-cook', ?, 'cook', 'member', 0)").bind(ORG).run()
    assert.deepEqual(await db.prepare('SELECT assigned_member_id, max_guests, check_in_time, check_out_time FROM product_stay_configs WHERE product_id = ?').bind(cabin.id).first(), {
      assigned_member_id: null, max_guests: 3, check_in_time: '17:00', check_out_time: '11:00',
    })
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook', assigned_team_id: null })
    const promotedMember = await auth.api.updateMemberRole({ headers, body: { organizationId: ORG, memberId: 'm-cook', role: 'admin' } })
    assert.equal(promotedMember.role, 'admin')
    assert.equal(await assignee(), 'm-cook')
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activity_entries WHERE event_name = 'member.access_scope_revoked' AND actor_kind = 'system' AND organization_id = ?").bind(ORG).first('n'), 3)
  } finally {
    await runtime.dispose()
  }
})
