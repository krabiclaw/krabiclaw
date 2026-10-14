import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct, deleteProduct, getProduct, removeProductLocation, setProductLocation, setProductPublication, updateProduct } from '../../server/utils/product-management.ts'
import { cancelStay, createStay, deleteStayPayment, getStay, listStays, readStayCalendar, recordStayPayment, setStayNights, updateStay, type StayAccess } from '../../server/domain/stays.ts'

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
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
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
    return { runtime, db }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

async function home(db: D1Database, input: { name: string; location: string; team?: string }) {
  return createProduct(db, { organizationId: ORG, actor: { actorId: OWNER }, product: {
    kind: 'stay', name: input.name,
    variants: [{ name: input.name, prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
    stay: { location_id: input.location, check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: null, assigned_team_id: input.team ?? null },
  } })
}

function code(expected: string) {
  return (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected
}

const guest = { adults: 2, guest_name: 'Ana', total_minor: 45_000 }

test('a place to stay is a Product at exactly one location, priced per night', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'stay', name: 'No rules' } }), /needs its location/)
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'dish', name: 'Soup', stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 2, min_nights: 1, assigned_member_id: null, assigned_team_id: null } } }), /Only a place to stay/)
    const cabin = await home(db, { name: 'Cabin', location: 'cabin-site', team: 'cleaning' })
    assert.equal(cabin.kind, 'stay')
    assert.equal(cabin.unit_label, 'night')
    assert.deepEqual(cabin.stay, { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: null, assigned_team_id: 'cleaning' })
    // Its one location shows it; the product's publication decides whether anyone does.
    assert.deepEqual(cabin.locations, [{ location_id: 'cabin-site', active: true, published: true }])
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { location_id: 'lake-site', max_guests: 2 } as never } }), /keeps its location/)
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).locations.map(location => location.location_id), ['cabin-site'])
    await assert.rejects(setProductLocation(db, { organizationId: ORG, productId: cabin.id, locationId: 'lake-site', actor: { actorId: OWNER } }), /exactly one location/)
    await assert.rejects(removeProductLocation(db, { organizationId: ORG, productId: cabin.id, locationId: 'cabin-site' }), /cannot leave the location/)
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { kind: 'experience' } }), /keeps its kind/)
    // Guests book through an external link until direct stays exist.
    await assert.rejects(setProductPublication(db, { organizationId: ORG, productId: cabin.id, published: true, actor: { actorId: OWNER } }), /link where guests book/)
    const edited = await updateProduct(db, { organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { max_guests: 6 } } })
    // A save that does not name stay settings leaves them as stored, even if they changed meanwhile.
    await db.prepare('UPDATE product_stay_configs SET min_nights = 5 WHERE product_id = ?').bind(cabin.id).run()
    await updateProduct(db, { organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { name: 'Cliff Cabin' } })
    assert.equal((await getProduct(db, ORG, cabin.id)).stay?.min_nights, 5)
    assert.equal(edited.stay?.max_guests, 6)
    assert.equal(edited.stay?.location_id, 'cabin-site')
  } finally {
    await runtime.dispose()
  }
})

test('a stay holds its nights, and a held night refuses another stay even when two arrive at once', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const cabin = await home(db, { name: 'Cabin', location: 'cabin-site' })
    const first = await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })
    assert.equal(first.status, 'confirmed')
    assert.equal(first.owner, 'app')
    assert.equal(first.currency, 'USD')
    assert.equal(first.payment_status, 'unpaid')
    // The same key replays the same stay; a different stay under it is refused.
    assert.equal((await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })).id, first.id)
    await assert.rejects(createStay(db, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-02', check_out_date: '2026-11-04', ...guest }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(createStay(db, manager, { product_id: cabin.id, idempotency_key: 'k2', check_in_date: '2026-11-03', check_out_date: '2026-11-06', ...guest }), code('STAY_OVERLAP'))
    // Checkout morning is the next guest's check-in.
    const next = await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'k3', check_in_date: '2026-11-04', check_out_date: '2026-11-06', ...guest })
    assert.equal(next.check_in_date, '2026-11-04')
    await assert.rejects(createStay(db, manager, { product_id: cabin.id, idempotency_key: 'k4', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest, adults: 5 }), code('INVALID_STAY_FIELD'))

    const racers = await Promise.allSettled(['r1', 'r2', 'r3'].map(key => createStay(db, manager, { product_id: cabin.id, idempotency_key: key, check_in_date: '2026-12-01', check_out_date: '2026-12-05', ...guest })))
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of racers.filter(result => result.status === 'rejected')) assert(code('STAY_OVERLAP')((result as PromiseRejectedResult).reason))
    const claims = await db.prepare("SELECT count(*) AS n FROM stay_nights WHERE product_id = ? AND date >= '2026-12-01' AND date < '2026-12-05'").bind(cabin.id).first<{ n: number }>()
    assert.equal(claims?.n, 4)
  } finally {
    await runtime.dispose()
  }
})

