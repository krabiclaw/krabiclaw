import { createHash } from 'node:crypto'
import { assertResponsibleMember } from '~/server/utils/member-access'
import { sessionPrepTaskQueries } from '~/server/domain/tasks'
import { publishAccessInvalidation, publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { assertPublishedHost } from '~/server/utils/public-provider'
import { creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { d1JsonValue, MAX_D1_BATCH_STATEMENTS } from '~/server/db/d1-limits'
import { getDateIntervals, locationAllowsBooking, parseOpeningHours, parseSpecialHours, toTimeString } from '~/shared/reservation-hours'
import { providerAvailabilityParams, providerMemberSql, providerUnavailableSql } from '~/server/utils/provider-allocation'
import { memberAvailabilityJson, memberBusy, workingWindows } from '~/server/domain/member-scheduling'
import type { CloudflareEnv } from '~/server/utils/auth'
import { PUBLISHED_PROFILE_SQL, type SchedulingInterval, type WorkingHours } from '~/shared/member-scheduling'
import { outsideNotice } from '~/shared/availability-settings'
import { HTTPError } from 'nitro'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import {
  AVAILABILITY_PAGE_DAYS,
  CAPACITY_CONSUMING_SQL,
  PRODUCT_SESSION_STATUSES,
  occurrenceKey,
  parseStayCalendarRules,
  BOOKING_HORIZON_DAYS,
  type StayCalendarRules,
  type ProductSessionStatus,
} from '~/shared/bookings'
import { formQuestionsRevision, parseStoredFormQuestions, type FormAnswerSnapshot, type FormQuestion } from '~/shared/form-questions'
import type { StayCancellationPolicy, StayLongTermCancellationPolicy } from '~/shared/stay-listing'
import { prepareFormQuestionsWrite } from '~/server/domain/form-questions'
import { addLocalDays, assertCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant, localNow, MINUTE_TIME_PATTERN } from '~/utils/timezone'

/**
 * The booking capability.
 *
 * A product's configuration and schedule determine the times guests see.
 * A saved session records a dated time, a schedule edit or a claim against
 * one occurrence. A booking claims seats on that session.
 *
 * A restaurant's tables are a `table` product booked the same way. It has no
 * rules: its seatings are its location's current opening and special hours,
 * cut by `tableSeatings`, and a booking claims that seating's seats.
 */

/** Why a table takes no weekly times, dated sessions or per-seating edits. */
const TABLE_HOURS_ONLY = 'A table is seated through its location\'s opening hours. Change those hours, or add special hours or a closure, to change when tables can be booked'

function badRequest(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

export function assertAvailabilityDate(value: string, field = 'date'): void {
  try { assertCalendarDate(value) }
  catch { badRequest(`${field} must be a valid YYYY-MM-DD date`) }
}

/** What a booking claims: a session's seats, or a home's whole nights. */
export type BookingUnit = 'slot' | 'nights'
const BOOKING_UNITS: Record<string, BookingUnit> = { experience: 'slot', service: 'slot', table: 'slot', stay: 'nights' }

/** A home's night settings, null on every slot unit. */
export const NIGHTS_BOOKING_FIELDS = ['check_in_time', 'check_in_end_time', 'check_out_time', 'min_nights', 'calendar_rules', 'cancellation_policy', 'long_term_cancellation_policy'] as const
export interface NightsBookingSettings {
  check_in_time: string | null
  /** Null is a flexible end. */
  check_in_end_time: string | null
  check_out_time: string | null
  min_nights: number | null
  calendar_rules: Omit<StayCalendarRules, 'weekend_price_minor'> | null
  cancellation_policy: StayCancellationPolicy | null
  long_term_cancellation_policy: StayLongTermCancellationPolicy | null
}

export interface ProductBookingConfigRecord extends NightsBookingSettings {
  product_id: string
  organization_id: string
  unit: BookingUnit
  duration_minutes: number | null
  /** A table's minutes between seating starts through its location's hours; null for every other product. */
  seating_interval_minutes: number | null
  default_capacity: number | null
  confirmation_mode: 'instant' | 'review'
  online_payment_required: boolean
  /** Sessions come from each provider's working hours, in that provider's timezone. */
  held_online: boolean
  scheduling_mode: 'business' | 'provider'
  assigned_member_id: string | null
  /** How long before a start booking, changing and the guest's own cancellation close; null is no notice. */
  advance_notice_minutes: number | null
  /** The tenant's own questions asked with each booking, and the revision a form built from them carries. */
  questions: FormQuestion[]
  questions_revision: string
  /** The smallest and largest party one booking takes; null does not limit it beyond the seats. */
  party_size_min: number | null
  party_size_max: number | null
  minimum_guest_age: number | null
  accessibility_contact_required: boolean
  /** What an online payment's price is charged for: each guest, or the booking as a whole. */
  payment_basis: PaymentBasis
  /** The smallest party that pays online; null is every party. */
  payment_min_party_size: number | null
}

export const PAYMENT_BASES = ['per_guest', 'per_booking'] as const
export type PaymentBasis = typeof PAYMENT_BASES[number]

/** Whether a party of this size pays online for this offering. */
export function partyPaysOnline(config: Pick<ProductBookingConfigRecord, 'online_payment_required' | 'payment_min_party_size'>, partySize: number): boolean {
  return config.online_payment_required && (config.payment_min_party_size === null || partySize >= config.payment_min_party_size)
}

/** How many units of the price a party pays for. */
export function paidQuantity(config: Pick<ProductBookingConfigRecord, 'payment_basis'>, partySize: number): number {
  return config.payment_basis === 'per_booking' ? 1 : partySize
}

/** The party limits as a refusal the guest can act on, or null when the party fits. */
export function partySizeRefusal(config: Pick<ProductBookingConfigRecord, 'party_size_min' | 'party_size_max'>, partySize: number): string | null {
  if (config.party_size_min !== null && partySize < config.party_size_min) return `This booking is for parties of at least ${config.party_size_min}.`
  if (config.party_size_max !== null && partySize > config.party_size_max) return `This booking is for parties of up to ${config.party_size_max}. Contact the business for a larger party.`
  return null
}

/** A weekly start time at a location. `capacity` null is the configuration's default_capacity. */
export interface ProductAvailabilityRule {
  id: string
  organization_id: string
  product_id: string
  location_id: string
  timezone: string
  weekday: number
  start_time: string
  capacity: number | null
}

export interface ProductSession {
  id: string
  organization_id: string
  product_id: string
  location_id: string | null
  availability_rule_id: string | null
  source_occurrence_key: string | null
  timezone: string
  starts_at: string
  ends_at: string
  capacity: number | null
  status: ProductSessionStatus
  /** When the occurrence came into existence, which is when its seats went on sale. */
  created_at: string
  updated_at: string
  created_by: string
  updated_by: string
}

/** A session with its claimed seats resolved. `remaining` is null when uncapped. */
export interface SessionAvailability extends ProductSession {
  claimed: number
  remaining: number | null
  is_full: boolean
}

/** Projected openings have no saved timestamps or authors. */
type SessionFacts = Omit<ProductSession, 'created_at' | 'updated_at' | 'created_by' | 'updated_by'> & {
  created_at: string | null
  updated_at: string | null
  created_by: string | null
  updated_by: string | null
}
export type BookableSession = SessionFacts & Pick<SessionAvailability, 'claimed' | 'remaining' | 'is_full'>

function requireConsultationAttorney(kind: string, config: Pick<ProductBookingConfigRecord, 'scheduling_mode' | 'assigned_member_id'>): void {
  if (kind !== 'service') return
  if (config.scheduling_mode !== 'provider' || !config.assigned_member_id) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Choose an attorney and use their working hours before taking new legal consultation requests.',
      data: { code: 'ATTORNEY_REQUIRED', field: config.scheduling_mode !== 'provider' ? 'scheduling_mode' : 'host' } })
  }
}

export async function requireBookingConfig(
  db: DbClient,
  organizationId: string,
  productId: string,
): Promise<ProductBookingConfigRecord> {
  const row = await queryFirst<StoredBookingConfig & { product_kind: string }>(db, `
    SELECT ${BOOKING_CONFIG_COLUMNS.map(column => `c.${column}`).join(', ')}, p.kind product_kind
    FROM product_booking_configs c JOIN products p ON p.id=c.product_id AND p.organization_id=c.organization_id WHERE c.organization_id = ? AND c.product_id = ?
  `, [organizationId, productId])
  // The absence of a config row means the product does not take bookings. It
  // is not a product with unknown booking settings.
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'This product does not take bookings' })
  const { product_kind: kind, ...stored } = row
  const config = bookingConfigRecord(stored)
  requireConsultationAttorney(kind, config)
  return config
}

/** The booking terms any offering may set, beside its schedule. */
const GUEST_TERMS_FIELDS = ['party_size_min', 'party_size_max', 'minimum_guest_age', 'accessibility_contact_required', 'payment_basis', 'payment_min_party_size'] as const
const BOOKING_CONFIG_COLUMNS = ['product_id', 'organization_id', 'unit', 'duration_minutes', 'seating_interval_minutes', 'default_capacity', 'confirmation_mode', 'online_payment_required', 'held_online', 'scheduling_mode', 'assigned_member_id', 'advance_notice_minutes', 'questions', ...GUEST_TERMS_FIELDS, ...NIGHTS_BOOKING_FIELDS] as const
type StoredBookingConfig = Omit<ProductBookingConfigRecord, 'online_payment_required' | 'held_online' | 'accessibility_contact_required' | 'questions' | 'questions_revision' | 'calendar_rules'> & { online_payment_required: number; held_online: number; accessibility_contact_required: number; questions: string; calendar_rules: string | null }

/** A stored configuration row as its record; a unit outside the known set is a corrupt row, not a default. */
export function bookingConfigRecord(row: StoredBookingConfig): ProductBookingConfigRecord {
  if (row.unit !== 'slot' && row.unit !== 'nights') throw new Error(`Product ${row.product_id} has an unknown booking unit`)
  if (!(PAYMENT_BASES as readonly string[]).includes(row.payment_basis)) throw new Error(`Product ${row.product_id} has an unknown payment basis`)
  const questions = parseStoredFormQuestions(row.questions)
  return {
    ...row, online_payment_required: Number(row.online_payment_required) === 1, held_online: Number(row.held_online) === 1,
    accessibility_contact_required: Number(row.accessibility_contact_required) === 1,
    min_nights: row.min_nights === null ? null : Number(row.min_nights),
    calendar_rules: parseStayCalendarRules(row.calendar_rules === null ? null : JSON.parse(row.calendar_rules)),
    questions, questions_revision: formQuestionsRevision(questions),
  }
}

