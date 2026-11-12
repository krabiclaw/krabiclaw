import assert from 'node:assert/strict'
import { nameConversationBooking, setBookingStatus } from './support/booking-state.ts'
import { OPEN_TERMS_JSON } from './support/booking-terms.ts'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import {
  CapacityUnavailableError,
  setProductBookingConfig,
  deleteProductBookingConfig,
  replaceWeeklySchedule,
  claimSessionCapacity,
  bookingWindow,
  listSessions,
  materializeSessions,
  sessionMoveQuery,
  updateSession,
} from '../../server/utils/availability.ts'
import { requestInsertQueries, threadPayloadForGuest, getThreadOperationalRecord } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { appendMessage } from '../../server/domain/conversations.ts'
import { conversationTaskQueries } from '../../server/domain/guest-threads/repository.ts'
import { listDashboardLocations } from '../../server/utils/dashboard-context.ts'
import { updateLocation } from '../../server/utils/location-management.ts'
import { syncPlaceToLocation } from '../../server/utils/google-places.ts'
import { listPublicBookingSessions } from '../../server/utils/public-session-booking.ts'
import { createProduct, getProduct, removeProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { occurrenceKey } from '../../shared/bookings.ts'
import { addLocalDays, formatTimestamp, localDateTimeToInstant, localNow } from '../../utils/timezone.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { assertAssignedBookingAccess, memberAccessPrincipal } from '../../server/utils/member-access.ts'
import sessionsMaterialize from '../../server/tasks/sessions-materialize.ts'

const ORG = 'org-sessions'
const LOCATION = 'loc-sessions'
const PRODUCT = 'prod-class'
const ACTOR = 'user-actor'
const NOW = '2026-09-11T00:00:00.000Z'
/** The open reply tasks of a conversation, by dedupe key: the guest entry each one is about. */
const openReplies = (db: D1Database, threadId: string) => db.prepare("SELECT dedupe_key FROM tasks WHERE kind = 'guest_reply' AND subject_type = 'conversation' AND subject_id = ? AND status = 'open'").bind(threadId).all<{ dedupe_key: string }>().then(rows => rows.results.map(row => row.dedupe_key))

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'availability-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'availability-proof', exportName: 'Hub' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  await db.prepare("INSERT INTO user (id,name,email) VALUES (?,'Operator','operator@example.com')").bind(ACTOR).run()
  await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
       VALUES (?, 'Sessions', 'sessions', 'sessions', '{}', 'theme', 'THB', 'active', 'complete', 'flat', 'experience', ?, 'Asia/Bangkok')`)
    .bind(ORG, NOW).run()
  await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('sessions-en', ?, 'en', 1, 'published')").bind(ORG).run()
  await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
    VALUES (?, ?, 'studio', 'Studio', 'active', 'Asia/Bangkok', ?, ?)`).bind(LOCATION, ORG, NOW, NOW).run()
  await db.prepare(`INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('experience', ?, ?, 'Pottery Class', 'pottery-class', ?, ?)`)
    .bind(PRODUCT, ORG, ACTOR, ACTOR).run()
  await db.prepare('INSERT INTO product_publications (organization_id, product_id, published, created_by, updated_by) VALUES (?, ?, 1, ?, ?)').bind(ORG, PRODUCT, ACTOR, ACTOR).run()
  for (const [id, name] of [['var-adult', 'Adult'], ['var-child', 'Child']]) {
    await db.prepare(`INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, ORG, PRODUCT, name, ACTOR, ACTOR).run()
  }
  // The studio sells it: a session at a location takes seats only while that
  // location is still offering the product.
  await db.prepare(`INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by)
    VALUES (?, ?, ?, 1, 1, ?, ?)`).bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()
  // Every bookable offering has the member who handles its bookings.
  await db.prepare("INSERT INTO user (id,name,email) VALUES ('class-host-user','Class host','class-host@example.com')").run()
  await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('class-host', ?, 'class-host-user', 'member')").bind(ORG).run()
  await db.prepare(`INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, assigned_member_id, created_by, updated_by)
    VALUES (?, ?, 'slot', 120, 10, 'business', 'class-host', ?, ?)`).bind(PRODUCT, ORG, ACTOR, ACTOR).run()
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
    STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test' } as CloudflareEnv
  return { runtime, db, env }
}

function addRule(db: D1Database, id: string, over: Partial<{ weekday: number; start_time: string; timezone: string; location_id: string | null }> = {}) {
  return db.prepare(`INSERT INTO product_availability_rules
    (id, organization_id, product_id, location_id, timezone, weekday, start_time, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ORG, PRODUCT, over.location_id === undefined ? LOCATION : over.location_id, over.timezone ?? 'Asia/Bangkok', over.weekday ?? 0,
      over.start_time ?? '14:00', ACTOR, ACTOR).run()
}

test('hourly materialization reaches the next page with a rate-limited KV cursor', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const openingHours = { periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 17, minute: 0 }, close: { day, hour: 22, minute: 0 },
    })) }
    assert.equal((await updateLocation(db, ORG, LOCATION, { opening_hours: openingHours }, ACTOR, env)).status, 200)
    await addRule(db, 'hourly-class', { start_time: '18:00' })
    // These offerings fill the first page. The public class, which has a weekly time but
    // no sessions yet, can only be reached if the cursor survives the first invocation.
    await db.batch([
      db.prepare(`WITH RECURSIVE catalog(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM catalog WHERE n<50)
        INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)
        SELECT 'experience','a-offering-'||n,?,'Offering '||n,'a-offering-'||n,?,? FROM catalog`).bind(ORG, ACTOR, ACTOR),
      db.prepare(`INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,default_capacity,scheduling_mode,assigned_member_id,created_by,updated_by)
        SELECT id,organization_id,'slot',120,10,'business','class-host',?,? FROM products WHERE organization_id=? AND id LIKE 'a-offering-%'`).bind(ACTOR, ACTOR, ORG),
    ])
    const kv = env.ORGANIZATION_CACHE!
    let written: boolean
    const claimWrite = () => {
      if (written) throw new Error('KV PUT failed: 429 Too Many Requests')
      written = true
    }
    const run = () => {
      written = false
      return sessionsMaterialize.run({ name: 'sessions-materialize', context: { cloudflare: { env: {
        ...env, ORGANIZATION_CACHE: {
          get: kv.get.bind(kv),
          put: async (key: string, value: string) => { claimWrite(); await kv.put(key, value) },
          delete: async (key: string) => { claimWrite(); await kv.delete(key) },
        },
      } } } })
    }
    const sessions = () => listSessions(db, { env, organizationId: ORG, productId: PRODUCT, ...bookingWindow('Asia/Bangkok') })
    assert.deepEqual(await sessions(), [])
    await run()
    assert.deepEqual(await sessions(), [])
    await run()
    const offered = await sessions()
    assert.ok(offered.length > 0)
    assert.ok(offered.every(row => row.remaining === 10 && row.location_id === LOCATION))
    await run()
    await run()
    assert.deepEqual((await sessions()).map(row => row.id), offered.map(row => row.id))
  } finally { await runtime.dispose() }
})

test('a weekly time puts a session on each of its days inside the place\'s hours, once', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    // The studio is open 17:00–21:00 every day; a two-hour session must fit inside.
    await db.prepare('UPDATE business_locations SET opening_hours = ? WHERE id = ?')
      .bind(JSON.stringify({ periods: [0, 1, 2, 3, 4, 5, 6].map(day => ({ open: { day, hour: 17, minute: 0 }, close: { day, hour: 21, minute: 0 } })) }), LOCATION).run()
    await assert.rejects(replaceWeeklySchedule(db, { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR, slots: [{ weekday: 1, start_time: '16:00', end_time: '20:30', interval_minutes: 30 }] }), /slots support weekday and start_time/)
    const slots = [0, 1, 2, 3, 4, 5, 6].flatMap(weekday => ['16:00', '17:00', '18:30', '19:30'].map(start_time => ({ weekday, start_time })))
    const saved = await replaceWeeklySchedule(db, { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR, slots })
    assert.equal(saved.rules.length, 28)
    assert.ok(saved.sessions.skipped.length > 0 && saved.sessions.skipped.every(skip => skip.reason === 'location_closed'), 'starts the hours cannot hold are skipped, by name')

    const day = addLocalDays(localNow('Asia/Bangkok').date, 3)
    const window = { fromInstant: localDateTimeToInstant(day, '00:00', 'Asia/Bangkok', 'compatible').toISOString(), toInstant: localDateTimeToInstant(addLocalDays(day, 1), '00:00', 'Asia/Bangkok', 'compatible').toISOString() }
    const local = (instant: string) => formatTimestamp(instant, 'en', 'Asia/Bangkok', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    const onDay = await listSessions(db, { env, organizationId: ORG, productId: PRODUCT, ...window })
    // 16:00 starts before opening; 19:30 would end after closing.
    assert.deepEqual(onDay.map(session => [local(session.starts_at), local(session.ends_at), session.capacity, session.remaining]),
      [['17:00', '19:00', 10, 10], ['18:30', '20:30', 10, 10]])

    // Running generation again over the same window makes nothing new.
    const again = await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate: addLocalDays(localNow('Asia/Bangkok').date, 31), actorId: ACTOR })
    assert.equal(again.created, 0)
    assert.equal((await listSessions(db, { env, organizationId: ORG, productId: PRODUCT, ...window })).length, 2)

    // A dated closure takes the day's sessions off sale without deleting them.
    await db.prepare('UPDATE business_locations SET special_hours = ? WHERE id = ?').bind(JSON.stringify([{ kind: 'closure', starts_on: day, ends_on: day, note: null }]), LOCATION).run()
    assert.deepEqual((await listSessions(db, { env, organizationId: ORG, productId: PRODUCT, ...window })).map(session => [session.remaining, session.is_full]), Array(2).fill([0, true]))
  } finally {
    await runtime.dispose()
  }
})

