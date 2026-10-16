import { creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { MAX_D1_BATCH_STATEMENTS } from '~/server/db/d1-limits'
import { locationAllowsBooking } from '~/shared/reservation-hours'
import { providerUnavailableSql, sessionMemberSql } from '~/server/utils/provider-allocation'
import { PUBLIC_BOOKING_WINDOW_DAYS } from '~/shared/bookings'
import { HTTPError } from 'nitro'
import { requireOrganizationProduct } from '~/server/utils/product-management'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import {
  CAPACITY_CONSUMING_SQL,
  PRODUCT_SESSION_STATUSES,
  occurrenceKey,
  type BookingStatus,
  type ProductSessionStatus,
} from '~/shared/bookings'
import {
  addLocalDays,
  assertCalendarDate,
  isValidTimezone,
  localDateAt,
  localDateTimeToInstant,
  localNow,
  MINUTE_TIME_PATTERN,
} from '~/utils/timezone'

/**
 * The booking capability.
 *
 * A Product is bookable because it has a `product_booking_configs` row, not
 * because it has a duration or a vertical name. Rules describe when sessions
 * ought to exist; sessions ARE the occurrences and own their time, capacity
 * and state; a booking claims seats on one session. No step is inferred from
 * the absence of another.
 *
 * Location table reservations are a different capability and live in
 * `reservations.ts`. They are not this code under another name: a
 * reservation has no materialized occurrence, because a restaurant does not
 * schedule a dinner the way a studio schedules a class.
 */

const MAX_GENERATION_DAYS = 365
const MAX_CALENDAR_DAYS = 42

function badRequest(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

export function assertAvailabilityDate(value: string, field = 'date'): void {
  try { assertCalendarDate(value) }
  catch { badRequest(`${field} must be a valid YYYY-MM-DD date`) }
}

export interface ProductBookingConfigRecord {
  product_id: string
  organization_id: string
  duration_minutes: number | null
  default_capacity: number | null
  confirmation_mode: 'instant' | 'review'
  online_payment_required: boolean
  /** Sessions come from each provider's working hours, in that provider's timezone. */
  held_online: boolean
  scheduling_mode: 'legacy' | 'provider'
  assigned_member_id: string | null
  assigned_team_id: string | null
}

export interface ProductAvailabilityRule {
  id: string
  organization_id: string
  product_id: string
  location_id: string
  timezone: string
  weekday: number
  start_time: string
}

export interface ProductSession {
  id: string
  organization_id: string
  product_id: string
  location_id: string | null
  availability_rule_id: string | null
  assigned_member_id: string | null
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

export async function requireBookingConfig(
  db: DbClient,
  organizationId: string,
  productId: string,
): Promise<ProductBookingConfigRecord> {
  const row = await queryFirst<Omit<ProductBookingConfigRecord, 'online_payment_required' | 'held_online'> & { online_payment_required: number; held_online: number }>(db, `
    SELECT product_id, organization_id, duration_minutes, default_capacity, confirmation_mode, online_payment_required, held_online, scheduling_mode, assigned_member_id, assigned_team_id
    FROM product_booking_configs WHERE organization_id = ? AND product_id = ?
  `, [organizationId, productId])
  // The absence of a config row means the product does not take bookings. It
  // is not a product with unknown booking settings.
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'This product does not take bookings' })
  return { ...row, online_payment_required: row.online_payment_required === 1, held_online: row.held_online === 1 }
}

/** Shared capability writer: omissions retain saved defaults; null clears and capacity zero closes seats. */
export async function prepareProductBookingConfig(db: DbClient, input: {
  organizationId: string; productId: string; actorId: string; env?: import('~/server/utils/auth').CloudflareEnv
  productInSameBatch?: boolean
  patch: { duration_minutes?: unknown; default_capacity?: unknown; confirmation_mode?: unknown; online_payment_required?: unknown; held_online?: unknown; scheduling_mode?: unknown; assigned_member_id?: unknown; assigned_team_id?: unknown }
}): Promise<{ query: BatchQuery; config: ProductBookingConfigRecord }> {
  const product = input.productInSameBatch ? null : await requireOrganizationProduct(db, input)
  if (product && !['experience', 'service'].includes(product.kind)) badRequest('Only experiences and services take scheduled bookings')
  const patch = input.patch
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) badRequest('Invalid request body')
  const fields = ['duration_minutes', 'default_capacity', 'confirmation_mode', 'online_payment_required', 'held_online', 'scheduling_mode', 'assigned_member_id', 'assigned_team_id'] as const
  if (Object.keys(patch).some(key => !fields.includes(key as typeof fields[number]))) badRequest('Unknown booking configuration field')
  for (const field of ['duration_minutes', 'default_capacity'] as const) {
    const value = patch[field]
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) badRequest(`${field} must be a non-negative integer or null`)
  }
  if (patch.duration_minutes === 0) badRequest('duration_minutes must be positive')
  if (patch.confirmation_mode !== undefined && patch.confirmation_mode !== 'instant' && patch.confirmation_mode !== 'review') badRequest('confirmation_mode must be instant or review')
  if (patch.online_payment_required !== undefined && typeof patch.online_payment_required !== 'boolean') badRequest('online_payment_required must be boolean')
  if (patch.online_payment_required === true) {
    if (!input.env) throw new HTTPError({ statusCode: 403, statusMessage: 'Payments entitlement cannot be checked without the configured environment' })
    const { requireStripeCheckoutAcceptance } = await import('~/server/utils/stripe-connect')
    const { createStripeClient } = await import('~/server/utils/stripe-client')
    if (!input.env.STRIPE_SECRET_KEY) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured' })
    await requireStripeCheckoutAcceptance(db, createStripeClient(input.env.STRIPE_SECRET_KEY), input.env, input.organizationId)
  }
  if (patch.held_online !== undefined && typeof patch.held_online !== 'boolean') badRequest('held_online must be boolean')
  const current = await queryFirst<Omit<ProductBookingConfigRecord, 'online_payment_required' | 'held_online'> & { online_payment_required: number; held_online: number; updated_at: string }>(db, 'SELECT product_id,organization_id,duration_minutes,default_capacity,confirmation_mode,online_payment_required,held_online,scheduling_mode,assigned_member_id,assigned_team_id,updated_at FROM product_booking_configs WHERE organization_id = ? AND product_id = ?', [input.organizationId, input.productId])
  const heldOnline = patch.held_online === undefined ? current?.held_online === 1 : patch.held_online === true
  if (patch.scheduling_mode !== undefined && !['legacy', 'provider'].includes(String(patch.scheduling_mode))) badRequest('Invalid scheduling mode')
  if (patch.assigned_member_id !== undefined && patch.assigned_member_id !== null && typeof patch.assigned_member_id !== 'string') badRequest('Invalid member ID')
  if (patch.assigned_team_id !== undefined && patch.assigned_team_id !== null && typeof patch.assigned_team_id !== 'string') badRequest('Invalid team ID')
  const assignedMember = patch.assigned_member_id === undefined ? current?.assigned_member_id ?? null : patch.assigned_member_id as string | null
  const assignedTeam = patch.assigned_team_id === undefined ? current?.assigned_team_id ?? null : patch.assigned_team_id as string | null
  const mode = (patch.scheduling_mode ?? current?.scheduling_mode ?? 'legacy') as ProductBookingConfigRecord['scheduling_mode']
  if (mode === 'provider' ? Boolean(assignedMember) === Boolean(assignedTeam) : Boolean(assignedMember || assignedTeam)) badRequest('Choose the business schedule, one member, or one team')
  // Online, the provider's own hours are the schedule; there is no business clock to hold it in.
  if (heldOnline && mode !== 'provider') badRequest('An online offering is held by a member or a team: assign who provides it')
  if (patch.scheduling_mode !== undefined || patch.assigned_member_id !== undefined || patch.assigned_team_id !== undefined) {
    const { requireSchedulingAccess } = await import('~/server/domain/member-scheduling')
    // All callers of this shared writer must authenticate provider changes.
    const { resolveOrganizationMembership, assertRoleAllows }=await import('~/server/utils/member-access')
    const env=input.env
    if(!env)throw new HTTPError({statusCode:403,message:'Authenticated provider configuration required'})
    const membership=await resolveOrganizationMembership(env,{organizationId:input.organizationId,userId:input.actorId})
    if(!membership)throw new HTTPError({statusCode:403,message:'Organization membership required'})
    await assertRoleAllows({...membership,permissions:{products:['update']}})
    if (assignedMember) await requireSchedulingAccess({ env, userId: input.actorId, organizationId: input.organizationId }, assignedMember, true)
    if (assignedTeam && !(await queryFirst(db, `SELECT t.id FROM team t JOIN teamMember tm ON tm.teamId=t.id JOIN member m ON m.userId=tm.userId AND m.organizationId=t.organizationId JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE t.id=? AND t.organizationId=? LIMIT 1`, [assignedTeam, input.organizationId]))) badRequest('Choose a team in this business with at least one member who has set working hours')
  }
  const now = new Date().toISOString()
  const config: ProductBookingConfigRecord = {
    product_id: input.productId, organization_id: input.organizationId,
    duration_minutes: patch.duration_minutes === undefined ? current?.duration_minutes ?? null : patch.duration_minutes as number | null,
    default_capacity: patch.default_capacity === undefined ? current?.default_capacity ?? null : patch.default_capacity as number | null,
    confirmation_mode: (patch.confirmation_mode ?? current?.confirmation_mode ?? 'instant') as ProductBookingConfigRecord['confirmation_mode'],
    online_payment_required: patch.online_payment_required === undefined ? current?.online_payment_required === 1 : patch.online_payment_required === true,
    held_online: heldOnline,
    scheduling_mode: mode, assigned_member_id: assignedMember, assigned_team_id: assignedTeam,
  }
  if (config.duration_minutes === null && product?.kind === 'experience' && !product.order_url && product.publications.some(publication => publication.published)) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Keep a session duration for a published experience. Withhold the experience before clearing its booking setup.' })
  }
  const unchanged: BatchQuery = current
    ? { query: `EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.product_id=? AND c.organization_id=? AND c.updated_at=? AND ${fields.map(field => `c.${field} IS ?`).join(' AND ')})`, params: [input.productId, input.organizationId, current.updated_at, ...fields.map(field => current[field])] }
    : { query: 'NOT EXISTS (SELECT 1 FROM product_booking_configs WHERE product_id=?)', params: [input.productId] }
  // A rejected configuration must abort the entire native D1 batch, including
  // its sessions and publication. An INSERT ... SELECT that selects no row
  // would instead let those other writes commit.
  return { config, query: {
    query: `INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, confirmation_mode, online_payment_required, held_online, scheduling_mode, assigned_member_id, assigned_team_id, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN (${unchanged.query})
        AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM products p JOIN product_publications pub ON pub.product_id=p.id AND pub.organization_id=p.organization_id WHERE p.id=? AND p.organization_id=? AND p.kind='experience' AND NULLIF(p.order_url,'') IS NULL AND pub.published=1))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM team t JOIN teamMember tm ON tm.teamId=t.id JOIN member m ON m.userId=tm.userId AND m.organizationId=t.organizationId JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE t.id=? AND t.organizationId=?))
        AND (?<>'provider' OR (
          NOT EXISTS (SELECT 1 FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id WHERE b.organization_id=? AND b.product_id=? AND b.assigned_member_id IS NULL AND b.status IN ('pending','confirmed') AND s.ends_at>?)
          AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=? AND h.product_id=? AND h.assigned_member_id IS NULL AND h.status='active' AND h.expires_at>?)
        )) THEN ? ELSE NULL END, ?, ?)
      ON CONFLICT (product_id) DO UPDATE SET
        ${fields.map(field => `${field}=excluded.${field}`).join(', ')},
        updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    params: [input.productId, input.organizationId, config.duration_minutes, config.default_capacity,
      config.confirmation_mode, config.online_payment_required ? 1 : 0, config.held_online ? 1 : 0, config.scheduling_mode, config.assigned_member_id, config.assigned_team_id, now,
      ...unchanged.params!, config.duration_minutes, input.productId, input.organizationId, config.assigned_team_id, config.assigned_team_id, input.organizationId, config.scheduling_mode, input.organizationId, input.productId, now, input.organizationId, input.productId, now,
      now, input.actorId, input.actorId],
  } }
}

export function bookingConfigurationWriteError(error: unknown): unknown {
  if (!/NOT NULL constraint failed: product_booking_configs\.updated_at/.test(error instanceof Error ? error.message : String(error))) return error
  return new HTTPError({ statusCode: 409, statusMessage: 'The booking settings conflict or none of the requested times can be booked with the current hours, providers and calendars. Nothing was changed; review availability before saving.', cause: error })
}

export async function setProductBookingConfig(db: DbClient, input: Omit<Parameters<typeof prepareProductBookingConfig>[1], 'productInSameBatch'>): Promise<ProductBookingConfigRecord> {
  const { query, config } = await prepareProductBookingConfig(db, input)
  const rules = await listAvailabilityRules(db, input.organizationId, input.productId)
  const locations = await queryAll<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id IN (SELECT value FROM json_each(?))', [input.organizationId, JSON.stringify([...new Set(rules.map(rule => rule.location_id))])])
  const throughDate = rules.map(rule => addLocalDays(localNow(rule.timezone).date, PUBLIC_BOOKING_WINDOW_DAYS)).sort().at(-1)
  const materialized = throughDate ? prepareSessionMaterialization({ ...input, throughDate }, config, rules, new Map(locations.map(location => [location.id, location])), await sessionProviders(db, config)).queries : []
  const online = config.held_online ? await prepareProviderHoursSessions(db, config, { actorId: input.actorId, now: new Date().toISOString() }) : []
  const queries = [query, ...materialized, ...online, publicResourceCacheInvalidationQuery(input.organizationId, 'product-booking-config')]
  if (queries.length > MAX_D1_BATCH_STATEMENTS) badRequest('This schedule exceeds one atomic update; reduce the requested times or team size')
  await executeBatch(db, queries, { operation: 'Set product booking config' }).catch(error => { throw bookingConfigurationWriteError(error) })
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
    SELECT id, organization_id, product_id, location_id, timezone, weekday, start_time
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

async function sessionProviders(db: DbClient, config: ProductBookingConfigRecord): Promise<Array<string | null>> {
  if (!config.assigned_team_id) return [null]
  const members = await queryAll<{ id: string }>(db, `SELECT m.id FROM team t JOIN teamMember tm ON tm.teamId=t.id JOIN member m ON m.userId=tm.userId AND m.organizationId=t.organizationId JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE t.id=? AND t.organizationId=? ORDER BY m.id`, [config.assigned_team_id, config.organization_id])
  return members.map(member => member.id)
}

/**
 * An online offering's sessions: each provider's working windows, cut into
 * slots of the offering's length, in that provider's own timezone — the way a
 * Calendly host's availability is their schedule, not a list on the event.
 *
 * One statement per provider retires the future, unclaimed slots their hours
 * no longer cover, and one inserts the slots they do. A slot that comes back
 * reopens its own row; a claimed slot is never moved or cancelled here.
 */
export async function prepareProviderHoursSessions(db: DbClient, config: ProductBookingConfigRecord, input: { actorId: string; now: string }): Promise<BatchQuery[]> {
  const duration = resolvedDuration(config)
  const providers = await queryAll<{ member_id: string; timezone: string; windows_json: string; time_off_json: string }>(db, `
    SELECT ms.member_id, ms.timezone, ms.windows_json, ms.time_off_json FROM member_scheduling ms
      JOIN member m ON m.id=ms.member_id AND m.organizationId=ms.organization_id
     WHERE ms.organization_id=? AND (ms.member_id=? OR EXISTS (
       SELECT 1 FROM team t JOIN teamMember tm ON tm.teamId=t.id WHERE t.id=? AND t.organizationId=ms.organization_id AND tm.userId=m.userId))
     ORDER BY ms.member_id`, [config.organization_id, config.assigned_member_id, config.assigned_team_id])
  if (!providers.length) badRequest('Set working hours for whoever provides this offering before it can be booked online')
  const horizon = new Date(Date.parse(input.now) + PUBLIC_BOOKING_WINDOW_DAYS * 86_400_000).toISOString()
  const queries: BatchQuery[] = []
  for (const provider of providers) {
    const slots: Array<{ starts_at: string; ends_at: string }> = []
    const timeOff = JSON.parse(provider.time_off_json) as Array<{ start: string; end: string }>
    for (const window of JSON.parse(provider.windows_json) as Array<{ start: string; end: string }>) {
      for (let start = Date.parse(window.start); start + duration * 60_000 <= Date.parse(window.end); start += duration * 60_000) {
        const slot = { starts_at: new Date(start).toISOString(), ends_at: new Date(start + duration * 60_000).toISOString() }
        if (slot.starts_at <= input.now) continue
        if (slot.starts_at >= horizon) break
        if (timeOff.some(away => away.start < slot.ends_at && away.end > slot.starts_at)) continue
        slots.push(slot)
      }
    }
    const unclaimed = `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id=product_sessions.organization_id AND b.product_session_id=product_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=product_sessions.organization_id AND h.session_id=product_sessions.id AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    queries.push({
      query: `UPDATE product_sessions SET status='cancelled', updated_at=?, updated_by=?
        WHERE organization_id=? AND product_id=? AND location_id IS NULL AND assigned_member_id=? AND status='scheduled' AND starts_at>?
          AND starts_at NOT IN (SELECT json_extract(value, '$.starts_at') FROM json_each(?)) AND ${unclaimed}`,
      params: [input.now, input.actorId, config.organization_id, config.product_id, provider.member_id, input.now, JSON.stringify(slots)],
    }, {
      query: `INSERT INTO product_sessions (id, organization_id, product_id, location_id, assigned_member_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by)
        SELECT lower(hex(randomblob(16))), ?, ?, NULL, ?, 'hours:' || ? || ':' || json_extract(slot.value, '$.starts_at'), ?, json_extract(slot.value, '$.starts_at'), json_extract(slot.value, '$.ends_at'), ?, 'scheduled', ?, ?, ?, ? FROM json_each(?) slot WHERE true
        ON CONFLICT (product_id, starts_at, assigned_member_id) WHERE location_id IS NULL AND assigned_member_id IS NOT NULL DO UPDATE SET
          ends_at=excluded.ends_at, source_occurrence_key=excluded.source_occurrence_key, timezone=excluded.timezone, capacity=excluded.capacity,
          status='scheduled', updated_at=excluded.updated_at, updated_by=excluded.updated_by
          WHERE ${unclaimed} AND (product_sessions.ends_at IS NOT excluded.ends_at
            OR product_sessions.source_occurrence_key IS NOT excluded.source_occurrence_key
            OR product_sessions.timezone IS NOT excluded.timezone OR product_sessions.capacity IS NOT excluded.capacity
            OR product_sessions.status IS NOT excluded.status)
        ON CONFLICT DO NOTHING`,
      params: [config.organization_id, config.product_id, provider.member_id, provider.member_id, provider.timezone, config.default_capacity, input.now, input.now, input.actorId, input.actorId, JSON.stringify(slots)],
    })
  }
  return queries
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
  durationMinutes: number,
): { starts_at: string; ends_at: string } | OccurrenceSkip {
  let start: Date
  try {
    // 'reject' refuses both a gap (the wall time never happens) and a fold
    // (it happens twice). Silently picking one of the two instants would book
    // guests into an hour the merchant did not choose.
    start = localDateTimeToInstant(localDate, rule.start_time, rule.timezone, 'reject')
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    // '@internationalized/date' says "No such absolute time found" for a gap
    // and "Multiple possible absolute times found" for a fold.
    const reason = /multiple|ambiguous/i.test(error.message) ? 'ambiguous_local_time' : 'nonexistent_local_time'
    return { rule_id: rule.id, local_date: localDate, local_start_time: rule.start_time, reason }
  }
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
}, config: ProductBookingConfigRecord, rules: ProductAvailabilityRule[], locations: ReadonlyMap<string, SessionLocation>, providers: Array<string | null>, existing: ReadonlySet<string> = new Set()): { queries: BatchQuery[]; planned: number; skipped: OccurrenceSkip[]; sessions: Array<{ starts_at: string; ends_at: string }> } {
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
    const capacity = config.default_capacity

    // The window is expressed in the rule's own local calendar: a weekly slot
    // is a wall-clock fact, so walking UTC days would drift across DST.
    const today = localNow(rule.timezone).date
    const from = [input.fromDate ?? today, today]
      .reduce((latest, value) => (value > latest ? value : latest))
    const through = [input.throughDate, addLocalDays(today, MAX_GENERATION_DAYS)]
      .reduce((earliest, value) => (value < earliest ? value : earliest))
    if (from > through) continue

    for (let date = from; date <= through; date = addLocalDays(date, 1)) {
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== rule.weekday) continue
      const resolved = instantsFor(rule, date, duration)
      if ('reason' in resolved) { skipped.push(resolved); continue }
      if (rule.location_id) {
        const location = locations.get(rule.location_id)
        if (!location) throw new HTTPError({ statusCode: 409, statusMessage: 'The scheduled location no longer exists' })
        if (!locationAllowsBooking(resolved, location)) { skipped.push({ rule_id: rule.id, local_date: date, local_start_time: rule.start_time, reason: 'location_closed' }); continue }
      }
      sessions.push(resolved)
      planned += providers.length
      const key = occurrenceKey(rule.id, date, rule.start_time)
      const missing = providers.filter(provider => !existing.has(provider === null ? key : `${key}:member:${provider}`))
      if (missing.length === 0) continue
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
            id, organization_id, product_id, location_id, assigned_member_id, availability_rule_id, source_occurrence_key,
            timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by
          ) SELECT ? || CASE WHEN provider.value IS NULL THEN '' ELSE ':member:' || provider.value END,
            ?, ?, ?, provider.value, ?, ? || CASE WHEN provider.value IS NULL THEN '' ELSE ':member:' || provider.value END,
            ?, ?, ?, ?, 'scheduled', ?, ?, ?, ? FROM json_each(?) provider
            WHERE provider.value IS NULL OR EXISTS(SELECT 1 FROM team t JOIN teamMember tm ON tm.teamId=t.id JOIN member m ON m.userId=tm.userId AND m.organizationId=t.organizationId WHERE t.id=? AND t.organizationId=? AND m.id=provider.value)
          ON CONFLICT (product_id, source_occurrence_key) WHERE source_occurrence_key IS NOT NULL DO NOTHING
          ON CONFLICT DO UPDATE SET
            availability_rule_id = excluded.availability_rule_id, source_occurrence_key = excluded.source_occurrence_key,
            status = CASE WHEN product_sessions.status = 'cancelled' THEN 'scheduled' ELSE product_sessions.status END,
            ends_at = excluded.ends_at, capacity = excluded.capacity, timezone = excluded.timezone,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
            WHERE product_sessions.organization_id=excluded.organization_id AND product_sessions.product_id=excluded.product_id
              AND product_sessions.assigned_member_id IS excluded.assigned_member_id
              AND product_sessions.availability_rule_id IS NULL AND product_sessions.source_occurrence_key IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = product_sessions.organization_id AND b.product_session_id = product_sessions.id)
              AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=product_sessions.organization_id AND h.session_id=product_sessions.id AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `,
        params: [
          crypto.randomUUID(), input.organizationId, input.productId, rule.location_id, rule.id,
          key, rule.timezone,
          resolved.starts_at, resolved.ends_at, capacity, now, now, input.actorId, input.actorId,
          JSON.stringify(missing), config.assigned_team_id, input.organizationId,
        ],
      })
    }
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
  const { queries: writes, planned, skipped } = prepareSessionMaterialization(input, config, rules, new Map(locations.map(location => [location.id, location])), await sessionProviders(db, config), new Set(stored.map(row => row.source_occurrence_key)))
  if (writes.length === 0) return { created: providerCreated, existing: planned, skipped }
  const results = await executeBatch(db, writes, { operation: 'Materialize product sessions' })
  const created = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0)
  return { created: providerCreated + created, existing: planned - created, skipped }
}

export async function materializeMemberSessions(db: DbClient, input: { organizationId: string; userId: string; actorId: string }) {
  const products = await queryAll<{ product_id: string }>(db, `
    SELECT c.product_id FROM product_booking_configs c
      JOIN member m ON m.organizationId=c.organization_id AND m.userId=?
     WHERE c.organization_id=? AND c.scheduling_mode='provider'
       AND (c.assigned_member_id=m.id OR EXISTS (
         SELECT 1 FROM team t JOIN teamMember tm ON tm.teamId=t.id
          WHERE t.organizationId=c.organization_id AND t.id=c.assigned_team_id AND tm.userId=m.userId))
  `, [input.userId, input.organizationId])
  for (const product of products) {
    const rules = await listAvailabilityRules(db, input.organizationId, product.product_id)
    const throughDate = rules.map(rule => addLocalDays(localNow(rule.timezone).date, PUBLIC_BOOKING_WINDOW_DAYS)).sort().at(-1)
    // An online offering's slots follow this member's hours even with no rules at all.
    await materializeSessions(db, { ...input, productId: product.product_id, throughDate: throughDate ?? addLocalDays(localDateAt(new Date(), 'UTC'), PUBLIC_BOOKING_WINDOW_DAYS) })
  }
}

export interface WeeklySlotInput {
  weekday: number
  start_time: string
}

function parseWeeklySlots(value: unknown): WeeklySlotInput[] {
  if (!Array.isArray(value)) badRequest('slots must be an array')
  const slots: WeeklySlotInput[] = value.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) badRequest('each slot must be an object')
    if (typeof entry.weekday !== 'number' || typeof entry.start_time !== 'string') badRequest('each slot needs a weekday and a start_time')
    if (Object.keys(entry).some(key => key !== 'weekday' && key !== 'start_time')) badRequest('slots support only weekday and start_time; set duration and capacity on the product')
    return { weekday: entry.weekday, start_time: entry.start_time }
  })
  const seen = new Set<string>()
  for (const slot of slots) {
    if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6) badRequest('weekday must be 0 (Sunday) to 6 (Saturday)')
    assertLocalStartTime(slot.start_time)
    const key = `${slot.weekday}:${slot.start_time}`
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


  const byKey = new Map(existing.map(rule => [`${rule.weekday}:${rule.start_time}`, rule]))
  const kept = new Set<string>()
  const now = input.now
  const writes: BatchQuery[] = []
  const rules: ProductAvailabilityRule[] = []

  for (const slot of slots) {
    const current = byKey.get(`${slot.weekday}:${slot.start_time}`)
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
    rules.push({ id, organization_id: input.organizationId, product_id: input.productId, location_id: input.locationId, timezone, ...slot })
    writes.push({
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
  return { rules, queries: writes, cancellationIndexes: removed.map((_, index) => first + index * 3) }
}

export async function replaceWeeklySchedule(db: DbClient, input: {
  organizationId: string
  productId: string
  locationId: string
  timezone?: string
  slots: unknown
  actorId: string
}): Promise<{ rules: ProductAvailabilityRule[]; sessions: MaterializeSessionsResult; cancelled: number }> {
  await requireOrganizationProduct(db, input)
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
  const materialized = prepareSessionMaterialization({ ...input, now, throughDate: addLocalDays(localNow(timezone).date, PUBLIC_BOOKING_WINDOW_DAYS) }, config, schedule.rules, new Map(locationRows.map(row => [row.id, row])), await sessionProviders(db, config))
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
  default_capacity: number | null
  confirmation_mode?: 'instant' | 'review'
  online_payment_required?: boolean
  held_online?: boolean
  scheduling_mode?: 'legacy' | 'provider'
  assigned_member_id?: string | null
  assigned_team_id?: string | null
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
  organizationId: string; productId: string; actorId: string; now: string; location: SessionLocation; assignedMemberId: string | null
}, session: { id: string; starts_at: string; ends_at: string; capacity: number | null }): BatchQuery {
  const guard: BatchQuery = { query: `EXISTS (SELECT 1 FROM business_locations l WHERE l.id=? AND l.organization_id=? AND l.status='active' AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`, params: [input.location.id, input.organizationId, input.location.timezone, input.location.opening_hours, input.location.special_hours] }
  return {
    query: `INSERT INTO product_sessions (id, organization_id, product_id, location_id, assigned_member_id, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, CASE WHEN (${guard.query}) AND (? IS NULL OR EXISTS(SELECT 1 FROM product_booking_configs c JOIN team t ON t.id=c.assigned_team_id AND t.organizationId=c.organization_id JOIN teamMember tm ON tm.teamId=t.id JOIN member m ON m.userId=tm.userId AND m.organizationId=t.organizationId WHERE c.product_id=? AND c.organization_id=? AND m.id=?)) THEN ? ELSE NULL END, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    params: [session.id, input.organizationId, input.productId, input.location.id, input.assignedMemberId, input.location.timezone, ...guard.params!, input.assignedMemberId, input.productId, input.organizationId, input.assignedMemberId, session.starts_at, session.ends_at, session.capacity, input.now, input.now, input.actorId, input.actorId],
  }
}

