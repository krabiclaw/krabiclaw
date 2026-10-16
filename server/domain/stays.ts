import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedHomeSql, isOrganizationWideRole, organizationAdapter, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { createLocation, updateLocation } from '~/server/utils/location-management'
import { createProduct, getProduct, updateProduct } from '~/server/utils/product-management'
import type { Product, UpdateProductInput } from '~/server/types/products'
import type { CloudflareEnv } from '~/server/utils/auth'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { selectPrice, type Price, type PriceTaxBehavior } from '~/shared/prices'
import type { ChannexEnv } from '~/server/integrations/channex/client'
import { pushStayNights, requireChannelPush } from '~/server/integrations/channex/ari'
import type { ChannelPush } from '~/shared/channel-push'
import { isValidTimezone } from '~/utils/timezone'
import { stayThreadQueries } from '~/server/domain/requests'
import { publishGuestInboxThreadEvent, publishStayInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { planHomeMessages, planStayMessages } from '~/server/domain/scheduled-guest-messages'
import { arrangeProductPhotos, readProductPhotos, type MediaPlacementItem } from '~/server/utils/media-placement'
import { deleteMediaAsset, updateMediaAssetMetadata } from '~/server/utils/media-asset-manager'
import { sanitizeFilename, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, sniffMediaMimeType } from '~/server/utils/media-mime'
import { mediaStillUrl, MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'

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
type StayMutationEnv = ChannexEnv & GuestInboxPublicationEnv

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
  /** The guest conversation in the inbox; null until a named contact opens one. An existing conversation is retained. */
  request_id: string | null
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

/** The Stripe payment a guest made when booking the stay on the site. The payments row is its record; nothing is copied here. */
export interface StayOnlinePayment {
  payment_id: string
  state: 'pending' | 'captured' | 'failed' | 'recovery' | 'refunded'
  currency: string
  amount_minor: number
  captured_minor: number
  refunded_minor: number
  receipt_url: string | null
  created_at: string
}

/**
 * A stay with what was collected for it: the Stripe payment a guest made on
 * the site, if any, and what the host recorded collecting outside Stripe.
 * paid_minor is both, net of refunds. Channel stays are paid through their channel.
 */
export interface StayDetail extends Stay {
  payments: StayPayment[]
  online_payment: StayOnlinePayment | null
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
  /** How tax relates to the base nightly price; null when the home has no base price. */
  base_price_tax_behavior: PriceTaxBehavior | null
  check_in_time: string
  check_out_time: string
  max_guests: number
  min_nights: number
  check_in_instructions: string | null
  /** The member (member.id) and the team who look after the home; assigned members see its stays. */
  assigned_member_id: string | null
  assigned_team_id: string | null
  /**
   * The channel this home is connected to, if any. null is a home kept only in
   * KrabiClaw: its night changes go nowhere else. A connected home pushes its
   * nights; one importing or disconnected does not.
   */
  channel: { provider: 'channex'; status: 'importing' | 'connected' | 'disconnected' } | null
  /**
   * The home's photos in order, the cover first: its product's own media
   * (the product image, then its gallery), the same pictures its pages show.
   */
  photos: StayPhoto[]
}

/** One of a home's photos. Its id is the media asset's id. */
export interface StayPhoto {
  id: string
  /** A video placed from the media library shows its poster frame as its url. */
  kind: 'image' | 'video'
  url: string
  width: number | null
  height: number | null
  alt_text: string | null
  position: number
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
  /** When a guest's checkout hold on this night lapses; null when no guest is paying for it. A held night is not available. */
  held_until: string | null
  /** What the connected channel last took for this night; null when the home has no channel or the night was never pushed. */
  channel: { state: 'pending' | 'pushed' | 'needs_review'; detail: string | null } | null
}

const MAX_LIST_DAYS = 400
const MAX_CALENDAR_DAYS = 500
const MAX_STAY_NIGHTS = 365
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function fail(statusCode: number, code: string, message: string, field?: string, detail: Record<string, unknown> = {}): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, ...(field ? { field } : {}), ...detail } })
}

function locationFailure(result: { status: number; data: unknown }): never {
  const data = result.data
  if (typeof data !== 'object' || data === null) fail(502, 'INVALID_LOCATION_RESPONSE', 'Location operation returned invalid error data', 'data')
  const error = 'error' in data ? data.error : undefined
  const code = 'code' in data ? data.code : undefined
  if (typeof error !== 'string' || !error.trim()) fail(502, 'INVALID_LOCATION_RESPONSE', 'Location operation did not return its error message', 'data.error')
  if (typeof code !== 'string' || !code.trim()) fail(502, 'INVALID_LOCATION_RESPONSE', 'Location operation did not return its error code', 'data.code')
  throw new HTTPError({ statusCode: result.status, statusMessage: error, data })
}

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(422, 'INVALID_DATE', `${field} must be a YYYY-MM-DD date`, field)
  return value
}

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)
}

/** Today's date where the home is. */
function homeToday(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
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
  s.provider, s.external_booking_id, s.channel_booking_id, s.request_id, s.cancelled_at, s.cancellation_reason, s.version, s.created_at, s.updated_at`

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
  return stayHomesWhere(db, access.organizationId, productId, visibleHomes(access))
}

async function stayHomesWhere(db: DbClient, organizationId: string, productId: string | null, scope: { sql: string; params: string[] }): Promise<StayHome[]> {
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT p.id AS product_id, p.name, c.location_id, l.timezone, o.default_currency, c.check_in_time, c.check_out_time, c.max_guests, c.min_nights, c.check_in_instructions,
           c.assigned_member_id, c.assigned_team_id, m.enabled AS channel_enabled, m.import_stage AS channel_stage
      FROM product_stay_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN product_channel_mappings m ON m.organization_id = c.organization_id AND m.product_id = c.product_id AND m.provider = 'channex'
     WHERE c.organization_id = ? ${productId ? 'AND c.product_id = ?' : ''} AND ${scope.sql}
     ORDER BY p.name, p.id`, [organizationId, ...(productId ? [productId] : []), ...scope.params])
  if (!rows.length) return []
  const prices = await queryAll<Price & { product_id: string }>(db, `
    SELECT pr.*, v.product_id FROM prices pr
      JOIN product_variants v ON v.organization_id = pr.organization_id AND v.id = pr.product_variant_id
      JOIN product_stay_configs c ON c.organization_id = v.organization_id AND c.product_id = v.product_id
     WHERE pr.organization_id = ? ${productId ? 'AND v.product_id = ?' : ''} AND v.active = 1
     ORDER BY v.sort_order, v.id`, [organizationId, ...(productId ? [productId] : [])])
  const photos = await readProductPhotos(db, { organizationId, productIds: rows.map(row => String(row.product_id)) })
  return rows.map((row) => {
    if (!isCurrencyCode(row.default_currency)) throw new Error(`Organization ${organizationId} has an unsupported default currency`)
    const own = prices.filter(price => price.product_id === row.product_id).map(price => ({ ...price, active: Number(price.active) === 1 }))
    const base = selectPrice(own, { currency: row.default_currency, location_id: String(row.location_id) })
    return {
      product_id: String(row.product_id), name: String(row.name), location_id: String(row.location_id), timezone: String(row.timezone),
      currency: row.default_currency, base_price_minor: base ? base.unit_amount : null, base_price_tax_behavior: base ? base.tax_behavior : null,
      check_in_time: String(row.check_in_time), check_out_time: String(row.check_out_time), max_guests: Number(row.max_guests), min_nights: Number(row.min_nights),
      check_in_instructions: row.check_in_instructions === null ? null : String(row.check_in_instructions),
      assigned_member_id: row.assigned_member_id === null ? null : String(row.assigned_member_id),
      assigned_team_id: row.assigned_team_id === null ? null : String(row.assigned_team_id),
      channel: row.channel_stage === null ? null : {
        provider: 'channex',
        status: Number(row.channel_enabled) === 1 ? 'connected' : row.channel_stage === 'reservations' || row.channel_stage === 'messages' || row.channel_stage === 'complete' ? 'disconnected' : 'importing',
      },
      photos: (photos.get(String(row.product_id)) ?? []).map(stayPhoto),
    }
  })
}

