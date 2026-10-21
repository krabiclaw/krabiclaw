import { createReplayableReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import type { UpdateProductInput } from '../../server/types/products.ts'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct, deleteProduct, getProduct, removeProductLocation, setProductLocation, setProductPublication, updateProduct } from '../../server/utils/product-management.ts'
import { addStayHomePhoto, applyChannelBooking, cancelStay, createStay, createStayPhotoRoom, deleteStayPayment, getStay, listStays, moveStayPhotos, readStayCalendar, readStayHome, recordStayPayment, removeStayHomePhoto, removeStayPhotoRoom, reorderStayHomePhotos, setStayNights, updateStay, type GuestStay, type StayAccess } from '../../server/domain/stays.ts'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../shared/dashboard-invalidations.ts'
import { getQuery, H3 } from 'nitro/h3'
import { createAuth } from '../../server/utils/auth.ts'
import guestStayRoute from '../../server/api/public/guest-stays/[activityId].get.ts'
import accountStayRoute from '../../server/api/account/stays/[activityId].get.ts'
import paymentReturnRoute from '../../server/api/public/payments/[paymentId]/return.post.ts'
import { tokenHash } from '../../server/domain/payments/buyer.ts'
import { createLocation, updateLocation } from '../../server/utils/location-management.ts'
import { claimGuestThreadInvite, createGuestThreadInvite } from '../../server/domain/guest-threads/invites.ts'
import publicLocationsRoute from '../../server/api/public/locations.get.ts'
import publicLocationRoute from '../../server/api/public/locations/[slug].get.ts'
import publicPageRoute from '../../server/api/public/page.get.ts'
import { loadPublicShellSource } from '../../server/utils/public-shell.ts'
import { loadPublicProductApiDetail, loadPublicProductCollection, loadPublicProductDetail, loadPublicProductReviews, type PublicProductLocation } from '../../server/utils/public-products.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { getPublicTenantPageForPath } from '../../server/utils/public-tenant-pages.ts'
import { putResourceLocalization } from '../../server/utils/localization.ts'
import { listOrganizationReviews } from '../../server/utils/organization-reviews.ts'
import { loadPublicSocialMedia } from '../../server/utils/public-social-image.ts'
import { arrangeProductPhotos, attachMediaPlacement, removeMediaPlacement, setSingleMediaPlacement } from '../../server/utils/media-placement.ts'
import { deleteMediaAsset, getMediaAsset } from '../../server/utils/media-asset-manager.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { stayPhotoRoomName } from '../../shared/stay-photos.ts'

