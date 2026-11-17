import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { readPlacesCalendar, setPlaceDates, type PlaceDay } from '../../server/domain/places.ts'
import { localDateAt } from '../../utils/timezone.ts'
import { readPublicProductAvailability } from '../../server/utils/public-session-booking.ts'
import { applySchema } from './support/schema.ts'

// The places calendar: restaurant locations, experiences and consultations as
// rows, days as columns, and the one write that opens or blocks their days.
const ORG = 'org-places'
const OWNER = 'places-owner'
const STAFF = 'places-staff'
const NOW = '2026-11-02T12:00:00.000Z'
// 2027-11-08 is a Monday; the window runs Monday to the following Sunday.
const FROM = '2027-11-08'
const TO = '2027-11-15'
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
    await applySchema(db)
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
      ['williamsburg', 'Williamsburg', hours([0, 1, 2, 3, 4, 5, 6]), JSON.stringify([{ kind: 'closure', starts_on: '2027-11-11', ends_on: '2027-11-11', note: null }])],
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
      await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, seating_interval_minutes, default_capacity, scheduling_mode, payment_basis, assigned_member_id, created_by, updated_by) VALUES (?, ?, 'slot', 90, 30, 40, 'business', 'per_booking', ?, ?, ?)").bind(`${location}-tables`, ORG, `m-${OWNER}`, OWNER, OWNER).run()
    }
    // Two tables booked on Brooklyn's Tuesday, one cancelled; one on Williamsburg's Saturday.
    for (const [id, location, at, status] of [['r1', 'brooklyn', '2027-11-09T23:00:00.000Z', 'confirmed'], ['r2', 'brooklyn', '2027-11-10T00:30:00.000Z', 'confirmed'], ['r3', 'brooklyn', '2027-11-10T01:00:00.000Z', 'cancelled'], ['r4', 'williamsburg', '2027-11-13T23:00:00.000Z', 'confirmed']]) {
      await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 40, 'scheduled', ?, ?)`)
        .bind(`${id}-seating`, ORG, `${location}-tables`, location, ZONE, at, new Date(Date.parse(at!) + 5_400_000).toISOString(), OWNER, OWNER).run()
      await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, policy_json, status, cancelled_at)
        SELECT ?, organization_id, product_id, id, ?, location_id, starts_at, ends_at, timezone, 2, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', ?, CASE WHEN ? = 'cancelled' THEN ? END FROM product_sessions WHERE id = ?`)
        .bind(id, `${location}-table`, status, status, NOW, `${id}-seating`).run()
    }
    // The pizza class at Brooklyn: a session each weekday evening, Wednesday's booked. The family-law consultation is Dana's hours: two slots on weekdays.
    for (const [id, name, kind] of [['class', 'Pizza Class', 'experience'], ['family', 'Family Law', 'service']]) {
      await db.prepare("INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(kind, id, ORG, name, id, OWNER, OWNER).run()
      await db.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, 'Seat', ?, ?)").bind(`${id}-seat`, ORG, id, OWNER, OWNER).run()
      await db.prepare('INSERT INTO product_publications (organization_id, product_id, published, created_by, updated_by) VALUES (?, ?, 1, ?, ?)').bind(ORG, id, OWNER, OWNER).run()
    }
    await db.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, 'class', 'brooklyn', 1, 1, ?, ?)").bind(ORG, OWNER, OWNER).run()
    await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, created_by, updated_by) VALUES ('class', ?, 'slot', 120, 12, 'business', ?, ?)").bind(ORG, OWNER, OWNER).run()
    await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, public_name, public_approved, updated_at, updated_by)
      VALUES (?, ?, ?, ?, '[]', 'Dana Brooks, Esq.', 1, ?, ?)`).bind(`m-${OWNER}`, ORG, ZONE, JSON.stringify([1, 2, 3, 4, 5].flatMap(weekday => [{ weekday, start: '10:00', end: '12:00' }, { weekday, start: '14:00', end: '16:00' }])), NOW, OWNER).run()
    await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, assigned_member_id, held_online, created_by, updated_by) VALUES ('family', ?, 'slot', 120, 1, 'provider', ?, 1, ?, ?)").bind(ORG, `m-${OWNER}`, OWNER, OWNER).run()
    // New York is five hours behind UTC in November.
    const session = (id: string, product: string, day: string, hour: number) => {
      const starts = Date.parse(`${day}T00:00:00.000Z`) + (hour + 5) * 3_600_000
      return db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 4, 'scheduled', ?, ?)`).bind(id, ORG, product, product === 'class' ? 'brooklyn' : null, ZONE, new Date(starts).toISOString(), new Date(starts + 7_200_000).toISOString(), OWNER, OWNER).run()
    }
    for (const [offset, day] of ['2027-11-08', '2027-11-09', '2027-11-10', '2027-11-11', '2027-11-12'].entries()) {
      await session(`class-${offset}`, 'class', day, 18)
      await session(`family-${offset}-a`, 'family', day, 10)
      await session(`family-${offset}-b`, 'family', day, 14)
    }
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, policy_json, status)
      SELECT 'b1', organization_id, product_id, id, 'class-seat', location_id, starts_at, ends_at, timezone, 3, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', 'confirmed' FROM product_sessions WHERE id = 'class-2' AND organization_id = ?`).bind(ORG).run()
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, policy_json, status)
      SELECT 'b2', organization_id, product_id, id, 'family-seat', location_id, starts_at, ends_at, timezone, 1, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', 'pending' FROM product_sessions WHERE id = 'family-1-a' AND organization_id = ?`).bind(ORG).run()
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, organizationId: ORG, role } as never, { env })
    return { runtime, db, env, owner: principal(OWNER, 'owner'), staff: principal(STAFF, 'member') }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const state = (days: PlaceDay[]) => days.map(day => [day.date.slice(-2), day.closed ? 'blocked' : 'open', day.held?.kind ?? null, day.booked, day.free].join(':'))
