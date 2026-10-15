import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedHomeSql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { createLocation } from '~/server/utils/location-management'
import { createProduct } from '~/server/utils/product-management'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { selectPrice, type Price } from '~/shared/prices'
import { isValidTimezone } from '~/utils/timezone'

/**
 * Places to stay: the one implementation of stays, nights and offline
 * payments. Dashboard routes, MCP tools and the native app's API all call
 * these functions; none of them reads or writes the tables directly.
 *
 * A stay holds the nights [check_in_date, check_out_date) at one home. Its
 * night claims (stay_nights) are written in the same batch as the stay, so the
 * primary key on (product_id, date) is the overlap guard: two writes for one
 * night cannot both commit.
 */

/** Who is asking: managers act on every home; assigned members read the homes they look after. */
export type StayAccess = { organizationId: string; actorId: string } & ({ manage: true } | { manage: false; userId: string })

/** Resolve a member's stay access from their Better Auth role: operations update manages, operations assigned reads assigned homes. */
export async function stayAccessFor(principal: MemberAccessPrincipal): Promise<StayAccess> {
  if (await roleAllows({ ...principal, permissions: { operations: ['update'] } })) return { organizationId: principal.organizationId, actorId: principal.userId, manage: true }
  await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
  return { organizationId: principal.organizationId, actorId: principal.userId, manage: false, userId: principal.userId }
}

export const STAY_CHANNELS = ['airbnb', 'vrbo', 'direct'] as const
export const STAY_STATUSES = ['pending', 'confirmed', 'cancelled'] as const
export const STAY_PAYMENT_METHODS = ['cash', 'bank_transfer', 'card_external', 'other'] as const
export type StayPaymentMethod = typeof STAY_PAYMENT_METHODS[number]

export interface Stay {
  id: string
  product_id: string
  location_id: string
  /** The home's location timezone: its dates and times are read in it. */
  timezone: string
  channel: typeof STAY_CHANNELS[number]
  owner: 'app' | 'channel'
  status: typeof STAY_STATUSES[number]
  overbooked: boolean
  check_in_date: string
  check_out_date: string
  arrival_time: string | null
  adults: number
  children: number
  infants: number
  guest_name: string | null
  guest_surname: string | null
  guest_email: string | null
  guest_phone: string | null
  user_id: string | null
  total_minor: number
  currency: string
  notes: string | null
  provider: 'channex' | null
  external_booking_id: string | null
  channel_booking_id: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface StayPayment {
  id: string
  stay_id: string
  amount_minor: number
  currency: string
  method: StayPaymentMethod
  paid_on: string
  reference: string | null
  note: string | null
  created_at: string
  created_by: string
}

/** A stay with what the host has recorded collecting for it. Channel stays are paid through their channel. */
export interface StayDetail extends Stay {
  payments: StayPayment[]
  paid_minor: number
  payment_status: 'unpaid' | 'partial' | 'paid' | 'overpaid' | null
}

export interface StayHome {
  product_id: string
  name: string
  location_id: string
  timezone: string
  currency: CurrencyCode
  base_price_minor: number | null
  check_in_time: string
  check_out_time: string
  max_guests: number
  min_nights: number
}

export interface StayNight {
  date: string
  available: boolean
  stay_id: string | null
  closed: boolean
  price_minor: number | null
  min_stay_arrival: number | null
  min_stay_through: number | null
  max_stay: number | null
  closed_to_arrival: boolean
  closed_to_departure: boolean
  source: 'host' | 'import' | null
}

const MAX_LIST_DAYS = 400
const MAX_CALENDAR_DAYS = 500
const MAX_STAY_NIGHTS = 365
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, ...(field ? { field } : {}) } })
}

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(422, 'INVALID_DATE', `${field} must be a YYYY-MM-DD date`, field)
  return value
}

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function range(input: { from: unknown; to: unknown }, max: number): { from: string; to: string } {
  const from = date(input.from, 'from')
  const to = date(input.to, 'to')
  const span = days(from, to)
  if (span < 1 || span > max) fail(422, 'INVALID_RANGE', `to must be after from and at most ${max} days later`, 'to')
  return { from, to }
}

function optionalText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail(422, 'INVALID_STAY_FIELD', `${field} must be text`, field)
  const text = value.trim()
  if (text.length > max) fail(422, 'INVALID_STAY_FIELD', `${field} must be at most ${max} characters`, field)
  return text || null
}

function count(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 99) fail(422, 'INVALID_STAY_FIELD', `${field} must be a whole number from ${min} to 99`, field)
  return value
}

function amount(value: unknown, field: string, allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!allowNegative && value < 0)) fail(422, 'INVALID_AMOUNT', `${field} must be a whole number of minor units${allowNegative ? '' : ' of at least 0'}`, field)
  return value
}

