import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import {
  CapacityUnavailableError,
  setProductBookingConfig,
  deleteProductBookingConfig,
  replaceWeeklySchedule,
  claimSessionCapacity,
  listSessions,
  materializeSessions,
  setBookingStatus,
  sessionMoveQuery,
  updateSession,
} from '../../server/utils/availability.ts'
import { requestInsertQueries, threadPayloadForGuest, getThreadOperationalRecord, getGuestRequest } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { updateThreadProjectionIfLatestEntry } from '../../server/domain/guest-threads/repository.ts'
import { occurrenceKey } from '../../shared/bookings.ts'
import { addLocalDays, localDateTimeToInstant, localNow } from '../../utils/timezone.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

const ORG = 'org-sessions'
const LOCATION = 'loc-sessions'
const PRODUCT = 'prod-class'
const ACTOR = 'user-actor'
const NOW = '2026-09-11T00:00:00.000Z'

async function boot(legacy = false) {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'availability-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = legacy
    ? ['0000_baseline'].flatMap(name => readFileSync(`migrations-history/v11/${name}.sql`, 'utf8').split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean))
    : await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  await db.prepare("INSERT INTO user (id,name,email) VALUES (?,'Operator','operator@example.com')").bind(ACTOR).run()
  // The archived v11 schema kept the business clock in settings; the current one holds it as a column.
  await db.prepare(legacy
    ? `INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at)
       VALUES (?, 'Sessions', 'sessions', 'sessions', '{"config":{"default_timezone":"Asia/Bangkok"}}', 'theme', 'THB', 'active', 'complete', 'flat', 'experience', ?)`
    : `INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
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
  await db.prepare(`INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, created_by, updated_by)
    VALUES (?, ?, 120, 10, ?, ?)`).bind(PRODUCT, ORG, ACTOR, ACTOR).run()
  return { runtime, db }
}

function addRule(db: D1Database, id: string, over: Partial<{ weekday: number; start_time: string; timezone: string; location_id: string | null }> = {}) {
  return db.prepare(`INSERT INTO product_availability_rules
    (id, organization_id, product_id, location_id, timezone, weekday, start_time, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ORG, PRODUCT, over.location_id === undefined ? LOCATION : over.location_id, over.timezone ?? 'Asia/Bangkok', over.weekday ?? 0,
      over.start_time ?? '14:00', ACTOR, ACTOR).run()
}

test('session materialization is idempotent across cancel, edit and reschedule', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
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
    await updateSession(db, { organizationId: ORG, sessionId: target.id, actorId: ACTOR, status: 'cancelled' })
    await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate, actorId: ACTOR })
    assert.equal(await db.prepare('SELECT status FROM product_sessions WHERE id = ?').bind(target.id).first<string>('status'), 'cancelled',
      'regeneration must not resurrect a cancelled occurrence')
    assert.equal(await db.prepare('SELECT count(*) n FROM product_sessions').first<number>('n'), count)

    // A rescheduled occurrence is not recreated at its old start.
    const moved = await db.prepare('SELECT id, starts_at, ends_at FROM product_sessions WHERE status = ? ORDER BY starts_at LIMIT 1')
      .bind('scheduled').first<{ id: string; starts_at: string; ends_at: string }>()
    assert(moved)
    const newStart = new Date(Date.parse(moved.starts_at) + 3_600_000).toISOString()
    await updateSession(db, { organizationId: ORG, sessionId: moved.id, actorId: ACTOR, startsAt: newStart, endsAt: new Date(Date.parse(moved.ends_at) + 3_600_000).toISOString(), capacity: 4 })
    await materializeSessions(db, { organizationId: ORG, productId: PRODUCT, throughDate, actorId: ACTOR })
    const after = await db.prepare('SELECT starts_at, capacity FROM product_sessions WHERE id = ?').bind(moved.id).first<{ starts_at: string; capacity: number }>()
    assert.equal(after?.starts_at, newStart, 'a rescheduled session keeps its new time')
    assert.equal(after?.capacity, 4, 'regeneration must not overwrite an edited capacity')
    assert.equal(await db.prepare('SELECT count(*) n FROM product_sessions').first<number>('n'), count,
      'regeneration must not recreate a rescheduled occurrence under its old start')
  } finally { await runtime.dispose() }
})