test('a table is seated through its location\'s current hours: wider hours and an opened day add seatings, closing cancels the unbooked ones', { timeout: 120_000 }, async (t) => {
  const { runtime, db, env } = await boot()
  try {
    const ZONE = 'Asia/Bangkok'
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('member-actor', ?, ?, 'owner')").bind(ORG, ACTOR).run()
    const hours = (close: number) => ({ periods: [0, 2, 3, 4, 5, 6].map(day => ({ open: { day, hour: 17, minute: 0 }, close: { day, hour: close, minute: 0 } })) })
    // The dining room opens Tuesday to Sunday, 17:00–21:00; Monday is its closed day. Bangkok keeps no daylight saving.
    assert.equal((await updateLocation(db, ORG, LOCATION, { opening_hours: hours(21) }, ACTOR, env)).status, 200)
    const tables = await createProduct(db, {
      env, organizationId: ORG, actor: { actorId: ACTOR }, publication: { published: true },
      product: { kind: 'table', name: 'Dining room', variants: [{ name: 'Table', prices: [{ unit_amount: 0, currency: 'THB', type: 'one_time' }] }] },
      booking: { env, data: { location_id: LOCATION, duration_minutes: 90, seating_interval_minutes: 30, default_capacity: 20, confirmation_mode: 'instant', scheduling_mode: 'business', assigned_member_id: 'class-host' } },
    })
    // A table has no weekly times of its own: its location's hours are its one schedule.
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM product_availability_rules WHERE product_id = ?').bind(tables.id).first<{ n: number }>())!.n, 0)
    await assert.rejects(replaceWeeklySchedule(db, { organizationId: ORG, productId: tables.id, locationId: LOCATION, actorId: ACTOR, slots: [{ weekday: 1, start_time: '12:00' }] }), /seated through its location's opening hours/)

    // What a guest is offered, read the way the booking page reads it: local "date time" of each open seating.
    const local = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant)).replace(',', '')
    const offered = async (date: string) => (await listPublicBookingSessions(db, ORG, tables.slug, env)).sessions
      .filter(session => local(session.starts_at).startsWith(date)).map(session => [local(session.starts_at).slice(11), session.remaining])
    let monday = addLocalDays(localNow(ZONE).date, 2)
    while (new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1) monday = addLocalDays(monday, 1)
    const tuesday = addLocalDays(monday, 1)
    const wednesday = addLocalDays(monday, 2)
    const evening = (until: string) => ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'].filter(time => time <= until).map(time => [time, 20])
    // A 90-minute table every half hour that still ends by closing: the last seating is 19:30.
    assert.deepEqual(await offered(tuesday), evening('19:30'))
    assert.deepEqual(await offered(monday), [])

    // A party of four holds Tuesday's 19:30 table.
    const booked = await db.prepare('SELECT id FROM product_sessions WHERE product_id = ? AND starts_at = ?').bind(tables.id, localDateTimeToInstant(tuesday, '19:30', ZONE, 'reject').toISOString()).first<{ id: string }>()
    assert(booked)
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, policy_json, status)
      SELECT 'tuesday-party', organization_id, product_id, id, ?, location_id, starts_at, ends_at, timezone, 4, ?, 'confirmed' FROM product_sessions WHERE id = ?`)
      .bind(tables.variants[0]!.id, OPEN_TERMS_JSON, booked.id).run()

    // Staying open until 22:00 adds the 20:00 and 20:30 seatings.
    assert.equal((await updateLocation(db, ORG, LOCATION, { opening_hours: hours(22) }, ACTOR, env)).status, 200)
    assert.deepEqual(await offered(wednesday), evening('20:30'))
    assert.deepEqual(await offered(tuesday), evening('20:30').map(([time, seats]) => [time, time === '19:30' ? 16 : seats]))

    // Special hours opening the closed Monday for lunch seat tables that day, and no other.
    assert.equal((await updateLocation(db, ORG, LOCATION, { special_hours: [{ kind: 'hours', date: monday, periods: [{ open_time: '12:00', close_time: '14:00', close_day_offset: 0 }], note: 'Holiday lunch' }] }, ACTOR, env)).status, 200)
    assert.deepEqual(await offered(monday), [['12:00', 20], ['12:30', 20]])
    assert.deepEqual(await offered(addLocalDays(monday, 7)), [])

    // Closing Tuesday cancels its unbooked seatings; the booked table keeps its time and is no longer offered.
    assert.equal((await updateLocation(db, ORG, LOCATION, { special_hours: [
      { kind: 'hours', date: monday, periods: [{ open_time: '12:00', close_time: '14:00', close_day_offset: 0 }], note: 'Holiday lunch' },
      { kind: 'closure', starts_on: tuesday, ends_on: tuesday, note: 'Private event' },
    ] }, ACTOR, env)).status, 200)
    const onTuesday = (await db.prepare('SELECT starts_at, status FROM product_sessions WHERE product_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at')
      .bind(tables.id, localDateTimeToInstant(tuesday, '00:00', ZONE, 'reject').toISOString(), localDateTimeToInstant(wednesday, '00:00', ZONE, 'reject').toISOString()).all<{ starts_at: string; status: string }>()).results
    assert.deepEqual(onTuesday.map(row => [local(row.starts_at).slice(11), row.status]), evening('20:30').map(([time]) => [time, time === '19:30' ? 'scheduled' : 'cancelled']))
    assert.deepEqual((await db.prepare("SELECT status, party_size FROM bookings WHERE id = 'tuesday-party'").first()), { status: 'confirmed', party_size: 4 })
    assert.deepEqual(await offered(tuesday), [['19:30', 0]])

    // Closing at 21:00 again cancels the late seatings it no longer holds; reopening Tuesday brings its seatings back.
    assert.equal((await updateLocation(db, ORG, LOCATION, { opening_hours: hours(21), special_hours: null }, ACTOR, env)).status, 200)
    assert.deepEqual(await offered(wednesday), evening('19:30'))
    assert.deepEqual(await offered(tuesday), evening('19:30').map(([time, seats]) => [time, time === '19:30' ? 16 : seats]))
    assert.deepEqual(await offered(monday), [])

    // Keep the opening-time cadence through midnight, including a non-hourly phase.
    assert.equal((await updateLocation(db, ORG, LOCATION, { special_hours: [
      { kind: 'hours', date: monday, periods: [{ open_time: '20:15', close_time: '02:15', close_day_offset: 1 }], note: 'Late dinner' },
    ] }, ACTOR, env)).status, 200)
    assert.deepEqual((await offered(tuesday)).filter(([time]) => String(time) < '02:15'), [['00:15', 20], ['00:45', 20]])

    const review = (name: string) => ({
      name: `places/place-id/reviews/${name}`, authorAttribution: { displayName: name }, rating: 5,
      publishTime: '2026-01-01T00:00:00Z',
    })
    const originalFetch = globalThis.fetch
    const closure = { kind: 'closure', starts_on: tuesday, ends_on: tuesday, note: 'Private event' } as const
    let racing = false
    t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      if (!String(args[0]).startsWith('https://places.googleapis.com/')) return originalFetch(...args)
      if (racing) assert.equal((await updateLocation(db, ORG, LOCATION, { special_hours: [closure] }, ACTOR, env)).status, 200)
      return Response.json({
        id: 'place-id', rating: racing ? 1 : 5, timeZone: { id: ZONE }, regularOpeningHours: hours(22),
        reviews: [review(racing ? 'stale-review' : 'current-review')],
      })
    })
    assert.equal((await syncPlaceToLocation(db, 'test-key', ORG, LOCATION, 'place-id', 'import')).reviewsUpserted, 1)
    assert.deepEqual(await offered(wednesday), evening('20:30'))
    racing = true
    await assert.rejects(syncPlaceToLocation(db, 'test-key', ORG, LOCATION, 'place-id', 'import'), { statusCode: 409 })
    assert.deepEqual((await db.prepare('SELECT author_name FROM reviews WHERE organization_id = ? AND location_id = ?').bind(ORG, LOCATION).all()).results, [{ author_name: 'current-review' }])
    assert.deepEqual(await db.prepare('SELECT rating FROM business_locations WHERE id = ?').bind(LOCATION).first(), { rating: 5 })
    assert.deepEqual(await offered(tuesday), [['19:30', 0]])
  } finally {
    await runtime.dispose()
  }
})

test('session materialization is idempotent across cancel, edit and reschedule, and retains assigned session locations', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('member-actor', ?, ?, 'owner')").bind(ORG, ACTOR).run()
    const member = await db.prepare('SELECT id FROM member WHERE organizationId = ? AND userId = ?').bind(ORG, ACTOR).first<{ id: string }>()
    assert(member)
    assert.deepEqual(await listDashboardLocations(db, ORG, ACTOR, true), [], 'an unassigned Product grants no location visibility')
    await setProductBookingConfig(db, { organizationId: ORG, productId: PRODUCT, actorId: ACTOR, env, patch: { assigned_member_id: member.id } })
    assert.equal((await getProduct(db, ORG, PRODUCT)).booking?.assigned_member_id, member.id)
    await addRule(db, 'rule-sunday')
    const throughDate = addLocalDays(localNow('Asia/Bangkok').date, 31)
    const first = await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate, actorId: ACTOR })
    assert(first.created > 0, 'the weekly rule generates sessions')
    assert.equal(first.existing, 0)
    const count = await db.prepare('SELECT count(*) n FROM product_sessions').first<number>('n')

    // Re-running changes nothing.
    const second = await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate, actorId: ACTOR })
    assert.equal(second.created, 0, 'regeneration must not duplicate a session')
    assert.equal(second.existing, first.created)
    assert.equal(await db.prepare('SELECT count(*) n FROM product_sessions').first<number>('n'), count)

    const target = await db.prepare('SELECT id, source_occurrence_key, starts_at FROM product_sessions ORDER BY starts_at LIMIT 1')
      .first<{ id: string; source_occurrence_key: string; starts_at: string }>()
    assert(target)

    // A cancelled occurrence stays cancelled.
    await updateSession(db, { env, organizationId: ORG, sessionId: target.id, actorId: ACTOR, status: 'cancelled' })
    await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate, actorId: ACTOR })
    assert.equal(await db.prepare('SELECT status FROM product_sessions WHERE id = ?').bind(target.id).first<string>('status'), 'cancelled',
      'regeneration must not resurrect a cancelled occurrence')
    assert.equal(await db.prepare('SELECT count(*) n FROM product_sessions').first<number>('n'), count)

    // A rescheduled occurrence is not recreated at its old start.
    const moved = await db.prepare('SELECT id, starts_at, ends_at FROM product_sessions WHERE status = ? ORDER BY starts_at LIMIT 1')
      .bind('scheduled').first<{ id: string; starts_at: string; ends_at: string }>()
    assert(moved)
    const newStart = new Date(Date.parse(moved.starts_at) + 3_600_000).toISOString()
    await updateSession(db, { env, organizationId: ORG, sessionId: moved.id, actorId: ACTOR, startsAt: newStart, endsAt: new Date(Date.parse(moved.ends_at) + 3_600_000).toISOString(), capacity: 4 })
    await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate, actorId: ACTOR })
    const after = await db.prepare('SELECT starts_at, capacity FROM product_sessions WHERE id = ?').bind(moved.id).first<{ starts_at: string; capacity: number }>()
    assert.equal(after?.starts_at, newStart, 'a rescheduled session keeps its new time')
    assert.equal(after?.capacity, 4, 'regeneration must not overwrite an edited capacity')
    assert.equal(await db.prepare('SELECT count(*) n FROM product_sessions').first<number>('n'), count,
      'regeneration must not recreate a rescheduled occurrence under its old start')

    const readScope: Parameters<typeof listSessions>[1] = {
      env, organizationId: ORG, productId: PRODUCT, statuses: ['scheduled', 'cancelled'],
      fromInstant: localDateTimeToInstant(localNow('Asia/Bangkok').date, '00:00', 'Asia/Bangkok').toISOString(),
      toInstant: localDateTimeToInstant(addLocalDays(throughDate, 1), '00:00', 'Asia/Bangkok').toISOString(),
    }
    const sessionsBeforeRemoval = await listSessions(db, readScope)
    assert.equal(sessionsBeforeRemoval.length, count)
    assert(sessionsBeforeRemoval.every(session => session.location_id === LOCATION))
    const assignedLocations = await listDashboardLocations(db, ORG, ACTOR, true)
    assert.deepEqual(assignedLocations.map(location => location.id), [LOCATION])
    const [retainedLocation] = assignedLocations
    assert(retainedLocation)
    assert.equal(retainedLocation.title, 'Studio')
    assert.equal(retainedLocation.timezone, 'Asia/Bangkok')

    await removeProductLocation(db, { organizationId: ORG, productId: PRODUCT, locationId: LOCATION })
    const productAfterRemoval = await getProduct(db, ORG, PRODUCT)
    assert.deepEqual(productAfterRemoval.locations, [])
    assert.equal(productAfterRemoval.booking?.assigned_member_id, member.id)
    assert.deepEqual(await listSessions(db, readScope), sessionsBeforeRemoval, 'removing the Product location preserves each saved occurrence')
    assert.deepEqual(await listDashboardLocations(db, ORG, ACTOR, true), [retainedLocation], 'the assigned host retains the exact historical session location')

    // A bookable offering always has the member who handles it: clearing the host is refused, and nothing changes.
    await assert.rejects(setProductBookingConfig(db, { organizationId: ORG, productId: PRODUCT, actorId: ACTOR, env, patch: { assigned_member_id: null } }),
      (error: unknown) => { const failure = error as { status: number; data: unknown }; assert.equal(failure.status, 422); assert.deepEqual(failure.data, { code: 'ASSIGNEE_REQUIRED', field: 'assigned_member_id' }); return true })
    assert.equal((await getProduct(db, ORG, PRODUCT)).booking?.assigned_member_id, member.id)
    assert.deepEqual((await listSessions(db, readScope)).map(session => session.id), sessionsBeforeRemoval.map(session => session.id))

    // A booking-only replacement owns real child writes and must advance the
    // Product CAS token even when its descriptive fields are unchanged.
    await db.prepare("INSERT INTO prices (id,organization_id,product_variant_id,unit_amount,currency,type,created_by,updated_by) SELECT 'free-'||id,organization_id,id,0,'THB','one_time',?,? FROM product_variants WHERE organization_id=? AND product_id=?")
      .bind(ACTOR, ACTOR, ORG, PRODUCT).run()
    await db.prepare("INSERT INTO member_scheduling (member_id, organization_id, public_name, public_approved, updated_at, updated_by) VALUES (?,?,'Published host',1,?,?)")
      .bind(member.id, ORG, NOW, ACTOR).run()
    const beforeBooking = await getProduct(db, ORG, PRODUCT)
    const bookingReplacement = { organizationId: ORG, productId: PRODUCT, actor: { actorId: ACTOR }, env, patch: {}, idempotencyKey: 'booking-only-replacement',
      booking: { env, data: { location_id: LOCATION, duration_minutes: 45, default_capacity: 6, assigned_member_id: member.id, online_payment_required: false,
        weekly_slots: [{ weekday: 0, start_time: '14:00' }] } } }
    await updateProduct(db, bookingReplacement)
    const afterBooking = await getProduct(db, ORG, PRODUCT)
    assert.equal(afterBooking.name, beforeBooking.name)
    assert.notEqual(afterBooking.updated_at, beforeBooking.updated_at)
    assert.equal(await db.prepare('SELECT updated_at FROM products WHERE organization_id=? AND id=?').bind(ORG, PRODUCT).first('updated_at'), afterBooking.updated_at)
    assert.equal(afterBooking.booking?.duration_minutes, 45)
    const receipt = JSON.parse((await db.prepare("SELECT payload_json FROM activity_entries WHERE dedupe_key=?").bind(`product-update:${ORG}:${PRODUCT}:booking-only-replacement`).first<string>('payload_json'))!)
    assert.deepEqual(receipt.metadata.changed_fields, ['booking'])
    assert.equal(receipt.afterState.updated_at, afterBooking.updated_at)
    await updateProduct(db, bookingReplacement)
    assert.equal((await getProduct(db, ORG, PRODUCT)).updated_at, afterBooking.updated_at, 'the keyed booking replay keeps the committed Product revision')
    await assert.rejects(updateProduct(db, { ...bookingReplacement, idempotencyKey: 'stale-booking-replacement', patch: { updated_at: beforeBooking.updated_at } }),
      { statusCode: 409, data: { code: 'PRODUCT_UPDATE_CONFLICT', field: 'updated_at', product_id: PRODUCT } })
  } finally { await runtime.dispose() }
})

test('DST gaps and folds are reported, never silently resolved', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    // Generation is bounded to a year ahead, so the transition dates are found
    // inside that window rather than hardcoded — the test stays true as time
    // passes instead of expiring on a fixed date.
    // One window for both the search and the generation: searching a day
    // further than sessions are generated could find a transition the run never
    // reached, depending on the date the suite happened to run.
    const WINDOW_DAYS = 359
    const findSunday = (zone: string, time: string): string | null => {
      const today = localNow(zone).date
      for (let offset = 1; offset <= WINDOW_DAYS; offset += 1) {
        const date = addLocalDays(today, offset)
        if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) continue
        try { localDateTimeToInstant(date, time, zone, 'reject') }
        catch (error) { if (error instanceof RangeError) return date; throw error }
      }
      return null
    }
    // A zone's next transition can be 371 days after its last, so for some days
    // after each one no single zone has both inside the window. Los Angeles
    // skips its 02:xx hour and repeats 01:xx; Lord Howe skips 02:00–02:29 in
    // October and repeats 01:30–01:59 in April, so the two are never both out
    // of reach at once, and on each zone's transition days the other rule's
    // time still exists.
    const candidates = [
      { zone: 'America/Los_Angeles', gapTime: '02:30', foldTime: '01:30' },
      { zone: 'Australia/Lord_Howe', gapTime: '02:15', foldTime: '01:45' },
    ].map(candidate => ({ ...candidate, gapDate: findSunday(candidate.zone, candidate.gapTime), foldDate: findSunday(candidate.zone, candidate.foldTime) }))
    const chosen = candidates.find(candidate => candidate.gapDate && candidate.foldDate)
    assert(chosen, `a spring-forward and a fall-back Sunday exist within the generation window: ${JSON.stringify(candidates)}`)
    const { zone, gapTime, foldTime } = chosen
    const gapDate = chosen.gapDate!
    const foldDate = chosen.foldDate!

    // A rule is at a location, in that location's clock.
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at) VALUES ('loc-la', ?, 'la', 'Los Angeles', 'active', ?, ?, ?)`).bind(ORG, zone, NOW, NOW).run()
    await addRule(db, 'rule-gap', { timezone: zone, weekday: 0, start_time: gapTime, location_id: 'loc-la' })
    await addRule(db, 'rule-fold', { timezone: zone, weekday: 0, start_time: foldTime, location_id: 'loc-la' })
    const result = await materializeSessions(db, {
      organizationId: ORG, productId: PRODUCT, throughDate: addLocalDays(localNow(zone).date, WINDOW_DAYS), actorId: ACTOR,
    })

    const gap = result.skipped.find(entry => entry.local_date === gapDate && entry.local_start_time === gapTime)
    assert(gap, `the spring-forward occurrence on ${gapDate} is reported`)
    assert.equal(gap.reason, 'nonexistent_local_time')
    const fold = result.skipped.find(entry => entry.local_date === foldDate && entry.local_start_time === foldTime)
    assert(fold, `the fall-back occurrence on ${foldDate} is reported`)
    assert.equal(fold.reason, 'ambiguous_local_time')

    const rows = await db.prepare('SELECT starts_at FROM product_sessions ORDER BY starts_at').all<{ starts_at: string }>()
    assert(rows.results.length > 0, 'the surrounding Sundays still generate')
    const localDay = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))
    const localTime = (instant: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant))
    // The other rule still runs on each transition date — the fold time exists
    // on the spring-forward day and the gap time exists on the fall-back day.
    // Only the impossible and the doubled occurrence are absent, and neither
    // was quietly shifted to a neighbouring hour.
    assert.equal(rows.results.some(row => localDay(row.starts_at) === gapDate && localTime(row.starts_at) === gapTime), false, `the impossible ${gapTime} occurrence does not exist`)
    assert.equal(rows.results.some(row => localDay(row.starts_at) === foldDate && localTime(row.starts_at) === foldTime), false, `the doubled ${foldTime} occurrence does not exist`)
    assert.equal(rows.results.filter(row => localDay(row.starts_at) === gapDate).length, 1, `the gap date keeps only its ${foldTime} session`)
    assert.equal(rows.results.filter(row => localDay(row.starts_at) === foldDate).length, 1, `the fold date keeps only its ${gapTime} session`)

    // Local wall time is stable across the offset change: this is the whole
    // reason recurrence is stored as wall time plus a zone, not as an offset.
    const locals = new Set(rows.results.map(row => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.starts_at))))
    assert.deepEqual([...locals].sort(), [foldTime, gapTime].sort())
  } finally { await runtime.dispose() }
})