/** Shared capability writer: omissions retain saved defaults; null clears and capacity zero closes seats. */
export async function prepareProductBookingConfig(db: DbClient, input: {
  organizationId: string; productId: string; actorId: string; env?: import('~/server/utils/auth').CloudflareEnv
  productInSameBatch?: boolean
  productKind?: string
  /**
   * A home's night settings, already checked by the stay writer
   * (product-management planStayConfig); refused for a slot unit.
   */
  patch: { duration_minutes?: unknown; seating_interval_minutes?: unknown; default_capacity?: unknown; confirmation_mode?: unknown; online_payment_required?: unknown; held_online?: unknown; scheduling_mode?: unknown; assigned_member_id?: unknown; advance_notice_minutes?: unknown; questions?: unknown; expected_questions_revision?: unknown }
    & { [K in typeof GUEST_TERMS_FIELDS[number]]?: unknown } & Partial<NightsBookingSettings>
}): Promise<{ queries: BatchQuery[]; config: ProductBookingConfigRecord }> {
  const product = input.productInSameBatch ? null : await requireOrganizationProduct(db, input)
  const kind = product?.kind ?? input.productKind ?? ''
  // The unit follows from what the product is: experiences and consultations sell
  // a session's seats, a home its nights. Every other kind takes no bookings here.
  const unit = Object.hasOwn(BOOKING_UNITS, kind) ? BOOKING_UNITS[kind]! : badRequest(input.productInSameBatch ? 'The bookable product kind is required before preparing booking setup' : 'Only experiences, services, tables and places to stay take bookings')
  const patch = input.patch
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) badRequest('Invalid request body')
  const slotFields = ['duration_minutes', 'seating_interval_minutes', 'confirmation_mode', 'online_payment_required', 'held_online', 'scheduling_mode', 'advance_notice_minutes', 'party_size_min', 'party_size_max', 'payment_basis', 'payment_min_party_size'] as const
  const fields = ['duration_minutes', 'seating_interval_minutes', 'default_capacity', 'confirmation_mode', 'online_payment_required', 'held_online', 'scheduling_mode', 'assigned_member_id', 'advance_notice_minutes', ...GUEST_TERMS_FIELDS, ...NIGHTS_BOOKING_FIELDS] as const
  if (Object.keys(patch).some(key => !fields.includes(key as typeof fields[number]) && key !== 'questions' && key !== 'expected_questions_revision')) badRequest('Unknown booking configuration field')
  // The organization owns direct-stay confirmation and payment settings for all its homes.
  if (unit === 'nights' && slotFields.some(field => patch[field] !== undefined)) badRequest('A place to stay is booked by the night; it takes no session length, scheduling, notice, confirmation or payment setting')
  if (unit === 'slot' && NIGHTS_BOOKING_FIELDS.some(field => patch[field] !== undefined)) badRequest('Only a place to stay takes check-in, checkout, minimum nights and cancellation settings')
  if (patch.calendar_rules && 'weekend_price_minor' in patch.calendar_rules) badRequest('Set the weekend price with the home’s pricing settings')
  if (patch.expected_questions_revision !== undefined && patch.questions === undefined) badRequest('expected_questions_revision is only sent with questions')
  for (const field of ['duration_minutes', 'default_capacity', 'advance_notice_minutes', 'minimum_guest_age'] as const) {
    const value = patch[field]
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) badRequest(`${field} must be a non-negative integer or null`)
  }
  for (const field of ['party_size_min', 'party_size_max', 'payment_min_party_size'] as const) {
    const value = patch[field]
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || (value as number) < 1)) badRequest(`${field} must be a positive integer or null`)
  }
  if (patch.accessibility_contact_required !== undefined && typeof patch.accessibility_contact_required !== 'boolean') badRequest('accessibility_contact_required must be boolean')
  if (patch.payment_basis !== undefined && !(PAYMENT_BASES as readonly unknown[]).includes(patch.payment_basis)) badRequest('payment_basis must be per_guest or per_booking')
  if (patch.duration_minutes === 0) badRequest('duration_minutes must be positive')
  if (patch.seating_interval_minutes !== undefined && patch.seating_interval_minutes !== null && kind !== 'table') badRequest('Only a table takes seating_interval_minutes; other offerings start at their weekly times')
  if (patch.seating_interval_minutes !== undefined && patch.seating_interval_minutes !== null && (!Number.isSafeInteger(patch.seating_interval_minutes) || (patch.seating_interval_minutes as number) < 5 || (patch.seating_interval_minutes as number) > 1440)) badRequest('seating_interval_minutes must be a whole number of minutes from 5 to 1440')
  if (patch.confirmation_mode !== undefined && patch.confirmation_mode !== 'instant' && patch.confirmation_mode !== 'review') badRequest('confirmation_mode must be instant or review')
  if (patch.online_payment_required !== undefined && typeof patch.online_payment_required !== 'boolean') badRequest('online_payment_required must be boolean')
  if (unit === 'slot' && patch.online_payment_required === true) {
    if (!input.env) throw new HTTPError({ statusCode: 403, statusMessage: 'Payments entitlement cannot be checked without the configured environment' })
    const { requireStripeCheckoutAcceptance } = await import('~/server/utils/stripe-connect')
    if (!input.env.STRIPE_SECRET_KEY) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured' })
    await requireStripeCheckoutAcceptance(db, input.env, input.organizationId)
  }
  if (patch.held_online !== undefined && typeof patch.held_online !== 'boolean') badRequest('held_online must be boolean')
  const current = await queryFirst<StoredBookingConfig & { updated_at: string }>(db, `SELECT ${BOOKING_CONFIG_COLUMNS.join(',')},updated_at FROM product_booking_configs WHERE organization_id = ? AND product_id = ?`, [input.organizationId, input.productId])
  if (current && current.unit !== unit) throw new Error(`Product ${input.productId} is booked by the ${current.unit} but is a ${kind}`)
  const currentQuestions = current ? parseStoredFormQuestions(current.questions) : []
  const questions = patch.questions === undefined ? currentQuestions : prepareFormQuestionsWrite(currentQuestions, { questions: patch.questions, expectedRevision: patch.expected_questions_revision })
  const heldOnline = patch.held_online === undefined ? current?.held_online === 1 : patch.held_online === true
  if (patch.scheduling_mode !== undefined && !['business', 'provider'].includes(String(patch.scheduling_mode))) badRequest('Invalid scheduling mode')
  const assignedMember = await assertResponsibleMember(db, input.organizationId, patch, current?.assigned_member_id)
  const mode = (patch.scheduling_mode ?? current?.scheduling_mode ?? 'business') as ProductBookingConfigRecord['scheduling_mode']
  requireConsultationAttorney(kind, { scheduling_mode: mode, assigned_member_id: assignedMember })
  // Every booking has a person: the member who handles this product's bookings.
  if (!assignedMember) throw new HTTPError({ statusCode: 422, statusMessage: unit === 'nights' ? 'Choose the member who looks after this home' : 'Choose the member who handles this offering\'s bookings', data: { code: 'ASSIGNEE_REQUIRED', field: 'assigned_member_id' } })
  // The host is the member who runs it; in provider mode their own hours are also the schedule.
  if (mode === 'provider' && !assignedMember) badRequest('Choose the member whose working hours guests book')
  // Online, the provider's own hours are the schedule; there is no business clock to hold it in.
  if (heldOnline && mode !== 'provider') badRequest('An online offering is held by a member: assign who provides it')
  if (patch.scheduling_mode !== undefined || patch.assigned_member_id !== undefined) {
    const { requireSchedulingAccess } = await import('~/server/domain/member-scheduling')
    // All callers of this shared writer must authenticate provider changes.
    const { resolveOrganizationMembership, assertRoleAllows }=await import('~/server/utils/member-access')
    const env=input.env
    if(!env)throw new HTTPError({statusCode:403,message:'Authenticated provider configuration required'})
    const membership=await resolveOrganizationMembership(env,{organizationId:input.organizationId,userId:input.actorId})
    if(!membership)throw new HTTPError({statusCode:403,message:'Organization membership required'})
    await assertRoleAllows({...membership,permissions:{products:['update']}})
    if (assignedMember) await requireSchedulingAccess({ env, userId: input.actorId, organizationId: input.organizationId }, assignedMember, true)
    if (mode === 'provider' && assignedMember && !(await queryFirst(db, 'SELECT member_id FROM member_scheduling WHERE member_id=? AND organization_id=? AND timezone IS NOT NULL', [assignedMember, input.organizationId]))) badRequest('Set working hours for this member before using their hours for bookings')
  }
  const now = new Date().toISOString()
  const saved = current ? bookingConfigRecord(current) : null
  const term = <K extends typeof GUEST_TERMS_FIELDS[number]>(field: K, empty: ProductBookingConfigRecord[K]): ProductBookingConfigRecord[K] => (patch[field] === undefined ? saved?.[field] ?? empty : patch[field]) as ProductBookingConfigRecord[K]
  const guestTerms = {
    minimum_guest_age: term('minimum_guest_age', null), accessibility_contact_required: term('accessibility_contact_required', false),
    ...(unit === 'nights'
      ? { party_size_min: null, party_size_max: null, payment_basis: 'per_guest' as const, payment_min_party_size: null }
      : { party_size_min: term('party_size_min', null), party_size_max: term('party_size_max', null), payment_basis: term('payment_basis', 'per_guest'), payment_min_party_size: term('payment_min_party_size', null) }),
  }
  if (guestTerms.party_size_min !== null && guestTerms.party_size_max !== null && guestTerms.party_size_max < guestTerms.party_size_min) badRequest('party_size_max must be at least party_size_min')
  const night = <K extends typeof NIGHTS_BOOKING_FIELDS[number]>(field: K): ProductBookingConfigRecord[K] => (patch[field] === undefined ? (saved ? saved[field] : null) : patch[field]) as ProductBookingConfigRecord[K]
  const config: ProductBookingConfigRecord = unit === 'nights' ? {
    product_id: input.productId, organization_id: input.organizationId, unit,
    duration_minutes: null, seating_interval_minutes: null,
    default_capacity: patch.default_capacity === undefined ? current?.default_capacity ?? null : patch.default_capacity as number | null,
    confirmation_mode: 'instant', online_payment_required: true, held_online: false, scheduling_mode: 'business', assigned_member_id: assignedMember, advance_notice_minutes: null,
    questions, questions_revision: formQuestionsRevision(questions), ...guestTerms,
    check_in_time: night('check_in_time'), check_in_end_time: night('check_in_end_time'), check_out_time: night('check_out_time'), min_nights: night('min_nights'),
    calendar_rules: night('calendar_rules'), cancellation_policy: night('cancellation_policy'), long_term_cancellation_policy: night('long_term_cancellation_policy'),
  } : {
    product_id: input.productId, organization_id: input.organizationId, unit,
    check_in_time: null, check_in_end_time: null, check_out_time: null, min_nights: null, calendar_rules: null, cancellation_policy: null, long_term_cancellation_policy: null,
    duration_minutes: patch.duration_minutes === undefined ? current?.duration_minutes ?? null : patch.duration_minutes as number | null,
    seating_interval_minutes: patch.seating_interval_minutes === undefined ? current?.seating_interval_minutes ?? null : patch.seating_interval_minutes as number | null,
    default_capacity: patch.default_capacity === undefined ? current?.default_capacity ?? null : patch.default_capacity as number | null,
    confirmation_mode: (patch.confirmation_mode ?? current?.confirmation_mode ?? 'instant') as ProductBookingConfigRecord['confirmation_mode'],
    online_payment_required: patch.online_payment_required === undefined ? current?.online_payment_required === 1 : patch.online_payment_required === true,
    held_online: heldOnline,
    scheduling_mode: mode, assigned_member_id: assignedMember,
    // Zero is no notice, stored as null.
    advance_notice_minutes: patch.advance_notice_minutes === undefined ? current?.advance_notice_minutes ?? null : (patch.advance_notice_minutes as number | null) || null,
    questions, questions_revision: formQuestionsRevision(questions), ...guestTerms,
  }
  // A table is seated every interval through its location's hours; without one it has no seatings.
  if (kind === 'table' && (config.seating_interval_minutes === null || config.duration_minutes === null)) badRequest('Choose how long a table is held and how often one can be seated (duration_minutes and seating_interval_minutes)')
  if (config.duration_minutes === null && product?.kind === 'experience' && !product.order_url && product.publications.some(publication => publication.published)) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Keep a session duration for a published experience. Withhold the experience before clearing its booking setup.' })
  }
  const stored = (record: ProductBookingConfigRecord | StoredBookingConfig, field: typeof fields[number]): unknown => {
    const value = record[field]
    if (field === 'calendar_rules') return value === null || typeof value === 'string' ? value : JSON.stringify(value)
    return typeof value === 'boolean' ? (value ? 1 : 0) : value
  }
  const unchanged: BatchQuery = current
    ? { query: `EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.product_id=? AND c.organization_id=? AND c.updated_at=? AND c.questions IS ? AND ${fields.map(field => `c.${field} IS ?`).join(' AND ')})`, params: [input.productId, input.organizationId, current.updated_at, current.questions, ...fields.map(field => stored(current, field))] }
    : { query: 'NOT EXISTS (SELECT 1 FROM product_booking_configs WHERE product_id=?)', params: [input.productId] }
  const reassigned = current !== undefined && current !== null && current.assigned_member_id !== config.assigned_member_id
  // A rejected configuration must abort the entire native D1 batch, including
  // its sessions and publication. An INSERT ... SELECT that selects no row
  // would instead let those other writes commit.
  return { config, queries: [
    // A home's open cleaning jobs are its assignee's: a new assignee takes them over,
    // read against the assignee this write replaces.
    ...(reassigned ? [{
      query: `UPDATE tasks SET assigned_member_id = ?, version = version + 1, updated_at = ?
        WHERE organization_id = ? AND product_id = ? AND status = 'open' AND kind IN ('turnover', 'stay_ready') AND assigned_member_id IS NOT ?
          AND EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.organization_id = ? AND c.product_id = ? AND c.assigned_member_id IS ?)`,
      params: [config.assigned_member_id, now, input.organizationId, input.productId, config.assigned_member_id, input.organizationId, input.productId, current!.assigned_member_id],
    }] : []), {
    query: `INSERT INTO product_booking_configs (product_id, organization_id, unit, ${fields.join(', ')}, questions, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ${fields.map(() => '?').join(', ')}, ?, ?, CASE WHEN (${unchanged.query})
        AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM products p JOIN product_publications pub ON pub.product_id=p.id AND pub.organization_id=p.organization_id WHERE p.id=? AND p.organization_id=? AND p.kind='experience' AND NULLIF(p.order_url,'') IS NULL AND pub.published=1))
        AND (?<>'provider' OR EXISTS (SELECT 1 FROM member_scheduling ms WHERE ms.member_id=? AND ms.organization_id=? AND ms.timezone IS NOT NULL))
        THEN ? ELSE NULL END, ?, ?)
      ON CONFLICT (product_id) DO UPDATE SET
        ${fields.map(field => `${field}=excluded.${field}`).join(', ')}, questions=excluded.questions,
        updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    params: [input.productId, input.organizationId, unit, ...fields.map(field => stored(config, field)), JSON.stringify(questions), now,
      ...unchanged.params!, config.duration_minutes, input.productId, input.organizationId, config.scheduling_mode, config.assigned_member_id, input.organizationId,
      now, input.actorId, input.actorId],
  }, ...(unit === 'slot' && reassigned ? sessionPrepTaskQueries({
    query: 'SELECT id FROM product_sessions WHERE organization_id = ? AND product_id = ?',
    params: [input.organizationId, input.productId],
  }, now) : [])] }
}

export function bookingConfigurationWriteError(error: unknown): unknown {
  if (!/NOT NULL constraint failed: product_booking_configs\.updated_at/.test(error instanceof Error ? error.message : String(error))) return error
  return new HTTPError({ statusCode: 409, statusMessage: 'The booking settings conflict or none of the requested times can be booked with the current hours, providers and calendars. Nothing was changed; review availability before saving.', cause: error })
}

export async function setProductBookingConfig(db: DbClient, input: Omit<Parameters<typeof prepareProductBookingConfig>[1], 'productInSameBatch'>): Promise<ProductBookingConfigRecord> {
  const named = Object.entries(input.patch).filter(([, value]) => value !== undefined).map(([key]) => key)
  // A home's nights, times and cancellation are its stay settings: their writer also tells its channels.
  if (NIGHTS_BOOKING_FIELDS.some(field => input.patch[field] !== undefined)) badRequest('Change a home\'s check-in, checkout, minimum nights and cancellation in its stay settings')
  const questionsOnly = named.length > 0 && named.every(key => key === 'questions' || key === 'expected_questions_revision')
  // Questions belong to an existing booking setup; they never create one.
  if (questionsOnly && !await queryFirst(db, 'SELECT 1 FROM product_booking_configs WHERE organization_id = ? AND product_id = ?', [input.organizationId, input.productId])) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'This product does not take bookings. Set up its booking before adding questions.', data: { code: 'BOOKING_CONFIG_NOT_FOUND', field: 'product_id' } })
  }
  const { queries: configQueries } = await prepareProductBookingConfig(db, input)
  // Questions are not scheduling: a question-only edit writes the questions and
  // leaves every session, rule and provider-hours occurrence where it was.
  if (questionsOnly) {
    await executeBatch(db, [...configQueries, publicResourceCacheInvalidationQuery(input.organizationId, 'product-booking-questions')], { operation: 'Set product booking questions' }).catch(error => { throw bookingConfigurationWriteError(error) })
    return requireBookingConfig(db, input.organizationId, input.productId)
  }
  const paymentEnabled = input.patch.online_payment_required === true
  const queries = [...configQueries, publicResourceCacheInvalidationQuery(input.organizationId, 'product-booking-config')]
  if (queries.length > MAX_D1_BATCH_STATEMENTS) badRequest('This schedule exceeds one atomic update; reduce the requested times')
  await executeBatch(db, queries, { operation: 'Set product booking config' }).catch(error => { throw bookingConfigurationWriteError(error) })
  if (input.patch.assigned_member_id !== undefined) {
    if (!input.env) throw new HTTPError({ statusCode: 503, message: 'The saved responsibility requires its organization environment', data: { code: 'ORGANIZATION_ENVIRONMENT_REQUIRED', field: 'env', committed: true } })
    await publishAccessInvalidation(input.env, { organizationId: input.organizationId })
  }
  if (paymentEnabled) await publishBusinessInvalidation(input.env!, input.organizationId)
  return requireBookingConfig(db, input.organizationId, input.productId)
}

export async function deleteProductBookingConfig(db: DbClient, input: { organizationId: string; productId: string }): Promise<void> {
  const product = await requireOrganizationProduct(db, input)
  if (product.kind === 'experience' && !product.order_url && product.publications.some(publication => publication.published)) throw new HTTPError({ statusCode: 409, statusMessage: 'Withhold this experience before removing its booking setup' })
  const booked = await queryFirst<{ n: number }>(db, 'SELECT count(*) AS n FROM bookings WHERE organization_id = ? AND product_id = ?', [input.organizationId, input.productId])
  if ((booked?.n ?? 0) > 0) throw new HTTPError({ statusCode: 409, statusMessage: 'This product has bookings. Leave bookings on and turn the product off instead.' })
  await executeBatch(db, [{
    query: `DELETE FROM product_booking_configs WHERE organization_id = ? AND product_id = ?
      AND NOT EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND product_id = ?)`,
    params: [input.organizationId, input.productId, input.organizationId, input.productId],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'product-booking-config-delete')], { operation: 'Remove product booking config' })
  const remaining = await queryFirst<{ product_id: string }>(db, 'SELECT product_id FROM product_booking_configs WHERE organization_id = ? AND product_id = ?', [input.organizationId, input.productId])
  if (remaining) throw new HTTPError({ statusCode: 409, statusMessage: 'The booking configuration changed while it was being removed' })
}

export async function listAvailabilityRules(
  db: DbClient,
  organizationId: string,
  productId: string,
  locationId?: string,
): Promise<ProductAvailabilityRule[]> {
  return queryAll<ProductAvailabilityRule>(db, `
    SELECT id, organization_id, product_id, location_id, timezone, weekday, start_time, capacity
    FROM product_availability_rules
    WHERE organization_id = ? AND product_id = ? ${locationId ? 'AND location_id=?' : ''}
    ORDER BY weekday, start_time, id
  `, locationId ? [organizationId, productId, locationId] : [organizationId, productId])
}

function resolvedDuration(config: ProductBookingConfigRecord): number {
  const minutes = config.duration_minutes
  if (minutes === null) {
    throw new HTTPError({
      statusCode: 409,
      statusMessage: 'Set a session length on the product before opening times',
    })
  }
  return minutes
}

type InstantRange = { fromInstant: string; toInstant: string }
type ProviderHours = { member_id: string; timezone: string; weekly_json: string; time_off_json: string }

function providerHoursSlots(config: ProductBookingConfigRecord, provider: ProviderHours, range: InstantRange, now: string) {
  const duration = resolvedDuration(config) * 60_000
  const from = new Date(range.fromInstant)
  const until = new Date(range.toInstant)
  if (until <= from) return []
  const slots: Array<{ starts_at: string; ends_at: string }> = []
  const timeOff = JSON.parse(provider.time_off_json) as Array<{ start: string; end: string }>
  for (const window of workingWindows(provider.timezone, JSON.parse(provider.weekly_json) as WorkingHours[], { from, until })) {
    const anchor = Date.parse(window.start)
    const first = anchor + Math.max(0, Math.ceil((from.getTime() - anchor) / duration)) * duration
    for (let start = first; start < until.getTime() && start + duration <= Date.parse(window.end); start += duration) {
      const slot = { starts_at: new Date(start).toISOString(), ends_at: new Date(start + duration).toISOString() }
      if (slot.starts_at <= now || timeOff.some(away => away.start < slot.ends_at && away.end > slot.starts_at)) continue
      slots.push(slot)
    }
  }
  return slots
}

/**
 * A table's seatings: the one place its configuration meets its location's
 * hours. On each local day of the public window, every open period of the
 * location that day — its weekly opening hours, or that date's special hours,
 * with a closure leaving the day shut — offers a seating at the period's
 * opening and every `seating_interval_minutes` after it, as long as
 * `duration_minutes` still ends by the period's close. Each seating seats
 * `default_capacity` guests. A period running past midnight belongs to the day
 * it opens. A wall time that never happens or happens twice is not offered.
 *
 * A location with no opening hours has no open time, so its tables have no
 * seatings; setting tables up there is refused, never guessed.
 */
function tableSeatings(config: Pick<ProductBookingConfigRecord, 'duration_minutes' | 'seating_interval_minutes'>, location: SessionLocation, now: string, requested?: InstantRange): Array<{ starts_at: string; ends_at: string }> {
  const duration = config.duration_minutes, interval = config.seating_interval_minutes
  if (duration === null || interval === null) throw new Error('A table is seated with a duration and a seating interval')
  if (!isValidTimezone(location.timezone)) throw new HTTPError({ statusCode: 409, statusMessage: 'The table\'s location has an invalid timezone' })
  const hours = parseOpeningHours(location.opening_hours ? JSON.parse(location.opening_hours) : null)
  const special = parseSpecialHours(location.special_hours ? JSON.parse(location.special_hours) : null)
  const window = bookingWindow(location.timezone, BOOKING_HORIZON_DAYS, now)
  const from = requested && requested.fromInstant > window.fromInstant ? requested.fromInstant : window.fromInstant
  const to = requested && requested.toInstant < window.toInstant ? requested.toInstant : window.toInstant
  if (to <= from) return []
  const firstDate = localDateAt(new Date(from), location.timezone)
  const lastDate = localDateAt(new Date(Date.parse(to) - 1), location.timezone)
  const seatings: Array<{ starts_at: string; ends_at: string }> = []
  for (let date = firstDate; date <= lastDate; date = addLocalDays(date, 1)) {
    for (const period of getDateIntervals(hours, special, date) ?? []) {
      const first = period.start + Math.ceil(Math.max(0, -period.start) / interval) * interval
      for (let minute = first; minute < 1440 && minute + duration <= period.end; minute += interval) {
        const slot = instantsFor(date, toTimeString(minute), location.timezone, duration)
        if (slot && slot.starts_at > now && slot.starts_at >= from && slot.starts_at < to) seatings.push(slot)
      }
    }
  }
  return seatings
}

/** A booking time has to identify one instant through DST gaps and folds. */
function instantsFor(date: string, time: string, timezone: string, durationMinutes: number) {
  try {
    const start = localDateTimeToInstant(date, time, timezone, 'reject')
    return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + durationMinutes * 60_000).toISOString() }
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

interface WeeklySlotInput {
  weekday: number
  start_time: string
}

const weeklySlotKey = (slot: WeeklySlotInput) => `${slot.weekday}:${slot.start_time}`

function parseWeeklySlots(value: unknown): WeeklySlotInput[] {
  if (!Array.isArray(value)) badRequest('slots must be an array')
  const slots = value.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) badRequest('each slot must be an object')
    if (typeof entry.weekday !== 'number' || typeof entry.start_time !== 'string') badRequest('each slot needs a weekday and a start_time')
    if (Object.keys(entry).some(key => !['weekday', 'start_time'].includes(key))) badRequest('slots support weekday and start_time; set duration and capacity on the product')
    return { weekday: entry.weekday as number, start_time: entry.start_time as string }
  })
  const seen = new Set<string>()
  for (const slot of slots) {
    if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6) badRequest('weekday must be 0 (Sunday) to 6 (Saturday)')
    assertLocalStartTime(slot.start_time)
    const key = weeklySlotKey(slot)
    if (seen.has(key)) badRequest(`The schedule lists ${slot.start_time} twice on the same day`)
    seen.add(key)
  }
  return slots
}

/**
 * Replace a product's weekly schedule at one location.
 *
 * The schedule is the set of (weekday, time) slots the merchant runs, using
 * the Product's duration and capacity. A slot that stays keeps its
 * rule — and with it every session and booking already hanging off it; a slot
 * that goes cancels its future sessions that nobody has booked, leaves the
 * booked ones as the commitments they are, and then removes the rule. A slot
 * that is new gets a rule and opens immediately on the calendar.
 */
function prepareWeeklySchedule(input: {
  organizationId: string; productId: string; locationId: string; slots: unknown; actorId: string; now: string
}, config: ProductBookingConfigRecord, timezone: string, existing: ProductAvailabilityRule[]): { rules: ProductAvailabilityRule[]; queries: BatchQuery[]; cancellationIndexes: number[] } {
  const slots = parseWeeklySlots(input.slots)
  // Weekly slots carry no duration of their own; they read the product's.
  if (slots.length && config.duration_minutes === null) badRequest('Set the session duration before adding a weekly schedule')


  const byKey = new Map(existing.map(rule => [weeklySlotKey(rule), rule]))
  const kept = new Set<string>()
  const now = input.now
  const writes: BatchQuery[] = []
  const additions: BatchQuery[] = []
  const rules: ProductAvailabilityRule[] = []

  for (const slot of slots) {
    const current = byKey.get(weeklySlotKey(slot))
    if (current) {
      kept.add(current.id)
      rules.push({ ...current, timezone })
      if (current.timezone !== timezone) {
        writes.push({
          query: `UPDATE product_availability_rules SET timezone = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?`,
          params: [timezone, now, input.actorId, input.organizationId, current.id],
        })
      }
      continue
    }
    const id = crypto.randomUUID()
    rules.push({ id, organization_id: input.organizationId, product_id: input.productId, location_id: input.locationId, timezone, ...slot, capacity: null })
    additions.push({
      query: `INSERT INTO product_availability_rules (
                id, organization_id, product_id, location_id, timezone, weekday, start_time, created_at, updated_at, created_by, updated_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, input.organizationId, input.productId, input.locationId, timezone,
        slot.weekday, slot.start_time, now, now, input.actorId, input.actorId],
    })
  }

  const removed = existing.filter(rule => !kept.has(rule.id))
  for (const rule of removed) {
    // Only sessions with no booking history go with the slot. Cancelled
    // bookings still belong to that session's history and protect its facts.
    writes.push({
      query: `UPDATE product_sessions SET status = 'cancelled', updated_at = ?, updated_by = ?
              WHERE organization_id = ? AND availability_rule_id = ? AND status = 'scheduled' AND starts_at > ?
                AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = product_sessions.organization_id AND b.product_session_id = product_sessions.id)`,
      params: [now, input.actorId, input.organizationId, rule.id, now],
    })
    // The rule is the session's provenance, and the schema refuses to delete a
    // rule that sessions still name (product_sessions_rule_scope_fk).
    writes.push({
      query: `UPDATE product_sessions SET availability_rule_id = NULL, updated_at = ?, updated_by = ?
              WHERE organization_id = ? AND availability_rule_id = ?`,
      params: [now, input.actorId, input.organizationId, rule.id],
    })
    writes.push({
      query: 'DELETE FROM product_availability_rules WHERE organization_id = ? AND id = ?',
      params: [input.organizationId, rule.id],
    })
  }

  const first = writes.length - removed.length * 3
  return { rules, queries: [...writes, ...additions], cancellationIndexes: removed.map((_, index) => first + index * 3) }
}

