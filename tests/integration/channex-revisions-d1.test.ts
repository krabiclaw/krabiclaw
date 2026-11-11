import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, createStay, getStay, listStayMoveOptions, moveStay } from '../../server/domain/stays.ts'
import { applyBookingRevision, runRevisionFeed } from '../../server/integrations/channex/booking-revisions.ts'

// Airbnb bookings landing as channel stays: acknowledged only after they
// land, idempotent across repeated and out-of-order deliveries, overbooked
// rather than refused when their nights are taken, and released on cancel.

const ORG = 'org'
const OWNER = 'owner-user'
const channexEnv = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }

// A booking is its revisions: each carries the booking whole at its own time,
// and only that time tells a later state from an earlier one.
interface Booking { id: string; property_id: string; status: string; arrival: string; departure: string; amount: string; revision: string; code?: string }

class FakeChannex {
  /** Each revision as Channex serves it: the booking as the channel sent it, at that revision's time. */
  revisions = new Map<string, Record<string, unknown>>()
  acked: string[] = []
  /** Channex's revision reads (by id and the feed) answer 503. */
  failRevisions = false

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    if (method === 'POST' && (path === '/restrictions' || path === '/availability')) return json({ data: [{ id: crypto.randomUUID(), type: 'task' }], meta: { message: 'Success', warnings: [] } })
    let match = path.match(/^\/booking_revisions\/([^/]+)\/ack$/)
    if (method === 'POST' && match) { this.acked.push(match[1]!); return json({ meta: { message: 'Success' } }) }
    if (method === 'GET' && path === '/booking_revisions/feed') {
      if (this.failRevisions) return new Response('upstream', { status: 503 })
      const pending = [...this.revisions.keys()].filter(id => !this.acked.includes(id))
      return json({ data: pending.map(id => ({ id, type: 'booking_revision', attributes: this.revisions.get(id) })), meta: { total: pending.length } })
    }
    match = path.match(/^\/booking_revisions\/([^/]+)$/)
    if (method === 'GET' && match) {
      if (this.failRevisions) return new Response('upstream', { status: 503 })
      return json({ data: { id: match[1], type: 'booking_revision', attributes: this.revisions.get(match[1]!) } })
    }
    // Channex's certification refuses a booking read by id: nothing here answers one.
    return new Response(`unexpected ${method} ${path}`, { status: 404 })
  }

  /** A revision: the booking as the channel states it, revised at `at`. */
  revise(revision: string, booking: Booking, at: string) {
    this.revisions.set(revision, {
      booking_id: booking.id, property_id: booking.property_id, status: booking.status, ota_name: 'AirBNB', ota_reservation_code: booking.code ?? `HM${booking.id}`,
      inserted_at: at, arrival_date: booking.arrival, departure_date: booking.departure, amount: booking.amount, currency: 'USD',
      customer: { name: 'Lee', surname: 'Park', mail: 'lee@example.test', phone: null }, occupancy: { adults: 2, children: 1, infants: 0 },
    })
  }

  /** A revision delivered after a later one of the same booking landed: its time is older, so it changes nothing. */
  superseded(revision: string, booking: Booking, at: string) {
    this.revise(revision, booking, at)
  }
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'channex-revisions-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channex-revisions-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), ...channexEnv }
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'o@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'm-owner' },
    } })
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing-1', 'chan-1', 'prop-1', 'room-1', 'rate-1', 'complete', 1)`).bind(ORG, home.id).run()
    return { runtime, db, env, productId: home.id }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const nights = async (db: D1Database, stayId: string) => (await db.prepare('SELECT date FROM stay_nights WHERE booking_id = ? ORDER BY date').bind(stayId).all<{ date: string }>()).results.map(row => row.date)
const logged = async (db: D1Database) => (await db.prepare('SELECT external_id, status FROM channel_sync_log ORDER BY created_at, rowid').all<{ external_id: string; status: string }>()).results