function stayPhoto(item: MediaPlacementItem, position: number): StayPhoto {
  const url = mediaStillUrl(item)
  if ((item.kind !== 'image' && item.kind !== 'video') || !url) throw new Error(`Media asset ${item.asset_id} has no picture to show`)
  return { id: item.asset_id, kind: item.kind, url, width: item.width ?? null, height: item.height ?? null, alt_text: item.alt_text ?? null, position }
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

/** A home's details read from a request body; each problem names its field. */
function homeDetails(body: Record<string, unknown>) {
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
  const timezone = (required: boolean) => {
    const value = text('timezone', 64, required)
    if (value !== null && !isValidTimezone(value)) fail(422, 'INVALID_DETAIL', 'Choose a valid time zone', 'timezone')
    return value
  }
  const time = (key: 'check_in_time' | 'check_out_time', required: boolean) => {
    const value = text(key, 5, required)
    if (value !== null && !TIME.test(value)) fail(422, 'INVALID_DETAIL', `${key} must be a 24-hour HH:MM time`, key)
    return value
  }
  return {
    text, timezone, time,
    name: (required: boolean) => text('name', 200, required),
    maxGuests: (required: boolean) => whole('max_guests', 1, 99, required),
    minNights: (required: boolean) => whole('min_nights', 1, 365, required),
    basePrice: () => whole('base_price_minor', 0, Number.MAX_SAFE_INTEGER, false),
  }
}

/** Read a new home's details from a request body; each problem names its field. */
export function stayHomeInput(body: Record<string, unknown>): NewStayHome {
  const { text, timezone, time, name, maxGuests, minNights, basePrice } = homeDetails(body)
  const home: NewStayHome = {
    name: name(true)!, timezone: timezone(true)!,
    address: text('address', 200, true)!, city: text('city', 100, true)!, state: text('state', 100, false),
    country: text('country', 2, true)!, zip_code: text('zip_code', 32, false),
    phone: text('phone', 32, false), email: text('email', 254, false),
    check_in_time: time('check_in_time', true)!, check_out_time: time('check_out_time', true)!,
    max_guests: maxGuests(true)!, min_nights: minNights(true)!,
    base_price_minor: basePrice(),
  }
  if (!/^[A-Z]{2}$/.test(home.country)) fail(422, 'INVALID_DETAIL', 'country must be a two-letter ISO country code', 'country')
  if (home.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(home.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email', 'email')
  return home
}

const EDITABLE_HOME_FIELDS = ['name', 'timezone', 'check_in_time', 'check_out_time', 'max_guests', 'min_nights', 'check_in_instructions', 'base_price_minor', 'assigned_member_id', 'assigned_team_id'] as const

/**
 * Change a home's details. Fields left out keep their value. Its time zone is
 * its location's, so it moves every home at that location. Who looks after it
 * is a member (member.id) or a team of this organization, or null. On a
 * connected home, a new base price or minimum stay is pushed for the nights
 * ahead, because nights without their own value use them.
 */
export async function updateStayHome(env: CloudflareEnv, db: DbClient, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<{ home: StayHome; channel_push: ChannelPush | null }> {
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  const unknown = Object.keys(body).find(key => !(EDITABLE_HOME_FIELDS as readonly string[]).includes(key))
  if (unknown) fail(422, 'INVALID_DETAIL', `${unknown} cannot be changed here`, unknown)
  if (!Object.keys(body).length) fail(422, 'INVALID_DETAIL', 'Name at least one detail to change')
  for (const key of ['name', 'timezone', 'check_in_time', 'check_out_time', 'max_guests', 'min_nights'] as const) {
    const value = body[key]
    if (key in body && (value === null || (typeof value === 'string' && !value.trim()))) fail(422, 'INVALID_DETAIL', `${key} cannot be empty`, key)
  }
  const { timezone, time, name, maxGuests, minNights, basePrice } = homeDetails(body)
  // Every field is checked before anything is written.
  const zone = timezone(false)
  const stay: NonNullable<UpdateProductInput['stay']> = {}
  const checkIn = time('check_in_time', false)
  if (checkIn !== null) stay.check_in_time = checkIn
  const checkOut = time('check_out_time', false)
  if (checkOut !== null) stay.check_out_time = checkOut
  const guests = maxGuests(false)
  if (guests !== null) stay.max_guests = guests
  const nights = minNights(false)
  if (nights !== null) stay.min_nights = nights
  if ('check_in_instructions' in body) {
    const instructions = body.check_in_instructions
    if (instructions !== null && (typeof instructions !== 'string' || !instructions.trim() || instructions.trim().length > 5000)) {
      fail(422, 'INVALID_DETAIL', 'check_in_instructions must contain 1 to 5000 characters, or null', 'check_in_instructions')
    }
  }
  for (const [key, table, column] of [['assigned_member_id', 'member', 'organizationId'], ['assigned_team_id', 'team', 'organizationId']] as const) {
    if (!(key in body)) continue
    const value = body[key]
    if (value !== null && (typeof value !== 'string' || !await queryFirst(db, `SELECT 1 FROM ${table} WHERE ${column} = ? AND id = ?`, [access.organizationId, value]))) {
      fail(422, 'INVALID_DETAIL', `${key} must be a ${table} of this organization, or null`, key)
    }
    stay[key] = value as string | null
  }
  const patch: UpdateProductInput = {}
  const renamed = name(false)
  if (renamed !== null) patch.name = renamed
  if (Object.keys(stay).length) patch.stay = stay
  const pricing = 'base_price_minor' in body
  if (pricing) {
    const price = basePrice()
    const product = await getProduct(db, access.organizationId, productId)
    if (product.variants.length !== 1) fail(409, 'HOME_HAS_OPTIONS', 'This home has several options; change their prices in the product editor', 'base_price_minor')
    const variant = product.variants[0]!
    const base = selectPrice(variant.prices, { currency: home.currency, location_id: home.location_id })
    if (price !== null) patch.variants = [{ id: variant.id, prices: [base ? { id: base.id, unit_amount: price } : { unit_amount: price }] }]
    else if (base) patch.variants = [{ id: variant.id, prices_mode: 'replace', prices: variant.prices.filter(other => other.id !== base.id).map(other => ({ id: other.id })) }]
  }
  const pushes = pricing || nights !== null
  // Clearing an already absent base price still asks for channel completion,
  // but creates no product pricing patch for updateProduct to preflight.
  if (pushes && patch.variants === undefined && patch.stay?.min_nights === undefined) await requireChannelPush(db, env, access.organizationId, productId)
  if (Object.keys(patch).length) await updateProduct(db, { organizationId: access.organizationId, productId, patch, actor: { actorId: access.actorId }, env, deferStayNightPush: true })
  // The product's checks are the ones a valid request can still fail, so it is written first.
  if (zone !== null && zone !== home.timezone) {
    const moved = await updateLocation(db as D1Database, access.organizationId, home.location_id, { timezone: zone }, access.actorId, env)
    if (moved.status !== 200) locationFailure(moved)
  }
  const instructionsAt = 'check_in_instructions' in body ? new Date().toISOString() : null
  if (instructionsAt !== null) {
    const results = await executeBatch(db, [{
      query: 'UPDATE product_stay_configs SET check_in_instructions = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ?',
      params: [body.check_in_instructions === null ? null : (body.check_in_instructions as string).trim(), instructionsAt, access.actorId, access.organizationId, productId],
    }, organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.instructions_updated', entityType: 'stay_home', entityId: productId, onlyIfPreviousChangedOneRow: true })], { operation: 'Update home check-in instructions' })
    if (results[0]?.meta.changes !== 1) fail(409, 'HOME_CHANGED', 'The home changed before its check-in instructions were saved; reload it', 'product_id')
  }
  const product = pushes ? await getProduct(db, access.organizationId, productId) : null
  const channelPush = product ? await pushStayHomeNights(db, env, access, product) : null
  const updated = await readStayHome(db, access, productId)
  if (zone !== null && zone !== home.timezone) await planHomeMessages(db, access.organizationId, home.location_id)
  if (product && channelPush !== null) {
    await publishStayInvalidation(env, { type: 'nights.changed', organizationId: access.organizationId, productId, locationId: updated.location_id, stayId: null }, { updated_at: product.updated_at })
  }
  if (instructionsAt !== null) {
    await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId, locationId: updated.location_id, stayId: null }, { updated_at: instructionsAt })
  }
  return { home: updated, channel_push: channelPush }
}

/**
 * The homes one member looks after, set at once. Each named home is assigned
 * to that member — a home has one assigned member, so another member's
 * assignment there is replaced — and the member's other homes are cleared.
 * Owners and admins already see every home and are never assigned one.
 */
export async function setMemberHomes(env: CloudflareEnv & GuestInboxPublicationEnv, db: DbClient, access: StayAccess, memberId: string, productIds: unknown): Promise<{ memberId: string; productIds: string[] }> {
  requireManager(access)
  const member = await (await organizationAdapter(env)).findMemberById(memberId)
  if (!member || member.organizationId !== access.organizationId) fail(404, 'MEMBER_NOT_FOUND', 'That person is not a member of this organization', 'memberId')
  if (isOrganizationWideRole(member.role)) fail(409, 'MEMBER_SEES_ALL_HOMES', 'Owners and admins already see every home', 'memberId')
  if (!Array.isArray(productIds) || productIds.some(id => typeof id !== 'string' || !id)) fail(422, 'INVALID_HOME_IDS', 'productIds must list homes of this organization', 'productIds')
  const selected = [...new Set(productIds as string[])]
  const homes = await queryAll<{ product_id: string; location_id: string; assigned_member_id: string | null }>(db, `
    SELECT product_id, location_id, assigned_member_id FROM product_stay_configs
     WHERE organization_id = ? AND (product_id IN (SELECT value FROM json_each(?)) OR assigned_member_id = ?)`, [access.organizationId, d1JsonStringSet(selected), memberId])
  const chosen = new Set(selected)
  if (homes.filter(home => chosen.has(home.product_id)).length !== selected.length) fail(422, 'INVALID_HOME_IDS', 'productIds must list homes of this organization', 'productIds')
  const changed = homes.filter(home => chosen.has(home.product_id) ? home.assigned_member_id !== memberId : home.assigned_member_id === memberId)
  const now = new Date().toISOString()
  if (changed.length) {
    await executeBatch(db, [{
      query: `UPDATE product_stay_configs SET assigned_member_id = ?, updated_at = ?, updated_by = ?
               WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) AND assigned_member_id IS NOT ?`,
      params: [memberId, now, access.actorId, access.organizationId, d1JsonStringSet(selected), memberId],
    }, {
      query: `UPDATE product_stay_configs SET assigned_member_id = NULL, updated_at = ?, updated_by = ?
               WHERE organization_id = ? AND assigned_member_id = ? AND product_id NOT IN (SELECT value FROM json_each(?))`,
      params: [now, access.actorId, access.organizationId, memberId, d1JsonStringSet(selected)],
    }, organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'stay.homes_assigned', entityType: 'member', entityId: memberId,
      metadata: { product_ids: selected.sort(), changed_product_ids: changed.map(home => home.product_id).sort() } })], { operation: 'Assign homes to a member' })
  }
  const assigned = await queryAll<{ product_id: string }>(db, 'SELECT product_id FROM product_stay_configs WHERE organization_id = ? AND assigned_member_id = ? ORDER BY product_id', [access.organizationId, memberId])
  // The member's Today and Calendar, and everyone else's open views of these homes, reload.
  for (const home of changed) {
    await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId: home.product_id, locationId: home.location_id, stayId: null }, { updated_at: now })
  }
  return { memberId, productIds: assigned.map(row => row.product_id) }
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
  if (located.status !== 201) locationFailure(located)
  const location = 'location' in located.data ? located.data.location : undefined
  if (!location || typeof location.id !== 'string' || !location.id.trim()) fail(502, 'INVALID_LOCATION_RESPONSE', 'Location creation did not return the location id', 'data.location.id')
  const locationId = location.id
  const product = await createProduct(db, {
    organizationId: access.organizationId, actor: { actorId: access.actorId }, idempotencyKey, env,
    // On the site unpublished, like a product added in the editor, so it can carry photos and a page.
    publication: { published: false },
    product: {
      kind: 'stay', name: home.name,
      ...(home.base_price_minor === null ? {} : { variants: [{ name: home.name, prices: [{ unit_amount: home.base_price_minor }] }] }),
      stay: { location_id: locationId, check_in_time: home.check_in_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, assigned_member_id: null, assigned_team_id: null },
    },
  })
  return await readStayHome(db, access, product.id)
}