export async function replaceWeeklySchedule(db: DbClient, input: {
  organizationId: string
  productId: string
  locationId: string
  timezone?: string
  slots: unknown
  actorId: string
  requireBookableTime?: { env: CloudflareEnv; slot: WeeklySlotInput }
}): Promise<{ rules: ProductAvailabilityRule[]; cancelled: number }> {
  if ((await requireOrganizationProduct(db, input)).kind === 'table') badRequest(TABLE_HOURS_ONLY)
  const config = await requireBookingConfig(db, input.organizationId, input.productId)
  const locationId = input.locationId
  const locationRows = await queryAll<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, locationId])
  const location = locationRows[0]
  if (!location) throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  const timezone = location.timezone
  if (input.timezone !== undefined && input.timezone !== timezone) badRequest('timezone must match the location timezone')
  const now = new Date().toISOString()
  const existing = await listAvailabilityRules(db, input.organizationId, input.productId, locationId)
  const schedule = prepareWeeklySchedule({ ...input, locationId, now }, config, timezone, existing)
  if (input.requireBookableTime) {
    const { env, slot } = input.requireBookableTime
    const rule = schedule.rules.find(candidate => weeklySlotKey(candidate) === weeklySlotKey(slot))
    if (!rule || !await firstBookableOpening(db, env, { ...input, now, scope: 'editor' }, { prepared: { productId: input.productId, config, rules: [rule] }, match: session => session.availability_rule_id === rule.id })) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a time that fits the office and attorney’s availability', data: { code: 'TIME_NOT_BOOKABLE' } })
    }
  }
  const writes = [...schedule.queries, publicResourceCacheInvalidationQuery(input.organizationId, 'product-weekly-schedule')]
  if (writes.length > MAX_D1_BATCH_STATEMENTS) badRequest('This weekly schedule exceeds one atomic update')
  const results = await executeBatch(db, writes, { operation: 'Replace weekly schedule' })
  const cancelled = schedule.cancellationIndexes.reduce((sum, index) => sum + (results[index]?.meta?.changes ?? 0), 0)
  return { rules: schedule.rules, cancelled }
}

export interface ProductBookingSetupInput {
  location_id: string | null
  duration_minutes: number
  /** A table only: minutes between seatings through its location's hours. */
  seating_interval_minutes?: number | null
  default_capacity: number | null
  confirmation_mode?: 'instant' | 'review'
  online_payment_required?: boolean
  held_online?: boolean
  scheduling_mode?: 'business' | 'provider'
  assigned_member_id?: string | null
  advance_notice_minutes?: number | null
  party_size_min?: number | null
  party_size_max?: number | null
  minimum_guest_age?: number | null
  accessibility_contact_required?: boolean
  payment_basis?: PaymentBasis
  payment_min_party_size?: number | null
  weekly_slots?: WeeklySlotInput[]
  sessions?: Array<{ starts_at: string; ends_at: string; capacity?: number | null }>
}

function sessionInstants(startsAt: string, endsAt: string): { starts_at: string; ends_at: string } {
  const start = new Date(startsAt), end = new Date(endsAt)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) badRequest('Sessions need valid start and end instants, with the end after the start')
  return { starts_at: start.toISOString(), ends_at: end.toISOString() }
}