test('DST gaps and folds are reported, never silently resolved', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    // Generation is bounded to a year ahead, so the transition dates are found
    // inside that window rather than hardcoded — the test stays true as time
    // passes instead of expiring on a fixed date.
    const zone = 'America/Los_Angeles'
    // One window for both the search and the generation: searching a day
    // further than sessions are generated could find a transition the run never
    // reached, depending on the date the suite happened to run.
    const WINDOW_DAYS = 359
    const findSunday = (time: string): string | null => {
      const today = localNow(zone).date
      for (let offset = 1; offset <= WINDOW_DAYS; offset += 1) {
        const date = addLocalDays(today, offset)
        if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) continue
        try { localDateTimeToInstant(date, time, zone, 'reject') }
        catch (error) { if (error instanceof RangeError) return date; throw error }
      }
      return null
    }
    const gapDate = findSunday('02:30')
    const foldDate = findSunday('01:30')
    assert(gapDate, 'a spring-forward Sunday exists within the generation window')
    assert(foldDate, 'a fall-back Sunday exists within the generation window')

    // A rule is at a location, in that location's clock.
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at) VALUES ('loc-la', ?, 'la', 'Los Angeles', 'active', ?, ?, ?)`).bind(ORG, zone, NOW, NOW).run()
    await addRule(db, 'rule-gap', { timezone: zone, weekday: 0, start_time: '02:30', location_id: 'loc-la' })
    await addRule(db, 'rule-fold', { timezone: zone, weekday: 0, start_time: '01:30', location_id: 'loc-la' })
    const result = await materializeSessions(db, {
      organizationId: ORG, productId: PRODUCT, throughDate: addLocalDays(localNow(zone).date, WINDOW_DAYS), actorId: ACTOR,
    })

    const gap = result.skipped.find(entry => entry.local_date === gapDate && entry.local_start_time === '02:30')
    assert(gap, `the spring-forward occurrence on ${gapDate} is reported`)
    assert.equal(gap.reason, 'nonexistent_local_time')
    const fold = result.skipped.find(entry => entry.local_date === foldDate && entry.local_start_time === '01:30')
    assert(fold, `the fall-back occurrence on ${foldDate} is reported`)
    assert.equal(fold.reason, 'ambiguous_local_time')

    const rows = await db.prepare('SELECT starts_at FROM product_sessions ORDER BY starts_at').all<{ starts_at: string }>()
    assert(rows.results.length > 0, 'the surrounding Sundays still generate')
    const localDay = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))
    const localTime = (instant: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant))
    // The other rule still runs on each transition date — 01:30 exists on the
    // spring-forward day and 02:30 exists on the fall-back day. Only the
    // impossible and the doubled occurrence are absent, and neither was
    // quietly shifted to a neighbouring hour.
    assert.equal(rows.results.some(row => localDay(row.starts_at) === gapDate && localTime(row.starts_at) === '02:30'), false, 'the impossible 02:30 occurrence does not exist')
    assert.equal(rows.results.some(row => localDay(row.starts_at) === foldDate && localTime(row.starts_at) === '01:30'), false, 'the doubled 01:30 occurrence does not exist')
    assert.equal(rows.results.filter(row => localDay(row.starts_at) === gapDate).length, 1, 'the gap date keeps only its 01:30 session')
    assert.equal(rows.results.filter(row => localDay(row.starts_at) === foldDate).length, 1, 'the fold date keeps only its 02:30 session')

    // Local wall time is stable across the offset change: this is the whole
    // reason recurrence is stored as wall time plus a zone, not as an offset.
    const locals = new Set(rows.results.map(row => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.starts_at))))
    assert.deepEqual([...locals].sort(), ['01:30', '02:30'])
  } finally { await runtime.dispose() }
})

test('concurrent claims cannot exceed capacity, and variants share one pool', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('sess-1', ?, ?, ?, 'Asia/Bangkok', '2099-01-05T07:00:00.000Z', '2099-01-05T09:00:00.000Z', 5, 'scheduled', ?, ?)`)
      .bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()

    // Two ticket tiers, one seat pool: 3 adults + 2 children fills the class.
    await claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-adult', partySize: 3 })
    await claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-child', partySize: 2 })
    await assert.rejects(
      claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-adult', partySize: 1 }),
      CapacityUnavailableError,
      'a ticket tier does not get its own seat pool',
    )

    // Concurrency: eight parties of one race for three seats.
    await db.prepare("UPDATE product_sessions SET capacity = 8 WHERE id = 'sess-1'").run()
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
      claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-1', productVariantId: 'var-adult', partySize: 1 })))
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
    const [session] = await listSessions(db, { organizationId: ORG, productId: PRODUCT, fromInstant: '2099-01-01T00:00:00.000Z', toInstant: '2099-02-01T00:00:00.000Z' })
    assert.equal(session?.remaining, 3)
    assert.equal(session?.is_full, false)
  } finally { await runtime.dispose() }
})

