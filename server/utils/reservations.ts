import { HTTPError } from 'nitro'
import { changeNoticeMinutes, outsideNotice } from '~/shared/availability-settings'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '../db/index.ts'
import { generateReservationTimes, parseOpeningHours, parseSpecialHours, locationAllowsBooking } from '~/shared/reservation-hours'
import { RESERVATION_CAPACITY_CONSUMING_SQL } from '~/shared/bookings'
import { isValidTimezone, localDateTimeToInstant, unresolvableLocalTime } from '~/utils/timezone'
import { requireStripeCheckoutAcceptance } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { formQuestionsRevision, parseStoredFormQuestions, type FormQuestion } from '~/shared/form-questions'
import { prepareFormQuestionsWrite } from '~/server/domain/form-questions'
export { formatBookingPolicySummary as renderBookingPolicySummary } from './booking-policy-summary.ts'
export type {
  FormattedBookingPolicySummary as RenderedBookingPolicySummary,
  FormattedBookingPolicySummaryItem as RenderedBookingPolicySummaryItem,
} from './booking-policy-summary.ts'

/**
 * Location reservation policy.
 *
 * One location, one typed row. There is no site → location → experience
 * cascade any more: the old resolver merged three partial policies field by
 * field, so a single displayed rule could come from any of three places and
 * nobody could say which without re-running the merge. A location either
 * states a rule or does not state it.
 *
 * Product booking policy is not here at all. A product's cancellation terms
 * and preparation notes are typed details on the product, read through the
 * named product detail contract like every other descriptive attribute.
 */

export interface LocationReservationConfig {
  location_id: string
  organization_id: string
  duration_minutes: number
  slot_capacity: number | null
  advance_notice_minutes: number | null
  minimum_guest_age: number | null
  deposit_required: boolean
  deposit_amount: number | null
  deposit_currency: CurrencyCode | null
  deposit_tax_behavior: 'inclusive' | 'exclusive' | null
  deposit_trigger_party_size: number | null
  accessibility_contact_required: boolean
  /** The tenant's own questions asked with each reservation, and the revision a form built from them carries. */
  questions: FormQuestion[]
  questions_revision: string
  created_at: string
  updated_at: string
}

export type LocationReservationConfigPatch = Partial<Omit<LocationReservationConfig,
  'location_id' | 'organization_id' | 'created_at' | 'updated_at' | 'duration_minutes' | 'questions' | 'questions_revision'>> & { duration_minutes?: number | null
    /** The complete replacement question list and the revision it replaces; checked by the writer against the saved list. */
    questions?: unknown; expected_questions_revision?: unknown }

// Ordinary table reservations used two hours before duration became configurable.
export const DEFAULT_RESERVATION_DURATION_MINUTES = 120

const NUMERIC_FIELDS = [
  'duration_minutes', 'slot_capacity', 'advance_notice_minutes', 'minimum_guest_age',
  'deposit_trigger_party_size', 'deposit_amount',
] as const
const BOOLEAN_FIELDS = ['deposit_required', 'accessibility_contact_required'] as const

