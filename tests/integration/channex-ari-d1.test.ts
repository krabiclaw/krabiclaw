import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { createProduct, getProduct, reconcileProducts, updateProduct } from '../../server/utils/product-management.ts'
import { localDateAt, localDateTimeToInstant } from '../../utils/timezone.ts'
import { cancelStay, createStay, deliverPendingChannelNights, readHomeCalendar, readStayHome, setStayNights, updateStay, updateStayHome, verifyStayCalendarOccupancy, type StayAccess } from '../../server/domain/stays.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { captureEvents } from './support/events.ts'
import { applySchema } from './support/schema.ts'

// A connected home's night changes reach Channex: closed nights, prices and
// stay rules as restrictions, booked nights as availability, each
// night carrying only what differs from what Channex last confirmed, and
// contiguous nights with the same change as one date range. What Channex took
// is recorded on each night; a partial rejection reads needs_review with the
// reason. A call Channex never confirmed (a 429, a 5xx, an unreadable answer)
// leaves its nights pending with Channex's answer, and the deadline sends
// them. Past nights are not sent.

const ORG = 'org'
const OWNER = 'owner-user'
const TZ = 'America/Denver'
const AIRBNB_AVAILABILITY = { booking_lead_time: 24, max_days_notice: 90, allow_rtb_beyond_max_days_notice: false, default_max_nights: 700, allow_rtb_above_max_nights: false, turnover_days: 1, day_of_week_check_in: [true, true, true, true, true, false, false], day_of_week_check_out: [false, true, true, true, true, true, true] }
const channexEnv = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' }
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }

/** When a home's calendar next gains a night: the daily wake's deadline once nothing waits on Channex. */
function nextRoll(zone = TZ): number {
  const tomorrow = new Date(Date.parse(`${localDateAt(new Date(), zone)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return localDateTimeToInstant(tomorrow, '00:00', zone, 'compatible').getTime()
}

function day(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

type Value = Record<string, unknown> & { date_from: string; date_to: string }

/** Each night a call's date ranges cover, with the values sent for it. */
function byNight(values: readonly Value[]): Map<string, Record<string, unknown>> {
  const nights = new Map<string, Record<string, unknown>>()
  for (const { date_from: from, date_to: to, property_id: _property, rate_plan_id: _rate, room_type_id: _room, ...change } of values) {
    for (let date = from; date <= to; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) nights.set(date, change)
  }
  return nights
}

class FakeChannex {
  airbnbUnavailable = new Set<string>()
  calendarFailure = false
  sent: Array<{ path: string; values: Value[] }> = []
  minimums = new Map(['1', '2', '3'].map(id => [`listing-${id}`, 2]))
  channelSettings: Record<string, unknown> = { min_stay_type: 'Arrival' }
  missingMapping: string | null = null
  ratePlanReads: string[] = []
  properties = new Map(['1', '2', '3'].map(id => [`prop-${id}`, { settings: { min_stay_type: 'arrival' } }]))
  ratePlans = new Map<string, Record<string, unknown>>(['1', '2', '3'].map(id => [`rate-${id}`, { min_stay_arrival: 2, options: [{ occupancy: 4, is_primary: true, rate: id === '1' ? '150.00' : id === '2' ? '0.00' : '90.00' }] }]))
  ratePlanAnswer?: (method: 'GET' | 'PUT') => Response | undefined
  answer: Partial<Record<'/restrictions' | '/availability', () => Response>> = {}
  /** Runs while a call is in flight, before Channex answers it. */
  during?: () => Promise<unknown>

  /** Booking settings Channex sends to the mapped Airbnb listing. */
  settings: Array<{ path: string; body: unknown }> = []
  /** The listings whose whole calendar Channex was asked to send to Airbnb. */
  fullSyncs: string[] = []
  settingsAnswer?: () => Response

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const path = url.pathname.replace('/api/v1', '') as '/restrictions' | '/availability'
    if ((init.method ?? 'GET') === 'GET' && String(path) === '/channels/chan-1/action/get_listing_calendar') {
      if (this.calendarFailure) return Response.json({ errors: { detail: 'Calendar unavailable' } }, { status: 502 })
      const from = url.searchParams.get('date_from')!
      return Response.json({ data: { calendar: { listing_id: url.searchParams.get('listing_id'), start_date: from, end_date: url.searchParams.get('date_to'), days: Array.from({ length: 500 }, (_, offset) => {
        const date = new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
        return { date, availability: this.airbnbUnavailable.has(date) ? 'unavailable' : 'available', daily_price: 150, min_nights: 2, max_nights: 700, closed_to_arrival: false, closed_to_departure: false }
      }) } } })
    }
    if ((init.method ?? 'GET') === 'GET' && (path as string) === '/channels/chan-1') {
      return Response.json({ data: { id: 'chan-1', type: 'channel', attributes: { channel: 'AirBNB', settings: this.channelSettings, rate_plans: ['1', '2', '3'].filter(listing => listing !== this.missingMapping).map(listing => ({ id: `map-${listing}`, rate_plan_id: `rate-${listing}`, settings: { listing_id: `listing-${listing}` } })) } } })
    }
    if ((init.method ?? 'GET') === 'GET' && /^\/properties\/prop-\d$/.test(path)) {
      const id = path.split('/').at(-1)!
      return Response.json({ data: { id, type: 'property', attributes: this.properties.get(id) } })
    }
    if (/^\/rate_plans\/rate-\d$/.test(path)) {
      const id = path.split('/').at(-1)!
      const plan = this.ratePlans.get(id)!
      const response = this.ratePlanAnswer?.(init.method === 'PUT' ? 'PUT' : 'GET')
      if (response) return response
      if (init.method === 'PUT') {
        Object.assign(plan, (JSON.parse(init.body as string) as { rate_plan: { min_stay_arrival: number } }).rate_plan)
      } else this.ratePlanReads.push(id)
      return Response.json({ data: { id, type: 'rate_plan', attributes: plan } })
    }
    // Airbnb's own instant-booking setting, guest controls and guest expectations, which every booking-settings update restates.
    if ((init.method ?? 'GET') === 'GET' && (path as string) === '/channels/chan-1/action/listing_details') {
      return Response.json({ data: { listing: { id: url.searchParams.get('listing_id'), images: null, rooms: [], descriptions: null, pricing_settings: { default_daily_price: 150, listing_currency: 'USD', standard_fees: [], weekly_price_factor: 0, monthly_price_factor: 0 }, availability_rules: { ...AIRBNB_AVAILABILITY, default_min_nights: this.minimums.get(url.searchParams.get('listing_id')!) }, booking_settings: { instant_booking_allowed_category: 'everyone', instant_book_welcome_message: null, check_in_time_start: '16', check_in_time_end: '21', check_out_time: 10, cancellation_policy_settings: { cancellation_policy_category: 'flexible', lts_cancellation_policy_id: 'CANCEL_LONG_TERM_FAIR', non_refundable_price_factor: null }, listing_expectations_for_guests: [{ type: 'requires_stairs', added_details: null }], guest_controls: { allows_children_as_host: true, allows_infants_as_host: true, allows_pets_as_host: false, allows_events_as_host: false, allows_smoking_as_host: false, children_not_allowed_details: null, pet_capacity: null } } } } })
    }
    if (init.method === 'PUT' && (path as string) === '/channels/chan-1/execute/update_booking_setting') {
      this.settings.push({ path, body: JSON.parse(init.body as string) })
      return this.settingsAnswer ? this.settingsAnswer() : Response.json({ data: {} })
    }
    if (init.method === 'POST' && (path as string) === '/meta/airbnb/chan-1/full_sync_listing') {
      const listing = (JSON.parse(init.body as string) as { listing_id: string }).listing_id
      if (listing === `listing-${this.missingMapping}`) return Response.json({ errors: { code: 'resource_not_found', title: 'Resource Not Found' } }, { status: 404 })
      this.fullSyncs.push(listing)
      return Response.json({ meta: { message: 'Success' } })
    }
    assert.equal(init.method, 'POST')
    assert.ok(path === '/restrictions' || path === '/availability', `unexpected ${path}`)
    this.sent.push({ path, values: (JSON.parse(init.body as string) as { values: Value[] }).values })
    await this.during?.()
    const answer = this.answer[path]
    return answer ? answer() : new Response(JSON.stringify({ data: [{ id: `task-${this.sent.length}`, type: 'task' }], meta: { message: 'Success', warnings: [] } }), { status: 200 })
  }

  take() {
    const sent = this.sent
    this.sent = []
    return sent
  }
}

async function boot(airbnbConnected = true) {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'channex-ari-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `
      export class Hub {
        constructor(ctx) { this.ctx = ctx }
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (path === '/wake') {
            const wake = await request.json()
            await this.ctx.storage.put(wake.kind, wake.due_at)
          }
          if (path === '/ari-deadline') return Response.json(await this.ctx.storage.get('channex_ari') ?? null)
          return new Response(null, { status: 204 })
        }
      }
      export default { fetch() { return new Response('ok') } }
    ` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channex-ari-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), ...channexEnv, DB: db, EVENTS: queue.binding,
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-ari-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    bindDatabaseEvents(db, env)
    await applySchema(db)
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'o@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    // A connected host is on a paid plan: three homes are past what Basic includes. No Stripe customer is attached, so nothing is reported.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-org', 'growth', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('site', ?, 'site', 'Site', 'active', ?, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG, TZ).run()
    const home = async (name: string, price: number | null) => (await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name, ...(price === null ? {} : { variants: [{ name, prices: [{ unit_amount: price, currency: 'USD' }] }] }),
      stay: { location_id: 'site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: 'm-owner' },
    } })).id
    const connected = await home('Cabin', 150_00)
    const unpriced = await home('Loft', null)
    const local = await home('Barn', 90_00)
    for (const [productId, listing, enabled] of [[connected, '1', 1], [unpriced, '2', 1], [local, '3', 0]] as const) {
      await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, property_id, room_type_id, rate_plan_id, import_stage, enabled)
        VALUES (?, ?, 'channex', ?, ?, ?, 'complete', ?)`).bind(ORG, productId, `prop-${listing}`, `room-${listing}`, `rate-${listing}`, enabled).run()
      await db.prepare(`INSERT INTO product_airbnb_listings (organization_id, product_id, listing_id, channel_id, import_stage, enabled)
        VALUES (?, ?, ?, 'chan-1', 'complete', ?)`).bind(ORG, productId, `listing-${listing}`, enabled).run()
      // A home that syncs had its calendar ahead sent when it was imported: every night within reach has its
      // delivery row. What Channex confirmed for each is left empty, so the scenarios send each night whole.
      if (enabled) await db.prepare(`INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state)
        SELECT ?, ?, 'channex', value, 'pushed' FROM json_each(?)`).bind(ORG, productId, JSON.stringify(Array.from({ length: 501 }, (_, offset) => day(offset)))).run()
    }
    if (airbnbConnected) await db.prepare("INSERT INTO channex_connections (id,organization_id,status,channel_id,connected_at) VALUES ('account-1', ?, 'connected','chan-1', ?)").bind(ORG, new Date().toISOString()).run()
    return { runtime, db, env, queue, connected, unpriced, local }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