test('concurrent claims cannot exceed capacity, and variants share one pool', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('sess-1', ?, ?, ?, 'Asia/Bangkok', '2099-01-05T07:00:00.000Z', '2099-01-05T09:00:00.000Z', 5, 'scheduled', ?, ?)`)
      .bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()

    // Two ticket tiers, one seat pool: 3 adults + 2 children fills the class.
    await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-adult', partySize: 3 })
    await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-child', partySize: 2 })
    await assert.rejects(
      claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-adult', partySize: 1 }),
      CapacityUnavailableError,
      'a ticket tier does not get its own seat pool',
    )

    // Concurrency: eight parties of one race for three seats.
    await db.prepare("UPDATE product_sessions SET capacity = 8 WHERE id = 'sess-1'").run()
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
      claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-adult', partySize: 1 })))
    const granted = outcomes.filter(outcome => outcome.status === 'fulfilled').length
    assert.equal(granted, 3, `exactly the three remaining seats were granted, got ${granted}`)
    const claimed = await db.prepare("SELECT SUM(party_size) n FROM bookings WHERE product_session_id = 'sess-1' AND status = 'confirmed'").first<number>('n')
    assert.equal(claimed, 8, 'claims never exceed capacity')

    // Cancelling releases exactly that booking's seats.
    const one = await db.prepare("SELECT id FROM bookings WHERE party_size = 3 LIMIT 1").first<string>('id')
    assert(one)
    await setBookingStatus(db, { organizationId: ORG, bookingId: one, status: 'cancelled', reason: 'guest cancelled' })
    const afterCancel = await db.prepare("SELECT SUM(party_size) n FROM bookings WHERE product_session_id = 'sess-1' AND status = 'confirmed'").first<number>('n')
    assert.equal(afterCancel, 5, 'cancellation released exactly three seats')
    const [session] = await listSessions(db, { env, organizationId: ORG, productId: PRODUCT, fromInstant: '2099-01-01T00:00:00.000Z', toInstant: '2099-02-01T00:00:00.000Z' })
    assert.equal(session?.remaining, 3)
    assert.equal(session?.is_full, false)
  } finally { await runtime.dispose() }
})

test('capacity cannot be reduced below seats already claimed, and a past session cannot be booked', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('sess-cap', ?, ?, ?, 'Asia/Bangkok', '2099-01-05T07:00:00.000Z', '2099-01-05T09:00:00.000Z', 10, 'scheduled', ?, ?)`)
      .bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()
    await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-cap', productVariantId: 'var-adult', partySize: 6 })
    await assert.rejects(
      updateSession(db, { env, organizationId: ORG, sessionId: 'sess-cap', actorId: ACTOR, capacity: 4 }),
      /already has 6 seats claimed/, 'reducing capacity below claimed seats is refused, not silently oversold')
    await updateSession(db, { env, organizationId: ORG, sessionId: 'sess-cap', actorId: ACTOR, capacity: 6 })

    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('sess-past', ?, ?, ?, 'Asia/Bangkok', '2020-01-05T07:00:00.000Z', '2020-01-05T09:00:00.000Z', 10, 'scheduled', ?, ?)`)
      .bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()
    await assert.rejects(
      claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-past', productVariantId: 'var-adult', partySize: 1 }),
      CapacityUnavailableError, 'a session in the past takes no bookings')

    await db.prepare("UPDATE product_sessions SET status = 'cancelled' WHERE id = 'sess-cap'").run()
    await assert.rejects(
      claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'sess-cap', productVariantId: 'var-adult', partySize: 1 }),
      CapacityUnavailableError, 'a cancelled session takes no bookings')
  } finally { await runtime.dispose() }
})

test('the occurrence key is the intended local start, not the actual instant', () => {
  assert.equal(occurrenceKey('rule-1', '2026-10-04', '14:00'), 'rule-1:2026-10-04T14:00')
})


test('required online collection needs Payments setup as well as entitlement, while disabling remains available', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR }
  const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', STRIPE_PAYMENTS_METHOD_CONFIGURATION: 'pmc_local_proof', NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_local_proof', BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test' } as CloudflareEnv
  try {
    const before = await db.prepare('SELECT online_payment_required, updated_at FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first()
    const invalidations = await db.prepare('SELECT COUNT(*) FROM public_resource_cache_invalidations').first('COUNT(*)')
    await assert.rejects(() => setProductBookingConfig(db, { ...scope, patch: { online_payment_required: true } }), { statusCode: 403 })
    await assert.rejects(() => setProductBookingConfig(db, { ...scope, env, patch: { online_payment_required: true } }), { statusCode: 403 })
    await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,periodEnd) VALUES('booking-entitlement','growth',?,'active',4070908800)").bind(ORG).run()
    await assert.rejects(() => setProductBookingConfig(db, { ...scope, env, patch: { online_payment_required: true } }), { statusCode: 403 })
    await db.prepare("UPDATE subscription SET plan='commerce',status='past_due' WHERE id='booking-entitlement'").run()
    await assert.rejects(() => setProductBookingConfig(db, { ...scope, env, patch: { online_payment_required: true } }), { statusCode: 403 })
    assert.deepEqual(await db.prepare('SELECT online_payment_required, updated_at FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first(), before)
    assert.equal(await db.prepare('SELECT COUNT(*) FROM public_resource_cache_invalidations').first('COUNT(*)'), invalidations)

    await db.prepare("UPDATE subscription SET status='active' WHERE id='booking-entitlement'").run()
    await assert.rejects(() => setProductBookingConfig(db, { ...scope, env, patch: { online_payment_required: true } }), { statusCode: 409 })
    assert.deepEqual(await db.prepare('SELECT online_payment_required, updated_at FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first(), before)
    // A saved policy from before a downgrade can still be disabled.
    await db.prepare('UPDATE product_booking_configs SET online_payment_required=1 WHERE product_id=?').bind(PRODUCT).run()
    await db.prepare("UPDATE subscription SET status='canceled' WHERE id='booking-entitlement'").run()
    await setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 60 } })
    assert.equal(await db.prepare('SELECT online_payment_required FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first('online_payment_required'), 1, 'other settings preserve the saved policy after downgrade')
    await setProductBookingConfig(db, { ...scope, env, patch: { online_payment_required: false } })
    assert.equal(await db.prepare('SELECT online_payment_required FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first('online_payment_required'), 0)
    await setProductBookingConfig(db, { ...scope, patch: { online_payment_required: false } })
    assert.equal(await db.prepare('SELECT online_payment_required FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first('online_payment_required'), 0)
  } finally { await runtime.dispose() }
})

test('shared booking defaults retain omissions, zero and null; all history blocks removal', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR, env, policyJson: OPEN_TERMS_JSON }
  try {
    await setProductBookingConfig(db, { ...scope, patch: { default_capacity: 0 } })
    assert.deepEqual(await db.prepare('SELECT duration_minutes, default_capacity FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first(), { duration_minutes: 120, default_capacity: 0 })
    await assert.rejects(setProductBookingConfig(db, { ...scope, patch: { duration_minutes: null } }), /Keep a session duration/)
    await db.prepare('UPDATE product_publications SET published=0 WHERE product_id=?').bind(PRODUCT).run()
    await setProductBookingConfig(db, { ...scope, patch: { duration_minutes: null } })
    assert.deepEqual(await db.prepare('SELECT duration_minutes, default_capacity FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first(), { duration_minutes: null, default_capacity: 0 })
    await assert.rejects(setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 0 } }), /duration_minutes/)
    await assert.rejects(setProductBookingConfig(db, { ...scope, organizationId: 'other-org', patch: { default_capacity: 99 } }), /not found/i)
    await setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 60, default_capacity: null } })
    const scheduled = await replaceWeeklySchedule(db, { ...scope, locationId: LOCATION, slots: [{ weekday: 1, start_time: '10:00' }] })
    assert(scheduled.sessions.created > 0)
    const session = await db.prepare("SELECT id FROM product_sessions WHERE starts_at > ? AND status = 'scheduled' ORDER BY starts_at LIMIT 1").bind(new Date().toISOString()).first<string>('id')
    assert(session)
    const booking = await claimSessionCapacity(db, { ...scope, sessionId: session, productVariantId: 'var-adult', partySize: 1 })
    await setBookingStatus(db, { organizationId: ORG, bookingId: booking.bookingId, status: 'cancelled' })
    await assert.rejects(deleteProductBookingConfig(db, scope), /has bookings/)
    assert.equal(await db.prepare('SELECT default_capacity FROM product_booking_configs WHERE product_id = ?').bind(PRODUCT).first('default_capacity'), null)
    assert.equal(await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(booking.bookingId).first('status'), 'cancelled')
  } finally { await runtime.dispose() }
})

test('weekly replacement uses saved timezone, converges and preserves booked occurrences on clear', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR, env, policyJson: OPEN_TERMS_JSON }
  const slots = [{ weekday: 0, start_time: '14:00' }, { weekday: 1, start_time: '10:00' }]
  try {
    await assert.rejects(replaceWeeklySchedule(db, { ...scope, timezone: 'UTC', slots }), /timezone must match/)
    await assert.rejects(replaceWeeklySchedule(db, { ...scope, slots: [{ weekday: 0, start_time: '14:00', capacity: null }] }), /slots support weekday and start_time; set duration and capacity on the product/)
    await assert.rejects(replaceWeeklySchedule(db, { ...scope, locationId: 'foreign-location', slots }), /Location not found/)
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('other-studio', ?, 'other-studio', 'Other studio', 'active', 'Asia/Bangkok', ?, ?)`).bind(ORG, NOW, NOW).run()
    await addRule(db, 'other-location-rule', { location_id: 'other-studio', weekday: 3, start_time: '12:00' })
    await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate: addLocalDays(localNow('Asia/Bangkok').date, 31), actorId: ACTOR })
    const first = await replaceWeeklySchedule(db, { ...scope, slots })
    assert(first.sessions.created > 0)
    assert(first.rules.every(rule => rule.timezone === 'Asia/Bangkok'))
    const before = (await db.prepare('SELECT id, starts_at, ends_at, capacity FROM product_sessions ORDER BY id').all()).results
    const monday = await db.prepare('SELECT id FROM product_sessions WHERE capacity = 10 AND location_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 1').bind(LOCATION, new Date().toISOString()).first<string>('id')
    assert(monday)
    const booked = await claimSessionCapacity(db, { ...scope, sessionId: monday, productVariantId: 'var-adult', partySize: 1 })
    const repeated = await replaceWeeklySchedule(db, { ...scope, slots })
    assert.equal(repeated.sessions.created, 0)
    assert.deepEqual(repeated.rules.map(rule => rule.id).sort(), first.rules.map(rule => rule.id).sort())
    assert.deepEqual((await db.prepare('SELECT id, starts_at, ends_at, capacity FROM product_sessions ORDER BY id').all()).results, before)
    const otherSessions = (await db.prepare("SELECT id, status FROM product_sessions WHERE location_id = 'other-studio' ORDER BY id").all()).results
    assert(otherSessions.length > 0)
    const cleared = await replaceWeeklySchedule(db, { ...scope, slots: [] })
    assert.deepEqual(cleared.rules, [])
    assert.equal(await db.prepare("SELECT id FROM product_availability_rules WHERE location_id = 'other-studio'").first('id'), 'other-location-rule')
    assert.deepEqual((await db.prepare("SELECT id, status FROM product_sessions WHERE location_id = 'other-studio' ORDER BY id").all()).results, otherSessions)
    assert(cleared.cancelled > 0)
    assert.deepEqual(await db.prepare('SELECT status, availability_rule_id FROM product_sessions WHERE id = ?').bind(monday).first(), { status: 'scheduled', availability_rule_id: null })
    assert.deepEqual(await db.prepare('SELECT status, product_session_id FROM bookings WHERE id = ?').bind(booked.bookingId).first(), { status: 'confirmed', product_session_id: monday })
    // A published experience retains the duration needed for its other scope.
    await assert.rejects(setProductBookingConfig(db, { ...scope, patch: { duration_minutes: null } }), /Keep a session duration/)
    assert.equal(await db.prepare('SELECT duration_minutes FROM product_booking_configs WHERE product_id=?').bind(PRODUCT).first('duration_minutes'),120)
    assert.deepEqual((await replaceWeeklySchedule(db, { ...scope, slots: [] })).rules, [])
  } finally { await runtime.dispose() }
})