const ORG = 'org'
const OWNER = 'owner-user'
const CLEANER = 'cleaner-user'
const OUTSIDER = 'outsider-user'
const NOW = '2026-10-14T00:00:00.000Z'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const cleaner: StayAccess = { organizationId: ORG, actorId: CLEANER, manage: false, userId: CLEANER }
const outsider: StayAccess = { organizationId: ORG, actorId: OUTSIDER, manage: false, userId: OUTSIDER }

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stays-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { constructor(ctx) { this.ctx = ctx } async fetch(request) { if (new URL(request.url).pathname === "/observed") return Response.json(await this.ctx.storage.get("events") ?? []); if (new URL(request.url).pathname === "/failure") { await this.ctx.storage.put("failure", request.method === "PUT"); return new Response(null, { status: 204 }) } const event = await request.json(); await this.ctx.storage.put("events", [...await this.ctx.storage.get("events") ?? [], event]); if (await this.ctx.storage.get("failure")) return new Response("Publication refused", { status: 503 }); return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stays-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' } as CloudflareEnv
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    for (const [id, role] of [[OWNER, 'owner'], [CLEANER, 'member'], [OUTSIDER, 'member']] as const) {
      await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)").bind(id, id, `${id}@example.test`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
    }
    await db.prepare("INSERT INTO team (id, name, organizationId, createdAt) VALUES ('cleaning', 'Cleaning', ?, 0)").bind(ORG).run()
    await db.prepare("INSERT INTO teamMember (id, teamId, userId, createdAt) VALUES ('tm-cleaner', 'cleaning', ?, 0)").bind(CLEANER).run()
    for (const loc of ['cabin-site', 'lake-site']) {
      await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 'America/Denver', ?, ?)`).bind(loc, ORG, loc, loc, NOW, NOW).run()
    }
    return { runtime, db, env }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

async function home(db: D1Database, env: CloudflareEnv, input: { name: string; location: string; team?: string }) {
  return createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
    kind: 'stay', name: input.name,
    variants: [{ name: input.name, prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
    stay: { location_id: input.location, check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: null, assigned_team_id: input.team ?? null },
  } })
}

function code(expected: string) {
  return (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected
}

const guest = { adults: 2, guest_name: 'Ana', total_minor: 45_000 }

test('committed stays report publication failures and idempotent retries publish without duplicate writes', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    const events = async () => {
      const value: unknown = await (await hub.fetch('https://inbox.test/observed')).json()
      assert(Array.isArray(value) && value.every(isDashboardInvalidation))
      return value as DashboardInvalidation[]
    }
    const homeEvents = await events()
    assert.deepEqual(homeEvents.map(event => ({ type: event.type, ...('stayId' in event ? { productId: event.productId, stayId: event.stayId, locationId: event.locationId } : {}) })), [
      { type: 'stay.changed', productId: cabin.id, stayId: null, locationId: 'cabin-site' },
      { type: 'nights.changed', productId: cabin.id, stayId: null, locationId: 'cabin-site' },
    ])
    await hub.fetch('https://inbox.test/failure', { method: 'PUT' })
    const input = { product_id: cabin.id, idempotency_key: 'publish-stay', check_in_date: '2027-05-01', check_out_date: '2027-05-03', ...guest }
    await assert.rejects(createStay(db, env, manager, input), (error: { status?: number; data?: Record<string, unknown> }) =>
      error.status === 503 && error.data?.code === 'DASHBOARD_PUBLICATION_FAILED' && error.data.committed === true && error.data.version === 1 && typeof error.data.stay_id === 'string')
    const persisted = await db.prepare('SELECT id, version FROM stays WHERE idempotency_key = ?').bind(input.idempotency_key).first<{ id: string; version: number }>()
    assert(persisted)
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights WHERE stay_id = ?').bind(persisted.id).first('count(*)'), 2)
    await hub.fetch('https://inbox.test/failure', { method: 'DELETE' })
    const replay = await createStay(db, env, manager, input)
    assert.deepEqual({ id: replay.id, version: replay.version }, persisted)
    assert.equal(await db.prepare('SELECT count(*) FROM stays WHERE idempotency_key = ?').bind(input.idempotency_key).first('count(*)'), 1)
    assert.deepEqual((await events()).slice(-2).map(event => ({ type: event.type, ...('stayId' in event ? { stayId: event.stayId, productId: event.productId } : {}) })), [
      { type: 'stay.changed', stayId: replay.id, productId: cabin.id }, { type: 'nights.changed', stayId: replay.id, productId: cabin.id },
    ])

    await hub.fetch('https://inbox.test/failure', { method: 'PUT' })
    const payment = { amount_minor: 10_000, method: 'cash', paid_on: '2027-05-01', idempotency_key: 'publish-payment' }
    await assert.rejects(recordStayPayment(db, env, manager, replay.id, payment), code('DASHBOARD_PUBLICATION_FAILED'))
    assert.equal((await getStay(db, manager, replay.id)).paid_minor, 10_000)
    await hub.fetch('https://inbox.test/failure', { method: 'DELETE' })
    assert.equal((await recordStayPayment(db, env, manager, replay.id, payment)).paid_minor, 10_000)
    assert.equal(await db.prepare('SELECT count(*) FROM stay_payments WHERE stay_id = ?').bind(replay.id).first('count(*)'), 1)

    // A saved versioned edit reports its real version; its stale retry never writes again.
    await hub.fetch('https://inbox.test/failure', { method: 'PUT' })
    await assert.rejects(updateStay(db, env, manager, replay.id, { expected_version: 1, guest_name: 'Ana Recorded' }),
      (error: { data?: Record<string, unknown> }) => error.data?.code === 'DASHBOARD_PUBLICATION_FAILED' && error.data.committed === true && error.data.version === 2)
    await hub.fetch('https://inbox.test/failure', { method: 'DELETE' })
    await assert.rejects(updateStay(db, env, manager, replay.id, { expected_version: 1, guest_name: 'Ana Recorded' }), code('STAY_VERSION_CONFLICT'))
    assert.deepEqual({ name: (await getStay(db, manager, replay.id)).guest_name, version: (await getStay(db, manager, replay.id)).version }, { name: 'Ana Recorded', version: 2 })

    const booking = { provider: 'channex' as const, external_booking_id: 'live-channel-booking', channel_booking_id: null, channel: 'airbnb' as const,
      revision_id: 'live-revision', provider_updated_at: '2026-10-16T01:00:00Z', cancelled: false, check_in_date: '2027-06-01', check_out_date: '2027-06-03', adults: 2,
      children: 0, infants: 0, guest_name: null, guest_surname: null, guest_email: null, guest_phone: null, total_minor: 20_000, currency: 'USD' }
    await hub.fetch('https://inbox.test/failure', { method: 'PUT' })
    await assert.rejects(applyChannelBooking(db, env, ORG, cabin.id, booking), code('DASHBOARD_PUBLICATION_FAILED'))
    await hub.fetch('https://inbox.test/failure', { method: 'DELETE' })
    const channel = await applyChannelBooking(db, env, ORG, cabin.id, booking)
    assert.equal(channel.applied, false)
    assert.equal(channel.version, 1)
    assert.equal(await db.prepare('SELECT count(*) FROM stays WHERE external_booking_id = ?').bind(booking.external_booking_id).first('count(*)'), 1)
    const published = await events()
    assert.deepEqual(published.slice(-2).map(event => ({ type: event.type, ...('stayId' in event ? { stayId: event.stayId, productId: event.productId, locationId: event.locationId } : {}) })), [
      { type: 'stay.changed', stayId: channel.id, productId: cabin.id, locationId: 'cabin-site' },
      { type: 'nights.changed', stayId: channel.id, productId: cabin.id, locationId: 'cabin-site' },
    ])
    assert.equal(new Set(published.map(event => event.eventId)).size, published.length)
  } finally {
    await runtime.dispose()
  }
})

test('a moved channel revision repairs its audited home scopes without rewriting a recognized or superseded delivery', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const lake = await home(db, env, { name: 'Lake', location: 'lake-site' })
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    const events = async () => {
      const value: unknown = await (await hub.fetch('https://inbox.test/observed')).json()
      assert(Array.isArray(value) && value.every(isDashboardInvalidation))
      return value as DashboardInvalidation[]
    }
    const audit = () => db.prepare("SELECT payload_json FROM activity_entries WHERE organization_id = ? AND json_extract(payload_json, '$.metadata.external_booking_id') = ? ORDER BY occurred_at, rowid")
      .bind(ORG, 'moving-channel-booking').all<{ payload_json: string }>()
    const booking = { provider: 'channex' as const, external_booking_id: 'moving-channel-booking', channel_booking_id: null, channel: 'airbnb' as const,
      revision_id: 'initial-revision', provider_updated_at: '2026-10-16T01:00:00Z', cancelled: false, check_in_date: '2027-06-01', check_out_date: '2027-06-03', adults: 2,
      children: 0, infants: 0, guest_name: null, guest_surname: null, guest_email: null, guest_phone: null, total_minor: 20_000, currency: 'USD' }
    const first = await applyChannelBooking(db, env, ORG, cabin.id, booking)
    const moved = { ...booking, revision_id: 'moved-revision', provider_updated_at: '2026-10-16T02:00:00Z' }
    await hub.fetch('https://inbox.test/failure', { method: 'PUT' })
    await assert.rejects(applyChannelBooking(db, env, ORG, lake.id, moved), (error: { data?: Record<string, unknown> }) =>
      error.data?.code === 'DASHBOARD_PUBLICATION_FAILED' && error.data.product_id === cabin.id && error.data.version === 2)
    const committed = await getStay(db, manager, first.id)
    assert.equal(committed.product_id, lake.id)
    assert.equal(committed.version, 2)
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights WHERE product_id = ?').bind(cabin.id).first('count(*)'), 0)
    const appliedAudits = await audit()
    assert.equal(appliedAudits.results.length, 2)
    assert.deepEqual(JSON.parse(appliedAudits.results[1]!.payload_json).metadata, {
      channel: 'airbnb', overbooked: false, provider: 'channex', external_booking_id: booking.external_booking_id, revision_id: moved.revision_id, provider_updated_at: moved.provider_updated_at,
      previous_product_id: cabin.id, previous_location_id: 'cabin-site', product_id: lake.id, location_id: 'lake-site',
    })
    await hub.fetch('https://inbox.test/failure', { method: 'DELETE' })
    const beforeRepair = (await events()).length
    const replay = await applyChannelBooking(db, env, ORG, lake.id, moved)
    assert.equal(replay.applied, false)
    assert.deepEqual([replay.version, replay.updated_at], [committed.version, committed.updated_at])
    assert.deepEqual((await events()).slice(beforeRepair).map(event => ({ type: event.type, ...('productId' in event ? { productId: event.productId, locationId: event.locationId, stayId: event.stayId } : {}) })), [
      { type: 'stay.changed', productId: cabin.id, locationId: 'cabin-site', stayId: first.id },
      { type: 'nights.changed', productId: cabin.id, locationId: 'cabin-site', stayId: first.id },
      { type: 'stay.changed', productId: lake.id, locationId: 'lake-site', stayId: first.id },
      { type: 'nights.changed', productId: lake.id, locationId: 'lake-site', stayId: first.id },
    ])
    assert.deepEqual((await audit()).results, appliedAudits.results)

    // A factual earlier receipt can be repaired after a later move. A stale
    // revision that never applied has no historical scope to manufacture.
    const earlier = await applyChannelBooking(db, env, ORG, cabin.id, booking)
    assert.equal(earlier.applied, false)
    assert.equal(earlier.product_id, lake.id)
    const beforeStale = (await events()).length
    const stale = await applyChannelBooking(db, env, ORG, cabin.id, { ...booking, revision_id: 'never-applied', provider_updated_at: '2026-10-16T00:00:00Z' })
    assert.equal(stale.applied, false)
    assert.deepEqual((await events()).slice(beforeStale).filter(event => 'productId' in event).map(event => event.productId), [lake.id, lake.id])
    assert.deepEqual((await audit()).results, appliedAudits.results)
    assert.equal((await getStay(db, manager, first.id)).updated_at, committed.updated_at)

    // An explicitly empty previous scope on creation is valid; a missing
    // required audit field is malformed and cannot silently mean empty.
    await db.prepare("UPDATE activity_entries SET payload_json = json_remove(payload_json, '$.metadata.previous_product_id') WHERE organization_id = ? AND json_extract(payload_json, '$.metadata.revision_id') = ?")
      .bind(ORG, booking.revision_id).run()
    await assert.rejects(applyChannelBooking(db, env, ORG, cabin.id, booking), code('CHANNEL_REVISION_AUDIT_INVALID'))
    await db.prepare("UPDATE activity_entries SET payload_json = ? WHERE organization_id = ? AND json_extract(payload_json, '$.metadata.revision_id') = ?")
      .bind(appliedAudits.results[0]!.payload_json, ORG, booking.revision_id).run()

    // Current required audit data is not replaced with guessed home history.
    await db.prepare("DELETE FROM activity_entries WHERE organization_id = ? AND json_extract(payload_json, '$.metadata.revision_id') = ?").bind(ORG, moved.revision_id).run()
    await assert.rejects(applyChannelBooking(db, env, ORG, lake.id, moved), code('CHANNEL_REVISION_AUDIT_REQUIRED'))
    assert.equal((await getStay(db, manager, first.id)).version, 2)
    await db.prepare('UPDATE stays SET revision_id = NULL WHERE id = ?').bind(first.id).run()
    await assert.rejects(applyChannelBooking(db, env, ORG, lake.id, moved), code('CHANNEL_REVISION_ID_REQUIRED'))
    await db.prepare('UPDATE stays SET revision_id = ? WHERE id = ?').bind(moved.revision_id, first.id).run()

    const duplicate = { ...booking, external_booking_id: 'concurrent-channel-booking', revision_id: 'concurrent-revision', check_in_date: '2027-07-01', check_out_date: '2027-07-03' }
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => applyChannelBooking(db, env, ORG, cabin.id, duplicate)))
    assert.equal(concurrent.filter(stay => stay.applied).length, 1)
    assert.equal(new Set(concurrent.map(stay => stay.id)).size, 1)
    assert(concurrent.every(stay => stay.version === 1))
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE json_extract(payload_json, '$.metadata.revision_id') = ?").bind(duplicate.revision_id).first('count(*)'), 1)

    const raceBase = { ...booking, external_booking_id: 'racing-move', revision_id: 'race-base', check_in_date: '2027-08-01', check_out_date: '2027-08-03' }
    await applyChannelBooking(db, env, ORG, cabin.id, raceBase)
    const older = { ...raceBase, revision_id: 'race-older', provider_updated_at: '2026-10-16T03:00:00Z' }
    const newer = { ...raceBase, revision_id: 'race-newer', provider_updated_at: '2026-10-16T04:00:00Z' }
    const raced = await Promise.allSettled([applyChannelBooking(db, env, ORG, lake.id, older), applyChannelBooking(db, env, ORG, cabin.id, newer)])
    assert.equal(raced[0]!.status, 'fulfilled')
    if (raced[1]!.status === 'rejected') assert(code('CHANNEL_REVISION_CONFLICT')(raced[1]!.reason))
    // The provider's retained newer revision can be retried against the actual
    // winner. Its audit must describe that winner's home, not a pre-race read.
    const winner = await applyChannelBooking(db, env, ORG, cabin.id, newer)
    const moveAudits = await db.prepare("SELECT json_extract(payload_json, '$.metadata.revision_id') AS revision, json_extract(payload_json, '$.metadata.previous_product_id') AS previous_product FROM activity_entries WHERE json_extract(payload_json, '$.metadata.external_booking_id') = ?")
      .bind(raceBase.external_booking_id).all<{ revision: string; previous_product: string | null }>()
    const olderApplied = moveAudits.results.some(row => row.revision === older.revision_id)
    assert.equal(moveAudits.results.filter(row => row.revision === newer.revision_id).length, 1)
    assert.equal(moveAudits.results.find(row => row.revision === newer.revision_id)!.previous_product, olderApplied ? lake.id : cabin.id)
    assert.equal(winner.version, olderApplied ? 3 : 2)
    assert.equal(winner.product_id, cabin.id)
    const held = await db.prepare('SELECT product_id, date FROM stay_nights WHERE stay_id = ? ORDER BY date').bind(winner.id).all<{ product_id: string; date: string }>()
    assert.deepEqual(held.results, [{ product_id: cabin.id, date: '2027-08-01' }, { product_id: cabin.id, date: '2027-08-02' }])

    // A move into occupied nights rolls back its first attempt, then lands
    // overbooked without retaining old claims or releasing the other guest's.
    const overlapBase = { ...booking, external_booking_id: 'overlapping-move', revision_id: 'overlap-base' }
    const overlapStay = await applyChannelBooking(db, env, ORG, cabin.id, overlapBase)
    const overbooked = await applyChannelBooking(db, env, ORG, lake.id, { ...overlapBase, revision_id: 'overlap-move', provider_updated_at: '2026-10-16T05:00:00Z' })
    assert.deepEqual([overbooked.id, overbooked.product_id, overbooked.overbooked, overbooked.version], [overlapStay.id, lake.id, true, 2])
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights WHERE stay_id = ?').bind(overlapStay.id).first('count(*)'), 0)
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights WHERE stay_id = ?').bind(first.id).first('count(*)'), 2)
  } finally {
    await runtime.dispose()
  }
})

test('a place to stay is a Product at exactly one location, priced per night', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    await assert.rejects(createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'stay', name: 'No rules' } }), /needs its location/)
    await assert.rejects(createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'dish', name: 'Soup', stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 2, min_nights: 1, assigned_member_id: null, assigned_team_id: null } } }), /Only a place to stay/)
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site', team: 'cleaning' })
    assert.equal(cabin.kind, 'stay')
    assert.equal(cabin.unit_label, 'night')
    assert.deepEqual(cabin.stay, { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2,
      property_type_group: null, property_type: null, listing_type: null, total_floors: null, listing_floor: null, year_built: null, property_size: null, property_size_unit: null,
      bedrooms: null, beds: null, bathrooms: null, amenities: [], cancellation_policy: null, long_term_cancellation_policy: null, assigned_member_id: null, assigned_team_id: 'cleaning', photo_rooms: [] })
    // Its one location shows it; the product's publication decides whether anyone does.
    assert.deepEqual(cabin.locations, [{ location_id: 'cabin-site', active: true, published: true }])
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { location_id: 'lake-site', max_guests: 2 } as never } }), /keeps its location/)
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).locations.map(location => location.location_id), ['cabin-site'])
    await assert.rejects(setProductLocation(db, { organizationId: ORG, productId: cabin.id, locationId: 'lake-site', actor: { actorId: OWNER } }), /exactly one location/)
    await assert.rejects(removeProductLocation(db, { organizationId: ORG, productId: cabin.id, locationId: 'cabin-site' }), /cannot leave the location/)
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { kind: 'experience' } }), /keeps its kind/)
    // Guests book a place to stay on the site and pay in full, so it takes no external booking link.
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { order_url: 'https://www.airbnb.com/rooms/1' } }), /takes no external booking link/)
    const edited = await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { max_guests: 6 } } })
    // A save that does not name stay settings leaves them as stored, even if they changed meanwhile.
    await db.prepare('UPDATE product_stay_configs SET min_nights = 5 WHERE product_id = ?').bind(cabin.id).run()
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { name: 'Cliff Cabin' } })
    assert.equal((await getProduct(db, ORG, cabin.id)).stay?.min_nights, 5)
    assert.equal(edited.stay?.max_guests, 6)
    assert.equal(edited.stay?.location_id, 'cabin-site')

    // Focused rule edits read the current detail owner, preserving facts a
    // different editor saved after this home was first loaded.
    assert.deepEqual(cabin.details, { featured: false })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details: { featured: true, your_property: 'A cabin beside the cliff.', house_rules: 'Leave muddy shoes outside.' },
    } })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: { your_property: 'A cabin with a sheltered terrace.', smoking_allowed: false },
    } })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: { pets_allowed: true },
    } })
    const rules = { featured: true, your_property: 'A cabin with a sheltered terrace.', house_rules: 'Leave muddy shoes outside.', smoking_allowed: false, pets_allowed: true }
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).details, rules)
    assert.deepEqual(JSON.parse((await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'))!), rules)

    const simultaneous = [
      { details_mode: 'merge', details: { events_allowed: false } },
      { details_mode: 'merge', details: { commercial_photography_allowed: true } },
      { stay: { check_in_time: '17:00', check_out_time: '11:00' } },
    ] satisfies UpdateProductInput[]
    const outcomes = await Promise.allSettled(simultaneous.map(patch => updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch })))
    assert(outcomes.some(outcome => outcome.status === 'fulfilled'))
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'rejected') continue
      assert.equal((outcome.reason as { status: number }).status, 409)
      assert.equal((outcome.reason as { data?: { code?: string } }).data?.code, 'PRODUCT_UPDATE_CONFLICT')
      // The caller reads the committed state before explicitly retrying the
      // refused edit. A concurrent fact is never silently overwritten.
      const committed = await getProduct(db, ORG, cabin.id)
      assert.equal(committed.details.featured, true)
      await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: simultaneous[index]! })
    }
    const combinedRules = { ...rules, events_allowed: false, commercial_photography_allowed: true }
    const afterConcurrentEdits = await getProduct(db, ORG, cabin.id)
    assert.deepEqual(afterConcurrentEdits.details, combinedRules)
    assert.equal(afterConcurrentEdits.stay?.check_in_time, '17:00')
    assert.equal(afterConcurrentEdits.stay?.check_out_time, '11:00')
    assert.deepEqual(JSON.parse((await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'))!), combinedRules)
    assert.deepEqual(await db.prepare('SELECT check_in_time, check_out_time FROM product_stay_configs WHERE product_id = ?').bind(cabin.id).first(), {
      check_in_time: '17:00', check_out_time: '11:00',
    })

    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: { quiet_hours: true, quiet_hours_start: '22:00', quiet_hours_end: '07:00' },
    } })
    const beforeRefusals = await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json')
    for (const patch of [
      { details_mode: 'merge', details: { quiet_hours: false } },
      { details_mode: 'merge', details: { quiet_hours_start: null } },
      { details_mode: 'merge', details: { quiet_hours_start: '22:30' } },
      { details_mode: 'merge', details: { unknown_rule: null } },
      { details: { pets_allowed: null } },
      { details_mode: 'replace', details: { house_rules: null } },
      { details_mode: 'unknown', details: {} },
      { details_mode: 'merge' },
    ]) {
      await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: patch as UpdateProductInput }),
        (error: unknown) => (error as { status: number }).status === 400)
      assert.equal(await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'), beforeRefusals)
    }

    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: { quiet_hours: null, quiet_hours_start: null, quiet_hours_end: null, smoking_allowed: null },
    } })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).details, {
      featured: true, your_property: 'A cabin with a sheltered terrace.', house_rules: 'Leave muddy shoes outside.',
      pets_allowed: true, events_allowed: false, commercial_photography_allowed: true,
    })
    // The default remains replacement, while featured retains its saved value.
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { details: { house_rules: 'Leave shoes at the door.' } } })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).details, { featured: true, house_rules: 'Leave shoes at the door.' })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { details_mode: 'merge', details: { pets_allowed: false } } })
    assert.equal((await getProduct(db, ORG, cabin.id)).details.pets_allowed, false)
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { details_mode: 'merge', details: { pets_allowed: null, house_rules: null } } })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).details, { featured: true })
    assert.deepEqual(JSON.parse((await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'))!), { featured: true })

    // Safety disclosures are public Product facts. An alarm continues to
    // belong only to the home's amenity selection while these facts change.
    const safetyDetails = {
      house_rules: 'Leave shoes at the door.', exterior_security_cameras: true, exterior_security_cameras_details: 'C'.repeat(300),
      noise_decibel_monitors: false, unsecured_pool: false, stairs_required: true, stairs_required_details: 'Two flights\nNo lift.',
      special_safety_considerations: 'An uneven path leads to the orchard.',
    }
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: safetyDetails, stay: { amenities: ['smoke_detector'] },
    } })
    const safetyProduct = await getProduct(db, ORG, cabin.id)
    assert.deepEqual(safetyProduct.details, { featured: true, ...safetyDetails })
    assert.deepEqual(safetyProduct.stay?.amenities, ['smoke_detector'])
    assert.deepEqual(JSON.parse((await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'))!), { featured: true, ...safetyDetails })
    const beforeSafetyRefusals = await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json')
    for (const { details, message } of [
      { details: { exterior_security_cameras_details: 'C'.repeat(301) }, message: /^exterior_security_cameras_details must be at most 300 characters$/ },
      { details: { special_safety_considerations: 'C'.repeat(301) }, message: /^special_safety_considerations must be at most 300 characters$/ },
      { details: { stairs_required: false }, message: /^details\.stairs_required_details requires details\.stairs_required to be true$/ },
      { details: { exterior_security_cameras: null }, message: /^details\.exterior_security_cameras_details requires details\.exterior_security_cameras to be true$/ },
      { details: { nearby_water_details: 'A canal crosses the garden.' }, message: /^details\.nearby_water_details requires details\.nearby_water to be true$/ },
      { details: { noise_decibel_monitors: 'yes' }, message: /^noise_decibel_monitors must be a boolean$/ },
    ]) {
      await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { details_mode: 'merge', details } }),
        (error: unknown) => (error as { status: number }).status === 400 && message.test((error as Error).message))
      assert.equal(await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'), beforeSafetyRefusals)
      assert.equal(await db.prepare('SELECT amenities FROM product_stay_configs WHERE product_id = ?').bind(cabin.id).first<string>('amenities'), '["smoke_detector"]')
    }
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: { exterior_security_cameras: false, exterior_security_cameras_details: null },
    } })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).details, {
      featured: true, house_rules: 'Leave shoes at the door.', exterior_security_cameras: false,
      noise_decibel_monitors: false, unsecured_pool: false, stairs_required: true, stairs_required_details: 'Two flights\nNo lift.',
      special_safety_considerations: 'An uneven path leads to the orchard.',
    })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: {
        exterior_security_cameras: null, exterior_security_cameras_details: null, noise_decibel_monitors: null,
        unsecured_pool: null, stairs_required: null, stairs_required_details: null, special_safety_considerations: null,
      },
    } })
    const clearedSafety = await getProduct(db, ORG, cabin.id)
    assert.deepEqual(clearedSafety.details, { featured: true, house_rules: 'Leave shoes at the door.' })
    assert.deepEqual(clearedSafety.stay?.amenities, ['smoke_detector'])
    assert.deepEqual(JSON.parse((await db.prepare('SELECT details_json FROM products WHERE id = ?').bind(cabin.id).first<string>('details_json'))!), { featured: true, house_rules: 'Leave shoes at the door.' })
    assert.equal(await db.prepare('SELECT amenities FROM product_stay_configs WHERE product_id = ?').bind(cabin.id).first<string>('amenities'), '["smoke_detector"]')

    // A disclosure and an amenity cannot make opposite claims about the same
    // property's parking, whichever focused editor supplies the contradiction.
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { amenities: ['smoke_detector', 'free_parking'] } } })
    const beforeParking = await db.prepare('SELECT p.details_json, c.amenities FROM products p JOIN product_stay_configs c ON c.product_id = p.id WHERE p.id = ?').bind(cabin.id).first()
    for (const patch of [
      { details_mode: 'merge', details: { no_property_parking: true } },
      { details_mode: 'merge', details: { no_property_parking: true }, stay: { amenities: ['smoke_detector', 'paid_parking_on_premises'] } },
    ] satisfies UpdateProductInput[]) {
      await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch }),
        (error: unknown) => (error as { status: number }).status === 400 && /^Remove on-property parking amenities or change “No parking on the property” before saving\.$/.test((error as Error).message))
      assert.deepEqual(await db.prepare('SELECT p.details_json, c.amenities FROM products p JOIN product_stay_configs c ON c.product_id = p.id WHERE p.id = ?').bind(cabin.id).first(), beforeParking)
    }
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: {
      details_mode: 'merge', details: { no_property_parking: true }, stay: { amenities: ['smoke_detector', 'paid_parking'] },
    } })
    const offPropertyParking = await getProduct(db, ORG, cabin.id)
    assert.deepEqual(offPropertyParking.details, { featured: true, house_rules: 'Leave shoes at the door.', no_property_parking: true })
    assert.deepEqual(offPropertyParking.stay?.amenities, ['smoke_detector', 'paid_parking'])
    const beforeParkingAmenities = await db.prepare('SELECT p.details_json, c.amenities FROM products p JOIN product_stay_configs c ON c.product_id = p.id WHERE p.id = ?').bind(cabin.id).first()
    for (const parking of ['free_parking', 'paid_parking_on_premises'] as const) {
      await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { amenities: ['smoke_detector', parking] } } }),
        (error: unknown) => (error as { status: number }).status === 400 && /^Remove on-property parking amenities or change “No parking on the property” before saving\.$/.test((error as Error).message))
      assert.deepEqual(await db.prepare('SELECT p.details_json, c.amenities FROM products p JOIN product_stay_configs c ON c.product_id = p.id WHERE p.id = ?').bind(cabin.id).first(), beforeParkingAmenities)
    }
  } finally {
    await runtime.dispose()
  }
})

test('authored photo rooms move photos atomically and follow the listing placements through removal without resurrecting membership', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('room-en', ?, 'en', 1, 'published')").bind(ORG).run()
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site', team: 'cleaning' })
    const lake = await home(db, env, { name: 'Lake house', location: 'lake-site' })
    // Like the CMS, carry the catalog item on the site while it is unlisted.
    await setProductPublication(db, { env, organizationId: ORG, productId: cabin.id, published: false, actor: { actorId: OWNER } })
    const membership = await resolveMembership(env, { organizationId: ORG, userId: OWNER })
    assert(membership)
    const principal = memberAccessPrincipal(membership, { env })
    // Existing library pictures can have room-like alt text and categories;
    // neither those nor aggregate bedroom counts author a room identity.
    for (const [id, alt, category] of [['room-a', 'A bedroom with a bed', 'interior'], ['room-b', 'A living room with chairs', 'interior'], ['room-c', 'An exterior deck', 'exterior'], ['room-library', 'Another bedroom', 'interior']] as const) {
      await db.prepare("INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, mime_type, width, height, alt_text, category, status) VALUES (?, ?, 'image', 'cloudflare_images', 'uploaded', ?, 'image/png', 1200, 800, ?, ?, 'active')")
        .bind(id, ORG, `https://imagedelivery.example.test/hash/${id}/public`, alt, category).run()
    }
    await arrangeProductPhotos(db, { organizationId: ORG, env, principal, productId: cabin.id, from: [], to: ['room-a', 'room-b', 'room-c'] })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { bedrooms: 2, beds: 3, bathrooms: 1 } } })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [])
    assert.deepEqual((await readStayHome(db, manager, cabin.id)).photo_rooms, [])

    const first = await createStayPhotoRoom(db, env, manager, cabin.id, { type: 'bedroom' })
    const intervening = await createStayPhotoRoom(db, env, manager, cabin.id, { type: 'living_room' })
    const second = await createStayPhotoRoom(db, env, manager, cabin.id, { type: 'bedroom' })
    assert.notEqual(first.room.id, second.room.id)
    const roomA = { id: first.room.id, type: 'bedroom' as const, photo_ids: [] as string[] }
    const roomB = { id: second.room.id, type: 'bedroom' as const, photo_ids: [] as string[] }
    // A bedroom added after a different type still groups with the original
    // bedroom, retaining creation order and identities within their type.
    const grouped = [roomA, roomB, { id: intervening.room.id, type: 'living_room' as const, photo_ids: [] }]
    const groupedProduct = await getProduct(db, ORG, cabin.id)
    assert.deepEqual(groupedProduct.stay?.photo_rooms, grouped)
    assert.deepEqual(groupedProduct.stay!.photo_rooms.map(room => stayPhotoRoomName(room, groupedProduct.stay!.photo_rooms)), ['Bedroom 1', 'Bedroom 2', 'Living room'])
    const groupedPublic = await loadPublicProductApiDetail(env, db, ORG, true, 'cabin-site', cabin.slug)
    assert(groupedPublic)
    assert.deepEqual(groupedPublic.product.stay?.photo_rooms, grouped)
    await removeStayPhotoRoom(db, env, manager, cabin.id, intervening.room.id)
    const retainedRooms = (await getProduct(db, ORG, cabin.id)).stay!.photo_rooms
    assert.deepEqual(retainedRooms, [roomA, roomB])
    assert.deepEqual(retainedRooms.map(room => stayPhotoRoomName(room, retainedRooms)), ['Bedroom 1', 'Bedroom 2'])
    await assert.rejects(createStayPhotoRoom(db, env, cleaner, cabin.id, { type: 'bedroom' }), { status: 403, data: { code: 'STAY_ROLE_REQUIRED' } })
    await assert.rejects(createStayPhotoRoom(db, env, manager, cabin.id, { type: 'invented_room' }), { status: 422, data: { code: 'INVALID_PHOTO_ROOM', field: 'type' } })
    const foreignRoom = await createStayPhotoRoom(db, env, manager, lake.id, { type: 'bedroom' })
    await assert.rejects(moveStayPhotos(db, env, manager, cabin.id, { room_id: foreignRoom.room.id, photos: [{ photo_id: 'room-a', expected_room_id: null }] }), { status: 404, data: { code: 'PHOTO_ROOM_NOT_FOUND', field: 'room_id' } })
    await assert.rejects(moveStayPhotos(db, env, manager, cabin.id, { room_id: roomA.id, photos: [{ photo_id: 'room-library', expected_room_id: null }] }), { status: 404, data: { code: 'PHOTO_NOT_FOUND', field: 'photo_id' } })

    await moveStayPhotos(db, env, manager, cabin.id, { room_id: roomA.id, photos: [{ photo_id: 'room-a', expected_room_id: null }, { photo_id: 'room-b', expected_room_id: null }] })
    const assigned = [{ ...roomA, photo_ids: ['room-a', 'room-b'] }, roomB]
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, assigned)
    // One stale selection refuses the whole move, including an atomic new-room
    // request: the valid sibling stays where it was and no empty room appears.
    for (const destination of [{ room_id: roomB.id }, { new_room_type: 'deck' }]) {
      await assert.rejects(moveStayPhotos(db, env, manager, cabin.id, { ...destination, photos: [{ photo_id: 'room-a', expected_room_id: roomA.id }, { photo_id: 'room-b', expected_room_id: null }] }), { status: 409, data: { code: 'PHOTOS_CHANGED', field: 'photos' } })
      assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, assigned)
    }
    await moveStayPhotos(db, env, manager, cabin.id, { new_room_type: 'living_room', photos: [{ photo_id: 'room-b', expected_room_id: roomA.id }, { photo_id: 'room-c', expected_room_id: null }] })
    const createdRooms = (await getProduct(db, ORG, cabin.id)).stay!.photo_rooms
    assert.equal(createdRooms.length, 3)
    const roomC = createdRooms[2]!
    assert.equal(roomC.type, 'living_room')
    assert.deepEqual(createdRooms, [{ ...roomA, photo_ids: ['room-a'] }, roomB, { ...roomC, photo_ids: ['room-b', 'room-c'] }])
    const race = await Promise.allSettled([
      moveStayPhotos(db, env, manager, cabin.id, { room_id: roomB.id, photos: [{ photo_id: 'room-a', expected_room_id: roomA.id }] }),
      moveStayPhotos(db, env, manager, cabin.id, { room_id: null, photos: [{ photo_id: 'room-a', expected_room_id: roomA.id }] }),
    ])
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    const refused = race.find(result => result.status === 'rejected')
    assert(refused?.status === 'rejected')
    assert.equal((refused.reason as { status: number }).status, 409)
    assert.equal((refused.reason as { data: { code: string } }).data.code, 'PHOTOS_CHANGED')
    const winner = race[0]!.status === 'fulfilled' ? roomB.id : null
    const afterRace = (await getProduct(db, ORG, cabin.id)).stay!.photo_rooms
    assert.deepEqual(afterRace, [roomA, { ...roomB, photo_ids: winner ? ['room-a'] : [] }, { ...roomC, photo_ids: ['room-b', 'room-c'] }])
    await moveStayPhotos(db, env, manager, cabin.id, { room_id: roomC.id, photos: [{ photo_id: 'room-a', expected_room_id: winner }] })

    // Reordering and a cover replacement retain authored membership even when
    // the placement operation deletes and reinserts its own rows internally.
    await reorderStayHomePhotos(db, env, manager, principal, cabin.id, { photo_ids: ['room-c', 'room-b', 'room-a'] })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-c', 'room-b', 'room-a'] }])
    await attachMediaPlacement(db, { organizationId: ORG, env, principal, placement: { owner_type: 'product', owner_id: cabin.id, slot: 'gallery' }, assetId: 'room-c' })
    await setSingleMediaPlacement(db, { organizationId: ORG, env, principal, placement: { owner_type: 'product', owner_id: cabin.id, slot: 'image' }, assetId: 'room-a' })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-a', 'room-b', 'room-c'] }])
    await removeMediaPlacement(db, { organizationId: ORG, env, principal, placement: { owner_type: 'product', owner_id: cabin.id, slot: 'gallery' }, assetId: 'room-c' })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-a', 'room-b'] }])
    await addStayHomePhoto(db, env, manager, principal, cabin.id, { asset_id: 'room-c' })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-a', 'room-b'] }])
    await removeStayHomePhoto(db, env, manager, principal, cabin.id, 'room-a')
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-b'] }])
    assert.equal((await getMediaAsset(db, 'room-a', ORG))?.status, 'active')
    await addStayHomePhoto(db, env, manager, principal, cabin.id, { asset_id: 'room-a' })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-b'] }])
    await deleteMediaAsset(db, env, 'room-b', ORG, OWNER)
    assert.equal((await getMediaAsset(db, 'room-b', ORG))?.status, 'deleted')
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: [] }])
    await assert.rejects(addStayHomePhoto(db, env, manager, principal, cabin.id, { asset_id: 'room-b' }), { status: 404, data: { code: 'PHOTO_NOT_FOUND', field: 'asset_id' } })
    await moveStayPhotos(db, env, manager, cabin.id, { room_id: roomC.id, photos: [{ photo_id: 'room-c', expected_room_id: null }, { photo_id: 'room-a', expected_room_id: null }] })
    await reorderStayHomePhotos(db, env, manager, principal, cabin.id, { photo_ids: ['room-c', 'room-a'] })
    const beforeRoomRemoval = await readStayHome(db, manager, cabin.id)
    assert.deepEqual(beforeRoomRemoval.photos.map(photo => photo.id), ['room-c', 'room-a'])
    assert.deepEqual(beforeRoomRemoval.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-c', 'room-a'] }])
    const publicDetail = await loadPublicProductApiDetail(env, db, ORG, true, 'cabin-site', cabin.slug)
    assert(publicDetail)
    assert.deepEqual(publicDetail.product.stay?.photo_rooms, beforeRoomRemoval.photo_rooms)
    // Replacing the only placement through the generic media owner clears its
    // old room too. Restoring the picture cannot restore that old membership.
    await setSingleMediaPlacement(db, { organizationId: ORG, env, principal, placement: { owner_type: 'product', owner_id: cabin.id, slot: 'image' }, assetId: 'room-library' })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-a'] }])
    await setSingleMediaPlacement(db, { organizationId: ORG, env, principal, placement: { owner_type: 'product', owner_id: cabin.id, slot: 'image' }, assetId: 'room-c' })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB, { ...roomC, photo_ids: ['room-a'] }])
    await removeStayPhotoRoom(db, env, manager, cabin.id, roomC.id)
    const afterRoomRemoval = await getProduct(db, ORG, cabin.id)
    assert.deepEqual(afterRoomRemoval.stay?.photo_rooms, [roomA, roomB])
    assert.deepEqual((await readStayHome(db, manager, cabin.id)).photos.map(photo => photo.id), ['room-c', 'room-a'])
    for (const photoId of ['room-c', 'room-a']) assert.equal((await getMediaAsset(db, photoId, ORG))?.status, 'active')
    await assert.rejects(removeStayPhotoRoom(db, env, manager, cabin.id, foreignRoom.room.id), { status: 404, data: { code: 'PHOTO_ROOM_NOT_FOUND', field: 'room_id' } })
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay?.photo_rooms, [roomA, roomB])
  } finally {
    await runtime.dispose()
  }
})

