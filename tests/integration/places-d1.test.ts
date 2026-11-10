import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { readPlacesCalendar, setPlaceDates, type PlaceDay } from '../../server/domain/places.ts'
import { parseSpecialHours } from '../../shared/reservation-hours.ts'

// The places calendar: restaurant locations, experiences and consultations as
// rows, days as columns, and the one write that opens or blocks their days.
const ORG = 'org-places'
const OWNER = 'places-owner'
const STAFF = 'places-staff'
const NOW = '2026-11-02T12:00:00.000Z'
// 2026-11-09 is a Monday; the window runs Monday to the following Sunday.
const FROM = '2026-11-09'
const TO = '2026-11-16'
const ZONE = 'America/New_York'

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'places-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'places-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'places-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example' } as CloudflareEnv
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Ember & Slice', 'ember', 'ember', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'restaurant', ?, ?)`).bind(ORG, NOW, ZONE).run()
    for (const [id, role] of [[OWNER, 'owner'], [STAFF, 'member']] as const) {
      await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)").bind(id, id === OWNER ? 'Dana Brooks, Esq.' : 'Sam Staff', `${id}@example.test`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
    }
    // Brooklyn opens Tuesday to Sunday; Williamsburg every day, with the Thursday closed by its host. The studio has no tables and is no row.
    const hours = (days: number[]) => JSON.stringify({ periods: days.map(day => ({ open: { day, hour: 17, minute: 0 }, close: { day, hour: 22, minute: 0 } })) })
    const address = JSON.stringify({ regionCode: 'US', addressLines: ['77 Dean St'], locality: 'Brooklyn' })
    for (const [id, title, opening, special] of [
      ['brooklyn', 'Brooklyn', hours([0, 2, 3, 4, 5, 6]), null],
      ['williamsburg', 'Williamsburg', hours([0, 1, 2, 3, 4, 5, 6]), JSON.stringify([{ kind: 'closure', starts_on: '2026-11-12', ends_on: '2026-11-12', note: null }])],
      ['studio', 'Studio', hours([0, 1, 2, 3, 4, 5, 6]), null],
    ] as const) {
      await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, address, opening_hours, special_hours, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).bind(id, ORG, id, title, ZONE, address, opening, special, NOW, NOW).run()
    }
    // Each restaurant's tables, the owner's to handle.
    for (const location of ['brooklyn', 'williamsburg']) {
      await db.prepare("INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('table', ?, ?, ?, ?, ?, ?)").bind(`${location}-tables`, ORG, `${location} tables`, `${location}-tables`, OWNER, OWNER).run()
      await db.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, 'Table', ?, ?)").bind(`${location}-table`, ORG, `${location}-tables`, OWNER, OWNER).run()
      await db.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, ?, ?, 1, 1, ?, ?)").bind(ORG, `${location}-tables`, location, OWNER, OWNER).run()
      await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, payment_basis, assigned_member_id, created_by, updated_by) VALUES (?, ?, 'slot', 90, 40, 'business', 'per_booking', ?, ?, ?)").bind(`${location}-tables`, ORG, `m-${OWNER}`, OWNER, OWNER).run()
    }
    // Two tables booked on Brooklyn's Tuesday, one cancelled; one on Williamsburg's Saturday.
    for (const [id, location, at, status] of [['r1', 'brooklyn', '2026-11-10T23:00:00.000Z', 'confirmed'], ['r2', 'brooklyn', '2026-11-11T00:30:00.000Z', 'confirmed'], ['r3', 'brooklyn', '2026-11-11T01:00:00.000Z', 'cancelled'], ['r4', 'williamsburg', '2026-11-14T23:00:00.000Z', 'confirmed']]) {
      await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 40, 'scheduled', ?, ?)`)
        .bind(`${id}-seating`, ORG, `${location}-tables`, location, ZONE, at, new Date(Date.parse(at!) + 5_400_000).toISOString(), OWNER, OWNER).run()
      await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, policy_json, status) VALUES (?, ?, ?, ?, ?, 2, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null}', ?)`)
        .bind(id, ORG, `${location}-tables`, `${id}-seating`, `${location}-table`, status).run()
    }
    // The pizza class at Brooklyn: a session each weekday evening, Wednesday's booked. The family-law consultation is Dana's hours: two slots on weekdays.
    for (const [id, name, kind] of [['class', 'Pizza Class', 'experience'], ['family', 'Family Law', 'service']]) {
      await db.prepare("INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(kind, id, ORG, name, id, OWNER, OWNER).run()
      await db.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, 'Seat', ?, ?)").bind(`${id}-seat`, ORG, id, OWNER, OWNER).run()
    }
    await db.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, 'class', 'brooklyn', 1, 1, ?, ?)").bind(ORG, OWNER, OWNER).run()
    await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, created_by, updated_by) VALUES ('class', ?, 'slot', 120, 12, 'business', ?, ?)").bind(ORG, OWNER, OWNER).run()
    await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, public_name, public_approved, updated_at, updated_by)
      VALUES (?, ?, ?, '[]', '[]', 'Dana Brooks, Esq.', 1, ?, ?)`).bind(`m-${OWNER}`, ORG, ZONE, NOW, OWNER).run()
    await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, assigned_member_id, held_online, created_by, updated_by) VALUES ('family', ?, 'slot', 60, 1, 'provider', ?, 1, ?, ?)").bind(ORG, `m-${OWNER}`, OWNER, OWNER).run()
    // New York is five hours behind UTC in November.
    const session = (id: string, product: string, day: string, hour: number) => {
      const starts = Date.parse(`${day}T00:00:00.000Z`) + (hour + 5) * 3_600_000
      return db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 4, 'scheduled', ?, ?)`).bind(id, ORG, product, product === 'class' ? 'brooklyn' : null, ZONE, new Date(starts).toISOString(), new Date(starts + 7_200_000).toISOString(), OWNER, OWNER).run()
    }
    for (const [offset, day] of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'].entries()) {
      await session(`class-${offset}`, 'class', day, 18)
      await session(`family-${offset}-a`, 'family', day, 10)
      await session(`family-${offset}-b`, 'family', day, 14)
    }
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, policy_json, status) VALUES ('b1', ?, 'class', 'class-2', 'class-seat', 3, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null}', 'confirmed')`).bind(ORG).run()
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, policy_json, status) VALUES ('b2', ?, 'family', 'family-1-a', 'family-seat', 1, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null}', 'pending')`).bind(ORG).run()
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, organizationId: ORG, role } as never, { env })
    return { runtime, db, owner: principal(OWNER, 'owner'), staff: principal(STAFF, 'member') }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const state = (days: PlaceDay[]) => days.map(day => [day.date.slice(-2), day.closed ? 'blocked' : 'open', day.held?.kind ?? null, day.booked, day.free].join(':'))