test('readding a weekly slot preserves every fact of sessions with booking history', { timeout: 120_000 }, async () => {
  for (const scenario of ['active', 'cancelled-booking', 'cancelled-session', 'edited', 'moved'] as const) {
    const { runtime, db, env } = await boot()
    const scope = { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR, env, policyJson: OPEN_TERMS_JSON }
    const slots = [{ weekday: 0, start_time: '14:00' }]
    try {
      await replaceWeeklySchedule(db, { ...scope, slots })
      const sessionId = await db.prepare('SELECT id FROM product_sessions WHERE starts_at > ? ORDER BY starts_at LIMIT 1').bind(new Date().toISOString()).first<string>('id')
      assert(sessionId)
      const booking = await claimSessionCapacity(db, { ...scope, sessionId, productVariantId: 'var-adult', partySize: 6 })
      if (scenario === 'cancelled-booking' || scenario === 'cancelled-session' || scenario === 'moved') await setBookingStatus(db, { organizationId: ORG, bookingId: booking.bookingId, status: 'cancelled' })
      if (scenario === 'cancelled-session') await updateSession(db, { ...scope, sessionId, status: 'cancelled' })
      if (scenario === 'edited') await updateSession(db, { ...scope, sessionId, capacity: 8 })
      if (scenario === 'moved') {
        const row = await db.prepare('SELECT starts_at, ends_at FROM product_sessions WHERE id = ?').bind(sessionId).first<{ starts_at: string; ends_at: string }>()
        assert(row)
        await updateSession(db, { ...scope, sessionId, startsAt: new Date(Date.parse(row.starts_at) + 3_600_000).toISOString(), endsAt: new Date(Date.parse(row.ends_at) + 3_600_000).toISOString() })
      }
      const read = () => db.prepare('SELECT id, source_occurrence_key, timezone, starts_at, ends_at, capacity, status FROM product_sessions WHERE id = ?').bind(sessionId).first()
      const before = await read()
      const bookingBefore = await db.prepare('SELECT id, product_session_id, status, party_size FROM bookings WHERE id = ?').bind(booking.bookingId).first()
      await replaceWeeklySchedule(db, { ...scope, slots: [] })
      await setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 30, default_capacity: 2 } })
      await replaceWeeklySchedule(db, { ...scope, slots })
      assert.deepEqual(await read(), before, `${scenario}: adoption must preserve booked actual facts and generation identity`)
      assert.deepEqual(await db.prepare('SELECT id, product_session_id, status, party_size FROM bookings WHERE id = ?').bind(booking.bookingId).first(), bookingBefore)
      await replaceWeeklySchedule(db, { ...scope, slots })
      assert.deepEqual(await read(), before, `${scenario}: normal replay also preserves history`)
    } finally { await runtime.dispose() }
  }
})