test('a reservation re-imported under a new Channex booking id updates its stay instead of becoming a second one', { timeout: 120_000 }, async () => {
  const { runtime, db, env, productId } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const before: Booking = { id: 'bk-staging', property_id: 'prop-1', status: 'new', arrival: '2027-02-10', departure: '2027-02-13', amount: '300.00', revision: '', code: 'HMREIMPORT' }
    channex.revise('rev-staging', before, '2026-10-15T01:00:00Z')
    const original = await applyBookingRevision(db, env, 'rev-staging') as { booking_id: string }
    // After the cutover the new Channex account holds the same Airbnb reservation under its own booking id.
    const after: Booking = { ...before, id: 'bk-production', departure: '2027-02-14', amount: '400.00' }
    channex.revise('rev-production', after, '2026-10-20T01:00:00Z')
    const reimported = await applyBookingRevision(db, env, 'rev-production')
    assert.deepEqual(reimported, { status: 'acknowledged', booking_id: original.booking_id, overbooked: false })
    assert.deepEqual((await db.prepare("SELECT id, external_booking_id, channel_booking_id, ends_at, total_minor, overbooked, version, revision_id FROM bookings WHERE owner = 'channel'").all()).results, [
      // Checkout is the home's 10:00 in Denver.
      { id: original.booking_id, external_booking_id: 'bk-production', channel_booking_id: 'HMREIMPORT', ends_at: '2027-02-14T17:00:00.000Z', total_minor: 40_000, overbooked: 0, version: 2, revision_id: 'rev-production' },
    ])
    assert.deepEqual(await nights(db, original.booking_id), ['2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13'])
    // A revision of the old booking delivered late does not take the stay back.
    channex.superseded('rev-staging-late', before, '2026-10-16T01:00:00Z')
    await applyBookingRevision(db, env, 'rev-staging-late')
    assert.deepEqual(await db.prepare('SELECT external_booking_id, version FROM bookings WHERE id = ?').bind(original.booking_id).first(), { external_booking_id: 'bk-production', version: 2 })
    // Nor does an older revision of a new booking id move a newer stay onto it.
    channex.revise('rev-stale', { ...before, id: 'bk-stale' }, '2026-10-19T01:00:00Z')
    assert.deepEqual(await applyBookingRevision(db, env, 'rev-stale'), { status: 'acknowledged', booking_id: original.booking_id, overbooked: false })
    assert.deepEqual((await db.prepare("SELECT id, external_booking_id, version FROM bookings WHERE owner = 'channel'").all()).results, [{ id: original.booking_id, external_booking_id: 'bk-production', version: 2 }])
    // Later revisions arrive under the new id and keep updating the same stay.
    channex.revise('rev-production-cancel', { ...after, status: 'cancelled' }, '2026-10-21T01:00:00Z')
    await applyBookingRevision(db, env, 'rev-production-cancel')
    assert.deepEqual(await db.prepare('SELECT status, external_booking_id FROM bookings WHERE id = ?').bind(original.booking_id).first(), { status: 'cancelled', external_booking_id: 'bk-production' })
    assert.deepEqual(await nights(db, original.booking_id), [])
    // Another reservation on the same nights is its own stay.
    channex.revise('rev-other', { ...before, id: 'bk-other', code: 'HMOTHER' }, '2026-10-21T02:00:00Z')
    const other = await applyBookingRevision(db, env, 'rev-other') as { booking_id: string }
    assert.notEqual(other.booking_id, original.booking_id)
    // The database holds one stay per channel reservation, whatever writes it.
    await assert.rejects(db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_variant_id, starts_at, ends_at, timezone, party_size, adults, children, infants, policy_json, total_minor, currency, channel, owner, status, provider, external_booking_id, channel_booking_id)
      SELECT 'duplicate', organization_id, product_id, id, '2027-03-01', '2027-03-02', 'America/Denver', 1, 1, 0, 0, '{}', 100, 'USD', 'airbnb', 'channel', 'confirmed', 'channex', 'bk-duplicate', 'HMREIMPORT'
        FROM product_variants WHERE organization_id = ? AND product_id = ?`).bind(ORG, productId).run(), /UNIQUE constraint failed: bookings\.organization_id, bookings\.channel, bookings\.channel_booking_id/)
    assert.deepEqual(channex.acked, ['rev-staging', 'rev-production', 'rev-staging-late', 'rev-stale', 'rev-production-cancel', 'rev-other'])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a channel booking lands, repeats and stale deliveries change nothing, an overlap is overbooked, a cancel frees its nights', { timeout: 120_000 }, async () => {
  const { runtime, db, env, productId } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const booking: Booking = { id: 'bk-1', property_id: 'prop-1', status: 'new', arrival: '2027-01-10', departure: '2027-01-13', amount: '450.50', revision: '' }
    channex.revise('rev-1', booking, '2026-10-15T01:00:00Z')
    const landed = await applyBookingRevision(db, env, 'rev-1')
    assert.equal(landed.status, 'acknowledged')
    const stayId = (landed as { booking_id: string }).booking_id
    const stored = await db.prepare(`SELECT b.channel, b.owner, b.status, b.overbooked, b.total_minor, b.currency, json_extract(r.payload_json, '$.guest.name') AS guest_name, b.adults, b.children, b.version, b.provider_updated_at
      FROM bookings b JOIN conversations r ON r.booking_id = b.id AND r.kind = 'booking' WHERE b.id = ?`).bind(stayId).first()
    assert.deepEqual(stored, { channel: 'airbnb', owner: 'channel', status: 'confirmed', overbooked: 0, total_minor: 45_050, currency: 'USD', guest_name: 'Lee Park', adults: 2, children: 1, version: 1, provider_updated_at: '2026-10-15T01:00:00Z' })
    assert.deepEqual(await nights(db, stayId), ['2027-01-10', '2027-01-11', '2027-01-12'])
    assert.deepEqual(channex.acked, ['rev-1'])

    // The same revision again, and an older one delivered late, change nothing but are acknowledged:
    // each reads the booking's current state, ordered by its current revision.
    await applyBookingRevision(db, env, 'rev-1')
    channex.superseded('rev-0', booking, '2026-10-15T00:30:00Z')
    await applyBookingRevision(db, env, 'rev-0')
    assert.deepEqual((await db.prepare('SELECT ends_at, version FROM bookings WHERE id = ?').bind(stayId).first()), { ends_at: '2027-01-13T17:00:00.000Z', version: 1 })
    assert.deepEqual(channex.acked, ['rev-1', 'rev-1', 'rev-0'])
    // A read that finished after a newer one landed is refused by its older revision time.
    const raced = await applyChannelBooking(db, env, ORG, productId, { provider: 'channex', external_booking_id: 'bk-1', channel_booking_id: null, channel: 'airbnb', revision_id: 'rev-0', provider_updated_at: '2026-10-15T00:30:00Z', cancelled: false, check_in_date: '2027-01-10', check_out_date: '2027-01-20', adults: 2, children: 0, infants: 0, guest_name: 'Lee', guest_surname: null, guest_email: null, guest_phone: null, total_minor: 1, currency: 'USD' })
    assert.deepEqual([raced.applied, raced.check_out_date], [false, '2027-01-13'])

    // A modification keeps the booking's creation time; its revision's later time lands it.
    channex.revise('rev-1b', { ...booking, status: 'modified', departure: '2027-01-14' }, '2026-10-15T01:30:00Z')
    await applyBookingRevision(db, env, 'rev-1b')
    assert.deepEqual(await db.prepare('SELECT status, ends_at, version, provider_updated_at FROM bookings WHERE id = ?').bind(stayId).first(), { status: 'confirmed', ends_at: '2027-01-14T17:00:00.000Z', version: 2, provider_updated_at: '2026-10-15T01:30:00Z' })
    assert.deepEqual(await nights(db, stayId), ['2027-01-10', '2027-01-11', '2027-01-12', '2027-01-13'])

    // A host stay holds 2027-02-01..03; a channel booking over it still lands, flagged and holding nothing.
    const host = await createStay(db, env, { organizationId: ORG, actorId: OWNER, manage: true }, { product_id: productId, idempotency_key: 'host-1', check_in_date: '2027-02-01', check_out_date: '2027-02-03', adults: 1, guest_name: 'Host guest', total_minor: 10_000 })
    assert.deepEqual(host.channel_push, { state: 'pushed', detail: null })
    channex.revise('rev-2', { ...booking, id: 'bk-2', arrival: '2027-02-02', departure: '2027-02-04' }, '2026-10-15T02:00:00Z')
    const overlap = await applyBookingRevision(db, env, 'rev-2')
    assert.deepEqual([overlap.status, (overlap as { overbooked: boolean }).overbooked], ['acknowledged', true])
    assert.deepEqual(await nights(db, (overlap as { booking_id: string }).booking_id), [])

    // Cancelling the first booking frees its nights; the stay is kept, cancelled.
    channex.revise('rev-3', { ...booking, status: 'cancelled', departure: '2027-01-14' }, '2026-10-15T03:00:00Z')
    await applyBookingRevision(db, env, 'rev-3')
    assert.deepEqual(await db.prepare('SELECT status, version FROM bookings WHERE id = ?').bind(stayId).first(), { status: 'cancelled', version: 3 })
    assert.deepEqual(await nights(db, stayId), [])
    assert.ok((await db.prepare('SELECT cancelled_at FROM bookings WHERE id = ?').bind(stayId).first<{ cancelled_at: string | null }>())!.cancelled_at)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('an unknown home is logged and acknowledged; a failed read is not acknowledged and the feed lands it later', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    channex.revise('rev-x', { id: 'bk-x', property_id: 'someone-elses', status: 'new', arrival: '2027-03-01', departure: '2027-03-02', amount: '100', revision: '' }, '2026-10-15T01:00:00Z')
    assert.deepEqual(await applyBookingRevision(db, env, 'rev-x'), { status: 'ignored_disconnected' })
    assert.deepEqual(channex.acked, ['rev-x'])
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bookings').first<{ n: number }>())!.n, 0)

    channex.revise('rev-y', { id: 'bk-y', property_id: 'prop-1', status: 'new', arrival: '2027-03-05', departure: '2027-03-07', amount: '300', revision: '' }, '2026-10-15T01:00:00Z')
    channex.failRevisions = true
    await assert.rejects(applyBookingRevision(db, env, 'rev-y'), (error: unknown) => (error as { providerStatus?: number; status?: number }).providerStatus === 503 && (error as { status?: number }).status === 502)
    assert.deepEqual(channex.acked, ['rev-x'])
    await assert.rejects(runRevisionFeed(db, env), (error: unknown) => (error as { providerStatus?: number }).providerStatus === 503)

    channex.failRevisions = false
    assert.deepEqual(await runRevisionFeed(db, env), { acknowledged: 1, ignored: 0 })
    assert.deepEqual(channex.acked, ['rev-x', 'rev-y'])
    assert.deepEqual(await logged(db), [
      { external_id: 'rev-x', status: 'ignored_disconnected' }, { external_id: 'rev-y', status: 'failed' }, { external_id: 'rev-y', status: 'acknowledged' },
    ])

  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a moved guest takes the nights, turnover and messages to the new home while the reservation keeps its listing', { timeout: 120_000 }, async () => {
  const { runtime, db, env, productId } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  const access = { organizationId: ORG, actorId: OWNER, manage: true }
  try {
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('annex-site', ?, 'annex', 'Annex', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const annex = (await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Annex', variants: [{ name: 'Annex', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'annex-site', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1, assigned_member_id: 'm-owner' },
    } })).id
    const booking: Booking = { id: 'bk-move', property_id: 'prop-1', status: 'new', arrival: '2027-03-10', departure: '2027-03-13', amount: '300.00', revision: '' }
    // Channex delivered the guest's conversation for this booking on its listing.
    await db.prepare(`INSERT INTO conversations (id, kind, organization_id, payload_json, last_message_at) VALUES ('thread-move', 'booking', ?, '{"guest":{"name":"Lee","email":"lee@example.test","phone":null},"ip_hash":null,"cancellation":{"token_hash":null,"expires_at":null,"used_at":null}}', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    await db.prepare(`INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, conversation_id, external_booking_id, provider_updated_at) VALUES ('channex', 'ext-thread', ?, ?, 'thread-move', 'bk-move', '2026-10-15T00:00:00Z')`).bind(ORG, productId).run()
    channex.revise('rev-move', booking, '2026-10-15T01:00:00Z')
    const stayId = (await applyBookingRevision(db, env, 'rev-move') as { booking_id: string }).booking_id
    const landed = await getStay(db, access, stayId)
    assert.ok(landed.conversation_id, 'the guest has a conversation to be told in')

    // Without instructions the guest could not be told how to get in, so the move is refused and nothing changes.
    await assert.rejects(moveStay(db, env, access, stayId, { version: landed.version, product_id: annex }), /Add check-in instructions/)
    assert.equal((await getStay(db, access, stayId)).product_id, productId)
    await db.prepare('UPDATE product_stay_configs SET check_in_instructions = ? WHERE product_id = ?').bind('Door code 1234', annex).run()

    const [option] = await listStayMoveOptions(db, access, stayId)
    assert.deepEqual([option!.product_id, option!.taken, option!.has_instructions], [annex, [], true])

    const moved = await moveStay(db, env, access, stayId, { version: landed.version, product_id: annex })
    assert.deepEqual([moved.product_id, moved.booked_product_id], [annex, productId])
    const claims = async () => (await db.prepare('SELECT product_id, date FROM stay_nights WHERE booking_id = ? ORDER BY date').bind(stayId).all()).results
    assert.deepEqual(await claims(), ['2027-03-10', '2027-03-11', '2027-03-12'].map(date => ({ product_id: annex, date })))
    assert.deepEqual(await db.prepare("SELECT product_id, starts_at FROM tasks WHERE dedupe_key = ?").bind(`turnover:${stayId}`).first(), { product_id: annex, starts_at: '2027-03-13T18:00:00.000Z' })
    assert.deepEqual(await db.prepare('SELECT kind, status, product_id, title, due_at FROM tasks WHERE dedupe_key = ?').bind(`stay-ready:${stayId}:${annex}`).first(),
      { kind: 'stay_ready', status: 'open', product_id: annex, title: 'Get Annex ready', due_at: '2027-03-10T22:00:00.000Z' })
    const told = await db.prepare("SELECT product_id, status, body FROM scheduled_guest_messages WHERE booking_id = ? AND id = ? AND template_title = 'Your stay has moved'").bind(stayId, moved.scheduled_message_id).first<{ product_id: string; status: string; body: string }>()
    assert.deepEqual([told!.product_id, told!.status], [annex, 'pending'])
    assert.match(told!.body, /Your stay has moved to Annex|your stay has moved to Annex/)
    assert.match(told!.body, /Door code 1234/)
    assert.match(told!.body, /any you received for Cabin/)

    // The reservation still holds its listing's nights: they are closed there, not resold.
    assert.equal(JSON.parse((await db.prepare("SELECT sent_json FROM channel_night_pushes WHERE product_id = ? AND date = '2027-03-11'").bind(productId).first<{ sent_json: string }>())!.sent_json).availability, 0)

    // Neither home takes another stay over the moved guest's nights, in the write itself: the listing because
    // the reservation still holds it, the destination because the guest sleeps there.
    await assert.rejects(createStay(db, env, access, { product_id: productId, idempotency_key: 'listing-held', check_in_date: '2027-03-11', check_out_date: '2027-03-12', adults: 1, guest_name: 'Second', total_minor: 100 }), /already holds one of these nights/)
    await assert.rejects(createStay(db, env, access, { product_id: annex, idempotency_key: 'annex-held', check_in_date: '2027-03-11', check_out_date: '2027-03-12', adults: 1, guest_name: 'Second', total_minor: 100 }), /already holds one of these nights/)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE idempotency_key IN ('listing-held', 'annex-held')").first('n'), 0)

    // A later revision names the listing it was booked on, and the guest stays where they sleep.
    channex.revise('rev-move-2', { ...booking, status: 'modified', departure: '2027-03-14' }, '2026-10-16T01:00:00Z')
    await applyBookingRevision(db, env, 'rev-move-2')
    assert.deepEqual(await db.prepare('SELECT product_id, booked_product_id, ends_at, overbooked FROM bookings WHERE id = ?').bind(stayId).first(), { product_id: annex, booked_product_id: productId, ends_at: '2027-03-14T17:00:00.000Z', overbooked: 0 })
    assert.equal((await claims()).length, 4)

    // A home someone else holds cannot take the guest.
    await createStay(db, env, access, { product_id: productId, idempotency_key: 'later-host', check_in_date: '2027-03-20', check_out_date: '2027-03-22', adults: 1, guest_name: 'Later', total_minor: 100 })
    channex.revise('rev-other-home', { ...booking, id: 'bk-blocked', code: 'HMBLOCKED', arrival: '2027-03-12', departure: '2027-03-15' }, '2026-10-17T01:00:00Z')
    const blocked = (await applyBookingRevision(db, env, 'rev-other-home') as { booking_id: string }).booking_id
    const blockedStay = await getStay(db, access, blocked)
    await assert.rejects(moveStay(db, env, access, blocked, { version: blockedStay.version, product_id: annex }), /not free for every night/)

    channex.revise('rev-other-home-cancel', { ...booking, id: 'bk-blocked', code: 'HMBLOCKED', status: 'cancelled', arrival: '2027-03-12', departure: '2027-03-15' }, '2026-10-18T01:00:00Z')
    await applyBookingRevision(db, env, 'rev-other-home-cancel')
    // Moving back to the booked listing undoes it: the listing is theirs again and the job is called off.
    // The guest is told how to get in again, so the listing needs its instructions too.
    await db.prepare('UPDATE product_stay_configs SET check_in_instructions = ? WHERE product_id = ?').bind('Door code 5678', productId).run()
    const current = await getStay(db, access, stayId)
    const undone = await moveStay(db, env, access, stayId, { version: current.version, product_id: productId })
    assert.deepEqual([undone.product_id, undone.booked_product_id], [productId, null])
    assert.deepEqual((await claims()).map(row => (row as { product_id: string }).product_id), Array(4).fill(productId))
    assert.equal((await db.prepare('SELECT status FROM tasks WHERE dedupe_key = ?').bind(`stay-ready:${stayId}:${annex}`).first<{ status: string }>())!.status, 'cancelled')

    // A stay booked directly has no listing to go back to: its new home still gets the job.
    const direct = await createStay(db, env, access, { product_id: productId, idempotency_key: 'direct-move', check_in_date: '2027-06-01', check_out_date: '2027-06-03', adults: 1, guest_name: 'Direct Guest', total_minor: 10_000 })
    await moveStay(db, env, access, direct.id, { version: direct.version, product_id: annex })
    assert.equal((await db.prepare('SELECT status FROM tasks WHERE dedupe_key = ?').bind(`stay-ready:${direct.id}:${annex}`).first<{ status: string }>())?.status, 'open')
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
