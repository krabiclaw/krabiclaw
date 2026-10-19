import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import type { UpdateProductInput } from '../../server/types/products.ts'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct, deleteProduct, getProduct, removeProductLocation, setProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, cancelStay, createStay, deleteStayPayment, getStay, listStays, readStayCalendar, recordStayPayment, setStayNights, updateStay, type StayAccess } from '../../server/domain/stays.ts'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../shared/dashboard-invalidations.ts'
import { H3 } from 'nitro/h3'
import { createAuth } from '../../server/utils/auth.ts'
import guestStayRoute from '../../server/api/public/guest-stays/[activityId].get.ts'
import paymentReturnRoute from '../../server/api/public/payments/[paymentId]/return.post.ts'
import { tokenHash } from '../../server/domain/payments/buyer.ts'

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
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stays-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = await runtime.getBindings<CloudflareEnv>()
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
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
      bedrooms: null, beds: null, bathrooms: null, amenities: [], cancellation_policy: null, long_term_cancellation_policy: null, assigned_member_id: null, assigned_team_id: 'cleaning' })
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
    const moved = await updateStay(db, env, manager, stay.id, { expected_version: 1, check_in_date: '2026-11-05', check_out_date: '2026-11-08', guest_phone: '+15551234567' })
    assert.equal(moved.version, 2)
    assert.equal(moved.guest_phone, '+15551234567')
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

