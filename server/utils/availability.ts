import { assertResponsibleMember } from '~/server/utils/member-access'
import { opportunityDoneQuery } from '~/server/domain/tasks'
import { publishAccessInvalidation, publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { assertPublishedHost } from '~/server/utils/public-provider'
import { creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { d1JsonValue, MAX_D1_BATCH_STATEMENTS } from '~/server/db/d1-limits'
import { getDateIntervals, locationAllowsBooking, parseOpeningHours, parseSpecialHours, toTimeString } from '~/shared/reservation-hours'
import { providerAvailabilityParams, providerMemberSql, providerUnavailableSql } from '~/server/utils/provider-allocation'
import { memberAvailabilityJson, workingWindows } from '~/server/domain/member-scheduling'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { WorkingHours } from '~/shared/member-scheduling'
import { HTTPError } from 'nitro'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import {
  CAPACITY_CONSUMING_SQL,
  PRODUCT_SESSION_STATUSES,
  occurrenceKey,
  parseStayCalendarRules,
  PUBLIC_BOOKING_WINDOW_DAYS,
  type StayCalendarRules,
  type ProductSessionStatus,
} from '~/shared/bookings'
import { formQuestionsRevision, parseStoredFormQuestions, type FormAnswerSnapshot, type FormQuestion } from '~/shared/form-questions'
import type { StayCancellationPolicy, StayLongTermCancellationPolicy } from '~/shared/stay-listing'
import { prepareFormQuestionsWrite } from '~/server/domain/form-questions'
import { addLocalDays, assertCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant, localNow, MINUTE_TIME_PATTERN, unresolvableLocalTime } from '~/utils/timezone'

/**
 * The booking capability.
 *
 * A Product is bookable because it has a `product_booking_configs` row, not
 * because it has a duration or a vertical name. Rules describe when sessions
 * ought to exist; sessions ARE the occurrences and own their time, capacity
 * and state; a booking claims seats on one session. No step is inferred from
 * the absence of another.
 *
 * A restaurant's tables are a `table` product booked the same way. It has no
 * rules: its seatings are its location's current opening and special hours,
 * cut by `tableSeatings`, and a booking claims that seating's seats.
 */

const MAX_GENERATION_DAYS = 365
/** Why a table takes no weekly times, dated sessions or per-seating edits. */
const TABLE_HOURS_ONLY = 'A table is seated through its location\'s opening hours. Change those hours, or add special hours or a closure, to change when tables can be booked'
const MAX_CALENDAR_DAYS = 42

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
}

/** A session with its claimed seats resolved. `remaining` is null when uncapped. */
export interface SessionAvailability extends ProductSession {
  claimed: number
  remaining: number | null
  is_full: boolean
}

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
  // A home is booked by the night on its business's calendar, paid in full on the site and confirmed when paid.
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
  }, ...(unit === 'slot' && patch.online_payment_required === true ? [opportunityDoneQuery(input.organizationId, ['product.payment'], input.productId, now)] : [])] }
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
  const { queries: configQueries, config } = await prepareProductBookingConfig(db, input)
  // Questions are not scheduling: a question-only edit writes the questions and
  // leaves every session, rule and provider-hours occurrence where it was.
  if (questionsOnly) {
    await executeBatch(db, [...configQueries, publicResourceCacheInvalidationQuery(input.organizationId, 'product-booking-questions')], { operation: 'Set product booking questions' }).catch(error => { throw bookingConfigurationWriteError(error) })
    return requireBookingConfig(db, input.organizationId, input.productId)
  }
  const rules = await listAvailabilityRules(db, input.organizationId, input.productId)
  const locations = await queryAll<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id IN (SELECT value FROM json_each(?))', [input.organizationId, JSON.stringify([...new Set(rules.map(rule => rule.location_id))])])
  const throughDate = rules.map(rule => addLocalDays(localNow(rule.timezone).date, PUBLIC_BOOKING_WINDOW_DAYS)).sort().at(-1)
  const materialized = throughDate ? prepareSessionMaterialization({ ...input, throughDate }, config, rules, new Map(locations.map(location => [location.id, location])), await canScheduleSessions(db, config)).queries : []
  const online = config.held_online ? await prepareProviderHoursSessions(db, config, { actorId: input.actorId, now: new Date().toISOString() }) : []
  // A table's seatings take its new length, interval and seats in the same batch.
  const location = config.seating_interval_minutes === null ? null : await tableLocation(db, config)
  const seatings = location ? tableSeatingQueries(config, location, { actorId: input.actorId, now: new Date().toISOString() }) : []
  if (location) {
    const guard = tableLocationSnapshot(config, location)
    configQueries.push({
      query: `UPDATE product_booking_configs SET updated_at=CASE WHEN (${guard.query}) THEN updated_at ELSE NULL END WHERE product_id=? AND organization_id=?`,
      params: [...guard.params!, config.product_id, config.organization_id],
    })
  }
  const paymentEnabled = input.patch.online_payment_required === true
  const queries = [...configQueries, ...materialized, ...online, ...seatings, publicResourceCacheInvalidationQuery(input.organizationId, 'product-booking-config')]
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
): Promise<ProductAvailabilityRule[]> {
  return queryAll<ProductAvailabilityRule>(db, `
    SELECT id, organization_id, product_id, location_id, timezone, weekday, start_time, capacity
    FROM product_availability_rules
    WHERE organization_id = ? AND product_id = ?
    ORDER BY weekday, start_time, id
  `, [organizationId, productId])
}

function resolvedDuration(config: ProductBookingConfigRecord): number {
  const minutes = config.duration_minutes
  if (minutes === null) {
    throw new HTTPError({
      statusCode: 409,
      statusMessage: 'Set a session length on the product before generating sessions',
    })
  }
  return minutes
}

async function canScheduleSessions(db: DbClient, config: ProductBookingConfigRecord): Promise<boolean> {
  // In provider mode the member's own hours are the schedule; without them there is nothing to hold.
  if (config.scheduling_mode !== 'provider') return true
  return Boolean(await queryFirst(db, 'SELECT member_id FROM member_scheduling WHERE member_id=? AND organization_id=? AND timezone IS NOT NULL', [config.assigned_member_id, config.organization_id]))
}

/**
 * Sessions whose open time is someone's hours rather than weekly rules: an
 * online offering's (its provider's working hours) and a table's (its
 * location's opening and special hours). `slots` is every start those hours
 * give inside the public window.
 *
 * One statement retires the future, unclaimed sessions the hours no longer
 * cover, and one inserts the slots they do. A slot that comes back reopens its
 * own row; a claimed session (a booking, even a cancelled one, or a live
 * checkout hold) is never moved or cancelled here — it stays the commitment it
 * is. `guard`, when given, must hold for either statement to write: the hours
 * being written in the same batch.
 */