test('unbooked re-add retains the existing cancellation and default-refresh behavior', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR }
  const slots = [{ weekday: 0, start_time: '14:00' }]
  try {
    await replaceWeeklySchedule(db, { ...scope, slots })
    const first = await db.prepare('SELECT id, starts_at FROM product_sessions WHERE starts_at > ? ORDER BY starts_at LIMIT 1').bind(new Date().toISOString()).first<{ id: string; starts_at: string }>()
    assert(first)
    await replaceWeeklySchedule(db, { ...scope, slots: [] })
    assert.equal(await db.prepare('SELECT status FROM product_sessions WHERE id = ?').bind(first.id).first('status'), 'cancelled')
    await setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 30, default_capacity: 2 } })
    await replaceWeeklySchedule(db, { ...scope, slots })
    assert.deepEqual(await db.prepare('SELECT id, starts_at, ends_at, capacity, status FROM product_sessions WHERE id = ?').bind(first.id).first(), {
      id: first.id, starts_at: first.starts_at, ends_at: new Date(Date.parse(first.starts_at) + 30 * 60_000).toISOString(), capacity: 2, status: 'scheduled',
    })
  } finally { await runtime.dispose() }
})

test('re-adoption protects cancelled history and a claim racing its atomic write', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR, env, policyJson: OPEN_TERMS_JSON }
  try {
    await addRule(db, 'neutral-old')
    const throughDate = addLocalDays(localNow('Asia/Bangkok').date, 31)
    await materializeSessions(db, { ...scope, throughDate })
    const rows = (await db.prepare('SELECT id FROM product_sessions WHERE location_id = ? AND starts_at > ? ORDER BY starts_at').bind(LOCATION, new Date().toISOString()).all<{ id: string }>()).results
    assert(rows.length >= 2)
    const protectedId = rows[0]!.id
    const racingId = rows[1]!.id
    const booking = await claimSessionCapacity(db, { ...scope, sessionId: protectedId, productVariantId: 'var-adult', partySize: 6 })
    await setBookingStatus(db, { organizationId: ORG, bookingId: booking.bookingId, status: 'cancelled' })
    await updateSession(db, { ...scope, sessionId: protectedId, status: 'cancelled' })
    const read = (id: string) => db.prepare('SELECT id, source_occurrence_key, starts_at, ends_at, timezone, capacity, status FROM product_sessions WHERE id = ?').bind(id).first()
    const protectedBefore = await read(protectedId)
    const raceBefore = await read(racingId)
    await db.batch([
      db.prepare("UPDATE product_sessions SET availability_rule_id = NULL WHERE availability_rule_id = 'neutral-old'"),
      db.prepare("DELETE FROM product_availability_rules WHERE id = 'neutral-old'"),
    ])
    await setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 30, default_capacity: 2 } })
    await addRule(db, 'neutral-new')
    const [claim, generation] = await Promise.allSettled([
      claimSessionCapacity(db, { ...scope, sessionId: racingId, productVariantId: 'var-adult', partySize: 6 }),
      materializeSessions(db, { ...scope, throughDate }),
    ])
    assert.equal(generation.status, 'fulfilled')
    assert.deepEqual(await read(protectedId), protectedBefore)
    if (claim.status === 'fulfilled') assert.deepEqual(await read(racingId), raceBefore, 'the committed claim protects all session facts')
    else {
      assert(claim.reason instanceof CapacityUnavailableError)
      assert.equal((await read(racingId))?.capacity, 2, 'adoption won and the larger claim was refused')
    }
    const invalid = await db.prepare("SELECT count(*) n FROM product_sessions s WHERE s.capacity IS NOT NULL AND s.capacity < (SELECT COALESCE(SUM(b.party_size),0) FROM bookings b WHERE b.product_session_id=s.id AND b.status='confirmed')").first('n')
    assert.equal(invalid, 0)
    assert.equal(await db.prepare('SELECT product_session_id FROM bookings WHERE id = ?').bind(booking.bookingId).first('product_session_id'), protectedId)
  } finally { await runtime.dispose() }
})