const STAY_COLUMNS = `s.id, s.product_id, c.location_id, l.timezone, s.channel, s.owner, s.status, s.overbooked, s.check_in_date, s.check_out_date, s.arrival_time,
  s.adults, s.children, s.infants, s.guest_name, s.guest_surname, s.guest_email, s.guest_phone, s.user_id, s.total_minor, s.currency, s.notes,
  s.provider, s.external_booking_id, s.channel_booking_id, s.cancelled_at, s.cancellation_reason, s.version, s.created_at, s.updated_at`

function mapStay(row: Record<string, unknown>): Stay {
  return { ...row, overbooked: Number(row.overbooked) === 1 } as unknown as Stay
}

/** The SQL that limits rows to homes this caller may see, and its parameters. */
function visibleHomes(access: StayAccess, alias = 'c'): { sql: string; params: string[] } {
  return access.manage ? { sql: '1 = 1', params: [] } : { sql: assignedHomeSql(alias), params: [access.userId, access.userId] }
}

function requireManager(access: StayAccess): asserts access is StayAccess & { manage: true } {
  if (!access.manage) fail(403, 'STAY_ROLE_REQUIRED', 'Only organization owners and admins can change stays')
}

/** The homes this caller may see, or one of them; one query for the homes and one for their prices. */
async function stayHomes(db: DbClient, access: StayAccess, productId: string | null): Promise<StayHome[]> {
  const scope = visibleHomes(access)
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT p.id AS product_id, p.name, c.location_id, l.timezone, o.default_currency, c.check_in_time, c.check_out_time, c.max_guests, c.min_nights
      FROM product_stay_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      JOIN organization o ON o.id = c.organization_id
     WHERE c.organization_id = ? ${productId ? 'AND c.product_id = ?' : ''} AND ${scope.sql}
     ORDER BY p.name, p.id`, [access.organizationId, ...(productId ? [productId] : []), ...scope.params])
  if (!rows.length) return []
  const prices = await queryAll<Price & { product_id: string }>(db, `
    SELECT pr.*, v.product_id FROM prices pr
      JOIN product_variants v ON v.organization_id = pr.organization_id AND v.id = pr.product_variant_id
      JOIN product_stay_configs c ON c.organization_id = v.organization_id AND c.product_id = v.product_id
     WHERE pr.organization_id = ? ${productId ? 'AND v.product_id = ?' : ''} AND v.active = 1
     ORDER BY v.sort_order, v.id`, [access.organizationId, ...(productId ? [productId] : [])])
  return rows.map((row) => {
    if (!isCurrencyCode(row.default_currency)) throw new Error(`Organization ${access.organizationId} has an unsupported default currency`)
    const own = prices.filter(price => price.product_id === row.product_id).map(price => ({ ...price, active: Number(price.active) === 1 }))
    const base = selectPrice(own, { currency: row.default_currency, location_id: String(row.location_id) })
    return {
      product_id: String(row.product_id), name: String(row.name), location_id: String(row.location_id), timezone: String(row.timezone),
      currency: row.default_currency, base_price_minor: base ? base.unit_amount : null,
      check_in_time: String(row.check_in_time), check_out_time: String(row.check_out_time), max_guests: Number(row.max_guests), min_nights: Number(row.min_nights),
    }
  })
}

/** Every place to stay this caller may see: all of them for managers, their assigned homes for members. */
export async function listStayHomes(db: DbClient, access: StayAccess): Promise<StayHome[]> {
  return await stayHomes(db, access, null)
}

export async function readStayHome(db: DbClient, access: StayAccess, productId: string): Promise<StayHome> {
  const [home] = await stayHomes(db, access, productId)
  if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  return home
}

/** A new place to stay: the location it is at and its stay rules, checked. */
export interface NewStayHome {
  name: string
  timezone: string
  address: string
  city: string
  state: string | null
  /** ISO 3166-1 alpha-2, upper case. */
  country: string
  zip_code: string | null
  phone: string | null
  email: string | null
  check_in_time: string
  check_out_time: string
  max_guests: number
  min_nights: number
  base_price_minor: number | null
}

/** Read a new home's details from a request body; each problem names its field. */
export function stayHomeInput(body: Record<string, unknown>): NewStayHome {
  const text = (key: string, max: number, required: boolean): string | null => {
    const value = body[key]
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      if (required) fail(422, 'MISSING_DETAIL', `${key} is required`, key)
      return null
    }
    if (typeof value !== 'string' || value.trim().length > max) fail(422, 'INVALID_DETAIL', `${key} must be text of at most ${max} characters`, key)
    return value.trim()
  }
  const whole = (key: string, min: number, max: number, required: boolean): number | null => {
    const value = body[key]
    if (value === undefined || value === null) {
      if (required) fail(422, 'MISSING_DETAIL', `${key} is required`, key)
      return null
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(422, 'INVALID_DETAIL', `${key} must be a whole number from ${min} to ${max}`, key)
    return value
  }
  const home: NewStayHome = {
    name: text('name', 200, true)!, timezone: text('timezone', 64, true)!,
    address: text('address', 200, true)!, city: text('city', 100, true)!, state: text('state', 100, false),
    country: text('country', 2, true)!, zip_code: text('zip_code', 32, false),
    phone: text('phone', 32, false), email: text('email', 254, false),
    check_in_time: text('check_in_time', 5, true)!, check_out_time: text('check_out_time', 5, true)!,
    max_guests: whole('max_guests', 1, 99, true)!, min_nights: whole('min_nights', 1, 365, true)!,
    base_price_minor: whole('base_price_minor', 0, Number.MAX_SAFE_INTEGER, false),
  }
  if (!/^[A-Z]{2}$/.test(home.country)) fail(422, 'INVALID_DETAIL', 'country must be a two-letter ISO country code', 'country')
  if (!isValidTimezone(home.timezone)) fail(422, 'INVALID_DETAIL', 'Choose a valid time zone', 'timezone')
  if (home.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(home.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email', 'email')
  for (const key of ['check_in_time', 'check_out_time'] as const) {
    if (!TIME.test(home[key])) fail(422, 'INVALID_DETAIL', `${key} must be a 24-hour HH:MM time`, key)
  }
  return home
}

/**
 * Add a place to stay: a new location of this organization (its plan's
 * location billing applies) and an unpublished stay at it, priced per night in
 * the organization's currency. A home added by hand and one imported from a
 * channel are made here, the same way. The key replays both writes.
 */
export async function createStayHome(env: Parameters<typeof createLocation>[0], db: DbClient, access: StayAccess, home: NewStayHome, idempotencyKey: string): Promise<StayHome> {
  requireManager(access)
  const located = await createLocation(env, db as D1Database, access.organizationId, {
    title: home.name, timezone: home.timezone, phone: home.phone, email: home.email,
    address: { regionCode: home.country, addressLines: [home.address], locality: home.city, administrativeArea: home.state ?? undefined, postalCode: home.zip_code ?? undefined },
  }, access.actorId, { idempotencyKey })
  if (located.status !== 201 || !('location' in located.data)) {
    const data = located.data as { error?: string; code?: string }
    throw new HTTPError({ statusCode: located.status, statusMessage: data.error ?? 'The location could not be created', data: { code: data.code ?? 'LOCATION_NOT_CREATED' } })
  }
  const locationId = (located.data as { location: { id: string } }).location.id
  const product = await createProduct(db, {
    organizationId: access.organizationId, actor: { actorId: access.actorId }, idempotencyKey,
    product: {
      kind: 'stay', name: home.name,
      ...(home.base_price_minor === null ? {} : { variants: [{ name: home.name, prices: [{ unit_amount: home.base_price_minor }] }] }),
      stay: { location_id: locationId, check_in_time: home.check_in_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, assigned_member_id: null, assigned_team_id: null },
    },
  })
  return await readStayHome(db, access, product.id)
}

/** Stays overlapping [from, to), newest check-in last. Cancelled stays are included only when asked for. */
export async function listStays(db: DbClient, access: StayAccess, input: { from: unknown; to: unknown; productId?: string; includeCancelled?: boolean }): Promise<Stay[]> {
  const { from, to } = range(input, MAX_LIST_DAYS)
  const scope = visibleHomes(access)
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.check_in_date < ? AND s.check_out_date > ?
       ${input.productId ? 'AND s.product_id = ?' : ''} ${input.includeCancelled ? '' : "AND s.status <> 'cancelled'"} AND ${scope.sql}
     ORDER BY s.check_in_date, s.id`, [access.organizationId, to, from, ...(input.productId ? [input.productId] : []), ...scope.params])
  return rows.map(mapStay)
}