test('a stay holds its nights, and a held night refuses another stay even when two arrive at once', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const first = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })
    assert.equal(first.status, 'confirmed')
    assert.equal(first.owner, 'app')
    assert.equal(first.currency, 'USD')
    assert.equal(first.payment_status, 'unpaid')
    // The same key replays the same stay; a different stay under it is refused.
    assert.equal((await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })).id, first.id)
    await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-02', check_out_date: '2026-11-04', ...guest }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k2', check_in_date: '2026-11-03', check_out_date: '2026-11-06', ...guest }), code('STAY_OVERLAP'))
    // Checkout morning is the next guest's check-in.
    const next = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k3', check_in_date: '2026-11-04', check_out_date: '2026-11-06', ...guest })
    assert.equal(next.check_in_date, '2026-11-04')
    await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k4', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest, adults: 5 }), code('INVALID_STAY_FIELD'))

    const racers = await Promise.allSettled(['r1', 'r2', 'r3'].map(key => createStay(db, env, manager, { product_id: cabin.id, idempotency_key: key, check_in_date: '2026-12-01', check_out_date: '2026-12-05', ...guest })))
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of racers.filter(result => result.status === 'rejected')) assert(code('STAY_OVERLAP')((result as PromiseRejectedResult).reason))
    const claims = await db.prepare("SELECT count(*) AS n FROM stay_nights WHERE product_id = ? AND date >= '2026-12-01' AND date < '2026-12-05'").bind(cabin.id).first<{ n: number }>()
    assert.equal(claims?.n, 4)
  } finally {
    await runtime.dispose()
  }
})