test('capacity cannot be reduced below seats already claimed, and a past session cannot be booked', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('sess-cap', ?, ?, ?, 'Asia/Bangkok', '2099-01-05T07:00:00.000Z', '2099-01-05T09:00:00.000Z', 10, 'scheduled', ?, ?)`)
      .bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()
    await claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-cap', productVariantId: 'var-adult', partySize: 6 })
    await assert.rejects(
      updateSession(db, { organizationId: ORG, sessionId: 'sess-cap', actorId: ACTOR, capacity: 4 }),
      /already has 6 seats claimed/, 'reducing capacity below claimed seats is refused, not silently oversold')
    await updateSession(db, { organizationId: ORG, sessionId: 'sess-cap', actorId: ACTOR, capacity: 6 })

    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('sess-past', ?, ?, ?, 'Asia/Bangkok', '2020-01-05T07:00:00.000Z', '2020-01-05T09:00:00.000Z', 10, 'scheduled', ?, ?)`)
      .bind(ORG, PRODUCT, LOCATION, ACTOR, ACTOR).run()
    await assert.rejects(
      claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-past', productVariantId: 'var-adult', partySize: 1 }),
      CapacityUnavailableError, 'a session in the past takes no bookings')

    await db.prepare("UPDATE product_sessions SET status = 'cancelled' WHERE id = 'sess-cap'").run()
    await assert.rejects(
      claimSessionCapacity(db, { organizationId: ORG, productId: PRODUCT, sessionId: 'sess-cap', productVariantId: 'var-adult', partySize: 1 }),
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
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR }
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
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR }
  const slots = [{ weekday: 0, start_time: '14:00' }, { weekday: 1, start_time: '10:00' }]
  try {
    await assert.rejects(replaceWeeklySchedule(db, { ...scope, timezone: 'UTC', slots }), /timezone must match/)
    await assert.rejects(replaceWeeklySchedule(db, { ...scope, slots: [{ weekday: 0, start_time: '14:00', capacity: null }] }), /only weekday and start_time/)
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
    const { runtime, db } = await boot()
    const scope = { organizationId: ORG, productId: PRODUCT, locationId: LOCATION, actorId: ACTOR }
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
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR }
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


