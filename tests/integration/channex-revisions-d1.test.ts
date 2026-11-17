import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { Miniflare } from 'miniflare'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, createStay } from '../../server/domain/stays.ts'
import { applyBookingRevision } from '../../server/integrations/channex/booking-revisions.ts'
import { ChannexConnection } from '../../server/integrations/channex/channel-connection.ts'
import { startVrboSetup, vrboHomes } from '../../server/integrations/channex/hosted-channel.ts'
import { captureEvents } from './support/events.ts'
import { applySchema } from './support/schema.ts'

// Airbnb bookings landing as channel stays: acknowledged only after they
// land, idempotent across repeated and out-of-order deliveries, overbooked
// rather than refused when their nights are taken, and released on cancel.

const ORG = 'org'
const OWNER = 'owner-user'
const channexEnv = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-revision-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }

// A booking is its revisions: each carries the booking whole at its own time,
// and only that time tells a later state from an earlier one.
interface Booking { id: string; property_id: string; status: string; arrival: string; departure: string; amount: string; revision: string; code?: string; ota_name?: 'AirBNB' | 'VRBO' }

class FakeChannex {
  /** Each revision as Channex serves it: the booking as the channel sent it, at that revision's time. */
  revisions = new Map<string, Record<string, unknown>>()
  acked: string[] = []
  /** Channex's revision reads (by id and the feed) answer 503. */
  failRevisions = false
  availability: Array<{ date_from: string; date_to: string; availability: number }> = []

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    if (method === 'POST' && (path === '/restrictions' || path === '/availability')) {
      if (path === '/availability') this.availability.push(...JSON.parse(String(init.body)).values)
      return json({ data: [{ id: crypto.randomUUID(), type: 'task' }], meta: { message: 'Success', warnings: [] } })
    }
    let match = path.match(/^\/booking_revisions\/([^/]+)\/ack$/)
    if (method === 'POST' && match) { this.acked.push(match[1]!); return json({ meta: { message: 'Success' } }) }
    if (method === 'GET' && path === '/booking_revisions/feed') {
      if (this.failRevisions) return new Response('upstream', { status: 503 })
      const property = url.searchParams.get('filter[property_id]')
      const pending = [...this.revisions.keys()].filter(id => !this.acked.includes(id) && (!property || this.revisions.get(id)?.property_id === property))
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
      booking_id: booking.id, property_id: booking.property_id, status: booking.status, ota_name: booking.ota_name ?? 'AirBNB', ota_reservation_code: booking.code ?? `HM${booking.id}`,
      inserted_at: at, arrival_date: booking.arrival, departure_date: booking.departure, amount: booking.amount, currency: 'USD',
      customer: { name: 'Lee', surname: 'Park', mail: 'lee@example.test', phone: null }, occupancy: { adults: 2, children: 1, infants: 0 },
    })
  }

  /** A revision delivered after a later one of the same booking landed: its time is older, so it changes nothing. */
  superseded(revision: string, booking: Booking, at: string) {
    this.revise(revision, booking, at)
  }
}