function mapRow(row: Record<string, unknown>): LocationReservationConfig {
  return {
    location_id: String(row.location_id),
    organization_id: String(row.organization_id),
    duration_minutes: row.duration_minutes === null ? DEFAULT_RESERVATION_DURATION_MINUTES : Number(row.duration_minutes),
    slot_capacity: row.slot_capacity === null ? null : Number(row.slot_capacity),
    advance_notice_minutes: row.advance_notice_minutes === null ? null : Number(row.advance_notice_minutes),
    minimum_guest_age: row.minimum_guest_age === null ? null : Number(row.minimum_guest_age),
    deposit_required: Number(row.deposit_required) === 1,
    deposit_amount: row.deposit_amount === null ? null : Number(row.deposit_amount),
    deposit_currency: row.deposit_currency as CurrencyCode | null,
    deposit_tax_behavior: row.deposit_tax_behavior as LocationReservationConfig['deposit_tax_behavior'],
    deposit_trigger_party_size: row.deposit_trigger_party_size === null ? null : Number(row.deposit_trigger_party_size),
    accessibility_contact_required: Number(row.accessibility_contact_required) === 1,
    ...(() => { const questions = parseStoredFormQuestions(String(row.questions)); return { questions, questions_revision: formQuestionsRevision(questions) } })(),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

/**
 * Read a location's reservation policy.
 *
 * Editors use a missing row to offer setup. Operations that need the policy
 * use requireLocationReservationConfig so its absence is an explicit error.
 */
export async function getLocationReservationConfig(
  db: DbClient,
  input: { organizationId: string; locationId: string },
): Promise<LocationReservationConfig | null> {
  const row = await queryFirst<Record<string, unknown>>(db, `
    SELECT * FROM location_reservation_configs WHERE organization_id = ? AND location_id = ?
  `, [input.organizationId, input.locationId])
  return row ? mapRow(row) : null
}

export async function requireLocationReservationConfig(
  db: DbClient,
  input: { organizationId: string; locationId: string },
): Promise<LocationReservationConfig> {
  const config = await getLocationReservationConfig(db, input)
  if (!config) throw new HTTPError({ statusCode: 404, statusMessage: 'Reservation policy not found', data: { code: 'RESERVATION_POLICY_NOT_FOUND' } })
  return config
}


export async function validateLocationReservationConfigPatch(input: Record<string, unknown>): Promise<LocationReservationConfigPatch> {
  const patch: LocationReservationConfigPatch = {}
  const unknown = Object.keys(input).filter(key => !([...NUMERIC_FIELDS, ...BOOLEAN_FIELDS, 'deposit_currency', 'deposit_tax_behavior', 'questions', 'expected_questions_revision'] as readonly string[]).includes(key))
  if (unknown.length) throw new HTTPError({ statusCode: 400, statusMessage: `Unsupported field${unknown.length > 1 ? 's' : ''}: ${unknown.sort().join(', ')}` })

  for (const field of NUMERIC_FIELDS) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    if (value === null) { patch[field] = null; continue }
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new HTTPError({ statusCode: 400, statusMessage: `${field} must be a non-negative integer or null` })
    }
    patch[field] = value as number
  }
  for (const field of BOOLEAN_FIELDS) {
    if (!Object.hasOwn(input, field)) continue
    if (typeof input[field] !== 'boolean') throw new HTTPError({ statusCode: 400, statusMessage: `${field} must be a boolean` })
    patch[field] = input[field]
  }
  if (patch.deposit_trigger_party_size !== undefined && patch.deposit_trigger_party_size !== null && patch.deposit_trigger_party_size < 1) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'deposit_trigger_party_size must be at least 1' })
  }
  if (patch.duration_minutes !== undefined && patch.duration_minutes !== null && patch.duration_minutes < 1) throw new HTTPError({ statusCode: 400, message: 'duration_minutes must be a positive integer or null' })
  if (patch.deposit_amount !== undefined && patch.deposit_amount !== null && patch.deposit_amount < 1) throw new HTTPError({ statusCode: 400, message: 'deposit_amount must be a positive amount in currency minor units or null' })
  if (Object.hasOwn(input, 'deposit_tax_behavior')) {
    const value = input.deposit_tax_behavior
    if (value !== null && value !== 'inclusive' && value !== 'exclusive') throw new HTTPError({ statusCode: 400, message: 'deposit_tax_behavior must be inclusive, exclusive or null' })
    patch.deposit_tax_behavior = value
  }
  if (Object.hasOwn(input, 'deposit_currency')) {
    const value = input.deposit_currency
    if (value !== null && !isCurrencyCode(value)) throw new HTTPError({ statusCode: 400, message: 'deposit_currency must be a supported currency or null' })
    patch.deposit_currency = value
  }
  if (Object.hasOwn(input, 'expected_questions_revision') && !Object.hasOwn(input, 'questions')) throw new HTTPError({ statusCode: 400, message: 'expected_questions_revision is only sent with questions' })
  if (Object.hasOwn(input, 'questions')) {
    patch.questions = input.questions
    patch.expected_questions_revision = input.expected_questions_revision
  }
  return patch
}

/**
 * Create or amend a location's reservation policy.
 *
 * Creating the row is what enables reservations at that location. Fields the
 * caller omits keep their stored value. A missing or cleared duration uses
 * the ordinary two-hour reservation; null clears other optional rules.
 */