// Named invariants: one provider's online offerings exclude each other's overlapping
// pending requests; confirmation/rejection and replay never allocate a second seat.
test('one provider\'s online offerings exclude overlapping pending requests and review retries release once', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    // Two providers whose hours cover the day; each holds their own online offerings.
    for (const provider of ['provider-x', 'provider-y']) {
      await db.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)").bind(`${provider}-user`, provider, `${provider}@example.com`).run()
      await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES (?, ?, ?, 'member')").bind(provider, ORG, `${provider}-user`).run()
      await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, updated_at, updated_by) VALUES (?, ?, 'America/New_York', '[{"weekday":0,"start":"00:00","end":"23:59"},{"weekday":1,"start":"00:00","end":"23:59"},{"weekday":2,"start":"00:00","end":"23:59"},{"weekday":3,"start":"00:00","end":"23:59"},{"weekday":4,"start":"00:00","end":"23:59"},{"weekday":5,"start":"00:00","end":"23:59"},{"weekday":6,"start":"00:00","end":"23:59"}]', '[]', ?, ?)`).bind(provider, ORG, NOW, ACTOR).run()
    }
    await db.prepare("UPDATE product_booking_configs SET confirmation_mode = 'review', held_online = 1, scheduling_mode = 'provider', assigned_member_id = 'provider-x' WHERE product_id = ?").bind(PRODUCT).run()
    for (const [productId, variantId, provider] of [['prod-consult', 'var-consult', 'provider-x'], ['prod-independent', 'var-independent', 'provider-y']]) {
      await db.prepare(`INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('experience', ?, ?, ?, ?, ?, ?)`).bind(productId, ORG, productId, productId, ACTOR, ACTOR).run()
      await db.prepare('INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)').bind(variantId, ORG, productId, variantId, ACTOR, ACTOR).run()
      await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, confirmation_mode, held_online, scheduling_mode, assigned_member_id, created_by, updated_by) VALUES (?, ?, 'slot', 45, 1, 'review', 1, 'provider', ?, ?, ?)").bind(productId, ORG, provider, ACTOR, ACTOR).run()
    }
    for (const [id, productId, start, end] of [
      ['session-one', PRODUCT, '2098-11-02T15:00:00.000Z', '2098-11-02T16:15:00.000Z'],
      ['session-two', 'prod-consult', '2098-11-02T15:30:00.000Z', '2098-11-02T16:15:00.000Z'],
      ['session-adjacent', 'prod-consult', '2098-11-02T16:15:00.000Z', '2098-11-02T17:00:00.000Z'],
      ['session-independent', 'prod-independent', '2098-11-02T15:30:00.000Z', '2098-11-02T16:15:00.000Z'],
    ]) await db.prepare("INSERT INTO product_sessions (id, organization_id, product_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by) VALUES (?, ?, ?, 'America/New_York', ?, ?, 1, 'scheduled', ?, ?)").bind(id, ORG, productId, start, end, ACTOR, ACTOR).run()
    for (const id of ['thread-one', 'thread-two']) {
      const queries = requestInsertQueries({ id, kind: 'booking', organization_id: ORG, location_id: null, user_id: null, booking_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW })
      await db.batch(queries.map(query => db.prepare(query.query).bind(...query.params!)))
    }
    const inputs = [
      { env, policyJson: OPEN_TERMS_JSON, organizationId: ORG, productId: PRODUCT, sessionId: 'session-one', productVariantId: 'var-adult', partySize: 1, requestId: 'thread-one' },
      { env, policyJson: OPEN_TERMS_JSON, organizationId: ORG, productId: 'prod-consult', sessionId: 'session-two', productVariantId: 'var-consult', partySize: 1, requestId: 'thread-two' },
    ]
    // Each conversation names the booking its claim made, as a paid checkout's does.
    const claim = async ({ requestId, ...input }: typeof inputs[number]) => nameConversationBooking(db, requestId, (await claimSessionCapacity(db, input)).bookingId)
    const raced = await Promise.allSettled(inputs.map(claim))
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
    const index = raced.findIndex(result => result.status === 'fulfilled')
    const winner = inputs[index]!
    const record = await getThreadOperationalRecord(db, winner.requestId)
    assert.equal(record?.status, 'pending')
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'), 1)
    const listed = await listSessions(db, { env, organizationId: ORG, fromInstant: '2098-11-02T00:00:00.000Z', toInstant: '2098-11-03T00:00:00.000Z' })
    assert.equal(listed.find(session => session.id === inputs[1 - index]!.sessionId)?.is_full, true)
    assert.equal(listed.find(session => session.id === 'session-adjacent')?.remaining, 1)
    assert.equal(listed.find(session => session.id === 'session-independent')?.remaining, 1)
    const confirm = { threadId: winner.requestId, organizationId: ORG, action: 'confirm', actorUserId: ACTOR, idempotencyKey: 'confirm-once', env: { ...env, NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only' } }
    assert.equal((await executeGuestThreadOperation(db, confirm)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, confirm)).ok, true)
    assert.equal((await getThreadOperationalRecord(db, winner.requestId))?.status, 'confirmed')
    assert.deepEqual(await openReplies(db, winner.requestId), [], 'a delivered decision leaves no reply owed on the booking')
    const guestReply = await appendMessage(db, { conversationId: winner.requestId, authorKind: 'guest', authorUserId: null, channel: 'web', body: 'One more question', dedupeKey: 'question-after-confirmation' },
      conversationTaskQueries(winner.requestId, new Date().toISOString()))
    assert.equal((await executeGuestThreadOperation(db, confirm)).ok, true)
    assert.deepEqual(await openReplies(db, winner.requestId), [`guest_reply:${winner.requestId}:${guestReply.id}`], 'replaying an older decision does not answer a new guest message')
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'), 1)
    const moved = await sessionMoveQuery(db, { env, bookingId: record!.id, organizationId: ORG, fromProductId: winner.productId, productId: winner.productId, productVariantId: winner.productVariantId, sessionId: winner.sessionId, partySize: 1, now: new Date().toISOString() })
    assert.equal((await db.prepare(moved.query).bind(...moved.params!).run()).meta.changes, 1, 'same-session changes exclude the allocation being moved')
    assert.equal((await getThreadOperationalRecord(db, winner.requestId))?.id, record!.id)
    assert.equal((await getThreadOperationalRecord(db, winner.requestId))?.status, 'confirmed')
    const cancel = { ...confirm, action: 'cancel', idempotencyKey: 'cancel-once' }
    assert.equal((await executeGuestThreadOperation(db, cancel)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, cancel)).ok, true)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM messages WHERE event_name = 'booking.cancel'").first('n'), 1)
    const loser = inputs[1 - index]!
    // A booking conversation without its own allocation is invalid. Neither
    // a status transition nor a reply can manufacture its missing record.
    const missingRecord = { statusCode: 404, message: 'The conversation has no matching booking', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: loser.requestId } }
    await assert.rejects(executeGuestThreadOperation(db, { ...confirm, threadId: loser.requestId }), missingRecord)
    const reply = { ...confirm, threadId: loser.requestId, action: 'reply', body: 'We can help with your booking.', idempotencyKey: 'before-allocation' }
    await assert.rejects(executeGuestThreadOperation(db, reply), missingRecord)
    assert.equal(await db.prepare('SELECT status FROM guest_thread_deliveries WHERE id = ?').bind(`guest-thread-email:${loser.requestId}:before-allocation`).first('status'), null)
    await claim(loser)
    const reject = { ...confirm, threadId: loser.requestId, action: 'reject', idempotencyKey: 'reject-once' }
    assert.equal((await executeGuestThreadOperation(db, reject)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, reject)).ok, true)
    assert.equal((await getThreadOperationalRecord(db, loser.requestId))?.status, 'cancelled')
    const after = await listSessions(db, { env, organizationId: ORG, fromInstant: '2098-11-02T00:00:00.000Z', toInstant: '2098-11-03T00:00:00.000Z' })
    assert.equal(after.find(session => session.id === 'session-one')?.remaining, 1)
    assert.equal(after.find(session => session.id === 'session-two')?.remaining, 1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM messages WHERE event_name = 'booking.confirm'").first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM messages WHERE event_name = 'booking.reject'").first('n'), 1)
    // A delivered receipt proves that an earlier operation finished, not that
    // its required booking still exists when that operation is replayed.
    await db.batch([db.prepare('UPDATE conversations SET booking_id = NULL WHERE booking_id = ?').bind(record!.id), db.prepare('DELETE FROM bookings WHERE id = ?').bind(record!.id)])
    await assert.rejects(executeGuestThreadOperation(db, cancel), { statusCode: 404, message: 'The conversation has no matching booking', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: winner.requestId } })

    const questionRequest = 'thread-question-before-confirmation'
    await db.batch(requestInsertQueries({ id: questionRequest, kind: 'booking', organization_id: ORG, location_id: null, user_id: null, booking_id: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW }).map(query => db.prepare(query.query).bind(...query.params!)))
    await claim({ ...winner, requestId: questionRequest })
    const question = await appendMessage(db, { conversationId: questionRequest, authorKind: 'guest', authorUserId: null, channel: 'web', body: 'Can I bring my notes?', dedupeKey: 'question-before-confirmation' },
      conversationTaskQueries(questionRequest, new Date().toISOString()))
    assert.equal((await executeGuestThreadOperation(db, { ...confirm, threadId: questionRequest })).ok, true)
    assert.equal((await getThreadOperationalRecord(db, questionRequest))?.status, 'confirmed')
    assert.deepEqual(await openReplies(db, questionRequest), [`guest_reply:${questionRequest}:${question.id}`], 'confirming a booking does not answer a separate guest message')
  } finally { await runtime.dispose() }
})

test('provider allocation shares a class Session, excludes distinct overlapping services, and preserves assigned identities after hours/config edits', {timeout:120_000}, async()=>{
 const {runtime,db,env}=await boot()
 try {
  const {publicProductHosts}=await import('../../server/utils/public-provider.ts')
  const day=addLocalDays(localNow('UTC').date,3), start=`${day}T09:00:00.000Z`, end=`${day}T10:00:00.000Z`
  await db.prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES ('provider-user','Private account name','private-provider@example.com',1,1,1)`).run()
  await db.prepare(`INSERT INTO member(id,organizationId,userId,role) VALUES ('provider-one',?,'provider-user','member')`).bind(ORG).run()
  const weekly=Array.from({length:7},(_,weekday)=>({weekday,start:'08:00',end:'18:00'}))
  await db.prepare(`INSERT INTO member_scheduling(member_id, organization_id, timezone, weekly_json, time_off_json, public_name, public_bio, public_approved, updated_at, updated_by) VALUES ('provider-one',?,'UTC',?,'[]', 'Approved public name','Approved public bio',1,?,?)`).bind(ORG,JSON.stringify(weekly),NOW,ACTOR).run()
  await db.prepare("UPDATE product_booking_configs SET scheduling_mode='provider',assigned_member_id='provider-one' WHERE product_id=?").bind(PRODUCT).run()
  const second='second-service'
  await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('service',?,?,'Other service','other-service',?,?)").bind(second,ORG,ACTOR,ACTOR).run()
  await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,scheduling_mode,assigned_member_id,duration_minutes,default_capacity,created_by,updated_by)VALUES(?,?,'slot','provider','provider-one',60,3,?,?)").bind(second,ORG,ACTOR,ACTOR).run()
  await db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_by,updated_by)VALUES(?,?,?,1,1,?,?)").bind(ORG,second,LOCATION,ACTOR,ACTOR).run()
  await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by)VALUES('second-variant',?,?,'Standard',?,?)").bind(ORG,second,ACTOR,ACTOR).run()
  // One provider in one place: their two services at the studio cannot overlap.
  for(const [id,product]of [['group-session',PRODUCT],['other-session',second]])await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES(?,?,?,?,'UTC',?,?,3,?,?)").bind(id,ORG,product,LOCATION,start,end,ACTOR,ACTOR).run()
  const claims=await Promise.allSettled([
   claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:PRODUCT,sessionId:'group-session',productVariantId:'var-adult',partySize:1}),
   claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:second,sessionId:'other-session',productVariantId:'second-variant',partySize:1})
  ])
  assert.equal(claims.filter(c=>c.status==='fulfilled').length,1,'only one distinct overlapping Session acquires provider occupancy')
  const winner=await db.prepare("SELECT b.id,b.product_id,b.product_session_id,c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.status='confirmed'").first<{id:string;product_id:string;product_session_id:string;assigned_member_id:string}>()
  assert.equal(winner?.assigned_member_id,'provider-one')
  const variant=winner!.product_id===PRODUCT?'var-child':'second-variant'
  const attendee=await claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:winner!.product_id,sessionId:winner!.product_session_id,productVariantId:variant,partySize:1})
  assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind(attendee.bookingId).first('assigned_member_id'),'provider-one','a second attendee shares the offering\'s provider')
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'),2)
  assert.equal((await listSessions(db,{env,organizationId:ORG,fromInstant:`${day}T00:00:00.000Z`,toInstant:`${day}T23:59:59.999Z`})).find(s=>s.id===winner!.product_session_id)?.remaining,1,'remaining capacity is attendee based')
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id),[{name:'Approved public name',photo_url:null,bio:'Approved public bio'}])
  for(const sessionId of ['missing-session',winner!.product_session_id==='group-session'?'other-session':'group-session']) {
   await assert.rejects(()=>publicProductHosts(db,ORG,winner!.product_id,sessionId),{statusCode:404},'an explicitly selected missing or foreign-product Session cannot substitute the offering provider')
  }
  await assert.rejects(()=>publicProductHosts(db,'foreign-org',winner!.product_id,winner!.product_session_id),{statusCode:404})
  for(const sessionId of ['',null,['group-session']])await assert.rejects(()=>publicProductHosts(db,ORG,winner!.product_id,sessionId),{statusCode:400})
  await db.prepare("UPDATE product_booking_configs SET assigned_member_id=NULL WHERE product_id=?").bind(winner!.product_id).run()
  await db.prepare("UPDATE member_scheduling SET time_off_json=? WHERE member_id='provider-one'").bind(JSON.stringify([{start,end}])).run()
  await assert.rejects(()=>claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:ORG,productId:winner!.product_id,sessionId:winner!.product_session_id,productVariantId:variant,partySize:1}), winner!.product_id === second
    ? (error: unknown) => { const failure = error as { status: number; data: unknown }; assert.equal(failure.status, 409); assert.deepEqual(failure.data, { code: 'ATTORNEY_REQUIRED', field: 'host' }); return true }
    : CapacityUnavailableError)
  // A booking is its offering's member's: an offering nobody handles has no host to show for any of its sessions.
  assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind(winner!.id).first('assigned_member_id'),null,'a booking has no person of its own beside its offering\'s')
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id,winner!.product_session_id),[])
  await db.prepare("UPDATE product_booking_configs SET assigned_member_id='provider-one' WHERE product_id=?").bind(winner!.product_id).run()
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id,winner!.product_session_id),[{name:'Approved public name',photo_url:null,bio:'Approved public bio'}])
  await db.prepare("UPDATE member_scheduling SET public_approved=0 WHERE member_id='provider-one'").run()
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id,winner!.product_session_id),[],'unapproved/private identity is not public content')
  // Responsibility grants operational access even for retained bookings with
  // no request, while the individual who was booked remains a separate fact.
  await db.prepare("INSERT INTO user(id,name,email) VALUES('responsible-user','Responsible member','responsible@example.test')").run()
  await db.prepare("INSERT INTO member(id,organizationId,userId,role) VALUES('responsible-member',?,'responsible-user','member'),('operator-member',?,?,'owner')").bind(ORG, ORG, ACTOR).run()
  await db.prepare(`INSERT INTO member_scheduling(member_id, organization_id, timezone, weekly_json, time_off_json, public_name, public_approved, updated_at, updated_by)
    VALUES('responsible-member',?,'UTC',?,'[]','Responsible member',1,?,?)`).bind(ORG,JSON.stringify(weekly),NOW,ACTOR).run()
  await setProductBookingConfig(db,{organizationId:ORG,productId:winner!.product_id,actorId:ACTOR,env,patch:{assigned_member_id:'responsible-member'}})
  await assertAssignedBookingAccess(db,{...memberAccessPrincipal({organizationId:ORG,userId:'responsible-user',role:'member'} as never,{env}),bookingId:winner!.id})
  assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind(winner!.id).first('assigned_member_id'),'responsible-member','the booking follows its offering\'s responsibility')
 }finally{await runtime.dispose()}
})