/** A dated session at a location, in the location's timezone. Online sessions come only from provider hours. */
function manualSessionQuery(input: {
  organizationId: string; productId: string; actorId: string; now: string; location: SessionLocation
}, session: { id: string; starts_at: string; ends_at: string; capacity: number | null }): BatchQuery {
  const guard: BatchQuery = { query: `EXISTS (SELECT 1 FROM business_locations l WHERE l.id=? AND l.organization_id=? AND l.status='active' AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`, params: [input.location.id, input.organizationId, input.location.timezone, input.location.opening_hours, input.location.special_hours] }
  return {
    query: `INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, CASE WHEN (${guard.query}) THEN ? ELSE NULL END, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    params: [session.id, input.organizationId, input.productId, input.location.id, input.location.timezone, ...guard.params!, session.starts_at, session.ends_at, session.capacity, input.now, input.now, input.actorId, input.actorId],
  }
}

/** Author the setup and prove a guest can select a time without storing empty occurrences. */
export async function prepareProductBookingSetup(db: DbClient, input: {
  organizationId: string; productId: string; actorId: string; env: CloudflareEnv; now: string; booking: ProductBookingSetupInput; productInSameBatch?: boolean; productKind?: string
}): Promise<BatchQuery[]> {
  const booking = input.booking
  if (!Number.isSafeInteger(booking.duration_minutes) || booking.duration_minutes <= 0) badRequest('Provide the session duration before creating a bookable offering')
  if (booking.default_capacity !== null && (!Number.isSafeInteger(booking.default_capacity) || booking.default_capacity <= 0)) badRequest('Provide places per session, or explicit null for unlimited places')
  const { location_id: locationId, weekly_slots: weeklySlots, sessions: oneOffSessions, ...patch } = booking
  const kind = input.productInSameBatch ? input.productKind : (await requireOrganizationProduct(db, input)).kind
  const { queries, config } = await prepareProductBookingConfig(db, { ...input, patch: { ...patch, held_online: locationId === null }, productInSameBatch: input.productInSameBatch })
  if (kind !== 'table') await assertPublishedHost(db, input.organizationId, config)

  const provider = await readScheduleProvider(db, config)
  const authored: ScheduledOpening[] = []
  let rules: ProductAvailabilityRule[] = []
  if (locationId === null) {
    if (weeklySlots?.length || oneOffSessions?.length) badRequest('An online offering is booked in its provider\'s working hours; it takes no weekly times or dated sessions')
    if (!provider) badRequest('Set working hours for whoever provides this offering before it can be booked online')
  } else {
    const location = await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, locationId])
    if (!location || location.status !== 'active') badRequest('Choose an active location in this business')
    queries.push({
      query: `INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?) ON CONFLICT(product_id,location_id) DO UPDATE SET active=1,published=1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      params: [input.organizationId, input.productId, locationId, input.now, input.now, input.actorId, input.actorId],
    })
    if (kind === 'table') {
      if (weeklySlots?.length || oneOffSessions?.length) badRequest(TABLE_HOURS_ONLY)
      if (location.opening_hours === null) badRequest('Set this location\'s opening hours before taking table bookings: tables are seated through them')
    } else {
      const existing = input.productInSameBatch ? [] : await listAvailabilityRules(db, input.organizationId, input.productId, locationId)
      const weekly = prepareWeeklySchedule({ ...input, locationId, slots: weeklySlots ?? existing.map(rule => ({ weekday: rule.weekday, start_time: rule.start_time })) }, config, location.timezone, existing)
      if (!weekly.rules.length && !oneOffSessions?.length) badRequest('Provide actual weekly times or dated sessions before creating a bookable offering')
      if (config.scheduling_mode === 'provider' && !provider) badRequest('Set working hours for the assigned member before adding bookable times')
      queries.push(...weekly.queries)
      rules = weekly.rules
      for (const session of oneOffSessions ?? []) {
        const instants = sessionInstants(session.starts_at, session.ends_at)
        if (instants.starts_at <= input.now) badRequest('New dated sessions must start in the future')
        const capacity = session.capacity === undefined ? config.default_capacity : session.capacity
        if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity <= 0)) badRequest('Dated sessions need positive capacity or explicit null for unlimited places')
        if (!locationAllowsBooking(instants, location)) badRequest('A dated session is outside opening hours or during a closure')
        const id = crypto.randomUUID()
        queries.push(manualSessionQuery({ ...input, location }, { id, ...instants, capacity }))
        authored.push({ session: {
          id, ...instants, organization_id: input.organizationId, product_id: input.productId, location_id: location.id,
          availability_rule_id: null, source_occurrence_key: null, timezone: location.timezone, capacity,
          status: 'scheduled', created_at: input.now, updated_at: input.now, created_by: input.actorId, updated_by: input.actorId,
        } })
      }
    }
  }

  const first = await firstBookableOpening(db, input.env, { organizationId: input.organizationId, productId: input.productId, locationId, now: input.now, scope: 'publication' }, {
    prepared: { productId: input.productId, kind, config, rules }, extra: authored,
  })
  if (!first) throw new HTTPError({ statusCode: 409, statusMessage: 'Provide at least one future time that a guest can book' })
  const allocation = await sessionAllocationPredicate(db, {
    env: input.env, organizationId: input.organizationId, productId: input.productId, sessionId: first.session.id,
    partySize: first.partySize, now: input.now, requireActive: false, resolved: first.resolve(null), preview: true,
  })
  queries.push({
    query: `UPDATE product_booking_configs SET updated_at=CASE WHEN (${allocation.query}) THEN updated_at ELSE NULL END
      WHERE organization_id=? AND product_id=?`,
    params: [...allocation.params!, input.organizationId, input.productId],
  })
  return queries
}

export function sessionHeldCapacitySql(sessionAlias: string, convertingPaymentSql = 'NULL'): string {
  return `COALESCE((SELECT SUM(h.quantity) FROM payment_checkout_holds h
    WHERE h.session_id = ${sessionAlias}.id AND h.organization_id = ${sessionAlias}.organization_id
      AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND h.payment_id IS NOT ${convertingPaymentSql}), 0)`
}

type SessionLocation = { id: string; timezone: string; status: string; opening_hours: string | null; special_hours: string | null }

/** The provider a scheduled session names, so a write's guard asks Google about that member only; none for a cancelled or business-scheduled session. */
async function sessionProviderIds(db: DbClient, organizationId: string, sessionId: string): Promise<string[]> {
  const row = await queryFirst<{ member: string | null }>(db, `SELECT ${providerMemberSql('s')} AS member FROM product_sessions s WHERE s.organization_id=? AND s.id=? AND s.status='scheduled'`, [organizationId, sessionId])
  return row?.member ? [row.member] : []
}

async function sessionLocationGuard(db: DbClient, input: SessionAllocationInput): Promise<BatchQuery> {
  const session = await queryFirst<ProductSession>(db, 'SELECT * FROM product_sessions WHERE id=? AND organization_id=? AND product_id=?', [input.sessionId, input.organizationId, input.productId])
  if (!session) return { query: '0', params: [] }
  const facts: BatchQuery = { query: 's.starts_at=? AND s.ends_at=?', params: [session.starts_at, session.ends_at] }
  if (!session.location_id) return facts
  const location = await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE id=? AND organization_id=?', [session.location_id, input.organizationId])
  if (!location || !locationAllowsBooking(session, location)) return { query: '0', params: [] }
  return { query: `${facts.query} AND EXISTS (SELECT 1 FROM business_locations l WHERE l.id=s.location_id AND l.organization_id=s.organization_id AND l.status='active' AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`, params: [...facts.params!, location.timezone, location.opening_hours, location.special_hours] }
}

/** The public booking window, expressed as instants in the product's timezone. */
export function bookingWindow(timezone: string, days = BOOKING_HORIZON_DAYS, now = new Date().toISOString()): InstantRange {
  if (!isValidTimezone(timezone)) throw new HTTPError({ statusCode: 409, statusMessage: 'Set the timezone before offering bookings' })
  if (days > BOOKING_HORIZON_DAYS) badRequest('Booking window is too long')
  const today = localNow(timezone, new Date(now)).date
  return {
    fromInstant: now,
    toInstant: localDateTimeToInstant(addLocalDays(today, days), '00:00', timezone, 'compatible').toISOString(),
  }
}

interface SlotRange extends InstantRange {
  organizationId: string
  productId: string
  /** Undefined is every location, null is online. */
  locationId?: string | null
  now?: string
}

type StoredOpening = ProductSession & SessionClaims
type ScheduledOpening = { session: SessionFacts; rule?: ProductAvailabilityRule; refresh?: StoredOpening }
/** The provider whose working hours an offering is booked in, with what the slot reader checks about them. */
type SlotProvider = ProviderHours & { updated_at: string; calendar_account_id: string | null; calendar_ids_json: string; profile_published: number; calendar_linked: number }
type SlotSchedule = {
  kind: string
  config: ProductBookingConfigRecord
  locations: Map<string, SessionLocation>
  rules: ProductAvailabilityRule[]
  provider: SlotProvider | null
}

/** Whether the assigned member has working hours, for setup that refuses an offering nobody can hold. */
async function readScheduleProvider(db: DbClient, config: ProductBookingConfigRecord) {
  return config.scheduling_mode !== 'provider' ? null : queryFirst<{ member_id: string; timezone: string }>(db, `
    SELECT ms.member_id,ms.timezone FROM member_scheduling ms
    JOIN member m ON m.id=ms.member_id AND m.organizationId=ms.organization_id
    WHERE ms.organization_id=? AND ms.member_id=? AND ms.timezone IS NOT NULL
  `, [config.organization_id, config.assigned_member_id])
}

type SlotReadScope = 'bookable' | 'editor' | 'publication'

function slotWindow(timezone: string, input: InstantRange, now: string): InstantRange {
  const window = bookingWindow(timezone, BOOKING_HORIZON_DAYS, now)
  return {
    fromInstant: input.fromInstant > window.fromInstant ? input.fromInstant : window.fromInstant,
    toInstant: input.toInstant < window.toInstant ? input.toInstant : window.toInstant,
  }
}

function projectedId(slot: Pick<SessionFacts, 'organization_id' | 'product_id' | 'location_id' | 'source_occurrence_key' | 'starts_at'>): string {
  const digest = createHash('sha256').update(JSON.stringify([
    slot.organization_id, slot.product_id, slot.location_id, slot.source_occurrence_key, slot.starts_at,
  ])).digest('hex').slice(0, 32)
  return `p.${slot.starts_at}.${digest}`
}

const projectedIdPattern = /^p\.(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\.[a-f0-9]{32}$/

function projectOpenings(schedule: SlotSchedule, input: SlotRange, now: string): ScheduledOpening[] {
  const { config, locations, rules, provider } = schedule
  if (config.duration_minutes === null) return []
  const result: ScheduledOpening[] = []
  const byTimezone = new Map<string, InstantRange>()
  const rangeIn = (timezone: string) => {
    const cached = byTimezone.get(timezone)
    if (cached) return cached
    const range = slotWindow(timezone, input, now)
    byTimezone.set(timezone, range)
    return range
  }
  const add = (slot: Pick<SessionFacts, 'starts_at' | 'ends_at'>, locationId: string | null, timezone: string, key: string, capacity: number | null, rule?: ProductAvailabilityRule) => {
    const facts = {
      ...slot, organization_id: input.organizationId, product_id: input.productId, location_id: locationId,
      availability_rule_id: rule?.id ?? null, source_occurrence_key: key, timezone, capacity,
      status: 'scheduled' as const, created_at: null, updated_at: null, created_by: null, updated_by: null,
    }
    result.push({ session: { ...facts, id: projectedId(facts) }, rule })
  }
  if (config.seating_interval_minutes !== null) {
    for (const location of locations.values()) {
      if (location.status !== 'active') continue
      for (const slot of tableSeatings(config, location, now, input)) {
        add(slot, location.id, location.timezone, `hours:${location.id}:${slot.starts_at}`, config.default_capacity)
      }
    }
    return result
  }
  if (config.scheduling_mode === 'provider' && !provider) return []
  if (config.held_online && provider && input.locationId == null) {
    for (const slot of providerHoursSlots(config, provider, rangeIn(provider.timezone), now)) {
      add(slot, null, provider.timezone, `hours:${provider.member_id}:${slot.starts_at}`, config.default_capacity)
    }
  }
  for (const rule of rules) {
    const location = locations.get(rule.location_id)
    if (!location || location.status !== 'active') continue
    const range = rangeIn(rule.timezone)
    if (range.toInstant <= range.fromInstant) continue
    const first = localDateAt(new Date(range.fromInstant), rule.timezone)
    const last = localDateAt(new Date(Date.parse(range.toInstant) - 1), rule.timezone)
    for (let date = first; date <= last; date = addLocalDays(date, 1)) {
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== rule.weekday) continue
      const slot = instantsFor(date, rule.start_time, rule.timezone, resolvedDuration(config))
      if (!slot || slot.starts_at <= now || slot.starts_at < range.fromInstant || slot.starts_at >= range.toInstant || !locationAllowsBooking(slot, location)) continue
      add(slot, location.id, rule.timezone, occurrenceKey(rule.id, date, rule.start_time), rule.capacity ?? config.default_capacity, rule)
    }
  }
  return result
}

function historySql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id=${alias}.organization_id AND b.product_session_id=${alias}.id)
    OR EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=${alias}.organization_id AND h.session_id=${alias}.id AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
}

const OPENINGS_PER_QUERY = 4_000

function openingChunks<T>(openings: T[]): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < openings.length; start += OPENINGS_PER_QUERY) chunks.push(openings.slice(start, start + OPENINGS_PER_QUERY))
  return chunks
}

/** The schedule's openings in the range with the saved sessions that edit, cancel or hold them, one per time. */
function mergeOpenings(input: SlotRange, schedule: SlotSchedule, projected: ScheduledOpening[], stored: StoredOpening[]): ScheduledOpening[] {
  const byOccurrence = new Map(stored.filter(row => row.source_occurrence_key !== null).map(row => [row.source_occurrence_key, row]))
  const instantKey = (slot: Pick<SessionFacts, 'location_id' | 'starts_at'>) => JSON.stringify([slot.location_id, slot.starts_at])
  const byInstant = new Map(stored.map(row => [instantKey(row), row]))
  const selected = new Map<string, ScheduledOpening>()
  const refreshed = new Set<string>()
  const projectedKeys = new Set(projected.map(opening => opening.session.source_occurrence_key))
  for (const opening of projected) {
    const slot = opening.session
    const existing = byOccurrence.get(slot.source_occurrence_key) ?? byInstant.get(instantKey(slot))
    if (!existing) {
      selected.set(instantKey(slot), opening)
      continue
    }
    // Table seatings always follow location hours until a booking or live hold
    // makes the row a commitment. Detached weekly occurrences can be adopted
    // when a manager adds their time back, just like an existing schedule edit.
    if (!existing.has_history && (
      (schedule.config.seating_interval_minutes !== null && existing.starts_at === slot.starts_at) ||
      (opening.rule && existing.source_occurrence_key !== slot.source_occurrence_key && existing.availability_rule_id === null &&
        existing.source_occurrence_key !== null && existing.starts_at === slot.starts_at)
    )) {
      const session = { ...slot, id: existing.id, created_at: existing.created_at, updated_at: existing.updated_at,
        created_by: existing.created_by, updated_by: existing.updated_by }
      const refresh = existing.status !== 'scheduled' || existing.ends_at !== slot.ends_at || existing.capacity !== slot.capacity ||
        existing.timezone !== slot.timezone || existing.source_occurrence_key !== slot.source_occurrence_key ? existing : undefined
      selected.set(instantKey(session), { ...opening, session, refresh })
      refreshed.add(existing.id)
    } else if (schedule.config.seating_interval_minutes !== null && existing.starts_at === slot.starts_at) {
      selected.set(instantKey(existing), { ...opening, session: savedSession(existing) })
    }
  }
  for (const row of stored) {
    if (refreshed.has(row.id) || row.starts_at < input.fromInstant || row.starts_at >= input.toInstant) continue
    if (row.location_id !== null && !schedule.locations.has(row.location_id)) continue
    if (row.location_id === null && !schedule.config.held_online) continue
    if (schedule.config.seating_interval_minutes !== null) continue
    if (row.location_id === null && row.source_occurrence_key?.startsWith('hours:') &&
        row.source_occurrence_key.endsWith(row.starts_at) && !projectedKeys.has(row.source_occurrence_key)) continue
    selected.set(instantKey(row), { session: savedSession(row) })
  }
  return [...selected.values()].sort((a, b) => a.session.starts_at.localeCompare(b.session.starts_at) || a.session.id.localeCompare(b.session.id))
}