export async function upsertLocationReservationConfig(db: DbClient, input: {
  organizationId: string
  locationId: string
  patch: LocationReservationConfigPatch
  actorId: string
  env: CloudflareEnv
  expectedUpdatedAt?: string | null
}): Promise<LocationReservationConfig> {
  const now = new Date().toISOString()
  const existing = await getLocationReservationConfig(db, input)
  if (existing && existing.updated_at !== input.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, message: 'The reservation policy changed. Read its current updated_at before saving.' })
  const { questions: questionsInput, expected_questions_revision: expectedQuestionsRevision, ...fieldPatch } = input.patch
  const questions = questionsInput === undefined ? existing?.questions ?? [] : prepareFormQuestionsWrite(existing?.questions ?? [], { questions: questionsInput, expectedRevision: expectedQuestionsRevision })
  const { questions: _savedQuestions, questions_revision: _savedRevision, ...existingFields } = existing ?? { questions: [], questions_revision: '' }
  const merged: LocationReservationConfigPatch = { advance_notice_minutes: 0, ...existingFields, ...fieldPatch }
  merged.duration_minutes ??= DEFAULT_RESERVATION_DURATION_MINUTES
  const missing = [
    ...(merged.deposit_required && !merged.deposit_amount ? ['deposit_amount'] : []),
    ...(merged.deposit_required && !merged.deposit_currency ? ['deposit_currency'] : []),
    ...(merged.deposit_required && !merged.deposit_tax_behavior ? ['deposit_tax_behavior'] : []),
  ]
  if (missing.length) throw new HTTPError({ statusCode: 409, message: 'Reservation setup is incomplete', data: { code: 'RESERVATION_SETUP_INCOMPLETE', missing } })
  if (merged.deposit_required) {
    if (!input.env.STRIPE_SECRET_KEY) throw new HTTPError({ statusCode: 503, message: 'Payments provider configuration is incomplete' })
    await requireStripeCheckoutAcceptance(db, input.env, input.organizationId)
  }
  const results = await executeBatch(db, [{
    query: `
      INSERT INTO location_reservation_configs (
        location_id, organization_id, duration_minutes, slot_capacity, advance_notice_minutes, minimum_guest_age,
        deposit_required, deposit_amount, deposit_currency, deposit_tax_behavior, deposit_trigger_party_size, accessibility_contact_required, questions, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (location_id) DO UPDATE SET
        duration_minutes = excluded.duration_minutes, slot_capacity = excluded.slot_capacity, advance_notice_minutes = excluded.advance_notice_minutes,
        minimum_guest_age = excluded.minimum_guest_age, deposit_required = excluded.deposit_required,
        deposit_amount = excluded.deposit_amount, deposit_currency = excluded.deposit_currency, deposit_tax_behavior = excluded.deposit_tax_behavior,
        deposit_trigger_party_size = excluded.deposit_trigger_party_size,
        accessibility_contact_required = excluded.accessibility_contact_required, questions = excluded.questions,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by
      WHERE location_reservation_configs.organization_id = excluded.organization_id AND location_reservation_configs.updated_at = ?
    `,
    params: [
      input.locationId, input.organizationId, merged.duration_minutes,
      merged.slot_capacity ?? null, merged.advance_notice_minutes ?? null, merged.minimum_guest_age ?? null,
      (merged.deposit_required ?? false) ? 1 : 0, merged.deposit_amount ?? null, merged.deposit_currency ?? null, merged.deposit_tax_behavior ?? null, merged.deposit_trigger_party_size ?? null,
      (merged.accessibility_contact_required ?? false) ? 1 : 0, JSON.stringify(questions), now, now, input.actorId, input.actorId, existing?.updated_at ?? null,
    ],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'reservation-policy-updated')], { operation: 'Upsert location reservation config' })
  if (results[0]?.meta.changes !== 1) throw new HTTPError({ statusCode: 409, message: 'The reservation policy changed before saving. Read it again.' })
  return requireLocationReservationConfig(db, input)
}

export async function deleteLocationReservationConfig(db: DbClient, input: { organizationId: string; locationId: string }): Promise<void> {
  // Removing the policy removes the capability, and takes its date overrides
  // with it. Existing reservations keep their own records.
  await executeBatch(db, [{
    query: 'DELETE FROM location_reservation_configs WHERE organization_id = ? AND location_id = ?',
    params: [input.organizationId, input.locationId],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'reservation-policy-deleted')], { operation: 'Delete location reservation config' })
}

/** The summary renderer speaks in the shared shape, whatever the source. */
export function reservationPolicySummarySource(config: LocationReservationConfig) {
  return {
    policy_type: 'reservation' as const,
    advance_notice_minutes: config.advance_notice_minutes,
    deposit_required: config.deposit_required,
    deposit_amount: config.deposit_amount,
    deposit_currency: config.deposit_currency,
    deposit_tax_behavior: config.deposit_tax_behavior,
    deposit_trigger_party_size: config.deposit_trigger_party_size,
    minimum_guest_age: config.minimum_guest_age,
    accessibility_contact_required: config.accessibility_contact_required,
  }
}