const code = (expected: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected

test('the places calendar reads each location, experience and consultation with every day held, booked or free', { timeout: 120_000 }, async () => {
  const { runtime, db, env, owner, staff } = await boot()
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
    assert.deepEqual(state(brooklyn!.days), ['08:blocked:hours:0:', '09:open:booked:2:', '10:open::0:', '11:open::0:', '12:open::0:', '13:open::0:', '14:open::0:'])
    assert.equal(brooklyn!.days[0]!.held!.text, "Closed: outside Brooklyn's hours")
    assert.equal(brooklyn!.days[1]!.held!.text, '2 reservations')
    // Williamsburg's Thursday is the host's closure: blocked, and writable.
    assert.deepEqual(state(williamsburg!.days), ['08:open::0:', '09:open::0:', '10:open::0:', '11:blocked::0:', '12:open::0:', '13:open:booked:1:', '14:open::0:'])
    // The class: one session a weekday, Wednesday's booked; the weekend has none. Brooklyn is shut on Mondays, so a guest cannot book Monday's: it is not free.
    assert.deepEqual(state(pizza!.days), ['08:open::0:0', '09:open::0:1', '10:open:booked:1:0', '11:open::0:1', '12:open::0:1', '13:open:unscheduled:0:0', '14:open:unscheduled:0:0'])
    assert.equal(pizza!.days[5]!.held!.text, 'No session on this day')
    // Dana's consultations: two slots a weekday, Tuesday's first one requested; the weekend is outside her hours.
    assert.deepEqual(state(family!.days), ['08:open::0:2', '09:open::1:1', '10:open::0:2', '11:open::0:2', '12:open::0:2', '13:open:hours:0:0', '14:open:hours:0:0'])
    assert.equal(family!.days[5]!.held!.text, "Outside Dana's hours")
    assert.equal(family!.place.timezone, ZONE)

    // The host Calendar and the booking page read the same places left: Wednesday's booking takes three, and on
    // Thursday both an active and an expired checkout leave the session's places free.
    for (const [id, quantity, expires] of [['live', 1, '+1 day'], ['lapsed', 2, '-1 minute']] as const) {
      await db.prepare("INSERT INTO payments (id, organization_id, stripe_account_id, livemode, subject_type, currency, amount, price_snapshot_json, created_at, updated_at) VALUES (?, ?, 'acct_test', 0, 'booking', 'USD', 100, '{}', ?, ?)").bind(`pay-${id}`, ORG, NOW, NOW).run()
      await db.prepare(`INSERT INTO payment_checkout_holds (id, organization_id, product_id, variant_id, price_id, session_id, payment_id, quantity, amount, currency, starts_at, ends_at, expires_at, created_at)
        SELECT ?, organization_id, product_id, 'class-seat', 'price', id, ?, ?, 100, 'USD', starts_at, ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?), ? FROM product_sessions WHERE id = 'class-3'`).bind(`hold-${id}`, `pay-${id}`, quantity, expires, NOW).run()
    }
    const placesLeft = async () => {
      const guest = (await readPublicProductAvailability(db, ORG, 'class', env, { location_id: 'brooklyn', from: FROM, to: TO })).sessions as Array<{ starts_at: string; timezone: string; remaining: number | null; is_full: boolean }>
      const host = (await readPlacesCalendar(db, owner, { from: FROM, to: TO }, { kind: 'offering', id: 'class' })).places[0]!.days
      const guestPlacesLeft = (date: string) => guest.filter(session => !session.is_full && localDateAt(new Date(session.starts_at), session.timezone) === date).reduce((sum, session) => sum + session.remaining!, 0)
      assert.deepEqual(host.map(day => day.places_left), host.map(day => guestPlacesLeft(day.date)))
      return host.map(day => day.places_left)
    }
    assert.deepEqual(await placesLeft(), [0, 4, 1, 4, 4, 0, 0])
    // Wednesday's one place is fewer than a party of two, the smallest the class takes: neither side offers it.
    await db.prepare("UPDATE product_booking_configs SET party_size_min = 2 WHERE product_id = 'class'").run()
    assert.deepEqual(await placesLeft(), [0, 4, 0, 4, 4, 0, 0])

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

    for (const input of [{ from: 'soon', to: TO }, { from: TO, to: FROM }]) await assert.rejects(readPlacesCalendar(db, owner, input), code('INVALID_PLACE_DATES'))

    // Blocking a place's days from a stale read changes nothing; blocking an offering's week keeps its booked session.
    const read = (await db.prepare('SELECT updated_at FROM business_locations WHERE id = ?').bind('brooklyn').first<{ updated_at: string }>())!.updated_at
    await setPlaceDates(db, owner, { kind: 'location', id: 'brooklyn', body: { from: FROM, to: TO, closed: true, weekdays: [3], updated_at: read } })
    const closures = await db.prepare('SELECT special_hours FROM business_locations WHERE id = ?').bind('brooklyn').first('special_hours')
    await assert.rejects(setPlaceDates(db, owner, { kind: 'location', id: 'brooklyn', body: { from: FROM, to: TO, closed: false, updated_at: read } }), (error: unknown) => (error as { statusCode?: number }).statusCode === 409 || (error as { status?: number }).status === 409)
    assert.equal(await db.prepare('SELECT special_hours FROM business_locations WHERE id = ?').bind('brooklyn').first('special_hours'), closures)
    await setPlaceDates(db, owner, { kind: 'offering', id: 'class', body: { from: FROM, to: TO, closed: true } })
    assert.deepEqual((await db.prepare("SELECT id, status FROM product_sessions WHERE product_id = 'class' ORDER BY starts_at").all<{ id: string; status: string }>()).results,
      [{ id: 'class-0', status: 'cancelled' }, { id: 'class-1', status: 'cancelled' }, { id: 'class-2', status: 'scheduled' }, { id: 'class-3', status: 'cancelled' }, { id: 'class-4', status: 'cancelled' }])
  } finally {
    await runtime.dispose()
  }
})