test('editing and cancelling a stay move and free exactly its nights, under its version', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'a', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'b', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest })
    await assert.rejects(updateStay(db, env, manager, stay.id, { expected_version: 99, check_out_date: '2026-11-04' }), code('STAY_VERSION_CONFLICT'))
    await assert.rejects(updateStay(db, env, manager, stay.id, { expected_version: 1, check_in_date: '2026-11-09', check_out_date: '2026-11-11' }), code('STAY_OVERLAP'))
    // A refused move leaves the stay and its nights where they were.
    assert.deepEqual((await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-03' })).nights.map(night => night.stay_id), [stay.id, stay.id])
    const moved = await updateStay(db, env, manager, stay.id, { expected_version: 1, check_in_date: '2026-11-05', check_out_date: '2026-11-08', guest_phone: '+61491570154' })
    assert.equal(moved.version, 2)
    assert.equal(moved.guest_phone, '+61491570154')
    const calendar = await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-09' })
    // The calendar reads its full 500 nights, with the stays in them.
    const year = await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2028-03-15' })
    assert.equal(year.nights.length, 500)
    assert.ok(year.stays.some(row => row.id === stay.id))
    assert.deepEqual(calendar.nights.map(night => night.available), [true, true, true, true, false, false, false, true])
    assert.equal(calendar.nights[0]!.price_minor, 15_000)
    // Two edits from the same version race; whichever wins, the nights held are the winner's.
    const racers = await Promise.allSettled([
      updateStay(db, env, manager, stay.id, { expected_version: 2, check_in_date: '2026-11-20', check_out_date: '2026-11-22' }),
      updateStay(db, env, manager, stay.id, { expected_version: 2, check_in_date: '2026-11-25', check_out_date: '2026-11-28' }),
    ])
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1)
    const winner = await getStay(db, manager, stay.id)
    const held = await db.prepare('SELECT date FROM stay_nights WHERE stay_id = ? ORDER BY date').bind(stay.id).all<{ date: string }>()
    const expected: string[] = []
    for (let day = Date.parse(`${winner.check_in_date}T00:00:00Z`); day < Date.parse(`${winner.check_out_date}T00:00:00Z`); day += 86_400_000) expected.push(new Date(day).toISOString().slice(0, 10))
    assert.deepEqual(held.results.map(row => row.date), expected)
    const cancelled = await cancelStay(db, env, manager, stay.id, { expected_version: 3, reason: 'Guest changed plans' })
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(cancelled.cancelled_at)
    assert(((await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-05', to: '2026-11-30' })).nights).every(night => night.stay_id !== stay.id))
    await assert.rejects(updateStay(db, env, manager, stay.id, { expected_version: 4, adults: 1 }), code('STAY_NOT_EDITABLE'))
    assert.deepEqual((await listStays(db, manager, { from: '2026-11-01', to: '2026-12-01' })).map(row => row.id).includes(stay.id), false)
    assert.equal((await listStays(db, manager, { from: '2026-11-01', to: '2026-12-01', includeCancelled: true })).some(row => row.id === stay.id), true)
    const audit = await db.prepare("SELECT event_name FROM activity_entries WHERE organization_id = ? AND event_name LIKE 'stay.%' ORDER BY occurred_at, event_name").bind(ORG).all<{ event_name: string }>()
    assert.deepEqual(audit.results.map(row => row.event_name).sort(), ['stay.cancelled', 'stay.created', 'stay.created', 'stay.updated', 'stay.updated'])
  } finally {
    await runtime.dispose()
  }
})

test('a channel stay is read-only here and is paid through its channel; an app stay records offline payments', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    await db.prepare(`INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, adults, guest_name, total_minor, currency, provider, external_booking_id, created_at, updated_at)
      VALUES ('airbnb-1', ?, ?, 'airbnb', 'channel', 'confirmed', '2026-11-20', '2026-11-22', 2, 'Bo', 30000, 'USD', 'channex', 'chx-1', ?, ?)`).bind(ORG, cabin.id, NOW, NOW).run()
    await assert.rejects(updateStay(db, env, manager, 'airbnb-1', { expected_version: 1, adults: 1 }), code('STAY_NOT_EDITABLE'))
    await assert.rejects(cancelStay(db, env, manager, 'airbnb-1', { expected_version: 1 }), code('STAY_NOT_EDITABLE'))
    await assert.rejects(recordStayPayment(db, env, manager, 'airbnb-1', { amount_minor: 100, method: 'cash', paid_on: '2026-11-20', idempotency_key: 'pay-1' }), code('STAY_NOT_EDITABLE'))
    assert.equal((await getStay(db, manager, 'airbnb-1')).payment_status, null)

    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'p', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })
    await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 0, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'pay-2' }), code('INVALID_AMOUNT'))
    await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 100, method: 'crypto', paid_on: '2026-11-01', idempotency_key: 'pay-3' }), code('INVALID_STAY_FIELD'))
    const partial = await recordStayPayment(db, env, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4' })
    assert.deepEqual([partial.paid_minor, partial.payment_status, partial.payments.length], [20_000, 'partial', 1])
    // A retried record is the same payment; the same key for another payment is refused.
    const retried = await recordStayPayment(db, env, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4' })
    assert.equal(retried.payments.length, 1)
    await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 1, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'pay-4' }), code('IDEMPOTENCY_CONFLICT'))
    const paid = await recordStayPayment(db, env, manager, stay.id, { amount_minor: 25_000, method: 'bank_transfer', paid_on: '2026-11-02', idempotency_key: 'pay-5' })
    assert.deepEqual([paid.paid_minor, paid.payment_status], [45_000, 'paid'])
    const refunded = await recordStayPayment(db, env, manager, stay.id, { amount_minor: -5_000, method: 'cash', paid_on: '2026-11-03', note: 'Early checkout', idempotency_key: 'pay-6' })
    assert.equal(refunded.payment_status, 'partial')
    const removed = await deleteStayPayment(db, env, manager, stay.id, refunded.payments.find(payment => payment.amount_minor === -5_000)!.id)
    assert.deepEqual([removed.paid_minor, removed.payment_status], [45_000, 'paid'])
    await assert.rejects(deleteStayPayment(db, env, manager, stay.id, 'missing'), code('PAYMENT_NOT_FOUND'))
  } finally {
    await runtime.dispose()
  }
})