test('night changes on a connected home reach Channex, and what it took is on each night', async (t) => {
  const { runtime, db, env, queue, connected, unpriced, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const states = async (productId: string, from: string, to: string) => (await readHomeCalendar(db, manager, { productId, from, to })).nights.map(night => night.channel)
    const log = async () => (await db.prepare("SELECT kind, external_id, status, detail, task_id FROM channel_sync_log WHERE direction = 'outbound' ORDER BY created_at, rowid").all()).results
    const deliver = () => deliverPendingChannelNights(env, ORG, Date.now())
    const retryAtDeadline = async () => {
      const due = await deliver()
      assert(due !== null && due > Date.now())
      assert.deepEqual(channex.take(), [], 'an early wake respects the provider retry deadline')
      t.mock.timers.enable({ apis: ['Date'], now: due })
      try {
        assert.equal(await deliver(), nextRoll())
      } finally {
        t.mock.timers.reset()
      }
      // The following scenarios start in a separate provider rate window.
      await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()
    }

    // Yesterday through two days ahead: closed and priced; yesterday is not sent. A closed
    // night is stop sell on the rate plan with the unit still in inventory.
    const closed = await setStayNights(db, env, manager, { product_id: connected, from: day(-1), to: day(3), closed: true, price_minor: 175_50, min_stay_arrival: 3 })
    assert.deepEqual(closed.channel_push, { state: 'pushed', detail: null })
    const restriction = { property_id: 'prop-1', rate_plan_id: 'rate-1', rate: '175.50', min_stay_arrival: 3, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: true }
    assert.deepEqual(channex.take(), [
      { path: '/restrictions', values: [{ ...restriction, date_from: day(0), date_to: day(2) }] },
      { path: '/availability', values: [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(0), date_to: day(2), availability: 1 }] },
    ])
    assert.deepEqual(await states(connected, day(-1), day(3)), [null, ...Array(3).fill({ state: 'pushed', detail: null })])
    // Each call keeps the task Channex created for it, which Channex's certification asks for.
    assert.deepEqual((await log()).map(row => [(row as { status: string }).status, (row as { task_id: string | null }).task_id]), [['pushed', 'task-1'], ['pushed', 'task-2']])
    // Opening a night Channex has is one restrictions update, stop sell alone; closing it again the same.
    await setStayNights(db, env, manager, { product_id: connected, from: day(1), to: day(2), closed: false })
    assert.deepEqual(channex.take(), [{ path: '/restrictions', values: [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(1), date_to: day(1), stop_sell: false }] }])
    await setStayNights(db, env, manager, { product_id: connected, from: day(1), to: day(2), closed: true })
    assert.deepEqual(channex.take(), [{ path: '/restrictions', values: [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(1), date_to: day(1), stop_sell: true }] }])
    // Changing the arrival minimum sends only Airbnb's arrival rule.
    await setStayNights(db, env, manager, { product_id: connected, from: day(2), to: day(3), min_stay_arrival: 4 })
    assert.deepEqual(channex.take(), [{ path: '/restrictions', values: [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(2), date_to: day(2), min_stay_arrival: 4 }] }])
    // A minute has passed since those calls, as far as Channex's limit is concerned.
    await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()

    // A host stay holds its nights; cancelling it releases them. The home's own minimum applies where no night sets one.
    const stay = await createStay(db, env, manager, { product_id: connected, idempotency_key: 'k1', check_in_date: day(10), check_out_date: day(12), adults: 2, guest_name: 'Ana', guest_email: 'ana@example.test', total_minor: 300_00 })
    assert.deepEqual(channex.take(), [])
    await queue.runNext(env, 'stay.changed')
    assert.deepEqual(await states(connected, day(10), day(12)), Array(2).fill({ state: 'pushed', detail: null }))
    // A booked night is unavailable, not stop-sold: stop sell is the host closing a night.
    const held = channex.take()
    assert.deepEqual(held[0]!.values.map(value => [value.date_from, value.date_to, value.rate, value.min_stay_arrival, value.stop_sell]), [[day(10), day(11), '150.00', 2, false]])
    assert.deepEqual(held[1]!.values, [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(10), date_to: day(11), availability: 0 }])
    const cancelled = await cancelStay(db, env, manager, stay.id, { version: stay.version })
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(channex.take(), [])
    await queue.runNext(env, 'stay.changed')
    // Only what changed goes: releasing a booking changes availability alone, in one call.
    assert.deepEqual(channex.take(), [
      { path: '/availability', values: [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(10), date_to: day(11), availability: 1 }] },
    ])
    const cancelledRow = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(stay.id).first()
    const cancellationEvents = await db.prepare("SELECT * FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.cancelled' AND json_extract(payload_json, '$.entityId') = ? ORDER BY id").bind(ORG, stay.id).all()
    assert.equal(cancellationEvents.results.length, 1)
    const cancellationNights = await db.prepare('SELECT * FROM stay_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? ORDER BY date').bind(ORG, connected, day(10), day(12)).all()
    const cancellationLog = await log()
    await assert.rejects(cancelStay(db, env, manager, stay.id, { version: stay.version }), (error: { status?: number; data?: Record<string, unknown> }) => {
      assert.equal(error.status, 409)
      assert.partialDeepStrictEqual(error.data, { code: 'STAY_VERSION_CONFLICT', field: 'version' })
      return true
    })
    assert.deepEqual(channex.take(), [])
    assert.deepEqual(await log(), cancellationLog)
    assert.deepEqual(await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(stay.id).first(), cancelledRow)
    assert.deepEqual((await db.prepare('SELECT * FROM stay_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? ORDER BY date').bind(ORG, connected, day(10), day(12)).all()).results, cancellationNights.results)
    // A replay repairs completion; Channex already confirmed these nights, so nothing is sent again.
    const replayedCancellation = await cancelStay(db, env, manager, stay.id, { version: cancelled.version })
    assert.equal(replayedCancellation.version, cancelled.version)
    await queue.drain(env, 'stay.changed')
    assert.deepEqual(channex.take(), [])
    assert.deepEqual(await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(stay.id).first(), cancelledRow)
    assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.cancelled' AND json_extract(payload_json, '$.entityId') = ? ORDER BY id").bind(ORG, stay.id).all()).results, cancellationEvents.results)
    assert.deepEqual((await readHomeCalendar(db, manager, { productId: connected, from: day(10), to: day(12) })).nights.map(night => [night.date, night.booking_id, night.available, night.channel]),
      [10, 11].map(offset => [day(offset), null, true, { state: 'pushed', detail: null }]))

    // A partial rejection is not success: the nights it names read needs_review; availability still goes.
    const warnings = [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(20), date_to: day(20), rate: '0.01', warning: { rate: ['must be greater than 0'] } }]
    channex.answer['/restrictions'] = () => new Response(JSON.stringify({ data: [], meta: { message: 'Success', warnings } }), { status: 200 })
    let rejected: Record<string, unknown> | undefined
    await assert.rejects(setStayNights(db, env, manager, { product_id: connected, from: day(20), to: day(21), price_minor: 1 }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: connected, channel_push: { state: 'needs_review' } })
        assert.deepEqual(error.data?.ranges, [{ from: day(20), to: day(21) }])
        assert.match(error.message!, /rejected part of the restrictions update/)
        assert.match(String(error.data?.reason), /must be greater than 0/)
        rejected = error.data
        return true
      })
    const rejectedCalendar = await readHomeCalendar(db, manager, { productId: connected, from: day(20), to: day(21) })
    assert.deepEqual(rejectedCalendar.nights.map(night => [night.date, night.price_minor, night.closed]), [[day(20), 1, false]])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual(rejectedCalendar.nights.map(night => night.channel), [rejected!.channel_push])

    // A write Channex never confirmed stays pending with Channex's answer; the
    // deadline sends only the part Channex has not confirmed.
    channex.answer['/restrictions'] = undefined
    channex.answer['/availability'] = () => new Response('upstream', { status: 503 })
    const unconfirmed = await setStayNights(db, env, manager, { product_id: connected, from: day(30), to: day(31), closed: true })
    assert.equal(unconfirmed.channel_push?.state, 'pending')
    assert.match(String(unconfirmed.channel_push?.detail), /^Channex did not confirm the availability update for .*: Channex/)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual((await states(connected, day(30), day(31)))[0], unconfirmed.channel_push)
    // A rejection that created no task, and a call Channex never confirmed, keep none.
    assert.deepEqual((await log()).slice(-4).map(row => [(row as { kind: string }).kind, (row as { status: string }).status, (row as { task_id: string | null }).task_id !== null]),
      [['restrictions', 'needs_review', false], ['availability', 'pushed', true], ['restrictions', 'pushed', true], ['availability', 'failed', false]])
    channex.answer['/availability'] = undefined
    await retryAtDeadline()
    assert.deepEqual(channex.take(), [{ path: '/availability', values: [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(30), date_to: day(30), availability: 1 }] }])
    assert.deepEqual((await states(connected, day(30), day(31)))[0], { state: 'pushed', detail: null })

    // A broken provider body is unconfirmed too: Channex may have applied the
    // POST before its body failed, so it is sent again rather than assumed.
    const interruptedReason = 'The Channex response body was interrupted.'
    channex.answer['/restrictions'] = () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(interruptedReason)) },
    }), { status: 200 })
    const interrupted = await setStayNights(db, env, manager, { product_id: connected, from: day(35), to: day(36), closed: true })
    assert.equal(interrupted.channel_push?.state, 'pending')
    assert.match(String(interrupted.channel_push?.detail), new RegExp(`^Channex did not confirm the restrictions update for .*${day(35)}: Channex could not be reached for POST /restrictions: ${interruptedReason}`))
    assert.deepEqual(interrupted.nights.map(night => [night.date, night.closed, night.available]), [[day(35), true, false]])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    // The pending night goes with the next delivery.
    channex.answer['/restrictions'] = undefined
    await retryAtDeadline()
    assert.deepEqual(channex.take().map(request => request.values.map(value => [value.date_from, value.date_to])), [[[day(35), day(35)]]])
    assert.deepEqual(await states(connected, day(35), day(36)), [{ state: 'pushed', detail: null }])

    // A new base price on a connected home reaches every night ahead that has no price of its own.
    // A minute has passed since the calls above, as far as Channex's limit is concerned.
    await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()
    const repriced = await updateStayHome(env, db, manager, connected, { base_price_minor: 160_00 })
    assert.deepEqual([repriced.home.base_price_minor, repriced.channel_push], [160_00, { state: 'pushed', detail: null }])
    assert.deepEqual(channex.ratePlans.get('rate-1')!.options, [{ occupancy: 4, is_primary: true, rate: '160.00' }])
    const ahead = channex.take()
    assert.deepEqual(ahead.map(request => request.path), ['/restrictions', '/availability'])
    const sentByDate = byNight(ahead[0]!.values)
    // Nights with their own price that Channex already has are not sent; a night it has
    // other values for gets only its new rate; a night it never had gets everything.
    assert.equal(sentByDate.has(day(0)), false)
    assert.deepEqual(sentByDate.get(day(10)), { rate: '160.00' })
    assert.deepEqual(sentByDate.get(day(499)), { rate: '160.00', min_stay_arrival: 2, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: false })
    // The nights Channex never had go as one range, not one value per night.
    assert(ahead[0]!.values.some(value => value.date_from === day(36) && value.date_to === day(499)))
    const availableByDate = byNight(ahead[1]!.values)
    assert.equal(availableByDate.has(day(10)) || availableByDate.has(day(0)), false)
    assert.equal(ahead[1]!.values.at(-1)!.date_to, day(499))
    // A rename changes nothing the channel is told.
    assert.equal((await updateStayHome(env, db, manager, connected, { name: 'Cabin by the cliff' })).channel_push, null)
    assert.deepEqual(channex.take(), [])

    // A connected home with no nightly price still sends its availability and rules; the missing price needs review.
    channex.answer['/availability'] = undefined
    const noPriceOutcome = { state: 'needs_review', detail: `${day(5)} has no nightly price; Channex needs one for every night` }
    await assert.rejects(setStayNights(db, env, manager, { product_id: unpriced, from: day(5), to: day(6), closed: true }),
      (error: { status?: number; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: unpriced, reason: noPriceOutcome.detail, channel_push: noPriceOutcome })
        assert.deepEqual(error.data?.ranges, [{ from: day(5), to: day(6) }])
        return true
      })
    const noPrice = await readHomeCalendar(db, manager, { productId: unpriced, from: day(5), to: day(6) })
    assert.deepEqual(noPrice.nights.map(night => [night.date, night.closed, night.price_minor, night.channel]), [[day(5), true, null, noPriceOutcome]])
    assert.deepEqual(channex.take(), [
      { path: '/restrictions', values: [{ property_id: 'prop-2', rate_plan_id: 'rate-2', date_from: day(5), date_to: day(5), min_stay_arrival: 2, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: true }] },
      { path: '/availability', values: [{ property_id: 'prop-2', room_type_id: 'room-2', date_from: day(5), date_to: day(5), availability: 1 }] },
    ])
    // Without the Channex configuration a connected home's nights are not changed at all.
    await assert.rejects(setStayNights(db, {}, manager, { product_id: connected, from: day(40), to: day(41), closed: true }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.match(error.message!, /CHANNEX_BASE_URL and CHANNEX_API_KEY are required/)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_CONFIGURATION_REQUIRED', field: 'CHANNEX_BASE_URL' })
        assert.equal(Object.hasOwn(error.data ?? {}, 'committed'), false)
        return true
      })
    assert.equal((await readHomeCalendar(db, manager, { productId: connected, from: day(40), to: day(41) })).nights[0]!.closed, false)
    // A home whose channel is disconnected sends nothing, and says it is disconnected.
    assert.deepEqual((await readStayHome(db, manager, connected)).channel, { provider: 'channex', status: 'connected' })
    const offline = await setStayNights(db, env, manager, { product_id: local, from: day(5), to: day(6), closed: true })
    assert.deepEqual((await readStayHome(db, manager, local)).channel, { provider: 'channex', status: 'disconnected' })
    assert.equal(offline.channel_push, null)
    assert.deepEqual(offline.nights.map(night => night.channel), [null])
    assert.deepEqual(channex.take(), [])

    // A refused event send still leaves the committed inventory in the delivery outbox.
    await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()
    const original = await createStay(db, env, manager, { product_id: connected, idempotency_key: 'edit-without-event',
      check_in_date: day(50), check_out_date: day(52), adults: 2, guest_name: 'Dana', guest_email: 'dana@example.test', total_minor: 300_00 })
    await queue.drain(env, 'stay.changed')
    channex.take()
    const after = Date.now()
    await assert.rejects(updateStay(db, { ...env, EVENTS: { async send() { throw new Error('Event send refused') } } }, manager, original.id,
      { version: original.version, check_in_date: day(53), check_out_date: day(55) }), /Event send refused/)
    const changes = await readHomeCalendar(db, manager, { productId: connected, from: day(50), to: day(55) })
    assert.deepEqual(changes.nights.filter(night => night.channel?.state === 'pending').map(night => [night.date, night.booking_id]),
      [[day(50), null], [day(51), null], [day(53), original.id], [day(54), original.id]])
    const namespace = env.GUEST_INBOX_HUBS!
    const wake = await namespace.get(namespace.idFromName(ORG)).fetch('https://guest-inbox.internal/ari-deadline')
    assert.ok(Number(await wake.json()) >= after)
    await deliverPendingChannelNights(env, ORG, Date.now())
    const availability = channex.take().flatMap(call => call.path === '/availability' ? call.values : [])
    assert.deepEqual(availability.map(value => [value.date_from, value.date_to, value.availability]),
      [[day(50), day(51), 1], [day(53), day(54), 0]])
    // Two days on, the calendar has gained a night Channex was never sent: the wake sends it with the rest of the
    // calendar's last week, which Channex may not have kept when it was first sent, and has Channex
    // send the listing's whole calendar to Airbnb, which is what puts back a night changed on Airbnb itself.
    await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()
    channex.take()
    channex.fullSyncs.length = 0
    // Channex no longer maps the second listing: its full sync is refused, and that home's nights say why.
    channex.missingMapping = '2'
    t.mock.timers.enable({ apis: ['Date'], now: localDateTimeToInstant(day(2), '12:00', TZ, 'compatible').getTime() })
    try {
      await deliver()
    } finally {
      t.mock.timers.reset()
    }
    assert.deepEqual(channex.take().map(request => [request.path, request.values.filter(value => value.property_id === 'prop-1').map(value => [value.date_from, value.date_to])]).filter(([, nights]) => nights!.length),
      [['/restrictions', [[day(495), day(501)]]], ['/availability', [[day(495), day(501)]]]])
    assert.deepEqual(channex.fullSyncs, ['listing-1'])
    assert.deepEqual((await states(unpriced, day(5), day(6)))[0], { state: 'needs_review', detail: 'Channex has no Airbnb mapping for this connected home' })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('catalog and dated rules persist channel work and recover the planned minimum after a failure', async () => {
  const { runtime, db, env, queue, connected, unpriced, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    // An Airbnb setting the channel cannot take refuses the whole catalog write before anything changes.
    const beforeRefusal = await Promise.all([connected, local].map(id => getProduct(db, ORG, id)))
    const { photo_rooms: _refusedRooms, accessibility: _refusedAccessibility, ...refusedStay } = beforeRefusal[0]!.stay!
    await assert.rejects(reconcileProducts(db, { env, organizationId: ORG, actor: { actorId: OWNER }, products: [
      { product_id: local, kind: 'stay', name: 'Must remain Barn' },
      { product_id: connected, kind: 'stay', name: 'Must remain Cabin', stay: { ...refusedStay, check_in_time: '16:30' } },
    ] }), { status: 422, data: { code: 'AIRBNB_UNSUPPORTED_VALUE', field: 'check_in_time' } })
    assert.deepEqual(await Promise.all([connected, local].map(id => getProduct(db, ORG, id))), beforeRefusal)
    assert.deepEqual(channex.take(), [])
    assert.deepEqual(channex.settings, [])

    const before = await getProduct(db, ORG, connected)
    const variant = before.variants[0]!
    const price = variant.prices[0]!
    const patch = { variants: [{ id: variant.id, prices: [{ id: price.id, unit_amount: 170_00 }] }] }
    const unavailable = { ...env, CHANNEX_BASE_URL: undefined, CHANNEX_API_KEY: undefined }
    await assert.rejects(updateProduct(db, { env: unavailable, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch }),
      (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_CONFIGURATION_REQUIRED' && error.data.field === 'CHANNEX_BASE_URL' && !Object.hasOwn(error.data, 'committed'))
    assert.equal((await getProduct(db, ORG, connected)).variants[0]!.prices[0]!.unit_amount, 150_00)
    assert.deepEqual(channex.take(), [])

    // An explicit absent-price edit has no pricing SQL, but must still preflight
    // before any accompanying name or location timezone is changed.
    await assert.rejects(updateStayHome(unavailable, db, manager, unpriced, { name: 'Must remain Loft', timezone: 'UTC', base_price_minor: null }),
      (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_CONFIGURATION_REQUIRED' && !Object.hasOwn(error.data, 'committed'))
    assert.equal((await getProduct(db, ORG, unpriced)).name, 'Loft')
    assert.equal((await readHomeCalendar(db, manager, { productId: unpriced, from: day(0), to: day(1) })).home.timezone, TZ)
    assert.deepEqual(channex.take(), [])

    const update = { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch, idempotencyKey: 'catalog-price' }
    const saved = await updateProduct(db, update)
    assert.deepEqual(saved.channel_push, { state: 'pushed', detail: null })
    const published = channex.take()
    // 500 nights Channex never had, all alike: one range per call.
    assert.deepEqual(published.map(request => [request.path, request.values.length]), [['/restrictions', 1], ['/availability', 1]])
    assert.deepEqual([published[0]!.values[0]!.date_from, published[0]!.values[0]!.date_to], [day(0), day(499)])
    assert(published[0]!.values.every(value => value.rate === '170.00' && value.min_stay_arrival === 2))
    assert.equal(Object.hasOwn(await getProduct(db, ORG, connected), 'channel_push'), false, 'a completion receipt is not a stored Product field')

    // A recognized write replay repairs completion without editing the product again.
    const replay = await updateProduct(db, update)
    assert.equal(replay.updated_at, saved.updated_at)
    assert.equal(replay.variants[0]!.prices[0]!.id, price.id)
    assert.deepEqual(replay.channel_push, { state: 'pushed', detail: null })
    // Channex confirmed every night already, so the replay sends nothing.
    assert.deepEqual(channex.take(), [])

    const { photo_rooms: _photoRooms, accessibility: _accessibility, ...stayInput } = saved.stay!
    const reconciled = await reconcileProducts(db, { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'catalog-minimum', products: [{
      product_id: connected, name: 'Cabin', kind: 'stay', stay: { ...stayInput, min_nights: 3 },
      variants: [{ id: variant.id, name: variant.name, prices: [{ id: price.id, unit_amount: 180_00, currency: 'USD' }] }],
    }] })
    assert.deepEqual(reconciled[0]!.channel_push, { state: 'pushed', detail: null })
    const minimum = channex.take()
    assert.deepEqual(minimum.map(request => [request.path, request.values.length]), [['/restrictions', 1]])
    // A home default affects arrival only; an absent through rule stays absent.
    assert.deepEqual(minimum[0]!.values, [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(0), date_to: day(499), rate: '180.00', min_stay_arrival: 3 }])

    const calendar = await readHomeCalendar(db, manager, { productId: connected, from: day(0), to: day(1) })
    assert.deepEqual(calendar.nights[0]!.channel, { state: 'pushed', detail: null })

    // A rate-plan error before the dated send leaves the saved default queued.
    channex.ratePlanAnswer = method => method === 'PUT' ? Response.json({ errors: { detail: 'Rate plan unavailable' } }, { status: 503 }) : undefined
    await assert.rejects(updateStayHome(env, db, manager, connected, { min_nights: 21 }),
      (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
    assert.equal((await getProduct(db, ORG, connected)).stay!.min_nights, 21)
    assert.equal(channex.ratePlans.get('rate-1')!.min_stay_arrival, 3)
    assert.deepEqual(channex.take(), [])
    const pendingDefault = await readHomeCalendar(db, manager, { productId: connected, from: day(0), to: day(1) })
    assert.deepEqual([pendingDefault.nights[0]!.min_stay_arrival, pendingDefault.nights[0]!.channel?.state], [21, 'pending'])
    assert.match(pendingDefault.nights[0]!.channel!.detail!, /Rate plan unavailable/)
    assert((await deliverPendingChannelNights(env, ORG, Date.now()))! > Date.now(), 'a transient failure still has a recovery deadline')

    // A booking still closes its mapped room while the rate plan cannot be read.
    channex.ratePlanAnswer = method => method === 'GET' ? Response.json({ errors: { detail: 'Rate plan read unavailable' } }, { status: 503 }) : undefined
    const booked = await createStay(db, env, manager, { product_id: connected, idempotency_key: 'stay-during-rate-outage', check_in_date: day(10), check_out_date: day(12), adults: 2, guest_name: 'Ana', guest_email: 'ana@example.test', total_minor: 360_00 })
    await assert.rejects(queue.runNext(env, 'stay.changed'), /Rate plan read unavailable/)
    assert.deepEqual(channex.take(), [{ path: '/availability', values: [
      { property_id: 'prop-1', room_type_id: 'room-1', date_from: day(10), date_to: day(11), availability: 0 },
    ] }])
    const held = await readHomeCalendar(db, manager, { productId: connected, from: day(10), to: day(12) })
    assert.deepEqual(held.nights.map(night => [night.booking_id, night.available, night.channel?.state]), Array(2).fill([booked.id, false, 'pending']))
    assert.deepEqual(await db.prepare(`SELECT json_extract(sent_json, '$.availability') AS availability,
      json_extract(sent_json, '$.min_stay_arrival') AS min_stay_arrival FROM channel_night_pushes WHERE product_id = ? AND date = ?`).bind(connected, day(10)).first(),
    { availability: 0, min_stay_arrival: 3 })

    channex.ratePlanAnswer = undefined
    assert.equal(await deliverPendingChannelNights(env, ORG, Date.now()), nextRoll())
    assert.equal(channex.ratePlans.get('rate-1')!.min_stay_arrival, 21)
    const recovered = channex.take()
    assert.deepEqual(recovered, [{ path: '/restrictions', values: [
      { property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(0), date_to: day(499), min_stay_arrival: 21 },
    ] }])
    await queue.drain(env, 'stay.changed')
    assert.deepEqual(channex.take(), [], 'booking redelivery keeps the confirmed room occupancy')

    // An event failure before the provider call cannot leave the date saved without work.
    bindDatabaseEvents(db, { EVENTS: { send: async () => { throw new Error('Wake unavailable') } } })
    try {
      await assert.rejects(setStayNights(db, env, manager, { product_id: connected, from: day(1), to: day(2), min_stay_arrival: 30 }),
        /Set stay nights committed, but its events could not be published/)
    } finally { bindDatabaseEvents(db, env) }
    const pending = await readHomeCalendar(db, manager, { productId: connected, from: day(0), to: day(2) })
    assert.deepEqual(pending.nights.map(night => [night.min_stay_arrival, night.channel?.state]), [[21, 'pushed'], [30, 'pending']])
    assert.deepEqual(channex.take(), [])

    assert.equal(await deliverPendingChannelNights(env, ORG, Date.now()), nextRoll())
    assert.equal(channex.ratePlans.get('rate-1')!.min_stay_arrival, 21)
    assert.deepEqual(channex.take(), [{ path: '/restrictions', values: [
      { property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(1), date_to: day(1), min_stay_arrival: 30 },
    ] }])
    const delivered = await readHomeCalendar(db, manager, { productId: connected, from: day(0), to: day(2) })
    assert.deepEqual(delivered.nights.map(night => [night.min_stay_arrival, night.channel?.state]), [[21, 'pushed'], [30, 'pushed']])

    // Every affected home is preflighted before any row in the atomic catalog changes.
    await assert.rejects(reconcileProducts(db, { env: unavailable, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'unavailable-batch', products: [
      { product_id: local, kind: 'stay', name: 'Must remain Barn' },
      { product_id: connected, kind: 'stay', name: 'Must remain Cabin', stay: { ...stayInput, min_nights: 4 } },
    ] }), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_CONFIGURATION_REQUIRED' && !Object.hasOwn(error.data, 'committed'))
    assert.equal((await getProduct(db, ORG, local)).name, 'Barn')
    assert.equal((await getProduct(db, ORG, connected)).stay!.min_nights, 21)
    assert.deepEqual(channex.take(), [])

    // A warning that names no dates refuses every night of its call.
    channex.answer['/restrictions'] = () => Response.json({ data: [], meta: { message: 'Success', warnings: [{ rate: ['refused'] }] } })
    let refused: Record<string, unknown> | undefined
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { stay: { min_nights: 4 } } }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: connected, channel_push: { state: 'needs_review' } })
        assert.equal(typeof error.data?.updated_at, 'string')
        assert.match(error.message!, /Channex rejected part of the restrictions update/)
        assert.match(String(error.data?.reason), /Channex rejected part of the restrictions update/)
        refused = error.data
        return true
      })
    const refusedProduct = await getProduct(db, ORG, connected)
    assert.equal(refusedProduct.stay!.min_nights, 4)
    assert.equal(refusedProduct.updated_at, refused!.updated_at)
    const refusedCalendar = await readHomeCalendar(db, manager, { productId: connected, from: day(0), to: day(1) })
    assert.deepEqual(refusedCalendar.nights.map(night => night.channel), [refused!.channel_push])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])

    // The native home's combined timezone and base-price edit completes once, after the timezone lands.
    channex.answer['/restrictions'] = undefined
    const changed = await updateStayHome(env, db, manager, connected, { timezone: 'Pacific/Kiritimati', base_price_minor: 190_00 })
    assert.deepEqual(changed.channel_push, { state: 'pushed', detail: null })
    const once = channex.take()
    const newToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    assert.equal(once[0]!.path, '/restrictions')
    const repricedNights = byNight(once[0]!.values)
    assert.equal(repricedNights.size, 500)
    assert.equal(once[0]!.values[0]!.date_from, newToday)
    assert([...repricedNights.values()].every(value => value.rate === '190.00'))
    // Availability goes only for the nights the new timezone brought within reach, which Channex never had:
    // as many as Kiritimati's date is ahead of the home's old one.
    const gained = Math.round((Date.parse(`${newToday}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / 86_400_000)
    assert.deepEqual(once.slice(1).map(request => [request.path, [...byNight(request.values).keys()]]),
      gained ? [['/availability', Array.from({ length: gained }, (_, offset) => day(500 + offset))]] : [])

    const barn = await getProduct(db, ORG, local)
    const disconnected = await updateProduct(db, { env, organizationId: ORG, productId: local, actor: { actorId: OWNER }, patch: {
      variants: [{ id: barn.variants[0]!.id, prices: [{ id: barn.variants[0]!.prices[0]!.id, unit_amount: 95_00 }] }],
    } })
    assert.equal(disconnected.channel_push, null)
    assert.deepEqual(channex.take(), [])

    // A saved change for a listing whose provider mapping is gone cannot block another home's dated rules.
    await updateStayHome(env, db, manager, unpriced, { base_price_minor: 125_00 })
    channex.take()
    const healthyNight = day(5)
    bindDatabaseEvents(db, { EVENTS: { send: async () => { throw new Error('Wake unavailable') } } })
    try {
      await assert.rejects(updateStayHome(env, db, manager, connected, { min_nights: 100 }), /Update product committed, but its events could not be published/)
      await assert.rejects(setStayNights(db, env, manager, { product_id: unpriced, from: healthyNight, to: day(6), min_stay_arrival: 30 }),
        /Set stay nights committed, but its events could not be published/)
    } finally { bindDatabaseEvents(db, env) }
    channex.missingMapping = '1'
    channex.ratePlanReads.length = 0
    assert.equal(await deliverPendingChannelNights(env, ORG, Date.now()), nextRoll('Pacific/Kiritimati'))
    assert.deepEqual(channex.ratePlanReads, [], 'ordinary dated delivery does not read defaults')
    const unavailableHome = await readHomeCalendar(db, manager, { productId: connected, from: newToday, to: day(6) })
    assert.deepEqual(unavailableHome.nights[0]!.channel,
      { state: 'needs_review', detail: 'Channex has no Airbnb mapping for this connected home' })
    assert.deepEqual(channex.take(), [{ path: '/restrictions', values: [
      { property_id: 'prop-2', rate_plan_id: 'rate-2', date_from: healthyNight, date_to: healthyNight, min_stay_arrival: 30 },
    ] }])
    const healthyHome = await readHomeCalendar(db, manager, { productId: unpriced, from: healthyNight, to: day(6) })
    assert.deepEqual([healthyHome.nights[0]!.min_stay_arrival, healthyHome.nights[0]!.channel?.state], [30, 'pushed'])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('migration verification reads Airbnb availability and refuses missing channel or uncovered dates', { timeout: 120_000 }, async () => {
  const { runtime, db, env, connected, local } = await boot(false)
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const dates = [day(2), day(3)]
    assert.equal((await verifyStayCalendarOccupancy(db, env, manager, connected, dates)).state, 'not_connected')
    await db.prepare("INSERT INTO channex_connections (id,organization_id,status,channel_id,connected_at) VALUES ('account-1', ?, 'connected','chan-1', ?)").bind(ORG, new Date().toISOString()).run()
    await createStay(db, env, manager, { product_id: connected, idempotency_key: 'migration-verification-stay', check_in_date: day(2), check_out_date: day(4), guest_name: 'Imported guest', guest_email: 'imported-guest@example.test', adults: 1, total_minor: 30_000 })
    const mismatch = await verifyStayCalendarOccupancy(db, env, manager, connected, dates)
    assert.equal(mismatch.state, 'needs_attention')
    assert.deepEqual(mismatch.mismatches, dates)
    for (const date of dates) channex.airbnbUnavailable.add(date)
    assert.deepEqual(await verifyStayCalendarOccupancy(db, env, manager, connected, dates), { state: 'verified', checked_dates: dates, unverified_dates: [], mismatches: [], detail: null })
    assert.equal((await verifyStayCalendarOccupancy(db, env, manager, local, dates)).state, 'needs_attention')
    const outside = await verifyStayCalendarOccupancy(db, env, manager, connected, [...dates, day(500)])
    assert.equal(outside.state, 'needs_attention')
    assert.deepEqual(outside.unverified_dates, [day(500)])
    channex.calendarFailure = true
    await assert.rejects(verifyStayCalendarOccupancy(db, env, manager, connected, dates), /502/)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
