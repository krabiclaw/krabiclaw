import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { cancelStay, createStay, readStayCalendar, setStayNights, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A connected home's night changes reach Channex: closed nights, prices and
// stay rules as restrictions, held nights as availability. What Channex took
// is recorded on each night; a partial rejection or an outcome it never
// confirmed reads needs_review with the reason. Past nights are not sent.

const ORG = 'org'
const OWNER = 'owner-user'
const TZ = 'America/Denver'
const env = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k' }
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }

function day(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

type Value = Record<string, unknown> & { date: string }

class FakeChannex {
  sent: Array<{ path: string; values: Value[] }> = []
  answer: Partial<Record<'/restrictions' | '/availability', () => Response>> = {}

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const path = url.pathname.replace('/api/v1', '') as '/restrictions' | '/availability'
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
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'o@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('site', ?, 'site', 'Site', 'active', ?, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG, TZ).run()
    const home = async (name: string, price: number | null) => (await createProduct(db, { organizationId: ORG, actor: { actorId: OWNER }, product: {
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
    return { runtime, db, connected, unpriced, local }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

test('night changes on a connected home reach Channex, and what it took is on each night', async () => {
  const { runtime, db, connected, unpriced, local } = await boot()
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

    // A partial rejection is not success: the nights read needs_review, and availability is not sent after it.
    const warnings = [{ date: day(20), warning: { rate: ['must be greater than 0'] } }]
    channex.answer['/restrictions'] = () => new Response(JSON.stringify({ data: [], meta: { message: 'Success', warnings } }), { status: 200 })
    const rejected = await setStayNights(db, env, manager, { product_id: connected, from: day(20), to: day(21), price_minor: 1 })
    assert.equal(rejected.channel_push?.state, 'needs_review')
    assert.match(rejected.channel_push!.detail!, /rejected part of the update/)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions'])
    assert.deepEqual(rejected.nights.map(night => night.channel), [rejected.channel_push])

    // A write Channex never confirmed is unknown, and says so.
    channex.answer['/restrictions'] = undefined
    channex.answer['/availability'] = () => new Response('upstream', { status: 503 })
    const unknown = await setStayNights(db, env, manager, { product_id: connected, from: day(30), to: day(31), closed: true })
    assert.equal(unknown.channel_push?.state, 'needs_review')
    assert.match(unknown.channel_push!.detail!, /did not confirm the availability update; its outcome is unknown/)
    assert.deepEqual((await states(connected, day(30), day(31)))[0], unknown.channel_push)
    assert.deepEqual(channex.take().map(request => request.path), ['/restrictions', '/availability'])
    assert.deepEqual((await log()).slice(-3).map(row => [(row as { kind: string }).kind, (row as { status: string }).status]), [['restrictions', 'needs_review'], ['restrictions', 'pushed'], ['availability', 'needs_review']])

    // A new base price on a connected home reaches every night ahead that has no price of its own.
    channex.answer['/availability'] = undefined
    const repriced = await updateStayHome(env as unknown as CloudflareEnv, db, manager, connected, { base_price_minor: 160_00 })
    assert.deepEqual([repriced.home.base_price_minor, repriced.channel_push], [160_00, { state: 'pushed', detail: null }])
    const ahead = channex.take()
    assert.deepEqual(ahead.map(request => [request.path, request.values.length]), [['/restrictions', 500], ['/availability', 500]])
    const rates = new Map(ahead[0]!.values.map(value => [value.date, value.rate]))
    assert.deepEqual([rates.get(day(0)), rates.get(day(10)), rates.get(day(499))], ['175.50', '160.00', '160.00'])
    // A rename changes nothing the channel is told.
    assert.equal((await updateStayHome(env as unknown as CloudflareEnv, db, manager, connected, { name: 'Cabin by the cliff' })).channel_push, null)
    assert.deepEqual(channex.take(), [])

    // A connected home with no nightly price is held for review before anything is sent.
    channex.answer['/availability'] = undefined
    const noPrice = await setStayNights(db, env, manager, { product_id: unpriced, from: day(5), to: day(6), closed: true })
    assert.deepEqual(noPrice.channel_push, { state: 'needs_review', detail: `${day(5)} has no nightly price; Channex needs one for every night` })
    // Without the Channex configuration a connected home's nights are not changed at all.
    await assert.rejects(setStayNights(db, {}, manager, { product_id: connected, from: day(40), to: day(41), closed: true }), /CHANNEX_BASE_URL and CHANNEX_API_KEY are required/)
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