function savedSession(row: ProductSession & Partial<SessionClaims>): ProductSession {
  const { has_history: _history, booked: _booked, held: _held, bookings: _bookings, ...session } = row as ProductSession & SessionClaims
  return session
}

function fitsPublicWindow(session: SessionFacts, config: ProductBookingConfigRecord, now: string, until: string) {
  return config.duration_minutes !== null && session.status === 'scheduled' && session.starts_at < until &&
    outsideNotice(session.starts_at, config.advance_notice_minutes, Date.parse(now))
}

/** The one slot reader (docs/domain-model.md, "Open and blocked time"): one D1 batch for the window; openings and places computed in memory. */
export interface SlotRead {
  /** SQL yielding the organization's id. */
  organization: BatchQuery
  /** SQL selecting the offerings' product ids. */
  products: BatchQuery
  /** Undefined is every location, null is online. */
  locationId?: string | null
  fromInstant: string
  toInstant: string
  scope: SlotReadScope
  now: string
  /** Settings not saved yet: setup reads the slots an offering would have before it saves them. */
  prepared?: { productId: string; kind?: string; config: ProductBookingConfigRecord; rules?: ProductAvailabilityRule[] }
}

/** What of a slot read its rows are computed against. */
export type SlotWindow = Pick<SlotRead, 'locationId' | 'fromInstant' | 'toInstant' | 'scope' | 'now' | 'prepared'>

type SessionClaims = { booked: number; held: number; bookings: number; has_history: number }
type ProviderCommitment = { member_id: string; session_id: string | null; starts_at: string; ends_at: string }
type StoredConfig = StoredBookingConfig & { product_kind: string; product_on_sale: number }
type Placement = { product_id: string; location_id: string; active: number; published: number }

/** The statements of one slot read, in the order `slotFacts` reads them. */
export function slotReadQueries(read: SlotRead): BatchQuery[] {
  const org = read.organization, products = read.products
  const members = {
    query: `SELECT assigned_member_id FROM product_booking_configs WHERE organization_id=${org.query} AND product_id IN (${products.query}) AND scheduling_mode='provider' UNION SELECT ?`,
    params: [...org.params!, ...products.params!, read.prepared?.config.scheduling_mode === 'provider' ? read.prepared.config.assigned_member_id : null],
  }
  const from = Date.parse(read.fromInstant), to = Date.parse(read.toInstant)
  // A provider's commitment that overlaps any slot in the window: slots start inside it and last at most a day.
  const reach = { from: new Date(from - 86_400_000).toISOString(), to: new Date(to + 86_400_000).toISOString() }
  // A moved weekly or hours session keeps the occurrence key of the time it came from.
  const keyDate = `CASE WHEN s.source_occurrence_key LIKE 'hours:%' THEN substr(s.source_occurrence_key,-24,10) ELSE substr(s.source_occurrence_key,-16,10) END`
  const consuming = `FROM bookings b WHERE b.organization_id=s.organization_id AND b.product_session_id=s.id AND ${CAPACITY_CONSUMING_SQL}`
  return [{
    query: `SELECT ${BOOKING_CONFIG_COLUMNS.map(column => `c.${column}`).join(', ')}, p.kind AS product_kind,
        p.active AND EXISTS (SELECT 1 FROM product_publications pub WHERE pub.organization_id=p.organization_id AND pub.product_id=p.id AND pub.published=1) AS product_on_sale
      FROM product_booking_configs c
      JOIN products p ON p.id=c.product_id AND p.organization_id=c.organization_id
      WHERE c.organization_id=${org.query} AND c.product_id IN (${products.query})`,
    params: [...org.params!, ...products.params!],
  }, {
    query: `SELECT product_id, location_id, active, published FROM product_locations WHERE organization_id=${org.query} AND product_id IN (${products.query})`,
    params: [...org.params!, ...products.params!],
  }, {
    query: `SELECT l.id, l.timezone, l.status, l.opening_hours, l.special_hours FROM business_locations l
      WHERE l.organization_id=${org.query} AND (l.id IN (SELECT location_id FROM product_locations WHERE organization_id=l.organization_id AND product_id IN (${products.query}))
        OR l.id IN (SELECT location_id FROM product_sessions WHERE organization_id=l.organization_id AND product_id IN (${products.query}) AND starts_at>=? AND starts_at<?)
        OR l.id IS ?)`,
    params: [...org.params!, ...products.params!, ...products.params!, read.fromInstant, read.toInstant, typeof read.locationId === 'string' ? read.locationId : null],
  }, {
    query: `SELECT id, organization_id, product_id, location_id, timezone, weekday, start_time, capacity FROM product_availability_rules
      WHERE organization_id=${org.query} AND product_id IN (${products.query}) ORDER BY weekday, start_time, id`,
    params: [...org.params!, ...products.params!],
  }, {
    query: `SELECT ms.member_id, ms.timezone, ms.weekly_json, ms.time_off_json, ms.updated_at, ms.calendar_account_id, ms.calendar_ids_json,
        ${PUBLISHED_PROFILE_SQL} AS profile_published,
        EXISTS (SELECT 1 FROM account a WHERE a.id=ms.calendar_account_id AND a.userId=m.userId AND a.providerId='google') AS calendar_linked
      FROM member_scheduling ms JOIN member m ON m.id=ms.member_id AND m.organizationId=ms.organization_id
      WHERE ms.organization_id=${org.query} AND ms.timezone IS NOT NULL AND ms.member_id IN (${members.query})`,
    params: [...org.params!, ...members.params!],
  }, {
    query: `SELECT s.*, COALESCE((SELECT SUM(b.party_size) ${consuming}), 0) AS booked, (SELECT COUNT(*) ${consuming}) AS bookings,
        ${sessionHeldCapacitySql('s')} AS held, ${historySql('s')} AS has_history
      FROM product_sessions s WHERE s.organization_id=${org.query} AND s.product_id IN (${products.query})
        AND ((s.starts_at>=? AND s.starts_at<?) OR (s.source_occurrence_key IS NOT NULL AND ${keyDate}>=? AND ${keyDate}<=?))
      ORDER BY s.starts_at, s.id`,
    params: [...org.params!, ...products.params!, read.fromInstant, read.toInstant, reach.from.slice(0, 10), reach.to.slice(0, 10)],
  }, {
    query: `SELECT config.assigned_member_id AS member_id, occupied.id AS session_id, occupied.starts_at, occupied.ends_at FROM bookings b
        JOIN product_sessions occupied ON occupied.id=b.product_session_id AND occupied.organization_id=b.organization_id
        JOIN product_booking_configs config ON config.product_id=b.product_id AND config.organization_id=b.organization_id AND config.scheduling_mode='provider'
      WHERE b.organization_id=${org.query} AND config.assigned_member_id IN (${members.query}) AND b.status IN ('pending','confirmed')
        AND occupied.starts_at<? AND occupied.ends_at>?
      UNION ALL
      SELECT config.assigned_member_id, h.session_id, h.starts_at, h.ends_at FROM payment_checkout_holds h
        JOIN product_booking_configs config ON config.product_id=h.product_id AND config.organization_id=h.organization_id AND config.scheduling_mode='provider'
      WHERE h.organization_id=${org.query} AND config.assigned_member_id IN (${members.query}) AND h.status='active'
        AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND h.starts_at<? AND h.ends_at>?`,
    params: [...org.params!, ...members.params!, reach.to, reach.from, ...org.params!, ...members.params!, reach.to, reach.from],
  }]
}

/** One offering's slots in the window, as every calendar reads them. */
export interface SlotCalendar {
  schedule: SlotSchedule
  /** The offered times merged with the saved sessions that edit them, for writes that persist or cancel one. */
  openings: ScheduledOpening[]
  /** Where a guest can book it now: its active, published placements at active locations, and online (null) when its provider holds it there; none while the product is off sale. */
  onSale: Set<string | null>
  /** The saved sessions in the window, whatever the schedule now offers. */
  stored: Array<ProductSession & SessionClaims>
  /** Places left, with the provider's busy calendars asked at most once per member per read. */
  places: () => Promise<SlotPlaces>
}

export interface SlotPlaces {
  /** The merged openings with their places left. */
  sessions: BookableSession[]
  /** The saved sessions in the window with their places left. */
  recorded: BookableSession[]
  /** Any session's places left, for a time setup proposes before saving it. */
  place: (session: SessionFacts) => BookableSession
  /** The provider's hours and busy times, as the JSON a write's provider guard binds. */
  availability: string
}

/** Read the batch's rows into each offering's calendar. Google is asked only when `places()` is. */
export function slotCalendars(env: CloudflareEnv | null, read: SlotWindow, results: Array<{ results: unknown[] }>, include: (productId: string, kind: string) => boolean = () => true): Map<string, SlotCalendar> {
  const [configs, placements, locationRows, rules, providers, sessions, commitments] = results.map(result => result.results) as [
    StoredConfig[], Placement[], SessionLocation[], ProductAvailabilityRule[], SlotProvider[], Array<ProductSession & SessionClaims>, ProviderCommitment[],
  ]
  if (commitments === undefined) throw new Error('The slot read returned fewer statements than it sent')
  const allLocations = new Map(locationRows.map(location => [location.id, location]))
  const providerById = new Map(providers.map(provider => [provider.member_id, provider]))
  const busy = new Map<string, Promise<SchedulingInterval[]>>()
  const busyOf = (provider: SlotProvider, organizationId: string) => {
    let found = busy.get(provider.member_id)
    if (found === undefined) {
      if (!env) throw new Error('Places left on a busy-calendar provider\'s times need the organization environment')
      found = memberBusy(env, { ...provider, organization_id: organizationId }, { from: read.fromInstant, until: new Date(Date.parse(read.toInstant) + 86_400_000).toISOString() })
      busy.set(provider.member_id, found)
    }
    return found!
  }
  const stored = configs.filter(row => include(row.product_id, row.product_kind)).map(row => {
    const { product_kind: kind, product_on_sale: onSale, ...config } = row
    return { kind, onSale: onSale === 1, config: bookingConfigRecord(config) }
  })
  const entries = read.prepared
    ? [{ kind: read.prepared.kind ?? stored.find(entry => entry.config.product_id === read.prepared!.productId)?.kind, onSale: false, config: read.prepared.config }]
    : stored
  const calendars = new Map<string, SlotCalendar>()
  for (const { kind, onSale, config } of entries) {
    if (kind === undefined) throw new Error('A prepared slot read names a product kind')
    requireConsultationAttorney(kind, config)
    if (config.unit !== 'slot') badRequest('Choose an offering booked by time')
    const productId = config.product_id
    const explicit = typeof read.locationId === 'string'
    const locations = new Map<string, SessionLocation>()
    if (read.locationId !== null) {
      const placed = placements.filter(row => row.product_id === productId && (!explicit || row.location_id === read.locationId))
      const ids = read.scope === 'publication' && explicit ? [read.locationId as string]
        : placed.filter(row => read.scope !== 'bookable' || (row.active === 1 && row.published === 1)).map(row => row.location_id)
      for (const id of ids) {
        const location = allLocations.get(id)
        if (location && (read.scope !== 'bookable' || location.status === 'active')) locations.set(id, location)
      }
    }
    const schedule: SlotSchedule = {
      kind, config, locations,
      rules: config.seating_interval_minutes !== null || read.locationId === null ? []
        : read.prepared?.rules ?? rules.filter(rule => rule.product_id === productId && (!explicit || rule.location_id === read.locationId)),
      provider: config.scheduling_mode === 'provider' && config.assigned_member_id ? providerById.get(config.assigned_member_id) ?? null : null,
    }
    const range: SlotRange = { organizationId: config.organization_id, productId, locationId: read.locationId, fromInstant: read.fromInstant, toInstant: read.toInstant }
    const own = sessions.filter(row => row.product_id === productId)
    const scoped = own.filter(row => read.locationId === undefined || row.location_id === read.locationId)
    const openings = mergeOpenings(range, schedule, projectOpenings(schedule, range, read.now), scoped)
    let placed: Promise<SlotPlaces> | undefined
    const sale = new Set<string | null>(onSale ? placements.filter(row => row.product_id === productId && row.active === 1 && row.published === 1 && allLocations.get(row.location_id)?.status === 'active').map(row => row.location_id) : [])
    if (onSale && config.held_online && schedule.provider) sale.add(null)
    calendars.set(productId, {
      schedule, openings, onSale: sale, stored: own.filter(row => row.starts_at >= read.fromInstant && row.starts_at < read.toInstant),
      places: () => placed ??= slotPlaces(schedule, openings, own, read, allLocations, commitments, busyOf),
    })
  }
  return calendars
}