/**
 * A home's photos are its product's media, so its pages and booking site
 * show the same pictures. Only managers change them; each change is checked
 * against the photos the caller's change was based on, and returns the home.
 */
async function arrangeHomePhotos(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, home: StayHome, to: string[]): Promise<StayHome> {
  await arrangeProductPhotos(db, { organizationId: access.organizationId, env, principal, productId: home.product_id, from: home.photos.map(photo => photo.id), to })
  const updated = await readStayHome(db, access, home.product_id)
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId: home.product_id, locationId: home.location_id, stayId: null }, { updated_at: new Date().toISOString() })
  return updated
}

async function managedHome(db: DbClient, access: StayAccess, productId: string): Promise<StayHome> {
  requireManager(access)
  return await readStayHome(db, access, productId)
}

function homePhoto(home: StayHome, photoId: string): StayPhoto {
  const photo = home.photos.find(entry => entry.id === photoId)
  if (!photo) fail(404, 'PHOTO_NOT_FOUND', 'That photo is not one of this home\'s photos', 'photo_id')
  return photo
}

/** Add a photo after the home's others; the first photo a home gets is its cover. The file is kept in the organization's media library. */
export async function addStayHomePhoto(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, productId: string, file: unknown): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  if (!(file instanceof File)) fail(422, 'PHOTO_REQUIRED', 'Send the photo as the multipart field image', 'image')
  if (file.size > MAX_IMAGE_BYTES) fail(413, 'PHOTO_TOO_LARGE', `A photo can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, 'image')
  if (home.photos.length >= MAX_ORDERED_MEDIA_ASSETS) fail(422, 'PHOTO_LIMIT', `A home holds at most ${MAX_ORDERED_MEDIA_ASSETS} photos`, 'image')
  const buffer = new Uint8Array(await file.arrayBuffer())
  if (!buffer.byteLength) fail(422, 'PHOTO_REQUIRED', 'The photo is empty', 'image')
  const contentType = sniffMediaMimeType(buffer)
  if (!RESOLVED_MEDIA_IMAGE_TYPES.has(contentType)) fail(415, 'UNSUPPORTED_PHOTO_TYPE', 'A photo must be a JPEG, PNG, WebP, GIF, AVIF or SVG image', 'image')
  const uploaded = await uploadResolvedMediaToAssetStore({
    db, env, organizationId: access.organizationId, userId: access.actorId, source: 'uploaded', kind: 'image',
    buffer, contentType, filename: sanitizeFilename(file.name),
    fileSize: buffer.byteLength,
  })
  try {
    return await arrangeHomePhotos(db, env, access, principal, home, [...home.photos.map(photo => photo.id), uploaded.assetId])
  } catch (error) {
    // Nobody else knows the new asset: unless the arrangement placed it before
    // failing, it is deleted rather than left in the library unseen.
    const placed = (await readProductPhotos(db, { organizationId: access.organizationId, productIds: [home.product_id] })).get(home.product_id)?.some(item => item.asset_id === uploaded.assetId)
    if (!placed) {
      try {
        await deleteMediaAsset(db, env, uploaded.assetId, access.organizationId, access.actorId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `The photo was not added and its upload ${uploaded.assetId} could not be deleted`, { cause: cleanupError })
      }
    }
    throw error
  }
}

/**
 * Put the home's photos in this order; the first is the cover. The order is
 * the whole list, so it must name every photo the home has, once: a photo
 * added or removed since the caller read them refuses it.
 */
export async function reorderStayHomePhotos(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, productId: string, body: Record<string, unknown>): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  const unknown = Object.keys(body).find(key => key !== 'photo_ids')
  if (unknown) fail(422, 'INVALID_PHOTO_ORDER', `${unknown} cannot be changed here`, unknown)
  const ids = body.photo_ids
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    fail(422, 'INVALID_PHOTO_ORDER', 'photo_ids must list photo ids, each once', 'photo_ids')
  }
  const order = ids as string[]
  if (order.length !== home.photos.length || order.some(id => !home.photos.some(photo => photo.id === id))) {
    fail(409, 'PHOTOS_CHANGED', 'photo_ids must name every photo the home has; reload them and try again', 'photo_ids')
  }
  return await arrangeHomePhotos(db, env, access, principal, home, order)
}

/** Describe a photo for guests and search engines. The text is the media asset's own, so every page showing the photo uses it. */
export async function updateStayHomePhoto(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, productId: string, photoId: string, body: Record<string, unknown>): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  homePhoto(home, photoId)
  const unknown = Object.keys(body).find(key => key !== 'alt_text')
  if (unknown) fail(422, 'INVALID_PHOTO_FIELD', `${unknown} cannot be changed here`, unknown)
  if (!('alt_text' in body)) fail(422, 'INVALID_PHOTO_FIELD', 'alt_text is required', 'alt_text')
  const alt = body.alt_text
  if (alt !== null && (typeof alt !== 'string' || !alt.trim() || alt.trim().length > 500)) {
    fail(422, 'INVALID_PHOTO_FIELD', 'alt_text must contain 1 to 500 characters, or null', 'alt_text')
  }
  const placedOn = { owner_type: 'product', owner_id: productId, slots: ['image', 'gallery'] }
  if (!await updateMediaAssetMetadata(db, photoId, access.organizationId, { alt_text: alt === null ? null : (alt as string).trim() }, placedOn)) {
    fail(409, 'PHOTOS_CHANGED', 'The photo was taken off the home before its description was saved; reload the photos', 'photo_id')
  }
  const updated = await readStayHome(db, access, productId)
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId, locationId: home.location_id, stayId: null }, { updated_at: new Date().toISOString() })
  return updated
}

/** Take a photo off the home. The file stays in the organization's media library; when the cover goes, the next photo becomes the cover. */
export async function removeStayHomePhoto(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, productId: string, photoId: string): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  homePhoto(home, photoId)
  return await arrangeHomePhotos(db, env, access, principal, home, home.photos.map(photo => photo.id).filter(id => id !== photoId))
}

/** Stays overlapping [from, to), newest check-in last. Cancelled stays are included only when asked for. */
export async function listStays(db: DbClient, access: StayAccess, input: { from: unknown; to: unknown; productId?: string; includeCancelled?: boolean }): Promise<Stay[]> {
  const { from, to } = range(input, MAX_LIST_DAYS)
  return staysOverlapping(db, access, { from, to, productId: input.productId, includeCancelled: input.includeCancelled })
}

/** Stays overlapping a range its caller has already checked. */
async function staysOverlapping(db: DbClient, access: StayAccess, input: { from: string; to: string; productId?: string; includeCancelled?: boolean }): Promise<Stay[]> {
  const { from, to } = input
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
  const [payments, online] = await Promise.all([
    queryAll<StayPayment>(db, `
      SELECT id, stay_id, amount_minor, currency, method, paid_on, reference, note, created_at, created_by
        FROM stay_payments WHERE organization_id = ? AND stay_id = ? ORDER BY paid_on, created_at`, [access.organizationId, stayId]),
    queryAll<{ id: string; state: StayOnlinePayment['state']; currency: string; amount: number; captured_amount: number; refunded_amount: number; receipt_url: string | null; created_at: string }>(db, `
      SELECT id, state, currency, amount, captured_amount, refunded_amount, receipt_url, created_at
        FROM payments WHERE organization_id = ? AND subject_type = 'stay' AND subject_id = ?`, [access.organizationId, stayId]),
  ])
  if (online.length > 1) fail(500, 'STAY_PAYMENT_AMBIGUOUS', 'This stay has more than one online payment', 'online_payment')
  const onlinePayment: StayOnlinePayment | null = online[0] ? {
    payment_id: online[0].id, state: online[0].state, currency: online[0].currency, amount_minor: online[0].amount,
    captured_minor: online[0].captured_amount, refunded_minor: online[0].refunded_amount, receipt_url: online[0].receipt_url, created_at: online[0].created_at,
  } : null
  const paid = payments.reduce((sum, payment) => sum + payment.amount_minor, 0) + (onlinePayment ? onlinePayment.captured_minor - onlinePayment.refunded_minor : 0)
  const status = stay.owner === 'channel' ? null
    : paid === 0 ? 'unpaid' : paid < stay.total_minor ? 'partial' : paid === stay.total_minor ? 'paid' : 'overpaid'
  return { ...stay, payments, online_payment: onlinePayment, paid_minor: paid, payment_status: status }
}

/** Every night of [from, to) at one home: whether it is free, its price and rules, and the stay holding it. */
export async function readStayCalendar(db: DbClient, access: StayAccess, input: { productId: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Stay[] }> {
  const { from, to } = range(input, MAX_CALENDAR_DAYS)
  const home = await readStayHome(db, access, input.productId)
  const [nights, stays] = await Promise.all([homeNights(db, access.organizationId, home, from, to), staysOverlapping(db, access, { from, to, productId: input.productId })])
  return { home, nights, stays }
}

/** A hold's claim counts while its hold is active and unexpired; this selects the claims that no longer do. */
const LAPSED_HOLD_CLAIM_SQL = `stay_nights.hold_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h
  WHERE h.id = stay_nights.hold_id AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

/** Every night of [from, to) at one home, read for whoever already has the home. */
async function homeNights(db: DbClient, organizationId: string, home: StayHome, from: string, to: string): Promise<StayNight[]> {
  const [overrides, claims, pushes] = await Promise.all([
    queryAll<Record<string, unknown>>(db, 'SELECT * FROM product_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ?', [organizationId, home.product_id, from, to]),
    queryAll<{ date: string; stay_id: string | null; held_until: string | null }>(db, `SELECT stay_nights.date, stay_nights.stay_id, h.expires_at AS held_until FROM stay_nights
      LEFT JOIN payment_checkout_holds h ON h.id = stay_nights.hold_id
      WHERE stay_nights.organization_id = ? AND stay_nights.product_id = ? AND stay_nights.date >= ? AND stay_nights.date < ? AND NOT (${LAPSED_HOLD_CLAIM_SQL})`, [organizationId, home.product_id, from, to]),
    queryAll<{ date: string; state: 'pending' | 'pushed' | 'needs_review'; detail: string | null }>(db, 'SELECT date, state, detail FROM channel_night_pushes WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ?', [organizationId, home.product_id, from, to]),
  ])
  const overrideByDate = new Map(overrides.map(row => [String(row.date), row]))
  const claimByDate = new Map(claims.map(row => [row.date, row]))
  const pushByDate = new Map(pushes.map(row => [row.date, { state: row.state, detail: row.detail }]))
  const nights: StayNight[] = []
  for (let offset = 0; offset < days(from, to); offset++) {
    const night = addDays(from, offset)
    const row = overrideByDate.get(night)
    const claim = claimByDate.get(night)
    const stayId = claim?.stay_id ?? null
    const heldUntil = claim && claim.stay_id === null ? claim.held_until : null
    const closed = Number(row?.closed ?? 0) === 1
    nights.push({
      date: night, available: !closed && !claim, stay_id: stayId, closed,
      price_minor: row?.price_minor === null || row?.price_minor === undefined ? home.base_price_minor : Number(row.price_minor),
      min_stay_arrival: row?.min_stay_arrival == null ? null : Number(row.min_stay_arrival),
      min_stay_through: row?.min_stay_through == null ? null : Number(row.min_stay_through),
      max_stay: row?.max_stay == null ? null : Number(row.max_stay),
      closed_to_arrival: Number(row?.closed_to_arrival ?? 0) === 1,
      closed_to_departure: Number(row?.closed_to_departure ?? 0) === 1,
      source: row ? row.source as 'host' | 'import' : null,
      held_until: heldUntil,
      channel: pushByDate.get(night) ?? null,
    })
  }
  return nights
}

/**
 * Tell the home's channel, if it has one, the current state of these nights.
 * The outcome is part of the write's result; a night the channel did not take
 * reads needs_review on the calendar.
 */
async function pushNights(db: DbClient, env: ChannexEnv, access: StayAccess, productId: string, ranges: ReadonlyArray<readonly [string, string]>): Promise<ChannelPush | null> {
  let outcome: ChannelPush | null = null
  for (const [from, to] of ranges) {
    const { home, nights } = await readStayCalendar(db, { organizationId: access.organizationId, actorId: access.actorId, manage: true }, { productId, from, to })
    const pushed = await pushStayNights(db, env, access.organizationId, home, nights)
    if (pushed && (!outcome || pushed.state === 'needs_review')) outcome = pushed
  }
  return outcome
}

/** A base price or minimum stay changes the same 500 future nights on every write surface. */
export async function pushStayHomeNights(db: DbClient, env: ChannexEnv, access: StayAccess, product: Pick<Product, 'id' | 'updated_at'>): Promise<ChannelPush | null> {
  const productId = product.id
  try {
    const home = await readStayHome(db, access, productId)
    if (home.channel?.status !== 'connected') return null
    const today = homeToday(home.timezone)
    const until = addDays(today, MAX_CALENDAR_DAYS)
    return await pushNights(db, env, access, productId, [[today, until]])
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The home was saved, but its channel update did not complete. Reload its calendar before retrying.',
      data: { code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, product_id: productId, updated_at: product.updated_at }, cause })
  }
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
    // A lapsed checkout hold on one of these nights no longer holds it.
    query: `DELETE FROM stay_nights WHERE ${LAPSED_HOLD_CLAIM_SQL} AND EXISTS (SELECT 1 FROM ${row} st
              WHERE stay_nights.product_id = st.product_id AND stay_nights.date >= st.check_in_date AND stay_nights.date < st.check_out_date)`,
    params: [organizationId, stayId],
  }, {
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

export function isStayNightConflict(error: unknown): boolean {
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
export async function createStay(db: DbClient, env: StayMutationEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; idempotency_key: string }): Promise<StayDetail & { channel_push: ChannelPush | null }> {
  requireManager(access)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  const home = await readStayHome(db, access, input.product_id)
  const fields = stayFields(input, home)
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  const replay = async () => {
    const existing = await queryFirst<{ id: string; product_id: string; check_in_date: string; check_out_date: string; guest_name: string; total_minor: number }>(db,
      'SELECT id, product_id, check_in_date, check_out_date, guest_name, total_minor FROM stays WHERE organization_id = ? AND idempotency_key = ?', [access.organizationId, key])
    if (!existing) return null
    if (existing.product_id !== home.product_id || existing.check_in_date !== fields.check_in_date || existing.check_out_date !== fields.check_out_date
      || existing.guest_name !== fields.guest_name || existing.total_minor !== fields.total_minor) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency_key was already used for a different stay', 'idempotency_key')
    return getStay(db, access, existing.id)
  }
  // A replay pushes again, so retrying a create whose push did not land repairs it.
  const pushed = async (stay: StayDetail) => {
    await planStayMessages(db, access.organizationId, stay.id)
    const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
    await publishStayChange(env, db, access.organizationId, stay, true)
    return { ...await getStay(db, access, stay.id), channel_push: channelPush }
  }
  const earlier = await replay()
  if (earlier) return pushed(earlier)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await executeBatch(db, [
      {
        query: `INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, arrival_time, adults, children, infants,
                  guest_name, guest_surname, guest_email, guest_phone, total_minor, currency, notes, idempotency_key, booking_received_at, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, ?, 'direct', 'app', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, access.organizationId, home.product_id, fields.check_in_date, fields.check_out_date, fields.arrival_time, fields.adults, fields.children, fields.infants,
          fields.guest_name, fields.guest_surname, fields.guest_email, fields.guest_phone, fields.total_minor, home.currency, fields.notes, key, now, now, now, access.actorId, access.actorId],
      },
      ...reconcileNightsQueries(access.organizationId, id),
      ...stayThreadQueries({ organizationId: access.organizationId, stayId: id, now, openedBy: { userId: access.actorId } }),
      organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.created', entityType: 'stay', entityId: id }),
    ], { operation: 'Create stay' })
  } catch (error) {
    if (isStayNightConflict(error)) fail(409, 'STAY_OVERLAP', 'Another stay already holds one of these nights', 'check_in_date')
    if (/UNIQUE constraint failed: stays\.organization_id, stays\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
      const concurrent = await replay()
      if (concurrent) return pushed(concurrent)
    }
    throw error
  }
  return pushed(await getStay(db, access, id))
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

export async function updateStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: Record<string, unknown> & { expected_version: unknown }): Promise<StayDetail & { channel_push: ChannelPush | null }> {
  const current = await requireAppStay(db, access, stayId, input.expected_version)
  const home = await readStayHome(db, access, current.product_id)
  const fields = stayFields({ ...current, ...input }, home)
  if (current.request_id !== null && fields.guest_email === null && fields.guest_phone === null) {
    throw new HTTPError({ statusCode: 422, statusMessage: 'An existing guest conversation requires a guest email or phone', data: { code: 'STAY_THREAD_CONTACT_REQUIRED', fields: ['guest_email', 'guest_phone'] } })
  }
  await requireChannelPush(db, env, access.organizationId, home.product_id)
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
      ...stayThreadQueries({ organizationId: access.organizationId, stayId, now, openedBy: { userId: access.actorId } }),
    ], { operation: 'Update stay' })
  } catch (error) {
    if (isStayNightConflict(error)) fail(409, 'STAY_OVERLAP', 'Another stay already holds one of these nights', 'check_in_date')
    throw error
  }
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  await planStayMessages(db, access.organizationId, stayId)
  const stay = await getStay(db, access, stayId)
  // The nights it released and the nights it now holds.
  const ranges = [[current.check_in_date, current.check_out_date], [stay.check_in_date, stay.check_out_date]] as const
  const changed = current.check_in_date === stay.check_in_date && current.check_out_date === stay.check_out_date ? [] : ranges
  const channelPush = await pushNights(db, env, access, stay.product_id, changed)
  await publishStayChange(env, db, access.organizationId, stay, changed.length > 0)
  return { ...await getStay(db, access, stayId), channel_push: channelPush }
}

export async function cancelStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: { expected_version: unknown; reason?: unknown }): Promise<StayDetail & { channel_push: ChannelPush | null }> {
  const current = await requireAppStay(db, access, stayId, input.expected_version)
  const reason = optionalText(input.reason, 'reason', 500)
  await requireChannelPush(db, env, access.organizationId, current.product_id)
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
  await planStayMessages(db, access.organizationId, stayId)
  const channelPush = await pushNights(db, env, access, current.product_id, [[current.check_in_date, current.check_out_date]])
  await publishStayChange(env, db, access.organizationId, await getStay(db, access, stayId), true)
  return { ...await getStay(db, access, stayId), channel_push: channelPush }
}

/** Record money the host received (or, negative, refunded) outside Stripe for a stay they took. */
export async function recordStayPayment(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, stayId: string, input: Record<string, unknown>): Promise<StayDetail> {
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
    await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, locationId: stay.location_id, productId: stay.product_id, stayId }, { version: stay.version })
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
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, locationId: stay.location_id, productId: stay.product_id, stayId }, { version: stay.version })
  return getStay(db, access, stayId)
}

export async function deleteStayPayment(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, stayId: string, paymentId: string): Promise<StayDetail> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (!stay.payments.some(payment => payment.id === paymentId)) fail(404, 'PAYMENT_NOT_FOUND', 'That payment is not on this stay')
  await executeBatch(db, [
    { query: 'DELETE FROM stay_payments WHERE organization_id = ? AND stay_id = ? AND id = ?', params: [access.organizationId, stayId, paymentId] },
    organizationEventQuery({ organizationId: access.organizationId, locationId: stay.location_id, actorId: access.actorId, eventType: 'stay.payment_deleted', entityType: 'stay', entityId: stayId, metadata: { payment_id: paymentId }, onlyIfPreviousChangedOneRow: true }),
  ], { operation: 'Delete stay payment' })
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, locationId: stay.location_id, productId: stay.product_id, stayId }, { version: stay.version })
  return getStay(db, access, stayId)
}

/**
 * Set the host's rules for a run of nights. A field left out keeps each
 * night's current value; `price_minor: null` returns a night to the base
 * price. `reset: true` removes every override in the range instead.
 */
export async function setStayNights(db: DbClient, env: StayMutationEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Stay[]; channel_push: ChannelPush | null }> {
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
  await requireChannelPush(db, env, access.organizationId, home.product_id)
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
  const channelPush = await pushNights(db, env, access, home.product_id, [[from, to]])
  await publishStayInvalidation(env, { type: 'nights.changed', organizationId: access.organizationId, locationId: home.location_id, productId: home.product_id, stayId: null }, { updated_at: now })
  return { ...await readStayCalendar(db, access, { productId: home.product_id, from, to }), channel_push: channelPush }
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
export async function importStayNights(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, productId: string, nights: readonly ImportedNight[]): Promise<void> {
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
  await publishStayInvalidation(env, { type: 'nights.changed', organizationId: access.organizationId, locationId: home.location_id, productId: home.product_id, stayId: null }, { updated_at: now })
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
export async function applyChannelBooking(db: DbClient, env: GuestInboxPublicationEnv, organizationId: string, productId: string, booking: ChannelBooking): Promise<Stay & { applied: boolean }> {
  date(booking.check_in_date, 'check_in_date')
  date(booking.check_out_date, 'check_out_date')
  if (booking.check_out_date <= booking.check_in_date) throw new Error(`Channel booking ${booking.external_booking_id} ends before it starts`)
  if (booking.adults < 1) throw new Error(`Channel booking ${booking.external_booking_id} has no adult guest`)
  if (!/^[A-Z]{3}$/.test(booking.currency)) throw new Error(`Channel booking ${booking.external_booking_id} has an invalid currency`)
  const currentChannelStay = () => queryFirst<{ id: string; provider_updated_at: string | null; revision_id: string | null }>(db,
    'SELECT id, provider_updated_at, revision_id FROM stays WHERE provider = ? AND external_booking_id = ?', [booking.provider, booking.external_booking_id])
  const existing = await currentChannelStay()
  const conversation = await queryFirst<{ organization_id: string; product_id: string; request_id: string }>(db,
    'SELECT organization_id, product_id, request_id FROM channel_threads WHERE provider = ? AND external_booking_id = ?', [booking.provider, booking.external_booking_id])
  if (conversation && (conversation.organization_id !== organizationId || conversation.product_id !== productId)) {
    throw new HTTPError({ statusCode: 409, message: 'The provider booking and conversation belong to different homes', data: { code: 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', field: 'external_booking_id' } })
  }
  if (conversation && existing && await queryFirst(db, 'SELECT id FROM stays WHERE id = ? AND request_id IS NOT NULL AND request_id <> ?', [existing.id, conversation.request_id])) {
    throw new HTTPError({ statusCode: 409, message: 'The inquiry and stay already have separate conversations; review both timelines', data: { code: 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', field: 'request_id' } })
  }
  const revisionKey = `channel-revision:${JSON.stringify([organizationId, booking.provider, booking.external_booking_id, booking.revision_id])}`
  const publish = async (stored: Stay, currentRevisionId: string | null) => {
    if (currentRevisionId === null) throw new HTTPError({ statusCode: 503, message: 'The saved channel stay has no current revision identity', data: { code: 'CHANNEL_REVISION_ID_REQUIRED', field: 'revision_id', committed: true, stay_id: stored.id, product_id: stored.product_id, version: stored.version } })
    const receipt = await queryFirst<Record<string, unknown>>(db, `SELECT
      json_extract(payload_json, '$.entityId') AS stay_id,
      json_extract(payload_json, '$.metadata.provider') AS provider,
      json_extract(payload_json, '$.metadata.external_booking_id') AS external_booking_id,
      json_extract(payload_json, '$.metadata.revision_id') AS revision_id,
      json_extract(payload_json, '$.metadata.provider_updated_at') AS provider_updated_at,
      json_extract(payload_json, '$.metadata.product_id') AS product_id,
      json_extract(payload_json, '$.metadata.location_id') AS location_id,
      json_extract(payload_json, '$.metadata.previous_product_id') AS previous_product_id,
      json_extract(payload_json, '$.metadata.previous_location_id') AS previous_location_id,
      json_type(payload_json, '$.metadata.previous_product_id') AS previous_product_type,
      json_type(payload_json, '$.metadata.previous_location_id') AS previous_location_type
      FROM activity_entries WHERE organization_id = ? AND kind = 'audit' AND dedupe_key = ?`, [organizationId, revisionKey])
    if (receipt) {
      const scope = (product: unknown, location: unknown) => typeof product === 'string' && Boolean(product) && typeof location === 'string' && Boolean(location)
      if (receipt.stay_id !== stored.id || receipt.provider !== booking.provider || receipt.external_booking_id !== booking.external_booking_id || receipt.revision_id !== booking.revision_id || receipt.provider_updated_at !== booking.provider_updated_at
        || !scope(receipt.product_id, receipt.location_id)
        || !((receipt.previous_product_id === null && receipt.previous_location_id === null && receipt.previous_product_type === 'null' && receipt.previous_location_type === 'null') || scope(receipt.previous_product_id, receipt.previous_location_id))) {
        throw new HTTPError({ statusCode: 500, message: 'The channel revision audit has invalid affected home identities', data: { code: 'CHANNEL_REVISION_AUDIT_INVALID', field: 'revision_id', revision_id: booking.revision_id, stay_id: stored.id } })
      }
      const published = new Set([stored.product_id])
      for (const [product, location] of [[receipt.previous_product_id, receipt.previous_location_id], [receipt.product_id, receipt.location_id]]) {
        if (typeof product !== 'string' || typeof location !== 'string' || published.has(product)) continue
        published.add(product)
        const affected = { organizationId, locationId: location, productId: product, stayId: stored.id }
        await publishStayInvalidation(env, { ...affected, type: 'stay.changed' }, { version: stored.version })
        await publishStayInvalidation(env, { ...affected, type: 'nights.changed' }, { version: stored.version })
      }
    } else if (currentRevisionId === booking.revision_id) {
      throw new HTTPError({ statusCode: 503, message: 'The saved channel revision has no audit identifying its affected homes', data: { code: 'CHANNEL_REVISION_AUDIT_REQUIRED', field: 'revision_id', committed: true, revision_id: booking.revision_id, stay_id: stored.id, product_id: stored.product_id, version: stored.version } })
    }
    await publishStayChange(env, db, organizationId, stored, true)
  }
  if (existing && existing.provider_updated_at !== null && existing.provider_updated_at >= booking.provider_updated_at) {
    await planStayMessages(db, organizationId, existing.id)
    const stored = await storedStay(db, organizationId, existing.id)
    await publish(stored, existing.revision_id)
    return { ...await storedStay(db, organizationId, existing.id), applied: false }
  }
  const id = existing?.id ?? crypto.randomUUID()
  const previous = existing ? await storedStay(db, organizationId, existing.id) : null
  const home = await queryFirst<{ location_id: string }>(db, 'SELECT location_id FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, productId])
  if (!home) fail(404, 'STAY_HOME_NOT_FOUND', 'The channel booking home was not found', 'product_id')
  const now = new Date().toISOString()
  const write = (overbooked: 0 | 1): BatchQuery[] => [{
    // The claims' composite FK names the stay's home. Release a real move's
    // old claims before changing that home, under the same upsert guard. The
    // entire batch rolls back if its new claims or any later write fails.
    query: `DELETE FROM stay_nights WHERE organization_id = ? AND stay_id = ? AND product_id <> ?
      AND EXISTS (SELECT 1 FROM stays st WHERE st.organization_id = ? AND st.id = ? AND st.product_id = ?
        AND (st.provider_updated_at IS NULL OR st.provider_updated_at < ?))`,
    params: [organizationId, id, productId, organizationId, existing?.id ?? null, previous?.product_id ?? null, booking.provider_updated_at],
  }, {
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
            WHERE stays.organization_id = excluded.organization_id AND stays.id = ? AND stays.product_id = ?
              AND (stays.provider_updated_at IS NULL OR stays.provider_updated_at < excluded.provider_updated_at)`,
    params: [id, organizationId, productId, booking.channel, booking.cancelled ? 'cancelled' : 'confirmed', overbooked, booking.check_in_date, booking.check_out_date,
      booking.adults, booking.children, booking.infants, booking.guest_name, booking.guest_surname, booking.guest_email, booking.guest_phone,
      booking.total_minor, booking.currency, booking.provider, booking.external_booking_id, booking.channel_booking_id, booking.revision_id,
      booking.provider_updated_at, booking.cancelled ? now : null, now, now, 'channex', 'channex', existing?.id ?? null, previous?.product_id ?? null],
  },
  organizationEventQuery({ organizationId, locationId: home.location_id, actorId: null, eventType: existing ? 'stay.updated' : 'stay.created', entityType: 'stay', entityId: id,
    dedupeKey: revisionKey, onlyIfPreviousChangedOneRow: true, metadata: { channel: booking.channel, overbooked: overbooked === 1,
      provider: booking.provider, external_booking_id: booking.external_booking_id, revision_id: booking.revision_id, provider_updated_at: booking.provider_updated_at,
      previous_product_id: previous?.product_id ?? null, previous_location_id: previous?.location_id ?? null, product_id: productId, location_id: home.location_id } }),
  ...reconcileNightsQueries(organizationId, id),
  {
    query: `UPDATE stays SET request_id = t.request_id FROM channel_threads t
      WHERE stays.id = ? AND stays.organization_id = ? AND stays.product_id = ?
        AND t.provider = stays.provider AND t.external_booking_id = stays.external_booking_id
        AND t.organization_id = stays.organization_id AND t.product_id = stays.product_id
        AND (stays.request_id IS NULL OR stays.request_id = t.request_id)`,
    params: [id, organizationId, productId],
  },
  ...stayThreadQueries({ organizationId, stayId: id, now, openedBy: 'channel' }),
  ]
  let writes: Awaited<ReturnType<typeof executeBatch>>
  try {
    writes = await executeBatch(db, write(0), { operation: 'Apply channel booking' })
  } catch (error) {
    if (!isStayNightConflict(error)) throw error
    // Rule 1: another stay holds one of these nights. The channel stay still lands, flagged and holding none.
    writes = await executeBatch(db, write(1), { operation: 'Apply overbooked channel booking' })
  }
  const changed = writes[1]?.meta.changes
  if (changed !== 0 && changed !== 1) fail(500, 'CHANNEL_REVISION_WRITE_RESULT_REQUIRED', 'The channel revision write did not report its affected row count', 'changes')
  const current = await currentChannelStay()
  if (!current) fail(500, 'CHANNEL_STAY_NOT_READABLE', 'The saved channel booking could not be read', 'external_booking_id')
  const stored = await storedStay(db, organizationId, current.id)
  if (changed === 0 && (current.provider_updated_at === null || current.provider_updated_at < booking.provider_updated_at)) {
    throw new HTTPError({ statusCode: 409, message: 'The channel booking home changed concurrently. Retry this revision from the feed.', data: { code: 'CHANNEL_REVISION_CONFLICT', field: 'revision_id', revision_id: booking.revision_id, stay_id: stored.id, version: stored.version } })
  }
  const linked = await queryFirst<{ request_id: string | null; mapped_request_id: string | null }>(db, `SELECT s.request_id, t.request_id AS mapped_request_id FROM stays s
    LEFT JOIN channel_threads t ON t.provider = s.provider AND t.external_booking_id = s.external_booking_id WHERE s.id = ?`, [stored.id])
  if (linked?.mapped_request_id && linked.request_id !== linked.mapped_request_id) {
    throw new HTTPError({ statusCode: 409, message: 'The stay conversation changed during association', data: { code: 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', field: 'request_id' } })
  }
  await planStayMessages(db, organizationId, stored.id)
  await publish(stored, current.revision_id)
  return { ...await storedStay(db, organizationId, stored.id), applied: changed === 1 }
}

async function publishStayChange(env: GuestInboxPublicationEnv, db: DbClient, organizationId: string, stay: Stay, nightsChanged: boolean): Promise<void> {
  const input = { organizationId, locationId: stay.location_id, productId: stay.product_id, stayId: stay.id }
  await publishStayInvalidation(env, { ...input, type: 'stay.changed' }, { version: stay.version })
  if (nightsChanged) await publishStayInvalidation(env, { ...input, type: 'nights.changed' }, { version: stay.version })
  if (stay.request_id !== null) {
    try {
      await publishGuestInboxThreadEvent(env, db, { threadId: stay.request_id, type: 'thread.changed' })
    } catch (cause) {
      throw new HTTPError({ statusCode: 503, message: 'The stay was saved, but its conversation update could not be published. Reload before retrying.',
        data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, stay_id: stay.id, product_id: stay.product_id, version: stay.version, request_id: stay.request_id }, cause })
    }
  }
}

async function storedStay(db: DbClient, organizationId: string, stayId: string): Promise<Stay> {
  const row = await queryFirst<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.id = ?`, [organizationId, stayId])
  if (!row) throw new Error(`Stay ${stayId} is not in organization ${organizationId}`)
  return mapStay(row)
}

/**
 * Booking on the site. A guest picks nights on a published home and pays in
 * full: the checkout holds those nights (stay_nights rows naming the hold) for
 * the hold's lifetime, and capture turns the hold into a confirmed direct stay.
 * The rules a guest is held to are the ones the home offers channels.
 */

/** A home a guest can book on the site: active, published on the site and at its active location. */
export async function readPublicStayHome(db: DbClient, organizationId: string, slug: string): Promise<StayHome> {
  const row = await queryFirst<{ id: string }>(db, `SELECT p.id FROM products p
      JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
     WHERE p.organization_id = ? AND p.slug = ? AND ${PUBLIC_STAY_SQL}`, [organizationId, slug])
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That place to stay is not open for booking', 'slug')
  const [home] = await stayHomesWhere(db, organizationId, row.id, { sql: '1 = 1', params: [] })
  if (!home) fail(404, 'STAY_NOT_FOUND', 'That place to stay is not open for booking', 'slug')
  return home
}

/** The published, active, located home `p` with stay settings `c`, as one predicate a write can repeat. */
const PUBLIC_STAY_SQL = `p.kind = 'stay' AND p.active = 1
  AND EXISTS (SELECT 1 FROM product_publications pub WHERE pub.organization_id = p.organization_id AND pub.product_id = p.id AND pub.published = 1)
  AND EXISTS (SELECT 1 FROM product_locations pl JOIN business_locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id AND l.status = 'active'
    WHERE pl.organization_id = c.organization_id AND pl.product_id = c.product_id AND pl.location_id = c.location_id AND pl.active = 1 AND pl.published = 1)`

/** One night as a guest sees it: whether it can be part of a stay, its price, and the home's rules for it. */
export interface PublicStayNight {
  date: string
  available: boolean
  price_minor: number | null
  min_stay_arrival: number
  min_stay_through: number | null
  max_stay: number | null
  closed_to_arrival: boolean
  closed_to_departure: boolean
}

export interface PublicStayCalendar {
  home: { currency: CurrencyCode; timezone: string; today: string; check_in_time: string; check_out_time: string; max_guests: number; min_nights: number; base_price_minor: number | null }
  nights: PublicStayNight[]
}

function publicNight(night: StayNight, home: StayHome, today: string): PublicStayNight {
  return {
    date: night.date,
    available: night.available && night.price_minor !== null && night.date >= today,
    price_minor: night.price_minor,
    min_stay_arrival: night.min_stay_arrival ?? home.min_nights,
    min_stay_through: night.min_stay_through,
    max_stay: night.max_stay,
    closed_to_arrival: night.closed_to_arrival,
    closed_to_departure: night.closed_to_departure,
  }
}

/** The nights of [from, to) a guest can choose from. Nothing about who holds a night is shown. */
export async function readPublicStayCalendar(db: DbClient, organizationId: string, slug: string, input: { from: unknown; to: unknown }): Promise<PublicStayCalendar> {
  const { from, to } = range(input, MAX_LIST_DAYS)
  const home = await readPublicStayHome(db, organizationId, slug)
  const today = homeToday(home.timezone)
  const nights = await homeNights(db, organizationId, home, from, to)
  return {
    home: { currency: home.currency, timezone: home.timezone, today, check_in_time: home.check_in_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, base_price_minor: home.base_price_minor },
    nights: nights.map(night => publicNight(night, home, today)),
  }
}

/** What a guest pays for a run of nights, checked against every rule the home offers. */
export interface StayQuote {
  product_id: string
  name: string
  location_id: string
  timezone: string
  currency: CurrencyCode
  tax_behavior: PriceTaxBehavior
  check_in_date: string
  check_out_date: string
  check_in_time: string
  check_out_time: string
  nights: number
  adults: number
  children: number
  infants: number
  nightly: Array<{ date: string; price_minor: number }>
  total_minor: number
}

export interface StayQuoteInput { check_in_date: unknown; check_out_date: unknown; adults: unknown; children?: unknown; infants?: unknown }

/**
 * Quote a stay at this home, or refuse it with the rule it breaks: the dates,
 * the guests, a night that is taken, closed or unpriced, closed to arrival or
 * departure, the minimum stay on arrival or through any night, or the
 * maximum stay. Every refusal names its code and the field it is about.
 */
export async function quoteStay(db: DbClient, organizationId: string, home: StayHome, input: StayQuoteInput): Promise<StayQuote> {
  const checkIn = date(input.check_in_date, 'check_in_date')
  const checkOut = date(input.check_out_date, 'check_out_date')
  const today = homeToday(home.timezone)
  if (checkIn < today) fail(422, 'STAY_CHECK_IN_PAST', 'Check-in cannot be before today where the home is', 'check_in_date', { today })
  const count_ = days(checkIn, checkOut)
  if (count_ < 1) fail(422, 'INVALID_DATE', 'check_out_date must be after check_in_date', 'check_out_date')
  if (count_ > MAX_STAY_NIGHTS) fail(422, 'STAY_TOO_LONG', `A stay is at most ${MAX_STAY_NIGHTS} nights`, 'check_out_date', { max_nights: MAX_STAY_NIGHTS })
  if (checkOut > addDays(today, MAX_CALENDAR_DAYS)) fail(422, 'STAY_TOO_FAR_AHEAD', `Stays can be booked up to ${MAX_CALENDAR_DAYS} days ahead`, 'check_out_date')
  const adults = count(input.adults, 'adults', 1)
  const children = count(input.children ?? 0, 'children', 0)
  const infants = count(input.infants ?? 0, 'infants', 0)
  if (adults + children > home.max_guests) fail(422, 'STAY_TOO_MANY_GUESTS', `This home sleeps at most ${home.max_guests} guests`, 'adults', { max_guests: home.max_guests })
  // The check-out day is read too: closed to departure is a rule of that day.
  const all = await homeNights(db, organizationId, home, checkIn, addDays(checkOut, 1))
  const stayed = all.slice(0, count_)
  const departure = all[count_]!
  const taken = stayed.filter(night => !night.available).map(night => night.date)
  if (taken.length) fail(409, 'STAY_NIGHTS_UNAVAILABLE', 'Some of these nights are no longer available', 'check_in_date', { dates: taken })
  const unpriced = stayed.find(night => night.price_minor === null)
  if (unpriced) fail(409, 'STAY_NIGHT_UNPRICED', `${unpriced.date} has no nightly price yet`, 'check_in_date', { date: unpriced.date })
  const arrival = stayed[0]!
  if (arrival.closed_to_arrival) fail(422, 'STAY_CLOSED_TO_ARRIVAL', `Guests cannot check in on ${checkIn}`, 'check_in_date')
  if (departure.closed_to_departure) fail(422, 'STAY_CLOSED_TO_DEPARTURE', `Guests cannot check out on ${checkOut}`, 'check_out_date')
  const minimum = arrival.min_stay_arrival ?? home.min_nights
  if (count_ < minimum) fail(422, 'STAY_MIN_NIGHTS', `Stays arriving on ${checkIn} are at least ${minimum} nights`, 'check_out_date', { min_nights: minimum })
  const through = stayed.reduce((most, night) => Math.max(most, night.min_stay_through ?? 1), 1)
  if (count_ < through) fail(422, 'STAY_MIN_NIGHTS_THROUGH', `Stays over these nights are at least ${through} nights`, 'check_out_date', { min_nights: through })
  if (arrival.max_stay !== null && count_ > arrival.max_stay) fail(422, 'STAY_MAX_NIGHTS', `Stays arriving on ${checkIn} are at most ${arrival.max_stay} nights`, 'check_out_date', { max_nights: arrival.max_stay })
  if (home.base_price_tax_behavior === null) fail(409, 'STAY_BASE_PRICE_REQUIRED', 'This home has no base nightly price', 'base_price_minor')
  const nightly = stayed.map(night => ({ date: night.date, price_minor: night.price_minor! }))
  const total = nightly.reduce((sum, night) => sum + night.price_minor, 0)
  if (!Number.isSafeInteger(total) || total < 1) fail(409, 'STAY_TOTAL_INVALID', 'These nights have no amount to pay', 'check_in_date')
  return {
    product_id: home.product_id, name: home.name, location_id: home.location_id, timezone: home.timezone, currency: home.currency, tax_behavior: home.base_price_tax_behavior,
    check_in_date: checkIn, check_out_date: checkOut, check_in_time: home.check_in_time, check_out_time: home.check_out_time,
    nights: count_, adults, children, infants, nightly, total_minor: total,
  }
}

/**
 * The nights a checkout hold claims, in the batch that inserts the hold. A
 * lapsed hold on one of them is cleared first; a night another stay or live
 * hold has fails the batch on stay_nights' primary key.
 */
export function stayHoldClaimQueries(input: { organizationId: string; productId: string; holdId: string; checkIn: string; checkOut: string }): BatchQuery[] {
  return [{
    query: `DELETE FROM stay_nights WHERE ${LAPSED_HOLD_CLAIM_SQL} AND stay_nights.product_id = ? AND stay_nights.date >= ? AND stay_nights.date < ?`,
    params: [input.productId, input.checkIn, input.checkOut],
  }, {
    query: `WITH RECURSIVE night(d) AS (SELECT ? UNION ALL SELECT date(d, '+1 day') FROM night WHERE date(d, '+1 day') < ?)
            INSERT INTO stay_nights (organization_id, product_id, date, hold_id)
            SELECT ?, ?, d, ? FROM night WHERE EXISTS (SELECT 1 FROM payment_checkout_holds WHERE id = ? AND status = 'active')`,
    params: [input.checkIn, input.checkOut, input.organizationId, input.productId, input.holdId, input.holdId],
  }]
}

/** The condition a stay hold is inserted under: the home is still bookable and none of its nights is closed. */
export function stayHoldPredicate(input: { organizationId: string; productId: string; checkIn: string; checkOut: string }): { query: string; params: string[] } {
  return {
    query: `EXISTS (SELECT 1 FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
              WHERE p.organization_id = ? AND p.id = ? AND ${PUBLIC_STAY_SQL})
            AND NOT EXISTS (SELECT 1 FROM product_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? AND closed = 1)`,
    params: [input.organizationId, input.productId, input.organizationId, input.productId, input.checkIn, input.checkOut],
  }
}

/** Tell the home's channel about nights a checkout hold took or gave back, and the calendar that they changed. */
export async function pushStayHoldNights(db: DbClient, env: StayMutationEnv, organizationId: string, productId: string, checkIn: string, checkOut: string): Promise<ChannelPush | null> {
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const home = await readStayHome(db, access, productId)
  const channelPush = await pushNights(db, env, access, productId, [[checkIn, checkOut]])
  await publishStayInvalidation(env, { type: 'nights.changed', organizationId, locationId: home.location_id, productId, stayId: null }, { updated_at: new Date().toISOString() })
  return channelPush
}

/**
 * Lapsed checkout holds still claiming nights: the nights are reopened on each
 * home's channel, then their claims are deleted. A night another write already
 * reclaimed was cleared by that write and is not here.
 */
export async function releaseLapsedStayHolds(db: DbClient, env: StayMutationEnv): Promise<{ released: number; channel_push: ChannelPush[] }> {
  const lapsed = await queryAll<{ hold_id: string; organization_id: string; product_id: string; check_in: string; check_out: string }>(db, `
    SELECT stay_nights.hold_id, stay_nights.organization_id, stay_nights.product_id, MIN(stay_nights.date) AS check_in, date(MAX(stay_nights.date), '+1 day') AS check_out
      FROM stay_nights WHERE ${LAPSED_HOLD_CLAIM_SQL}
     GROUP BY stay_nights.hold_id, stay_nights.organization_id, stay_nights.product_id LIMIT 100`)
  const pushes: ChannelPush[] = []
  for (const hold of lapsed) {
    // The calendar already reads a lapsed claim as free, so the channel is told first; the claims
    // go only once it has been, and a push that throws leaves them for the next run to retry.
    const pushed = await pushStayHoldNights(db, env, hold.organization_id, hold.product_id, hold.check_in, hold.check_out)
    if (pushed) pushes.push(pushed)
    await executeBatch(db, [{ query: `DELETE FROM stay_nights WHERE hold_id = ? AND ${LAPSED_HOLD_CLAIM_SQL}`, params: [hold.hold_id] }], { operation: 'Release lapsed stay hold' })
  }
  return { released: lapsed.length, channel_push: pushes }
}

/** What a captured checkout made a stay of: its frozen quote and the guest who paid. */
export interface CheckoutStay {
  quote: Pick<StayQuote, 'product_id' | 'check_in_date' | 'check_out_date' | 'adults' | 'children' | 'infants' | 'total_minor' | 'currency'>
  guest: { name: string; email: string; phone: string | null; notes: string | null }
}

/**
 * The batch that makes a captured stay hold a confirmed direct stay: the hold's
 * claims go, the stay takes the same nights (failing the batch on a night
 * someone else now holds), and its guest conversation opens.
 */
export function stayFromCheckoutQueries(input: { organizationId: string; locationId: string; stayId: string; holdId: string; paymentId: string; buyerUserId: string | null; now: string; stay: CheckoutStay }): BatchQuery[] {
  const { quote, guest } = input.stay
  return [
    { query: 'DELETE FROM stay_nights WHERE hold_id = ?', params: [input.holdId] },
    {
      query: `INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, adults, children, infants,
                guest_name, guest_email, guest_phone, user_id, total_minor, currency, notes, idempotency_key, booking_received_at, created_at, updated_at)
              SELECT ?, ?, ?, 'direct', 'app', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM payments WHERE id = ? AND organization_id = ? AND state = 'captured' AND refunded_amount = 0)`,
      params: [input.stayId, input.organizationId, quote.product_id, quote.check_in_date, quote.check_out_date, quote.adults, quote.children, quote.infants,
        guest.name, guest.email, guest.phone, input.buyerUserId, quote.total_minor, quote.currency, guest.notes, `checkout:${input.paymentId}`, input.now, input.now, input.now,
        input.paymentId, input.organizationId],
    },
    organizationEventQuery({ organizationId: input.organizationId, locationId: input.locationId, actorId: null, eventType: 'stay.created', entityType: 'stay', entityId: input.stayId, metadata: { channel: 'direct', payment_id: input.paymentId }, onlyIfPreviousChangedOneRow: true }),
    ...reconcileNightsQueries(input.organizationId, input.stayId),
    ...stayThreadQueries({ organizationId: input.organizationId, stayId: input.stayId, now: input.now, openedBy: 'guest' }),
  ]
}

/** After a stay is made from a checkout: its scheduled messages, its channel and the screens showing it. */
export async function completeStayFromCheckout(db: DbClient, env: StayMutationEnv, organizationId: string, stayId: string): Promise<{ stay: Stay; channel_push: ChannelPush | null }> {
  const stay = await storedStay(db, organizationId, stayId)
  await planStayMessages(db, organizationId, stayId)
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
  await publishStayChange(env, db, organizationId, stay, true)
  return { stay, channel_push: channelPush }
}

/** The stay a captured checkout made, read for its confirmation. */
export async function readCheckoutStay(db: DbClient, organizationId: string, stayId: string): Promise<Stay & { home: StayHome }> {
  const stay = await storedStay(db, organizationId, stayId)
  const [home] = await stayHomesWhere(db, organizationId, stay.product_id, { sql: '1 = 1', params: [] })
  if (!home) throw new Error(`Stay ${stayId} has no home`)
  return { ...stay, home }
}