/** Product creation uses the same config and occurrence writers in its atomic batch. */
export async function prepareProductBookingSetup(db: DbClient, input: {
  organizationId: string; productId: string; actorId: string; env: import('~/server/utils/auth').CloudflareEnv; now: string; booking: ProductBookingSetupInput; productInSameBatch?: boolean
}): Promise<BatchQuery[]> {
  const booking = input.booking
  if (!Number.isSafeInteger(booking.duration_minutes) || booking.duration_minutes <= 0) badRequest('Provide the session duration before creating a bookable offering')
  if (booking.default_capacity !== null && (!Number.isSafeInteger(booking.default_capacity) || booking.default_capacity <= 0)) badRequest('Provide places per session, or explicit null for unlimited places')
  const { location_id: locationId, weekly_slots: weeklySlots, sessions: oneOffSessions, ...patch } = booking
  const { query: configQuery, config } = await prepareProductBookingConfig(db, { ...input, patch: { ...patch, held_online: locationId === null }, productInSameBatch: input.productInSameBatch })
  const queries: BatchQuery[] = [configQuery]
  // The offering is created only if a guest could book something now, at the location as it was read.
  let locationGuard: BatchQuery = { query: 's.location_id IS NULL', params: [] }
  if (locationId === null) {
    // Online: the provider's working hours are the times. Weekly slots and
    // dated sessions would be a second schedule beside theirs.
    if (weeklySlots?.length || oneOffSessions?.length) badRequest('An online offering is booked in its provider\'s working hours; it takes no weekly times or dated sessions')
    queries.push(...await prepareProviderHoursSessions(db, config, input))
  } else {
    const location = await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, locationId])
    if (!location || location.status !== 'active') badRequest('Choose an active location in this business')
    locationGuard = { query: `EXISTS (SELECT 1 FROM business_locations l WHERE l.id=s.location_id AND l.organization_id=s.organization_id AND l.status='active' AND l.timezone IS ? AND l.opening_hours IS ? AND l.special_hours IS ?)`, params: [location.timezone, location.opening_hours, location.special_hours] }
    const existingRules = input.productInSameBatch ? [] : (await listAvailabilityRules(db, input.organizationId, input.productId)).filter(rule => rule.location_id === locationId)
    const schedule = prepareWeeklySchedule({ ...input, locationId, slots: weeklySlots ?? existingRules.map(rule => ({ weekday: rule.weekday, start_time: rule.start_time })) }, config, location.timezone, existingRules)
    if (!schedule.rules.length && !oneOffSessions?.length) badRequest('Provide actual weekly times or dated sessions before creating a bookable offering')
    queries.push({
      query: `INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?) ON CONFLICT(product_id,location_id) DO UPDATE SET active=1,published=1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      params: [input.organizationId, input.productId, locationId, input.now, input.now, input.actorId, input.actorId],
    }, ...schedule.queries)
    const providers = await sessionProviders(db, config)
    if (!providers.length) badRequest('Set working hours for the assigned team before adding bookable times')
    const materialized = prepareSessionMaterialization({ ...input, throughDate: addLocalDays(localNow(location.timezone).date, PUBLIC_BOOKING_WINDOW_DAYS) }, config, schedule.rules, new Map([[location.id, location]]), providers)
    if (materialized.skipped.some(skipped => skipped.reason !== 'location_closed')) throw new HTTPError({ statusCode: 400, statusMessage: 'Some requested local times are ambiguous or do not exist; choose their actual times before creating the offering', data: { skipped: materialized.skipped } })
    queries.push(...materialized.queries)
    let futureSessions = materialized.sessions.filter(session => session.starts_at > input.now).length
    for (const session of oneOffSessions ?? []) {
      const instants = sessionInstants(session.starts_at, session.ends_at)
      if (instants.starts_at <= input.now) badRequest('New dated sessions must start in the future')
      const capacity = session.capacity === undefined ? config.default_capacity : session.capacity
      if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity <= 0)) badRequest('Dated sessions need positive capacity or explicit null for unlimited places')
      if (!locationAllowsBooking(instants, location)) badRequest('A dated session is outside opening hours or during a closure')
      for (const assignedMemberId of providers) queries.push(manualSessionQuery({ ...input, location, assignedMemberId }, { id: crypto.randomUUID(), ...instants, capacity }))
      futureSessions += 1
    }
    if (!futureSessions) badRequest('Provide at least one future session before creating a bookable offering')
  }
  queries.push({
    query: `UPDATE product_booking_configs SET updated_at=CASE WHEN EXISTS (
      SELECT 1 FROM product_sessions s WHERE s.organization_id=? AND s.product_id=?
        AND s.location_id IS ? AND s.starts_at>? AND s.status='scheduled'
        AND (s.capacity IS NULL OR s.capacity>${sessionHeldCapacitySql('s')}+COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.product_session_id=s.id AND ${CAPACITY_CONSUMING_SQL}),0))
        AND (${locationGuard.query}) AND NOT ${providerUnavailableSql('s')}
    ) THEN updated_at ELSE NULL END WHERE organization_id=? AND product_id=?`,
    params: [input.organizationId, input.productId, locationId, input.now, ...locationGuard.params!, input.organizationId, input.productId],
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
  organizationId: string
  productId?: string
  locationId?: string
  fromInstant: string
  toInstant: string
  statuses?: ProductSessionStatus[]
}): Promise<SessionAvailability[]> {
  const statuses = input.statuses ?? ['scheduled']
  const sessions = await queryAll<SessionAvailability>(db, `
    SELECT s.id, s.organization_id, s.product_id, s.location_id, s.availability_rule_id, ${sessionMemberSql('s')} AS assigned_member_id,
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
      AND (? IS NULL OR s.location_id = ?)
      AND s.starts_at >= ? AND s.starts_at < ?
      AND s.status IN (SELECT value FROM json_each(?))
    ORDER BY s.starts_at, s.id
  `, [
    input.organizationId,
    input.productId ?? null, input.productId ?? null,
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
  organizationId: string; productId: string; sessionId: string; partySize: number; now: string
  /** Publication keeps its page when sale is disabled; bookings require active sale by default. */
  requireActive?: boolean
  replacingBookingId?: string | null
  /** Only authenticated capture reconciliation supplies this; public callers cannot exclude holds. */
  capturedPaymentId?: string
  /** Authenticated automatic capture time; delivery time still checks current capacity. */
  capturedAt?: string
  requireUndecided?: { requestId: string; organizationId: string; updatedAt: string; decisionDedupeKey: string } | null
}

export async function sessionAllocationPredicate(db: DbClient, input: SessionAllocationInput): Promise<BatchQuery> {
  const location = await sessionLocationGuard(db, input)
  return { query: `${input.capturedPaymentId ? `EXISTS (SELECT 1 FROM payment_checkout_holds h JOIN payments p ON p.id=h.payment_id WHERE p.id=? AND p.organization_id=? AND p.state='captured' AND p.refunded_amount=0 AND h.status IN ('active','released') AND h.expires_at>? AND h.session_id=? AND h.quantity=? AND h.organization_id=p.organization_id AND h.amount=p.amount AND h.currency=p.currency) AND ` : ''}${input.requireUndecided
        ? `EXISTS (SELECT 1 FROM requests WHERE id = ? AND organization_id = ? AND updated_at = ?)
           AND NOT EXISTS (SELECT 1 FROM activity_entries WHERE dedupe_key = ?) AND `
        : ''}EXISTS (
        SELECT 1 FROM product_sessions s
        WHERE s.id = ? AND s.organization_id = ? AND s.product_id = ?
          AND s.status = 'scheduled'
          AND EXISTS (SELECT 1 FROM product_booking_configs c JOIN products p ON p.id=c.product_id AND p.organization_id=c.organization_id
            WHERE c.product_id=s.product_id AND c.organization_id=s.organization_id AND c.duration_minutes>0
              ${input.capturedPaymentId || input.requireActive === false ? '' : 'AND p.active=1'} AND (s.location_id IS NOT NULL OR c.held_online=1))
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
          ${input.capturedPaymentId ? 'AND EXISTS(SELECT 1 FROM payment_checkout_holds held WHERE held.payment_id=? AND held.assigned_member_id IS ' + sessionMemberSql('s') + ')' : ''}
          AND (s.capacity IS NULL OR s.capacity >= ? + ${sessionHeldCapacitySql('s','?')} + COALESCE((
            SELECT SUM(b.party_size) FROM bookings b
            WHERE b.product_session_id = s.id AND b.id IS NOT ? AND ${CAPACITY_CONSUMING_SQL}
          ), 0))
      )`, params: [
      ...(input.capturedPaymentId ? [input.capturedPaymentId,input.organizationId,input.capturedAt ?? input.now,input.sessionId,input.partySize] : []),
      ...(input.requireUndecided
        ? [input.requireUndecided.requestId, input.requireUndecided.organizationId, input.requireUndecided.updatedAt, input.requireUndecided.decisionDedupeKey]
        : []),
      input.sessionId, input.organizationId, input.productId, ...location.params!, input.now, input.replacingBookingId ?? null, input.capturedPaymentId ?? null, ...(input.capturedPaymentId ? [input.capturedPaymentId] : []), input.partySize, input.capturedPaymentId ?? null, input.replacingBookingId ?? null,
  ] }
}

/** Move the same operational Booking ID, preserving its review and payment identity. */
export async function sessionMoveQuery(db: DbClient, input: SessionAllocationInput & { bookingId: string }): Promise<BatchQuery> {
  const allocation = await sessionAllocationPredicate(db, { ...input, replacingBookingId: input.bookingId })
  return {
    query: `UPDATE bookings SET assigned_member_id = (SELECT ${sessionMemberSql('destination')} FROM product_sessions destination WHERE destination.id=? AND destination.organization_id=?), product_session_id = ?, party_size = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND product_id = ? AND status IN ('pending', 'confirmed')
        AND EXISTS (SELECT 1 FROM product_sessions current_session WHERE current_session.id=bookings.product_session_id AND current_session.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND ${allocation.query}
        AND (NOT EXISTS (SELECT 1 FROM payments p WHERE p.organization_id=bookings.organization_id AND p.subject_type='booking' AND p.subject_id=bookings.id AND p.captured_amount>p.refunded_amount)
          OR (party_size=? AND (SELECT location_id FROM product_sessions WHERE id=bookings.product_session_id) IS (SELECT location_id FROM product_sessions WHERE id=? AND organization_id=bookings.organization_id)))`,
    params: [input.sessionId, input.organizationId, input.sessionId, input.partySize, input.now, input.bookingId, input.organizationId, input.productId, ...allocation.params!, input.partySize, input.sessionId],
  }
}

export async function sessionClaimQuery(db: DbClient, input: {
  bookingId: string
  organizationId: string
  productId: string
  sessionId: string
  productVariantId: string
  partySize: number
  /** The Better Auth user the booking belongs to. */
  userId?: string | null
  requestId?: string | null
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
  capturedPaymentId?: string
  /** Authenticated automatic capture time; delivery time still checks current capacity. */
  capturedAt?: string
  now: string
}): Promise<BatchQuery> {
  const allocation = await sessionAllocationPredicate(db, input)
  return {
    query: `
      INSERT INTO bookings (
        id, organization_id, product_id, product_session_id, product_variant_id,
        user_id, request_id, party_size, status, created_at, updated_at, assigned_member_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT status FROM bookings WHERE id = ?),
          (SELECT CASE WHEN confirmation_mode = 'review' THEN 'pending' ELSE 'confirmed' END
           FROM product_booking_configs WHERE product_id = ? AND organization_id = ?)), ?, ?,
        (SELECT ${sessionMemberSql('assigned')} FROM product_sessions assigned WHERE assigned.id=? AND assigned.organization_id=?)
      WHERE ${allocation.query}
        AND EXISTS(SELECT 1 FROM product_variants v WHERE v.id=? AND v.product_id=? AND v.organization_id=? AND v.active=1)
      ON CONFLICT (id) DO NOTHING
    `,
    params: [
      input.bookingId, input.organizationId, input.productId, input.sessionId, input.productVariantId,
      input.userId ?? null, input.requestId ?? null, input.partySize, input.replacingBookingId ?? null, input.productId, input.organizationId, input.now, input.now, input.sessionId, input.organizationId,
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
 *
 * A thread already holding a booking returns that booking instead of claiming
 * a second time.
 */
export async function claimSessionCapacity(db: DbClient, input: {
  organizationId: string
  productId: string
  sessionId: string
  productVariantId: string
  partySize: number
  /** The Better Auth user the booking belongs to. */
  userId?: string | null
  requestId?: string | null
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

  if (input.requestId) {
    const existing = await queryFirst<{ id: string; product_id: string; product_session_id: string; product_variant_id: string; party_size: number }>(db, `
      SELECT id, product_id, product_session_id, product_variant_id, party_size FROM bookings WHERE organization_id = ? AND request_id = ?
    `, [input.organizationId, input.requestId])
    if (existing) {
      if (existing.product_id !== input.productId || existing.product_session_id !== input.sessionId || existing.product_variant_id !== input.productVariantId || existing.party_size !== input.partySize) throw new HTTPError({ statusCode: 409, statusMessage: 'This request already holds a different booking' })
      return { bookingId: existing.id }
    }
  }

  const bookingId = crypto.randomUUID()
  const claim = await sessionClaimQuery(db, { ...input, bookingId, now: new Date().toISOString() })
  const results = await executeBatch(db, [claim, sessionAssignmentQuery(input.sessionId, input.organizationId, bookingId), ...(input.following?.(bookingId) ?? [])], { operation: 'Claim session capacity' })
  if ((results[0]?.meta?.changes ?? 0) === 0) throw new CapacityUnavailableError()
  return { bookingId }
}

/**
 * Move a booking to a new state, releasing exactly the seats it held.
 *
 * Cancellation releases this booking's party_size and nothing else, because
 * the seats were never tracked as a counter that could drift — availability is
 * always the sum over live bookings.
 */
export async function setBookingStatus(db: DbClient, input: {
  organizationId: string
  bookingId: string
  status: BookingStatus
  reason?: string | null
}): Promise<void> {
  const now = new Date().toISOString()
  const results = await executeBatch(db, [{
    query: `
      UPDATE bookings SET
        status = ?,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, ?) ELSE NULL END,
        cancellation_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE NULL END,
        updated_at = ?
      WHERE organization_id = ? AND id = ?
        AND (status = ? OR (status = 'pending' AND ? = 'confirmed') OR (? = 'cancelled' AND status IN ('pending', 'confirmed')))
    `,
    params: [input.status, input.status, now, input.status, input.reason ?? null, now, input.organizationId, input.bookingId, input.status, input.status, input.status],
  }], { operation: 'Set booking status' })
  if ((results[0]?.meta?.changes ?? 0) === 0) throw new HTTPError({ statusCode: 404, statusMessage: 'Booking not found' })
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
export async function getSessionAvailability(db: DbClient, organizationId: string, productId: string, sessionId: string): Promise<SessionAvailability> {
  const session = await queryFirst<ProductSession>(db, 'SELECT * FROM product_sessions WHERE organization_id=? AND product_id=? AND id=?', [organizationId, productId, sessionId])
  if (!session) throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found for this offering' })
  const sessions = await listSessions(db, { organizationId, productId, fromInstant: session.starts_at, toInstant: session.ends_at, statuses: ['scheduled', 'cancelled'] })
  const result = sessions.find(row => row.id === sessionId)
  if (!result) throw new Error('The saved session could not be read back')
  return result
}

export async function createSession(db: DbClient, input: {
  organizationId: string; productId: string; locationId: string; startsAt: string; endsAt: string; capacity?: number | null; actorId: string; idempotencyKey: string
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
    return Promise.all(ids.map(id => getSessionAvailability(db, input.organizationId, input.productId, id)))
  }
  const earlier = await replay()
  if (earlier) return earlier
  await requireOrganizationProduct(db, input)
  const config = await requireBookingConfig(db, input.organizationId, input.productId)
  const location = await queryFirst<SessionLocation>(db, 'SELECT id,timezone,status,opening_hours,special_hours FROM business_locations WHERE organization_id=? AND id=?', [input.organizationId, input.locationId])
  if (!location) badRequest('Choose a location in this business')
  const instants = sessionInstants(input.startsAt, input.endsAt)
  const now = new Date().toISOString()
  if (instants.starts_at <= now) badRequest('A new session must start in the future')
  const capacity = input.capacity === undefined ? config.default_capacity : input.capacity
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0)) badRequest('capacity must be a non-negative integer or null')
  if (!locationAllowsBooking(instants, location)) badRequest('This session is outside opening hours or during a closure')
  const providers = await sessionProviders(db, config)
  if (!providers.length) badRequest('Set working hours for the assigned team before adding bookable times')
  const sessions = providers.map(assignedMemberId => ({ id: crypto.randomUUID(), assignedMemberId }))
  try {
    await executeBatch(db, [...sessions.map(session => manualSessionQuery({ ...input, now, location, assignedMemberId: session.assignedMemberId }, { id: session.id, ...instants, capacity })),
      organizationEventQuery({ organizationId: input.organizationId, locationId: input.locationId, actorId: input.actorId, eventType: 'product.updated', entityType: 'session', entityId: sessions[0]!.id, dedupeKey, metadata: { request_hash: requestHash, product_id: input.productId, session_ids: sessions.map(session => session.id) } }),
      publicResourceCacheInvalidationQuery(input.organizationId, 'product-session-created')], { operation: 'Create product session' })
  } catch (error) {
    if (isUniqueDedupeConflict(error)) { const concurrent = await replay(); if (concurrent) return concurrent }
    throw error
  }
  return Promise.all(sessions.map(session => getSessionAvailability(db, input.organizationId, input.productId, session.id)))
}

export async function updateSession(db: DbClient, input: {
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
          OR NOT EXISTS (SELECT 1 FROM (SELECT product_sessions.id AS id, product_sessions.assigned_member_id AS assigned_member_id, product_sessions.organization_id AS organization_id, product_sessions.product_id AS product_id, product_sessions.location_id AS location_id, ? AS starts_at, ? AS ends_at) proposed
            WHERE ${providerUnavailableSql('proposed')}))
    `,
    params: [
      startsAt, endsAt, capacity,
      input.status ?? session.status, now, input.actorId,
      input.organizationId, input.sessionId, session.updated_at,
      ...(capacity === null ? [] : [capacity]), ...locationGuard.params!, startsAt, endsAt, input.status ?? session.status, startsAt, endsAt,
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
  return getSessionAvailability(db, input.organizationId, session.product_id, session.id)
}

/** The local calendar date a session falls on, for grouping in a UI. */
export function sessionLocalDate(session: Pick<ProductSession, 'starts_at' | 'timezone'>): string {
  return localDateAt(new Date(session.starts_at), session.timezone)
}

export function assertLocalStartTime(value: string, field = 'start_time'): void {
  if (!MINUTE_TIME_PATTERN.test(value)) badRequest(`${field} must be in "HH:MM" format`)
}

/** Persist the Session commitment inside the same D1 batch as its first claim. */
export function sessionAssignmentQuery(sessionId:string, organizationId:string, bookingId:string):BatchQuery {
 return {query:'UPDATE product_sessions SET assigned_member_id=(SELECT assigned_member_id FROM bookings WHERE id=?) WHERE id=? AND organization_id=? AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND product_session_id=product_sessions.id)',params:[bookingId,sessionId,organizationId,bookingId]}
}