test('the host sets nights apart from the defaults and resets them', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    await assert.rejects(setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-04' }), /at least one night setting/)
    const closed = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-03', closed: true })
    assert.deepEqual(closed.nights.map(night => [night.available, night.source]), [[false, 'host'], [false, 'host']])
    const priced = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-02', to: '2026-11-04', price_minor: 20_000, min_stay_arrival: 3 })
    assert.deepEqual(priced.nights.map(night => [night.date, night.closed, night.price_minor, night.min_stay_arrival]), [['2026-11-02', true, 20_000, 3], ['2026-11-03', false, 20_000, 3]])
    const based = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-03', to: '2026-11-04', price_minor: null })
    assert.equal(based.nights[0]!.price_minor, 15_000)
    const reset = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-04', reset: true })
    assert(reset.nights.every(night => night.available && night.source === null && night.price_minor === 15_000))
    // A closed night is the host's choice for guests; it does not hold a stay the host takes themselves.
    await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-10', to: '2026-11-11', closed: true })
    await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'closed', check_in_date: '2026-11-10', check_out_date: '2026-11-11', ...guest })
  } finally {
    await runtime.dispose()
  }
})

test('members see only the homes they look after and change nothing; a home with stays is not deleted', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site', team: 'cleaning' })
    const lake = await home(db, env, { name: 'Lake house', location: 'lake-site' })
    const cabinStay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'c', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    const lakeStay = await createStay(db, env, manager, { product_id: lake.id, idempotency_key: 'l', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    assert.deepEqual((await listStays(db, cleaner, { from: '2026-11-01', to: '2026-11-30' })).map(stay => stay.id), [cabinStay.id])
    assert.deepEqual(await listStays(db, outsider, { from: '2026-11-01', to: '2026-11-30' }), [])
    assert.equal((await getStay(db, cleaner, cabinStay.id)).id, cabinStay.id)
    await assert.rejects(getStay(db, cleaner, lakeStay.id), code('STAY_NOT_FOUND'))
    await assert.rejects(readStayCalendar(db, cleaner, { productId: lake.id, from: '2026-11-01', to: '2026-11-03' }), code('HOME_NOT_FOUND'))
    await assert.rejects(createStay(db, env, cleaner, { product_id: cabin.id, idempotency_key: 'x', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest }), code('STAY_ROLE_REQUIRED'))
    await assert.rejects(cancelStay(db, env, cleaner, cabinStay.id, { expected_version: 1 }), code('STAY_ROLE_REQUIRED'))
    await assert.rejects(deleteProduct(db, { env, organizationId: ORG, productId: cabin.id }), /has bookings or stays/)
    assert.equal((await getProduct(db, ORG, cabin.id)).id, cabin.id)
  } finally {
    await runtime.dispose()
  }
})