export async function getStay(db: DbClient, access: StayAccess, stayId: string): Promise<StayDetail> {
  const scope = visibleHomes(access)
  const row = await queryFirst<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.id = ? AND ${scope.sql}`, [access.organizationId, stayId, ...scope.params])
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That stay is not in this organization')
  const stay = mapStay(row)
  const payments = await queryAll<StayPayment>(db, `
    SELECT id, stay_id, amount_minor, currency, method, paid_on, reference, note, created_at, created_by
      FROM stay_payments WHERE organization_id = ? AND stay_id = ? ORDER BY paid_on, created_at`, [access.organizationId, stayId])
  const paid = payments.reduce((sum, payment) => sum + payment.amount_minor, 0)
  const status = stay.owner === 'channel' ? null
    : paid === 0 ? 'unpaid' : paid < stay.total_minor ? 'partial' : paid === stay.total_minor ? 'paid' : 'overpaid'
  return { ...stay, payments, paid_minor: paid, payment_status: status }
}

/** Every night of [from, to) at one home: whether it is free, its price and rules, and the stay holding it. */
export async function readStayCalendar(db: DbClient, access: StayAccess, input: { productId: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Stay[] }> {
  const { from, to } = range(input, MAX_CALENDAR_DAYS)
  const home = await readStayHome(db, access, input.productId)
  const [overrides, claims, stays] = await Promise.all([
    queryAll<Record<string, unknown>>(db, 'SELECT * FROM product_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ?', [access.organizationId, input.productId, from, to]),
    queryAll<{ date: string; stay_id: string }>(db, 'SELECT date, stay_id FROM stay_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ?', [access.organizationId, input.productId, from, to]),
    listStays(db, access, { from, to, productId: input.productId }),
  ])
  const overrideByDate = new Map(overrides.map(row => [String(row.date), row]))
  const claimByDate = new Map(claims.map(row => [row.date, row.stay_id]))
  const nights: StayNight[] = []
  for (let offset = 0; offset < days(from, to); offset++) {
    const night = new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
    const row = overrideByDate.get(night)
    const stayId = claimByDate.get(night) ?? null
    const closed = Number(row?.closed ?? 0) === 1
    nights.push({
      date: night, available: !closed && stayId === null, stay_id: stayId, closed,
      price_minor: row?.price_minor === null || row?.price_minor === undefined ? home.base_price_minor : Number(row.price_minor),
      min_stay_arrival: row?.min_stay_arrival == null ? null : Number(row.min_stay_arrival),
      min_stay_through: row?.min_stay_through == null ? null : Number(row.min_stay_through),
      max_stay: row?.max_stay == null ? null : Number(row.max_stay),
      closed_to_arrival: Number(row?.closed_to_arrival ?? 0) === 1,
      closed_to_departure: Number(row?.closed_to_departure ?? 0) === 1,
      source: row ? row.source as 'host' | 'import' : null,
    })
  }
  return { home, nights, stays }
}

/**
 * Make a stay's night claims match its row as committed: release the nights it
 * no longer holds, then claim the ones it lacks. Both read the dates and status
 * from the stays row, never from the caller, so a batch whose version-guarded
 * update lost a race converges on the winner's state instead of acting on its
 * own parameters. A long stay is still one statement each.
 */
function reconcileNightsQueries(organizationId: string, stayId: string): BatchQuery[] {
  const row = `(SELECT check_in_date, check_out_date, status, overbooked, product_id FROM stays WHERE organization_id = ? AND id = ?)`
  return [{
    query: `DELETE FROM stay_nights WHERE organization_id = ? AND stay_id = ? AND EXISTS (SELECT 1 FROM ${row} st
              WHERE st.status = 'cancelled' OR st.overbooked = 1 OR stay_nights.product_id <> st.product_id OR stay_nights.date < st.check_in_date OR stay_nights.date >= st.check_out_date)`,
    params: [organizationId, stayId, organizationId, stayId],
  }, {
    query: `WITH RECURSIVE st AS ${row},
              night(d) AS (SELECT check_in_date FROM st WHERE status <> 'cancelled' AND overbooked = 0
                UNION ALL SELECT date(d, '+1 day') FROM night WHERE date(d, '+1 day') < (SELECT check_out_date FROM st))
            INSERT INTO stay_nights (organization_id, product_id, date, stay_id)
            SELECT ?, (SELECT product_id FROM st), d, ? FROM night
             WHERE NOT EXISTS (SELECT 1 FROM stay_nights own WHERE own.organization_id = ? AND own.stay_id = ? AND own.date = night.d)`,
    params: [organizationId, stayId, organizationId, stayId, organizationId, stayId],
  }]
}

function isNightConflict(error: unknown): boolean {
  return /UNIQUE constraint failed: stay_nights\./.test(error instanceof Error ? error.message : String(error))
}

interface StayFields {
  check_in_date: string
  check_out_date: string
  arrival_time: string | null
  adults: number
  children: number
  infants: number
  guest_name: string
  guest_surname: string | null
  guest_email: string | null
  guest_phone: string | null
  total_minor: number
  notes: string | null
}

function stayFields(input: Record<string, unknown>, home: StayHome): StayFields {
  const checkIn = date(input.check_in_date, 'check_in_date')
  const checkOut = date(input.check_out_date, 'check_out_date')
  const nights = days(checkIn, checkOut)
  if (nights < 1) fail(422, 'INVALID_DATE', 'check_out_date must be after check_in_date', 'check_out_date')
  if (nights > MAX_STAY_NIGHTS) fail(422, 'INVALID_DATE', `A stay is at most ${MAX_STAY_NIGHTS} nights`, 'check_out_date')
  const arrival = optionalText(input.arrival_time, 'arrival_time', 5)
  if (arrival !== null && !TIME.test(arrival)) fail(422, 'INVALID_STAY_FIELD', 'arrival_time must be a 24-hour HH:MM time', 'arrival_time')
  const adults = count(input.adults, 'adults', 1)
  const children = count(input.children ?? 0, 'children', 0)
  const infants = count(input.infants ?? 0, 'infants', 0)
  if (adults + children > home.max_guests) fail(422, 'INVALID_STAY_FIELD', `This home sleeps at most ${home.max_guests} guests`, 'adults')
  const guestName = optionalText(input.guest_name, 'guest_name', 200)
  if (!guestName) fail(422, 'INVALID_STAY_FIELD', 'guest_name is required', 'guest_name')
  const email = optionalText(input.guest_email, 'guest_email', 254)
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(422, 'INVALID_STAY_FIELD', 'guest_email must be an email address', 'guest_email')
  return {
    check_in_date: checkIn, check_out_date: checkOut, arrival_time: arrival, adults, children, infants, guest_name: guestName,
    guest_surname: optionalText(input.guest_surname, 'guest_surname', 200), guest_email: email,
    guest_phone: optionalText(input.guest_phone, 'guest_phone', 40), total_minor: amount(input.total_minor, 'total_minor'),
    notes: optionalText(input.notes, 'notes', 2000),
  }
}

/**
 * Add a stay the host took themselves (phone, walk-in, repeat guest). It holds
 * its nights or is refused with STAY_OVERLAP; it never lands on a held night.
 * Closed nights, minimum nights and per-night stay rules are what the host
 * offers guests and channels; a stay the host enters is the host's own
 * decision, so those rules do not refuse it. Only another stay does.
 */
export async function createStay(db: DbClient, access: StayAccess, input: Record<string, unknown> & { product_id: string; idempotency_key: string }): Promise<StayDetail> {
  requireManager(access)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  const home = await readStayHome(db, access, input.product_id)
  const fields = stayFields(input, home)
  const replay = async () => {
    const existing = await queryFirst<{ id: string; product_id: string; check_in_date: string; check_out_date: string; guest_name: string; total_minor: number }>(db,
      'SELECT id, product_id, check_in_date, check_out_date, guest_name, total_minor FROM stays WHERE organization_id = ? AND idempotency_key = ?', [access.organizationId, key])
    if (!existing) return null
    if (existing.product_id !== home.product_id || existing.check_in_date !== fields.check_in_date || existing.check_out_date !== fields.check_out_date
      || existing.guest_name !== fields.guest_name || existing.total_minor !== fields.total_minor) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency_key was already used for a different stay', 'idempotency_key')
    return getStay(db, access, existing.id)
  }
  const earlier = await replay()
  if (earlier) return earlier
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await executeBatch(db, [
      {
        query: `INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, arrival_time, adults, children, infants,
                  guest_name, guest_surname, guest_email, guest_phone, total_minor, currency, notes, idempotency_key, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, ?, 'direct', 'app', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, access.organizationId, home.product_id, fields.check_in_date, fields.check_out_date, fields.arrival_time, fields.adults, fields.children, fields.infants,
          fields.guest_name, fields.guest_surname, fields.guest_email, fields.guest_phone, fields.total_minor, home.currency, fields.notes, key, now, now, access.actorId, access.actorId],
      },
      ...reconcileNightsQueries(access.organizationId, id),
      organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.created', entityType: 'stay', entityId: id }),
    ], { operation: 'Create stay' })
  } catch (error) {
    if (isNightConflict(error)) fail(409, 'STAY_OVERLAP', 'Another stay already holds one of these nights', 'check_in_date')
    if (/UNIQUE constraint failed: stays\.organization_id, stays\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
    throw error
  }
  return getStay(db, access, id)
}