/** A visit with no saved terms of its own: the one cancellation rule, nothing else. */
/** A class's or consultation's notice is its product's; a reservation's terms are its own snapshot. */
export function visitPolicySummarySource(policyType: 'reservation' | 'experience', advanceNoticeMinutes: number | null) {
  return {
    policy_type: policyType,
    advance_notice_minutes: advanceNoticeMinutes,
    deposit_required: null,
    deposit_trigger_party_size: null,
    minimum_guest_age: null,
    accessibility_contact_required: null,
  }
}

// ---------------------------------------------------------------------------
// Reservation availability and claiming.
//
// A reservation has no materialized occurrence: a restaurant does not schedule
// dinners the way a studio schedules classes. Slots are computed from the
// location's opening hours, narrowed by its date overrides, and capacity is
// per START-TIME SLOT — the contract chosen once here and not re-decided by
// each caller.
//
// This is deliberately NOT the session code under another name. There is no
// generation, no occurrence key, and nothing to regenerate.
// ---------------------------------------------------------------------------

export interface ReservationSlot {
  time_slot: string
  starts_at: string
  capacity: number | null
  claimed: number
  remaining: number | null
  is_closed: boolean
  is_full: boolean
}

interface LocationHoursRow {
  id: string
  organization_id: string
  timezone: string | null
  status: string
  opening_hours: string | null
  special_hours: string | null
}

export async function listReservationSlots(db: DbClient, input: {
  organizationId: string
  locationId: string
  date: string
  includePast?: boolean
  excludeReservationId?: string | null
}): Promise<{ timezone: string; slots: ReservationSlot[]; unresolvable: Array<{ time_slot: string; reason: 'nonexistent_local_time' | 'ambiguous_local_time' }> }> {
  const location = await queryFirst<LocationHoursRow>(db, `
    SELECT id, organization_id, timezone, status, opening_hours, special_hours
      FROM business_locations WHERE organization_id = ? AND id = ?
  `, [input.organizationId, input.locationId])
  if (!location) throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  if (!isValidTimezone(location.timezone)) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Reservation setup is incomplete', data: { code: 'RESERVATION_SETUP_INCOMPLETE', missing: ['location.timezone'] } })
  }
  const timezone = location.timezone
  const config = await requireLocationReservationConfig(db, input)
  const durationMinutes = config.duration_minutes

  const hours = parseOpeningHours(location.opening_hours ? JSON.parse(location.opening_hours) : null)
  const special = parseSpecialHours(location.special_hours ? JSON.parse(location.special_hours) : null)
  const scheduled = generateReservationTimes(hours, input.date, { specialHours: special })

  const claims = await queryAll<{ starts_at: string; total: number }>(db, `
    SELECT starts_at, SUM(quantity) AS total FROM (
      SELECT r.starts_at, r.party_size AS quantity FROM reservations r
      WHERE r.organization_id = ? AND r.location_id = ? AND ${RESERVATION_CAPACITY_CONSUMING_SQL} AND r.id IS NOT ?
      UNION ALL
      SELECT h.starts_at, h.quantity FROM payment_checkout_holds h
      WHERE h.organization_id = ? AND h.location_id = ? AND h.product_id IS NULL AND h.status = 'active'
        AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ) GROUP BY starts_at
  `, [input.organizationId, input.locationId, input.excludeReservationId ?? null, input.organizationId, input.locationId])
  const claimedByInstant = new Map(claims.map(row => [row.starts_at, Number(row.total)]))

  const closedAllDay = location.status !== 'active'
  const slots: ReservationSlot[] = []
  const unresolvable: Array<{ time_slot: string; reason: 'nonexistent_local_time' | 'ambiguous_local_time' }> = []
  for (const time of scheduled) {
    // A local time that never happens on this date (a spring-forward gap) or
    // happens twice (a fall-back fold) is not offered; picking one would book a
    // guest at a time nobody chose. The booking endpoint names which it is.
    const reason = unresolvableLocalTime(input.date, time, timezone)
    if (reason) { unresolvable.push({ time_slot: time, reason }); continue }
    const startsAt = localDateTimeToInstant(input.date, time, timezone, 'reject').toISOString()
    // Advance notice is the policy the guest reads, applied: a start inside the
    // notice is not offered, and the booking endpoint reads the same list.
    if (!input.includePast && !outsideNotice(startsAt, config.advance_notice_minutes)) continue

    if (!locationAllowsBooking({ starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString() }, location)) continue
    const capacity = config.slot_capacity
    const claimed = claimedByInstant.get(startsAt) ?? 0
    const remaining = capacity === null ? null : capacity - claimed
    slots.push({
      time_slot: time, starts_at: startsAt, capacity, claimed, remaining,
      is_closed: closedAllDay, is_full: remaining !== null && remaining <= 0,
    })
  }
  return { timezone, slots, unresolvable }
}