test('a business’s site shows a guest the stay its signed link names, from any browser, and nothing else', { timeout: 120_000 }, async () => {
  const { runtime, db, env: bindings } = await boot()
  try {
    const env = { ...bindings, BETTER_AUTH_URL: 'https://org.proof.example', BETTER_AUTH_SECRET: 'local-stay-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-stay-reply', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const address = { regionCode: 'US', addressLines: ['12 Test Road', 'Apartment 4', 'East building'], languageCode: 'en', locality: 'Boulder', sublocality: 'North Boulder', administrativeArea: 'Colorado', postalCode: '80301' }
    const location = { address, latitude: 40.014984, longitude: -105.270546, maps_url: 'https://maps.google.com/?cid=123456' }
    assert.equal((await updateLocation(db, ORG, 'cabin-site', location, OWNER, env)).status, 200)
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'site-stay', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest, guest_email: 'ana@example.com' })
    // A manual, pay-on-arrival stay is confirmed before collecting money. Its
    // existing guest invite gives the Better Auth guest their own stay.
    const signIn = async () => {
      const signed = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
      return { id: signed.response!.user.id, cookie: signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    }
    const booker = await signIn()
    const otherGuest = await signIn()
    assert(stay.request_id)
    const invite = await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: stay.request_id, actorUserId: OWNER })
    const token = new URL(invite.url).pathname.split('/').at(-1)!
    assert.equal((await claimGuestThreadInvite(db, { token, userId: booker.id })).thread_id, stay.request_id)
    // The guest's stay is read by its activity ID: its conversation's, as the account reads it.
    const activityId = stay.request_id ?? stay.id
    // The link the confirmation email and the paid return carry, signed with the site's secret.
    const link = (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET, activityId)).token
    const otherLink = (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET, 'another-stay')).token
    const read = (organizationId: string, token?: string) => {
      const app = new H3()
      app.use((event) => { event.context.organizationId = organizationId })
      app.get('/api/public/guest-stays/:activityId', guestStayRoute)
      return app.request(Object.assign(new Request(`https://org.proof.example/api/public/guest-stays/${activityId}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }
    const accountRead = (cookie?: string) => {
      const app = new H3()
      app.get('/api/account/stays/:activityId', accountStayRoute)
      return app.request(Object.assign(new Request(`https://proof.example/api/account/stays/${activityId}`, { headers: cookie ? { cookie } : {} }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }

    // No session is sent: the link alone opens the stay, as from the email on another device.
    const own = await read(ORG, link)
    assert.equal(own.status, 200)
    assert.equal(own.headers.get('cache-control'), 'private, no-store')
    const body = await own.json() as GuestStay
    const { location: guestLocation, ...guestHome } = body.home
    assert.deepEqual({ organization_id: body.organization_id, id: body.stay.id, email: body.stay.guest_email, policy: body.stay.cancellation_policy, dates: [body.stay.check_in_date, body.stay.check_out_date], home: guestHome, cancellation: body.cancellation },
      { organization_id: ORG, id: stay.id, email: 'ana@example.com', policy: null, dates: ['2026-11-01', '2026-11-04'], home: { name: 'Cabin', organization_name: 'Org', check_in_time: '16:00', check_out_time: '10:00', image_url: null }, cancellation: null })
    assert(guestLocation?.maps_url)
    assert.deepEqual({ address: guestLocation.address, latitude: guestLocation.latitude, longitude: guestLocation.longitude }, { address, latitude: 40.014984, longitude: -105.270546 })
    assert.equal(new URL(guestLocation.maps_url).origin, 'https://maps.google.com')
    assert.equal(new URL(guestLocation.maps_url).searchParams.get('q'), '40.014984,-105.270546')
    assert.equal(new URL(guestLocation.maps_url).searchParams.has('cid'), false)
    assert.deepEqual({ status: body.stay.status, payment: body.stay.payment_status, paid: body.stay.paid_minor }, { status: 'confirmed', payment: 'unpaid', paid: 0 })
    const account = await accountRead(booker.cookie)
    assert.equal(account.status, 200)
    assert.equal(account.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual((await account.json() as GuestStay).home.location, guestLocation)
    assert.equal((await accountRead(otherGuest.cookie)).status, 404)
    assert.equal((await accountRead()).status, 401)
    assert.equal((await read('another-org', link)).status, 404)
    assert.equal((await read(ORG, otherLink)).status, 404)
    assert.equal((await read(ORG)).status, 401)

    // The mutation response must carry the saved pin on an address-only edit
    // and on clearing just the address, as the focused editor reads it back.
    for (const nextAddress of [{ ...address, locality: 'Longmont' }, null, address]) {
      const edited = await updateLocation(db, ORG, 'cabin-site', { address: nextAddress }, OWNER, env)
      assert.equal(edited.status, 200)
      assert('location' in edited.data && edited.data.location)
      assert.deepEqual({ latitude: edited.data.location.latitude, longitude: edited.data.location.longitude }, { latitude: 40.014984, longitude: -105.270546 })
      assert.equal(edited.data.location.maps_url, location.maps_url)
      assert.equal(await db.prepare("SELECT maps_url FROM business_locations WHERE id = 'cabin-site'").first('maps_url'), location.maps_url)
      const saved = await read(ORG, link)
      assert.equal(saved.status, 200)
      const savedLocation = (await saved.json() as GuestStay).home.location
      assert(savedLocation)
      assert.deepEqual({ address: savedLocation.address, latitude: savedLocation.latitude, longitude: savedLocation.longitude }, { address: nextAddress, latitude: 40.014984, longitude: -105.270546 })
    }

    // A broken stored pin fails visibly, rather than exposing a half pin or
    // replacing invalid coordinates with a guessed destination.
    for (const [latitude, longitude, field] of [[40.014984, null, 'longitude'], [91, -105.270546, 'latitude']] as const) {
      await db.prepare("UPDATE business_locations SET latitude = ?, longitude = ? WHERE id = 'cabin-site'").bind(latitude, longitude).run()
      for (const response of [await read(ORG, link), await accountRead(booker.cookie)]) {
        assert.equal(response.status, 500)
        const refusal = await response.json() as { data: { code: string; field: string } }
        assert.deepEqual(refusal.data, { code: 'INVALID_STORED_LOCATION', field })
      }
      assert.equal((await updateLocation(db, ORG, 'cabin-site', location, OWNER, env)).status, 200)
      const restored = await read(ORG, link)
      assert.equal(restored.status, 200)
      assert.deepEqual((await restored.json() as GuestStay).home.location, guestLocation)
    }

    // A confirmed guest sees only facts the location actually has.
    const cleared = await updateLocation(db, ORG, 'cabin-site', { address: null, latitude: null, longitude: null, maps_url: null }, OWNER, env)
    assert.equal(cleared.status, 200)
    assert('location' in cleared.data && cleared.data.location)
    assert.deepEqual({ latitude: cleared.data.location.latitude, longitude: cleared.data.location.longitude }, { latitude: null, longitude: null })
    const unset = await read(ORG, link)
    assert.equal(unset.status, 200)
    assert.deepEqual((await unset.json() as GuestStay).home.location, { address: null, latitude: null, longitude: null, maps_url: null })
    assert.equal((await updateLocation(db, ORG, 'cabin-site', location, OWNER, env)).status, 200)

    // Pending app records are not currently made by checkout, but stored
    // unconfirmed state must never disclose an exact location through either read.
    await db.prepare("UPDATE stays SET status = 'pending' WHERE id = ?").bind(stay.id).run()
    for (const response of [await read(ORG, link), await accountRead(booker.cookie)]) {
      assert.equal(response.status, 200)
      const pending = await response.json() as GuestStay
      assert.equal(pending.stay.status, 'pending')
      assert.equal(pending.home.location, null)
      for (const exact of [address.addressLines[0]!, String(location.latitude), String(location.longitude), location.maps_url]) assert(!JSON.stringify(pending).includes(exact))
    }
    await db.prepare("UPDATE stays SET status = 'confirmed' WHERE id = ?").bind(stay.id).run()
    await cancelStay(db, env, manager, stay.id, { expected_version: stay.version })
    for (const response of [await read(ORG, link), await accountRead(booker.cookie)]) {
      assert.equal(response.status, 200)
      const cancelled = await response.json() as GuestStay
      assert.equal(cancelled.stay.status, 'cancelled')
      assert.equal(cancelled.home.location, null)
      for (const exact of [address.addressLines[0]!, String(location.latitude), String(location.longitude), location.maps_url]) assert(!JSON.stringify(cancelled).includes(exact))
    }
    // The link lasts as a booking's does: thirty days from when the stay was booked.
    await db.prepare("UPDATE stays SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - 31 * 86_400_000).toISOString(), stay.id).run()
    assert.equal((await read(ORG, link)).status, 410)
  } finally {
    await runtime.dispose()
  }
})

test('a stay paid on a business’s site returns to that site’s stay confirmation, whose link opens it from any browser', { timeout: 120_000 }, async t => {
  const { runtime, db, env: bindings } = await boot()
  try {
    // A demo business on the live platform pays in Stripe test mode, which bills no usage.
    const env = { ...bindings, BETTER_AUTH_URL: 'https://org.proof.example', BETTER_AUTH_SECRET: 'local-stay-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-stay-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_live_local_boundary', STRIPE_TEST_SECRET_KEY: 'sk_test_local_boundary' }
    // The guest's notices are written in the business's source language.
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const location = { address: { regionCode: 'TH', addressLines: ['56 Test Lane', 'Villa 8', 'Garden entrance'], languageCode: 'th', locality: 'Krabi Town', sublocality: 'Ao Nang', administrativeArea: 'Krabi', postalCode: '81180' }, latitude: 8.0326, longitude: 98.822, maps_url: null }
    assert.equal((await updateLocation(db, ORG, 'cabin-site', location, OWNER, env)).status, 200)
    const signed = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    const buyer = signed.response!.user.id
    const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    // The checkout's own anonymous guest owns the stay until the paying browser proves the purchase.
    const checkoutSigned = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    const checkoutGuest = checkoutSigned.response!.user.id
    const checkoutCookie = checkoutSigned.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    // The stay a captured checkout made, as its conversion leaves it: the hold converted to it, the payment captured for it.
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'checkout:stay-pay', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest, guest_email: 'ana@example.com' })
    await db.prepare("UPDATE stays SET user_id = ?, cancellation_policy = 'moderate' WHERE id = ?").bind(checkoutGuest, stay.id).run()
    const nightly = ['2026-11-01', '2026-11-02', '2026-11-03'].map(date => ({ date, price_minor: 15_000 }))
    const purchase = { product_id: cabin.id, location_id: 'cabin-site', timezone: 'America/Denver', check_in_date: '2026-11-01', check_out_date: '2026-11-04', adults: 2, children: 0, infants: 0, total_minor: 45_000, currency: 'USD', cancellation_policy: 'moderate', nightly, guest: { name: 'Ana', email: 'ana@example.com', phone: null, notes: null } }
    await db.prepare(`INSERT INTO payments (id, organization_id, buyer_user_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, captured_amount, state, stripe_payment_intent_id, price_snapshot_json, created_at, updated_at)
      VALUES ('stay-pay', ?, ?, 'acct_seller', 0, 'stay', ?, 'cabin-site', 'USD', 45000, 45000, 'captured', 'pi_stay-pay', ?, ?, ?)`).bind(ORG, checkoutGuest, stay.id, JSON.stringify({ title: 'Cabin', quantity: 1, price: { unit_amount: 45_000, currency: 'USD' }, method_configuration_id: 'pmc_test', stay: purchase }), NOW, NOW).run()
    await db.prepare(`INSERT INTO payment_checkout_holds (id, organization_id, product_id, location_id, timezone, buyer_user_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, converted_stay_id, expires_at, created_at)
      VALUES ('stay-hold', ?, ?, 'cabin-site', 'America/Denver', ?, 'stay-pay', 2, 45000, 'USD', '2026-11-01', '2026-11-04', 'converted', ?, '2099-01-01T00:00:00.000Z', ?)`).bind(ORG, cabin.id, checkoutGuest, stay.id, NOW).run()
    const claim = crypto.randomUUID() + crypto.randomUUID()
    await db.prepare("INSERT INTO payment_attempts (id, payment_id, idempotency_key, stripe_payment_intent_id, return_token, status, expires_at, created_at, updated_at) VALUES ('a:stay-pay', 'stay-pay', 'checkout:stay', 'pi_stay-pay', ?, 'open', '2099-01-01T00:00:00.000Z', ?, ?)").bind(claim, NOW, NOW).run()
    await db.prepare("INSERT INTO payment_claims (token_hash, payment_id, expires_at) VALUES (?, 'stay-pay', '2099-01-01T00:00:00.000Z')").bind(await tokenHash(claim)).run()
    const charge = { id: 'ch_stay', object: 'charge', livemode: false, amount: 45_000, currency: 'usd', created: 1_790_000_000, payment_intent: 'pi_stay-pay', payment_method: 'pm_card', receipt_url: 'https://pay.stripe.com/receipts/stay', billing_details: { email: 'ana@example.com' } }
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      assert.equal(init?.method, 'GET')
      assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
      if (url.pathname === '/v1/charges/ch_stay') return Response.json(charge)
      assert.equal(url.pathname, '/v1/payment_intents/pi_stay-pay')
      return Response.json({ id: 'pi_stay-pay', object: 'payment_intent', livemode: false, currency: 'usd', amount: 45_000, amount_received: 45_000, status: 'succeeded', customer: null, application_fee_amount: null, latest_charge: charge, metadata: { krabiclaw_payment_id: 'stay-pay' } })
    })
    const app = new H3()
    app.use((event) => { event.context.organizationId = ORG })
    app.post('/api/public/payments/:paymentId/return', paymentReturnRoute)
    app.get('/api/public/guest-stays/:activityId', guestStayRoute)
    app.get('/api/account/stays/:activityId', accountStayRoute)
    const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = { cookie }) => app.request(Object.assign(new Request(`https://org.proof.example${path}`, { ...init, headers: { ...headers, 'content-type': 'application/json' } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))

    const activityId = stay.request_id ?? stay.id
    // The stay is read by its signed link, not by a browser's session: none, or a forged one, opens nothing.
    assert.equal((await call(`/api/public/guest-stays/${activityId}`)).status, 401)
    assert.equal((await call(`/api/public/guest-stays/${activityId}`, {}, { authorization: 'Bearer forged' })).status, 404)
    const back = await call('/api/public/payments/stay-pay/return', { method: 'POST', body: JSON.stringify({ claim }) })
    assert.equal(back.status, 200)
    const returned = await back.json() as { state: string; kind: string; activity_id: string; receipt_token: string }
    assert.deepEqual({ state: returned.state, kind: returned.kind, activity_id: returned.activity_id }, { state: 'paid', kind: 'stay', activity_id: activityId })
    assert.equal(typeof returned.receipt_token, 'string')
    assert.deepEqual(await db.prepare("SELECT claimed_user_id FROM payment_claims WHERE payment_id = 'stay-pay'").first(), { claimed_user_id: buyer })
    // The claim moved the stay, its payment and its hold to the browser that paid.
    assert.deepEqual(await db.prepare("SELECT (SELECT user_id FROM stays WHERE id = ?) AS stay, (SELECT buyer_user_id FROM payments WHERE id = 'stay-pay') AS payment, (SELECT buyer_user_id FROM payment_checkout_holds WHERE id = 'stay-hold') AS hold").bind(stay.id).first(), { stay: buyer, payment: buyer, hold: buyer })
    // The confirmation page reads the stay its link names, here from a browser with no session at all, as
    // the emailed link is opened. What was paid and the policy come from the conversion seeded above
    // (conversion is covered by its own tests); this checks the receipt read shows them.
    const read = await call(`/api/public/guest-stays/${activityId}`, {}, { authorization: `Bearer ${returned.receipt_token}` })
    assert.equal(read.status, 200)
    const body = await read.json() as GuestStay
    assert.deepEqual({ id: body.stay.id, paid: body.stay.paid_minor, policy: body.stay.cancellation_policy, email: body.stay.guest_email, quote: body.cancellation && { policy: body.cancellation.policy, paid: body.cancellation.paid_minor } },
      { id: stay.id, paid: 45_000, policy: 'moderate', email: 'ana@example.com', quote: { policy: 'moderate', paid: 45_000 } })
    assert(body.home.location?.maps_url)
    assert.deepEqual({ address: body.home.location.address, latitude: body.home.location.latitude, longitude: body.home.location.longitude }, { address: location.address, latitude: 8.0326, longitude: 98.822 })
    assert.equal(new URL(body.home.location.maps_url).searchParams.get('q'), '8.0326,98.822')
    const account = await call(`/api/account/stays/${activityId}`)
    assert.equal(account.status, 200)
    assert.deepEqual((await account.json() as GuestStay).home.location, body.home.location)
    assert.equal((await call(`/api/account/stays/${activityId}`, {}, { cookie: checkoutCookie })).status, 404)
  } finally {
    await runtime.dispose()
  }
})