async function requireAppStay(db: DbClient, access: StayAccess, stayId: string, expectedVersion: unknown): Promise<StayDetail> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (stay.owner !== 'app') fail(409, 'STAY_NOT_EDITABLE', 'This stay belongs to its channel; change it there')
  if (stay.status === 'cancelled') fail(409, 'STAY_NOT_EDITABLE', 'This stay is cancelled')
  if (expectedVersion !== stay.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  return stay
}

/** The version-guarded update leads its batch; whether it applied is read from its result. */
function versionChanged(results: unknown): boolean {
  return (results as Array<{ meta?: { changes?: number } }>)[0]?.meta?.changes === 1
}

export async function updateStay(db: DbClient, access: StayAccess, stayId: string, input: Record<string, unknown> & { expected_version: unknown }): Promise<StayDetail> {
  const current = await requireAppStay(db, access, stayId, input.expected_version)
  const home = await readStayHome(db, access, current.product_id)
  const fields = stayFields({ ...current, ...input }, home)
  const next = current.version + 1
  const now = new Date().toISOString()
  let results: unknown
  try {
    results = await executeBatch(db, [
      {
        query: `UPDATE stays SET check_in_date = ?, check_out_date = ?, arrival_time = ?, adults = ?, children = ?, infants = ?, guest_name = ?, guest_surname = ?,
                  guest_email = ?, guest_phone = ?, total_minor = ?, notes = ?, version = ?, updated_at = ?, updated_by = ?
                WHERE organization_id = ? AND id = ? AND version = ? AND owner = 'app' AND status <> 'cancelled'`,
        params: [fields.check_in_date, fields.check_out_date, fields.arrival_time, fields.adults, fields.children, fields.infants, fields.guest_name, fields.guest_surname,
          fields.guest_email, fields.guest_phone, fields.total_minor, fields.notes, next, now, access.actorId, access.organizationId, stayId, current.version],
      },
      organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.updated', entityType: 'stay', entityId: stayId, onlyIfPreviousChangedOneRow: true }),
      ...reconcileNightsQueries(access.organizationId, stayId),
    ], { operation: 'Update stay' })
  } catch (error) {
    if (isNightConflict(error)) fail(409, 'STAY_OVERLAP', 'Another stay already holds one of these nights', 'check_in_date')
    throw error
  }
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  return getStay(db, access, stayId)
}