export class ReservationUnavailableError extends Error {
  constructor(message = 'That time is no longer available') {
    super(message)
    this.name = 'ReservationUnavailableError'
  }
}

/** Changes close when free cancellation does, unless the business approves an exception. A reservation's notice is null. */
export function visitReschedulePolicyPredicate(input: { startsAt: string; advanceNoticeMinutes: number | null; overridePolicy?: boolean }): BatchQuery {
  if (input.overridePolicy) return { query: '1', params: [] }
  return { query: `julianday('now') <= julianday(?) - ${changeNoticeMinutes(input.advanceNoticeMinutes)} / 1440.0`, params: [input.startsAt] }
}

/** The same location, hours and capacity boundary for a seat claim and a Checkout hold. */
export async function reservationAllocationPredicate(db: DbClient, input: {
  organizationId: string; locationId: string; timezone: string; startsAt: string; endsAt: string; partySize: number
  replacingReservationId?: string; chargedPaymentId?: string; chargedAt?: string; policyUpdatedAt?: string
}): Promise<BatchQuery> {
  const location = await queryFirst<LocationHoursRow>(db, 'SELECT id, organization_id, timezone, status, opening_hours, special_hours FROM business_locations WHERE id = ? AND organization_id = ?', [input.locationId, input.organizationId])
  if (!location || location.timezone !== input.timezone || !locationAllowsBooking({ starts_at: input.startsAt, ends_at: input.endsAt }, location)) return { query: '0', params: [] }
  const payment = input.chargedPaymentId ? `EXISTS (
    SELECT 1 FROM payment_checkout_holds h JOIN payments p ON p.id = h.payment_id
    WHERE h.payment_id = ? AND h.organization_id = c.organization_id AND h.location_id = c.location_id
      AND p.organization_id = c.organization_id AND p.subject_type = 'reservation'
      AND p.refunded_amount = 0 AND h.product_id IS NULL
      AND h.starts_at = ? AND h.ends_at = ? AND h.timezone = ? AND h.quantity = ?
      AND h.status IN ('active', 'released') AND ? <= h.expires_at
  )` : input.replacingReservationId ? `EXISTS (SELECT 1 FROM reservations original
    WHERE original.id = ? AND original.organization_id = c.organization_id AND original.status = 'confirmed'
      AND unixepoch(original.ends_at) - unixepoch(original.starts_at) = unixepoch(?) - unixepoch(?))`
    : `COALESCE(c.duration_minutes, ${DEFAULT_RESERVATION_DURATION_MINUTES}) > 0
      AND strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || COALESCE(c.duration_minutes, ${DEFAULT_RESERVATION_DURATION_MINUTES}) || ' minutes') = ?
      AND julianday(?) > julianday('now') + COALESCE(c.advance_notice_minutes, 0) / 1440.0`
  return {
    query: `EXISTS (SELECT 1 FROM location_reservation_configs c
      JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id
      WHERE c.location_id = ? AND c.organization_id = ? AND l.status = 'active'
        AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?
        AND julianday(?) > julianday('now') AND (${payment})
        ${input.policyUpdatedAt ? 'AND c.updated_at = ?' : ''}
        AND (c.slot_capacity IS NULL OR c.slot_capacity >= ? +
          COALESCE((SELECT SUM(r.party_size) FROM reservations r WHERE r.organization_id = c.organization_id
            AND r.location_id = c.location_id AND r.starts_at = ? AND r.id IS NOT ? AND ${RESERVATION_CAPACITY_CONSUMING_SQL}), 0) +
          COALESCE((SELECT SUM(h.quantity) FROM payment_checkout_holds h WHERE h.organization_id = c.organization_id
            AND h.location_id = c.location_id AND h.starts_at = ? AND h.product_id IS NULL
            AND h.payment_id IS NOT ? AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 0))
    )`,
    params: [input.locationId, input.organizationId, location.timezone, location.opening_hours, location.special_hours, input.startsAt,
      ...(input.chargedPaymentId ? [input.chargedPaymentId, input.startsAt, input.endsAt, input.timezone, input.partySize, input.chargedAt ?? ''] : input.replacingReservationId ? [input.replacingReservationId, input.endsAt, input.startsAt] : [input.startsAt, input.endsAt, input.startsAt]),
      ...(input.policyUpdatedAt ? [input.policyUpdatedAt] : []), input.partySize, input.startsAt, input.replacingReservationId ?? null, input.startsAt, input.chargedPaymentId ?? null],
  }
}