test('new legal consultations require an eligible named attorney while experiences and historical attribution retain their own semantics', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const { publicProductHosts } = await import('../../server/utils/public-provider.ts')
    const consultation = 'family-law-consultation'
    const day = addLocalDays(localNow('UTC').date, 3)
    const startsAt = `${day}T09:00:00.000Z`
    const endsAt = `${day}T10:00:00.000Z`
    await db.prepare("INSERT INTO member (id,organizationId,userId,role) VALUES ('member-actor',?,?,'owner')").bind(ORG, ACTOR).run()
    for (const [id, name, published] of [['morgan', 'Attorney Morgan', 1], ['riley', 'Attorney Riley', 0]] as const) {
      await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,1,1)').bind(`${id}-user`, name, `${id}@example.test`).run()
      await db.prepare("INSERT INTO member (id,organizationId,userId,role) VALUES (?, ?, ?, 'member')").bind(id, ORG, `${id}-user`).run()
      const weekly = Array.from({ length: 7 }, (_, weekday) => ({ weekday, start: '08:00', end: '18:00' }))
      await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, public_name, public_approved, updated_at, updated_by)
        VALUES (?,?,'UTC',?,'[]',?,?,?,?)`).bind(id, ORG, JSON.stringify(weekly), name, published, NOW, ACTOR).run()
    }
    await db.prepare("INSERT INTO products (kind,id,organization_id,name,slug,created_by,updated_by) VALUES ('service',?,?,'Family Law Consultation','family-law-consultation',?,?)").bind(consultation, ORG, ACTOR, ACTOR).run()
    await db.prepare("INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('consultation-variant',?,?,'Consultation',?,?)").bind(ORG, consultation, ACTOR, ACTOR).run()
    await db.prepare('INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES (?,?,?,1,1,?,?)').bind(ORG, consultation, LOCATION, ACTOR, ACTOR).run()
    await db.prepare("INSERT INTO product_booking_configs (product_id,organization_id,unit,scheduling_mode,duration_minutes,default_capacity,created_by,updated_by) VALUES (?,?,'slot','business',60,1,?,?)").bind(consultation, ORG, ACTOR, ACTOR).run()
    for (const [id, product, start, end] of [
      ['class-business-clock', PRODUCT, startsAt, endsAt],
      ['consultation-morgan', consultation, startsAt, endsAt],
      ['consultation-historical', consultation, '2020-01-06T09:00:00.000Z', '2020-01-06T10:00:00.000Z'],
    ] as const) {
      await db.prepare("INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES (?,?,?,?,'UTC',?,?,1,'scheduled',?,?)")
        .bind(id, ORG, product, LOCATION, start, end, ACTOR, ACTOR).run()
    }
    // An earlier consultation is its practice area's like every other one.
    await db.prepare(`INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,party_size,policy_json,status,location_id,starts_at,ends_at,timezone) SELECT 'historical-consultation',?,?,'consultation-historical','consultation-variant',1,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed',location_id,starts_at,ends_at,timezone FROM product_sessions WHERE id = 'consultation-historical'`).bind(ORG, consultation).run()
    const experience = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: PRODUCT, sessionId: 'class-business-clock', productVariantId: 'var-adult', partySize: 1 })
    assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind(experience.bookingId).first('assigned_member_id'), 'class-host', 'a class booking is its host\'s')
    const scope = { organizationId: ORG, productId: consultation, actorId: ACTOR, env, policyJson: OPEN_TERMS_JSON }
    const attorneyRequired = (error: unknown) => { const failure = error as { status: number; data: unknown }; assert.equal(failure.status, 409); assert.deepEqual(failure.data, { code: 'ATTORNEY_REQUIRED', field: 'scheduling_mode' }); return true }
    await assert.rejects(setProductBookingConfig(db, { ...scope, patch: { duration_minutes: 30 } }), attorneyRequired)
    await assert.rejects(listSessions(db, { env, organizationId: ORG, productId: consultation, fromInstant: startsAt, toInstant: `${day}T23:59:59.999Z` }), attorneyRequired)
    await assert.rejects(claimSessionCapacity(db, { ...scope, sessionId: 'consultation-morgan', productVariantId: 'consultation-variant', partySize: 1 }), attorneyRequired)
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings WHERE product_id=? AND id<>?').bind(consultation, 'historical-consultation').first('n'), 0)

    await setProductBookingConfig(db, { ...scope, patch: { scheduling_mode: 'provider', assigned_member_id: 'morgan' } })
    const available = await listSessions(db, { env, organizationId: ORG, productId: consultation, fromInstant: startsAt, toInstant: `${day}T23:59:59.999Z` })
    assert.equal(available.find(session => session.id === 'consultation-morgan')?.is_full, false)
    const booked = await claimSessionCapacity(db, { ...scope, sessionId: 'consultation-morgan', productVariantId: 'consultation-variant', partySize: 1 })
    assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind(booked.bookingId).first('assigned_member_id'), 'morgan')
    assert.deepEqual(await publicProductHosts(db, ORG, consultation, 'consultation-morgan'), [{ name: 'Attorney Morgan', photo_url: null, bio: null }])
    assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind('historical-consultation').first('assigned_member_id'), 'morgan', 'every consultation of the practice area is its attorney\'s')

    await setProductBookingConfig(db, { ...scope, patch: { assigned_member_id: 'morgan', held_online: true } })
    const onlineOffering = await getProduct(db, ORG, consultation)
    assert.equal(onlineOffering.booking?.held_online, true)
    // A new provider-mode offering is bookable from its own setup batch: its sessions are not stored when the
    // readiness guard runs, so the providers it checks with Google come from the configuration.
    const fresh = await createProduct(db, { env, organizationId: ORG, actor: { actorId: ACTOR }, product: { kind: 'service', name: 'Fresh consultation', variants: [{ name: 'Standard', prices: [{ unit_amount: 100_000, currency: 'THB', type: 'one_time' }] }] },
      booking: { env, data: { location_id: null, duration_minutes: 60, default_capacity: 1, scheduling_mode: 'provider', assigned_member_id: 'morgan' } } })
    const freshSessions = await listSessions(db, { env, organizationId: ORG, productId: fresh.id, fromInstant: new Date().toISOString(), toInstant: new Date(Date.now() + 14 * 86_400_000).toISOString() })
    assert(freshSessions.some(session => !session.is_full), 'the configured attorney holds bookable sessions from the first write')
    // A dated session beyond the public window is nothing a guest can book now, so it does not make the offering bookable.
    const distantStart = new Date(Date.now() + 60 * 86_400_000); distantStart.setUTCHours(10, 0, 0, 0)
    await assert.rejects(createProduct(db, { env, organizationId: ORG, actor: { actorId: ACTOR }, product: { kind: 'service', name: 'Distant consultation', variants: [{ name: 'Standard', prices: [{ unit_amount: 100_000, currency: 'THB', type: 'one_time' }] }] },
      booking: { env, data: { location_id: LOCATION, duration_minutes: 60, default_capacity: 1, assigned_member_id: 'morgan', sessions: [{ starts_at: distantStart.toISOString(), ends_at: new Date(distantStart.getTime() + 3_600_000).toISOString() }] } } }), { statusCode: 409 })
    const bookedBeforeDeparture = await db.prepare('SELECT * FROM bookings WHERE id=?').bind(booked.bookingId).first()
    const sessionBeforeDeparture = await db.prepare("SELECT * FROM product_sessions WHERE id='consultation-morgan'").first()
    await db.prepare("INSERT INTO session (id,expiresAt,token,userId) VALUES ('owner-session',unixepoch()+3600,'owner-session-token',?)").bind(ACTOR).run()
    const removed = await createAuth(env).api.removeMember({ headers: new Headers({ authorization: 'Bearer owner-session-token' }), body: { organizationId: ORG, memberIdOrEmail: 'morgan' } })
    assert.equal(removed.member.id, 'morgan')
    assert.deepEqual((await getProduct(db, ORG, consultation)).booking, { ...onlineOffering.booking, assigned_member_id: null }, 'departure clears current responsibility while preserving the online offering and its authored booking facts')
    assert.deepEqual(await db.prepare('SELECT * FROM bookings WHERE id=?').bind(booked.bookingId).first(), bookedBeforeDeparture, 'membership removal retains every booked attorney fact')
    assert.deepEqual(await db.prepare("SELECT * FROM product_sessions WHERE id='consultation-morgan'").first(), sessionBeforeDeparture, 'membership removal retains the booked session')
    const attorneyDeparted = (error: unknown) => { const failure = error as { status: number; data: unknown }; assert.equal(failure.status, 409); assert.deepEqual(failure.data, { code: 'ATTORNEY_REQUIRED', field: 'host' }); return true }
    await assert.rejects(listSessions(db, { env, organizationId: ORG, productId: consultation, fromInstant: startsAt, toInstant: `${day}T23:59:59.999Z` }), attorneyDeparted)
    await assert.rejects(claimSessionCapacity(db, { ...scope, sessionId: 'consultation-morgan', productVariantId: 'consultation-variant', partySize: 1 }), attorneyDeparted)
  } finally { await runtime.dispose() }
})