export async function cancelStay(db: DbClient, access: StayAccess, stayId: string, input: { expected_version: unknown; reason?: unknown }): Promise<StayDetail> {
  const current = await requireAppStay(db, access, stayId, input.expected_version)
  const reason = optionalText(input.reason, 'reason', 500)
  const next = current.version + 1
  const now = new Date().toISOString()
  const results = await executeBatch(db, [
    {
      query: `UPDATE stays SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, version = ?, updated_at = ?, updated_by = ?
              WHERE organization_id = ? AND id = ? AND version = ? AND owner = 'app' AND status <> 'cancelled'`,
      params: [now, reason, next, now, access.actorId, access.organizationId, stayId, current.version],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: current.location_id, actorId: access.actorId, eventType: 'stay.cancelled', entityType: 'stay', entityId: stayId, onlyIfPreviousChangedOneRow: true }),
    ...reconcileNightsQueries(access.organizationId, stayId),
  ], { operation: 'Cancel stay' })
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  return getStay(db, access, stayId)
}

/** Record money the host received (or, negative, refunded) outside Stripe for a stay they took. */
export async function recordStayPayment(db: DbClient, access: StayAccess, stayId: string, input: Record<string, unknown>): Promise<StayDetail> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (stay.owner !== 'app') fail(409, 'STAY_NOT_EDITABLE', 'This stay is paid through its channel')
  const amountMinor = amount(input.amount_minor, 'amount_minor', true)
  if (amountMinor === 0) fail(422, 'INVALID_AMOUNT', 'amount_minor must not be zero', 'amount_minor')
  if (!STAY_PAYMENT_METHODS.includes(input.method as StayPaymentMethod)) fail(422, 'INVALID_STAY_FIELD', `method must be one of ${STAY_PAYMENT_METHODS.join(', ')}`, 'method')
  const paidOn = date(input.paid_on, 'paid_on')
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  // A retry of a payment that was recorded returns the stay as it is; the same key for a different payment is refused.
  const replay = async () => {
    const existing = await queryFirst<{ stay_id: string; amount_minor: number; method: string; paid_on: string }>(db,
      'SELECT stay_id, amount_minor, method, paid_on FROM stay_payments WHERE organization_id = ? AND idempotency_key = ?', [access.organizationId, key])
    if (!existing) return null
    if (existing.stay_id !== stayId || existing.amount_minor !== amountMinor || existing.method !== input.method || existing.paid_on !== paidOn) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency_key was already used for a different payment', 'idempotency_key')
    return getStay(db, access, stayId)
  }
  const earlier = await replay()
  if (earlier) return earlier
  const id = crypto.randomUUID()
  try {
    await executeBatch(db, [
      {
        query: `INSERT INTO stay_payments (id, organization_id, stay_id, amount_minor, currency, method, paid_on, reference, note, idempotency_key, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, access.organizationId, stayId, amountMinor, stay.currency, input.method, paidOn,
          optionalText(input.reference, 'reference', 200), optionalText(input.note, 'note', 1000), key, new Date().toISOString(), access.actorId],
      },
      organizationEventQuery({ organizationId: access.organizationId, locationId: stay.location_id, actorId: access.actorId, eventType: 'stay.payment_recorded', entityType: 'stay', entityId: stayId, metadata: { payment_id: id, amount_minor: amountMinor } }),
    ], { operation: 'Record stay payment' })
  } catch (error) {
    if (/UNIQUE constraint failed: stay_payments\.organization_id, stay_payments\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
    throw error
  }
  return getStay(db, access, stayId)
}

export async function deleteStayPayment(db: DbClient, access: StayAccess, stayId: string, paymentId: string): Promise<StayDetail> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (!stay.payments.some(payment => payment.id === paymentId)) fail(404, 'PAYMENT_NOT_FOUND', 'That payment is not on this stay')
  await executeBatch(db, [
    { query: 'DELETE FROM stay_payments WHERE organization_id = ? AND stay_id = ? AND id = ?', params: [access.organizationId, stayId, paymentId] },
    organizationEventQuery({ organizationId: access.organizationId, locationId: stay.location_id, actorId: access.actorId, eventType: 'stay.payment_deleted', entityType: 'stay', entityId: stayId, metadata: { payment_id: paymentId }, onlyIfPreviousChangedOneRow: true }),
  ], { operation: 'Delete stay payment' })
  return getStay(db, access, stayId)
}

/**
 * Set the host's rules for a run of nights. A field left out keeps each
 * night's current value; `price_minor: null` returns a night to the base
 * price. `reset: true` removes every override in the range instead.
 */
export async function setStayNights(db: DbClient, access: StayAccess, input: Record<string, unknown> & { product_id: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Stay[] }> {
  requireManager(access)
  const { from, to } = range(input, MAX_CALENDAR_DAYS)
  const home = await readStayHome(db, access, input.product_id)
  const patch: Record<string, number | null> = {}
  if (input.closed !== undefined) { if (typeof input.closed !== 'boolean') fail(422, 'INVALID_STAY_FIELD', 'closed must be true or false', 'closed'); patch.closed = input.closed ? 1 : 0 }
  if (input.price_minor !== undefined) patch.price_minor = input.price_minor === null ? null : amount(input.price_minor, 'price_minor')
  for (const field of ['min_stay_arrival', 'min_stay_through', 'max_stay'] as const) {
    if (input[field] !== undefined) patch[field] = input[field] === null ? null : count(input[field], field, 1)
  }
  for (const field of ['closed_to_arrival', 'closed_to_departure'] as const) {
    if (input[field] !== undefined) { if (typeof input[field] !== 'boolean') fail(422, 'INVALID_STAY_FIELD', `${field} must be true or false`, field); patch[field] = input[field] ? 1 : 0 }
  }
  const reset = input.reset === true
  if (reset === (Object.keys(patch).length > 0)) fail(422, 'INVALID_STAY_FIELD', reset ? 'reset cannot be combined with night settings' : 'Name at least one night setting to change, or reset')
  const now = new Date().toISOString()
  const columns = Object.keys(patch)
  const nights = `WITH RECURSIVE night(d) AS (SELECT ? UNION ALL SELECT date(d, '+1 day') FROM night WHERE date(d, '+1 day') < ?)`
  await executeBatch(db, [
    reset
      ? { query: 'DELETE FROM product_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ?', params: [access.organizationId, home.product_id, from, to] }
      : {
          query: `${nights} INSERT INTO product_nights (organization_id, product_id, date, source, updated_at, updated_by, ${columns.join(', ')})
                  SELECT ?, ?, d, 'host', ?, ?, ${columns.map(() => '?').join(', ')} FROM night WHERE true
                  ON CONFLICT (product_id, date) DO UPDATE SET source = 'host', updated_at = excluded.updated_at, updated_by = excluded.updated_by,
                    ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
          params: [from, to, access.organizationId, home.product_id, now, access.actorId, ...columns.map(column => patch[column])],
        },
    organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.nights_changed', entityType: 'product', entityId: home.product_id, metadata: { from, to, reset, fields: columns.join(',') } }),
  ], { operation: 'Set stay nights' })
  return readStayCalendar(db, access, { productId: home.product_id, from, to })
}