async function boot(mapped = true) {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'channex-revisions-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channex-revisions-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), ...channexEnv, DB: db, EVENTS: queue.binding }
    bindDatabaseEvents(db, env)
    await applySchema(db)
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
    if (mapped) await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing-1', 'chan-1', 'prop-1', 'room-1', 'rate-1', 'complete', 1)`).bind(ORG, home.id).run()
    return { runtime, db, env, queue, productId: home.id }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const nights = async (db: D1Database, stayId: string) => (await db.prepare('SELECT date FROM stay_nights WHERE booking_id = ? ORDER BY date').bind(stayId).all<{ date: string }>()).results.map(row => row.date)

test('a channel booking lands, repeats and stale deliveries change nothing, an overlap is overbooked, a cancel frees its nights', { timeout: 120_000 }, async () => {
  const { runtime, db, env, queue, productId } = await boot()
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
    assert.deepEqual(queue.pending.flatMap(item => item.body.type === 'stay.channel_revision' ? [item.body.revision_id] : []), ['rev-1'])

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
    assert.deepEqual(await nights(db, host.id), ['2027-02-01', '2027-02-02'])
    assert.deepEqual(channex.availability, [])
    await queue.drain(env, 'stay.changed')
    assert.deepEqual(channex.availability.map(entry => [entry.date_from, entry.date_to, entry.availability]), [['2027-02-01', '2027-02-02', 0]])
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

    // The same reservation code arriving under a new Channex booking id updates its stay rather than making a second one.
    const coded: Booking = { ...booking, id: 'bk-code', code: 'HMCODE', arrival: '2027-03-10', departure: '2027-03-12' }
    channex.revise('rev-code', coded, '2026-10-15T04:00:00Z')
    const first = await applyBookingRevision(db, env, 'rev-code') as { booking_id: string }
    channex.revise('rev-code-moved', { ...coded, id: 'bk-code-moved' }, '2026-10-15T05:00:00Z')
    assert.deepEqual(await applyBookingRevision(db, env, 'rev-code-moved'), { status: 'acknowledged', booking_id: first.booking_id, overbooked: false })
    assert.deepEqual((await db.prepare("SELECT id, external_booking_id FROM bookings WHERE channel_booking_id = 'HMCODE'").all()).results, [{ id: first.booking_id, external_booking_id: 'bk-code-moved' }])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('Vrbo hosts open only the selected mapped property and bookings use the shared Channex availability path', { timeout: 120_000 }, async () => {
  const { runtime, db, env, queue, productId } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  let tokenRequests = 0
  let active = false
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/api/v1/auth/one_time_token') {
      tokenRequests += 1
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(String(init.body)), { one_time_token: { property_id: 'prop-1', username: 'Owner' } })
      return Response.json({ data: { token: 'channex-test-token' } })
    }
    if (url.pathname === '/api/v1/channels') {
      assert.equal(url.searchParams.get('filter[property_id]'), 'prop-1')
      assert.equal(url.searchParams.get('filter[channel]'), 'VRB')
      return Response.json({ data: [{ id: 'vrbo-channel', type: 'channel', attributes: {
        channel: 'VRB', properties: ['prop-1'], is_active: active,
        rate_plans: [{ id: 'vrbo-rate-mapping', rate_plan_id: 'rate-1' }],
      } }], meta: { total: 1 } })
    }
    return await channex.fetch(input, init)
  }) as typeof fetch
  try {
    await assert.rejects(startVrboSetup(db, env, ORG, 'unmapped-home', OWNER, 'Owner'), { data: { code: 'HOME_NOT_FOUND' } })
    assert.equal(tokenRequests, 0)
    const started = await startVrboSetup(db, env, ORG, productId, OWNER, 'Owner')
    assert.ok('url' in started)
    const setup = new URL(started.url)
    assert.equal(setup.origin + setup.pathname, 'https://channex.test/auth/exchange')
    assert.equal(setup.searchParams.get('oauth_session_key'), 'channex-test-token')
    assert.equal(setup.searchParams.get('channels'), 'VRB')
    assert.equal(setup.searchParams.get('property_id'), 'prop-1')
    assert.deepEqual(await vrboHomes(db, env, ORG), [{ product_id: productId, name: 'Cabin', status: 'needs_review' }])
    active = true
    assert.deepEqual(await vrboHomes(db, env, ORG), [{ product_id: productId, name: 'Cabin', status: 'connected' }])
    channex.revise('vrbo-revision', {
      id: 'vrbo-booking', property_id: 'prop-1', ota_name: 'VRBO', status: 'new',
      arrival: '2027-01-10', departure: '2027-01-13', amount: '450.50', revision: 'vrbo-revision',
    }, '2026-10-15T01:00:00Z')
    const result = await applyBookingRevision(db, env, 'vrbo-revision')
    assert.equal(result.status, 'acknowledged')
    assert.deepEqual(channex.acked, ['vrbo-revision'])
    const stored = await db.prepare('SELECT channel, status FROM bookings WHERE external_booking_id = ?').bind('vrbo-booking').first()
    assert.deepEqual(stored, { channel: 'vrbo', status: 'confirmed' })
    assert.deepEqual(await nights(db, result.booking_id), ['2027-01-10', '2027-01-11', '2027-01-12'])
    await createStay(db, env, { organizationId: ORG, actorId: OWNER, manage: true }, {
      product_id: productId, idempotency_key: 'vrbo-property-host-stay', check_in_date: '2027-02-01',
      check_out_date: '2027-02-03', adults: 1, guest_name: 'Host guest', total_minor: 10_000,
    })
    await queue.drain(env, 'stay.changed')
    assert.deepEqual(channex.availability.map(value => [value.date_from, value.date_to, value.availability]), [['2027-02-01', '2027-02-02', 0]])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a standalone home provisions one Channex inventory and opens Vrbo only after calendar readback', { timeout: 120_000 }, async () => {
  const { runtime, db, env, productId } = await boot(false)
  env.CHANNEX_VRBO_ENABLED = 'true'
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  const created: string[] = []
  const inventory = { availability: {} as Record<string, unknown>, restrictions: {} as Record<string, unknown> }
  let confirmInventory = false
  let channelActive = false
  function land(values: Record<string, unknown>[], dates: Record<string, unknown>, read: (row: Record<string, unknown>) => unknown) {
    for (const row of values) {
      const from = new Date(String(row.date_from))
      const through = new Date(String(row.date_to))
      for (const day = from; day <= through; day.setUTCDate(day.getUTCDate() + 1)) {
        dates[day.toISOString().slice(0, 10)] = read(row)
      }
    }
  }
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace('/api/v1', '')
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    if (method === 'POST') {
      const resource = {
        '/groups': ['group', 'group-1'],
        '/properties': ['property', 'standalone-property'],
        '/room_types': ['room_type', 'standalone-room'],
        '/rate_plans': ['rate_plan', 'standalone-rate'],
      }[path]
      if (resource) {
        const [type, id] = resource
        assert.ok(type && id)
        created.push(path)
        if (type === 'property') assert.equal(body.property.group_id, 'group-1')
        return Response.json({ data: { id, type, attributes: body[type] } })
      }
      if (path === '/availability') land(body.values, inventory.availability, row => row.availability)
      if (path === '/restrictions') land(body.values, inventory.restrictions, row => row)
      if (path === '/auth/one_time_token') {
        assert.ok(confirmInventory)
        assert.equal(body.one_time_token.property_id, 'standalone-property')
        return Response.json({ data: { token: 'test-token' } })
      }
    }
    if (method === 'GET' && ['/groups', '/properties', '/room_types', '/rate_plans/options'].includes(path)) {
      return Response.json({ data: [], meta: { total: 0 } })
    }
    if (method === 'GET' && path === '/channels') {
      return Response.json({ data: channelActive ? [{ id: 'vrbo-standalone', type: 'channel', attributes: {
        channel: 'VRB', is_active: true, properties: ['standalone-property'],
        rate_plans: [{ id: 'vrbo-rate-mapping', rate_plan_id: 'standalone-rate' }],
      } }] : [], meta: { total: Number(channelActive) } })
    }
    if (path === '/properties/standalone-property') {
      return Response.json({ data: { id: 'standalone-property', type: 'property', attributes: { settings: { min_stay_type: 'arrival' } } } })
    }
    if (path === '/rate_plans/standalone-rate') {
      return Response.json({ data: { id: 'standalone-rate', type: 'rate_plan', attributes: { min_stay_arrival: 1, options: [{ is_primary: true, occupancy: 4, rate: '150.00' }] } } })
    }
    if (method === 'GET' && path === '/availability') {
      const values = confirmInventory ? inventory.availability : Object.fromEntries(Object.keys(inventory.availability).map(day => [day, 0]))
      return Response.json({ data: { 'standalone-room': values } })
    }
    if (method === 'GET' && path === '/restrictions') return Response.json({ data: { 'standalone-rate': inventory.restrictions } })
    return await channex.fetch(input, init)
  }) as typeof fetch
  try {
    assert.deepEqual(await vrboHomes(db, env, ORG), [{ product_id: productId, name: 'Cabin', status: 'not_connected' }])
    assert.deepEqual(await startVrboSetup(db, env, ORG, productId, OWNER, 'Owner'), { preparing: true })
    confirmInventory = true
    const ready = await startVrboSetup(db, env, ORG, productId, OWNER, 'Owner')
    assert.ok('url' in ready)
    assert.equal(new URL(ready.url).searchParams.get('property_id'), 'standalone-property')
    assert.deepEqual(created, ['/groups', '/properties', '/room_types', '/rate_plans'])
    assert.deepEqual(await db.prepare('SELECT listing_id, channel_id, property_id, import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), {
      listing_id: null, channel_id: null, property_id: 'standalone-property', import_stage: 'complete', enabled: 0,
    })
    assert.ok(Object.keys(inventory.availability).length > 300)
    const connection = new ChannexConnection(db, env, ORG, OWNER)
    await connection.finishHostedProperty(productId)
    assert.equal(await db.prepare('SELECT enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('enabled'), 0)
    channelActive = true
    channex.revise('standalone-revision', {
      id: 'standalone-stay', property_id: 'standalone-property', ota_name: 'VRBO', status: 'new',
      arrival: '2027-01-10', departure: '2027-01-13', amount: '450.50', revision: 'standalone-revision',
    }, '2026-10-15T01:00:00Z')
    const revision = await applyBookingRevision(db, env, 'standalone-revision')
    assert.equal(revision.status, 'acknowledged')
    assert.equal(await db.prepare('SELECT enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('enabled'), 1)
    assert.deepEqual(await nights(db, revision.booking_id), ['2027-01-10', '2027-01-11', '2027-01-12'])
    channelActive = false
    await connection.finishHostedProperty(productId)
    assert.equal(await db.prepare('SELECT enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('enabled'), 0)
    const reopened = await startVrboSetup(db, env, ORG, productId, OWNER, 'Owner')
    assert.ok('url' in reopened)
    assert.deepEqual(created, ['/groups', '/properties', '/room_types', '/rate_plans'])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