export interface ReservationClaimInput {
  organizationId: string; locationId: string; reservationId: string; requestId: string | null; userId: string | null
  timezone: string; startsAt: string; endsAt: string; date: string; timeSlot: string; partySize: number
  chargedPaymentId?: string; chargedAt?: string
  thread?: BatchQuery[]
}

export async function reservationClaimQuery(db: DbClient, input: ReservationClaimInput): Promise<BatchQuery> {
  if (!Number.isSafeInteger(input.partySize) || input.partySize < 1) throw new HTTPError({ statusCode: 400, statusMessage: 'party_size must be a positive integer' })
  const allocation = await reservationAllocationPredicate(db, input)
  const now = new Date().toISOString()
  const terms = input.chargedPaymentId
    ? `SELECT json_extract(price_snapshot_json, '$.reservation') FROM payments WHERE id = ? AND organization_id = ?`
    : `SELECT json_object('policy_type','reservation','advance_notice_minutes',advance_notice_minutes,'minimum_guest_age',minimum_guest_age,
        'deposit_required',json(CASE deposit_required WHEN 1 THEN 'true' ELSE 'false' END),'deposit_amount',deposit_amount,'deposit_currency',deposit_currency,'deposit_tax_behavior',deposit_tax_behavior,'deposit_trigger_party_size',deposit_trigger_party_size,
        'accessibility_contact_required',json(CASE accessibility_contact_required WHEN 1 THEN 'true' ELSE 'false' END)) FROM location_reservation_configs WHERE location_id = ? AND organization_id = ?`
  return {
    query: `INSERT INTO reservations (id, organization_id, location_id, user_id, request_id, timezone, starts_at, ends_at, party_size, policy_json, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, (${terms}), 'confirmed', ?, ? WHERE ${allocation.query}
        ${input.chargedPaymentId ? '' : `AND EXISTS (SELECT 1 FROM location_reservation_configs c WHERE c.organization_id = ? AND c.location_id = ? AND (c.deposit_required = 0 OR (c.deposit_trigger_party_size IS NOT NULL AND ? < c.deposit_trigger_party_size)))`}
      ON CONFLICT (id) DO NOTHING`,
    params: [input.reservationId, input.organizationId, input.locationId, input.userId, input.requestId, input.timezone, input.startsAt, input.endsAt, input.partySize, input.chargedPaymentId ?? input.locationId, input.organizationId, now, now,
      ...allocation.params!, ...(input.chargedPaymentId ? [] : [input.organizationId, input.locationId, input.partySize])],
  }
}

/**
 * Claim a reservation slot.
 *
 * One statement carries its own capacity predicate, so two parties competing
 * for the last table cannot both succeed. `following` runs in the same batch,
 * which is how the inbox thread and the reservation commit together.
 */
export async function claimReservation(db: DbClient, input: ReservationClaimInput): Promise<void> {
  const claim = await reservationClaimQuery(db, { ...input, requestId: null })
  const now = new Date().toISOString()
  // The reservation takes its request id once the thread it answers exists.
  const attach: BatchQuery[] = input.requestId
    ? [{
        query: `UPDATE reservations SET request_id = ?, updated_at = ?
                 WHERE id = ? AND EXISTS (SELECT 1 FROM requests WHERE id = ?)`,
        params: [input.requestId, now, input.reservationId, input.requestId],
      }]
    : []
  const results = await executeBatch(db, [claim, ...(input.thread ?? []), ...attach], { operation: 'Claim reservation' })
  if ((results[0]?.meta?.changes ?? 0) === 0) throw new ReservationUnavailableError()
}
