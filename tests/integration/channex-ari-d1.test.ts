import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct, createProductsBatch, getProduct, reconcileProducts, updateProduct } from '../../server/utils/product-management.ts'
import { cancelStay, createStay, deliverPendingChannelNights, readStayCalendar, releaseLapsedStayHolds, setStayNights, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A connected home's night changes reach Channex: closed nights, prices and
// stay rules as restrictions, held and booked nights as availability, each
// night carrying only what differs from what Channex last confirmed, and
// contiguous nights with the same change as one date range. What Channex took
// is recorded on each night; a partial rejection reads needs_review with the
// reason. A 429 or an outcome Channex never confirmed stays pending with its
// retry time, a minute doubling per attempt, and the delivery task sends it
// once due. Past nights are not sent.

const ORG = 'org'
const OWNER = 'owner-user'
const TZ = 'America/Denver'
const channexEnv = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' }
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }

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
  sent: Array<{ path: string; values: Value[] }> = []
  answer: Partial<Record<'/restrictions' | '/availability', () => Response>> = {}
  /** Runs while a call is in flight, before Channex answers it. */
  during?: () => Promise<unknown>

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
      if (!firstRestriction) return new Response(JSON.stringify({ data: [{ id: 'task-release', type: 'task' }], meta: { message: 'Success', warnings: [] } }), { status: 200 })
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
    // The refused restrictions do not hold back the released availability.
    assert.deepEqual(sent.map(request => [request.path, request.values.map(value => value.date_from)]), [
      ['/restrictions', [day(60)]], ['/availability', [day(60)]], ['/restrictions', [day(61)]], ['/availability', [day(61)]],
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
    const log = async () => (await db.prepare("SELECT kind, external_id, status, detail, task_id FROM channel_sync_log WHERE direction = 'outbound' ORDER BY created_at, rowid").all()).results

    // Yesterday through two days ahead: closed and priced; yesterday is not sent. Nights Channex never had go whole: a closed
    // night is stop sell on the rate plan with the unit still in inventory, and a night without its own minimum through
    // stay carries the home's minimum nights there.
    const closed = await setStayNights(db, env, manager, { product_id: connected, from: day(-1), to: day(3), closed: true, price_minor: 175_50, min_stay_arrival: 3 })
    assert.deepEqual(closed.channel_push, { state: 'pushed', detail: null })
    const restriction = { property_id: 'prop-1', rate_plan_id: 'rate-1', rate: '175.50', min_stay_arrival: 3, min_stay_through: 2, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: true }
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
    // The two minimum-stay fields go together: a change to one sends both.
    await setStayNights(db, env, manager, { product_id: connected, from: day(2), to: day(3), min_stay_through: 4 })
    assert.deepEqual(channex.take(), [{ path: '/restrictions', values: [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(2), date_to: day(2), min_stay_arrival: 3, min_stay_through: 4 }] }])
    // A minute has passed since those calls, as far as Channex's limit is concerned.
    await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()

    // A host stay holds its nights; cancelling it releases them. The home's own minimum applies where no night sets one.
    const stay = await createStay(db, env, manager, { product_id: connected, idempotency_key: 'k1', check_in_date: day(10), check_out_date: day(12), adults: 2, guest_name: 'Ana', total_minor: 300_00 })
    assert.deepEqual(stay.channel_push, { state: 'pushed', detail: null })
    // A booked night is unavailable, not stop-sold: stop sell is the host closing a night.
    const held = channex.take()
    assert.deepEqual(held[0]!.values.map(value => [value.date_from, value.date_to, value.rate, value.min_stay_arrival, value.stop_sell]), [[day(10), day(11), '150.00', 2, false]])
    assert.deepEqual(held[1]!.values, [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(10), date_to: day(11), availability: 0 }])
    const cancelled = await cancelStay(db, env, manager, stay.id, { expected_version: stay.version })
    assert.deepEqual(cancelled.channel_push, { state: 'pushed', detail: null })
    // Only what changed goes: releasing a booking changes availability alone, in one call.
    assert.deepEqual(channex.take(), [
      { path: '/availability', values: [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(10), date_to: day(11), availability: 1 }] },
    ])
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
    // A replay repairs completion; Channex already confirmed these nights, so nothing is sent again.
    const replayedCancellation = await cancelStay(db, env, manager, stay.id, { expected_version: cancelled.version })
    assert.deepEqual(replayedCancellation.channel_push, { state: 'pushed', detail: null })
    assert.deepEqual(channex.take(), [])
    assert.deepEqual(await db.prepare('SELECT * FROM stays WHERE id = ?').bind(stay.id).first(), cancelledRow)
    assert.deepEqual((await db.prepare("SELECT * FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.cancelled' AND json_extract(payload_json, '$.entityId') = ? ORDER BY id").bind(ORG, stay.id).all()).results, cancellationEvents.results)
    assert.deepEqual((await readStayCalendar(db, manager, { productId: connected, from: day(10), to: day(12) })).nights.map(night => [night.date, night.stay_id, night.available, night.channel]),
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
    const rejectedCalendar = await readStayCalendar(db, manager, { productId: connected, from: day(20), to: day(21) })
    assert.deepEqual(rejectedCalendar.nights.map(night => [night.date, night.price_minor, night.closed]), [[day(20), 1, false]])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual(rejectedCalendar.nights.map(night => night.channel), [rejected!.channel_push])

    // A write Channex never confirmed stays pending with its retry time; the
    // delivery task sends it once due, and only the part Channex has not confirmed.
    channex.answer['/restrictions'] = undefined
    channex.answer['/availability'] = () => new Response('upstream', { status: 503 })
    const unconfirmed = await setStayNights(db, env, manager, { product_id: connected, from: day(30), to: day(31), closed: true })
    assert.equal(unconfirmed.channel_push?.state, 'pending')
    assert.match(String(unconfirmed.channel_push?.detail), /did not confirm the availability update for .*Attempt 1; sending again at \d\d:\d\d UTC/)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual((await states(connected, day(30), day(31)))[0], unconfirmed.channel_push)
    // A rejection that created no task, and a call Channex never confirmed, keep none.
    assert.deepEqual((await log()).slice(-4).map(row => [(row as { kind: string }).kind, (row as { status: string }).status, (row as { task_id: string | null }).task_id !== null]),
      [['restrictions', 'needs_review', false], ['availability', 'pushed', true], ['restrictions', 'pushed', true], ['availability', 'failed', false]])
    // Not due yet: the task leaves it.
    channex.answer['/availability'] = undefined
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 0 })
    assert.deepEqual(channex.take(), [])
    await db.prepare("UPDATE channel_night_pushes SET retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ? AND date = ?").bind(connected, day(30)).run()
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    assert.deepEqual(channex.take(), [{ path: '/availability', values: [{ property_id: 'prop-1', room_type_id: 'room-1', date_from: day(30), date_to: day(30), availability: 1 }] }])
    assert.deepEqual((await states(connected, day(30), day(31)))[0], { state: 'pushed', detail: null })

    // A 429 pauses the property, availability included: a minute, then twice that for the next 429.
    channex.answer['/restrictions'] = () => Response.json({ errors: { code: 'http_too_many_requests', title: 'Too Many Requests' } }, { status: 429 })
    const limited = await setStayNights(db, env, manager, { product_id: connected, from: day(32), to: day(33), price_minor: 140_00 })
    assert.equal(limited.channel_push?.state, 'pending')
    assert.match(String(limited.channel_push?.detail), /slow down for this home .*Attempt 1; sending again at \d\d:\d\d UTC/)
    const retry = async () => await db.prepare('SELECT attempts, retry_at FROM channel_night_pushes WHERE product_id = ? AND date = ?').bind(connected, day(32)).first<{ attempts: number; retry_at: string }>()
    const first = await retry()
    assert.equal(first!.attempts, 1)
    assert(Date.parse(first!.retry_at) - Date.now() > 50_000 && Date.parse(first!.retry_at) - Date.now() <= 60_000)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])
    await db.prepare("UPDATE channel_night_pushes SET retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ? AND date = ?").bind(connected, day(32)).run()
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    const second = await retry()
    assert.equal(second!.attempts, 2)
    assert(Date.parse(second!.retry_at) - Date.now() > 110_000 && Date.parse(second!.retry_at) - Date.now() <= 120_000)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])
    channex.answer['/restrictions'] = undefined
    await db.prepare("UPDATE channel_night_pushes SET retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ? AND date = ?").bind(connected, day(32)).run()
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    assert.deepEqual(channex.take().map(request => [request.path, request.values.map(value => [value.date_from, value.rate])]), [
      ['/restrictions', [[day(32), '140.00']]], ['/availability', [[day(32), undefined]]],
    ])
    assert.deepEqual(await retry(), { attempts: 0, retry_at: null })

    // Ten calls of a kind in the last minute is Channex's limit for the property: the next change waits for the window.
    for (let call = 0; call < 10; call++) {
      await db.prepare("INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail) VALUES (?, ?, ?, 'channex', 'outbound', 'restrictions', 'prop-1', 'pushed', 'window')").bind(`window-${call}`, ORG, connected).run()
    }
    // Availability has its own ten, so the night's availability still goes.
    const windowed = await setStayNights(db, env, manager, { product_id: connected, from: day(34), to: day(35), price_minor: 141_00 })
    assert.equal(windowed.channel_push?.state, 'pending')
    assert.match(String(windowed.channel_push?.detail), /Channex takes 10 restrictions updates a minute for this home; this one goes at/)
    assert.deepEqual(channex.take().map(request => [request.path, request.values.map(value => value.date_from)]), [['/availability', [day(34)]]])
    await db.prepare("DELETE FROM channel_sync_log WHERE detail = 'window'").run()

    // A broken provider body is unconfirmed too: Channex may have applied the
    // POST before its body failed, so it is sent again rather than assumed.
    const interruptedReason = 'The Channex response body was interrupted.'
    channex.answer['/restrictions'] = () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(interruptedReason)) },
    }), { status: 200 })
    const interrupted = await setStayNights(db, env, manager, { product_id: connected, from: day(35), to: day(36), closed: true })
    assert.equal(interrupted.channel_push?.state, 'pending')
    assert.match(String(interrupted.channel_push?.detail), new RegExp(`did not confirm the restrictions update for ${day(35)}\\.\\.${day(35)}\\. Channex could not be reached for POST /restrictions: ${interruptedReason} Attempt 1`))
    assert.deepEqual(interrupted.nights.map(night => [night.date, night.closed, night.available]), [[day(35), true, false]])
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])
    // An unconfirmed night is never given up on: it stays pending, its wait doubling up to an hour.
    await db.prepare("UPDATE channel_night_pushes SET attempts = 4, retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ? AND date IN (?, ?)").bind(connected, day(34), day(35)).run()
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    const waiting = (await db.prepare('SELECT date, state, attempts, retry_at FROM channel_night_pushes WHERE product_id = ? AND date IN (?, ?) ORDER BY date').bind(connected, day(34), day(35)).all<{ date: string; state: string; attempts: number; retry_at: string }>()).results
    assert.deepEqual(waiting.map(row => [row.date, row.state, row.attempts]), [[day(34), 'pending', 5], [day(35), 'pending', 5]])
    assert(waiting.every(row => Date.parse(row.retry_at) - Date.now() > 15 * 60_000 && Date.parse(row.retry_at) - Date.now() <= 16 * 60_000))
    assert.match(String((await states(connected, day(35), day(36)))[0]?.detail), /Attempt 5; sending again at/)
    // Contiguous nights with different changes are separate ranges: one has a new price, the other is closed.
    assert.deepEqual(channex.take().map(request => request.values.map(value => [value.date_from, value.date_to])), [[[day(34), day(34)], [day(35), day(35)]]])
    await db.prepare("UPDATE channel_night_pushes SET attempts = 9, retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ? AND date = ?").bind(connected, day(35)).run()
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    const capped = await db.prepare('SELECT attempts, retry_at FROM channel_night_pushes WHERE product_id = ? AND date = ?').bind(connected, day(35)).first<{ attempts: number; retry_at: string }>()
    assert.equal(capped!.attempts, 10)
    assert(Date.parse(capped!.retry_at) - Date.now() <= 3_600_000 && Date.parse(capped!.retry_at) - Date.now() > 3_500_000)
    channex.take()

    // A new base price on a connected home reaches every night ahead that has no price of its own.
    // A minute has passed since the calls above, as far as Channex's limit is concerned.
    channex.answer['/restrictions'] = undefined
    channex.answer['/availability'] = undefined
    await db.prepare("UPDATE channel_sync_log SET created_at = '2000-01-01T00:00:00.000Z' WHERE direction = 'outbound'").run()
    const repriced = await updateStayHome(env, db, manager, connected, { base_price_minor: 160_00 })
    assert.deepEqual([repriced.home.base_price_minor, repriced.channel_push], [160_00, { state: 'pushed', detail: null }])
    const ahead = channex.take()
    assert.deepEqual(ahead.map(request => request.path), ['/restrictions', '/availability'])
    const sentByDate = byNight(ahead[0]!.values)
    // Nights with their own price that Channex already has are not sent; a night it has
    // other values for gets only its new rate; a night it never had gets everything.
    assert.equal(sentByDate.has(day(0)), false)
    assert.deepEqual(sentByDate.get(day(10)), { rate: '160.00' })
    assert.deepEqual(sentByDate.get(day(499)), { rate: '160.00', min_stay_arrival: 2, min_stay_through: 2, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: false })
    // The nights Channex never had go as one range, not one value per night.
    assert(ahead[0]!.values.some(value => value.date_from === day(36) && value.date_to === day(499)))
    const availableByDate = byNight(ahead[1]!.values)
    assert.equal(availableByDate.has(day(10)) || availableByDate.has(day(0)), false)
    assert.equal(ahead[1]!.values.at(-1)!.date_to, day(499))
    // A rename changes nothing the channel is told.
    assert.equal((await updateStayHome(env, db, manager, connected, { name: 'Cabin by the cliff' })).channel_push, null)
    assert.deepEqual(channex.take(), [])

    // One delivery per property at a time: while another holds the lease, a change waits for it.
    const lease = (until: string) => db.prepare("UPDATE product_channel_mappings SET delivery_lease = 'other-delivery', delivery_lease_until = ? WHERE product_id = ?").bind(until, connected).run()
    await lease(new Date(Date.now() + 60_000).toISOString())
    const queued = await setStayNights(db, env, manager, { product_id: connected, from: day(40), to: day(41), price_minor: 142_00 })
    assert.deepEqual(queued.channel_push, { state: 'pending', detail: 'Another delivery to Channex for this home is under way; this change goes with it or right after' })
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    assert.deepEqual(channex.take(), [])
    // A lease whose delivery died lapses, and the next delivery takes it.
    await lease('2000-01-01T00:00:00.000Z')
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    assert.deepEqual(channex.take().map(request => [request.path, request.values.map(value => [value.date_from, value.rate])]), [['/restrictions', [[day(40), '142.00']]]])
    assert.deepEqual(await db.prepare('SELECT delivery_lease, delivery_lease_until FROM product_channel_mappings WHERE product_id = ?').bind(connected).first(), { delivery_lease: null, delivery_lease_until: null })
    assert.deepEqual((await states(connected, day(40), day(41)))[0], { state: 'pushed', detail: null })
    // A delivery that outlives its lease records nothing: the delivery that took the property over owns the nights.
    const sentBefore = await db.prepare('SELECT sent_json FROM channel_night_pushes WHERE product_id = ? AND date = ?').bind(connected, day(41)).first('sent_json')
    channex.during = async () => { await lease(new Date(Date.now() + 60_000).toISOString()) }
    const outlived = await setStayNights(db, env, manager, { product_id: connected, from: day(41), to: day(42), price_minor: 143_00 })
    channex.during = undefined
    assert.equal(outlived.channel_push?.state, 'pending')
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])
    assert.deepEqual(await db.prepare('SELECT state, sent_json FROM channel_night_pushes WHERE product_id = ? AND date = ?').bind(connected, day(41)).first(), { state: 'pending', sent_json: sentBefore })
    assert.equal(await db.prepare('SELECT delivery_lease FROM product_channel_mappings WHERE product_id = ?').bind(connected).first('delivery_lease'), 'other-delivery')
    await lease('2000-01-01T00:00:00.000Z')
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    assert.deepEqual(channex.take().map(request => [request.path, request.values.map(value => [value.date_from, value.rate])]), [['/restrictions', [[day(41), '143.00']]]])
    assert.deepEqual((await states(connected, day(41), day(42)))[0], { state: 'pushed', detail: null })

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
    const noPrice = await readStayCalendar(db, manager, { productId: unpriced, from: day(5), to: day(6) })
    assert.deepEqual(noPrice.nights.map(night => [night.date, night.closed, night.price_minor, night.channel]), [[day(5), true, null, noPriceOutcome]])
    assert.deepEqual(channex.take(), [
      { path: '/restrictions', values: [{ property_id: 'prop-2', rate_plan_id: 'rate-2', date_from: day(5), date_to: day(5), min_stay_arrival: 2, min_stay_through: 2, max_stay: 0, closed_to_arrival: false, closed_to_departure: false, stop_sell: true }] },
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
    assert.equal(channex.settings.length, 4, 'a replay completes only the booking section the committed plan changed')
    assert.deepEqual(channex.take(), [])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('removed guest controls retain the committed channel completion intent for single and catalog retries', async () => {
  const { runtime, db, env, connected, local } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    await updateProduct(db, { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { details: { pets_allowed: true, smoking_allowed: false } } })
    assert.deepEqual((await getProduct(db, ORG, connected)).details, { featured: false, pets_allowed: true, smoking_allowed: false })
    channex.settings = []
    channex.settingsAnswer = () => Response.json({ errors: { detail: 'Settings refused' } }, { status: 422 })
    const update = { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { details: { house_rules: 'Shoes off' } }, idempotencyKey: 'removed-controls-repair' }
    await assert.rejects(updateProduct(db, update), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
    const saved = await getProduct(db, ORG, connected)
    assert.deepEqual(saved.details, { featured: false, house_rules: 'Shoes off' })
    const updateReceipt = `product-update:${ORG}:${connected}:removed-controls-repair`
    const updateIntent = await db.prepare("SELECT json_extract(payload_json, '$.metadata.channel_completion') AS intent FROM activity_entries WHERE dedupe_key=?").bind(updateReceipt).first<string>('intent')
    assert.deepEqual(JSON.parse(updateIntent!), { nights: false, settings: { booking: true, availability: false } })
    assert.deepEqual(channex.settings, [{ path: '/channels/chan-1/execute/update_booking_setting', body: {
      channel_rate_plan_id: 'map-1', data: { check_in_time_start: '16', check_in_time_end: 'FLEXIBLE', check_out_time: 10 },
    } }], 'unknown guest controls stay omitted from the canonical provider payload')
    const attemptedUpdate = channex.settings[0]
    channex.settingsAnswer = undefined
    const replay = await updateProduct(db, update)
    assert.deepEqual(replay.channel_push, { state: 'pushed', detail: null })
    assert.deepEqual(await getProduct(db, ORG, connected), saved)
    assert.equal(channex.settings.length, 2)
    assert.deepEqual(channex.settings[1], attemptedUpdate, 'same-key repair retries the booking work planned before the controls were removed')
    assert.deepEqual(channex.take(), [])

    await db.prepare("UPDATE activity_entries SET payload_json=json_remove(payload_json, '$.metadata.channel_completion') WHERE dedupe_key=?").bind(updateReceipt).run()
    await assert.rejects(updateProduct(db, update), { status: 503, data: {
      code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true,
      reason: 'Product audit record has a missing or invalid channel completion plan', channel_outcome: 'unknown', product_id: connected, updated_at: saved.updated_at,
    } })
    assert.equal(channex.settings.length, 2, 'missing intent fails before provider work')
    assert.deepEqual(await getProduct(db, ORG, connected), saved)

    await updateProduct(db, { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { details: { pets_allowed: true, smoking_allowed: false } } })
    channex.settings = []
    channex.settingsAnswer = () => Response.json({ errors: { detail: 'Settings refused' } }, { status: 422 })
    const reconcile = { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'catalog-removed-controls-repair', products: [
      { product_id: connected, kind: 'stay' as const, name: 'Cabin', details: { house_rules: 'Quiet after ten' } },
      { product_id: local, kind: 'stay' as const, name: 'Updated Barn' },
    ] }
    await assert.rejects(reconcileProducts(db, reconcile), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
    const savedCatalog = await Promise.all([connected, local].map(id => getProduct(db, ORG, id)))
    assert.deepEqual(savedCatalog[0]!.details, { featured: false, house_rules: 'Quiet after ten' })
    assert.equal(savedCatalog[1]!.name, 'Updated Barn')
    const catalogReceipt = `catalog-reconcile:${ORG}:catalog-removed-controls-repair`
    const catalogIntent = await db.prepare("SELECT json_extract(payload_json, '$.metadata.channel_completion') AS intent FROM activity_entries WHERE dedupe_key=?").bind(catalogReceipt).first<string>('intent')
    assert.deepEqual(JSON.parse(catalogIntent!), {
      [connected]: { nights: false, settings: { booking: true, availability: false } },
      [local]: { nights: false, settings: null },
    })
    assert.equal(channex.settings.length, 1)
    const attemptedCatalog = channex.settings[0]
    assert.deepEqual(attemptedCatalog, attemptedUpdate)
    channex.settingsAnswer = undefined
    const replayedCatalog = await reconcileProducts(db, reconcile)
    assert.deepEqual(replayedCatalog.map(product => product.channel_push), [{ state: 'pushed', detail: null }, null])
    assert.deepEqual(await Promise.all([connected, local].map(id => getProduct(db, ORG, id))), savedCatalog)
    assert.equal(channex.settings.length, 2)
    assert.deepEqual(channex.settings[1], attemptedCatalog)
    assert.deepEqual(channex.take(), [])

    // A missing later entry must fail before the first home's otherwise valid push.
    await db.prepare("UPDATE activity_entries SET payload_json=json_set(payload_json, '$.metadata.channel_completion', json(?)) WHERE dedupe_key=?").bind(JSON.stringify({ [connected]: JSON.parse(catalogIntent!)[connected] }), catalogReceipt).run()
    await assert.rejects(reconcileProducts(db, reconcile), { status: 503, data: {
      code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true,
      reason: 'Product audit record has a missing or invalid channel completion plan', channel_outcome: 'unknown', product_id: local, updated_at: savedCatalog[1]!.updated_at,
    } })
    assert.equal(channex.settings.length, 2)
    assert.deepEqual(await Promise.all([connected, local].map(id => getProduct(db, ORG, id))), savedCatalog)

    // Canonical non-stay kinds have no Airbnb work, including older receipts.
    const dish = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'dish', name: 'Breakfast' } })
    const dishUpdate = { env, organizationId: ORG, productId: dish.id, actor: { actorId: OWNER }, patch: { name: 'Breakfast menu' }, idempotencyKey: 'dish-update' }
    await updateProduct(db, dishUpdate)
    const savedDish = await getProduct(db, ORG, dish.id)
    await db.prepare("UPDATE activity_entries SET payload_json=json_remove(payload_json, '$.metadata.channel_completion') WHERE dedupe_key=?").bind(`product-update:${ORG}:${dish.id}:dish-update`).run()
    assert.equal((await updateProduct(db, dishUpdate)).channel_push, null)
    assert.deepEqual(await getProduct(db, ORG, dish.id), savedDish)
    const dishReconcile = { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'dish-reconcile', products: [{ product_id: dish.id, kind: 'dish' as const, name: 'Breakfast specials' }] }
    await reconcileProducts(db, dishReconcile)
    const savedDishCatalog = await getProduct(db, ORG, dish.id)
    await db.prepare("UPDATE activity_entries SET payload_json=json_remove(payload_json, '$.metadata.channel_completion') WHERE dedupe_key=?").bind(`catalog-reconcile:${ORG}:dish-reconcile`).run()
    assert.equal((await reconcileProducts(db, dishReconcile))[0]!.channel_push, null)
    assert.deepEqual(await getProduct(db, ORG, dish.id), savedDishCatalog)
    assert.equal(channex.settings.length, 2)
    assert.deepEqual(channex.take(), [])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('paid home product receipts repair failed billing reports before channel work without repeating writes', async () => {
  const { runtime, db, env, connected } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  let refused = true
  const meters: string[] = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (url.origin !== 'https://api.stripe.com') return channex.fetch(input, init)
    assert.equal(url.pathname, '/v1/billing/meter_events')
    const data = new URLSearchParams(String(init.body))
    assert.equal(data.get('payload[stripe_customer_id]'), 'cus_paid_host')
    meters.push(`${data.get('event_name')}=${data.get('payload[value]')}`)
    if (refused) return Response.json({ error: { type: 'invalid_request_error', message: 'Meter refused' } }, { status: 400 })
    return Response.json({ object: 'billing.meter_event', identifier: `meter-${meters.length}`, event_name: data.get('event_name'), created: Math.floor(Date.now() / 1000), livemode: false })
  }
  try {
    await db.prepare('UPDATE organization SET stripeCustomerId=? WHERE id=?').bind('cus_paid_host', ORG).run()
    await db.prepare("UPDATE subscription SET stripeCustomerId='cus_paid_host', stripeSubscriptionId='sub-paid' WHERE referenceId=?").bind(ORG).run()
    const billingFailure = { status: 503, data: { code: 'POST_WRITE_COMPLETION_FAILED', field: 'billing_usage', committed: true, organization_id: ORG, reason: 'Meter refused' } }
    const update = { env, organizationId: ORG, productId: connected, actor: { actorId: OWNER }, patch: { active: false, stay: { check_in_time: '17:00' } }, idempotencyKey: 'billing-update' }
    await assert.rejects(updateProduct(db, update), billingFailure)
    const saved = await getProduct(db, ORG, connected)
    assert.equal(saved.active, false)
    assert.equal(saved.stay!.check_in_time, '17:00')
    assert.equal(await db.prepare('SELECT count(*) AS n FROM activity_entries WHERE dedupe_key=?').bind(`product-update:${ORG}:${connected}:billing-update`).first('n'), 1)
    assert.deepEqual(channex.settings, [])
    // A still-failing replay must retain committed state and make no channel write.
    await assert.rejects(updateProduct(db, update), billingFailure)
    assert.deepEqual(await getProduct(db, ORG, connected), saved)
    assert.deepEqual(channex.settings, [])
    refused = false
    assert.deepEqual((await updateProduct(db, update)).channel_push, { state: 'pushed', detail: null })
    assert.deepEqual(await getProduct(db, ORG, connected), saved)
    assert.deepEqual(meters.splice(0), ['krabiclaw_locations=0', 'krabiclaw_locations=0', 'krabiclaw_locations=0', 'krabiclaw_homes=1'])
    assert.equal(channex.settings.length, 1)

    refused = true
    const { photo_rooms: _rooms, accessibility: _accessibility, ...stay } = saved.stay!
    const reconcile = { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'billing-reconcile', products: [{ product_id: connected, kind: 'stay' as const, name: 'Cabin', active: true, stay: { ...stay, check_in_time: '18:00' } }] }
    await assert.rejects(reconcileProducts(db, reconcile), billingFailure)
    const savedCatalog = await getProduct(db, ORG, connected)
    assert.equal(savedCatalog.active, true)
    assert.equal(savedCatalog.stay!.check_in_time, '18:00')
    assert.equal(await db.prepare('SELECT count(*) AS n FROM activity_entries WHERE dedupe_key=?').bind(`catalog-reconcile:${ORG}:billing-reconcile`).first('n'), 1)
    assert.equal(channex.settings.length, 1)
    refused = false
    assert.deepEqual((await reconcileProducts(db, reconcile))[0]!.channel_push, { state: 'pushed', detail: null })
    assert.deepEqual(await getProduct(db, ORG, connected), savedCatalog)
    assert.deepEqual(meters.splice(0), ['krabiclaw_locations=0', 'krabiclaw_locations=0', 'krabiclaw_homes=2'])
    assert.equal(channex.settings.length, 2)

    const home = { kind: 'stay' as const, stay, variants: [{ name: 'Night', prices: [{ unit_amount: 150_00, currency: 'USD' }] }] }
    refused = true
    const create = { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'billing-create', publication: { published: true }, product: { ...home, name: 'Creek Cabin' } }
    await assert.rejects(createProduct(db, create), billingFailure)
    assert.deepEqual(meters, ['krabiclaw_locations=0'], 'a failed completion is reported once; only the caller retries its committed receipt')
    const createdId = await db.prepare("SELECT json_extract(payload_json, '$.entityId') AS id FROM activity_entries WHERE dedupe_key=?").bind(`create:product:${ORG}:billing-create`).first<string>('id')
    const created = await getProduct(db, ORG, createdId!)
    assert.equal(created.name, 'Creek Cabin')
    assert.equal(created.publications[0]!.published, true)
    assert.equal(await db.prepare('SELECT count(*) AS n FROM products').first('n'), 4)
    refused = false
    assert.equal((await createProduct(db, create)).id, createdId)
    assert.deepEqual(await getProduct(db, ORG, createdId!), created)
    assert.equal(await db.prepare('SELECT count(*) AS n FROM products').first('n'), 4)
    assert.deepEqual(meters.splice(0), ['krabiclaw_locations=0', 'krabiclaw_locations=0', 'krabiclaw_homes=3'])

    refused = true
    const createBatch = { env, organizationId: ORG, actor: { actorId: OWNER }, idempotencyKey: 'billing-create-batch', publication: { published: true }, products: [{ ...home, name: 'Forest Cabin' }, { ...home, name: 'River Cabin' }] }
    await assert.rejects(createProductsBatch(db, createBatch), billingFailure)
    const ids = await db.prepare("SELECT json_extract(payload_json, '$.metadata.product_ids') AS ids FROM activity_entries WHERE dedupe_key=?").bind(`catalog-create:${ORG}:billing-create-batch`).first<string>('ids')
    const createdIds = JSON.parse(ids!) as string[]
    const createdCatalog = await Promise.all(createdIds.map(id => getProduct(db, ORG, id)))
    assert.deepEqual(createdCatalog.map(product => [product.name, product.publications[0]!.published]), [['Forest Cabin', true], ['River Cabin', true]])
    assert.equal(await db.prepare('SELECT count(*) AS n FROM products').first('n'), 6)
    refused = false
    assert.deepEqual((await createProductsBatch(db, createBatch)).map(product => product.id), createdIds)
    assert.deepEqual(await Promise.all(createdIds.map(id => getProduct(db, ORG, id))), createdCatalog)
    assert.equal(await db.prepare('SELECT count(*) AS n FROM products').first('n'), 6)
    assert.deepEqual(meters.splice(0), ['krabiclaw_locations=0', 'krabiclaw_locations=0', 'krabiclaw_homes=5'])
    assert.equal(channex.settings.length, 2)
    assert.deepEqual(channex.take(), [])
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
    // The home's minimum nights is both minimum-stay fields of a night without its own.
    assert.deepEqual(minimum[0]!.values, [{ property_id: 'prop-1', rate_plan_id: 'rate-1', date_from: day(0), date_to: day(499), rate: '180.00', min_stay_arrival: 3, min_stay_through: 3 }])

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
    const refusedCalendar = await readStayCalendar(db, manager, { productId: connected, from: day(0), to: day(1) })
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
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