/** One night of a channel's calendar as an import reads it. */
export interface ImportedNight {
  date: string
  available: boolean
  price_minor: number
  min_stay_arrival: number
  max_stay: number | null
  closed_to_arrival: boolean
  closed_to_departure: boolean
}

/**
 * A channel calendar copied onto a home: each night becomes an `import` row,
 * replacing any earlier import and never a night the host set themselves.
 * One statement, so the calendar lands whole or not at all.
 */
export async function importStayNights(db: DbClient, access: StayAccess, productId: string, nights: readonly ImportedNight[]): Promise<void> {
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  if (!nights.length) return
  for (const night of nights) date(night.date, 'date')
  const now = new Date().toISOString()
  await executeBatch(db, [
    {
      query: `INSERT INTO product_nights (organization_id, product_id, date, closed, price_minor, min_stay_arrival, max_stay, closed_to_arrival, closed_to_departure, source, updated_at, updated_by)
              SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.closed'), json_extract(value, '$.price_minor'), json_extract(value, '$.min_stay_arrival'),
                     json_extract(value, '$.max_stay'), json_extract(value, '$.closed_to_arrival'), json_extract(value, '$.closed_to_departure'), 'import', ?, ?
                FROM json_each(?) WHERE true
              ON CONFLICT (product_id, date) DO UPDATE SET closed = excluded.closed, price_minor = excluded.price_minor, min_stay_arrival = excluded.min_stay_arrival,
                max_stay = excluded.max_stay, closed_to_arrival = excluded.closed_to_arrival, closed_to_departure = excluded.closed_to_departure,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by
              WHERE product_nights.source = 'import'`,
      params: [access.organizationId, home.product_id, now, access.actorId, JSON.stringify(nights.map(night => ({
        date: night.date, closed: night.available ? 0 : 1, price_minor: night.price_minor, min_stay_arrival: night.min_stay_arrival,
        max_stay: night.max_stay, closed_to_arrival: night.closed_to_arrival ? 1 : 0, closed_to_departure: night.closed_to_departure ? 1 : 0,
      })))],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.nights_imported', entityType: 'product', entityId: home.product_id, metadata: { from: nights[0]!.date, to: nights.at(-1)!.date, nights: nights.length } }),
  ], { operation: 'Import stay nights' })
}

/** A channel's booking as its current state reads, ready to land as a stay. */
export interface ChannelBooking {
  provider: 'channex'
  external_booking_id: string
  channel_booking_id: string | null
  channel: (typeof STAY_CHANNELS)[number]
  revision_id: string
  provider_updated_at: string
  cancelled: boolean
  check_in_date: string
  check_out_date: string
  adults: number
  children: number
  infants: number
  guest_name: string | null
  guest_surname: string | null
  guest_email: string | null
  guest_phone: string | null
  total_minor: number
  currency: string
}

/**
 * Lands a channel booking on a home (conflict rule 1). A channel stay always
 * lands: if one of its nights is already held, it is stored overbooked and
 * holds no night, for the host to resolve. A delivery older than the stay
 * already stored changes nothing, so repeated and out-of-order deliveries are
 * harmless. Returns the stay as stored.
 */
export async function applyChannelBooking(db: DbClient, organizationId: string, productId: string, booking: ChannelBooking): Promise<Stay & { applied: boolean }> {
  date(booking.check_in_date, 'check_in_date')
  date(booking.check_out_date, 'check_out_date')
  if (booking.check_out_date <= booking.check_in_date) throw new Error(`Channel booking ${booking.external_booking_id} ends before it starts`)
  if (booking.adults < 1) throw new Error(`Channel booking ${booking.external_booking_id} has no adult guest`)
  if (!/^[A-Z]{3}$/.test(booking.currency)) throw new Error(`Channel booking ${booking.external_booking_id} has an invalid currency`)
  const existing = await queryFirst<{ id: string; provider_updated_at: string | null }>(db,
    'SELECT id, provider_updated_at FROM stays WHERE provider = ? AND external_booking_id = ?', [booking.provider, booking.external_booking_id])
  if (existing && existing.provider_updated_at !== null && existing.provider_updated_at >= booking.provider_updated_at) {
    return { ...(await storedStay(db, organizationId, existing.id)), applied: false }
  }
  const id = existing?.id ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const write = (overbooked: 0 | 1): BatchQuery[] => [{
    query: `INSERT INTO stays (id, organization_id, product_id, channel, owner, status, overbooked, check_in_date, check_out_date, adults, children, infants,
              guest_name, guest_surname, guest_email, guest_phone, total_minor, currency, provider, external_booking_id, channel_booking_id, revision_id,
              provider_updated_at, cancelled_at, created_at, updated_at, created_by, updated_by)
            VALUES (?, ?, ?, ?, 'channel', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (provider, external_booking_id) WHERE external_booking_id IS NOT NULL DO UPDATE SET
              product_id = excluded.product_id, channel = excluded.channel, status = excluded.status, overbooked = excluded.overbooked,
              check_in_date = excluded.check_in_date, check_out_date = excluded.check_out_date, adults = excluded.adults, children = excluded.children,
              infants = excluded.infants, guest_name = excluded.guest_name, guest_surname = excluded.guest_surname, guest_email = excluded.guest_email,
              guest_phone = excluded.guest_phone, total_minor = excluded.total_minor, currency = excluded.currency, channel_booking_id = excluded.channel_booking_id,
              revision_id = excluded.revision_id, provider_updated_at = excluded.provider_updated_at,
              cancelled_at = CASE WHEN excluded.status = 'cancelled' THEN COALESCE(stays.cancelled_at, excluded.cancelled_at) ELSE NULL END,
              version = stays.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by
            WHERE stays.organization_id = excluded.organization_id AND (stays.provider_updated_at IS NULL OR stays.provider_updated_at < excluded.provider_updated_at)`,
    params: [id, organizationId, productId, booking.channel, booking.cancelled ? 'cancelled' : 'confirmed', overbooked, booking.check_in_date, booking.check_out_date,
      booking.adults, booking.children, booking.infants, booking.guest_name, booking.guest_surname, booking.guest_email, booking.guest_phone,
      booking.total_minor, booking.currency, booking.provider, booking.external_booking_id, booking.channel_booking_id, booking.revision_id,
      booking.provider_updated_at, booking.cancelled ? now : null, now, now, 'channex', 'channex'],
  },
  ...reconcileNightsQueries(organizationId, id),
  organizationEventQuery({ organizationId, actorId: null, eventType: existing ? 'stay.updated' : 'stay.created', entityType: 'stay', entityId: id, metadata: { channel: booking.channel, overbooked: overbooked === 1 } }),
  ]
  try {
    await executeBatch(db, write(0), { operation: 'Apply channel booking' })
  } catch (error) {
    if (!isNightConflict(error)) throw error
    // Rule 1: another stay holds one of these nights. The channel stay still lands, flagged and holding none.
    await executeBatch(db, write(1), { operation: 'Apply overbooked channel booking' })
  }
  return { ...(await storedStay(db, organizationId, id)), applied: true }
}

async function storedStay(db: DbClient, organizationId: string, stayId: string): Promise<Stay> {
  const row = await queryFirst<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.id = ?`, [organizationId, stayId])
  if (!row) throw new Error(`Stay ${stayId} is not in organization ${organizationId}`)
  return mapStay(row)
}
