import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, createStay } from '../../server/domain/stays.ts'
import { applyBookingRevision, runRevisionFeed } from '../../server/integrations/channex/booking-revisions.ts'

// Airbnb bookings landing as channel stays: acknowledged only after they
// land, idempotent across repeated and out-of-order deliveries, overbooked
// rather than refused when their nights are taken, and released on cancel.

const ORG = 'org'
const OWNER = 'owner-user'
const channexEnv = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' }

// A booking keeps its creation time across modifications and cancellation;
// only its revisions carry later times.
interface Booking { id: string; property_id: string; status: string; arrival: string; departure: string; amount: string; revision: string }
const CREATED = '2026-10-14T00:00:00Z'

class FakeChannex {
  bookings = new Map<string, Booking>()
  revisions = new Map<string, { booking_id: string; property_id: string; inserted_at: string }>()
  acked: string[] = []
  failBooking = false

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    if (method === 'POST' && (path === '/restrictions' || path === '/availability')) return json({ data: [], meta: { message: 'Success', warnings: [] } })
    let match = path.match(/^\/booking_revisions\/([^/]+)\/ack$/)
    if (method === 'POST' && match) { this.acked.push(match[1]!); return json({ meta: { message: 'Success' } }) }
    if (method === 'GET' && path === '/booking_revisions/feed') {
      const pending = [...this.revisions.keys()].filter(id => !this.acked.includes(id))
      return json({ data: pending.map(id => ({ id, type: 'booking_revision', attributes: this.revisions.get(id) })), meta: { total: pending.length } })
    }
    match = path.match(/^\/booking_revisions\/([^/]+)$/)
    if (method === 'GET' && match) return json({ data: { id: match[1], type: 'booking_revision', attributes: this.revisions.get(match[1]!) } })
    match = path.match(/^\/bookings\/([^/]+)$/)
    if (method === 'GET' && match) {
      if (this.failBooking) return new Response('upstream', { status: 503 })
      const booking = this.bookings.get(match[1]!)!
      return json({ data: { id: booking.id, type: 'booking', attributes: {
        property_id: booking.property_id, status: booking.status, ota_name: 'AirBNB', ota_reservation_code: `HM${booking.id}`, revision_id: booking.revision,
        inserted_at: CREATED, arrival_date: booking.arrival, departure_date: booking.departure, amount: booking.amount, currency: 'USD',
        customer: { name: 'Lee', surname: 'Park', mail: 'lee@example.test', phone: null }, occupancy: { adults: 2, children: 1, infants: 0 },
      } } })
    }
    return new Response(`unexpected ${method} ${path}`, { status: 404 })
  }

  /** A new revision: the booking's current state becomes `booking`, revised at `at`. */
  revise(revision: string, booking: Booking, at: string) {
    this.bookings.set(booking.id, { ...booking, revision })
    this.revisions.set(revision, { booking_id: booking.id, property_id: booking.property_id, inserted_at: at })
  }

  /** A revision Channex still lists but that is no longer the booking's current state. */
  superseded(revision: string, booking: Booking, at: string) {
    this.revisions.set(revision, { booking_id: booking.id, property_id: booking.property_id, inserted_at: at })
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
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'o@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing-1', 'chan-1', 'prop-1', 'room-1', 'rate-1', 'complete', 1)`).bind(ORG, home.id).run()
    return { runtime, db, env, productId: home.id }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const nights = async (db: D1Database, stayId: string) => (await db.prepare('SELECT date FROM stay_nights WHERE stay_id = ? ORDER BY date').bind(stayId).all<{ date: string }>()).results.map(row => row.date)
const logged = async (db: D1Database) => (await db.prepare('SELECT external_id, status FROM channel_sync_log ORDER BY created_at, rowid').all<{ external_id: string; status: string }>()).results

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
    const stayId = (landed as { stay_id: string }).stay_id
    const stored = await db.prepare('SELECT channel, owner, status, overbooked, total_minor, currency, guest_name, adults, children, version, provider_updated_at FROM stays WHERE id = ?').bind(stayId).first()
    assert.deepEqual(stored, { channel: 'airbnb', owner: 'channel', status: 'confirmed', overbooked: 0, total_minor: 45_050, currency: 'USD', guest_name: 'Lee', adults: 2, children: 1, version: 1, provider_updated_at: '2026-10-15T01:00:00Z' })
    assert.deepEqual(await nights(db, stayId), ['2027-01-10', '2027-01-11', '2027-01-12'])
    assert.deepEqual(channex.acked, ['rev-1'])

    // The same revision again, and an older one delivered late, change nothing but are acknowledged:
    // each reads the booking's current state, ordered by its current revision.
    await applyBookingRevision(db, env, 'rev-1')
    channex.superseded('rev-0', booking, '2026-10-15T00:30:00Z')
    await applyBookingRevision(db, env, 'rev-0')
    assert.deepEqual((await db.prepare('SELECT check_out_date, version FROM stays WHERE id = ?').bind(stayId).first()), { check_out_date: '2027-01-13', version: 1 })
    assert.deepEqual(channex.acked, ['rev-1', 'rev-1', 'rev-0'])
    // A read that finished after a newer one landed is refused by its older revision time.
    const raced = await applyChannelBooking(db, env, ORG, productId, { provider: 'channex', external_booking_id: 'bk-1', channel_booking_id: null, channel: 'airbnb', revision_id: 'rev-0', provider_updated_at: '2026-10-15T00:30:00Z', cancelled: false, check_in_date: '2027-01-10', check_out_date: '2027-01-20', adults: 2, children: 0, infants: 0, guest_name: 'Lee', guest_surname: null, guest_email: null, guest_phone: null, total_minor: 1, currency: 'USD' })
    assert.deepEqual([raced.applied, raced.check_out_date], [false, '2027-01-13'])

    // A modification keeps the booking's creation time; its revision's later time lands it.
    channex.revise('rev-1b', { ...booking, status: 'modified', departure: '2027-01-14' }, '2026-10-15T01:30:00Z')
    await applyBookingRevision(db, env, 'rev-1b')
    assert.deepEqual(await db.prepare('SELECT status, check_out_date, version, provider_updated_at FROM stays WHERE id = ?').bind(stayId).first(), { status: 'confirmed', check_out_date: '2027-01-14', version: 2, provider_updated_at: '2026-10-15T01:30:00Z' })
    assert.deepEqual(await nights(db, stayId), ['2027-01-10', '2027-01-11', '2027-01-12', '2027-01-13'])

    // A host stay holds 2027-02-01..03; a channel booking over it still lands, flagged and holding nothing.
    const host = await createStay(db, env, { organizationId: ORG, actorId: OWNER, manage: true }, { product_id: productId, idempotency_key: 'host-1', check_in_date: '2027-02-01', check_out_date: '2027-02-03', adults: 1, guest_name: 'Host guest', total_minor: 10_000 })
    assert.deepEqual(host.channel_push, { state: 'pushed', detail: null })
    channex.revise('rev-2', { ...booking, id: 'bk-2', arrival: '2027-02-02', departure: '2027-02-04' }, '2026-10-15T02:00:00Z')
    const overlap = await applyBookingRevision(db, env, 'rev-2')
    assert.deepEqual([overlap.status, (overlap as { overbooked: boolean }).overbooked], ['acknowledged', true])
    assert.deepEqual(await nights(db, (overlap as { stay_id: string }).stay_id), [])

    // Cancelling the first booking frees its nights; the stay is kept, cancelled.
    channex.revise('rev-3', { ...booking, status: 'cancelled', departure: '2027-01-14' }, '2026-10-15T03:00:00Z')
    await applyBookingRevision(db, env, 'rev-3')
    assert.deepEqual(await db.prepare('SELECT status, version FROM stays WHERE id = ?').bind(stayId).first(), { status: 'cancelled', version: 3 })
    assert.deepEqual(await nights(db, stayId), [])
    assert.ok((await db.prepare('SELECT cancelled_at FROM stays WHERE id = ?').bind(stayId).first<{ cancelled_at: string | null }>())!.cancelled_at)
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
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM stays').first<{ n: number }>())!.n, 0)

    channex.revise('rev-y', { id: 'bk-y', property_id: 'prop-1', status: 'new', arrival: '2027-03-05', departure: '2027-03-07', amount: '300', revision: '' }, '2026-10-15T01:00:00Z')
    channex.failBooking = true
    await assert.rejects(applyBookingRevision(db, env, 'rev-y'), (error: unknown) => (error as { status?: number }).status === 503)
    assert.deepEqual(channex.acked, ['rev-x'])
    await assert.rejects(runRevisionFeed(db, env), /1 Channex booking revision\(s\) did not land: rev-y/)

    channex.failBooking = false
    assert.deepEqual(await runRevisionFeed(db, env), { acknowledged: 1, ignored: 0 })
    assert.deepEqual(channex.acked, ['rev-x', 'rev-y'])
    assert.deepEqual(await logged(db), [
      { external_id: 'rev-x', status: 'ignored_disconnected' }, { external_id: 'rev-y', status: 'failed' },
      { external_id: 'rev-y', status: 'failed' }, { external_id: 'rev-y', status: 'acknowledged' },
    ])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