test('home location sharing protects every public projection after localization while ordinary business locations remain public', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    // A mixed catalog owns a private home and an ordinary public branch. The
    // unpublished home's location remains private even on another product.
    await db.prepare("UPDATE organization SET vertical = 'restaurant' WHERE id = ?").bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('public-en', ?, 'en', 1, 'published'), ('public-th', ?, 'th', 0, 'published')").bind(ORG, ORG).run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('public-growth', 'growth', ?, 'active', 4102444800)").bind(ORG).run()
    const address = { regionCode: 'TH', addressLines: ['56 Private Lane', 'Villa 8', 'Garden entrance'], languageCode: 'en', locality: 'Krabi Town', sublocality: 'Ao Nang', administrativeArea: 'Krabi', postalCode: '81180' }
    const location = { address, latitude: 8.0326, longitude: 98.822, maps_url: 'https://maps.google.com/?cid=private-cid', google_place_id: 'private-place-id', google_review_url: 'https://search.google.com/local/writereview?placeid=private-place-id' }
    const branchAddress = { regionCode: 'US', addressLines: ['123 Public Street'], locality: 'Boulder', administrativeArea: 'Colorado', postalCode: '80301' }
    assert.equal((await updateLocation(db, ORG, 'cabin-site', location, OWNER, env)).status, 200)
    assert.equal((await updateLocation(db, ORG, 'lake-site', { address: branchAddress, latitude: 40.014984, longitude: -105.270546, maps_url: 'https://maps.google.com/?cid=public-cid', google_place_id: 'public-place-id' }, OWNER, env)).status, 200)
    const beforeInvalidMap = await db.prepare("SELECT maps_url, updated_at FROM business_locations WHERE id = 'cabin-site'").first()
    const beforeLocationCount = await db.prepare('SELECT count(*) FROM business_locations').first('count(*)')
    for (const [mapsUrl, error] of [['not a map URL', 'Invalid URL'], ['javascript:alert(1)', 'A map URL must use HTTP or HTTPS']] as const) {
      const refusal = { status: 400, data: { error, code: 'INVALID_LOCATION_FIELD', field: 'maps_url' } }
      assert.deepEqual(await updateLocation(db, ORG, 'cabin-site', { maps_url: mapsUrl }, OWNER, env), refusal)
      assert.deepEqual(await createLocation(env, db, ORG, { title: 'Invalid map location', timezone: 'UTC', maps_url: mapsUrl }, OWNER), refusal)
      assert.deepEqual(await db.prepare("SELECT maps_url, updated_at FROM business_locations WHERE id = 'cabin-site'").first(), beforeInvalidMap)
      assert.equal(await db.prepare('SELECT count(*) FROM business_locations').first('count(*)'), beforeLocationCount)
    }
    const emptyMap = await updateLocation(db, ORG, 'cabin-site', { maps_url: '' }, OWNER, env)
    assert.equal(emptyMap.status, 200)
    assert('location' in emptyMap.data && emptyMap.data.location)
    assert.equal(emptyMap.data.location.maps_url, '')
    assert.equal(await db.prepare("SELECT maps_url FROM business_locations WHERE id = 'cabin-site'").first('maps_url'), '')
    assert.equal((await updateLocation(db, ORG, 'cabin-site', { maps_url: location.maps_url }, OWNER, env)).status, 200)
    await home(db, env, { name: 'Private cabin', location: 'cabin-site' })
    const dish = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'dish', name: 'Lunch', variants: [{ name: 'Default', prices: [{ unit_amount: 1500, currency: 'USD' }] }] } })
    await setProductPublication(db, { env, organizationId: ORG, productId: dish.id, published: true, actor: { actorId: OWNER } })
    await setProductLocation(db, { env, organizationId: ORG, productId: dish.id, locationId: 'cabin-site', published: true, actor: { actorId: OWNER } })
    const translatedStreet = '56 ถนนส่วนตัว'
    await putResourceLocalization(env, db, { organizationId: ORG, resourceType: 'business_location', resourceId: 'cabin-site', locale: 'th', userId: OWNER,
      values: { title: 'ที่พักส่วนตัว', address: { addressLines: [translatedStreet, 'วิลลา 8'], locality: 'เมืองกระบี่', sublocality: 'อ่าวนาง', administrativeArea: 'กระบี่' } } })
    await putResourceLocalization(env, db, { organizationId: ORG, resourceType: 'product', resourceId: dish.id, locale: 'th', userId: OWNER, values: { name: 'อาหารกลางวัน' } })
    await createContentDocumentWithBlocks(db, { id: 'public-home', organizationId: ORG, kind: 'page', rowRole: 'root', locale: 'en', title: 'Home', path: '/', status: 'published', visibility: 'listed', metadata: { page_type: 'custom' } },
      [{ id: 'public-location-grid', type: 'location_grid', data: { location_ids: ['cabin-site', 'lake-site'] } }])
    await createContentDocumentWithBlocks(db, { id: 'public-home-th', organizationId: ORG, kind: 'page', rowRole: 'representation', rootId: 'public-home', locale: 'th', title: 'หน้าแรก', path: '/' },
      [{ id: 'public-location-grid-th', type: 'location_grid', data: { location_ids: ['cabin-site'] } }])
    const reference = 'https://www.google.com/maps/reviews/data=private-review'
    const flag = 'https://www.google.com/maps/review/report?placeid=private-place-id'
    const metadata = { author_uri: null, author_photo_uri: null, language_code: 'en', original_text: null, original_language_code: null, flag_content_uri: flag, visit_date: null }
    for (const [id, locationId] of [['private-review', 'cabin-site'], ['public-review', 'lake-site']] as const) {
      await db.prepare("INSERT INTO reviews (id, organization_id, location_id, author_name, rating, content, source, status, original_reference, google_review_metadata) VALUES (?, ?, ?, 'Ana', 5, 'A lovely visit', 'google_places', 'approved', ?, ?)")
        .bind(id, ORG, locationId, reference, JSON.stringify(metadata)).run()
    }
    // Existing generated artifacts may still contain an address drawn before
    // privacy was enabled. Reading must exclude them without depending on a
    // cleanup having already run; an ordinary branch keeps its generated card.
    const privateCard = 'https://imagedelivery.example.test/hash/old-private-card/public'
    const privateHero = 'https://imagedelivery.example.test/hash/private-hero/public'
    const publicCard = 'https://imagedelivery.example.test/hash/public-card/public'
    const publicHero = 'https://imagedelivery.example.test/hash/public-hero/public'
    for (const [assetId, locationId, slot, url] of [
      ['old-private-card', 'cabin-site', 'social_card', privateCard], ['private-hero', 'cabin-site', 'hero', privateHero],
      ['public-card', 'lake-site', 'social_card', publicCard], ['public-hero', 'lake-site', 'hero', publicHero],
    ] as const) {
      await db.prepare("INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, mime_type, width, height, generation_key, status, created_at, updated_at) VALUES (?, ?, 'image', 'cloudflare_images', ?, ?, 'image/png', 1200, 630, ?, 'active', ?, ?)")
        .bind(assetId, ORG, slot === 'social_card' ? 'generated' : 'uploaded', url, slot === 'social_card' ? `historical-${assetId}` : null, NOW, NOW).run()
      await db.prepare("INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at) VALUES (?, ?, 'business_location', ?, ?, ?, 0, 'active', ?, ?)")
        .bind(`placement-${assetId}`, ORG, locationId, slot, assetId, NOW, NOW).run()
    }
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_id = 'cabin-site' AND slot = 'social_card' AND status = 'active'").first('count(*)'), 1)
    const retained = await loadPublicSocialMedia(db, ORG, 'business_location', ['cabin-site', 'lake-site'])
    assert.equal(retained.get('cabin-site')?.social_image?.url, privateHero)
    assert.equal(retained.get('lake-site')?.social_image?.url, publicCard)
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_id = 'cabin-site' AND slot = 'social_card' AND status = 'active'").first('count(*)'), 1)

    const app = new H3()
    app.use(event => { event.context.organizationId = ORG })
    app.get('/api/public/locations', publicLocationsRoute)
    app.get('/api/public/locations/:slug', publicLocationRoute)
    app.get('/api/public/page', publicPageRoute)
    app.get('/shell', event => loadPublicShellSource(event, ORG, { locale: getQuery(event).locale as string | undefined }))
    const read = (path: string) => app.request(Object.assign(new Request(`https://org.localhost${path}`), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    const originalVersion = await db.prepare("SELECT updated_at FROM business_locations WHERE id = 'cabin-site'").first<string>('updated_at')
    assert(originalVersion)
    const invalid = await updateLocation(db, ORG, 'cabin-site', { stay_map_sharing: 'invalid' as 'general' }, OWNER, env)
    assert.equal(invalid.status, 400)
    assert.equal(await db.prepare("SELECT updated_at FROM business_locations WHERE id = 'cabin-site'").first('updated_at'), originalVersion)

    for (const mode of ['general', 'specific'] as const) {
      if (mode === 'specific') {
        assert.equal((await updateLocation(db, ORG, 'cabin-site', { stay_map_sharing: mode, expected_updated_at: originalVersion }, OWNER, env)).status, 200)
        assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_id = 'cabin-site' AND slot = 'social_card'").first('count(*)'), 0)
        assert.equal(await db.prepare("SELECT status FROM media_assets WHERE id = 'old-private-card'").first('status'), 'active')
        const stale = await updateLocation(db, ORG, 'cabin-site', { stay_map_sharing: 'general', expected_updated_at: originalVersion }, OWNER, env)
        assert.deepEqual(stale, { status: 409, data: { error: 'The location changed since it was read. Reload it and try again.', code: 'LOCATION_VERSION_CONFLICT', field: 'expected_updated_at' } })
      }
      const collection = await loadPublicProductCollection(db, ORG, 'menu', false, 'cabin-site', env)
      assert.equal(collection?.products[0]?.id, dish.id)
      const detail = await loadPublicProductDetail(env, db, ORG, 'menu', false, 'cabin-site', dish.slug)
      const apiDetail = await loadPublicProductApiDetail(env, db, ORG, false, 'cabin-site', dish.slug)
      const translatedDetail = await loadPublicProductDetail(env, db, ORG, 'menu', false, 'cabin-site', dish.slug, 'th')
      assert(detail && apiDetail && translatedDetail)
      const projections: PublicProductLocation[] = [collection!.locations[0]!, detail.location, apiDetail.location, translatedDetail.location]
      for (const path of ['/api/public/locations', '/api/public/locations/cabin-site', '/shell', '/shell?locale=th', '/api/public/page?page=location&location=cabin-site&datasets=location,reviews', '/api/public/page?page=location&location=cabin-site&datasets=location,reviews&locale=th']) {
        const response = await read(path)
        assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
        const payload = await response.json() as { locations?: PublicProductLocation[]; location?: PublicProductLocation; shell?: { locations: PublicProductLocation[] } }
        const selected = payload.location ?? (payload.locations ?? payload.shell?.locations)?.find(item => item.id === 'cabin-site')
        assert(selected, path)
        assert.equal(selected.stay_map_sharing, mode, path)
        projections.push(selected)
        for (const exact of [...address.addressLines, translatedStreet, location.maps_url, location.google_place_id, reference, flag, privateCard]) assert(!JSON.stringify(payload).includes(exact), `${path} disclosed ${exact}`)
        if (path.startsWith('/shell') || path.startsWith('/api/public/page')) assert.equal((selected as PublicProductLocation & { social_image: { url: string } }).social_image.url, privateHero)
      }
      for (const projected of projections) {
        assert.equal(projected.address, null)
        assert.equal(projected.maps_url, null)
        assert.equal(projected.stay_map_sharing, mode)
        assert.equal(projected.public_area?.approximate, mode === 'general')
        if (mode === 'general') {
          assert.equal(projected.latitude, null)
          assert.equal(projected.longitude, null)
          assert.deepEqual(projected.public_area?.center, { latitude: 8.03, longitude: 98.83 })
          assert.equal(projected.public_area?.radius_meters, 2000)
          assert.equal(new URL(projected.map_embed_url!).searchParams.get('q'), '8.03,98.83')
        } else {
          assert.deepEqual([projected.latitude, projected.longitude], [location.latitude, location.longitude])
          assert.equal(new URL(projected.map_embed_url!).searchParams.get('q'), '8.0326,98.822')
        }
      }
      assert.equal(translatedDetail.location.public_area?.locality, 'เมืองกระบี่')
      const grid = await getPublicTenantPageForPath(env, db, ORG, '/', { locale: 'th' })
      assert(grid)
      const items = grid.blocks.find(block => block.type === 'location_grid')?.data.items as Array<{ id: string; city: string; address?: string; public_area: { locality: string } }>
      assert.equal(items.length, 1)
      assert.equal(items[0]!.id, 'cabin-site')
      assert.equal(items[0]!.city, 'เมืองกระบี่')
      assert.equal(items[0]!.address, undefined)
      assert(!JSON.stringify(grid).includes(translatedStreet))
      const reviews = await loadPublicProductReviews(db, detail)
      assert.equal(reviews.length, 1)
      assert.equal(reviews[0]!.original_reference, null)
      assert.equal(reviews[0]!.google_review_metadata?.flag_content_uri, null)
      const locationReviews = await listOrganizationReviews(db, ORG, { locationId: 'cabin-site', publishedOnly: true })
      assert.equal(locationReviews.length, 1)
      assert.equal(locationReviews[0]!.original_reference, null)
    }

    assert.equal((await updateLocation(db, ORG, 'cabin-site', { latitude: null, longitude: null, maps_url: null }, OWNER, env)).status, 200)
    const missingPin = await read('/api/public/locations/cabin-site')
    assert.equal(missingPin.status, 200)
    const withoutPin = (await missingPin.json() as { location: PublicProductLocation }).location
    assert.equal(withoutPin.stay_map_sharing, 'specific')
    assert.deepEqual([withoutPin.latitude, withoutPin.longitude, withoutPin.public_area?.center, withoutPin.public_area?.radius_meters], [null, null, null, null])
    assert.equal(withoutPin.public_area?.approximate, true)
    assert(!withoutPin.map_embed_url?.includes(address.addressLines[0]!))

    const branch = await read('/api/public/locations/lake-site')
    assert.equal(branch.status, 200)
    const publicBranch = (await branch.json() as { location: PublicProductLocation }).location
    assert.deepEqual(publicBranch.address, branchAddress)
    assert.deepEqual([publicBranch.latitude, publicBranch.longitude, publicBranch.maps_url, publicBranch.stay_map_sharing], [40.014984, -105.270546, 'https://maps.google.com/?cid=public-cid', null])
    const branchReviews = await listOrganizationReviews(db, ORG, { locationId: 'lake-site', publishedOnly: true })
    assert.equal(branchReviews[0]!.original_reference, reference)
    assert.deepEqual(branchReviews[0]!.google_review_metadata, metadata)
    assert.equal((await loadPublicSocialMedia(db, ORG, 'business_location', ['lake-site'])).get('lake-site')?.social_image?.url, publicCard)
    // A lodging organization's location is private before any home is attached.
    await db.prepare("UPDATE organization SET vertical = 'lodging' WHERE id = ?").bind(ORG).run()
    const unassigned = await read('/api/public/locations/lake-site')
    assert.equal(unassigned.status, 200)
    const privateBranch = (await unassigned.json() as { location: PublicProductLocation }).location
    assert.equal(privateBranch.address, null)
    assert.equal(privateBranch.maps_url, null)
    assert.equal(privateBranch.stay_map_sharing, 'general')
    assert.deepEqual([privateBranch.latitude, privateBranch.longitude], [null, null])
    const nowProtected = await loadPublicSocialMedia(db, ORG, 'business_location', ['lake-site'])
    assert.equal(nowProtected.get('lake-site')?.social_image?.url, publicHero)
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_id = 'lake-site' AND slot = 'social_card' AND status = 'active'").first('count(*)'), 1)
  } finally {
    await runtime.dispose()
  }
})