test('an online offering is booked in its provider\'s hours, in the provider\'s zone, and follows those hours as they change', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR, env, policyJson: OPEN_TERMS_JSON }
  try {
    const { writeMemberScheduling } = await import('../../server/domain/member-scheduling.ts')
    const zone = 'America/Los_Angeles'
    await db.prepare("INSERT INTO user (id, name, email) VALUES ('host-user', 'Host', 'host@example.com')").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('host', ?, 'host-user', 'member')").bind(ORG).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('member-actor', ?, ?, 'owner')").bind(ORG, ACTOR).run()
    const hostActor = { env, organizationId: ORG, userId: 'host-user' }
    const profile = await writeMemberScheduling(hostActor, 'host', { updated_at: null, public_name: 'Authored host' })
    assert.equal(profile.timezone, null)
    await setProductBookingConfig(db, { ...scope, env, patch: { assigned_member_id: 'host', scheduling_mode: 'business' } })
    assert.equal(await db.prepare('SELECT assigned_member_id FROM product_booking_configs WHERE product_id=?').bind(PRODUCT).first('assigned_member_id'), 'host', 'a host does not need provider hours for physical sessions')
    await assert.rejects(setProductBookingConfig(db, { ...scope, env, patch: { scheduling_mode: 'provider' } }), /Set working hours for this member/)
    await assert.rejects(setProductBookingConfig(db, { ...scope, env, patch: { scheduling_mode: 'provider', assigned_member_id: 'host' } }), /Set working hours for this member/)
    assert.equal(await db.prepare('SELECT scheduling_mode FROM product_booking_configs WHERE product_id=?').bind(PRODUCT).first('scheduling_mode'), 'business', 'a profile-only member cannot become a provider candidate')
    const tuesday = (() => { let date = addLocalDays(localNow(zone).date, 2); while (new Date(`${date}T12:00:00Z`).getUTCDay() !== 2) date = addLocalDays(date, 1); return date })()
    const away = { start: localDateTimeToInstant(tuesday, '09:00', zone).toISOString(), end: localDateTimeToInstant(tuesday, '10:00', zone).toISOString() }
    const write = async (end: string, timeOff: Array<{ start: string; end: string }>) => writeMemberScheduling(hostActor, 'host', {
      timezone: zone, weekly: [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '09:00', end })), time_off: timeOff,
      updated_at: (await db.prepare("SELECT updated_at FROM member_scheduling WHERE member_id='host'").first<string>('updated_at'))!,
    })
    await write('12:00', [away])
    await setProductBookingConfig(db, { ...scope, env, patch: { duration_minutes: 60, default_capacity: 1, held_online: true, scheduling_mode: 'provider', assigned_member_id: 'host' } })
    await materializeSessions(db, { ...scope, throughDate: addLocalDays(localNow(zone).date, 30) })
    const online = async () => (await db.prepare("SELECT id, starts_at, timezone, status FROM product_sessions WHERE location_id IS NULL ORDER BY starts_at").all<{ id: string; starts_at: string; timezone: string; status: string }>()).results
    const local = (instant: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant))
    const first = await online()
    assert(first.length > 0)
    assert(first.every(session => session.timezone === zone), 'each slot is in the provider\'s zone')
    assert.deepEqual([...new Set(first.map(session => local(session.starts_at)))].sort(), ['09:00', '10:00', '11:00'], 'hourly slots across 09:00–12:00 local')
    assert.equal(first.some(session => session.starts_at === away.start), false, 'time off holds no slot')

    // A guest takes one 11:00 slot; then the provider shortens their day to 10:00.
    const claimed = first.find(session => local(session.starts_at) === '11:00')!
    await claimSessionCapacity(db, { ...scope, sessionId: claimed.id, productVariantId: 'var-adult', partySize: 1 })
    await write('10:00', [away])
    const shorter = await online()
    assert.equal(shorter.filter(session => session.status === 'scheduled' && local(session.starts_at) === '10:00').length, 0, 'unclaimed slots the hours no longer cover are retired')
    assert.equal(shorter.find(session => session.id === claimed.id)?.status, 'scheduled', 'a claimed slot is a commitment and stays')

    // The longer day comes back: the retired slots reopen in place rather than gaining twins.
    await write('12:00', [away])
    const restored = await online()
    assert.equal(restored.length, shorter.length, 'no duplicate sessions')
    assert.equal(restored.filter(session => session.status === 'scheduled').length, first.length)
  } finally { await runtime.dispose() }
})