test('editing and cancelling a stay move and free exactly its nights, under its version', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const cabin = await home(db, { name: 'Cabin', location: 'cabin-site' })
    const stay = await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'a', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'b', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest })
    await assert.rejects(updateStay(db, manager, stay.id, { expected_version: 99, check_out_date: '2026-11-04' }), code('STAY_VERSION_CONFLICT'))
    await assert.rejects(updateStay(db, manager, stay.id, { expected_version: 1, check_in_date: '2026-11-09', check_out_date: '2026-11-11' }), code('STAY_OVERLAP'))
    // A refused move leaves the stay and its nights where they were.
    assert.deepEqual((await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-03' })).nights.map(night => night.stay_id), [stay.id, stay.id])
    const moved = await updateStay(db, manager, stay.id, { expected_version: 1, check_in_date: '2026-11-05', check_out_date: '2026-11-08', guest_phone: '+15551234567' })
    assert.equal(moved.version, 2)
    assert.equal(moved.guest_phone, '+15551234567')
    const calendar = await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-09' })
    assert.deepEqual(calendar.nights.map(night => night.available), [true, true, true, true, false, false, false, true])
    assert.equal(calendar.nights[0]!.price_minor, 15_000)
    // Two edits from the same version race; whichever wins, the nights held are the winner's.
    const racers = await Promise.allSettled([
      updateStay(db, manager, stay.id, { expected_version: 2, check_in_date: '2026-11-20', check_out_date: '2026-11-22' }),
      updateStay(db, manager, stay.id, { expected_version: 2, check_in_date: '2026-11-25', check_out_date: '2026-11-28' }),
    ])
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1)
    const winner = await getStay(db, manager, stay.id)
    const held = await db.prepare('SELECT date FROM stay_nights WHERE stay_id = ? ORDER BY date').bind(stay.id).all<{ date: string }>()
    const expected: string[] = []
    for (let day = Date.parse(`${winner.check_in_date}T00:00:00Z`); day < Date.parse(`${winner.check_out_date}T00:00:00Z`); day += 86_400_000) expected.push(new Date(day).toISOString().slice(0, 10))
    assert.deepEqual(held.results.map(row => row.date), expected)
    const cancelled = await cancelStay(db, manager, stay.id, { expected_version: 3, reason: 'Guest changed plans' })
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(cancelled.cancelled_at)
    assert(((await readStayCalendar(db, manager, { productId: cabin.id, from: '2026-11-05', to: '2026-11-30' })).nights).every(night => night.stay_id !== stay.id))
    await assert.rejects(updateStay(db, manager, stay.id, { expected_version: 4, adults: 1 }), code('STAY_NOT_EDITABLE'))
    assert.deepEqual((await listStays(db, manager, { from: '2026-11-01', to: '2026-12-01' })).map(row => row.id).includes(stay.id), false)
    assert.equal((await listStays(db, manager, { from: '2026-11-01', to: '2026-12-01', includeCancelled: true })).some(row => row.id === stay.id), true)
    const audit = await db.prepare("SELECT event_name FROM activity_entries WHERE organization_id = ? AND event_name LIKE 'stay.%' ORDER BY occurred_at, event_name").bind(ORG).all<{ event_name: string }>()
    assert.deepEqual(audit.results.map(row => row.event_name).sort(), ['stay.cancelled', 'stay.created', 'stay.created', 'stay.updated', 'stay.updated'])
  } finally {
    await runtime.dispose()
  }
})