async function slotPlaces(schedule: SlotSchedule, openings: ScheduledOpening[], own: Array<ProductSession & SessionClaims>, read: SlotWindow,
  locations: Map<string, SessionLocation>, commitments: ProviderCommitment[], busyOf: (provider: SlotProvider, organizationId: string) => Promise<SchedulingInterval[]>): Promise<SlotPlaces> {
  const { config, kind, provider } = schedule
  const member = config.scheduling_mode === 'provider' ? config.assigned_member_id : null
  const calendarSelected = provider !== null && provider.calendar_account_id !== null && (JSON.parse(provider.calendar_ids_json) as string[]).length > 0
  const busy = calendarSelected && provider.calendar_linked ? await busyOf(provider, config.organization_id) : []
  const span = { from: new Date(Date.parse(read.fromInstant) - 86_400_000), until: new Date(Date.parse(read.toInstant) + 86_400_000) }
  const windows = provider ? workingWindows(provider.timezone, JSON.parse(provider.weekly_json) as WorkingHours[], span) : []
  const timeOff = provider ? JSON.parse(provider.time_off_json) as SchedulingInterval[] : []
  const overlaps = (interval: { start: string; end: string }, session: SessionFacts) => interval.start < session.ends_at && interval.end > session.starts_at
  // The provider rule `providerUnavailableSql` guards a write with, applied to the rows this read holds.
  const providerBlocks = (session: SessionFacts): boolean => {
    if (kind === 'service' && (config.scheduling_mode !== 'provider' || !member || !provider?.profile_published)) return true
    if (config.scheduling_mode === 'provider' && !member) return true
    if (!member) return false
    if (!provider) return true
    if (!windows.some(window => window.start <= session.starts_at && window.end >= session.ends_at)) return true
    if (timeOff.some(away => overlaps(away, session))) return true
    if (calendarSelected && (!provider.calendar_linked || busy.some(interval => overlaps(interval, session)))) return true
    return commitments.some(taken => taken.member_id === member && taken.session_id !== session.id && taken.starts_at < session.ends_at && taken.ends_at > session.starts_at)
  }
  const claims = new Map(own.map(row => [row.id, row]))
  const place = (session: SessionFacts): BookableSession => {
    const row = claims.get(session.id)
    const claimed = row ? Number(row.booked) + Number(row.held) : 0
    const location = session.location_id === null ? null : locations.get(session.location_id)
    const closed = providerBlocks(session) || (session.location_id !== null && (!location || !locationAllowsBooking(session, location)))
    const remaining = closed ? 0 : session.capacity === null ? null : session.capacity - claimed
    return { ...session, claimed, remaining, is_full: remaining !== null && remaining <= 0 }
  }
  return {
    sessions: openings.map(({ session }) => place(session)),
    recorded: own.filter(row => row.starts_at >= read.fromInstant && row.starts_at < read.toInstant).map(row => place(savedSession(row))),
    place,
    availability: JSON.stringify(provider ? { [provider.member_id]: { windows, busy } } : {}),
  }
}

/** Read slot calendars in one batch. */
export async function readSlots(db: DbClient, env: CloudflareEnv | null, read: SlotRead): Promise<Map<string, SlotCalendar>> {
  return slotCalendars(env, read, await executeBatch(db, slotReadQueries(read), { operation: 'Read slots' }))
}

/** One offering's slot calendar; an offering that takes no bookings is not found. */
async function readSlotCalendar(db: DbClient, env: CloudflareEnv | null, input: SlotRange & { scope: SlotReadScope; prepared?: SlotRead['prepared'] }): Promise<SlotCalendar> {
  const calendar = (await readSlots(db, env, {
    organization: { query: '?', params: [input.organizationId] }, products: { query: 'SELECT ?', params: [input.productId] },
    locationId: input.locationId, fromInstant: input.fromInstant, toInstant: input.toInstant, scope: input.scope,
    now: input.now ?? new Date().toISOString(), prepared: input.prepared,
  })).get(input.productId)
  if (!calendar) throw new HTTPError({ statusCode: 404, statusMessage: 'This product does not take bookings' })
  return calendar
}

/** The times a guest can book: scheduled, outside notice and inside the booking horizon, read once per timezone. */
export function bookableSessions(schedule: SlotSchedule, sessions: BookableSession[], now: string): BookableSession[] {
  const horizons = new Map<string, string>()
  return sessions.filter((session) => {
    let until = horizons.get(session.timezone)
    if (!until) {
      until = bookingWindow(session.timezone, BOOKING_HORIZON_DAYS, now).toInstant
      horizons.set(session.timezone, until)
    }
    return fitsPublicWindow(session, schedule.config, now, until)
  })
}

/** The bookable times in a range, read with one batch. */
export async function listBookableSessions(db: DbClient, input: SlotRange & { env: CloudflareEnv }, scope: SlotReadScope = 'bookable'): Promise<BookableSession[]> {
  const from = Date.parse(input.fromInstant), to = Date.parse(input.toInstant)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 94 * 86_400_000) badRequest('Choose a valid availability range of at most 93 days')
  const now = input.now ?? new Date().toISOString()
  const calendar = await readSlotCalendar(db, input.env, { ...input, now, scope })
  return bookableSessions(calendar.schedule, (await calendar.places()).sessions, now)
}

/** The operator's view: the bookable times and the saved sessions in the range; a saved future time no longer offered reads full. */
export function scheduleSessions(calendar: SlotCalendar, places: SlotPlaces, input: { locationId?: string | null; statuses?: ProductSessionStatus[]; now: string }): BookableSession[] {
  const statuses = input.statuses ?? [...PRODUCT_SESSION_STATUSES]
  const recorded = places.recorded.filter(session => statuses.includes(session.status)
    && (input.locationId === undefined || session.location_id === input.locationId))
  const byId = new Map<string, BookableSession>(recorded.map(session => [
    session.id,
    session.starts_at > input.now && session.status === 'scheduled' ? { ...session, remaining: 0, is_full: true } : session,
  ]))
  if (statuses.includes('scheduled')) for (const session of bookableSessions(calendar.schedule, places.sessions, input.now)) byId.set(session.id, session)
  return [...byId.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id))
}

/** Include recorded edits and history in the operator's view of a schedule. */
export async function listScheduleSessions(db: DbClient, input: SlotRange & { env: CloudflareEnv; statuses?: ProductSessionStatus[] }): Promise<BookableSession[]> {
  const now = input.now ?? new Date().toISOString()
  const calendar = await readSlotCalendar(db, input.env, { ...input, now, scope: 'editor' })
  return scheduleSessions(calendar, await calendar.places(), { ...input, now })
}

/** One session: a saved one with its places left, or a time the schedule offers. */
export async function getScheduleSession(db: DbClient, env: CloudflareEnv, input: SessionSelector): Promise<SessionAvailability> {
  const found = await findOpening(db, env, input, input.now ?? new Date().toISOString(), 'editor')
  const places = found && await found.calendar.places()
  const session = places && (places.recorded.find(row => row.id === input.sessionId) ?? (found.opening && places.place(found.opening.session)))
  if (!session) throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found for this offering' })
  return session as SessionAvailability
}

/** The first time in the booking horizon with room for the smallest party, a page at a time; `extra` are times setup saves in the same batch. */
export async function firstBookableOpening(db: DbClient, env: CloudflareEnv, input: {
  organizationId: string; productId: string; locationId?: string | null; now: string; scope: SlotReadScope
}, options: { prepared?: SlotRead['prepared']; match?: (session: BookableSession) => boolean; extra?: ScheduledOpening[] } = {}) {
  const until = Date.parse(input.now) + (BOOKING_HORIZON_DAYS + 1) * 86_400_000
  const page = AVAILABILITY_PAGE_DAYS * 86_400_000
  for (let start = Date.parse(input.now); start < until; start += page) {
    const fromInstant = new Date(start).toISOString(), toInstant = new Date(Math.min(until, start + page)).toISOString()
    const calendar = await readSlotCalendar(db, env, { ...input, prepared: options.prepared, fromInstant, toInstant })
    const partySize = calendar.schedule.config.party_size_min ?? 1
    // One candidate per place and time: a time setup is about to save replaces the offered one it matches.
    const key = (session: Pick<SessionFacts, 'location_id' | 'starts_at'>) => JSON.stringify([session.location_id, session.starts_at])
    const candidates = new Map(calendar.openings.map(opening => [key(opening.session), opening]))
    for (const opening of options.extra ?? []) if (opening.session.starts_at >= fromInstant && opening.session.starts_at < toInstant) candidates.set(key(opening.session), opening)
    const places = await calendar.places()
    const session = bookableSessions(calendar.schedule, [...candidates.values()].map(opening => places.place(opening.session)), input.now)
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
      .find(session => (options.match?.(session) ?? true) && (session.remaining === null || session.remaining >= partySize))
    if (session) return { session, partySize, resolve: (actorId: string | null) => prepareResolvedOpening(calendar.schedule, candidates.get(key(session))!, input.now, actorId, places.availability) }
  }
  return null
}

export interface ResolvedBookingSession {
  session: SessionFacts
  preceding: BatchQuery[]
  guard: BatchQuery
  previewGuard: BatchQuery
  observedAt: string
  providerAvailability: string
}

function slotScheduleGuard(schedule: SlotSchedule, opening: ScheduledOpening): BatchQuery {
  const { config, locations, provider } = schedule
  const { session, rule } = opening
  const location = session.location_id === null ? null : locations.get(session.location_id)
  const clauses = [
    `EXISTS (SELECT 1 FROM product_booking_configs c
      WHERE c.organization_id=? AND c.product_id=? AND c.duration_minutes IS ? AND c.seating_interval_minutes IS ?
        AND c.default_capacity IS ? AND c.scheduling_mode=? AND c.assigned_member_id IS ? AND c.held_online=?)`,
  ]
  const params: unknown[] = [
    config.organization_id, config.product_id, config.duration_minutes, config.seating_interval_minutes,
    config.default_capacity, config.scheduling_mode, config.assigned_member_id, Number(config.held_online),
  ]
  if (session.location_id !== null) {
    if (!location || !locationAllowsBooking(session, location)) return { query: '0', params: [] }
    clauses.push(`EXISTS (SELECT 1 FROM business_locations l
      WHERE l.id=? AND l.organization_id=? AND l.status='active'
        AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`)
    params.push(location.id, config.organization_id, location.timezone, location.opening_hours, location.special_hours)
  }
  if (rule) {
    clauses.push(`EXISTS (SELECT 1 FROM product_availability_rules r
      WHERE r.id=? AND r.organization_id=? AND r.product_id=? AND r.location_id=?
        AND r.timezone=? AND r.weekday=? AND r.start_time=? AND r.capacity IS ?)`)
    params.push(rule.id, rule.organization_id, rule.product_id, rule.location_id, rule.timezone, rule.weekday, rule.start_time, rule.capacity)
  }
  if (config.scheduling_mode === 'provider') {
    if (!provider) return { query: '0', params: [] }
    clauses.push('EXISTS (SELECT 1 FROM member_scheduling WHERE organization_id=? AND member_id=? AND updated_at=?)')
    params.push(config.organization_id, provider.member_id, provider.updated_at)
  }
  return { query: clauses.join(' AND '), params }
}

function persistProjectedOpenings(schedule: SlotSchedule, openings: ScheduledOpening[], now: string, actorId: string, status: ProductSessionStatus): BatchQuery {
  const first = openings[0]!
  const snapshot = slotScheduleGuard(schedule, first)
  return {
    query: `INSERT INTO product_sessions (id, organization_id, product_id, location_id, availability_rule_id,
      source_occurrence_key, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by)
      SELECT json_extract(value,'$[0]'),?,?,?,?,json_extract(value,'$[1]'),?,json_extract(value,'$[2]'),
        json_extract(value,'$[3]'),json_extract(value,'$[4]'),?,?,?,?,?
      FROM json_each(?) WHERE ${snapshot.query} ON CONFLICT DO NOTHING`,
    params: [first.session.organization_id, first.session.product_id, first.session.location_id, first.session.availability_rule_id,
      first.session.timezone, status, now, now, actorId, actorId,
      d1JsonValue(openings.map(({ session }) => [session.id, session.source_occurrence_key, session.starts_at, session.ends_at, session.capacity])),
      ...snapshot.params!],
  }
}

function refreshSavedOpening(schedule: SlotSchedule, opening: ScheduledOpening, now: string, actorId: string, status: ProductSessionStatus): BatchQuery {
  const { session, refresh } = opening
  const snapshot = slotScheduleGuard(schedule, opening)
  return {
    query: `UPDATE product_sessions AS s SET status=?, ends_at=?, capacity=?, timezone=?,
      source_occurrence_key=?, availability_rule_id=?, updated_at=?, updated_by=?
      WHERE s.id=? AND s.organization_id=? AND s.product_id=? AND s.updated_at=?
        AND NOT ${historySql('s')} AND (${snapshot.query})`,
    params: [status, session.ends_at, session.capacity, session.timezone, session.source_occurrence_key, session.availability_rule_id,
      now, actorId, session.id, session.organization_id, session.product_id, refresh!.updated_at, ...snapshot.params!],
  }
}