test('provider additive migration keeps the separately held weekly columns and their populated values', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot(true)
  try {
    await addRule(db, 'held-rule')
    await db.prepare("UPDATE product_availability_rules SET end_time='16:00',interval_minutes=30,interval_weeks=2,effective_from_date='2026-01-01',effective_until_date='2030-01-01',duration_minutes=30,capacity=0 WHERE id='held-rule'").run()
    await db.prepare("INSERT INTO organization_integrations(id,organization_id,provider,account_id,target_id,target_name,measurement_id,revision,created_at,updated_at)VALUES('retained-analytics',?,'google_analytics','linked-account','properties/123','Analytics','G-RETAINED','original-revision',?,?)").bind(ORG,NOW,NOW).run()
    const integrationBefore=await db.prepare("SELECT * FROM organization_integrations WHERE id='retained-analytics'").first()
    await db.batch(readFileSync('migrations-history/v11/0001_calendar_member_scheduling.sql', 'utf8').split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)))
    const row = await db.prepare("SELECT end_time,interval_minutes,interval_weeks,effective_from_date,effective_until_date,duration_minutes,capacity FROM product_availability_rules WHERE id='held-rule'").first()
    assert.deepEqual(row, { end_time: '16:00', interval_minutes: 30, interval_weeks: 2, effective_from_date: '2026-01-01', effective_until_date: '2030-01-01', duration_minutes: 30, capacity: 0 })
    assert.deepEqual(await db.prepare("SELECT * FROM organization_integrations WHERE id='retained-analytics'").first(),{...integrationBefore,calendar_group:null,include_reservations:null,status:null,last_error:null})
    await db.prepare("INSERT INTO user(id,name,email) VALUES('integrity-user','Member','integrity@example.test')").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId) VALUES('integrity-member',?,'integrity-user')").bind(ORG).run()
    await db.prepare("INSERT INTO member_scheduling(member_id,organization_id,timezone,weekly_json,time_off_json,windows_json,windows_until,public_name,calendar_revision,updated_at,updated_by) VALUES('integrity-member',?,'Asia/Bangkok','[]','[]','[]','2030-01-01T00:00:00.000Z','Retained profile','retained-revision',?,?)").bind(ORG,NOW,ACTOR).run()
    const scheduleBefore=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='integrity-member'").first()
    await db.batch(readFileSync('migrations-history/v11/0002_calendar_member_integrity.sql','utf8').split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)))
    assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='integrity-member'").first(),scheduleBefore,'the forward constraint migration preserves the exact schedule and profile')
    const analyticsBefore=await db.prepare("SELECT id,organization_id,provider,account_id,target_id,target_name,measurement_id,verified,verification_token,status,last_error,revision,created_at,updated_at FROM organization_integrations WHERE provider='google_analytics'").first()
    await db.batch(readFileSync('migrations-history/v11/0003_calendar_connection.sql','utf8').split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)))
    assert.deepEqual(await db.prepare("SELECT * FROM organization_integrations WHERE provider='google_analytics'").first(),analyticsBefore,'removing calendar export policy preserves the exact Analytics identity and credentials reference')
    await db.prepare("INSERT INTO organization(id,name,slug) VALUES('foreign-org','Foreign','foreign-org')").run()
    await assert.rejects(db.prepare("UPDATE member_scheduling SET organization_id='foreign-org' WHERE member_id='integrity-member'").run(),/FOREIGN KEY/)
    assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all().then(result=>result.results),[])
    await db.prepare("DELETE FROM member WHERE id='integrity-member'").run()
    assert.equal(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='integrity-member'").first(),null,'Better Auth membership deletion removes its scheduling state')
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
  } finally { await runtime.dispose() }
})

