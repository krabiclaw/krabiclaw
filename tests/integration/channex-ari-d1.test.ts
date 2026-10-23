import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct, getProduct, reconcileProducts, updateProduct } from '../../server/utils/product-management.ts'
import { cancelStay, createStay, readStayCalendar, releaseLapsedStayHolds, setStayNights, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A connected home's night changes reach Channex: closed nights, prices and
// stay rules as restrictions, held nights as availability. What Channex took
// is recorded on each night; a partial rejection or an outcome it never
// confirmed reads needs_review with the reason. Past nights are not sent.

const ORG = 'org'
const OWNER = 'owner-user'
const TZ = 'America/Denver'
const channexEnv = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' }
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }

function day(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

type Value = Record<string, unknown> & { date: string }

class FakeChannex {
  sent: Array<{ path: string; values: Value[] }> = []
  answer: Partial<Record<'/restrictions' | '/availability', () => Response>> = {}

  /** The listing settings a minimum-stay change sends, by mapping: Airbnb's default minimum before each night's own. */
  settings: Array<{ path: string; body: unknown }> = []
  settingsAnswer?: () => Response

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const path = url.pathname.replace('/api/v1', '') as '/restrictions' | '/availability'
    if ((init.method ?? 'GET') === 'GET' && (path as string) === '/channels/chan-1') {
      return Response.json({ data: { id: 'chan-1', type: 'channel', attributes: { rate_plans: ['1', '2', '3'].map(listing => ({ id: `map-${listing}`, rate_plan_id: `rate-${listing}`, settings: { listing_id: `listing-${listing}` } })) } } })
    }
    if (init.method === 'PUT' && (/^\/channels\/chan-1\/mappings\/map-\d\/availability_settings$/.test(path) || (path as string) === '/channels/chan-1/execute/update_booking_setting')) {
      this.settings.push({ path, body: JSON.parse(init.body as string) })
      return this.settingsAnswer ? this.settingsAnswer() : Response.json({ data: {} })
    }
    assert.equal(init.method, 'POST')
    assert.ok(path === '/restrictions' || path === '/availability', `unexpected ${path}`)
    this.sent.push({ path, values: (JSON.parse(init.body as string) as { values: Value[] }).values })
    const answer = this.answer[path]
    return answer ? answer() : new Response(JSON.stringify({ data: [{ id: 'task-1', type: 'task' }], meta: { message: 'Success', warnings: [] } }), { status: 200 })
  }

  take() {
    const sent = this.sent
    this.sent = []
    return sent
  }
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'channex-ari-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channex-ari-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), ...channexEnv }
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
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
      stay: { location_id: 'site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: null, assigned_team_id: null },
    } })).id
    const connected = await home('Cabin', 150_00)
    const unpriced = await home('Loft', null)
    const local = await home('Barn', 90_00)
    for (const [productId, listing, enabled] of [[connected, '1', 1], [unpriced, '2', 1], [local, '3', 0]] as const) {
      await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
        VALUES (?, ?, 'channex', ?, 'chan-1', ?, ?, ?, 'complete', ?)`).bind(ORG, productId, `listing-${listing}`, `prop-${listing}`, `room-${listing}`, `rate-${listing}`, enabled).run()
    }
    return { runtime, db, env, connected, unpriced, local }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

test('lapsed hold failures retain their claims and report every failure after independent holds release', async () => {
  const { runtime, db, env, connected, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const now = new Date().toISOString()
    for (const [id, productId, offset] of [['00-channel-failure', connected, 60], ['01-delete-failure', connected, 61], ['02-independent', local, 62]] as const) {
      await db.prepare(`INSERT INTO payments (id, organization_id, stripe_account_id, livemode, subject_type, currency, amount, price_snapshot_json, created_at, updated_at)
        VALUES (?, ?, 'acct_hold_proof', 0, 'stay', 'USD', 15000, '{}', ?, ?)`).bind(id, ORG, now, now).run()
      await db.prepare(`INSERT INTO payment_checkout_holds (id, organization_id, product_id, location_id, timezone, payment_id, quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at)
        VALUES (?, ?, ?, 'site', ?, ?, 1, 15000, 'USD', ?, ?, 'active', '2000-01-01T00:00:00.000Z', ?)`).bind(id, ORG, productId, TZ, id, day(offset), day(offset + 1), now).run()
      await db.prepare('INSERT INTO stay_nights (organization_id, product_id, date, hold_id) VALUES (?, ?, ?, ?)').bind(ORG, productId, day(offset), id).run()
    }
    await db.prepare(`CREATE TRIGGER refuse_one_hold_release BEFORE DELETE ON stay_nights WHEN OLD.hold_id = '01-delete-failure'
      BEGIN SELECT RAISE(ABORT, 'Hold release deletion refused'); END`).run()
    let firstRestriction = true
    channex.answer['/restrictions'] = () => {
      if (!firstRestriction) return new Response(JSON.stringify({ data: [], meta: { message: 'Success', warnings: [] } }), { status: 200 })
      firstRestriction = false
      return new Response(JSON.stringify({ data: [], meta: { message: 'Success', warnings: [{ warning: 'Release refused' }] } }), { status: 200 })
    }
    await assert.rejects(releaseLapsedStayHolds(db, env), (error: unknown) => {
      assert(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      const failedPush = error.errors.find((failure: { data?: { code?: string } }) => failure.data?.code === 'CHANNEL_PUSH_FAILED')
      assert.equal(failedPush?.status, 503)
      assert.partialDeepStrictEqual(failedPush.data, { committed: true, product_id: connected, ranges: [{ from: day(60), to: day(61) }], channel_push: { state: 'needs_review' } })
      assert.match(error.message, /Release refused/)
      assert.match(error.message, /Hold release deletion refused/)
      return true
    })
    assert.deepEqual((await db.prepare('SELECT hold_id, date FROM stay_nights ORDER BY hold_id').all()).results, [
      { hold_id: '00-channel-failure', date: day(60) }, { hold_id: '01-delete-failure', date: day(61) },
    ])
    const sent = channex.take()
    assert.deepEqual(sent.map(request => [request.path, request.values.map(value => value.date)]), [
      ['/restrictions', [day(60)]], ['/restrictions', [day(61)]], ['/availability', [day(61)]],
    ])
    assert.deepEqual((await readStayCalendar(db, manager, { productId: connected, from: day(60), to: day(62) })).nights.map(night => [night.available, night.channel?.state]), [[true, 'needs_review'], [true, 'pushed']])
    assert.deepEqual((await readStayCalendar(db, manager, { productId: local, from: day(62), to: day(63) })).nights.map(night => [night.available, night.channel]), [[true, null]])
    await db.prepare('DROP TRIGGER refuse_one_hold_release').run()
    channex.answer['/restrictions'] = undefined
    assert.deepEqual(await releaseLapsedStayHolds(db, env), { released: 2, channel_push: [{ state: 'pushed', detail: null }, { state: 'pushed', detail: null }] })
    assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('night changes on a connected home reach Channex, and what it took is on each night', async () => {
  const { runtime, db, env, connected, unpriced, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const states = async (productId: string, from: string, to: string) => (await readStayCalendar(db, manager, { productId, from, to })).nights.map(night => night.channel)
    const log = async () => (await db.prepare("SELECT kind, external_id, status, detail FROM channel_sync_log WHERE direction = 'outbound' ORDER BY created_at, rowid").all()).results

    // Yesterday through two days ahead: closed and priced; yesterday is not sent.
    const closed = await setStayNights(db, env, manager, { product_id: connected, from: day(-1), to: day(3), closed: true, price_minor: 175_50, min_stay_arrival: 3 })
    assert.deepEqual(closed.channel_push, { state: 'pushed', detail: null })
    const restriction = { property_id: 'prop-1', rate_plan_id: 'rate-1', rate: '175.50', min_stay_arrival: 3, min_stay_through: 1, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: true }
    assert.deepEqual(channex.take(), [
      { path: '/restrictions', values: [0, 1, 2].map(offset => ({ ...restriction, date: day(offset) })) },
      { path: '/availability', values: [0, 1, 2].map(offset => ({ property_id: 'prop-1', room_type_id: 'room-1', date: day(offset), availability: 0 })) },
    ])
    assert.deepEqual(await states(connected, day(-1), day(3)), [null, ...Array(3).fill({ state: 'pushed', detail: null })])
    assert.deepEqual((await log()).map(row => (row as { status: string }).status), ['pushed', 'pushed'])

    // A host stay holds its nights; cancelling it releases them. The home's own minimum applies where no night sets one.
    const stay = await createStay(db, env, manager, { product_id: connected, idempotency_key: 'k1', check_in_date: day(10), check_out_date: day(12), adults: 2, guest_name: 'Ana', total_minor: 300_00 })
    assert.deepEqual(stay.channel_push, { state: 'pushed', detail: null })
    const held = channex.take()
    assert.deepEqual(held[0]!.values.map(value => [value.date, value.rate, value.min_stay_arrival, value.stop_sell]), [[day(10), '150.00', 2, true], [day(11), '150.00', 2, true]])
    assert.deepEqual(held[1]!.values.map(value => value.availability), [0, 0])
    const cancelled = await cancelStay(db, env, manager, stay.id, { expected_version: stay.version })
    assert.deepEqual(cancelled.channel_push, { state: 'pushed', detail: null })
    assert.deepEqual(channex.take()[1]!.values.map(value => value.availability), [1, 1])
    const cancelledRow = await db.prepare('SELECT * FROM stays WHERE id = ?').bind(stay.id).first()
    const cancellationEvents = await db.prepare("SELECT * FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.cancelled' AND json_extract(payload_json, '$.entityId') = ? ORDER BY id").bind(ORG, stay.id).all()
    assert.equal(cancellationEvents.results.length, 1)
    const cancellationNights = await db.prepare('SELECT * FROM stay_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? ORDER BY date').bind(ORG, connected, day(10), day(12)).all()
    const cancellationLog = await log()
    await assert.rejects(cancelStay(db, env, manager, stay.id, { expected_version: stay.version }), (error: { status?: number; data?: Record<string, unknown> }) => {
      assert.equal(error.status, 409)
      assert.partialDeepStrictEqual(error.data, { code: 'STAY_VERSION_CONFLICT', field: 'expected_version' })
      return true
    })
    assert.deepEqual(channex.take(), [])
    assert.deepEqual(await log(), cancellationLog)
    assert.deepEqual(await db.prepare('SELECT * FROM stays WHERE id = ?').bind(stay.id).first(), cancelledRow)
    assert.deepEqual((await db.prepare('SELECT * FROM stay_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? ORDER BY date').bind(ORG, connected, day(10), day(12)).all()).results, cancellationNights.results)
    const replayedCancellation = await cancelStay(db, env, manager, stay.id, { expected_version: cancelled.version })
    assert.deepEqual(replayedCancellation.channel_push, { state: 'pushed', detail: null })
    const repaired = channex.take()
    assert.deepEqual(repaired.map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual(repaired[1]!.values.map(value => value.availability), [1, 1])
    assert.deepEqual(await db.prepare('SELECT * FROM stays WHERE id = ?').bind(stay.id).first(), cancelledRow)
    assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.cancelled' AND json_extract(payload_json, '$.entityId') = ? ORDER BY id").bind(ORG, stay.id).all()).results, cancellationEvents.results)
    assert.deepEqual((await readStayCalendar(db, manager, { productId: connected, from: day(10), to: day(12) })).nights.map(night => [night.date, night.stay_id, night.available, night.channel]),
      [10, 11].map(offset => [day(offset), null, true, { state: 'pushed', detail: null }]))

    // A partial rejection is not success: the nights read needs_review, and availability is not sent after it.
    const warnings = [{ date: day(20), warning: { rate: ['must be greater than 0'] } }]
    channex.answer['/restrictions'] = () => new Response(JSON.stringify({ data: [], meta: { message: 'Success', warnings } }), { status: 200 })
    let rejected: Record<string, unknown> | undefined
    await assert.rejects(setStayNights(db, env, manager, { product_id: connected, from: day(20), to: day(21), price_minor: 1 }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: connected, channel_push: { state: 'needs_review' } })
        assert.deepEqual(error.data?.ranges, [{ from: day(20), to: day(21) }])
        assert.match(error.message!, /rejected part of the update/)
        assert.match(String(error.data?.reason), /rejected part of the update/)
        rejected = error.data
        return true
      })
    const rejectedCalendar = await readStayCalendar(db, manager, { productId: connected, from: day(20), to: day(21) })
    assert.deepEqual(rejectedCalendar.nights.map(night => [night.date, night.price_minor, night.closed]), [[day(20), 1, false]])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])
    assert.deepEqual(rejectedCalendar.nights.map(night => night.channel), [rejected!.channel_push])

    // A write Channex never confirmed is unknown, and says so.
    channex.answer['/restrictions'] = undefined
    channex.answer['/availability'] = () => new Response('upstream', { status: 503 })
    let unknown: Record<string, unknown> | undefined
    await assert.rejects(setStayNights(db, env, manager, { product_id: connected, from: day(30), to: day(31), closed: true }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: connected, channel_push: { state: 'needs_review' } })
        assert.deepEqual(error.data?.ranges, [{ from: day(30), to: day(31) }])
        assert.match(error.message!, /did not confirm the availability update; its outcome is unknown/)
        assert.match(String(error.data?.reason), /did not confirm the availability update; its outcome is unknown/)
        unknown = error.data
        return true
      })
    const unknownCalendar = await readStayCalendar(db, manager, { productId: connected, from: day(30), to: day(31) })
    assert.deepEqual(unknownCalendar.nights.map(night => [night.date, night.closed]), [[day(30), true]])
    assert.deepEqual((await states(connected, day(30), day(31)))[0], unknown!.channel_push)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual((await log()).slice(-3).map(row => [(row as { kind: string }).kind, (row as { status: string }).status]), [['restrictions', 'needs_review'], ['restrictions', 'pushed'], ['availability', 'needs_review']])

    // A broken HTTP body is a raw failure, with no confirmed review outcome.
    // Its committed closure survives and the channel's persisted state stays pending.
    const interruptedReason = 'The Channex response body was interrupted.'
    channex.answer['/restrictions'] = () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(interruptedReason)) },
    }), { status: 200 })
    await assert.rejects(setStayNights(db, env, manager, { product_id: connected, from: day(35), to: day(36), closed: true }),
      (error: { status?: number; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: connected, reason: interruptedReason, channel_outcome: 'unknown' })
        assert.deepEqual(error.data?.ranges, [{ from: day(35), to: day(36) }])
        assert.equal(Object.hasOwn(error.data ?? {}, 'channel_push'), false)
        return true
      })
    const interrupted = await readStayCalendar(db, manager, { productId: connected, from: day(35), to: day(36) })
    assert.deepEqual(interrupted.nights.map(night => [night.date, night.closed, night.available, night.channel]), [[day(35), true, false, { state: 'pending', detail: null }]])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])

    // A new base price on a connected home reaches every night ahead that has no price of its own.
    channex.answer['/restrictions'] = undefined
    channex.answer['/availability'] = undefined
    const repriced = await updateStayHome(env, db, manager, connected, { base_price_minor: 160_00 })
    assert.deepEqual([repriced.home.base_price_minor, repriced.channel_push], [160_00, { state: 'pushed', detail: null }])
    const ahead = channex.take()
    assert.deepEqual(ahead.map(request => [request.path, request.values.length]), [['/restrictions', 500], ['/availability', 500]])
    const rates = new Map(ahead[0]!.values.map(value => [value.date, value.rate]))
    assert.deepEqual([rates.get(day(0)), rates.get(day(10)), rates.get(day(499))], ['175.50', '160.00', '160.00'])
    // A rename changes nothing the channel is told.
    assert.equal((await updateStayHome(env, db, manager, connected, { name: 'Cabin by the cliff' })).channel_push, null)
    assert.deepEqual(channex.take(), [])

    // A connected home with no nightly price is held for review before anything is sent.
    channex.answer['/availability'] = undefined
    const noPriceOutcome = { state: 'needs_review', detail: `${day(5)} has no nightly price; Channex needs one for every night` }
    await assert.rejects(setStayNights(db, env, manager, { product_id: unpriced, from: day(5), to: day(6), closed: true }),
      (error: { status?: number; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: unpriced, reason: noPriceOutcome.detail, channel_push: noPriceOutcome })
        assert.deepEqual(error.data?.ranges, [{ from: day(5), to: day(6) }])
        return true
      })
    const noPrice = await readStayCalendar(db, manager, { productId: unpriced, from: day(5), to: day(6) })
    assert.deepEqual(noPrice.nights.map(night => [night.date, night.closed, night.price_minor, night.channel]), [[day(5), true, null, noPriceOutcome]])
    // Without the Channex configuration a connected home's nights are not changed at all.
    await assert.rejects(setStayNights(db, {}, manager, { product_id: connected, from: day(40), to: day(41), closed: true }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.match(error.message!, /CHANNEX_BASE_URL and CHANNEX_API_KEY are required/)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_CONFIGURATION_REQUIRED', field: 'CHANNEX_BASE_URL' })
        assert.equal(Object.hasOwn(error.data ?? {}, 'committed'), false)
        return true
      })
    assert.equal((await readStayCalendar(db, manager, { productId: connected, from: day(40), to: day(41) })).nights[0]!.closed, false)
    // A home whose channel is disconnected sends nothing, and says it is disconnected.
    assert.deepEqual(closed.home.channel, { provider: 'channex', status: 'connected' })
    const offline = await setStayNights(db, env, manager, { product_id: local, from: day(5), to: day(6), closed: true })
    assert.deepEqual(offline.home.channel, { provider: 'channex', status: 'disconnected' })
    assert.equal(offline.channel_push, null)
    assert.deepEqual(offline.nights.map(night => night.channel), [null])
    assert.deepEqual(channex.take(), [])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('Airbnb settings preflight the whole catalog and unchanged settings do not push while replays repair completion', async () => {
  const { runtime, db, env, connected, unpriced, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const before = await Promise.all([connected, unpriced, local].map(id => getProduct(db, ORG, id)))
    const activity = (await db.prepare('SELECT id FROM activity_entries ORDER BY id').all()).results
    const invalidations = (await db.prepare('SELECT id FROM public_resource_cache_invalidations ORDER BY id').all()).results
    const { photo_rooms: _photoRooms, accessibility: _accessibility, ...stay } = before[0]!.stay!
    for (const invalid of [
      { field: 'cancellation_policy', value: 'strict' },
      { field: 'check_in_time', value: '16:30' },
      { field: 'check_in_time', value: '03:00' },
      { field: 'check_in_end_time', value: '18:30' },
      { field: 'check_in_end_time', value: '04:00' },
      { field: 'check_out_time', value: '10:30' },
    ] as const) {
      await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { name: 'Must remain Cabin', stay: { [invalid.field]: invalid.value } } }),
        { status: 422, data: { code: 'AIRBNB_UNSUPPORTED_VALUE', field: invalid.field } })
      await assert.rejects(reconcileProducts(db, { env, organizationId: ORG, actor: { actorId: OWNER }, deactivateMissing: true, products: [
        { product_id: local, kind: 'stay', name: 'Must remain Barn' },
        { product_id: connected, kind: 'stay', name: 'Must remain Cabin', stay: { ...stay, [invalid.field]: invalid.value } },
      ] }), { status: 422, data: { code: 'AIRBNB_UNSUPPORTED_VALUE', field: invalid.field } })
      assert.deepEqual(await Promise.all([connected, unpriced, local].map(id => getProduct(db, ORG, id))), before)
      assert.deepEqual((await db.prepare('SELECT id FROM activity_entries ORDER BY id').all()).results, activity)
      assert.deepEqual((await db.prepare('SELECT id FROM public_resource_cache_invalidations ORDER BY id').all()).results, invalidations)
      assert.deepEqual(channex.take(), [])
      assert.deepEqual(channex.settings, [])
    }

    const unchanged = { check_in_time: '16:00', check_in_end_time: null, check_out_time: '10:00', cancellation_policy: null, long_term_cancellation_policy: null, min_nights: 2 } as const
    assert.equal((await updateProduct(db, { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { stay: unchanged } })).channel_push, null)
    assert.equal((await reconcileProducts(db, { env, organizationId: ORG, actor: { actorId: OWNER }, products: [{ product_id: connected, kind: 'stay', name: 'Cabin', stay: { ...stay, ...unchanged } }] }))[0]!.channel_push, null)
    assert.equal((await updateStayHome(env, db, manager, connected, unchanged)).channel_push, null)
    assert.deepEqual(channex.settings, [])
    assert.deepEqual(channex.take(), [])

    // Homes which are not syncing retain legitimate minute-valued times.
    await updateStayHome(env, db, manager, local, { check_in_time: '16:30', cancellation_policy: 'strict' })
    assert.equal((await getProduct(db, ORG, local)).stay!.check_in_time, '16:30')
    assert.equal((await getProduct(db, ORG, local)).stay!.cancellation_policy, 'strict')
    assert.deepEqual(channex.settings, [])

    channex.settingsAnswer = () => Response.json({ errors: { detail: 'Settings refused' } }, { status: 422 })
    const update = { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { stay: { check_in_time: '17:00' } }, idempotencyKey: 'booking-repair' }
    await assert.rejects(updateProduct(db, update), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
    const saved = await getProduct(db, ORG, connected)
    assert.equal(saved.stay!.check_in_time, '17:00')
    assert.equal(channex.settings.length, 1)
    channex.settingsAnswer = undefined
    const replay = await updateProduct(db, update)
    assert.equal(replay.updated_at, saved.updated_at)
    assert.deepEqual(replay.channel_push, { state: 'pushed', detail: null })
    assert.equal(channex.settings.length, 2)

    channex.settingsAnswer = () => Response.json({ errors: { detail: 'Settings refused' } }, { status: 422 })
    const reconcile = { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'catalog-booking-repair', products: [{ product_id: connected, kind: 'stay' as const, name: 'Cabin', stay: { ...stay, check_in_time: '18:00' } }] }
    await assert.rejects(reconcileProducts(db, reconcile), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
    const savedCatalog = await getProduct(db, ORG, connected)
    assert.equal(savedCatalog.stay!.check_in_time, '18:00')
    assert.equal(channex.settings.length, 3)
    channex.settingsAnswer = undefined
    const replayedCatalog = await reconcileProducts(db, reconcile)
    assert.equal(replayedCatalog[0]!.updated_at, savedCatalog.updated_at)
    assert.deepEqual(replayedCatalog[0]!.channel_push, { state: 'pushed', detail: null })
    assert.equal(channex.settings.length, 5, 'a replay completes both requested booking and minimum-stay sections')
    assert.deepEqual(channex.take().map(request => request.values.length), [500, 500])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('catalog price and minimum-stay writes use the same channel completion and preflight the whole batch', async () => {
  const { runtime, db, env, connected, unpriced, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
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
    assert.equal((await readStayCalendar(db, manager, { productId: unpriced, from: day(0), to: day(1) })).home.timezone, TZ)
    assert.deepEqual(channex.take(), [])

    const update = { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch, idempotencyKey: 'catalog-price' }
    const saved = await updateProduct(db, update)
    assert.deepEqual(saved.channel_push, { state: 'pushed', detail: null })
    const published = channex.take()
    assert.deepEqual(published.map(request => [request.path, request.values.length]), [['/restrictions', 500], ['/availability', 500]])
    assert.deepEqual([published[0]!.values[0]!.date, published[0]!.values[499]!.date], [day(0), day(499)])
    assert(published[0]!.values.every(value => value.rate === '170.00' && value.min_stay_arrival === 2))
    assert.equal(Object.hasOwn(await getProduct(db, ORG, connected), 'channel_push'), false, 'a completion receipt is not a stored Product field')

    // A recognized write replay repairs completion without editing the product again.
    const replay = await updateProduct(db, update)
    assert.equal(replay.updated_at, saved.updated_at)
    assert.equal(replay.variants[0]!.prices[0]!.id, price.id)
    assert.deepEqual(replay.channel_push, { state: 'pushed', detail: null })
    assert.deepEqual(channex.take().map(request => request.values.length), [500, 500])

    const { photo_rooms: _photoRooms, accessibility: _accessibility, ...stayInput } = saved.stay!
    const reconciled = await reconcileProducts(db, { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'catalog-minimum', products: [{
      product_id: connected, name: 'Cabin', kind: 'stay', stay: { ...stayInput, min_nights: 3 },
      variants: [{ id: variant.id, name: variant.name, prices: [{ id: price.id, unit_amount: 180_00, currency: 'USD' }] }],
    }] })
    assert.deepEqual(reconciled[0]!.channel_push, { state: 'pushed', detail: null })
    const minimum = channex.take()
    assert.equal(minimum[0]!.values.length, 500)
    assert(minimum[0]!.values.every(value => value.rate === '180.00' && value.min_stay_arrival === 3))
    const calendar = await readStayCalendar(db, manager, { productId: connected, from: day(0), to: day(1) })
    assert.deepEqual(calendar.nights[0]!.channel, { state: 'pushed', detail: null })

    // Every affected home is preflighted before any row in the atomic catalog changes.
    await assert.rejects(reconcileProducts(db, { env: unavailable, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'unavailable-batch', products: [
      { product_id: local, kind: 'stay', name: 'Must remain Barn' },
      { product_id: connected, kind: 'stay', name: 'Must remain Cabin', stay: { ...stayInput, min_nights: 4 } },
    ] }), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_CONFIGURATION_REQUIRED' && !Object.hasOwn(error.data, 'committed'))
    assert.equal((await getProduct(db, ORG, local)).name, 'Barn')
    assert.equal((await getProduct(db, ORG, connected)).stay!.min_nights, 3)
    assert.deepEqual(channex.take(), [])

    channex.answer['/restrictions'] = () => Response.json({ data: [], meta: { message: 'Success', warnings: [{ rate: ['refused'] }] } })
    let refused: Record<string, unknown> | undefined
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { stay: { min_nights: 4 } } }),
      (error: { status?: number; message?: string; data?: Record<string, unknown> }) => {
        assert.equal(error.status, 503)
        assert.partialDeepStrictEqual(error.data, { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: connected, channel_push: { state: 'needs_review' } })
        assert.equal(typeof error.data?.updated_at, 'string')
        assert.match(error.message!, /Channex rejected part of the update/)
        assert.match(String(error.data?.reason), /Channex rejected part of the update/)
        refused = error.data
        return true
      })
    const refusedProduct = await getProduct(db, ORG, connected)
    assert.equal(refusedProduct.stay!.min_nights, 4)
    assert.equal(refusedProduct.updated_at, refused!.updated_at)
    const refusedCalendar = await readStayCalendar(db, manager, { productId: connected, from: day(0), to: day(1) })
    assert.deepEqual(refusedCalendar.nights.map(night => night.channel), [refused!.channel_push])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])

    // The native home's combined timezone and base-price edit completes once, after the timezone lands.
    channex.answer['/restrictions'] = undefined
    const changed = await updateStayHome(env, db, manager, connected, { timezone: 'Pacific/Kiritimati', base_price_minor: 190_00 })
    assert.deepEqual(changed.channel_push, { state: 'pushed', detail: null })
    const once = channex.take()
    assert.deepEqual(once.map(request => [request.path, request.values.length]), [['/restrictions', 500], ['/availability', 500]])
    const newToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    assert.equal(once[0]!.values[0]!.date, newToday)
    assert(once[0]!.values.every(value => value.rate === '190.00'))

    const barn = await getProduct(db, ORG, local)
    const disconnected = await updateProduct(db, { env, organizationId: ORG, productId: local, actor: { actorId: OWNER }, patch: {
      variants: [{ id: barn.variants[0]!.id, prices: [{ id: barn.variants[0]!.prices[0]!.id, unit_amount: 95_00 }] }],
    } })
    assert.equal(disconnected.channel_push, null)
    assert.deepEqual(channex.take(), [])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