function hoursSessionQueries(input: {
  organizationId: string; productId: string; locationId: string | null; keyPrefix: string; timezone: string; capacity: number | null
  slots: Array<{ starts_at: string; ends_at: string }>; actorId: string; now: string; guard?: BatchQuery
}): BatchQuery[] {
  const unclaimed = `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id=product_sessions.organization_id AND b.product_session_id=product_sessions.id)
    AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=product_sessions.organization_id AND h.session_id=product_sessions.id AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  const guard = input.guard ?? { query: '1', params: [] }
  const conflict = input.locationId === null ? '(product_id, starts_at) WHERE location_id IS NULL' : '(product_id, location_id, starts_at) WHERE location_id IS NOT NULL'
  return [{
    query: `UPDATE product_sessions SET status='cancelled', updated_at=?, updated_by=?
      WHERE organization_id=? AND product_id=? AND location_id IS ? AND status='scheduled' AND starts_at>?
        AND starts_at NOT IN (SELECT json_extract(value, '$.starts_at') FROM json_each(?)) AND ${unclaimed} AND (${guard.query})`,
    params: [input.now, input.actorId, input.organizationId, input.productId, input.locationId, input.now, JSON.stringify(input.slots), ...guard.params!],
  }, {
    query: `INSERT INTO product_sessions (id, organization_id, product_id, location_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by)
      SELECT lower(hex(randomblob(16))), ?, ?, ?, ? || json_extract(slot.value, '$.starts_at'), ?, json_extract(slot.value, '$.starts_at'), json_extract(slot.value, '$.ends_at'), ?, 'scheduled', ?, ?, ?, ? FROM json_each(?) slot WHERE (${guard.query})
      ON CONFLICT ${conflict} DO UPDATE SET
        ends_at=excluded.ends_at, source_occurrence_key=excluded.source_occurrence_key, timezone=excluded.timezone, capacity=excluded.capacity,
        status='scheduled', updated_at=excluded.updated_at, updated_by=excluded.updated_by
        WHERE ${unclaimed} AND (product_sessions.ends_at IS NOT excluded.ends_at
          OR product_sessions.source_occurrence_key IS NOT excluded.source_occurrence_key
          OR product_sessions.timezone IS NOT excluded.timezone OR product_sessions.capacity IS NOT excluded.capacity
          OR product_sessions.status IS NOT excluded.status)
      ON CONFLICT DO NOTHING`,
    params: [input.organizationId, input.productId, input.locationId, input.keyPrefix, input.timezone, input.capacity, input.now, input.now, input.actorId, input.actorId, JSON.stringify(input.slots), ...guard.params!],
  }]
}

/**
 * An online offering's sessions: each provider's working windows, cut into
 * slots of the offering's length, in that provider's own timezone — the way a
 * Calendly host's availability is their schedule, not a list on the event.
 */
export async function prepareProviderHoursSessions(db: DbClient, config: ProductBookingConfigRecord, input: { actorId: string; now: string }): Promise<BatchQuery[]> {
  const duration = resolvedDuration(config)
  const providers = await queryAll<{ member_id: string; timezone: string; weekly_json: string; time_off_json: string }>(db, `
    SELECT ms.member_id, ms.timezone, ms.weekly_json, ms.time_off_json FROM member_scheduling ms
      JOIN member m ON m.id=ms.member_id AND m.organizationId=ms.organization_id
     WHERE ms.organization_id=? AND ms.timezone IS NOT NULL AND ms.member_id=?
     ORDER BY ms.member_id`, [config.organization_id, config.assigned_member_id])
  if (!providers.length) badRequest('Set working hours for whoever provides this offering before it can be booked online')
  const horizon = new Date(Date.parse(input.now) + PUBLIC_BOOKING_WINDOW_DAYS * 86_400_000).toISOString()
  const queries: BatchQuery[] = []
  for (const provider of providers) {
    const slots: Array<{ starts_at: string; ends_at: string }> = []
    const timeOff = JSON.parse(provider.time_off_json) as Array<{ start: string; end: string }>
    for (const window of workingWindows(provider.timezone, JSON.parse(provider.weekly_json) as WorkingHours[], { from: new Date(input.now), until: new Date(horizon) })) {
      for (let start = Date.parse(window.start); start + duration * 60_000 <= Date.parse(window.end); start += duration * 60_000) {
        const slot = { starts_at: new Date(start).toISOString(), ends_at: new Date(start + duration * 60_000).toISOString() }
        if (slot.starts_at <= input.now) continue
        if (slot.starts_at >= horizon) break
        if (timeOff.some(away => away.start < slot.ends_at && away.end > slot.starts_at)) continue
        slots.push(slot)
      }
    }
    queries.push(...hoursSessionQueries({ organizationId: config.organization_id, productId: config.product_id, locationId: null, keyPrefix: `hours:${provider.member_id}:`,
      timezone: provider.timezone, capacity: config.default_capacity, slots, actorId: input.actorId, now: input.now }))
  }
  return queries
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
export function tableSeatings(config: Pick<ProductBookingConfigRecord, 'duration_minutes' | 'seating_interval_minutes'>, location: SessionLocation, now: string): Array<{ starts_at: string; ends_at: string }> {
  const duration = config.duration_minutes, interval = config.seating_interval_minutes
  if (duration === null || interval === null) throw new Error('A table is seated with a duration and a seating interval')
  if (!isValidTimezone(location.timezone)) throw new HTTPError({ statusCode: 409, statusMessage: 'The table\'s location has an invalid timezone' })
  const hours = parseOpeningHours(location.opening_hours ? JSON.parse(location.opening_hours) : null)
  const special = parseSpecialHours(location.special_hours ? JSON.parse(location.special_hours) : null)
  const today = localNow(location.timezone, new Date(now)).date
  const seatings: Array<{ starts_at: string; ends_at: string }> = []
  for (let date = today; date < addLocalDays(today, PUBLIC_BOOKING_WINDOW_DAYS); date = addLocalDays(date, 1)) {
    for (const period of getDateIntervals(hours, special, date) ?? []) {
      const first = period.start + Math.ceil(Math.max(0, -period.start) / interval) * interval
      for (let minute = first; minute < 1440 && minute + duration <= period.end; minute += interval) {
        const time = toTimeString(minute)
        if (unresolvableLocalTime(date, time, location.timezone)) continue
        const start = localDateTimeToInstant(date, time, location.timezone, 'reject')
        if (start.toISOString() <= now) continue
        seatings.push({ starts_at: start.toISOString(), ends_at: new Date(start.getTime() + duration * 60_000).toISOString() })
      }
    }
  }
  return seatings
}

type TableSeatingConfig = Pick<ProductBookingConfigRecord, 'organization_id' | 'product_id' | 'duration_minutes' | 'seating_interval_minutes' | 'default_capacity'>

/** Write a table's seatings as its location's hours give them now. */
function tableSeatingQueries(config: TableSeatingConfig, location: SessionLocation, input: { actorId: string; now: string; guard?: BatchQuery }): BatchQuery[] {
  return hoursSessionQueries({ organizationId: config.organization_id, productId: config.product_id, locationId: location.id, keyPrefix: `hours:${location.id}:`,
    timezone: location.timezone, capacity: config.default_capacity, slots: tableSeatings(config, location, input.now), actorId: input.actorId, now: input.now, guard: input.guard })
}

/** A table product's one location: tables are booked at exactly one. */
async function tableLocation(db: DbClient, config: ProductBookingConfigRecord): Promise<SessionLocation> {
  const location = await queryFirst<SessionLocation>(db, `SELECT l.id,l.timezone,l.status,l.opening_hours,l.special_hours FROM product_locations pl
    JOIN business_locations l ON l.id=pl.location_id AND l.organization_id=pl.organization_id WHERE pl.organization_id=? AND pl.product_id=?`, [config.organization_id, config.product_id])
  if (!location) throw new HTTPError({ statusCode: 409, statusMessage: 'This table product is not at a location' })
  return location
}

function tableLocationSnapshot(config: TableSeatingConfig, location: SessionLocation): BatchQuery {
  return {
    query: `EXISTS (SELECT 1 FROM product_locations pl
      JOIN business_locations l ON l.id=pl.location_id AND l.organization_id=pl.organization_id
      WHERE pl.product_id=? AND pl.organization_id=? AND l.id=? AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`,
    params: [config.product_id, config.organization_id, location.id, location.timezone, location.opening_hours, location.special_hours],
  }
}

/**
 * The seatings of the table at this location, as the hours being written give
 * them: every writer of a location's opening hours, special hours or timezone
 * adds these to its batch before updating the location. Both writes must
 * still see the location and the seating settings used to plan the change.
 */
export async function prepareLocationTableSeatings(db: DbClient, input: { organizationId: string; location: SessionLocation; actorId: string; now: string; guard: BatchQuery }) {
  const from = `FROM product_locations pl
    JOIN products p ON p.id=pl.product_id AND p.organization_id=pl.organization_id AND p.kind='table'
    JOIN product_booking_configs c ON c.product_id=p.id AND c.organization_id=p.organization_id
    WHERE pl.organization_id=? AND pl.location_id=?`
  const scope = [input.organizationId, input.location.id]
  const config = await queryFirst<TableSeatingConfig>(db, `SELECT c.organization_id,c.product_id,c.duration_minutes,c.seating_interval_minutes,c.default_capacity ${from}`, scope)
  const guard: BatchQuery = config ? {
    query: `(${input.guard.query}) AND EXISTS (SELECT 1 ${from}
      AND c.product_id=? AND c.duration_minutes IS ? AND c.seating_interval_minutes IS ? AND c.default_capacity IS ?)`,
    params: [...input.guard.params!, ...scope, config.product_id, config.duration_minutes, config.seating_interval_minutes, config.default_capacity],
  } : {
    query: `(${input.guard.query}) AND NOT EXISTS (SELECT 1 ${from})`,
    params: [...input.guard.params!, ...scope],
  }
  return { guard, queries: config ? tableSeatingQueries(config, input.location, { ...input, guard }) : [] }
}

/** How a local wall time that does not exist, or exists twice, is handled. */
export interface OccurrenceSkip {
  rule_id: string
  local_date: string
  local_start_time: string
  reason: 'nonexistent_local_time' | 'ambiguous_local_time' | 'location_closed'
}

function instantsFor(
  rule: ProductAvailabilityRule,
  localDate: string,
  localStartTime: string,
  durationMinutes: number,
): { starts_at: string; ends_at: string } | OccurrenceSkip {
  // A gap (the wall time never happens) and a fold (it happens twice) are both
  // refused. Silently picking one of the two instants would book guests into an
  // hour the merchant did not choose.
  const reason = unresolvableLocalTime(localDate, localStartTime, rule.timezone)
  if (reason) return { rule_id: rule.id, local_date: localDate, local_start_time: localStartTime, reason }
  const start = localDateTimeToInstant(localDate, localStartTime, rule.timezone, 'reject')
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + durationMinutes * 60_000).toISOString(),
  }
}

export interface MaterializeSessionsResult {
  created: number
  /** Occurrences already represented by a session — edited, cancelled or rescheduled. */
  existing: number
  skipped: OccurrenceSkip[]
}

/**
 * Generate sessions for every rule of a product, up to `throughDate`.
 *
 * Idempotent by construction. Each occurrence carries the stable
 * `source_occurrence_key` from `shared/bookings`, and insertion relies on the
 * partial unique index over (product_id, source_occurrence_key). Re-running
 * therefore cannot:
 *   - duplicate a session,
 *   - restore one the merchant cancelled (the row still exists),
 *   - overwrite one whose time or capacity was edited (insert does nothing),
 *   - recreate a rescheduled one at its original start (the key is the
 *     intended occurrence, not the actual instant).
 *
 * Bounded: at most MAX_GENERATION_DAYS ahead, so a rule cannot fill the table.
 *
 * `existing` names occurrence keys already stored. Their insert would meet the
 * key's own conflict target and do nothing, so no statement is written for
 * them: re-running over a full window issued one no-op statement per
 * occurrence, 235,000 a day from the scheduled task alone.
 */
function prepareSessionMaterialization(input: {
  organizationId: string; productId: string; fromDate?: string; throughDate: string; actorId: string; now?: string
}, config: ProductBookingConfigRecord, rules: ProductAvailabilityRule[], locations: ReadonlyMap<string, SessionLocation>, schedulable: boolean, existing: ReadonlySet<string> = new Set()): { queries: BatchQuery[]; planned: number; skipped: OccurrenceSkip[]; sessions: Array<{ starts_at: string; ends_at: string }> } {
  assertAvailabilityDate(input.throughDate, 'through')
  if (input.fromDate) assertAvailabilityDate(input.fromDate, 'from')

  const now = input.now ?? new Date().toISOString()
  const skipped: OccurrenceSkip[] = []
  const writes: BatchQuery[] = []
  let planned = 0
  const sessions: Array<{ starts_at: string; ends_at: string }> = []

  for (const rule of rules) {
    if (!isValidTimezone(rule.timezone)) {
      throw new HTTPError({ statusCode: 409, statusMessage: `Rule ${rule.id} has an invalid timezone` })
    }
    const duration = resolvedDuration(config)
    const capacity = rule.capacity ?? config.default_capacity

    // The window is expressed in the rule's own local calendar: a weekly slot
    // is a wall-clock fact, so walking UTC days would drift across DST.
    const today = localNow(rule.timezone).date
    const from = [input.fromDate ?? today, today]
      .reduce((latest, value) => (value > latest ? value : latest))
    const through = [input.throughDate, addLocalDays(today, MAX_GENERATION_DAYS)]
      .reduce((earliest, value) => (value < earliest ? value : earliest))
    if (from > through) continue

    // One statement per rule: a daily class through a year is 365
    // occurrences; one batch statement each would not fit.
    const occurrences: Array<{ id: string; key: string; starts_at: string; ends_at: string }> = []
    for (let date = from; date <= through; date = addLocalDays(date, 1)) {
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== rule.weekday) continue
      const time = rule.start_time
      const resolved = instantsFor(rule, date, time, duration)
      if ('reason' in resolved) { skipped.push(resolved); continue }
      const location = locations.get(rule.location_id)
      if (!location) throw new HTTPError({ statusCode: 409, statusMessage: 'The scheduled location no longer exists' })
      if (!locationAllowsBooking(resolved, location)) { skipped.push({ rule_id: rule.id, local_date: date, local_start_time: time, reason: 'location_closed' }); continue }
      sessions.push(resolved)
      if (!schedulable) continue
      planned += 1
      const key = occurrenceKey(rule.id, date, time)
      if (existing.has(key)) continue
      occurrences.push({ id: crypto.randomUUID(), key, ...resolved })
    }
    if (!occurrences.length) continue
    // A slot that was removed and added back meets its own old sessions at
    // the same instant: the removal cancelled the unbooked ones and left the
    // booked ones scheduled, and cut every one of them loose from the rule.
    // Detached generated sessions without booking history retain the existing
    // re-adoption behavior. Any booking, including cancelled history, protects
    // every actual fact and the occurrence identity. The predicate is inside
    // the UPSERT, so a claim arriving during generation protects the row too.
    // A live rule's session or a hand-made session is also left alone.
    writes.push({
      query: `
        INSERT INTO product_sessions (
          id, organization_id, product_id, location_id, availability_rule_id, source_occurrence_key,
          timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by
        ) SELECT json_extract(o.value, '$.id'), ?, ?, ?, ?, json_extract(o.value, '$.key'), ?, json_extract(o.value, '$.starts_at'), json_extract(o.value, '$.ends_at'), ?, 'scheduled', ?, ?, ?, ?
          FROM json_each(?) o WHERE true
        ON CONFLICT (product_id, source_occurrence_key) WHERE source_occurrence_key IS NOT NULL DO NOTHING
        ON CONFLICT DO UPDATE SET
          availability_rule_id = excluded.availability_rule_id, source_occurrence_key = excluded.source_occurrence_key,
          status = CASE WHEN product_sessions.status = 'cancelled' THEN 'scheduled' ELSE product_sessions.status END,
          ends_at = excluded.ends_at, capacity = excluded.capacity, timezone = excluded.timezone,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by
          WHERE product_sessions.organization_id=excluded.organization_id AND product_sessions.product_id=excluded.product_id
            AND product_sessions.availability_rule_id IS NULL AND product_sessions.source_occurrence_key IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = product_sessions.organization_id AND b.product_session_id = product_sessions.id)
            AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=product_sessions.organization_id AND h.session_id=product_sessions.id AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `,
      params: [
        input.organizationId, input.productId, rule.location_id, rule.id, rule.timezone,
        capacity, now, now, input.actorId, input.actorId, d1JsonValue(occurrences),
      ],
    })
  }

  return { queries: writes, planned, skipped, sessions }
}

export async function materializeSessions(db: DbClient, input: {
  organizationId: string
  productId: string
  locationId?: string | null
  fromDate?: string
  throughDate: string
  actorId: string
}): Promise<MaterializeSessionsResult> {
  const config = await requireBookingConfig(db, input.organizationId, input.productId)
  // A table: its location's hours, as they are now.
  if (config.seating_interval_minutes !== null) {
    const location = await tableLocation(db, config)
    const snapshot = tableLocationSnapshot(config, location)
    const guard: BatchQuery = {
      query: `(${snapshot.query}) AND EXISTS (SELECT 1 FROM product_booking_configs WHERE product_id=? AND organization_id=?
        AND duration_minutes IS ? AND seating_interval_minutes IS ? AND default_capacity IS ?)`,
      params: [...snapshot.params!, config.product_id, config.organization_id, config.duration_minutes, config.seating_interval_minutes, config.default_capacity],
    }
    const results = await executeBatch(db, [
      ...tableSeatingQueries(config, location, { actorId: input.actorId, now: new Date().toISOString(), guard }),
      { query: `SELECT (${guard.query}) AS unchanged`, params: guard.params },
    ], { operation: 'Materialize table seatings' })
    if ((results[2]?.results?.[0] as { unchanged: number } | undefined)?.unchanged !== 1) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'The table or its hours changed. Reload and try again.' })
    }
    return { created: results[1]?.meta?.changes ?? 0, existing: 0, skipped: [] }
  }
  let providerCreated = 0
  // No location named, or the online one: the providers' hours. A location: its weekly rules.
  if (config.held_online && !input.locationId) {
    const results = await executeBatch(db, await prepareProviderHoursSessions(db, config, { actorId: input.actorId, now: new Date().toISOString() }), { operation: 'Materialize provider hours' })
    providerCreated = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0)
  }
  const rules = (await listAvailabilityRules(db, input.organizationId, input.productId))
    .filter(rule => input.locationId === undefined || rule.location_id === input.locationId)
  if (rules.length === 0) return { created: providerCreated, existing: 0, skipped: [] }

  const locations = await queryAll<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id IN (SELECT value FROM json_each(?))', [input.organizationId, JSON.stringify([...new Set(rules.map(rule => rule.location_id))])])
  // Occurrences already stored, read by the product's start index from two
  // days back: a rule's local today begins at most a day before now. A key
  // missed here only costs its insert, which then does nothing.
  const stored = await queryAll<{ source_occurrence_key: string }>(db, `
    SELECT source_occurrence_key FROM product_sessions
     WHERE product_id = ? AND starts_at >= ? AND organization_id = ? AND source_occurrence_key IS NOT NULL
  `, [input.productId, new Date(Date.now() - 2 * 86_400_000).toISOString(), input.organizationId])
  const { queries: writes, planned, skipped } = prepareSessionMaterialization(input, config, rules, new Map(locations.map(location => [location.id, location])), await canScheduleSessions(db, config), new Set(stored.map(row => row.source_occurrence_key)))
  if (writes.length === 0) return { created: providerCreated, existing: planned, skipped }
  const results = await executeBatch(db, writes, { operation: 'Materialize product sessions' })
  const created = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0)
  return { created: providerCreated + created, existing: planned - created, skipped }
}

export async function materializeMemberSessions(db: DbClient, input: { organizationId: string; userId: string; actorId: string }) {
  const products = await queryAll<{ product_id: string }>(db, `
    SELECT c.product_id FROM product_booking_configs c
      JOIN member m ON m.organizationId=c.organization_id AND m.userId=?
      JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId AND ms.timezone IS NOT NULL
     WHERE c.organization_id=? AND c.scheduling_mode='provider'
       AND c.assigned_member_id=m.id
  `, [input.userId, input.organizationId])
  for (const product of products) {
    const rules = await listAvailabilityRules(db, input.organizationId, product.product_id)
    const throughDate = rules.map(rule => addLocalDays(localNow(rule.timezone).date, PUBLIC_BOOKING_WINDOW_DAYS)).sort().at(-1)
    // An online offering's slots follow this member's hours even with no rules at all.
    await materializeSessions(db, { ...input, productId: product.product_id, throughDate: throughDate ?? addLocalDays(localDateAt(new Date(), 'UTC'), PUBLIC_BOOKING_WINDOW_DAYS) })
  }
}

/** One weekly start time. */
export interface WeeklySlotInput {
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
 * that is new gets a rule and, straight away, its sessions inside the public
 * window: the merchant sees on the site what they just saved, without waiting
 * for the generator's next pass.
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
}): Promise<{ rules: ProductAvailabilityRule[]; sessions: MaterializeSessionsResult; cancelled: number }> {
  if ((await requireOrganizationProduct(db, input)).kind === 'table') badRequest(TABLE_HOURS_ONLY)
  const config = await requireBookingConfig(db, input.organizationId, input.productId)
  const locationId = input.locationId
  const locationRows = await queryAll<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, locationId])
  const location = locationRows[0]
  if (!location) throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  const timezone = location.timezone
  if (input.timezone !== undefined && input.timezone !== timezone) badRequest('timezone must match the location timezone')
  const now = new Date().toISOString()
  const existing = (await listAvailabilityRules(db, input.organizationId, input.productId)).filter(rule => rule.location_id === locationId)
  const schedule = prepareWeeklySchedule({ ...input, locationId, now }, config, timezone, existing)
  const materialized = prepareSessionMaterialization({ ...input, now, throughDate: addLocalDays(localNow(timezone).date, PUBLIC_BOOKING_WINDOW_DAYS) }, config, schedule.rules, new Map(locationRows.map(row => [row.id, row])), await canScheduleSessions(db, config))
  const writes = [...schedule.queries, ...materialized.queries, publicResourceCacheInvalidationQuery(input.organizationId, 'product-weekly-schedule')]
  if (writes.length > MAX_D1_BATCH_STATEMENTS) badRequest('This weekly schedule exceeds one atomic update')
  const results = await executeBatch(db, writes, { operation: 'Replace weekly schedule' })
  const cancelled = schedule.cancellationIndexes.reduce((sum, index) => sum + (results[index]?.meta?.changes ?? 0), 0)
  const created = materialized.queries.reduce((sum, _, index) => sum + (results[schedule.queries.length + index]?.meta?.changes ?? 0), 0)
  return { rules: schedule.rules, sessions: { created, existing: materialized.planned - created, skipped: materialized.skipped }, cancelled }
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

/** Product creation uses the same config and occurrence writers in its atomic batch. */
export async function prepareProductBookingSetup(db: DbClient, input: {
  organizationId: string; productId: string; actorId: string; env: import('~/server/utils/auth').CloudflareEnv; now: string; booking: ProductBookingSetupInput; productInSameBatch?: boolean; productKind?: string
}): Promise<BatchQuery[]> {
  const booking = input.booking
  if (!Number.isSafeInteger(booking.duration_minutes) || booking.duration_minutes <= 0) badRequest('Provide the session duration before creating a bookable offering')
  if (booking.default_capacity !== null && (!Number.isSafeInteger(booking.default_capacity) || booking.default_capacity <= 0)) badRequest('Provide places per session, or explicit null for unlimited places')
  const { location_id: locationId, weekly_slots: weeklySlots, sessions: oneOffSessions, ...patch } = booking
  const kind = input.productInSameBatch ? input.productKind : (await requireOrganizationProduct(db, input)).kind
  const { queries: configQueries, config } = await prepareProductBookingConfig(db, { ...input, patch: { ...patch, held_online: locationId === null }, productInSameBatch: input.productInSameBatch })
  // Setting up bookings publishes the offering, and guests see who hosts it. A
  // table is the restaurant's own; guests book the place, not a host.
  if (kind !== 'table') await assertPublishedHost(db, input.organizationId, config)
  const queries: BatchQuery[] = [...configQueries]
  // The offering is created only if a guest could book something now, at the location as it was read.
  let locationGuard: BatchQuery = { query: 's.location_id IS NULL', params: [] }
  // The offering is created only if a guest could book something now: a session inside its own public window, as the
  // public listing bounds it (`bookingWindow` in the session's timezone); a timezone with no window falls back to UTC's.
  const utcWindowEnd = new Date(Date.parse(input.now) + PUBLIC_BOOKING_WINDOW_DAYS * 86_400_000).toISOString()
  const windowEnds: Record<string, string> = {}
  if (locationId === null) {
    // Online: the provider's working hours are the times. Weekly slots and
    // dated sessions would be a second schedule beside theirs.
    if (weeklySlots?.length || oneOffSessions?.length) badRequest('An online offering is booked in its provider\'s working hours; it takes no weekly times or dated sessions')
    queries.push(...await prepareProviderHoursSessions(db, config, input))
  } else {
    const location = await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, locationId])
    if (!location || location.status !== 'active') badRequest('Choose an active location in this business')
    windowEnds[location.timezone] = bookingWindow(location.timezone).toInstant
    locationGuard = { query: `EXISTS (SELECT 1 FROM business_locations l WHERE l.id=s.location_id AND l.organization_id=s.organization_id AND l.status='active' AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`, params: [location.timezone, location.opening_hours, location.special_hours] }
    const placement: BatchQuery = {
      query: `INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?) ON CONFLICT(product_id,location_id) DO UPDATE SET active=1,published=1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      params: [input.organizationId, input.productId, locationId, input.now, input.now, input.actorId, input.actorId],
    }
    if (kind === 'table') {
      // A table's open time is its location's hours; times of its own would be a second schedule.
      if (weeklySlots?.length || oneOffSessions?.length) badRequest(TABLE_HOURS_ONLY)
      if (location.opening_hours === null) badRequest('Set this location\'s opening hours before taking table bookings: tables are seated through them')
      queries.push(placement, ...tableSeatingQueries(config, location, input))
      if (!tableSeatings(config, location, input.now).length) badRequest('This location\'s opening hours leave no seating in the next weeks; change its hours or the table\'s length and interval')
    } else {
      const existingRules = input.productInSameBatch ? [] : (await listAvailabilityRules(db, input.organizationId, input.productId)).filter(rule => rule.location_id === locationId)
      const schedule = prepareWeeklySchedule({ ...input, locationId, slots: weeklySlots ?? existingRules.map(rule => ({ weekday: rule.weekday, start_time: rule.start_time })) }, config, location.timezone, existingRules)
      if (!schedule.rules.length && !oneOffSessions?.length) badRequest('Provide actual weekly times or dated sessions before creating a bookable offering')
      queries.push(placement, ...schedule.queries)
      if (!await canScheduleSessions(db, config)) badRequest('Set working hours for the assigned member before adding bookable times')
      const materialized = prepareSessionMaterialization({ ...input, throughDate: addLocalDays(localNow(location.timezone).date, PUBLIC_BOOKING_WINDOW_DAYS) }, config, schedule.rules, new Map([[location.id, location]]), true)
      if (materialized.skipped.some(skipped => skipped.reason !== 'location_closed')) throw new HTTPError({ statusCode: 400, statusMessage: 'Some requested local times are ambiguous or do not exist; choose their actual times before creating the offering', data: { skipped: materialized.skipped } })
      queries.push(...materialized.queries)
      let futureSessions = materialized.sessions.filter(session => session.starts_at > input.now).length
      for (const session of oneOffSessions ?? []) {
        const instants = sessionInstants(session.starts_at, session.ends_at)
        if (instants.starts_at <= input.now) badRequest('New dated sessions must start in the future')
        const capacity = session.capacity === undefined ? config.default_capacity : session.capacity
        if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity <= 0)) badRequest('Dated sessions need positive capacity or explicit null for unlimited places')
        if (!locationAllowsBooking(instants, location)) badRequest('A dated session is outside opening hours or during a closure')
        queries.push(manualSessionQuery({ ...input, location }, { id: crypto.randomUUID(), ...instants, capacity }))
        futureSessions += 1
      }
      if (!futureSessions) badRequest('Provide at least one future session before creating a bookable offering')
    }
  }
  const bookableFrom = input.now
  // The sessions this batch inserts are not stored yet: their providers come from the configuration.
  const configured = configuredProviderIds(config)
  if (locationId === null && configured.length) {
    // An online slot is public inside its own provider's window, in that provider's timezone.
    for (const zone of await queryAll<{ timezone: string }>(db, 'SELECT DISTINCT timezone FROM member_scheduling WHERE organization_id=? AND timezone IS NOT NULL AND member_id IN (SELECT value FROM json_each(?))', [input.organizationId, JSON.stringify(configured)])) {
      windowEnds[zone.timezone] = bookingWindow(zone.timezone).toInstant
    }
  }
  const stored = await sessionProviderIds(db, input.organizationId, { productId: input.productId, fromInstant: bookableFrom })
  // Google is asked through the end of every session the guard may count: a day past the latest window, the stored
  // sessions' last end, and each dated session this batch queues, whole.
  const readUntil = [new Date(Date.parse([utcWindowEnd, ...Object.values(windowEnds)].sort().at(-1)!) + 86_400_000).toISOString(),
    ...(stored.until ? [stored.until] : []), ...(oneOffSessions ?? []).map(session => sessionInstants(session.starts_at, session.ends_at).ends_at)].sort().at(-1)!
  const availability = await memberAvailabilityJson(db, input.env, input.organizationId, { from: bookableFrom, until: readUntil }, [...new Set([...configured, ...stored.members])])
  queries.push({
    query: `UPDATE product_booking_configs SET updated_at=CASE WHEN EXISTS (
      SELECT 1 FROM product_sessions s WHERE s.organization_id=? AND s.product_id=?
        AND s.location_id IS ? AND s.starts_at>? AND s.starts_at<COALESCE(json_extract(?, '$."' || s.timezone || '"'), ?) AND s.status='scheduled'
        AND (s.capacity IS NULL OR s.capacity>${sessionHeldCapacitySql('s')}+COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id=s.id AND ${CAPACITY_CONSUMING_SQL}),0))
        AND (${locationGuard.query}) AND NOT ${providerUnavailableSql('s')}
    ) THEN updated_at ELSE NULL END WHERE organization_id=? AND product_id=?`,
    params: [input.organizationId, input.productId, locationId, input.now, JSON.stringify(windowEnds), utcWindowEnd, ...locationGuard.params!, ...providerAvailabilityParams(availability), input.organizationId, input.productId],
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

/**
 * The providers the scheduled sessions a statement covers may name, so the
 * availability it binds asks Google about those members only. A cancelled
 * session and a session with no provider need no entry.
 */
async function sessionProviderIds(db: DbClient, organizationId: string, filter: { productId?: string | null; productIds?: string[] | null; locationId?: string | null; sessionIds?: string[] | null; fromInstant?: string | null; toInstant?: string | null }): Promise<{ members: string[]; from: string | null; until: string | null }> {
  const rows = await queryAll<{ member: string | null; from: string; until: string }>(db, `SELECT ${providerMemberSql('s')} AS member, MIN(s.starts_at) AS "from", MAX(s.ends_at) AS until FROM product_sessions s
    WHERE s.organization_id=? AND s.status='scheduled' AND (? IS NULL OR s.product_id=?) AND (? IS NULL OR s.product_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR s.location_id=?) AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR s.starts_at>=?) AND (? IS NULL OR s.starts_at<?)
    GROUP BY 1`,
  [organizationId, filter.productId ?? null, filter.productId ?? null, filter.productIds ? JSON.stringify(filter.productIds) : null, filter.productIds ? JSON.stringify(filter.productIds) : null, filter.locationId ?? null, filter.locationId ?? null, filter.sessionIds ? JSON.stringify(filter.sessionIds) : null, filter.sessionIds ? JSON.stringify(filter.sessionIds) : null,
    filter.fromInstant ?? null, filter.fromInstant ?? null, filter.toInstant ?? null, filter.toInstant ?? null])
  const named = rows.filter(row => row.member)
  return { members: named.map(row => row.member!), from: named.map(row => row.from).sort()[0] ?? null, until: named.map(row => row.until).sort().at(-1) ?? null }
}

/** The member a provider-mode configuration schedules. */
function configuredProviderIds(config: ProductBookingConfigRecord): string[] {
  return config.scheduling_mode === 'provider' && config.assigned_member_id ? [config.assigned_member_id] : []
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

export async function listSessions(db: DbClient, input: {
  env: CloudflareEnv
  organizationId: string
  productId?: string
  /** A catalog read names the offerings whose readiness it is assessing, so only their providers' calendars are read. */
  productIds?: string[]
  /** A readback names the sessions it wants, so only their providers' calendars are read. */
  sessionIds?: string[]
  locationId?: string
  fromInstant: string
  toInstant: string
  statuses?: ProductSessionStatus[]
}): Promise<SessionAvailability[]> {
  if (input.productId && await queryFirst(db, `SELECT c.product_id FROM product_booking_configs c JOIN products p ON p.id=c.product_id AND p.organization_id=c.organization_id
    WHERE c.organization_id=? AND c.product_id=? AND p.kind='service'`, [input.organizationId, input.productId])) {
    await requireBookingConfig(db, input.organizationId, input.productId)
  }
  const statuses = input.statuses ?? ['scheduled']
  // Google is asked about the span the stored provider sessions actually cover, not the whole window.
  const providers = await sessionProviderIds(db, input.organizationId, { productId: input.productId, productIds: input.productIds, sessionIds: input.sessionIds, locationId: input.locationId, fromInstant: input.fromInstant, toInstant: input.toInstant })
  const availability = providers.members.length ? await memberAvailabilityJson(db, input.env, input.organizationId, { from: providers.from!, until: providers.until! }, providers.members) : '{}'
  const sessions = await queryAll<SessionAvailability>(db, `
    SELECT s.id, s.organization_id, s.product_id, s.location_id, s.availability_rule_id,
           s.source_occurrence_key, s.timezone, s.starts_at, s.ends_at, s.capacity, s.status, s.created_at, s.updated_at,
           COALESCE((
             SELECT SUM(b.party_size) FROM bookings b
             WHERE b.product_session_id = s.id AND ${CAPACITY_CONSUMING_SQL}
           ), 0) + ${sessionHeldCapacitySql('s')} AS claimed,
           CASE WHEN ${providerUnavailableSql('s')} THEN 0 WHEN s.capacity IS NULL THEN NULL ELSE s.capacity - ${sessionHeldCapacitySql('s')} - COALESCE((
             SELECT SUM(b.party_size) FROM bookings b
             WHERE b.product_session_id = s.id AND ${CAPACITY_CONSUMING_SQL}
           ), 0) END AS remaining,
           CASE WHEN ${providerUnavailableSql('s')} THEN 1 WHEN s.capacity IS NULL THEN 0 WHEN s.capacity - ${sessionHeldCapacitySql('s')} - COALESCE((
             SELECT SUM(b.party_size) FROM bookings b
             WHERE b.product_session_id = s.id AND ${CAPACITY_CONSUMING_SQL}
           ), 0) <= 0 THEN 1 ELSE 0 END AS is_full
    FROM product_sessions s
    WHERE s.organization_id = ?
      AND (? IS NULL OR s.product_id = ?)
      AND (? IS NULL OR s.product_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR s.location_id = ?)
      AND s.starts_at >= ? AND s.starts_at < ?
      AND s.status IN (SELECT value FROM json_each(?))
    ORDER BY s.starts_at, s.id
  `, [
    ...providerAvailabilityParams(availability, 2),
    input.organizationId,
    input.productId ?? null, input.productId ?? null,
    input.productIds ? JSON.stringify(input.productIds) : null, input.productIds ? JSON.stringify(input.productIds) : null,
    input.sessionIds ? JSON.stringify(input.sessionIds) : null, input.sessionIds ? JSON.stringify(input.sessionIds) : null,
    input.locationId ?? null, input.locationId ?? null,
    input.fromInstant, input.toInstant, JSON.stringify(statuses),
  ]).then(rows => rows.map(row => ({ ...row, is_full: Boolean(row.is_full) })))
  const ids = [...new Set(sessions.flatMap(session => session.location_id ? [session.location_id] : []))]
  const locations = await queryAll<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id IN (SELECT value FROM json_each(?))', [input.organizationId, JSON.stringify(ids)])
  const byId = new Map(locations.map(location => [location.id, location]))
  return sessions.map(session => {
    if (!session.location_id) return session
    const location = byId.get(session.location_id)
    return location && locationAllowsBooking(session, location) ? session : { ...session, remaining: 0, is_full: true }
  })

}

/** The public booking window, expressed as instants in the product's timezone. */
export { PUBLIC_BOOKING_WINDOW_DAYS }

export function bookingWindow(timezone: string, days = PUBLIC_BOOKING_WINDOW_DAYS): { fromInstant: string; toInstant: string } {
  if (!isValidTimezone(timezone)) throw new HTTPError({ statusCode: 409, statusMessage: 'Set the timezone before offering bookings' })
  if (days > MAX_CALENDAR_DAYS * 12) badRequest('Booking window is too long')
  const today = localNow(timezone).date
  return {
    fromInstant: new Date().toISOString(),
    toInstant: localDateTimeToInstant(addLocalDays(today, days), '00:00', timezone, 'compatible').toISOString(),
  }
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
  const location = await sessionLocationGuard(db, input)
  const span = await queryFirst<{ starts_at: string; ends_at: string }>(db, 'SELECT starts_at, ends_at FROM product_sessions WHERE id=? AND organization_id=?', [input.sessionId, input.organizationId])
  const availability = span ? await memberAvailabilityJson(db, input.env, input.organizationId, { from: span.starts_at, until: span.ends_at }, (await sessionProviderIds(db, input.organizationId, { sessionIds: [input.sessionId] })).members) : '{}'
  return { query: `${input.chargedPaymentId ? `EXISTS (SELECT 1 FROM payment_checkout_holds h JOIN payments p ON p.id=h.payment_id WHERE p.id=? AND p.organization_id=? AND p.refunded_amount=0 AND h.status IN ('active','released') AND h.expires_at>? AND h.session_id=? AND h.quantity=? AND h.organization_id=p.organization_id AND h.amount=p.amount AND h.currency=p.currency) AND ` : ''}${input.requireUndecided
        ? `EXISTS (SELECT 1 FROM conversations WHERE id = ? AND organization_id = ?)
           AND NOT EXISTS (SELECT 1 FROM messages WHERE dedupe_key = ?) AND `
        : ''}EXISTS (
        SELECT 1 FROM product_sessions s
        WHERE s.id = ? AND s.organization_id = ? AND s.product_id = ?
          AND s.status = 'scheduled'
          AND EXISTS (SELECT 1 FROM product_booking_configs c JOIN products p ON p.id=c.product_id AND p.organization_id=c.organization_id
            WHERE c.product_id=s.product_id AND c.organization_id=s.organization_id AND c.duration_minutes>0
              ${input.chargedPaymentId || input.requireActive === false ? '' : 'AND p.active=1'} AND (s.location_id IS NOT NULL OR c.held_online=1)
              -- Advance notice: a start inside it is not booked or moved onto. A paid hold already passed it when it was taken.
              ${input.chargedPaymentId ? '' : "AND julianday(s.starts_at) > julianday('now') + COALESCE(c.advance_notice_minutes, 0) / 1440.0"})
          AND (${location.query})
          -- The location's own sale switch is part of being bookable: a branch
          -- that has stopped selling this does not take seats for it.
          AND (s.location_id IS NULL OR EXISTS (
            SELECT 1 FROM product_locations pl
             WHERE pl.product_id = s.product_id AND pl.location_id = s.location_id
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
      input.sessionId, input.organizationId, input.productId, ...location.params!, input.now, ...providerAvailabilityParams(availability), input.replacingBookingId ?? null, input.chargedPaymentId ?? null, input.partySize, input.chargedPaymentId ?? null, input.replacingBookingId ?? null,
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
  now: string
}): Promise<BatchQuery> {
  const allocation = await sessionAllocationPredicate(db, input)
  return {
    query: `
      INSERT INTO bookings (
        id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone,
        user_id, party_size, party_size_is_minimum, answers, policy_json, status, received_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?,
        (SELECT location_id FROM product_sessions WHERE id = ? AND organization_id = ?),
        (SELECT starts_at FROM product_sessions WHERE id = ? AND organization_id = ?),
        (SELECT ends_at FROM product_sessions WHERE id = ? AND organization_id = ?),
        (SELECT timezone FROM product_sessions WHERE id = ? AND organization_id = ?),
        ?, ?, ?, ?, ?,
        COALESCE((SELECT status FROM bookings WHERE id = ?),
          (SELECT CASE WHEN confirmation_mode = 'review' THEN 'pending' ELSE 'confirmed' END
           FROM product_booking_configs WHERE product_id = ? AND organization_id = ?)), ?, ?, ?
      WHERE ${allocation.query}
        AND EXISTS(SELECT 1 FROM product_variants v WHERE v.id=? AND v.product_id=? AND v.organization_id=? AND v.active=1)
      ON CONFLICT (id) DO NOTHING
    `,
    params: [
      input.bookingId, input.organizationId, input.productId, input.sessionId, input.productVariantId,
      ...[0, 1, 2, 3].flatMap(() => [input.sessionId, input.organizationId]),
      input.userId ?? null, input.partySize, input.partySizeIsMinimum ?? false, JSON.stringify(input.answers ?? []), input.policyJson, input.replacingBookingId ?? null, input.productId, input.organizationId, input.now, input.now, input.now,
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
  productVariantId: string
  partySize: number
  /** The Better Auth user the booking belongs to. */
  userId?: string | null
  /** The terms the guest agreed to (BookingPolicy), frozen on the booking. */
  policyJson: string
  answers?: FormAnswerSnapshot[]
  partySizeIsMinimum?: boolean
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
  const bookingId = crypto.randomUUID()
  const claim = await sessionClaimQuery(db, { ...input, bookingId, now: new Date().toISOString() })
  const results = await executeBatch(db, [claim, ...(input.following?.(bookingId) ?? [])], { operation: 'Claim session capacity' })
  if ((results[0]?.meta?.changes ?? 0) === 0) throw new CapacityUnavailableError()
  return { bookingId }
}

/**
 * Edit one session: its time, its capacity, or its state.
 *
 * This is what replaces the per-date override map. An override WAS a patch
 * applied on top of a computed schedule; a session IS the schedule, so
 * changing one is an ordinary update to a real row that bookings already
 * point at. Regeneration will not undo it.
 *
 * Editing a session never touches the rule, and editing a rule never touches
 * a session. A series change is an explicit, scoped operation the caller makes
 * over the sessions it names.
 */
export async function getSessionAvailability(db: DbClient, env: CloudflareEnv, organizationId: string, productId: string, sessionId: string): Promise<SessionAvailability> {
  const session = await queryFirst<ProductSession>(db, 'SELECT * FROM product_sessions WHERE organization_id=? AND product_id=? AND id=?', [organizationId, productId, sessionId])
  if (!session) throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found for this offering' })
  const sessions = await listSessions(db, { env, organizationId, productId, sessionIds: [sessionId], fromInstant: session.starts_at, toInstant: session.ends_at, statuses: ['scheduled', 'cancelled'] })
  const result = sessions.find(row => row.id === sessionId)
  if (!result) throw new Error('The saved session could not be read back')
  return result
}

/** The named sessions as a guest would see them, read in one pass so the providers' calendars are asked once. */
async function readSessionsBack(db: DbClient, env: CloudflareEnv, organizationId: string, productId: string, ids: string[]): Promise<SessionAvailability[]> {
  const span = await queryFirst<{ from: string; until: string }>(db, 'SELECT MIN(starts_at) AS "from", MAX(ends_at) AS until FROM product_sessions WHERE organization_id=? AND product_id=? AND id IN (SELECT value FROM json_each(?))', [organizationId, productId, JSON.stringify(ids)])
  if (!span?.from) throw new Error('The saved sessions could not be read back')
  const sessions = await listSessions(db, { env, organizationId, productId, sessionIds: ids, fromInstant: span.from, toInstant: new Date(Date.parse(span.until) + 1).toISOString(), statuses: ['scheduled', 'cancelled'] })
  return ids.map((id) => {
    const session = sessions.find(row => row.id === id)
    if (!session) throw new Error('The saved session could not be read back')
    return session
  })
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
    return readSessionsBack(db, input.env, input.organizationId, input.productId, ids)
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
  if (!await canScheduleSessions(db, config)) badRequest('Set working hours for the assigned member before adding bookable times')
  const sessions = [{ id: crypto.randomUUID() }]
  try {
    await executeBatch(db, [...sessions.map(session => manualSessionQuery({ ...input, now, location }, { id: session.id, ...instants, capacity })),
      organizationEventQuery({ organizationId: input.organizationId, locationId: input.locationId, actorId: input.actorId, eventType: 'product.updated', entityType: 'session', entityId: sessions[0]!.id, dedupeKey, metadata: { request_hash: requestHash, product_id: input.productId, session_ids: sessions.map(session => session.id) } }),
      publicResourceCacheInvalidationQuery(input.organizationId, 'product-session-created')], { operation: 'Create product session' })
  } catch (error) {
    if (isUniqueDedupeConflict(error)) { const concurrent = await replay(); if (concurrent) return concurrent }
    throw error
  }
  return readSessionsBack(db, input.env, input.organizationId, input.productId, sessions.map(session => session.id))
}

export async function updateSession(db: DbClient, input: {
  env: CloudflareEnv
  organizationId: string
  sessionId: string
  productId?: string
  expectedUpdatedAt?: string
  actorId: string
  startsAt?: string
  endsAt?: string
  capacity?: number | null
  status?: ProductSessionStatus
}): Promise<SessionAvailability> {
  const session = await queryFirst<ProductSession>(db, `
    SELECT id, organization_id, product_id, location_id, availability_rule_id, source_occurrence_key,
           timezone, starts_at, ends_at, capacity, status, created_at, updated_at
    FROM product_sessions WHERE organization_id = ? AND id = ? AND (? IS NULL OR product_id=?)
  `, [input.organizationId, input.sessionId, input.productId ?? null, input.productId ?? null])
  if (!session) throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found' })
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
    const claimed = await queryFirst<{ claimed: number }>(db, `
      SELECT COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id=s.id AND ${CAPACITY_CONSUMING_SQL}),0) + ${sessionHeldCapacitySql('s')} AS claimed FROM product_sessions s WHERE s.id=?
    `, [input.sessionId])
    if ((claimed?.claimed ?? 0) > input.capacity) {
      throw new HTTPError({
        statusCode: 409,
        statusMessage: `This session already has ${claimed?.claimed} seats claimed; cancel bookings before reducing capacity to ${input.capacity}`,
      })
    }
  }

  const now = new Date().toISOString()
  const location = session.location_id ? await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, session.location_id]) : null
  const moved = startsAt !== session.starts_at || endsAt !== session.ends_at
  // Only a move needs the provider's availability at the new time; a capacity or status change asks no calendar.
  const availability = moved ? await memberAvailabilityJson(db, input.env, input.organizationId, { from: startsAt, until: endsAt }, (await sessionProviderIds(db, input.organizationId, { sessionIds: [input.sessionId] })).members) : null
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
  const written = await executeBatch(db, [{
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
      input.organizationId, input.sessionId, session.updated_at,
      ...(capacity === null ? [] : [capacity]), ...locationGuard.params!, startsAt, endsAt, input.status ?? session.status, ...(availability === null ? [] : [startsAt, endsAt, ...providerAvailabilityParams(availability)]),
    ],
  }, organizationEventQuery({ organizationId: input.organizationId, locationId: session.location_id, actorId: input.actorId, eventType: 'product.updated', entityType: 'session', entityId: session.id, onlyIfPreviousChangedOneRow: true,
    beforeState: { starts_at: session.starts_at, ends_at: session.ends_at, capacity: session.capacity, status: session.status }, afterState: { starts_at: startsAt, ends_at: endsAt, capacity, status: input.status ?? session.status } }),
  publicResourceCacheInvalidationQuery(input.organizationId, 'product-session-updated')], { operation: 'Update product session' })
  if (written[0]?.meta?.changes === 0) {
    throw new HTTPError({
      statusCode: 409,
      statusMessage: 'This session, its opening hours or its capacity changed, or it has live bookings; reload and resolve the conflict',
    })
  }
  return getSessionAvailability(db, input.env, input.organizationId, session.product_id, session.id)
}

/** The local calendar date a session falls on, for grouping in a UI. */
export function sessionLocalDate(session: Pick<ProductSession, 'starts_at' | 'timezone'>): string {
  return localDateAt(new Date(session.starts_at), session.timezone)
}

export function assertLocalStartTime(value: string, field = 'start_time'): void {
  if (!MINUTE_TIME_PATTERN.test(value)) badRequest(`${field} must be in "HH:MM" format`)
}