test('a channel stay is read-only here and is paid through its channel; an app stay records offline payments', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const cabin = await home(db, { name: 'Cabin', location: 'cabin-site' })
    await db.prepare(`INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, adults, guest_name, total_minor, currency, provider, external_booking_id, created_at, updated_at)
      VALUES ('airbnb-1', ?, ?, 'airbnb', 'channel', 'confirmed', '2026-11-20', '2026-11-22', 2, 'Bo', 30000, 'USD', 'channex', 'chx-1', ?, ?)`).bind(ORG, cabin.id, NOW, NOW).run()
    await assert.rejects(updateStay(db, manager, 'airbnb-1', { expected_version: 1, adults: 1 }), code('STAY_NOT_EDITABLE'))
    await assert.rejects(cancelStay(db, manager, 'airbnb-1', { expected_version: 1 }), code('STAY_NOT_EDITABLE'))
    await assert.rejects(recordStayPayment(db, manager, 'airbnb-1', { amount_minor: 100, method: 'cash', paid_on: '2026-11-20', idempotency_key: 'pay-1' }), code('STAY_NOT_EDITABLE'))
    assert.equal((await getStay(db, manager, 'airbnb-1')).payment_status, null)

    const stay = await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'p', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })
    await assert.rejects(recordStayPayment(db, manager, stay.id, { amount_minor: 0, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'pay-2' }), code('INVALID_AMOUNT'))
    await assert.rejects(recordStayPayment(db, manager, stay.id, { amount_minor: 100, method: 'crypto', paid_on: '2026-11-01', idempotency_key: 'pay-3' }), code('INVALID_STAY_FIELD'))
    const partial = await recordStayPayment(db, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4' })
    assert.deepEqual([partial.paid_minor, partial.payment_status, partial.payments.length], [20_000, 'partial', 1])
    // A retried record is the same payment; the same key for another payment is refused.
    const retried = await recordStayPayment(db, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4' })
    assert.equal(retried.payments.length, 1)
    await assert.rejects(recordStayPayment(db, manager, stay.id, { amount_minor: 1, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'pay-4' }), code('IDEMPOTENCY_CONFLICT'))
    const paid = await recordStayPayment(db, manager, stay.id, { amount_minor: 25_000, method: 'bank_transfer', paid_on: '2026-11-02', idempotency_key: 'pay-5' })
    assert.deepEqual([paid.paid_minor, paid.payment_status], [45_000, 'paid'])
    const refunded = await recordStayPayment(db, manager, stay.id, { amount_minor: -5_000, method: 'cash', paid_on: '2026-11-03', note: 'Early checkout', idempotency_key: 'pay-6' })
    assert.equal(refunded.payment_status, 'partial')
    const removed = await deleteStayPayment(db, manager, stay.id, refunded.payments.find(payment => payment.amount_minor === -5_000)!.id)
    assert.deepEqual([removed.paid_minor, removed.payment_status], [45_000, 'paid'])
    await assert.rejects(deleteStayPayment(db, manager, stay.id, 'missing'), code('PAYMENT_NOT_FOUND'))
  } finally {
    await runtime.dispose()
  }
})

test('the host sets nights apart from the defaults and resets them', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const cabin = await home(db, { name: 'Cabin', location: 'cabin-site' })
    await assert.rejects(setStayNights(db, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-04' }), /at least one night setting/)
    const closed = await setStayNights(db, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-03', closed: true })
    assert.deepEqual(closed.nights.map(night => [night.available, night.source]), [[false, 'host'], [false, 'host']])
    const priced = await setStayNights(db, manager, { product_id: cabin.id, from: '2026-11-02', to: '2026-11-04', price_minor: 20_000, min_stay_arrival: 3 })
    assert.deepEqual(priced.nights.map(night => [night.date, night.closed, night.price_minor, night.min_stay_arrival]), [['2026-11-02', true, 20_000, 3], ['2026-11-03', false, 20_000, 3]])
    const based = await setStayNights(db, manager, { product_id: cabin.id, from: '2026-11-03', to: '2026-11-04', price_minor: null })
    assert.equal(based.nights[0]!.price_minor, 15_000)
    const reset = await setStayNights(db, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-04', reset: true })
    assert(reset.nights.every(night => night.available && night.source === null && night.price_minor === 15_000))
    // A closed night is the host's choice for guests; it does not hold a stay the host takes themselves.
    await setStayNights(db, manager, { product_id: cabin.id, from: '2026-11-10', to: '2026-11-11', closed: true })
    await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'closed', check_in_date: '2026-11-10', check_out_date: '2026-11-11', ...guest })
  } finally {
    await runtime.dispose()
  }
})

test('members see only the homes they look after and change nothing; a home with stays is not deleted', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const cabin = await home(db, { name: 'Cabin', location: 'cabin-site', team: 'cleaning' })
    const lake = await home(db, { name: 'Lake house', location: 'lake-site' })
    const cabinStay = await createStay(db, manager, { product_id: cabin.id, idempotency_key: 'c', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    const lakeStay = await createStay(db, manager, { product_id: lake.id, idempotency_key: 'l', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    assert.deepEqual((await listStays(db, cleaner, { from: '2026-11-01', to: '2026-11-30' })).map(stay => stay.id), [cabinStay.id])
    assert.deepEqual(await listStays(db, outsider, { from: '2026-11-01', to: '2026-11-30' }), [])
    assert.equal((await getStay(db, cleaner, cabinStay.id)).id, cabinStay.id)
    await assert.rejects(getStay(db, cleaner, lakeStay.id), code('STAY_NOT_FOUND'))
    await assert.rejects(readStayCalendar(db, cleaner, { productId: lake.id, from: '2026-11-01', to: '2026-11-03' }), code('HOME_NOT_FOUND'))
    await assert.rejects(createStay(db, cleaner, { product_id: cabin.id, idempotency_key: 'x', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest }), code('STAY_ROLE_REQUIRED'))
    await assert.rejects(cancelStay(db, cleaner, cabinStay.id, { expected_version: 1 }), code('STAY_ROLE_REQUIRED'))
    await assert.rejects(deleteProduct(db, { organizationId: ORG, productId: cabin.id }), /has bookings or stays/)
    assert.equal((await getProduct(db, ORG, cabin.id)).id, cabin.id)
  } finally {
    await runtime.dispose()
  }
})