/** Block or open the chosen local days: offered times become cancelled sessions, unheld saved ones are cancelled or restored, held ones never touched. */
export function prepareScheduleDays(calendar: SlotCalendar, places: SlotPlaces, input: { dates: string[]; closed: boolean; actorId: string; now: string }): { queries: BatchQuery[]; count: number } {
  const { schedule } = calendar
  const dates = new Set(input.dates)
  const groups = new Map<string, ScheduledOpening[]>()
  const projected = new Set<string>()
  const queries: BatchQuery[] = []
  for (const opening of input.closed ? calendar.openings : []) {
    const { session, refresh } = opening
    if ((session.created_at !== null && !refresh) || !dates.has(sessionLocalDate(session))) continue
    projected.add(session.id)
    if (refresh) {
      queries.push(refreshSavedOpening(schedule, opening, input.now, input.actorId, 'cancelled'), assertBookingBatchWrite({ query: 'changes() = 1' }))
      continue
    }
    const key = JSON.stringify([session.location_id, session.availability_rule_id])
    groups.set(key, [...(groups.get(key) ?? []), opening])
  }
  for (const openings of groups.values()) {
    for (const chunk of openingChunks(openings)) {
      queries.push(persistProjectedOpenings(schedule, chunk, input.now, input.actorId, 'cancelled'), assertBookingBatchWrite({ query: 'changes() = ?', params: [chunk.length] }))
    }
  }
  const from = input.closed ? 'scheduled' : 'cancelled'
  const targets = scheduleSessions(calendar, places, { statuses: [from], now: input.now })
    .filter(session => session.updated_at !== null && !projected.has(session.id) && session.claimed === 0 && dates.has(sessionLocalDate(session)))
    .map(session => session.id)
  if (targets.length) {
    queries.push({
      query: `UPDATE product_sessions SET status = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ? AND status = ? AND id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.product_session_id = product_sessions.id AND ${CAPACITY_CONSUMING_SQL})
        AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.session_id = product_sessions.id AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      params: [input.closed ? 'cancelled' : 'scheduled', input.now, input.actorId, schedule.config.organization_id, schedule.config.product_id, from, JSON.stringify(targets)],
    })
  }
  return { queries, count: targets.length + projected.size }
}

interface SessionSelector {
  organizationId: string
  productId: string
  sessionId: string
  locationId?: string | null
  now?: string
}

/** The offered time a session id names, read through the slot reader at that instant. */
async function findOpening(db: DbClient, env: CloudflareEnv | null, input: SessionSelector, now: string, scope: SlotReadScope) {
  const saved = await queryFirst<ProductSession>(db, `SELECT * FROM product_sessions WHERE organization_id=? AND product_id=? AND id=?`,
    [input.organizationId, input.productId, input.sessionId])
  const starts = saved?.starts_at ?? projectedIdPattern.exec(input.sessionId)?.[1]
  if (!starts || !Number.isFinite(Date.parse(starts))) return null
  const calendar = await readSlotCalendar(db, env, {
    ...input, now, scope, locationId: input.locationId === undefined ? saved?.location_id : input.locationId,
    fromInstant: starts, toInstant: new Date(Date.parse(starts) + 1).toISOString(),
  })
  const opening = calendar.openings.find(item => item.session.id === input.sessionId)
  return { calendar, opening: opening && bookableSessions(calendar.schedule, [opening.session as BookableSession], now).length ? opening : null }
}

/** Verify a session selector without storing its occurrence. */
export async function findBookableSession(db: DbClient, input: SessionSelector, scope: 'bookable' | 'editor' = 'bookable'): Promise<SessionFacts | null> {
  return (await findOpening(db, null, input, input.now ?? new Date().toISOString(), scope))?.opening?.session ?? null
}

/** Re-derive the exact offered occurrence and prepare its first claim. */
export async function resolveBookingSession(db: DbClient, input: SessionSelector & {
  env: CloudflareEnv; actorId: string
}, scope: SlotReadScope = 'bookable'): Promise<ResolvedBookingSession> {
  const now = input.now ?? new Date().toISOString()
  const found = await findOpening(db, input.env, input, now, scope)
  if (!found) throw new HTTPError({ statusCode: 404, message: 'That session is not open for booking' })
  const { calendar, opening } = found
  if (!opening) throw new HTTPError({ statusCode: 409, message: 'That session is no longer offered. Choose an available time.' })
  return prepareResolvedOpening(calendar.schedule, opening, now, input.actorId, (await calendar.places()).availability)
}

function prepareResolvedOpening(schedule: SlotSchedule, opening: ScheduledOpening, now: string, actorId: string | null, providerAvailability: string): ResolvedBookingSession {
  const { session, refresh } = opening
  const snapshot = slotScheduleGuard(schedule, opening)
  const preceding: BatchQuery[] = []
  if (actorId && session.created_at === null) {
    preceding.push(persistProjectedOpenings(schedule, [opening], now, actorId, 'scheduled'))
  } else if (actorId && refresh) {
    preceding.push(refreshSavedOpening(schedule, opening, now, actorId, 'scheduled'))
  }
  const guard = {
    query: `s.location_id IS ? AND s.starts_at=? AND s.ends_at=? AND s.capacity IS ?
      AND s.timezone=? AND s.source_occurrence_key IS ? AND (${snapshot.query})`,
    params: [session.location_id, session.starts_at, session.ends_at, session.capacity,
      session.timezone, session.source_occurrence_key, ...snapshot.params!],
  }
  const previewGuard = session.created_at === null ? {
    query: `NOT EXISTS (SELECT 1 FROM product_sessions stored WHERE stored.organization_id=s.organization_id AND stored.product_id=s.product_id
      AND ((stored.location_id IS s.location_id AND stored.starts_at=s.starts_at) OR stored.source_occurrence_key=s.source_occurrence_key)
      AND (stored.id<>s.id OR stored.status<>'scheduled' OR stored.starts_at<>s.starts_at OR stored.ends_at<>s.ends_at
        OR stored.location_id IS NOT s.location_id OR stored.timezone<>s.timezone OR stored.capacity IS NOT s.capacity))`,
  } : {
    query: `EXISTS (SELECT 1 FROM product_sessions stored WHERE stored.id=s.id AND stored.organization_id=s.organization_id
      AND stored.product_id=s.product_id AND stored.updated_at=? ${refresh ? `AND NOT ${historySql('stored')}` : ''} )`,
    params: [session.updated_at],
  }
  return { session, preceding, guard, previewGuard, observedAt: now, providerAvailability }
}

/** Abort a D1 batch when its guarded hold, booking or move affected no row. */
export function assertBookingBatchWrite(predicate: BatchQuery): BatchQuery {
  return { query: `SELECT CASE WHEN (${predicate.query}) THEN 1 ELSE json_extract('{}', 'BOOKING_WRITE_REFUSED') END`, params: predicate.params }
}

export function bookingBatchWriteRefused(error: unknown): boolean {
  return error instanceof Error && /BOOKING_WRITE_REFUSED/.test(error.message)
}

export class CapacityUnavailableError extends Error {
  constructor() {
    super('The session no longer has room for this party')
    this.name = 'CapacityUnavailableError'
  }
}

/**
 * The capacity-claiming INSERT, as a query rather than an execution.
 *
 * Exposed so a caller that must move a booking — cancel one claim and take
 * another — can put both in ONE batch. D1 applies a batch in order and
 * atomically, so the release lands before this predicate counts seats, and a
 * failure anywhere leaves the guest's original seat untouched.
 */
export interface SessionAllocationInput {
  env: CloudflareEnv
  organizationId: string; productId: string; sessionId: string; partySize: number; now: string
  resolved?: ResolvedBookingSession
  /** Test a proposed allocation without writing its projected session. */
  preview?: boolean
  /** Publication keeps its page when sale is disabled; bookings require active sale by default. */
  requireActive?: boolean
  replacingBookingId?: string | null
  /** Only authenticated capture reconciliation supplies this; public callers cannot exclude holds. */
  chargedPaymentId?: string
  /** Authenticated automatic capture time; delivery time still checks current capacity. */
  chargedAt?: string
  /** The conversation the claim answers, and the key its decision is recorded under: the claim lands only while nobody has answered. */
  requireUndecided?: { requestId: string; organizationId: string; decisionDedupeKey: string } | null
}

export async function sessionAllocationPredicate(db: DbClient, input: SessionAllocationInput): Promise<BatchQuery> {
  const resolved = input.resolved
  if (resolved && (resolved.session.id !== input.sessionId || resolved.session.organization_id !== input.organizationId || resolved.session.product_id !== input.productId)) {
    throw new Error('Resolved availability belongs to another booking')
  }
  const [location, session] = await Promise.all([
    resolved?.guard ?? sessionLocationGuard(db, input),
    resolved?.session ?? queryFirst<Pick<ProductSession, 'starts_at' | 'ends_at' | 'timezone'>>(db,
      'SELECT starts_at, ends_at, timezone FROM product_sessions WHERE id=? AND organization_id=? AND product_id=?',
      [input.sessionId, input.organizationId, input.productId]),
  ])
  if (!session) return { query: '0', params: [] }
  if (input.preview && !resolved) throw new Error('An availability preview needs a resolved session')
  const virtual = input.preview ? resolved?.session : undefined
  const source = virtual ? `(SELECT ? AS id, ? AS organization_id, ? AS product_id, ? AS location_id, ? AS starts_at,
    ? AS ends_at, ? AS timezone, ? AS capacity, ? AS source_occurrence_key, ? AS status)` : 'product_sessions'
  const availability = resolved?.providerAvailability ?? await memberAvailabilityJson(db, input.env, input.organizationId,
    { from: session.starts_at, until: session.ends_at }, await sessionProviderIds(db, input.organizationId, input.sessionId))
  return { query: `${input.chargedPaymentId ? `EXISTS (SELECT 1 FROM payment_checkout_holds h JOIN payments p ON p.id=h.payment_id WHERE p.id=? AND p.organization_id=? AND p.refunded_amount=0 AND h.status IN ('active','released') AND h.expires_at>? AND h.session_id=? AND h.quantity=? AND h.organization_id=p.organization_id AND h.amount=p.amount AND h.currency=p.currency) AND ` : ''}${input.requireUndecided
        ? `EXISTS (SELECT 1 FROM conversations WHERE id = ? AND organization_id = ?)
           AND NOT EXISTS (SELECT 1 FROM messages WHERE dedupe_key = ?) AND `
        : ''}EXISTS (
        SELECT 1 FROM ${source} s
        WHERE s.id = ? AND s.organization_id = ? AND s.product_id = ?
          AND s.status = 'scheduled'
          AND EXISTS (SELECT 1 FROM product_booking_configs c JOIN products p ON p.id=c.product_id AND p.organization_id=c.organization_id
            WHERE c.product_id=s.product_id AND c.organization_id=s.organization_id AND c.duration_minutes>0
              ${input.chargedPaymentId || input.requireActive === false ? '' : 'AND p.active=1'} AND (s.location_id IS NOT NULL OR c.held_online=1)
              -- Advance notice: a start inside it is not booked or moved onto. A paid hold already passed it when it was taken.
              ${input.chargedPaymentId ? '' : "AND julianday(s.starts_at) > julianday('now') + COALESCE(c.advance_notice_minutes, 0) / 1440.0"})
          AND (${location.query})
          ${input.preview && resolved ? `AND (${resolved.previewGuard.query})` : ''}
          -- The location's own sale switch is part of being bookable: a branch
          -- that has stopped selling this does not take seats for it.
          AND (s.location_id IS NULL OR EXISTS (
            SELECT 1 FROM product_locations pl
             WHERE pl.organization_id = s.organization_id AND pl.product_id = s.product_id AND pl.location_id = s.location_id
               ${input.requireActive === false ? '' : 'AND pl.active = 1'} AND pl.published = 1
          ))
          AND s.starts_at > ?
          AND NOT ${providerUnavailableSql('s', '?', '?')}
          AND (s.capacity IS NULL OR s.capacity >= ? + ${sessionHeldCapacitySql('s','?')} + COALESCE((
            SELECT SUM(b.party_size) FROM bookings b
            WHERE b.product_session_id = s.id AND b.id IS NOT ? AND ${CAPACITY_CONSUMING_SQL}
          ), 0))
      )`, params: [
      ...(input.chargedPaymentId ? [input.chargedPaymentId,input.organizationId,input.chargedAt ?? input.now,input.sessionId,input.partySize] : []),
      ...(input.requireUndecided
        ? [input.requireUndecided.requestId, input.requireUndecided.organizationId, input.requireUndecided.decisionDedupeKey]
        : []),
      ...(virtual ? [virtual.id, virtual.organization_id, virtual.product_id, virtual.location_id, virtual.starts_at, virtual.ends_at,
        virtual.timezone, virtual.capacity, virtual.source_occurrence_key, virtual.status] : []),
      input.sessionId, input.organizationId, input.productId, ...location.params!, ...(input.preview ? resolved?.previewGuard.params ?? [] : []), input.now, ...providerAvailabilityParams(availability), input.replacingBookingId ?? null, input.chargedPaymentId ?? null, input.partySize, input.chargedPaymentId ?? null, input.replacingBookingId ?? null,
  ] }
}

/**
 * Move the same operational Booking ID, preserving its review and payment
 * identity. `productId` is the destination session's product: a table booking
 * may move to another location's tables, taking that product's option
 * (`productVariantId`); `fromProductId` is the product it is booked on now.
 */
export async function sessionMoveQuery(db: DbClient, input: SessionAllocationInput & { bookingId: string; fromProductId: string; productVariantId: string; writeGuard?: BatchQuery }): Promise<BatchQuery> {
  const allocation = await sessionAllocationPredicate(db, { ...input, replacingBookingId: input.bookingId })
  return {
    query: `UPDATE bookings SET product_id = ?, product_variant_id = ?, product_session_id = ?, party_size = ?, updated_at = ?, version = version + 1,
        location_id = (SELECT location_id FROM product_sessions WHERE id = ?), starts_at = (SELECT starts_at FROM product_sessions WHERE id = ?),
        ends_at = (SELECT ends_at FROM product_sessions WHERE id = ?), timezone = (SELECT timezone FROM product_sessions WHERE id = ?)
      WHERE ${input.writeGuard ? `(${input.writeGuard.query}) AND ` : ''}id = ? AND organization_id = ? AND product_id = ? AND status IN ('pending', 'confirmed')
        AND EXISTS (SELECT 1 FROM product_sessions current_session WHERE current_session.id=bookings.product_session_id AND current_session.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND ${allocation.query}
        AND (NOT EXISTS (SELECT 1 FROM payments p WHERE p.organization_id=bookings.organization_id AND p.subject_type='booking' AND p.subject_id=bookings.id AND p.captured_amount>p.refunded_amount)
          OR (party_size=? AND (SELECT location_id FROM product_sessions WHERE id=bookings.product_session_id) IS (SELECT location_id FROM product_sessions WHERE id=? AND organization_id=bookings.organization_id)))`,
    params: [input.productId, input.productVariantId, input.sessionId, input.partySize, input.now, input.sessionId, input.sessionId, input.sessionId, input.sessionId, ...(input.writeGuard?.params ?? []), input.bookingId, input.organizationId, input.fromProductId, ...allocation.params!, input.partySize, input.sessionId],
  }
}

export async function sessionClaimQuery(db: DbClient, input: {
  env: CloudflareEnv
  bookingId: string
  organizationId: string
  productId: string
  sessionId: string
  resolved?: ResolvedBookingSession
  productVariantId: string
  partySize: number
  /** The Better Auth user the booking belongs to. */
  userId?: string | null
  /**
   * A booking this claim replaces. Its seats are not counted against the
   * destination's capacity: a guest moving within a full session is not
   * blocked by the seat they are giving up, and one moving into a session
   * that is full without them still is.
   */
  replacingBookingId?: string | null
  /**
   * The request this claim is part of answering, the version it was read at,
   * and the decision key that records the answer.
   *
   * The claim lands only while that request is still exactly what the caller
   * saw *and* nobody has answered the proposal yet. A competing decline
   * records its decision without touching the request, so the version alone
   * would let a losing acceptance take seats it then cannot attach to
   * anything.
   */
  requireUndecided?: { requestId: string; organizationId: string; updatedAt: string; decisionDedupeKey: string } | null
  chargedPaymentId?: string
  /** Authenticated automatic capture time; delivery time still checks current capacity. */
  chargedAt?: string
  /** The terms the guest agreed to (BookingPolicy), frozen on the booking. */
  policyJson: string
  /** The guest's answers to the product's questions, as accepted when they booked. */
  answers?: FormAnswerSnapshot[]
  /** The guest said "this many or more". */
  partySizeIsMinimum?: boolean
  /** How a website guest arrived (bookings.website_source); null for a booking a member makes. */
  websiteSource: string | null
  now: string
}): Promise<BatchQuery> {
  const allocation = await sessionAllocationPredicate(db, input)
  return {
    query: `
      INSERT INTO bookings (
        id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone,
        user_id, party_size, party_size_is_minimum, answers, policy_json, status, website_source, received_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?,
        (SELECT location_id FROM product_sessions WHERE id = ? AND organization_id = ?),
        (SELECT starts_at FROM product_sessions WHERE id = ? AND organization_id = ?),
        (SELECT ends_at FROM product_sessions WHERE id = ? AND organization_id = ?),
        (SELECT timezone FROM product_sessions WHERE id = ? AND organization_id = ?),
        ?, ?, ?, ?, ?,
        COALESCE((SELECT status FROM bookings WHERE id = ?),
          (SELECT CASE WHEN confirmation_mode = 'review' THEN 'pending' ELSE 'confirmed' END
           FROM product_booking_configs WHERE product_id = ? AND organization_id = ?)), ?, ?, ?, ?
      WHERE ${allocation.query}
        AND EXISTS(SELECT 1 FROM product_variants v WHERE v.id=? AND v.product_id=? AND v.organization_id=? AND v.active=1)
      ON CONFLICT (id) DO NOTHING
    `,
    params: [
      input.bookingId, input.organizationId, input.productId, input.sessionId, input.productVariantId,
      ...[0, 1, 2, 3].flatMap(() => [input.sessionId, input.organizationId]),
      input.userId ?? null, input.partySize, input.partySizeIsMinimum ?? false, JSON.stringify(input.answers ?? []), input.policyJson, input.replacingBookingId ?? null, input.productId, input.organizationId, input.websiteSource, input.now, input.now, input.now,
      ...allocation.params!, input.productVariantId,input.productId,input.organizationId,
    ],
  }
}

/**
 * The single protected capacity operation.
 *
 * Every booking claim — guest checkout, dashboard, MCP, ChowBot, WhatsApp —
 * goes through here or through `sessionClaimQuery`. Session identity alone is
 * not the concurrency control: the insert carries its own capacity predicate,
 * so two concurrent claims for the last seat cannot both succeed. D1 applies
 * each statement atomically, and the second inserts zero rows and raises.
 */
export async function claimSessionCapacity(db: DbClient, input: {
  env: CloudflareEnv
  organizationId: string
  productId: string
  sessionId: string
  resolved?: ResolvedBookingSession
  productVariantId: string
  partySize: number
  /** The Better Auth user the booking belongs to. */
  userId?: string | null
  /** The terms the guest agreed to (BookingPolicy), frozen on the booking. */
  policyJson: string
  answers?: FormAnswerSnapshot[]
  partySizeIsMinimum?: boolean
  /** How a website guest arrived (bookings.website_source); null for a booking a member makes. */
  websiteSource: string | null
  /**
   * The writes that belong to this claim, given the id it minted.
   *
   * They run AFTER the claim, in the same batch, and each one has to carry the
   * claim's existence in its own predicate: a claim that finds no room inserts
   * zero rows and raises nothing, so anything written ahead of it — or written
   * after it unconditionally — commits into a booking that does not exist.
   */
  following?: (_bookingId: string) => BatchQuery[]
}): Promise<{ bookingId: string }> {
  if (!Number.isSafeInteger(input.partySize) || input.partySize < 1) badRequest('party_size must be a positive integer')

  await requireBookingConfig(db, input.organizationId, input.productId)
  const now = new Date().toISOString()
  const resolved = input.resolved ?? (projectedIdPattern.test(input.sessionId)
    ? await resolveBookingSession(db, { ...input, actorId: input.userId ?? 'system', now })
    : undefined)
  const bookingId = crypto.randomUUID()
  const claim = await sessionClaimQuery(db, { ...input, resolved, bookingId, now })
  const preceding = resolved?.preceding ?? []
  try {
    await executeBatch(db, [...preceding, claim, assertBookingBatchWrite({ query: 'changes() = 1' }),
      ...(input.following?.(bookingId) ?? [])], { operation: 'Claim session capacity' })
  } catch (error) {
    if (bookingBatchWriteRefused(error)) throw new CapacityUnavailableError()
    throw error
  }
  return { bookingId }
}

export async function createSession(db: DbClient, input: {
  env: CloudflareEnv; organizationId: string; productId: string; locationId: string; startsAt: string; endsAt: string; capacity?: number | null; actorId: string; idempotencyKey: string
}): Promise<SessionAvailability[]> {
  if (typeof input.idempotencyKey !== 'string') badRequest('An idempotency key is required')
  const key = input.idempotencyKey.trim()
  if (!key || key.length > 200) badRequest('An idempotency key of 1–200 characters is required')
  const dedupeKey = `session:${input.organizationId}:${key}`
  const requestHash = await creationRequestHash({ productId: input.productId, locationId: input.locationId, startsAt: input.startsAt, endsAt: input.endsAt, capacity: input.capacity })
  const replay = async () => {
    const record = await readCreationRecord(db, dedupeKey)
    if (!record) return null
    if (record.requestHash !== requestHash) throw new HTTPError({ statusCode: 409, statusMessage: 'This idempotency key belongs to a different session' })
    const ids = record.metadata.session_ids
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('The session creation record does not identify its sessions')
    return Promise.all(ids.map(sessionId => getScheduleSession(db, input.env, { organizationId: input.organizationId, productId: input.productId, sessionId })))
  }
  const earlier = await replay()
  if (earlier) return earlier
  if ((await requireOrganizationProduct(db, input)).kind === 'table') badRequest(TABLE_HOURS_ONLY)
  const config = await requireBookingConfig(db, input.organizationId, input.productId)
  const location = await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, input.locationId])
  if (!location) badRequest('Choose a location in this business')
  const instants = sessionInstants(input.startsAt, input.endsAt)
  const now = new Date().toISOString()
  if (instants.starts_at <= now) badRequest('A new session must start in the future')
  const capacity = input.capacity === undefined ? config.default_capacity : input.capacity
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0)) badRequest('capacity must be a non-negative integer or null')
  if (!locationAllowsBooking(instants, location)) badRequest('This session is outside opening hours or during a closure')
  if (config.scheduling_mode === 'provider' && !await readScheduleProvider(db, config)) badRequest('Set working hours for the assigned member before adding bookable times')
  const sessions = [{ id: crypto.randomUUID() }]
  try {
    await executeBatch(db, [...sessions.map(session => manualSessionQuery({ ...input, now, location }, { id: session.id, ...instants, capacity })),
      organizationEventQuery({ organizationId: input.organizationId, locationId: input.locationId, actorId: input.actorId, eventType: 'product.updated', entityType: 'session', entityId: sessions[0]!.id, dedupeKey, metadata: { request_hash: requestHash, product_id: input.productId, session_ids: sessions.map(session => session.id) } }),
      publicResourceCacheInvalidationQuery(input.organizationId, 'product-session-created')], { operation: 'Create product session' })
  } catch (error) {
    if (isUniqueDedupeConflict(error)) { const concurrent = await replay(); if (concurrent) return concurrent }
    throw error
  }
  return Promise.all(sessions.map(session => getScheduleSession(db, input.env, { organizationId: input.organizationId, productId: input.productId, sessionId: session.id })))
}

export async function updateSession(db: DbClient, input: {
  env: CloudflareEnv
  organizationId: string
  sessionId: string
  productId?: string
  expectedUpdatedAt?: string | null
  resolved?: ResolvedBookingSession
  actorId: string
  startsAt?: string
  endsAt?: string
  capacity?: number | null
  status?: ProductSessionStatus
}): Promise<SessionAvailability> {
  const now = new Date().toISOString()
  const stored = await queryFirst<ProductSession>(db, `
    SELECT * FROM product_sessions WHERE organization_id=? AND id=? AND (? IS NULL OR product_id=?)
  `, [input.organizationId, input.sessionId, input.productId ?? null, input.productId ?? null])
  const resolved = !stored && input.productId && projectedIdPattern.test(input.sessionId)
    ? input.resolved ?? await resolveBookingSession(db, { ...input, productId: input.productId, now }, 'editor')
    : undefined
  const session = stored ?? resolved?.session
  if (!session || session.id !== input.sessionId || session.organization_id !== input.organizationId || (input.productId && session.product_id !== input.productId)) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found' })
  }
  if ((await requireBookingConfig(db, input.organizationId, session.product_id)).seating_interval_minutes !== null) badRequest(TABLE_HOURS_ONLY)

  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== session.updated_at) throw new HTTPError({ statusCode: 409, statusMessage: 'This session changed; read its current state before editing' })
  if (input.status !== undefined && !(PRODUCT_SESSION_STATUSES as readonly string[]).includes(input.status)) badRequest('Invalid session status')
  const { starts_at: startsAt, ends_at: endsAt } = sessionInstants(input.startsAt ?? session.starts_at, input.endsAt ?? session.ends_at)
  if (input.capacity !== undefined && input.capacity !== null && (!Number.isSafeInteger(input.capacity) || input.capacity < 0)) {
    badRequest('capacity must be a non-negative integer or null')
  }

  // Reducing capacity below the seats already claimed would make the session
  // silently oversold. Refuse, and let the merchant cancel bookings first.
  if (input.capacity !== undefined && input.capacity !== null) {
    const row = (await readSlotCalendar(db, input.env, { organizationId: input.organizationId, productId: session.product_id, scope: 'editor', fromInstant: session.starts_at, toInstant: new Date(Date.parse(session.starts_at) + 1).toISOString() })).stored.find(saved => saved.id === session.id)
    const claimed = row ? row.booked + row.held : 0
    if (claimed > input.capacity) throw new HTTPError({ statusCode: 409, statusMessage: `This session already has ${claimed} seats claimed; cancel bookings before reducing capacity to ${input.capacity}` })
  }

  const location = session.location_id ? await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, session.location_id]) : null
  const moved = startsAt !== session.starts_at || endsAt !== session.ends_at
  // Only a move needs the provider's availability at the new time; a capacity or status change asks no calendar.
  const availability = moved ? await memberAvailabilityJson(db, input.env, input.organizationId, { from: startsAt, until: endsAt }, await sessionProviderIds(db, input.organizationId, input.sessionId)) : null
  if (moved && session.location_id && (!location || !locationAllowsBooking({ starts_at: startsAt, ends_at: endsAt }, location))) badRequest('This session is outside opening hours or during a closure')
  const locationGuard: BatchQuery = moved && location
    ? { query: `AND EXISTS (SELECT 1 FROM business_locations l WHERE l.id=product_sessions.location_id AND l.organization_id=product_sessions.organization_id AND l.status='active' AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`, params: [location.timezone, location.opening_hours, location.special_hours] }
    : { query: '', params: [] }
  // The read above is a courtesy: it gives the merchant a message naming the
  // seats in the way. The write carries the same predicate, so a booking that
  // lands between the two cannot leave the session oversold.
  const capacity = input.capacity === undefined ? session.capacity : input.capacity
  const guard = capacity === null
    ? ''
    : `AND ? >= COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id = product_sessions.id AND ${CAPACITY_CONSUMING_SQL}), 0) + (SELECT ${sessionHeldCapacitySql('held')} FROM product_sessions held WHERE held.id=product_sessions.id)`
  const version = session.updated_at ?? resolved?.observedAt
  await executeBatch(db, [
    ...(resolved ? [...resolved.preceding, assertBookingBatchWrite({ query: 'changes() = 1' })] : []), {
    query: `
      UPDATE product_sessions
      SET starts_at = ?, ends_at = ?, capacity = ?, status = ?, updated_at = ?, updated_by = ?
      WHERE organization_id = ? AND id = ? AND updated_at=? ${guard} ${locationGuard.query}
        AND ((starts_at=? AND ends_at=? AND status=?) OR (
          NOT EXISTS(SELECT 1 FROM bookings b WHERE b.product_session_id=product_sessions.id AND ${CAPACITY_CONSUMING_SQL})
          AND NOT EXISTS(SELECT 1 FROM payment_checkout_holds h WHERE h.session_id=product_sessions.id AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
        AND (NOT EXISTS (SELECT 1 FROM bookings b WHERE b.product_session_id = product_sessions.id AND ${CAPACITY_CONSUMING_SQL})
          OR ${availability === null ? '1' : `NOT EXISTS (SELECT 1 FROM (SELECT product_sessions.id AS id, product_sessions.organization_id AS organization_id, product_sessions.product_id AS product_id, product_sessions.location_id AS location_id, ? AS starts_at, ? AS ends_at) proposed
            WHERE ${providerUnavailableSql('proposed')})`})
    `,
    params: [
      startsAt, endsAt, capacity,
      input.status ?? session.status, now, input.actorId,
      input.organizationId, input.sessionId, version,
      ...(capacity === null ? [] : [capacity]), ...locationGuard.params!, startsAt, endsAt, input.status ?? session.status, ...(availability === null ? [] : [startsAt, endsAt, ...providerAvailabilityParams(availability)]),
    ],
  }, assertBookingBatchWrite({ query: 'changes() = 1' }), organizationEventQuery({ organizationId: input.organizationId, locationId: session.location_id, actorId: input.actorId, eventType: 'product.updated', entityType: 'session', entityId: session.id, onlyIfPreviousChangedOneRow: true,
    beforeState: { starts_at: session.starts_at, ends_at: session.ends_at, capacity: session.capacity, status: session.status }, afterState: { starts_at: startsAt, ends_at: endsAt, capacity, status: input.status ?? session.status } }),
  publicResourceCacheInvalidationQuery(input.organizationId, 'product-session-updated')], { operation: 'Update product session' }).catch(error => {
    if (bookingBatchWriteRefused(error)) {
      throw new HTTPError({
        statusCode: 409,
        statusMessage: 'This session, its opening hours or its capacity changed, or it has live bookings; reload and resolve the conflict',
        cause: error,
      })
    }
    throw error
  })
  return getScheduleSession(db, input.env, { organizationId: input.organizationId, productId: session.product_id, sessionId: session.id })
}

/** The local calendar date a session falls on, for grouping in a UI. */
export function sessionLocalDate(session: Pick<ProductSession, 'starts_at' | 'timezone'>): string {
  return localDateAt(new Date(session.starts_at), session.timezone)
}

export function assertLocalStartTime(value: string, field = 'start_time'): void {
  if (!MINUTE_TIME_PATTERN.test(value)) badRequest(`${field} must be in "HH:MM" format`)
}