const code = (expected: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected

test('the places calendar reads each location, experience and consultation with every day held, booked or free', { timeout: 120_000 }, async () => {
  const { runtime, db, owner, staff } = await boot()
  try {
    const calendar = await readPlacesCalendar(db, owner, { from: FROM, to: TO })
    assert.equal(calendar.manage, true)
    assert.deepEqual(calendar.places.map(entry => [entry.place.kind, entry.place.id, entry.place.name, entry.place.detail, entry.place.slug, entry.place.provider]), [
      ['location', 'brooklyn', 'Brooklyn', '77 Dean St, Brooklyn', 'brooklyn', null],
      ['location', 'williamsburg', 'Williamsburg', '77 Dean St, Brooklyn', 'williamsburg', null],
      ['offering', 'family', 'Family Law', 'Consultation · Dana Brooks, Esq.', null, { member_id: `m-${OWNER}`, name: 'Dana Brooks, Esq.' }],
      ['offering', 'class', 'Pizza Class', 'Experience · Brooklyn', null, null],
    ])
    const [brooklyn, williamsburg, family, pizza] = calendar.places
    // Monday is outside Brooklyn's hours; Tuesday holds two tables, the cancelled one not counted.
    assert.deepEqual(state(brooklyn!.days), ['09:blocked:hours:0:', '10:open:booked:2:', '11:open::0:', '12:open::0:', '13:open::0:', '14:open::0:', '15:open::0:'])
    assert.equal(brooklyn!.days[0]!.held!.text, "Closed: outside Brooklyn's hours")
    assert.equal(brooklyn!.days[1]!.held!.text, '2 reservations')
    // Williamsburg's Thursday is the host's closure: blocked, and writable.
    assert.deepEqual(state(williamsburg!.days), ['09:open::0:', '10:open::0:', '11:open::0:', '12:blocked::0:', '13:open::0:', '14:open:booked:1:', '15:open::0:'])
    // The class: one session a weekday, Wednesday's booked; the weekend has none.
    assert.deepEqual(state(pizza!.days), ['09:open::0:1', '10:open::0:1', '11:open:booked:1:0', '12:open::0:1', '13:open::0:1', '14:open:unscheduled:0:0', '15:open:unscheduled:0:0'])
    assert.equal(pizza!.days[5]!.held!.text, 'No session on this day')
    // Dana's consultations: two slots a weekday, Tuesday's first one requested; the weekend is outside her hours.
    assert.deepEqual(state(family!.days), ['09:open::0:2', '10:open::1:1', '11:open::0:2', '12:open::0:2', '13:open::0:2', '14:open:hours:0:0', '15:open:hours:0:0'])
    assert.equal(family!.days[5]!.held!.text, "Outside Dana's hours")
    assert.equal(family!.place.timezone, ZONE)

    // A member sees only what they are assigned, and cannot manage.
    const assigned = await readPlacesCalendar(db, staff, { from: FROM, to: TO })
    assert.deepEqual(assigned.places, [])
    assert.equal(assigned.manage, false)
    // Handling Williamsburg's tables is what puts Williamsburg on the member's calendar.
    await db.prepare('UPDATE product_booking_configs SET assigned_member_id = ? WHERE product_id = ?').bind(`m-${STAFF}`, 'williamsburg-tables').run()
    assert.deepEqual((await readPlacesCalendar(db, staff, { from: FROM, to: TO })).places.map(entry => entry.place.id), ['williamsburg'])
    // Hosting the class held at Brooklyn is handling a product offered there, which reaches Brooklyn too.
    await db.prepare('UPDATE product_booking_configs SET assigned_member_id = ? WHERE product_id = ?').bind(`m-${STAFF}`, 'class').run()
    assert.deepEqual((await readPlacesCalendar(db, staff, { from: FROM, to: TO })).places.map(entry => entry.place.id), ['brooklyn', 'williamsburg', 'class'])

    for (const input of [{ from: 'soon', to: TO }, { from: TO, to: FROM }, { from: FROM, to: '2027-02-01' }]) await assert.rejects(readPlacesCalendar(db, owner, input), code('INVALID_PLACE_DATES'))
  } finally {
    await runtime.dispose()
  }
})

test('blocking and opening a place’s days writes a location’s closures and an offering’s unclaimed sessions, by weekday', { timeout: 120_000 }, async () => {
  const { runtime, db, owner, staff } = await boot()
  try {
    const write = (kind: string, id: string, body: Record<string, unknown>, principal = owner) => setPlaceDates(db, principal, { kind, id, body })
    for (const body of [{ from: FROM, to: TO }, { from: FROM, to: TO, closed: 'yes' }, { from: FROM, to: TO, closed: true, weekdays: [] }, { from: FROM, to: TO, closed: true, weekdays: [7] }, { from: FROM, to: TO, closed: true, weekdays: [1, 1] }, { from: FROM, to: TO, closed: true, note: 'x' }, { from: '2026-11-10', to: '2026-11-11', closed: true, weekdays: [5] }]) {
      await assert.rejects(write('location', 'brooklyn', body), code('INVALID_PLACE_DATES'), JSON.stringify(body))
    }
    await assert.rejects(write('room', 'brooklyn', { from: FROM, to: TO, closed: true }), code('PLACE_NOT_FOUND'))
    // The studio has no tables, so it is no row of the grid; the day leaf and Select dates still block it through this write, and read it back.
    const studio = await write('location', 'studio', { from: '2026-11-10', to: '2026-11-11', closed: true })
    assert.deepEqual(state(studio.days), ['10:blocked::0:'])
    assert.deepEqual(parseSpecialHours(JSON.parse((await db.prepare('SELECT special_hours FROM business_locations WHERE id = ?').bind('studio').first<{ special_hours: string }>())!.special_hours)), [{ kind: 'closure', starts_on: '2026-11-10', ends_on: '2026-11-10', note: null }])
    assert.deepEqual((await readPlacesCalendar(db, owner, { from: FROM, to: TO })).places.map(entry => entry.place.id), ['brooklyn', 'williamsburg', 'family', 'class'])
    await assert.rejects(write('location', 'missing', { from: FROM, to: TO, closed: true }), (error: unknown) => (error as { status?: number }).status === 404)
    await assert.rejects(write('location', 'brooklyn', { from: FROM, to: TO, closed: true }, staff), (error: unknown) => (error as { statusCode?: number; status?: number }).statusCode === 404 || (error as { status?: number }).status === 404)

    // Wednesdays and Fridays blocked at Brooklyn: one closure each, read back from the location and from the calendar.
    const before = (await db.prepare('SELECT updated_at FROM business_locations WHERE id = ?').bind('brooklyn').first<{ updated_at: string }>())!.updated_at
    const blocked = await write('location', 'brooklyn', { from: FROM, to: TO, closed: true, weekdays: [3, 5], expected_updated_at: before })
    assert.deepEqual(state(blocked.days), ['09:blocked:hours:0:', '10:open:booked:2:', '11:blocked::0:', '12:open::0:', '13:blocked::0:', '14:open::0:', '15:open::0:'])
    assert.notEqual(blocked.place.updated_at, before)
    const saved = await db.prepare('SELECT special_hours FROM business_locations WHERE id = ?').bind('brooklyn').first<{ special_hours: string }>()
    assert.deepEqual(parseSpecialHours(JSON.parse(saved!.special_hours)), [
      { kind: 'closure', starts_on: '2026-11-11', ends_on: '2026-11-11', note: null },
      { kind: 'closure', starts_on: '2026-11-13', ends_on: '2026-11-13', note: null },
    ])
    // A stale timestamp is refused and changes nothing.
    await assert.rejects(write('location', 'brooklyn', { from: FROM, to: TO, closed: false, expected_updated_at: before }), (error: unknown) => (error as { statusCode?: number }).statusCode === 409 || (error as { status?: number }).status === 409)
    assert.deepEqual(state((await readPlacesCalendar(db, owner, { from: FROM, to: TO }, { kind: 'location', id: 'brooklyn' })).places[0]!.days), state(blocked.days))
    // Opening the whole week cuts both closures out; Monday stays closed by the hours.
    const opened = await write('location', 'brooklyn', { from: FROM, to: TO, closed: false })
    assert.deepEqual(state(opened.days), ['09:blocked:hours:0:', '10:open:booked:2:', '11:open::0:', '12:open::0:', '13:open::0:', '14:open::0:', '15:open::0:'])
    assert.equal((await db.prepare('SELECT special_hours FROM business_locations WHERE id = ?').bind('brooklyn').first<{ special_hours: string | null }>())!.special_hours, null)

    // Blocking the class's week cancels the unclaimed sessions and leaves Wednesday's booked one scheduled.
    const cancelled = await write('offering', 'class', { from: FROM, to: TO, closed: true })
    assert.deepEqual(state(cancelled.days), ['09:blocked::0:0', '10:blocked::0:0', '11:open:booked:1:0', '12:blocked::0:0', '13:blocked::0:0', '14:open:unscheduled:0:0', '15:open:unscheduled:0:0'])
    assert.deepEqual((await db.prepare("SELECT id, status FROM product_sessions WHERE product_id = 'class' ORDER BY starts_at").all<{ id: string; status: string }>()).results,
      [{ id: 'class-0', status: 'cancelled' }, { id: 'class-1', status: 'cancelled' }, { id: 'class-2', status: 'scheduled' }, { id: 'class-3', status: 'cancelled' }, { id: 'class-4', status: 'cancelled' }])
    const event = await db.prepare("SELECT payload_json FROM activity_entries WHERE event_name = 'product.updated' AND json_extract(payload_json, '$.entityId') = 'class' ORDER BY rowid DESC LIMIT 1").first<{ payload_json: string }>()
    assert.deepEqual(JSON.parse(event!.payload_json).metadata, { from: FROM, to: TO, closed: true, sessions: 4 })
    // Opening Mondays and Fridays restores those two; the rest stay cancelled. Dana's consultations are untouched throughout.
    const restored = await write('offering', 'class', { from: FROM, to: TO, closed: false, weekdays: [1, 5] })
    assert.deepEqual(state(restored.days), ['09:open::0:1', '10:blocked::0:0', '11:open:booked:1:0', '12:blocked::0:0', '13:open::0:1', '14:open:unscheduled:0:0', '15:open:unscheduled:0:0'])
    assert.equal((await db.prepare("SELECT count(*) n FROM product_sessions WHERE product_id = 'family' AND status = 'scheduled'").first<number>('n')), 10)
    // A consultation's Saturday has nothing to write; the week's other days cancel the free slots and keep the requested one, so Tuesday reads blocked with its booking.
    const consultations = await write('offering', 'family', { from: FROM, to: TO, closed: true })
    assert.deepEqual(state(consultations.days), ['09:blocked::0:0', '10:blocked::1:0', '11:blocked::0:0', '12:blocked::0:0', '13:blocked::0:0', '14:open:hours:0:0', '15:open:hours:0:0'])
    assert.equal((await db.prepare("SELECT status FROM product_sessions WHERE id = 'family-1-a'").first<string>('status')), 'scheduled')
    assert.equal((await db.prepare("SELECT status FROM product_sessions WHERE id = 'family-1-b'").first<string>('status')), 'cancelled')
  } finally {
    await runtime.dispose()
  }
})