test('a business’s site shows a guest the stay their own browser booked there, and nothing else', { timeout: 120_000 }, async () => {
  const { runtime, db, env: bindings } = await boot()
  try {
    const env = { ...bindings, BETTER_AUTH_URL: 'https://org.proof.example', BETTER_AUTH_SECRET: 'local-stay-proof-secret-long-enough', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'site-stay', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest, guest_email: 'ana@example.com' })
    // The anonymous Better Auth user the site's checkout made the stay for.
    const signIn = async () => {
      const signed = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
      return { id: signed.response!.user.id, cookie: signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    }
    const [booker, stranger] = [await signIn(), await signIn()]
    await db.prepare("UPDATE stays SET user_id = ?, cancellation_policy = 'moderate' WHERE id = ?").bind(booker.id, stay.id).run()
    // The guest's stay is read by its activity ID: its conversation's, as the account reads it.
    const activityId = stay.request_id ?? stay.id
    const read = (organizationId: string, cookie?: string) => {
      const app = new H3()
      app.use((event) => { event.context.organizationId = organizationId })
      app.get('/api/public/guest-stays/:activityId', guestStayRoute)
      return app.request(Object.assign(new Request(`https://org.proof.example/api/public/guest-stays/${activityId}`, { headers: cookie ? { cookie } : {} }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }

    const own = await read(ORG, booker.cookie)
    assert.equal(own.status, 200)
    const body = await own.json() as { organization_id: string; stay: { id: string; guest_email: string; cancellation_policy: string; check_in_date: string; check_out_date: string }; home: { name: string; check_in_time: string; check_out_time: string }; cancellation: unknown }
    assert.deepEqual({ organization_id: body.organization_id, id: body.stay.id, email: body.stay.guest_email, policy: body.stay.cancellation_policy, dates: [body.stay.check_in_date, body.stay.check_out_date], home: body.home, cancellation: body.cancellation },
      { organization_id: ORG, id: stay.id, email: 'ana@example.com', policy: 'moderate', dates: ['2026-11-01', '2026-11-04'], home: { name: 'Cabin', organization_name: 'Org', check_in_time: '16:00', check_out_time: '10:00' }, cancellation: null })
    assert.equal((await read('another-org', booker.cookie)).status, 404)
    assert.equal((await read(ORG, stranger.cookie)).status, 404)
    assert.equal((await read(ORG)).status, 401)
  } finally {
    await runtime.dispose()
  }
})

test('a stay paid on a business’s site returns to that site’s stay confirmation, for the browser that paid', { timeout: 120_000 }, async t => {
  const { runtime, db, env: bindings } = await boot()
  try {
    // A demo business on the live platform pays in Stripe test mode, which bills no usage.
    const env = { ...bindings, BETTER_AUTH_URL: 'https://org.proof.example', BETTER_AUTH_SECRET: 'local-stay-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-stay-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_live_local_boundary', STRIPE_TEST_SECRET_KEY: 'sk_test_local_boundary' }
    // The guest's notices are written in the business's source language.
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const signed = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    const buyer = signed.response!.user.id
    const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    // The stay a captured checkout made, as its conversion leaves it: the hold converted to it, the payment captured for it.
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'checkout:stay-pay', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest, guest_email: 'ana@example.com' })
    await db.prepare("UPDATE stays SET user_id = ?, cancellation_policy = 'moderate' WHERE id = ?").bind(buyer, stay.id).run()
    const nightly = ['2026-11-01', '2026-11-02', '2026-11-03'].map(date => ({ date, price_minor: 15_000 }))
    const purchase = { product_id: cabin.id, location_id: 'cabin-site', timezone: 'America/Denver', check_in_date: '2026-11-01', check_out_date: '2026-11-04', adults: 2, children: 0, infants: 0, total_minor: 45_000, currency: 'USD', cancellation_policy: 'moderate', nightly, guest: { name: 'Ana', email: 'ana@example.com', phone: null, notes: null } }
    await db.prepare(`INSERT INTO payments (id, organization_id, buyer_user_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, captured_amount, state, stripe_payment_intent_id, price_snapshot_json, created_at, updated_at)
      VALUES ('stay-pay', ?, ?, 'acct_seller', 0, 'stay', ?, 'cabin-site', 'USD', 45000, 45000, 'captured', 'pi_stay-pay', ?, ?, ?)`).bind(ORG, buyer, stay.id, JSON.stringify({ title: 'Cabin', quantity: 1, price: { unit_amount: 45_000, currency: 'USD' }, method_configuration_id: 'pmc_test', stay: purchase }), NOW, NOW).run()
    await db.prepare(`INSERT INTO payment_checkout_holds (id, organization_id, product_id, location_id, timezone, buyer_user_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, converted_stay_id, expires_at, created_at)
      VALUES ('stay-hold', ?, ?, 'cabin-site', 'America/Denver', ?, 'stay-pay', 2, 45000, 'USD', '2026-11-01', '2026-11-04', 'converted', ?, '2099-01-01T00:00:00.000Z', ?)`).bind(ORG, cabin.id, buyer, stay.id, NOW).run()
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
    const call = (path: string, init: RequestInit = {}) => app.request(Object.assign(new Request(`https://org.proof.example${path}`, { ...init, headers: { cookie, 'content-type': 'application/json' } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))

    const back = await call('/api/public/payments/stay-pay/return', { method: 'POST', body: JSON.stringify({ claim }) })
    assert.equal(back.status, 200)
    const activityId = stay.request_id ?? stay.id
    assert.deepEqual(await back.json(), { state: 'paid', kind: 'stay', activity_id: activityId })
    assert.deepEqual(await db.prepare("SELECT claimed_user_id FROM payment_claims WHERE payment_id = 'stay-pay'").first(), { claimed_user_id: buyer })
    // The confirmation page reads the stay it names, with what was paid and the policy it was booked under.
    const read = await call(`/api/public/guest-stays/${activityId}`)
    assert.equal(read.status, 200)
    const body = await read.json() as { stay: { id: string; paid_minor: number; cancellation_policy: string; guest_email: string }; cancellation: { policy: string; paid_minor: number } | null }
    assert.deepEqual({ id: body.stay.id, paid: body.stay.paid_minor, policy: body.stay.cancellation_policy, email: body.stay.guest_email, quote: body.cancellation && { policy: body.cancellation.policy, paid: body.cancellation.paid_minor } },
      { id: stay.id, paid: 45_000, policy: 'moderate', email: 'ana@example.com', quote: { policy: 'moderate', paid: 45_000 } })
  } finally {
    await runtime.dispose()
  }
})