// Named invariants: one provider's online offerings exclude each other's overlapping
// pending requests; confirmation/rejection and replay never allocate a second seat.
test('one provider\'s online offerings exclude overlapping pending requests and review retries release once', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    // Two providers whose hours cover the day; each holds their own online offerings.
    for (const provider of ['provider-x', 'provider-y']) {
      await db.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)").bind(`${provider}-user`, provider, `${provider}@example.com`).run()
      await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES (?, ?, ?, 'member')").bind(provider, ORG, `${provider}-user`).run()
      await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, calendar_revision, updated_at, updated_by) VALUES (?, ?, 'America/New_York', '[]', '[]', '[{"start":"2098-11-02T00:00:00.000Z","end":"2098-11-03T00:00:00.000Z"}]', '2099-01-01T00:00:00.000Z', 'r1', ?, ?)`).bind(provider, ORG, NOW, ACTOR).run()
    }
    await db.prepare("UPDATE product_booking_configs SET confirmation_mode = 'review', held_online = 1, scheduling_mode = 'provider', assigned_member_id = 'provider-x' WHERE product_id = ?").bind(PRODUCT).run()
    for (const [productId, variantId, provider] of [['prod-consult', 'var-consult', 'provider-x'], ['prod-independent', 'var-independent', 'provider-y']]) {
      await db.prepare(`INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('experience', ?, ?, ?, ?, ?, ?)`).bind(productId, ORG, productId, productId, ACTOR, ACTOR).run()
      await db.prepare('INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)').bind(variantId, ORG, productId, variantId, ACTOR, ACTOR).run()
      await db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, confirmation_mode, held_online, scheduling_mode, assigned_member_id, created_by, updated_by) VALUES (?, ?, 45, 1, 'review', 1, 'provider', ?, ?, ?)").bind(productId, ORG, provider, ACTOR, ACTOR).run()
    }
    for (const [id, productId, provider, start, end] of [
      ['session-one', PRODUCT, 'provider-x', '2098-11-02T15:00:00.000Z', '2098-11-02T16:15:00.000Z'],
      ['session-two', 'prod-consult', 'provider-x', '2098-11-02T15:30:00.000Z', '2098-11-02T16:15:00.000Z'],
      ['session-adjacent', 'prod-consult', 'provider-x', '2098-11-02T16:15:00.000Z', '2098-11-02T17:00:00.000Z'],
      ['session-independent', 'prod-independent', 'provider-y', '2098-11-02T15:30:00.000Z', '2098-11-02T16:15:00.000Z'],
    ]) await db.prepare("INSERT INTO product_sessions (id, organization_id, product_id, assigned_member_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by) VALUES (?, ?, ?, ?, 'America/New_York', ?, ?, 1, 'scheduled', ?, ?)").bind(id, ORG, productId, provider, start, end, ACTOR, ACTOR).run()
    for (const id of ['thread-one', 'thread-two']) {
      const queries = requestInsertQueries({ id, kind: 'booking', organization_id: ORG, location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW, updated_at: NOW })
      await db.batch(queries.map(query => db.prepare(query.query).bind(...query.params!)))
    }
    const inputs = [
      { organizationId: ORG, productId: PRODUCT, sessionId: 'session-one', productVariantId: 'var-adult', partySize: 1, requestId: 'thread-one' },
      { organizationId: ORG, productId: 'prod-consult', sessionId: 'session-two', productVariantId: 'var-consult', partySize: 1, requestId: 'thread-two' },
    ]
    const raced = await Promise.allSettled(inputs.map(input => claimSessionCapacity(db, input)))
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
    const index = raced.findIndex(result => result.status === 'fulfilled')
    const winner = inputs[index]!
    const record = await getThreadOperationalRecord(db, winner.requestId)
    assert.equal(record?.status, 'pending')
    assert.equal((await claimSessionCapacity(db, winner)).bookingId, record!.id)
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'), 1)
    const listed = await listSessions(db, { organizationId: ORG, fromInstant: '2098-11-02T00:00:00.000Z', toInstant: '2098-11-03T00:00:00.000Z' })
    assert.equal(listed.find(session => session.id === inputs[1 - index]!.sessionId)?.is_full, true)
    assert.equal(listed.find(session => session.id === 'session-adjacent')?.remaining, 1)
    assert.equal(listed.find(session => session.id === 'session-independent')?.remaining, 1)
    const env = { NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only' }
    const confirm = { threadId: winner.requestId, organizationId: ORG, action: 'confirm', actorUserId: ACTOR, idempotencyKey: 'confirm-once', env }
    assert.equal((await executeGuestThreadOperation(db, confirm)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, confirm)).ok, true)
    assert.equal((await getThreadOperationalRecord(db, winner.requestId))?.status, 'confirmed')
    assert.equal((await getGuestRequest(db, winner.requestId, ORG))?.conversation_state, 'resolved', 'a delivered decision finishes its booking review')
    const guestReply = await appendEntry(db, { threadId: winner.requestId, kind: 'message', actorKind: 'guest', channel: 'web', body: 'One more question', dedupeKey: 'question-after-confirmation' })
    await updateThreadProjectionIfLatestEntry(db, winner.requestId, guestReply.id, { conversationState: 'needs_attention' })
    assert.equal((await executeGuestThreadOperation(db, confirm)).ok, true)
    assert.equal((await getGuestRequest(db, winner.requestId, ORG))?.conversation_state, 'needs_attention', 'replaying an older decision does not answer a new guest message')
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'), 1)
    const moved = await sessionMoveQuery(db, { bookingId: record!.id, organizationId: ORG, productId: winner.productId, sessionId: winner.sessionId, partySize: 1, now: new Date().toISOString() })
    assert.equal((await db.prepare(moved.query).bind(...moved.params!).run()).meta.changes, 1, 'same-session changes exclude the allocation being moved')
    assert.equal((await getThreadOperationalRecord(db, winner.requestId))?.id, record!.id)
    assert.equal((await getThreadOperationalRecord(db, winner.requestId))?.status, 'confirmed')
    await assert.rejects(() => claimSessionCapacity(db, { ...winner, partySize: 2 }), /different booking/)
    const cancel = { ...confirm, action: 'cancel', idempotencyKey: 'cancel-once' }
    assert.equal((await executeGuestThreadOperation(db, cancel)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, cancel)).ok, true)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE event_name = 'booking.cancel'").first('n'), 1)
    const loser = inputs[1 - index]!
    // A booking conversation without its own allocation is invalid. Neither
    // a status transition nor a reply can manufacture its missing record.
    const missingRecord = { statusCode: 404, message: 'The conversation has no matching booking or reservation', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: loser.requestId } }
    await assert.rejects(executeGuestThreadOperation(db, { ...confirm, threadId: loser.requestId }), missingRecord)
    const reply = { ...confirm, threadId: loser.requestId, action: 'reply', body: 'We can help with your booking.', idempotencyKey: 'before-allocation' }
    await assert.rejects(executeGuestThreadOperation(db, reply), missingRecord)
    assert.equal(await db.prepare('SELECT status FROM guest_thread_deliveries WHERE id = ?').bind(`guest-thread-email:${loser.requestId}:before-allocation`).first('status'), null)
    await claimSessionCapacity(db, loser)
    const reject = { ...confirm, threadId: loser.requestId, action: 'reject', idempotencyKey: 'reject-once' }
    assert.equal((await executeGuestThreadOperation(db, reject)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, reject)).ok, true)
    assert.equal((await getThreadOperationalRecord(db, loser.requestId))?.status, 'cancelled')
    const after = await listSessions(db, { organizationId: ORG, fromInstant: '2098-11-02T00:00:00.000Z', toInstant: '2098-11-03T00:00:00.000Z' })
    assert.equal(after.find(session => session.id === 'session-one')?.remaining, 1)
    assert.equal(after.find(session => session.id === 'session-two')?.remaining, 1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE event_name = 'booking.confirm'").first('n'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM activity_entries WHERE event_name = 'booking.reject'").first('n'), 1)
    // A delivered receipt proves that an earlier operation finished, not that
    // its required booking still exists when that operation is replayed.
    await db.prepare('DELETE FROM bookings WHERE id = ?').bind(record!.id).run()
    await assert.rejects(executeGuestThreadOperation(db, cancel), { statusCode: 404, message: 'The conversation has no matching booking or reservation', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: winner.requestId } })

    const questionRequest = 'thread-question-before-confirmation'
    await db.batch(requestInsertQueries({ id: questionRequest, kind: 'booking', organization_id: ORG, location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@example.com' }), created_at: NOW, updated_at: NOW }).map(query => db.prepare(query.query).bind(...query.params!)))
    await claimSessionCapacity(db, { ...winner, requestId: questionRequest })
    const question = await appendEntry(db, { threadId: questionRequest, kind: 'message', actorKind: 'guest', channel: 'web', body: 'Can I bring my notes?', dedupeKey: 'question-before-confirmation' })
    await updateThreadProjectionIfLatestEntry(db, questionRequest, question.id, { conversationState: 'needs_attention' })
    assert.equal((await executeGuestThreadOperation(db, { ...confirm, threadId: questionRequest })).ok, true)
    assert.equal((await getThreadOperationalRecord(db, questionRequest))?.status, 'confirmed')
    assert.equal((await getGuestRequest(db, questionRequest, ORG))?.conversation_state, 'needs_attention', 'confirming a booking does not answer a separate guest message')
  } finally { await runtime.dispose() }
})

test('provider allocation shares a class Session, excludes distinct overlapping services, and preserves assigned identities after hours/config edits', {timeout:120_000}, async()=>{
 const {runtime,db}=await boot()
 try {
  const {workingWindows}=await import('../../server/domain/member-scheduling.ts')
  const {publicProductHosts}=await import('../../server/utils/public-provider.ts')
  const day=addLocalDays(localNow('UTC').date,3), start=`${day}T09:00:00.000Z`, end=`${day}T10:00:00.000Z`
  await db.prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES ('provider-user','Private account name','private-provider@example.com',1,1,1)`).run()
  await db.prepare(`INSERT INTO member(id,organizationId,userId,role) VALUES ('provider-one',?,'provider-user','member')`).bind(ORG).run()
  const windows=workingWindows('UTC',Array.from({length:7},(_,weekday)=>({weekday,start:'08:00',end:'18:00'})))
  await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,timezone,weekly_json,time_off_json,windows_json,windows_until,public_name,public_bio,public_approved,calendar_revision,updated_at,updated_by) VALUES ('provider-one',?,'UTC','[]','[]',?,?, 'Approved public name','Approved public bio',1,'revision',?,?)`).bind(ORG,JSON.stringify(windows.intervals),windows.until,NOW,ACTOR).run()
  await db.prepare("UPDATE product_booking_configs SET scheduling_mode='provider',assigned_member_id='provider-one' WHERE product_id=?").bind(PRODUCT).run()
  const second='second-service'
  await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('service',?,?,'Other service','other-service',?,?)").bind(second,ORG,ACTOR,ACTOR).run()
  await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,scheduling_mode,assigned_member_id,duration_minutes,default_capacity,created_by,updated_by)VALUES(?,?,'provider','provider-one',60,3,?,?)").bind(second,ORG,ACTOR,ACTOR).run()
  await db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_by,updated_by)VALUES(?,?,?,1,1,?,?)").bind(ORG,second,LOCATION,ACTOR,ACTOR).run()
  await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by)VALUES('second-variant',?,?,'Standard',?,?)").bind(ORG,second,ACTOR,ACTOR).run()
  // One provider in one place: their two services at the studio cannot overlap.
  for(const [id,product]of [['group-session',PRODUCT],['other-session',second]])await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES(?,?,?,?,'UTC',?,?,3,?,?)").bind(id,ORG,product,LOCATION,start,end,ACTOR,ACTOR).run()
  const claims=await Promise.allSettled([
   claimSessionCapacity(db,{organizationId:ORG,productId:PRODUCT,sessionId:'group-session',productVariantId:'var-adult',partySize:1}),
   claimSessionCapacity(db,{organizationId:ORG,productId:second,sessionId:'other-session',productVariantId:'second-variant',partySize:1})
  ])
  assert.equal(claims.filter(c=>c.status==='fulfilled').length,1,'only one distinct overlapping Session acquires provider occupancy')
  const winner=await db.prepare("SELECT id,product_id,product_session_id,assigned_member_id FROM bookings WHERE status='confirmed'").first<{id:string;product_id:string;product_session_id:string;assigned_member_id:string}>()
  assert.equal(winner?.assigned_member_id,'provider-one')
  const variant=winner!.product_id===PRODUCT?'var-child':'second-variant'
  const attendee=await claimSessionCapacity(db,{organizationId:ORG,productId:winner!.product_id,sessionId:winner!.product_session_id,productVariantId:variant,partySize:1})
  assert.equal(await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(attendee.bookingId).first('assigned_member_id'),'provider-one','a second attendee shares the committed provider')
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM bookings').first('n'),2)
  assert.equal((await listSessions(db,{organizationId:ORG,fromInstant:`${day}T00:00:00.000Z`,toInstant:`${day}T23:59:59.999Z`})).find(s=>s.id===winner!.product_session_id)?.remaining,1,'remaining capacity is attendee based')
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id),[{name:'Approved public name',photo_url:null,bio:'Approved public bio'}])
  for(const sessionId of ['missing-session',winner!.product_session_id==='group-session'?'other-session':'group-session']) {
   await assert.rejects(()=>publicProductHosts(db,ORG,winner!.product_id,sessionId),{statusCode:404},'an explicitly selected missing or foreign-product Session cannot substitute the offering provider')
  }
  await assert.rejects(()=>publicProductHosts(db,'foreign-org',winner!.product_id,winner!.product_session_id),{statusCode:404})
  for(const sessionId of ['',null,['group-session']])await assert.rejects(()=>publicProductHosts(db,ORG,winner!.product_id,sessionId),{statusCode:400})
  await db.prepare("UPDATE product_booking_configs SET assigned_member_id=NULL WHERE product_id=?").bind(winner!.product_id).run()
  await db.prepare("UPDATE member_scheduling SET time_off_json=? WHERE member_id='provider-one'").bind(JSON.stringify([{start,end}])).run()
  await assert.rejects(()=>claimSessionCapacity(db,{organizationId:ORG,productId:winner!.product_id,sessionId:winner!.product_session_id,productVariantId:variant,partySize:1}),CapacityUnavailableError)
  assert.equal(await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(winner!.id).first('assigned_member_id'),'provider-one','hours/assignment edits never rewrite a booked commitment')
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id,winner!.product_session_id),[{name:'Approved public name',photo_url:null,bio:'Approved public bio'}])
  await db.prepare("UPDATE member_scheduling SET public_approved=0 WHERE member_id='provider-one'").run()
  assert.deepEqual(await publicProductHosts(db,ORG,winner!.product_id,winner!.product_session_id),[],'unapproved/private identity is not public content')
 }finally{await runtime.dispose()}
})

test('an online offering is booked in its provider\'s hours, in the provider\'s zone, and follows those hours as they change', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, productId: PRODUCT, actorId: ACTOR }
  try {
    const { workingWindows } = await import('../../server/domain/member-scheduling.ts')
    const zone = 'America/Los_Angeles'
    await db.prepare("INSERT INTO user (id, name, email) VALUES ('host-user', 'Host', 'host@example.com')").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('host', ?, 'host-user', 'member')").bind(ORG).run()
    const hours = (end: string) => workingWindows(zone, [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '09:00', end })))
    const tuesday = (() => { let date = addLocalDays(localNow(zone).date, 2); while (new Date(`${date}T12:00:00Z`).getUTCDay() !== 2) date = addLocalDays(date, 1); return date })()
    const away = { start: localDateTimeToInstant(tuesday, '09:00', zone).toISOString(), end: localDateTimeToInstant(tuesday, '10:00', zone).toISOString() }
    const write = (end: string, timeOff: Array<{ start: string; end: string }>) => {
      const windows = hours(end)
      return db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, calendar_revision, updated_at, updated_by) VALUES ('host', ?, ?, '[]', ?, ?, ?, 'r', ?, ?)
        ON CONFLICT (member_id) DO UPDATE SET time_off_json = excluded.time_off_json, windows_json = excluded.windows_json`).bind(ORG, zone, JSON.stringify(timeOff), JSON.stringify(windows.intervals), windows.until, NOW, ACTOR).run()
    }
    await write('12:00', [away])
    await db.prepare("UPDATE product_booking_configs SET duration_minutes = 60, default_capacity = 1, held_online = 1, scheduling_mode = 'provider', assigned_member_id = 'host' WHERE product_id = ?").bind(PRODUCT).run()
    await materializeSessions(db, { ...scope, throughDate: addLocalDays(localNow(zone).date, 30) })
    const online = async () => (await db.prepare("SELECT id, starts_at, timezone, assigned_member_id, status FROM product_sessions WHERE location_id IS NULL ORDER BY starts_at").all<{ id: string; starts_at: string; timezone: string; assigned_member_id: string; status: string }>()).results
    const local = (instant: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant))
    const first = await online()
    assert(first.length > 0)
    assert(first.every(session => session.timezone === zone && session.assigned_member_id === 'host'), 'each slot is the provider\'s, in their zone')
    assert.deepEqual([...new Set(first.map(session => local(session.starts_at)))].sort(), ['09:00', '10:00', '11:00'], 'hourly slots across 09:00–12:00 local')
    assert.equal(first.some(session => session.starts_at === away.start), false, 'time off holds no slot')

    // A guest takes one 11:00 slot; then the provider shortens their day to 10:00.
    const claimed = first.find(session => local(session.starts_at) === '11:00')!
    await claimSessionCapacity(db, { ...scope, sessionId: claimed.id, productVariantId: 'var-adult', partySize: 1 })
    await write('10:00', [away])
    await materializeSessions(db, { ...scope, throughDate: addLocalDays(localNow(zone).date, 30) })
    const shorter = await online()
    assert.equal(shorter.filter(session => session.status === 'scheduled' && local(session.starts_at) === '10:00').length, 0, 'unclaimed slots the hours no longer cover are retired')
    assert.equal(shorter.find(session => session.id === claimed.id)?.status, 'scheduled', 'a claimed slot is a commitment and stays')

    // The longer day comes back: the retired slots reopen in place rather than gaining twins.
    await write('12:00', [away])
    await materializeSessions(db, { ...scope, throughDate: addLocalDays(localNow(zone).date, 30) })
    const restored = await online()
    assert.equal(restored.length, shorter.length, 'no duplicate sessions')
    assert.equal(restored.filter(session => session.status === 'scheduled').length, first.length)
  } finally { await runtime.dispose() }
})
