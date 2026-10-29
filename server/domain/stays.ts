import { HTTPError } from 'nitro'
import { MAX_STAY_NIGHTS, STAY_PAYMENT_METHODS, type StayChannel, type StayPaymentMethod } from '~/shared/bookings'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { d1JsonStringSet, execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedResponsibilitySql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { createLocation, updateLocation, type UpdateLocationInput } from '~/server/utils/location-management'
import { liveHomeSql } from '~/server/utils/billing'
import { parsePostalAddress, type PostalAddress } from '~/utils/postal-address'
import { calculateMapUrl, coordinatesFailure } from '~/utils/location-map'
import { visitRefundQueries } from '~/server/domain/payments/visit-refund'
import { bookedPolicyFor, LONG_TERM_STAY_NIGHTS, stayCancellationRefund, type StayBookedPolicy, type StayCancellationInput } from '~/shared/stay-cancellation'
import { executeRefund, requirePayment, type Payment } from '~/server/domain/payments'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import { isRecord } from '~/server/utils/type-guards'
import { isStayCheckInMethod, STAY_ARRIVAL_TEXT_LIMITS, STAY_CHECKOUT_DETAILS_LIMIT, type StayArrivalGuide } from '~/shared/stay-arrival'
import { isStayAmenity, parseStayAmenityAnswers, parseStayMapSharing, STAY_ALARM_DETAIL_KEYS, STAY_CANCELLATION_POLICIES, type StayAmenityAnswer, type StayMapSharing, STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS, type StayAmenity, type StayCancellationPolicy, type StayCheckInMethod, type StayCheckoutTask, type StayListingType, type StayLongTermCancellationPolicy, type StayPropertySizeUnit, type StayPropertyType, type StayPropertyTypeGroup } from '~/shared/stay-listing'
import { validateProductDetails, validateStayAlarmDetails, stayHouseRuleLines } from '~/shared/product-details'
import { staySafetyLines, stayAlarmLines } from '~/shared/stay-safety'
import { formatTime, isValidTimezone, localDateTimeToInstant } from '~/utils/timezone'
import { createProduct, getProduct, setProductPublication, updateProduct } from '~/server/utils/product-management'
import type { Product, UpdateProductInput } from '~/server/types/products'
import type { CloudflareEnv } from '~/server/utils/auth'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { selectPrice, type Price, type PriceTaxBehavior } from '~/shared/prices'
import type { ChannexEnv } from '~/server/integrations/channex/client'
import { completeChannelPush, deliverStayNights, pushAirbnbListingSettings, pushStayCalendar, pushStayNights, requireChannelPush, type AirbnbListingSettings, type ChannelPushCompletion, type ChannexMapping, type DeliveryLease } from '~/server/integrations/channex/ari'
import type { ChannelPush, SuccessfulChannelPush } from '~/shared/channel-push'
import { stayThreadQueries } from '~/server/domain/requests'
import { ownedBuyerRequest } from '~/server/domain/payments/buyer'
import { publishGuestInboxThreadEvent, publishStayInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { planHomeMessages, planStayMessages } from '~/server/domain/scheduled-guest-messages'
import { toE164 } from '~/utils/phone'
import { arrangeProductPhotos, readProductPhotos, readStayHomeAccessibility, readStayPhotoRooms, type MediaPlacementItem } from '~/server/utils/media-placement'
import { deleteMediaAsset, getMediaAsset, updateMediaAssetMetadata } from '~/server/utils/media-asset-manager'
import { sanitizeFilename, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, sniffMediaMimeType } from '~/server/utils/media-mime'
import { mediaStillUrl, MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'
import { isStayPhotoRoomType, isStaySleepingArrangements, MAX_STAY_BEDS_PER_TYPE, type StayPhotoRoom, type StayPhotoRoomType } from '~/shared/stay-photos'
import { isStayHomeAccessibility, isStayRoomAccessibility, type StayHomeAccessibility, type StayRoomAccessibility } from '~/shared/stay-accessibility'
import { publicResourceCacheInvalidationQuery, purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'

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

export const STAY_STATUSES = ['pending', 'confirmed', 'cancelled'] as const

export interface Stay {
  id: string
  product_id: string
  location_id: string
  /** The home's location timezone: its dates and times are read in it. */
  timezone: string
  channel: StayChannel
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
  /** The policy a guest booked under on the site; null for a stay not paid there. */
  cancellation_policy: StayBookedPolicy | null
  /** Staff recorded the guest did not arrive; their review invitation is never sent. */
  no_show_at: string | null
  version: number
  created_at: string
  updated_at: string
}

/**
 * A stay as a member responsible for its home sees it: the Turnovers view.
 * Dates, arrival, the guest's first name and party, and whether they never
 * arrived (no_show_at); nothing that reaches
 * the guest or their money. Owners and admins read the whole stay.
 */
export const STAY_TURNOVER_FIELDS = ['id', 'product_id', 'location_id', 'timezone', 'status', 'check_in_date', 'check_out_date', 'arrival_time', 'adults', 'children', 'infants', 'guest_name', 'no_show_at'] as const
export type StayTurnover = Pick<Stay, typeof STAY_TURNOVER_FIELDS[number]>

export function stayTurnover(stay: Stay): StayTurnover {
  return Object.fromEntries(STAY_TURNOVER_FIELDS.map(field => [field, stay[field]])) as StayTurnover
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
  /** The linked Better Auth account's current portrait; unlinked guests have none. */
  guest_image_url: string | null
  payments: StayPayment[]
  online_payment: StayOnlinePayment | null
  paid_minor: number
  payment_status: 'unpaid' | 'partial' | 'paid' | 'overpaid' | null
}

export interface StayHome {
  product_id: string
  /** The Product version used when saving listing accessibility. */
  product_updated_at: string
  name: string
  location_id: string
  timezone: string
  currency: CurrencyCode
  base_price_minor: number | null
  /** How tax relates to the base nightly price; null when the home has no base price. */
  base_price_tax_behavior: PriceTaxBehavior | null
  check_in_time: string
  /** The end of the check-in window, local HH:MM; null is a flexible end. Earlier than check_in_time is after midnight. */
  check_in_end_time: string | null
  check_out_time: string
  max_guests: number
  min_nights: number
  /** The product's description, the listing text guests read; empty when the host has written none. */
  description: string
  /** Whether the home is listed on the site: its product's publication there. */
  published: boolean
  /** Whether the home is live, so billed: active at its active location, and published or syncing with Airbnb. A home not live is a free draft. */
  live: boolean
  /** The home's location: its address and the pin its host placed, each null until set. */
  address: StayAddress | null
  latitude: number | null
  longitude: number | null
  stay_map_sharing: StayMapSharing
  property_type_group: StayPropertyTypeGroup | null
  property_type: StayPropertyType | null
  listing_type: StayListingType | null
  total_floors: number | null
  listing_floor: number | null
  year_built: number | null
  property_size: number | null
  property_size_unit: StayPropertySizeUnit | null
  bedrooms: number | null
  beds: number | null
  bathrooms: number | null
  amenities: StayAmenity[]
  amenity_answers: StayAmenityAnswer[]
  smoke_detector_details: string | null
  carbon_monoxide_detector_details: string | null
  cancellation_policy: StayCancellationPolicy | null
  long_term_cancellation_policy: StayLongTermCancellationPolicy | null
  /**
   * The arrival guide. Private: only managers and the home's assigned members
   * read it here; no public page or payload carries it.
   */
  check_in_method: StayCheckInMethod | null
  check_in_instructions: string | null
  wifi_network: string | null
  wifi_password: string | null
  directions: string | null
  house_manual: string | null
  checkout_instructions: StayCheckoutInstruction[]
  /** The member (member.id) and the team who look after the home; assigned members see its stays. */
  assigned_member_id: string | null
  assigned_team_id: string | null
  /**
   * The channel this home is connected to, if any. null is a home kept only in
   * KrabiClaw: its night changes go nowhere else. A connected home pushes its
   * nights; one importing (a draft not yet activated among them) or disconnected does not.
   */
  channel: { provider: 'channex'; status: 'importing' | 'connected' | 'disconnected' } | null
  /** The Airbnb listing the home was imported from, and that listing's editor on Airbnb; null for a home not imported from Airbnb. */
  airbnb_listing_id: string | null
  airbnb_editor_url: string | null
  /**
   * The home's photos in order, the cover first: its product's own media
   * (the product image, then its gallery), the same pictures its pages show.
   */
  photos: StayPhoto[]
  photo_rooms: StayPhotoRoom[]
  accessibility: StayHomeAccessibility[]
}

/** A home's address as a home is added with it: street, city, state, ISO country and postal code. */
export interface StayAddress {
  address: string
  city: string | null
  state: string | null
  country: string
  zip_code: string | null
}

function stayAddress(value: unknown): StayAddress | null {
  const postal = parsePostalAddress(value)
  return postal && { address: postal.addressLines.join(', '), city: postal.locality ?? null, state: postal.administrativeArea ?? null, country: postal.regionCode, zip_code: postal.postalCode ?? null }
}

/** The postal address a location stores for a home's address. */
function postalAddress(address: Omit<StayAddress, 'city'> & { city: string }): PostalAddress {
  return { regionCode: address.country, addressLines: [address.address], locality: address.city, ...(address.state ? { administrativeArea: address.state } : {}), ...(address.zip_code ? { postalCode: address.zip_code } : {}) }
}

/** One thing guests are asked to do before they leave, with the host's details for it. */
export interface StayCheckoutInstruction {
  task: StayCheckoutTask
  details: string | null
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
  /** The linked calendar (Vrbo) that shows this night taken; null when no linked calendar holds it. Such a night is not available. */
  calendar: StayCalendarChannel | null
  /** What the connected channel last took for this night; null when the home has no channel or the night was never pushed. */
  channel: { state: 'pending' | 'pushed' | 'needs_review'; detail: string | null } | null
}

const MAX_LIST_DAYS = 400
const MAX_CALENDAR_DAYS = 500
/** Every home's nights at once: three months, a window a multi-calendar pages through. */
const MAX_HOMES_CALENDAR_DAYS = 92
const MAX_CALENDAR_BYTES = 2_000_000
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
  s.provider, s.external_booking_id, s.channel_booking_id, s.request_id, s.cancelled_at, s.cancellation_reason, s.cancellation_policy, s.no_show_at, s.version, s.created_at, s.updated_at`

function mapStay(row: Record<string, unknown>): Stay {
  return { ...row, overbooked: Number(row.overbooked) === 1 } as unknown as Stay
}

/** The SQL that limits rows to homes this caller may see, and its parameters. */
function visibleHomes(access: StayAccess, alias = 'c'): { sql: string; params: string[] } {
  return access.manage ? { sql: '1 = 1', params: [] } : { sql: assignedResponsibilitySql(alias), params: [access.userId, access.userId] }
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
    SELECT p.id AS product_id, p.updated_at AS product_updated_at, p.name, p.description, p.details_json, c.location_id, l.timezone, l.address, l.latitude, l.longitude, l.stay_map_sharing, o.default_currency,
           c.check_in_time, c.check_in_end_time, c.check_out_time, c.max_guests, c.min_nights, c.property_type_group, c.property_type,
           c.listing_type, c.total_floors, c.listing_floor, c.year_built, c.property_size, c.property_size_unit, c.bedrooms, c.beds, c.bathrooms, c.amenities,
           c.cancellation_policy, c.long_term_cancellation_policy, c.check_in_method, c.check_in_instructions, c.wifi_network, c.wifi_password,
           c.directions, c.house_manual, c.checkout_instructions, c.assigned_member_id, c.assigned_team_id,
           COALESCE((SELECT pp.published FROM product_publications pp WHERE pp.organization_id = c.organization_id AND pp.product_id = c.product_id), 0) AS published,
           ${liveHomeSql('p')} AS live, m.enabled AS channel_enabled, m.import_stage AS channel_stage, m.listing_id AS airbnb_listing_id
      FROM product_stay_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN product_channel_mappings m ON m.organization_id = c.organization_id AND m.product_id = c.product_id AND m.provider = 'channex'
     WHERE c.organization_id = ? ${productId !== null ? 'AND c.product_id = ?' : ''} AND ${scope.sql}
     ORDER BY p.name, p.id`, [organizationId, ...(productId !== null ? [productId] : []), ...scope.params])
  if (!rows.length) return []
  const prices = await queryAll<Price & { product_id: string }>(db, `
    SELECT pr.*, v.product_id FROM prices pr
      JOIN product_variants v ON v.organization_id = pr.organization_id AND v.id = pr.product_variant_id
      JOIN product_stay_configs c ON c.organization_id = v.organization_id AND c.product_id = v.product_id
     WHERE pr.organization_id = ? ${productId ? 'AND v.product_id = ?' : ''} AND v.active = 1
     ORDER BY v.sort_order, v.id`, [organizationId, ...(productId ? [productId] : [])])
  const productIds = rows.map(row => String(row.product_id))
  const [photos, photoRooms, accessibility] = await Promise.all([
    readProductPhotos(db, { organizationId, productIds }),
    readStayPhotoRooms(db, organizationId, productIds),
    readStayHomeAccessibility(db, organizationId, productIds),
  ])
  return rows.map((row) => {
    const amenityAnswers = parseStayAmenityAnswers(JSON.parse(String(row.amenities)))
    const details = validateProductDetails('stay', JSON.parse(String(row.details_json)))
    validateStayAlarmDetails(details, amenityAnswers)
    if (!isCurrencyCode(row.default_currency)) throw new Error(`Organization ${organizationId} has an unsupported default currency`)
    const own = prices.filter(price => price.product_id === row.product_id).map(price => ({ ...price, active: Number(price.active) === 1 }))
    const base = selectPrice(own, { currency: row.default_currency, location_id: String(row.location_id) })
    return {
      product_id: String(row.product_id), product_updated_at: String(row.product_updated_at), name: String(row.name), location_id: String(row.location_id), timezone: String(row.timezone),
      currency: row.default_currency, base_price_minor: base ? base.unit_amount : null, base_price_tax_behavior: base ? base.tax_behavior : null,
      check_in_time: String(row.check_in_time), check_in_end_time: nullableText(row.check_in_end_time), check_out_time: String(row.check_out_time), max_guests: Number(row.max_guests), min_nights: Number(row.min_nights),
      description: String(row.description), published: Number(row.published) === 1, live: Number(row.live) === 1,
      address: stayAddress(row.address), latitude: nullableNumber(row.latitude), longitude: nullableNumber(row.longitude), stay_map_sharing: parseStayMapSharing(row.stay_map_sharing),
      property_type_group: nullableText(row.property_type_group) as StayPropertyTypeGroup | null,
      property_type: nullableText(row.property_type) as StayPropertyType | null,
      listing_type: nullableText(row.listing_type) as StayListingType | null,
      total_floors: nullableNumber(row.total_floors), listing_floor: nullableNumber(row.listing_floor), year_built: nullableNumber(row.year_built),
      property_size: nullableNumber(row.property_size), property_size_unit: nullableText(row.property_size_unit) as StayPropertySizeUnit | null,
      bedrooms: nullableNumber(row.bedrooms), beds: nullableNumber(row.beds), bathrooms: nullableNumber(row.bathrooms),
      amenities: amenityAnswers.filter(answer => answer.available).map(answer => answer.code), amenity_answers: amenityAnswers,
      smoke_detector_details: typeof details.smoke_detector_details === 'string' ? details.smoke_detector_details : null,
      carbon_monoxide_detector_details: typeof details.carbon_monoxide_detector_details === 'string' ? details.carbon_monoxide_detector_details : null,
      cancellation_policy: nullableText(row.cancellation_policy) as StayCancellationPolicy | null,
      long_term_cancellation_policy: nullableText(row.long_term_cancellation_policy) as StayLongTermCancellationPolicy | null,
      check_in_method: nullableText(row.check_in_method) as StayCheckInMethod | null,
      check_in_instructions: nullableText(row.check_in_instructions),
      wifi_network: nullableText(row.wifi_network), wifi_password: nullableText(row.wifi_password),
      directions: nullableText(row.directions), house_manual: nullableText(row.house_manual),
      checkout_instructions: JSON.parse(String(row.checkout_instructions)) as StayCheckoutInstruction[],
      assigned_member_id: row.assigned_member_id === null ? null : String(row.assigned_member_id),
      assigned_team_id: row.assigned_team_id === null ? null : String(row.assigned_team_id),
      channel: row.channel_stage === null ? null : {
        provider: 'channex',
        status: Number(row.channel_enabled) === 1 ? 'connected' : row.channel_stage === 'reservations' || row.channel_stage === 'messages' || row.channel_stage === 'complete' ? 'disconnected' : 'importing',
      },
      airbnb_listing_id: row.airbnb_listing_id === null ? null : String(row.airbnb_listing_id),
      airbnb_editor_url: row.airbnb_listing_id === null ? null : airbnbEditorUrl(String(row.airbnb_listing_id), 'details'),
      photos: (photos.get(String(row.product_id)) ?? []).map(stayPhoto),
      photo_rooms: photoRooms.get(String(row.product_id)) ?? [],
      accessibility: accessibility.get(String(row.product_id))!,
    }
  })
}

/** A page of an Airbnb listing's editor, as Airbnb's own editor addresses it (read 2026-10-23). */
function airbnbEditorUrl(listingId: string, page: string): string {
  return `https://www.airbnb.com/hosting/listings/editor/${encodeURIComponent(listingId)}/${page}`
}

/** The Airbnb listing fields Channex cannot write, each with the page of Airbnb's editor that holds it (read 2026-10-23). */
const AIRBNB_ONLY_FIELDS = {
  name: 'details/title', description: 'details/description', photos: 'details/photo-tour', amenities: 'details/amenities', max_guests: 'details/number-of-guests',
  check_in_method: 'arrival/check-in-method', wifi: 'arrival/wifi-details', directions: 'arrival/directions', house_manual: 'arrival/house-manual',
} as const
type AirbnbOnlyField = keyof typeof AIRBNB_ONLY_FIELDS
/** The Airbnb field each home field is part of. */
const AIRBNB_FIELD_OF: Record<string, AirbnbOnlyField> = {
  name: 'name', description: 'description', photos: 'photos', amenities: 'amenities', amenity_answers: 'amenities', max_guests: 'max_guests',
  check_in_method: 'check_in_method', check_in_instructions: 'check_in_method', wifi_network: 'wifi', wifi_password: 'wifi', directions: 'directions', house_manual: 'house_manual',
}

/**
 * The Airbnb fields a save changed on a home syncing with Airbnb that Airbnb
 * will not receive, each with its page in the listing's Airbnb editor, so the
 * host can make the same change there. Empty for a home not syncing, or a save
 * of fields Airbnb receives or has none of.
 */
export function airbnbUnsynced(home: StayHome, fields: readonly string[]): Array<{ field: AirbnbOnlyField; airbnb_url: string }> {
  if (home.channel?.status !== 'connected' || !home.airbnb_listing_id) return []
  const changed = [...new Set(fields.flatMap(field => AIRBNB_FIELD_OF[field] ? [AIRBNB_FIELD_OF[field]] : []))]
  return changed.map(field => ({ field, airbnb_url: airbnbEditorUrl(home.airbnb_listing_id!, AIRBNB_ONLY_FIELDS[field]) }))
}

function nullableText(value: unknown): string | null {
  return value === null ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value)
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
  /** Null is a flexible end. */
  check_in_end_time: string | null
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
  const time = (key: 'check_in_time' | 'check_in_end_time' | 'check_out_time', required: boolean) => {
    // A blank end is not a flexible one: only null clears it.
    if (key === 'check_in_end_time' && typeof body[key] === 'string' && !(body[key] as string).trim()) fail(422, 'INVALID_DETAIL', `${key} must be a 24-hour HH:MM time, or null for a flexible end`, key)
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
    ...homeAddress(body, ''),
    phone: text('phone', 32, false), email: text('email', 254, false),
    check_in_time: time('check_in_time', true)!, check_in_end_time: time('check_in_end_time', false), check_out_time: time('check_out_time', true)!,
    max_guests: maxGuests(true)!, min_nights: minNights(true)!,
    base_price_minor: basePrice(),
  }
  if (home.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(home.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email', 'email')
  return home
}

/** A home's address read from a request; each problem names its field under the prefix. */
function homeAddress(body: Record<string, unknown>, prefix: string): Pick<NewStayHome, 'address' | 'city' | 'state' | 'country' | 'zip_code'> {
  const { text } = homeDetails(body)
  const named = <T>(read: () => T): T => {
    try { return read() } catch (error) {
      if (prefix && error instanceof HTTPError && typeof (error.data as { field?: unknown })?.field === 'string') {
        const data = error.data as { code: string; field: string }
        fail(error.status, data.code, error.message, `${prefix}${data.field}`)
      }
      throw error
    }
  }
  const address = named(() => ({
    address: text('address', 200, true)!, city: text('city', 100, true)!, state: text('state', 100, false),
    country: text('country', 2, true)!, zip_code: text('zip_code', 32, false),
  }))
  if (!/^[A-Z]{2}$/.test(address.country)) fail(422, 'INVALID_DETAIL', 'country must be a two-letter ISO country code', `${prefix}country`)
  return address
}

/** What the home is and offers: product stay settings, checked by the product writer. */
const LISTING_FIELDS = ['property_type_group', 'property_type', 'listing_type', 'total_floors', 'listing_floor', 'year_built', 'property_size', 'property_size_unit', 'bedrooms', 'beds', 'bathrooms', 'amenities', 'amenity_answers', 'cancellation_policy', 'long_term_cancellation_policy'] as const
/** The arrival guide: private columns only this module reads and writes. */
const ARRIVAL_FIELDS = [...Object.keys(STAY_ARRIVAL_TEXT_LIMITS) as Array<keyof typeof STAY_ARRIVAL_TEXT_LIMITS>, 'check_in_method', 'checkout_instructions'] as const
const LOCATION_FIELDS = ['address', 'latitude', 'longitude', 'stay_map_sharing'] as const
const EDITABLE_HOME_FIELDS = ['name', 'description', 'published', 'timezone', 'check_in_time', 'check_in_end_time', 'check_out_time', 'max_guests', 'min_nights', 'base_price_minor',
  'assigned_member_id', 'assigned_team_id', ...LISTING_FIELDS, ...Object.values(STAY_ALARM_DETAIL_KEYS), ...ARRIVAL_FIELDS, ...LOCATION_FIELDS] as const

/** The arrival guide fields a request names, checked; each problem names its field. */
function arrivalPatch(body: Record<string, unknown>): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  for (const [key, max] of Object.entries(STAY_ARRIVAL_TEXT_LIMITS)) {
    if (!(key in body)) continue
    const value = body[key]
    // A wifi password is kept exactly as typed; spaces can be part of it.
    const text = typeof value === 'string' ? (key === 'wifi_password' ? value : value.trim()) : value
    if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > max)) fail(422, 'INVALID_DETAIL', `${key} must contain 1 to ${max} characters, or null`, key)
    patch[key] = text as string | null
  }
  if ('check_in_method' in body) {
    const method = body.check_in_method
    if (method !== null && !isStayCheckInMethod(method)) fail(422, 'INVALID_DETAIL', `check_in_method must be one of ${Object.keys(STAY_CHECK_IN_METHODS).join(', ')}, or null`, 'check_in_method')
    patch.check_in_method = method as string | null
  }
  if ('checkout_instructions' in body) {
    const list = body.checkout_instructions
    if (!Array.isArray(list)) fail(422, 'INVALID_DETAIL', 'checkout_instructions must list { task, details } entries', 'checkout_instructions')
    const tasks = new Set<string>()
    const instructions = list.map((entry: unknown, index): StayCheckoutInstruction => {
      const field = `checkout_instructions[${index}]`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(422, 'INVALID_DETAIL', `${field} must be { task, details }`, field)
      const { task, details, ...rest } = entry as Record<string, unknown>
      if (Object.keys(rest).length) fail(422, 'INVALID_DETAIL', `${field} takes only task and details`, `${field}.${Object.keys(rest)[0]}`)
      if (typeof task !== 'string' || !Object.hasOwn(STAY_CHECKOUT_TASKS, task)) fail(422, 'INVALID_DETAIL', `${field}.task must be one of ${Object.keys(STAY_CHECKOUT_TASKS).join(', ')}`, `${field}.task`)
      if (tasks.has(task)) fail(422, 'INVALID_DETAIL', `${field}.task is already listed`, `${field}.task`)
      tasks.add(task)
      const text = typeof details === 'string' ? details.trim() : details
      if (text !== null && (typeof text !== 'string' || !text || text.length > STAY_CHECKOUT_DETAILS_LIMIT)) fail(422, 'INVALID_DETAIL', `${field}.details must contain 1 to ${STAY_CHECKOUT_DETAILS_LIMIT} characters, or null`, `${field}.details`)
      if (task === 'additional' && text === null) fail(422, 'INVALID_DETAIL', 'Additional requests need their details', `${field}.details`)
      return { task: task as StayCheckoutTask, details: text as string | null }
    })
    patch.checkout_instructions = JSON.stringify(instructions)
  }
  return patch
}

/** The location fields a request names, as the location writer takes them. */
function locationPatch(body: Record<string, unknown>): UpdateLocationInput {
  const patch: UpdateLocationInput = {}
  if ('address' in body) {
    const value = body.address
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(422, 'INVALID_DETAIL', 'address must be { address, city, state, country, zip_code }', 'address')
    const unknown = Object.keys(value).find(key => !['address', 'city', 'state', 'country', 'zip_code'].includes(key))
    if (unknown) fail(422, 'INVALID_DETAIL', `address.${unknown} is not part of an address`, `address.${unknown}`)
    patch.address = postalAddress(homeAddress(value as Record<string, unknown>, 'address.'))
  }
  if ('latitude' in body) patch.latitude = body.latitude as number | null
  if ('longitude' in body) patch.longitude = body.longitude as number | null
  if ('stay_map_sharing' in body) {
    try { patch.stay_map_sharing = parseStayMapSharing(body.stay_map_sharing) } catch (error) { fail(422, 'INVALID_DETAIL', error instanceof Error ? error.message : 'Invalid location sharing', 'stay_map_sharing') }
  }
  const pin = coordinatesFailure(patch)
  if (pin) fail(422, 'INVALID_DETAIL', pin.error, pin.field)
  return patch
}

/**
 * Change a home's details. Fields left out keep their value. Its time zone is
 * its location's, so it moves every home at that location. Who looks after it
 * is a member (member.id) or a team of this organization, or null. On a
 * connected home, a new base price or minimum stay is pushed for the nights
 * ahead, because nights without their own value use them.
 */
export async function updateStayHome(env: CloudflareEnv, db: DbClient, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<{ home: StayHome; channel_push: SuccessfulChannelPush | null; airbnb_unsynced: ReturnType<typeof airbnbUnsynced> }> {
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
  // null is a real value here: the check-in window has a flexible end.
  if ('check_in_end_time' in body) stay.check_in_end_time = time('check_in_end_time', false)
  const checkOut = time('check_out_time', false)
  if (checkOut !== null) stay.check_out_time = checkOut
  const guests = maxGuests(false)
  if (guests !== null) stay.max_guests = guests
  const nights = minNights(false)
  if (nights !== null) stay.min_nights = nights
  const arrival = arrivalPatch(body)
  const location = locationPatch(body)
  if ('published' in body && typeof body.published !== 'boolean') fail(422, 'INVALID_DETAIL', 'published must be true or false', 'published')
  // Publication is refused until the home can take bookings; on its own, a refusal leaves nothing else half-saved.
  if ('published' in body && Object.keys(body).length > 1) fail(422, 'INVALID_DETAIL', 'Change published on its own', 'published')
  if ('description' in body && typeof body.description !== 'string') fail(422, 'INVALID_DETAIL', 'description must be text; send an empty one to clear it', 'description')
  for (const key of LISTING_FIELDS) if (key in body) (stay as Record<string, unknown>)[key] = body[key]
  for (const field of ['assigned_member_id', 'assigned_team_id'] as const) {
    if (body[field] !== undefined) stay[field] = body[field] as string | null
  }
  const alarmDetails = Object.fromEntries(Object.values(STAY_ALARM_DETAIL_KEYS).filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]))
  const patch: UpdateProductInput = Object.keys(alarmDetails).length
    ? { details_mode: 'merge', details: alarmDetails as NonNullable<UpdateProductInput['details']> }
    : {}
  const renamed = name(false)
  if (renamed !== null) patch.name = renamed
  if ('description' in body) patch.description = (body.description as string).trim()
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
  const pushes = pricing || (nights !== null && nights !== home.min_nights)
  // Clearing an already absent base price still asks for channel completion,
  // but creates no product pricing patch for updateProduct to preflight.
  if (pushes && patch.variants === undefined && patch.stay?.min_nights === undefined) await requireChannelPush(db, env, access.organizationId, productId)
  const saved = Object.keys(patch).length ? await updateProduct(db, { organizationId: access.organizationId, productId, patch, actor: { actorId: access.actorId }, env, deferStayNightPush: true }) : null
  const settings = saved ? touchesAirbnbSettings({ stay: saved.stay ?? undefined }, { stay: home }) : null
  // The product's checks are the ones a valid request can still fail, so it is written first.
  if ((zone !== null && zone !== home.timezone) || Object.keys(location).length) {
    const moved = await updateLocation(db as D1Database, access.organizationId, home.location_id, { ...location, ...(zone !== null && zone !== home.timezone ? { timezone: zone } : {}) }, access.actorId, env)
    if (moved.status !== 200) locationFailure(moved)
  }
  if ('published' in body && body.published !== home.published) {
    await setProductPublication(db, { organizationId: access.organizationId, productId, published: body.published as boolean, actor: { actorId: access.actorId }, env })
  }
  const columns = Object.keys(arrival)
  const instructionsAt = columns.length ? new Date().toISOString() : null
  if (instructionsAt !== null) {
    const results = await executeBatch(db, [{
      query: `UPDATE product_stay_configs SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ?`,
      params: [...columns.map(column => arrival[column]!), instructionsAt, access.actorId, access.organizationId, productId],
    }, organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.instructions_updated', entityType: 'stay_home', entityId: productId,
      metadata: { fields: columns.sort().join(',') }, onlyIfPreviousChangedOneRow: true })], { operation: 'Update home arrival guide' })
    if (results[0]?.meta.changes !== 1) fail(409, 'HOME_CHANGED', 'The home changed before its arrival guide was saved; reload it', 'product_id')
  }
  const product = pushes || settings !== null ? await getProduct(db, access.organizationId, productId) : null
  const channelPush = product ? await pushStayHomeChannel(db, env, access, product, { nights: pushes, settings }) : null
  return completeChannelPush(channelPush, { product_id: productId, ...(product ? { updated_at: product.updated_at } : {}) }, async () => {
    const updated = await readStayHome(db, access, productId)
    if (zone !== null && zone !== home.timezone) await planHomeMessages(db, access.organizationId, home.location_id)
    if (product && pushes && channelPush !== null) {
      await publishStayInvalidation(env, { type: 'nights.changed', organizationId: access.organizationId, productId, locationId: updated.location_id, stayId: null }, { updated_at: product.updated_at })
    }
    // A product or location change already announced itself; the arrival guide and the listing switch do here.
    if (instructionsAt !== null || 'published' in body) {
      await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId, locationId: updated.location_id, stayId: null }, { updated_at: instructionsAt ?? new Date().toISOString() })
    }
    return { home: updated, airbnb_unsynced: airbnbUnsynced(updated, Object.keys(body)) }
  })
}

/**
 * Add a place to stay: a new location of this organization and an unpublished
 * stay at it, priced per night in the organization's currency. A new home is a
 * draft, free on every plan: it is billed, and held to Basic's limit, only once
 * it goes live (published, or synced with Airbnb). Its location is a home's, not
 * a location. A home added by hand and one imported from a channel are made
 * here, the same way. The key replays every write.
 */
export async function createStayHome(env: Parameters<typeof createLocation>[0], db: DbClient, access: StayAccess, home: NewStayHome, idempotencyKey: string): Promise<StayHome> {
  requireManager(access)
  const located = await createLocation(env, db as D1Database, access.organizationId, {
    title: home.name, timezone: home.timezone, phone: home.phone, email: home.email,
    address: postalAddress(home),
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
      stay: { location_id: locationId, check_in_time: home.check_in_time, check_in_end_time: home.check_in_end_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, assigned_member_id: null, assigned_team_id: null },
    },
  })
  return await readStayHome(db, access, product.id)
}

/**
 * A home's photos are its product's media, so its pages and booking site
 * show the same pictures. Only managers change them; each change is checked
 * against the photos the caller's change was based on, and returns the home.
 */
async function arrangeHomePhotos(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, home: StayHome, to: string[], roomAssignment?: { assetId: string; roomId: string }): Promise<StayHome> {
  await arrangeProductPhotos(db, { organizationId: access.organizationId, env, principal, productId: home.product_id, from: home.photos.map(photo => photo.id), to, roomAssignment })
  await purgePublicResourceCacheNow(env, access.organizationId)
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

/** Add an uploaded File or an explicit { asset_id } from the organization's library after the home's current photos. */
export async function addStayHomePhoto(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, productId: string, input: unknown): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  if (!(input instanceof File) && isRecord(input)) {
    if (typeof input.asset_id !== 'string' || !input.asset_id.trim()) fail(422, 'PHOTO_REQUIRED', 'Choose the library photo by its asset_id', 'asset_id')
    const unknown = Object.keys(input).find(key => key !== 'asset_id' && key !== 'room_id')
    if (unknown) fail(422, 'INVALID_PHOTO_FIELD', `${unknown} cannot be changed here`, unknown)
    if ('room_id' in input && (typeof input.room_id !== 'string' || !input.room_id.trim())) fail(422, 'INVALID_PHOTO_ROOM', 'Choose a room by its room_id', 'room_id')
    const roomId = input.room_id as string | undefined
    if (roomId && !home.photo_rooms.some(room => room.id === roomId)) fail(404, 'PHOTO_ROOM_NOT_FOUND', 'That room is not on this home', 'room_id')
    const asset = await getMediaAsset(db, input.asset_id, access.organizationId)
    if (!asset || asset.status !== 'active') fail(404, 'PHOTO_NOT_FOUND', 'That photo is not in this organization\'s media library', 'asset_id')
    if (asset.kind !== 'image') fail(415, 'UNSUPPORTED_PHOTO_TYPE', 'Choose an image from the media library', 'asset_id')
    if (home.photos.some(photo => photo.id === asset.id)) fail(409, 'PHOTO_ALREADY_ADDED', 'That photo is already on this home', 'asset_id')
    // Read the home on the server for every append. The complete arrangement
    // guards against another write between this read and its atomic commit.
    // A library asset was not created here and is never removed on failure.
    return await arrangeHomePhotos(db, env, access, principal, home, [...home.photos.map(photo => photo.id), asset.id], roomId ? { assetId: asset.id, roomId } : undefined)
  }
  const file = input
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
  await purgePublicResourceCacheNow(env, access.organizationId)
  const updated = await readStayHome(db, access, productId)
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId, locationId: home.location_id, stayId: null }, { updated_at: new Date().toISOString() })
  return updated
}

/**
 * Put these library assets first, in this order, ahead of the home's other
 * photos; the first becomes the cover. A channel import places the photos it
 * stored this way: an asset already on the home moves, one not yet on it is
 * added, and the host's own photos follow. Each asset must be an active image
 * of this organization.
 */
export async function placeStayHomePhotosFirst(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, productId: string, assetIds: readonly string[]): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  if (new Set(assetIds).size !== assetIds.length) fail(422, 'INVALID_PHOTO_ORDER', 'Each photo is placed once', 'photo_ids')
  const order = [...assetIds, ...home.photos.map(photo => photo.id).filter(id => !assetIds.includes(id))]
  if (order.length > MAX_ORDERED_MEDIA_ASSETS) fail(422, 'PHOTO_LIMIT', `A home holds at most ${MAX_ORDERED_MEDIA_ASSETS} photos`, 'photo_ids')
  if (order.length === home.photos.length && order.every((id, index) => home.photos[index]!.id === id)) return home
  return await arrangeHomePhotos(db, env, access, principal, home, order)
}

/** Take a photo off the home. The file stays in the organization's media library; when the cover goes, the next photo becomes the cover. */
export async function removeStayHomePhoto(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, principal: MemberAccessPrincipal, productId: string, photoId: string): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  homePhoto(home, photoId)
  return await arrangeHomePhotos(db, env, access, principal, home, home.photos.map(photo => photo.id).filter(id => id !== photoId))
}

function stayPhotoRoomInsert(access: StayAccess, productId: string, roomId: string, type: StayPhotoRoomType): BatchQuery {
  return {
    query: `INSERT INTO product_stay_photo_rooms (id, organization_id, product_id, type, sort_order, created_at, created_by)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ?), ?, ?)`,
    params: [roomId, access.organizationId, productId, type, access.organizationId, productId, new Date().toISOString(), access.actorId],
  }
}

async function changedStayPhotoRooms(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, home: StayHome): Promise<StayHome> {
  await purgePublicResourceCacheNow(env, access.organizationId)
  const updated = await readStayHome(db, access, home.product_id)
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, productId: home.product_id, locationId: home.location_id, stayId: null }, { updated_at: new Date().toISOString() })
  return updated
}

/** Add exactly the room the host named; aggregate bedroom and bathroom counts are unchanged. */
export async function createStayPhotoRoom(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, body: unknown): Promise<{ home: StayHome; room: StayPhotoRoom }> {
  const home = await managedHome(db, access, productId)
  if (!isRecord(body)) fail(422, 'INVALID_PHOTO_ROOM', 'Choose a room or space type', 'type')
  const unknown = Object.keys(body).find(key => key !== 'type')
  if (unknown) fail(422, 'INVALID_PHOTO_ROOM', `${unknown} cannot be changed here`, unknown)
  if (!isStayPhotoRoomType(body.type)) fail(422, 'INVALID_PHOTO_ROOM', 'Choose a room or space type from the catalog', 'type')
  const id = crypto.randomUUID()
  await executeBatch(db, [
    stayPhotoRoomInsert(access, productId, id, body.type),
    publicResourceCacheInvalidationQuery(access.organizationId, 'stay-photo-room-create'),
  ], { operation: 'Create stay photo room' })
  const updated = await changedStayPhotoRooms(db, env, access, home)
  const room = updated.photo_rooms.find(entry => entry.id === id)
  if (!room) throw new Error('The created photo room could not be read')
  return { home: updated, room }
}

/** Listing-level answers belong to the Product; no authored room is created or inferred. */
export async function updateStayHomeAccessibility(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, body: unknown): Promise<{ home: StayHome }> {
  const home = await managedHome(db, access, productId)
  if (!isRecord(body)) fail(422, 'INVALID_STAY_ACCESSIBILITY', 'Provide the accessibility answer to change', 'accessibility')
  const unknown = Object.keys(body).find(key => !['expected_updated_at', 'accessibility'].includes(key))
  if (unknown) fail(422, 'INVALID_STAY_ACCESSIBILITY', `${unknown} cannot be changed here`, unknown)
  if (typeof body.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(body.expected_updated_at))) fail(422, 'INVALID_STAY_ACCESSIBILITY', 'Provide the Product updated_at value from the latest read', 'expected_updated_at')
  if (!isStayHomeAccessibility(body.accessibility)) fail(422, 'INVALID_STAY_ACCESSIBILITY', 'Choose a listing accessibility feature and true, false or null. A true answer needs unique photo IDs; false or null needs an empty photo list.', 'accessibility')
  if (body.expected_updated_at !== home.product_updated_at) fail(409, 'STAY_ACCESSIBILITY_CHANGED', 'The listing changed while you were editing. Reload the accessibility information and try again.', 'expected_updated_at')
  await updateProduct(db, {
    organizationId: access.organizationId, productId, patch: {}, actor: { actorId: access.actorId }, env,
    stayAccessibilityUpdate: { expectedUpdatedAt: body.expected_updated_at, accessibility: body.accessibility },
  })
  return { home: await readStayHome(db, access, productId) }
}

/** Room bed quantities allocate the declared listing inventory; they never replace its total. */
export async function updateStayPhotoRoom(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, roomId: string, body: unknown): Promise<{ home: StayHome; room: StayPhotoRoom }> {
  const home = await managedHome(db, access, productId)
  const current = home.photo_rooms.find(room => room.id === roomId)
  if (!current) fail(404, 'PHOTO_ROOM_NOT_FOUND', 'That room is not on this home', 'room_id')
  if (!isRecord(body)) fail(422, 'INVALID_ROOM_DETAILS', 'Provide the room details to change', 'room')
  const unknown = Object.keys(body).find(key => !['expected_details_version', 'sleeping_arrangements', 'private_attached_bathroom', 'amenities', 'accessibility'].includes(key))
  if (unknown) fail(422, 'INVALID_ROOM_DETAILS', `${unknown} cannot be changed here`, unknown)
  if (!Number.isInteger(body.expected_details_version) || (body.expected_details_version as number) < 1) fail(422, 'INVALID_ROOM_DETAILS', 'Provide the room details_version from the latest read', 'expected_details_version')
  const sleeping = Object.hasOwn(body, 'sleeping_arrangements')
  const privacy = Object.hasOwn(body, 'private_attached_bathroom')
  const amenities = Object.hasOwn(body, 'amenities')
  const accessibility = Object.hasOwn(body, 'accessibility')
  if (!sleeping && !privacy && !amenities && !accessibility) fail(422, 'INVALID_ROOM_DETAILS', 'Provide room details to change', 'room')
  if (sleeping && !isStaySleepingArrangements(body.sleeping_arrangements)) fail(422, 'INVALID_ROOM_DETAILS', `Sleeping arrangements must be null or a list of unique bed types with whole counts from 1 to ${MAX_STAY_BEDS_PER_TYPE}`, 'sleeping_arrangements')
  if (privacy && (current.type !== 'bedroom' || (body.private_attached_bathroom !== null && typeof body.private_attached_bathroom !== 'boolean'))) fail(422, 'INVALID_ROOM_DETAILS', 'Only a bedroom can state whether it has a private attached bathroom, as true, false or null', 'private_attached_bathroom')
  if (amenities && (!Array.isArray(body.amenities) || !body.amenities.every(isStayAmenity) || new Set(body.amenities).size !== body.amenities.length)) fail(422, 'INVALID_ROOM_DETAILS', 'Room amenities must list amenity codes from the catalog, each once', 'amenities')
  if (accessibility && (current.type !== 'bedroom' || !isStayRoomAccessibility(body.accessibility))) fail(422, 'INVALID_ROOM_DETAILS', 'Choose a bedroom accessibility feature and true, false or null. A true answer needs unique photo IDs; false or null needs an empty photo list.', 'accessibility')
  if (current.details_version !== body.expected_details_version) fail(409, 'ROOM_DETAILS_CHANGED', 'The room details changed while you were editing. Reload the room and try again.', 'expected_details_version')
  await updateProduct(db, {
    organizationId: access.organizationId, productId, patch: {}, actor: { actorId: access.actorId }, env,
    stayRoomUpdate: {
      roomId, expectedDetailsVersion: body.expected_details_version as number,
      ...(sleeping ? { sleeping_arrangements: body.sleeping_arrangements as StayPhotoRoom['sleeping_arrangements'] } : {}),
      ...(privacy ? { private_attached_bathroom: body.private_attached_bathroom as boolean | null } : {}),
      ...(amenities ? { amenities: body.amenities as StayAmenity[] } : {}),
      ...(accessibility ? { accessibility: body.accessibility as StayRoomAccessibility } : {}),
    },
  })
  const updated = await readStayHome(db, access, productId)
  const room = updated.photo_rooms.find(entry => entry.id === roomId)
  if (!room) fail(409, 'ROOM_DETAILS_CHANGED', 'The room was removed after its details were saved; reload the photo tour', 'room_id')
  return { home: updated, room }
}

/** Deleting a room returns its photos to Additional photos and keeps their Product placements. */
export async function removeStayPhotoRoom(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, roomId: string): Promise<StayHome> {
  const home = await managedHome(db, access, productId)
  if (!home.photo_rooms.some(room => room.id === roomId)) fail(404, 'PHOTO_ROOM_NOT_FOUND', 'That room is not on this home', 'room_id')
  const [removed] = await executeBatch(db, [
    { query: 'DELETE FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ? AND id = ? RETURNING id', params: [access.organizationId, productId, roomId] },
    publicResourceCacheInvalidationQuery(access.organizationId, 'stay-photo-room-delete'),
  ], { operation: 'Delete stay photo room' })
  const deleted = removed?.results[0]
  if (removed?.results.length !== 1 || !isRecord(deleted) || deleted.id !== roomId) fail(409, 'PHOTOS_CHANGED', 'The room changed while deleting; reload the photo tour', 'room_id')
  return await changedStayPhotoRooms(db, env, access, home)
}

/** Move explicit photos together, refusing a changed source or a photo removed in the meantime. */
export async function moveStayPhotos(db: DbClient, env: CloudflareEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, body: unknown): Promise<{ home: StayHome; destination_room_id: string | null; created_room_id: string | null; moved_photo_ids: string[] }> {
  const home = await managedHome(db, access, productId)
  if (!isRecord(body)) fail(422, 'INVALID_PHOTO_MOVE', 'Choose photos and their destination', 'photos')
  const unknown = Object.keys(body).find(key => !['room_id', 'new_room_type', 'photos'].includes(key))
  if (unknown) fail(422, 'INVALID_PHOTO_MOVE', `${unknown} cannot be changed here`, unknown)
  const creating = Object.hasOwn(body, 'new_room_type')
  if (creating === Object.hasOwn(body, 'room_id')) fail(422, 'INVALID_PHOTO_MOVE', 'Choose either room_id or new_room_type', 'room_id')
  if (creating && !isStayPhotoRoomType(body.new_room_type)) fail(422, 'INVALID_PHOTO_MOVE', 'Choose a room or space type from the catalog', 'new_room_type')
  if (!creating && body.room_id !== null && (typeof body.room_id !== 'string' || !body.room_id.trim())) fail(422, 'INVALID_PHOTO_MOVE', 'room_id must name a room, or be null for Additional photos', 'room_id')
  const roomId = creating ? crypto.randomUUID() : body.room_id as string | null
  if (!creating && roomId !== null && !home.photo_rooms.some(room => room.id === roomId)) fail(404, 'PHOTO_ROOM_NOT_FOUND', 'That room is not on this home', 'room_id')
  if (!Array.isArray(body.photos) || !body.photos.length || body.photos.length > MAX_ORDERED_MEDIA_ASSETS) fail(422, 'INVALID_PHOTO_MOVE', `Choose between 1 and ${MAX_ORDERED_MEDIA_ASSETS} photos`, 'photos')
  const photos = body.photos.map((photo: unknown) => {
    if (!isRecord(photo) || Object.keys(photo).some(key => key !== 'photo_id' && key !== 'expected_room_id')
      || typeof photo.photo_id !== 'string' || !photo.photo_id.trim()
      || (photo.expected_room_id !== null && (typeof photo.expected_room_id !== 'string' || !photo.expected_room_id.trim()))) {
      fail(422, 'INVALID_PHOTO_MOVE', 'Each photo needs photo_id and its expected_room_id, or null when unassigned', 'photos')
    }
    return { photo_id: photo.photo_id, expected_room_id: photo.expected_room_id as string | null }
  })
  if (new Set(photos.map(photo => photo.photo_id)).size !== photos.length) fail(422, 'INVALID_PHOTO_MOVE', 'Choose each photo once', 'photos')
  for (const photo of photos) {
    homePhoto(home, photo.photo_id)
    const currentRoom = home.photo_rooms.find(room => room.photo_ids.includes(photo.photo_id))?.id ?? null
    if (currentRoom !== photo.expected_room_id) fail(409, 'PHOTOS_CHANGED', 'A selected photo moved to another room; reload the photo tour', 'photos')
  }
  const selected = JSON.stringify(photos)
  // A failed predicate violates the existing home's required timestamp and
  // rolls back the entire batch, including a new destination room. This
  // repeats presence and per-photo source checks at the actual commit.
  const guard: BatchQuery = {
    query: `UPDATE product_stay_configs SET updated_at = NULL WHERE organization_id = ? AND product_id = ? AND (
      (? IS NOT NULL AND ? = 0 AND NOT EXISTS (SELECT 1 FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ? AND id = ?))
      OR EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (
        SELECT 1 FROM media_placements mp JOIN media_assets ma ON ma.organization_id = mp.organization_id AND ma.id = mp.asset_id AND ma.status = 'active'
        WHERE mp.organization_id = ? AND mp.owner_type = 'product' AND mp.owner_id = ? AND mp.slot IN ('image', 'gallery') AND mp.status = 'active'
          AND mp.asset_id = json_extract(selected.value, '$.photo_id'))
        OR (SELECT m.room_id FROM product_stay_photo_room_memberships m WHERE m.organization_id = ? AND m.product_id = ?
          AND m.asset_id = json_extract(selected.value, '$.photo_id')) IS NOT json_extract(selected.value, '$.expected_room_id'))
      )`,
    params: [access.organizationId, productId, roomId, creating ? 1 : 0, access.organizationId, productId, roomId, selected, access.organizationId, productId, access.organizationId, productId],
  }
  const assignments: BatchQuery = roomId === null ? {
    query: `DELETE FROM product_stay_photo_room_memberships WHERE organization_id = ? AND product_id = ? AND asset_id IN (SELECT json_extract(value, '$.photo_id') FROM json_each(?))`,
    params: [access.organizationId, productId, selected],
  } : {
    query: `INSERT INTO product_stay_photo_room_memberships (organization_id, product_id, asset_id, room_id)
      SELECT ?, ?, json_extract(value, '$.photo_id'), ? FROM json_each(?) WHERE true
      ON CONFLICT (organization_id, product_id, asset_id) DO UPDATE SET room_id = excluded.room_id`,
    params: [access.organizationId, productId, roomId, selected],
  }
  try {
    await executeBatch(db, [
      guard,
      ...(creating ? [stayPhotoRoomInsert(access, productId, roomId!, body.new_room_type as StayPhotoRoomType)] : []),
      assignments,
      publicResourceCacheInvalidationQuery(access.organizationId, 'stay-photo-move'),
    ], { operation: 'Move stay photos' })
  } catch (error) {
    if (/NOT NULL constraint failed: product_stay_configs\.updated_at|FOREIGN KEY constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      fail(409, 'PHOTOS_CHANGED', 'The photos or destination room changed while saving; reload the photo tour', 'photos')
    }
    throw error
  }
  return { home: await changedStayPhotoRooms(db, env, access, home), destination_room_id: roomId, created_room_id: creating ? roomId : null, moved_photo_ids: photos.map(photo => photo.photo_id) }
}

/** What this caller reads of a stay: the whole stay for managers, its turnover for members. */
export type StayView<A extends StayAccess> = A extends { manage: true } ? Stay : StayTurnover
type StayDetailView<A extends StayAccess> = A extends { manage: true } ? StayDetail : StayTurnover

/** Stays overlapping [from, to), newest check-in last. Cancelled stays are included only when asked for. */
export async function listStays<A extends StayAccess>(db: DbClient, access: A, input: { from: unknown; to: unknown; productId?: string; includeCancelled?: boolean }): Promise<Array<StayView<A>>> {
  const { from, to } = range(input, MAX_LIST_DAYS)
  return staysOverlapping(db, access, { from, to, productId: input.productId, includeCancelled: input.includeCancelled })
}

/** Stays overlapping a range its caller has already checked. */
async function staysOverlapping<A extends StayAccess>(db: DbClient, access: A, input: { from: string; to: string; productId?: string; includeCancelled?: boolean }): Promise<Array<StayView<A>>> {
  const { from, to } = input
  const scope = visibleHomes(access)
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.check_in_date < ? AND s.check_out_date > ?
       ${input.productId ? 'AND s.product_id = ?' : ''} ${input.includeCancelled ? '' : "AND s.status <> 'cancelled'"} AND ${scope.sql}
     ORDER BY s.check_in_date, s.id`, [access.organizationId, to, from, ...(input.productId ? [input.productId] : []), ...scope.params])
  return rows.map(row => access.manage ? mapStay(row) : stayTurnover(mapStay(row))) as Array<StayView<A>>
}

export async function getStay<A extends StayAccess>(db: DbClient, access: A, stayId: string): Promise<StayDetailView<A>> {
  const scope = visibleHomes(access)
  const row = await queryFirst<Record<string, unknown> & Pick<StayDetail, 'guest_image_url'>>(db, `
    SELECT ${STAY_COLUMNS}, (SELECT u.image FROM user u WHERE u.id = s.user_id) AS guest_image_url
      FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.id = ? AND ${scope.sql}`, [access.organizationId, stayId, ...scope.params])
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That stay is not in this organization')
  const stay = mapStay(row)
  if (!access.manage) return stayTurnover(stay) as StayDetailView<A>
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
  return { ...stay, guest_image_url: row.guest_image_url, payments, online_payment: onlinePayment, paid_minor: paid, payment_status: status } as StayDetailView<A>
}

/** Every night of [from, to) at one home: whether it is free, its price and rules, and the stay holding it. */
export async function readStayCalendar<A extends StayAccess>(db: DbClient, access: A, input: { productId: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Array<StayView<A>> }> {
  const { from, to } = range(input, MAX_CALENDAR_DAYS)
  const home = await readStayHome(db, access, input.productId)
  const [nights, stays] = await Promise.all([homeNights(db, access.organizationId, home, from, to), staysOverlapping(db, access, { from, to, productId: input.productId })])
  return { home, nights, stays }
}

/**
 * Every night of [from, to) at every home this caller may see, the
 * multi-calendar's read: each home with its nights, and the stays holding any
 * of them. A night's stay_id names its stay in `stays`.
 */
export async function readStayCalendars<A extends StayAccess>(db: DbClient, access: A, input: { from: unknown; to: unknown }): Promise<{ from: string; to: string; homes: Array<{ home: StayHome; nights: StayNight[] }>; stays: Array<StayView<A>> }> {
  const { from, to } = range(input, MAX_HOMES_CALENDAR_DAYS)
  const [homes, stays] = await Promise.all([stayHomes(db, access, null), staysOverlapping(db, access, { from, to })])
  const nights = homes.length ? await homesNights(db, access.organizationId, homes, from, to) : []
  return { from, to, homes: homes.map((home, index) => ({ home, nights: nights[index]! })), stays }
}

/** A hold's claim counts while its hold is active and unexpired; this selects the claims that no longer do. */
const LAPSED_HOLD_CLAIM_SQL = `stay_nights.hold_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h
  WHERE h.id = stay_nights.hold_id AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

/** Every night of [from, to) at one home, read for whoever already has the home. */
async function homeNights(db: DbClient, organizationId: string, home: StayHome, from: string, to: string): Promise<StayNight[]> {
  return (await homesNights(db, organizationId, [home], from, to))[0]!
}

/** Every night of [from, to) at each of these homes, in their order: three queries for any number of homes. */
async function homesNights(db: DbClient, organizationId: string, homes: readonly StayHome[], from: string, to: string): Promise<StayNight[][]> {
  const ids = d1JsonStringSet(homes.map(home => home.product_id))
  const [overrides, claims, pushes] = await Promise.all([
    queryAll<Record<string, unknown>>(db, 'SELECT * FROM product_nights WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) AND date >= ? AND date < ?', [organizationId, ids, from, to]),
    queryAll<{ product_id: string; date: string; stay_id: string | null; held_until: string | null; calendar: StayCalendarChannel | null }>(db, `SELECT stay_nights.product_id, stay_nights.date, stay_nights.stay_id, h.expires_at AS held_until, k.channel AS calendar FROM stay_nights
      LEFT JOIN payment_checkout_holds h ON h.id = stay_nights.hold_id
      LEFT JOIN stay_calendar_links k ON k.id = stay_nights.calendar_link_id
      WHERE stay_nights.organization_id = ? AND stay_nights.product_id IN (SELECT value FROM json_each(?)) AND stay_nights.date >= ? AND stay_nights.date < ? AND NOT (${LAPSED_HOLD_CLAIM_SQL})`, [organizationId, ids, from, to]),
    queryAll<{ product_id: string; date: string; state: 'pending' | 'pushed' | 'needs_review'; detail: string | null }>(db, 'SELECT product_id, date, state, detail FROM channel_night_pushes WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) AND date >= ? AND date < ?', [organizationId, ids, from, to]),
  ])
  const overrideByNight = new Map(overrides.map(row => [`${String(row.product_id)} ${String(row.date)}`, row]))
  const claimByNight = new Map(claims.map(row => [`${row.product_id} ${row.date}`, row]))
  const pushByNight = new Map(pushes.map(row => [`${row.product_id} ${row.date}`, { state: row.state, detail: row.detail }]))
  return homes.map((home) => {
    const nights: StayNight[] = []
    for (let offset = 0; offset < days(from, to); offset++) {
      const night = addDays(from, offset)
      const key = `${home.product_id} ${night}`
      const row = overrideByNight.get(key)
      const claim = claimByNight.get(key)
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
        calendar: claim?.calendar ?? null,
        channel: pushByNight.get(key) ?? null,
      })
    }
    return nights
  })
}

/**
 * Tell the home's channel, if it has one, the current state of these nights:
 * they join its delivery outbox and go now unless Channex's rate limit or a
 * retry wait holds them. The outcome is part of the write's result; a night
 * the channel did not take reads needs_review on the calendar.
 */
async function pushNights(db: DbClient, env: ChannexEnv, access: StayAccess, productId: string, ranges: ReadonlyArray<readonly [string, string]>): Promise<ChannelPushCompletion> {
  try {
    const home = await readStayHome(db, { organizationId: access.organizationId, actorId: access.actorId, manage: true }, productId)
    const dates = ranges.flatMap(([from, to]) => Array.from({ length: days(from, to) }, (_, offset) => addDays(from, offset)))
    return await pushStayNights(db, env, access.organizationId, home, dates, (from, to) => homeNights(db, access.organizationId, home, from, to))
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
}

/**
 * The full sync of a home's calendar to the Channex property it is mapped to,
 * enabled or not: an import's inventory, or a home syncing again. Fails the
 * way a save's push fails; the caller decides what its import does with it.
 */
export async function syncStayCalendar(db: DbClient, env: ChannexEnv, access: StayAccess, productId: string, mapping: ChannexMapping, lease?: DeliveryLease): Promise<ChannelPush> {
  const home = await readStayHome(db, access, productId)
  return pushStayCalendar(db, env, access.organizationId, home, mapping, (from, to) => homeNights(db, access.organizationId, home, from, to), lease)
}

/**
 * Deliver every connected home's pending nights that are due: those waiting
 * out a rate limit or a retry, and those another delivery of the home or a
 * write that ended early left. Every home is tried; the run fails naming the
 * ones that could not be delivered.
 */
export async function deliverPendingChannelNights(db: DbClient, env: StayMutationEnv): Promise<{ homes: number }> {
  const homes = await queryAll<{ organization_id: string; product_id: string }>(db, `SELECT DISTINCT organization_id, product_id FROM channel_night_pushes
    WHERE provider = 'channex' AND state = 'pending' AND (retry_at IS NULL OR retry_at <= ?)`, [new Date().toISOString()])
  const failures: string[] = []
  for (const row of homes) {
    try {
      const home = await readStayHome(db, { organizationId: row.organization_id, actorId: 'system', manage: true }, row.product_id)
      await deliverStayNights(db, env, row.organization_id, home, (from, to) => homeNights(db, row.organization_id, home, from, to))
      await publishStayInvalidation(env, { type: 'nights.changed', organizationId: row.organization_id, locationId: home.location_id, productId: home.product_id, stayId: null }, { updated_at: new Date().toISOString() })
    } catch (error) {
      failures.push(`${row.product_id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} home(s) could not deliver their channel nights: ${failures.join('; ')}`)
  return { homes: homes.length }
}

/** A base price or minimum stay changes the same 500 future nights on every write surface. */
/**
 * Our cancellation policies as Airbnb's own: the option of the same title and
 * wording in Airbnb's listing editor (read 2026-10-23), as Channex names it.
 * Airbnb's editor offers no Strict, so a home syncing with Airbnb is refused one.
 */
const AIRBNB_CANCELLATION: Partial<Record<StayCancellationPolicy, string>> = {
  flexible: 'flexible', moderate: 'moderate', limited: 'firm_14', firm: 'better_strict_with_grace_period',
}

/**
 * Refuse, before anything is written, settings a home syncing with Airbnb
 * cannot send. The same mapper validates and sends the normalized values.
 */
export async function requireAirbnbAcceptable(db: DbClient, organizationId: string, productId: string, product: { stay: AirbnbHomeSettings | null; details: Product['details'] }, sections: AirbnbSettingSections | null): Promise<void> {
  if (!product.stay || !sections) return
  const settings = airbnbListingSettings(product.stay, product.details, sections)
  if (!('refusal' in settings)) return
  const syncing = await queryFirst(db, "SELECT 1 FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND enabled = 1", [organizationId, productId])
  if (syncing) fail(422, 'AIRBNB_UNSUPPORTED_VALUE', settings.refusal, settings.field)
}
const AIRBNB_LONG_TERM_CANCELLATION: Record<StayLongTermCancellationPolicy, string> = { firm: 'CANCEL_LONG_TERM_FAIR', strict: 'CANCEL_LONG_TERM_WITH_GRACE_PERIOD' }
/** House rules Airbnb takes as guest controls, by product detail. */
const AIRBNB_GUEST_CONTROLS = { pets_allowed: 'allows_pets_as_host', smoking_allowed: 'allows_smoking_as_host', events_allowed: 'allows_events_as_host' } as const
/** Which of a connected home's Airbnb listing settings a product write changes, by section. */
export type AirbnbSettingSections = { [Section in keyof AirbnbListingSettings]: boolean }

/** Compare complete normalized snapshots to select the sections this write changes. */
export function touchesAirbnbSettings(patch: UpdateProductInput, previous: UpdateProductInput): AirbnbSettingSections | null {
  const sections = {
    booking: (['check_in_time', 'check_in_end_time', 'check_out_time', 'cancellation_policy', 'long_term_cancellation_policy'] as const).some(field => patch.stay?.[field] !== undefined && patch.stay[field] !== previous.stay?.[field])
      || (Object.keys(AIRBNB_GUEST_CONTROLS) as Array<keyof typeof AIRBNB_GUEST_CONTROLS>).some(key => patch.details?.[key] !== previous.details?.[key]),
    availability: patch.stay?.min_nights !== undefined && patch.stay.min_nights !== previous.stay?.min_nights,
  }
  return sections.booking || sections.availability ? sections : null
}

type AirbnbHomeSettings = Pick<StayHome, 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'cancellation_policy' | 'long_term_cancellation_policy' | 'min_nights'>

/**
 * A home's Airbnb listing settings, or why one of its values cannot be one.
 * Airbnb takes whole hours: a check-in start from 08:00 to 02:00 the next day
 * ("8"–"26"), an end up to 03:00 ("27") or flexible, and a checkout hour.
 * Only what the home has is sent: an unset house rule or policy is left as
 * Airbnb has it. Prices are not listing settings here: every night's price,
 * the base price's included, already reaches Airbnb with the nightly calendar.
 */
function airbnbListingSettings(home: AirbnbHomeSettings, details: Product['details'], sections: AirbnbSettingSections): AirbnbListingSettings | { refusal: string; field: string } {
  const booking = sections.booking ? airbnbBookingSettings(home, details) : {}
  if ('refusal' in booking) return booking as { refusal: string; field: string }
  return { booking, availability: sections.availability ? { default_min_nights: home.min_nights } : {} }
}

function airbnbBookingSettings(home: AirbnbHomeSettings, details: Product['details']): Record<string, unknown> | { refusal: string; field: string } {
  const hour = (time: string, field: string, label: string): number | { refusal: string; field: string } => {
    const [hh, mm] = time.split(':')
    return mm === '00' ? Number(hh) : { refusal: `Airbnb takes ${label} in whole hours; ${time} cannot be sent to Airbnb`, field }
  }
  const start = hour(home.check_in_time, 'check_in_time', 'the check-in start')
  if (typeof start !== 'number') return start
  const startHour = start < 8 ? start + 24 : start
  if (startHour > 26) return { refusal: `Airbnb's check-in start is between 08:00 and 02:00; ${home.check_in_time} cannot be sent to Airbnb`, field: 'check_in_time' }
  const booking: Record<string, unknown> = { check_in_time_start: String(startHour) }
  if (home.check_in_end_time === null) booking.check_in_time_end = 'FLEXIBLE'
  else {
    const end = hour(home.check_in_end_time, 'check_in_end_time', 'the check-in end')
    if (typeof end !== 'number') return end
    // An end earlier than the start is the next day, as is every end of a start after midnight.
    const endHour = startHour >= 24 || end <= start ? end + 24 : end
    if (endHour > 27 || endHour <= startHour) return { refusal: `Airbnb's check-in end is after the start and no later than 03:00; ${home.check_in_end_time} cannot be sent to Airbnb`, field: 'check_in_end_time' }
    booking.check_in_time_end = String(endHour)
  }
  const checkout = hour(home.check_out_time, 'check_out_time', 'checkout')
  if (typeof checkout !== 'number') return checkout
  booking.check_out_time = checkout
  const controls = Object.fromEntries((Object.entries(AIRBNB_GUEST_CONTROLS) as Array<[keyof typeof AIRBNB_GUEST_CONTROLS, string]>).flatMap(([key, control]) => typeof details[key] === 'boolean' ? [[control, details[key]]] : []))
  if (Object.keys(controls).length) booking.guest_controls = controls
  const category = home.cancellation_policy ? AIRBNB_CANCELLATION[home.cancellation_policy] : undefined
  if (home.cancellation_policy && !category) return { refusal: `Airbnb has no ${STAY_CANCELLATION_POLICIES[home.cancellation_policy].label} cancellation policy. Choose Flexible, Moderate, Limited or Firm for a home that syncs with Airbnb.`, field: 'cancellation_policy' }
  const cancellation = {
    ...(category ? { cancellation_policy_category: category } : {}),
    ...(home.long_term_cancellation_policy ? { lts_cancellation_policy_id: AIRBNB_LONG_TERM_CANCELLATION[home.long_term_cancellation_policy] } : {}),
  }
  if (Object.keys(cancellation).length) booking.cancellation_policy_settings = cancellation
  return booking
}

/**
 * Push what a write changed of a connected home to its channel: its Airbnb
 * listing settings, then its nights for the calendar ahead (nights without a
 * value of their own use the home's base price and minimum stay). A home that
 * is not connected has nothing to push and returns null.
 */
export async function pushStayHomeChannel(db: DbClient, env: ChannexEnv, access: StayAccess, product: Pick<Product, 'id' | 'updated_at'>, changes: { nights: boolean; settings: AirbnbSettingSections | null }): Promise<ChannelPushCompletion> {
  try {
    const home = await readStayHome(db, access, product.id)
    if (home.channel?.status !== 'connected') return null
    if (changes.settings) {
      const settings = airbnbListingSettings(home, (await getProduct(db, access.organizationId, product.id)).details, changes.settings)
      const pushed: ChannelPush | null = 'refusal' in settings ? { state: 'needs_review', detail: settings.refusal } : await pushAirbnbListingSettings(db, env, access.organizationId, product.id, settings)
      if (pushed?.state === 'needs_review' || !changes.nights) return pushed
    }
    if (!changes.nights) return null
    const today = homeToday(home.timezone)
    return await pushNights(db, env, access, product.id, [[today, addDays(today, MAX_CALENDAR_DAYS)]])
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause))
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
  const enteredPhone = optionalText(input.guest_phone, 'guest_phone', 40)
  const phone = enteredPhone === null ? null : toE164(enteredPhone)
  if (enteredPhone !== null && !phone) fail(422, 'INVALID_STAY_FIELD', 'guest_phone must be an international number with its country calling code, such as +66812345678', 'guest_phone')
  return {
    check_in_date: checkIn, check_out_date: checkOut, arrival_time: arrival, adults, children, infants, guest_name: guestName,
    guest_surname: optionalText(input.guest_surname, 'guest_surname', 200), guest_email: email,
    guest_phone: phone, total_minor: amount(input.total_minor, 'total_minor'),
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
export async function createStay(db: DbClient, env: StayMutationEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; idempotency_key: string }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  const home = await readStayHome(db, access, input.product_id)
  const fields = stayFields(input, home)
  // A payment the guest already made is written with the stay, so a stay never exists without it.
  const payment = input.payment === undefined || input.payment === null ? null : stayPaymentFields(input.payment, 'payment.', false)
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  const replay = async () => {
    const existing = await queryFirst<StayFields & { id: string; product_id: string }>(db,
      `SELECT id, product_id, ${Object.keys(fields).join(', ')} FROM stays WHERE organization_id = ? AND idempotency_key = ?`, [access.organizationId, key])
    if (!existing) return null
    if (existing.product_id !== home.product_id || Object.entries(fields).some(([field, value]) => existing[field as keyof StayFields] !== value)) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a stay with different saved details. Reload the stay before another change; a create retry does not edit an existing stay.', 'idempotency_key')
    }
    const initialPayment = await queryFirst<StayPaymentFields>(db,
      'SELECT amount_minor, method, paid_on, reference, note FROM stay_payments WHERE organization_id = ? AND stay_id = ? AND idempotency_key = ?', [access.organizationId, existing.id, `${key}:payment`]) ?? null
    if ((payment === null) !== (initialPayment === null) || (payment && initialPayment && Object.entries(payment).some(([field, value]) => initialPayment[field as keyof StayPaymentFields] !== value))) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a stay with a different saved initial payment', 'idempotency_key')
    }
    return getStay(db, access, existing.id)
  }
  // A replay pushes again, so retrying a create whose push did not land repairs it.
  const pushed = async (stay: StayDetail) => {
    await planStayMessages(db, access.organizationId, stay.id)
    const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
    return completeChannelPush(channelPush, { product_id: stay.product_id, stay_id: stay.id, version: stay.version, ranges: [[stay.check_in_date, stay.check_out_date]] }, async () => {
      await publishStayChange(env, db, access.organizationId, stay, true)
      return getStay(db, access, stay.id)
    })
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
      ...(payment ? stayPaymentInsert(access, { id, currency: home.currency, location_id: home.location_id }, payment, `${key}:payment`, now) : []),
    ], { operation: 'Create stay' })
  } catch (error) {
    if (isStayNightConflict(error)) fail(409, 'STAY_OVERLAP', 'Another stay or a linked calendar already holds one of these nights', 'check_in_date')
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

export async function updateStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: Record<string, unknown> & { expected_version: unknown }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const current = await requireAppStay(db, access, stayId, input.expected_version)
  const home = await readStayHome(db, access, current.product_id)
  const fields = stayFields({ ...current, ...input }, home)
  if (!Object.entries(fields).some(([field, value]) => value !== current[field as keyof StayFields])) fail(422, 'INVALID_STAY_FIELD', 'Provide at least one changed stay field', 'stay')
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
    if (isStayNightConflict(error)) fail(409, 'STAY_OVERLAP', 'Another stay or a linked calendar already holds one of these nights', 'check_in_date')
    throw error
  }
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  await planStayMessages(db, access.organizationId, stayId)
  const stay = await getStay(db, access, stayId)
  // The nights it released and the nights it now holds.
  const ranges = [[current.check_in_date, current.check_out_date], [stay.check_in_date, stay.check_out_date]] as const
  const changed = current.check_in_date === stay.check_in_date && current.check_out_date === stay.check_out_date ? [] : ranges
  const channelPush = await pushNights(db, env, access, stay.product_id, changed)
  return completeChannelPush(channelPush, { product_id: stay.product_id, stay_id: stayId, version: stay.version, ranges: changed }, async () => {
    await publishStayChange(env, db, access.organizationId, stay, changed.length > 0)
    return getStay(db, access, stayId)
  })
}

/**
 * The host cancels a stay. One the guest paid for on the site returns the whole
 * payment, as Airbnb's host cancellation does: the refund is queued in the same
 * batch, only under the host's approved financial authorization, and sent by
 * the caller that holds it (server/api/dashboard/payments/refund.post.ts).
 * Without one the cancellation is refused with where to approve it.
 */
export async function cancelStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: { expected_version: unknown; reason?: unknown; authorization_id?: string; financial_writes_allowed?: boolean }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const current = await getStay(db, access, stayId)
  if (current.owner !== 'app') fail(409, 'STAY_NOT_EDITABLE', 'This stay belongs to its channel; change it there')
  if (input.expected_version !== current.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  const reason = optionalText(input.reason, 'reason', 500)
  const complete = async (version: number) => {
    const channelPush = await pushNights(db, env, access, current.product_id, [[current.check_in_date, current.check_out_date]])
    return completeChannelPush(channelPush, { product_id: current.product_id, stay_id: stayId, version, ranges: [[current.check_in_date, current.check_out_date]] }, async () => {
      await planStayMessages(db, access.organizationId, stayId)
      await publishStayChange(env, db, access.organizationId, await getStay(db, access, stayId), true)
      return getStay(db, access, stayId)
    })
  }
  // A current-version replay finishes the saved cancellation without another mutation or refund intent.
  if (current.status === 'cancelled') return complete(current.version)
  await requireChannelPush(db, env, access.organizationId, current.product_id)
  const next = current.version + 1
  const now = new Date().toISOString()
  const refund = await visitRefundQueries(db, {
    action: 'cancel', organizationId: access.organizationId, actorUserId: access.actorId, subjectType: 'stay', subjectId: stayId,
    authorizationId: input.authorization_id, financialWritesAllowed: input.financial_writes_allowed, note: reason ?? undefined, now,
    committed: { query: "EXISTS(SELECT 1 FROM stays WHERE organization_id=? AND id=? AND status='cancelled' AND version=?)", params: [access.organizationId, stayId, next] },
  })
  const results = await executeBatch(db, [
    {
      query: `UPDATE stays SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, version = ?, updated_at = ?, updated_by = ?
              WHERE organization_id = ? AND id = ? AND version = ? AND owner = 'app' AND status <> 'cancelled' AND (${refund.guard?.query ?? '1 = 1'})`,
      params: [now, reason, next, now, access.actorId, access.organizationId, stayId, current.version, ...(refund.guard?.params ?? [])],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: current.location_id, actorId: access.actorId, eventType: 'stay.cancelled', entityType: 'stay', entityId: stayId, onlyIfPreviousChangedOneRow: true }),
    ...reconcileNightsQueries(access.organizationId, stayId),
    ...refund.queries,
  ], { operation: 'Cancel stay' })
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'expected_version')
  return complete(next)
}

/** What cancelling a stay returns to its guest now, by the policy they booked under, out of what they paid. */
export interface StayCancellationQuote { policy: StayBookedPolicy; paid_minor: number; refund_minor: number; currency: string }

/** The guest's own stay, paid on the site and still theirs to cancel, with what cancelling returns now. */
async function guestStayCancellation(db: DbClient, organizationId: string, stayId: string, buyerUserId: string, now: string) {
  const stay = await queryFirst<Stay>(db, `SELECT ${STAY_COLUMNS} FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.organization_id = ? AND s.id = ? AND s.user_id = ? AND s.owner = 'app' AND s.channel = 'direct'`, [organizationId, stayId, buyerUserId])
  if (!stay) fail(404, 'STAY_NOT_FOUND', 'That stay is not yours to cancel', 'stay_id')
  const payment = await queryFirst<Payment>(db, "SELECT * FROM payments WHERE organization_id = ? AND subject_type = 'stay' AND subject_id = ? AND captured_amount > 0", [organizationId, stayId])
  if (!payment) fail(409, 'STAY_NOT_PAID_ONLINE', 'This stay was not paid on the site. Contact the host to cancel it.', 'stay_id')
  if (!stay.cancellation_policy) throw new Error(`Stay ${stayId} was paid on the site without a cancellation policy`)
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  const purchase = isRecord(snapshot) ? snapshot.stay : undefined
  if (!isRecord(purchase) || !Array.isArray(purchase.nightly)) throw new Error(`Stay ${stayId} payment has no nightly prices`)
  const home = await queryFirst<{ check_in_time: string }>(db, 'SELECT check_in_time FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, stay.product_id])
  if (!home) throw new Error(`Stay ${stayId} has no home`)
  const held = payment.captured_amount - payment.refunded_amount
  const owed = stayCancellationRefund({ policy: stay.cancellation_policy, nightly: purchase.nightly as StayCancellationInput['nightly'], booked_at: stay.created_at, now, timezone: stay.timezone, check_in_time: home.check_in_time })
  const quote: StayCancellationQuote = { policy: stay.cancellation_policy, paid_minor: payment.captured_amount, refund_minor: Math.min(owed, held), currency: payment.currency }
  return { stay, payment, quote }
}

/** A guest's own stay as their account reads it: the stay, its home and host, and what cancelling returns now. */
export interface GuestStay {
  /** The business the stay is with: a business's site shows only its own. */
  organization_id: string
  stay: StayDetail
  home: { name: string; organization_name: string; check_in_time: string; check_out_time: string; image_url: string | null; location: { address: PostalAddress | null; latitude: number | null; longitude: number | null; maps_url: string | null } | null; arrival_guide: StayArrivalGuide | null; house_rules: string[]; safety: string[] }
  /** Null once the stay is cancelled, or for a stay not paid on the site. */
  cancellation: StayCancellationQuote | null
}

/** The account's stay by its activity ID: its conversation's ID, or the stay's own when it has none. */
export async function readGuestStay(db: DbClient, buyerUserId: string, activityId: string): Promise<GuestStay> {
  const owned = await queryFirst<{ id: string; request_id: string | null; organization_id: string; product_id: string; status: string; name: string; organization_name: string; check_in_time: string; check_out_time: string; address: string | null; latitude: number | null; longitude: number | null; maps_url: string | null; paid_online: number }>(db, `
    SELECT s.id, s.request_id, s.organization_id, s.product_id, s.status, p.name, o.name AS organization_name, c.check_in_time, c.check_out_time, l.address, l.latitude, l.longitude, l.maps_url,
           EXISTS (SELECT 1 FROM payments WHERE organization_id = s.organization_id AND subject_type = 'stay' AND subject_id = s.id AND captured_amount > 0) AS paid_online
      FROM stays s JOIN products p ON p.organization_id = s.organization_id AND p.id = s.product_id
      JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN organization o ON o.id = s.organization_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE COALESCE(s.request_id, s.id) = ? AND s.user_id = ? AND s.owner = 'app'`, [activityId, buyerUserId])
  if (!owned) fail(404, 'STAY_NOT_FOUND', 'That stay is not in your account', 'stay_id')
  if (owned.request_id) await ownedBuyerRequest(db, buyerUserId, owned.request_id)
  const [stay, pictures] = await Promise.all([
    getStay(db, { organizationId: owned.organization_id, actorId: buyerUserId, manage: true }, owned.id),
    loadOwnerPictures(db, owned.organization_id, 'product', [owned.product_id], { organizationFallback: false }),
  ])
  if (stay.user_id !== buyerUserId || stay.owner !== 'app') fail(404, 'STAY_NOT_FOUND', 'That stay is not in your account', 'stay_id')
  const cancellation = stay.status !== 'cancelled' && owned.paid_online === 1
    ? (await guestStayCancellation(db, owned.organization_id, owned.id, buyerUserId, new Date().toISOString())).quote : null
  const pinFailure = stay.status === 'confirmed' ? coordinatesFailure(owned) : null
  if (pinFailure) fail(500, 'INVALID_STORED_LOCATION', pinFailure.error, pinFailure.field)
  const address = stay.status === 'confirmed' ? parsePostalAddress(owned.address) : null
  const location = stay.status === 'confirmed' ? {
    address, latitude: owned.latitude, longitude: owned.longitude,
    maps_url: calculateMapUrl({ title: '', address, latitude: owned.latitude, longitude: owned.longitude, maps_url: owned.maps_url }),
  } : null
  let arrivalGuide: StayArrivalGuide | null = null
  let houseRules: string[] = []
  let safety: string[] = []
  if (stay.status === 'confirmed') {
    const [{ home }, product] = await Promise.all([
      readCheckoutStay(db, owned.organization_id, owned.id),
      getProduct(db, owned.organization_id, owned.product_id),
    ])
    if (!product) throw new Error(`Stay ${owned.id} has no product`)
    const { product_id, check_in_method, check_in_instructions, wifi_network, wifi_password, directions, house_manual, checkout_instructions } = home
    if (Date.now() < localDateTimeToInstant(stay.check_out_date, home.check_out_time, home.timezone).getTime()) {
      arrivalGuide = { product_id, check_in_method, check_in_instructions, wifi_network, wifi_password, directions, house_manual, checkout_instructions }
    }
    houseRules = stayHouseRuleLines(product.details, value => formatTime(value, 'en'))
    safety = [...staySafetyLines(product.details), ...stayAlarmLines(home.amenity_answers, product.details, { includeUnknown: true })]
  }
  return { organization_id: owned.organization_id, stay, home: { name: owned.name, organization_name: owned.organization_name, check_in_time: owned.check_in_time, check_out_time: owned.check_out_time, image_url: pictures.get(owned.product_id)?.imageUrl ?? null, location, arrival_guide: arrivalGuide, house_rules: houseRules, safety }, cancellation }
}

/**
 * The guest cancels their own stay. The policy they booked under decides the
 * refund, which is queued in the same batch as the cancellation and sent to
 * Stripe after it; a retry of a cancelled stay sends a refund that did not go.
 */
export async function cancelStayAsGuest(db: DbClient, env: StayMutationEnv & CloudflareEnv, organizationId: string, stayId: string, buyerUserId: string): Promise<{ stay: Stay; refund_minor: number }> {
  const now = new Date().toISOString()
  const { stay, payment, quote } = await guestStayCancellation(db, organizationId, stayId, buyerUserId, now)
  const key = `guest-cancelled-stay:${stayId}`
  if (stay.status !== 'cancelled') {
    const next = stay.version + 1
    // Stripe's full-remaining refund when the policy returns everything still held.
    const amount = quote.refund_minor === payment.captured_amount - payment.refunded_amount ? null : quote.refund_minor
    const results = await executeBatch(db, [
      {
        query: `UPDATE stays SET status = 'cancelled', cancelled_at = ?, cancellation_reason = 'guest_cancelled', version = ?, updated_at = ?, updated_by = ?
                WHERE organization_id = ? AND id = ? AND version = ? AND user_id = ? AND status <> 'cancelled'
                  AND NOT EXISTS (SELECT 1 FROM payment_refunds WHERE payment_id = ? AND status IN ('queued','creating','pending','requires_action'))`,
        params: [now, next, now, buyerUserId, organizationId, stayId, stay.version, buyerUserId, payment.id],
      },
      organizationEventQuery({ organizationId, locationId: stay.location_id, actorId: buyerUserId, eventType: 'stay.cancelled', entityType: 'stay', entityId: stayId, metadata: { by: 'guest', refund_minor: quote.refund_minor }, onlyIfPreviousChangedOneRow: true }),
      ...reconcileNightsQueries(organizationId, stayId),
      ...(quote.refund_minor > 0 ? [{
        query: `INSERT INTO payment_refunds (id, payment_id, idempotency_key, amount, reason, status, created_by, created_at, updated_at)
                SELECT ?, ?, ?, ?, 'requested_by_customer', 'queued', ?, ?, ? WHERE EXISTS (SELECT 1 FROM stays WHERE organization_id = ? AND id = ? AND status = 'cancelled' AND version = ?)
                ON CONFLICT(idempotency_key) DO NOTHING`,
        params: [crypto.randomUUID(), payment.id, key, amount, buyerUserId, now, now, organizationId, stayId, next],
      }] : []),
    ], { operation: 'Guest cancels stay' })
    if (!versionChanged(results)) fail(409, 'STAY_NOT_CANCELLABLE', 'This stay changed or a refund is already on its way. Reload it and try again.', 'stay_id')
  } else if (stay.cancellation_reason !== 'guest_cancelled') {
    fail(409, 'STAY_ALREADY_CANCELLED', 'This stay was already cancelled', 'stay_id')
  }
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
  return completeChannelPush(channelPush, { product_id: stay.product_id, stay_id: stayId, version: stay.status === 'cancelled' ? stay.version : stay.version + 1, ranges: [[stay.check_in_date, stay.check_out_date]] }, async () => {
    await planStayMessages(db, organizationId, stayId)
    await publishStayChange(env, db, organizationId, await storedStay(db, organizationId, stayId), true)
    const refund = await queryFirst<{ amount: number | null }>(db, 'SELECT amount FROM payment_refunds WHERE payment_id = ? AND idempotency_key = ?', [payment.id, key])
    let refundMinor = 0
    if (refund) {
      const refunded = await requirePayment(db, organizationId, payment.id)
      const completed = await executeRefund(db, paymentsStripe(env, Boolean(refunded.livemode)), refunded, refund.amount, key, 'requested_by_customer', buyerUserId, env)
      const receipt = await queryFirst<{ amount: number; status: string; stripe_refund_id: string }>(db, 'SELECT amount, status, stripe_refund_id FROM payment_refunds WHERE payment_id = ? AND idempotency_key = ?', [payment.id, key])
      if (!receipt || !Number.isSafeInteger(receipt.amount) || receipt.amount < 0 || receipt.status !== completed.status || receipt.stripe_refund_id !== completed.stripe_refund_id) throw new Error('The cancelled stay refund could not be verified')
      refundMinor = receipt.amount
    }
    const { notifyStayCancelled } = await import('~/server/utils/notifications')
    await notifyStayCancelled(env, db, organizationId, stayId, 'guest', refundMinor)
    return { stay: await storedStay(db, organizationId, stayId), refund_minor: refundMinor }
  })
}

/** Record money the host received (or, negative, refunded) outside Stripe for a stay they took. */
interface StayPaymentFields {
  amount_minor: number
  method: StayPaymentMethod
  paid_on: string
  reference: string | null
  note: string | null
}

/**
 * A payment the host records against a stay. `prefix` names the fields in
 * errors when the payment rides inside another body, as `payment.` does on a
 * create. A refund (a negative amount) is allowed only on its own.
 */
function stayPaymentFields(input: unknown, prefix: string, allowRefund: boolean): StayPaymentFields {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'INVALID_STAY_FIELD', `${prefix || 'payment'} must be an object`, prefix.replace(/\.$/, '') || 'payment')
  const body = input as Record<string, unknown>
  const amountMinor = amount(body.amount_minor, `${prefix}amount_minor`, allowRefund)
  if (amountMinor === 0) fail(422, 'INVALID_AMOUNT', `${prefix}amount_minor must not be zero`, `${prefix}amount_minor`)
  if (!STAY_PAYMENT_METHODS.includes(body.method as StayPaymentMethod)) fail(422, 'INVALID_STAY_FIELD', `${prefix}method must be one of ${STAY_PAYMENT_METHODS.join(', ')}`, `${prefix}method`)
  return {
    amount_minor: amountMinor, method: body.method as StayPaymentMethod, paid_on: date(body.paid_on, `${prefix}paid_on`),
    reference: optionalText(body.reference, `${prefix}reference`, 200), note: optionalText(body.note, `${prefix}note`, 1000),
  }
}

function stayPaymentInsert(access: StayAccess, stay: { id: string; currency: string; location_id: string }, payment: StayPaymentFields, key: string, now: string): BatchQuery[] {
  const id = crypto.randomUUID()
  return [
    {
      query: `INSERT INTO stay_payments (id, organization_id, stay_id, amount_minor, currency, method, paid_on, reference, note, idempotency_key, created_at, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, access.organizationId, stay.id, payment.amount_minor, stay.currency, payment.method, payment.paid_on, payment.reference, payment.note, key, now, access.actorId],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: stay.location_id, actorId: access.actorId, eventType: 'stay.payment_recorded', entityType: 'stay', entityId: stay.id, metadata: { payment_id: id, amount_minor: payment.amount_minor } }),
  ]
}

export async function recordStayPayment(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, stayId: string, input: Record<string, unknown>): Promise<{ stay: StayDetail; payment: StayPayment }> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (stay.owner !== 'app') fail(409, 'STAY_NOT_EDITABLE', 'This stay is paid through its channel')
  const payment = stayPaymentFields(input, '', true)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  // Read the exact recorded row by its durable key, never by its position in
  // payment history. A retry also finishes a failed dashboard publication.
  const replay = async () => {
    const existing = await queryFirst<StayPaymentFields & { id: string; stay_id: string }>(db,
      'SELECT id, stay_id, amount_minor, method, paid_on, reference, note FROM stay_payments WHERE organization_id = ? AND idempotency_key = ?', [access.organizationId, key])
    if (!existing) return null
    if (existing.stay_id !== stayId || Object.entries(payment).some(([field, value]) => existing[field as keyof StayPaymentFields] !== value)) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency_key was already used for a different payment', 'idempotency_key')
    await publishStayInvalidation(env, { type: 'stay.changed', organizationId: access.organizationId, locationId: stay.location_id, productId: stay.product_id, stayId }, { version: stay.version })
    const updated = await getStay(db, access, stayId)
    const recorded = updated.payments.find(entry => entry.id === existing.id)
    if (!recorded) fail(409, 'PAYMENT_CHANGED', 'The payment was recorded but removed before readback. Reload the stay before another change.', 'payment_id', { committed: true, stay_id: stayId })
    return { stay: updated, payment: recorded }
  }
  const earlier = await replay()
  if (earlier) return earlier
  try {
    await executeBatch(db, stayPaymentInsert(access, stay, payment, key, new Date().toISOString()), { operation: 'Record stay payment' })
  } catch (error) {
    if (/UNIQUE constraint failed: stay_payments\.organization_id, stay_payments\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
    throw error
  }
  const recorded = await replay()
  if (!recorded) fail(409, 'PAYMENT_CHANGED', 'The payment was recorded but removed before readback. Reload the stay before another change.', 'payment_id', { committed: true, stay_id: stayId })
  return recorded
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
export async function setStayNights(db: DbClient, env: StayMutationEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Stay[]; channel_push: SuccessfulChannelPush | null }> {
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
  return completeChannelPush(channelPush, { product_id: home.product_id, updated_at: now, ranges: [[from, to]] }, async () => {
    await publishStayInvalidation(env, { type: 'nights.changed', organizationId: access.organizationId, locationId: home.location_id, productId: home.product_id, stayId: null }, { updated_at: now })
    return readStayCalendar(db, access, { productId: home.product_id, from, to })
  })
}

/** One night of a channel's calendar as an import reads it. Airbnb has one minimum stay a night; it is both of KrabiClaw's. */
export interface ImportedNight {
  date: string
  available: boolean
  price_minor: number
  min_stay_arrival: number
  min_stay_through: number
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
      query: `INSERT INTO product_nights (organization_id, product_id, date, closed, price_minor, min_stay_arrival, min_stay_through, max_stay, closed_to_arrival, closed_to_departure, source, updated_at, updated_by)
              SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.closed'), json_extract(value, '$.price_minor'), json_extract(value, '$.min_stay_arrival'), json_extract(value, '$.min_stay_through'),
                     json_extract(value, '$.max_stay'), json_extract(value, '$.closed_to_arrival'), json_extract(value, '$.closed_to_departure'), 'import', ?, ?
                FROM json_each(?) WHERE true
              ON CONFLICT (product_id, date) DO UPDATE SET closed = excluded.closed, price_minor = excluded.price_minor, min_stay_arrival = excluded.min_stay_arrival, min_stay_through = excluded.min_stay_through,
                max_stay = excluded.max_stay, closed_to_arrival = excluded.closed_to_arrival, closed_to_departure = excluded.closed_to_departure,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by
              WHERE product_nights.source = 'import'`,
      params: [access.organizationId, home.product_id, now, access.actorId, JSON.stringify(nights.map(night => ({
        date: night.date, closed: night.available ? 0 : 1, price_minor: night.price_minor, min_stay_arrival: night.min_stay_arrival, min_stay_through: night.min_stay_through,
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
  channel: StayChannel
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
  type ChannelStayRow = { id: string; provider_updated_at: string | null; revision_id: string | null; external_booking_id: string }
  const currentChannelStay = () => queryFirst<ChannelStayRow>(db,
    'SELECT id, provider_updated_at, revision_id, external_booking_id FROM stays WHERE provider = ? AND external_booking_id = ?', [booking.provider, booking.external_booking_id])
  // The same reservation under a new provider booking id (a re-import after a
  // new Channex account) is the stay it already is: the revision's write moves
  // it onto the new id, when that revision is newer than the stay.
  const existing = await currentChannelStay() ?? (booking.channel_booking_id === null ? null : await queryFirst<ChannelStayRow>(db,
    `SELECT id, provider_updated_at, revision_id, external_booking_id FROM stays WHERE organization_id = ? AND channel = ? AND channel_booking_id = ? AND provider = ? AND external_booking_id <> ?`,
    [organizationId, booking.channel, booking.channel_booking_id, booking.provider, booking.external_booking_id]))
  const reimported = existing && existing.external_booking_id !== booking.external_booking_id ? existing.external_booking_id : null
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
  const write = (overbooked: 0 | 1): BatchQuery[] => [...(reimported === null ? [] : [{
    query: `UPDATE stays SET external_booking_id = ? WHERE organization_id = ? AND id = ? AND provider = ? AND external_booking_id = ?
      AND (provider_updated_at IS NULL OR provider_updated_at < ?)`,
    params: [booking.external_booking_id, organizationId, existing?.id ?? null, booking.provider, reimported, booking.provider_updated_at],
  }]), {
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
  const changed = writes[reimported === null ? 1 : 2]?.meta.changes
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
export const PUBLIC_STAY_SQL = `p.kind = 'stay' AND p.active = 1
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
  /** The home's policy for a stay this long; the guest books under it. */
  cancellation_policy: StayBookedPolicy
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
  const cancellationPolicy = bookedPolicyFor(count_, home)
  if (!cancellationPolicy) fail(409, 'STAY_CANCELLATION_POLICY_REQUIRED', `This home has no cancellation policy for stays of ${count_ >= LONG_TERM_STAY_NIGHTS ? `${LONG_TERM_STAY_NIGHTS} nights or more` : `under ${LONG_TERM_STAY_NIGHTS} nights`}`, count_ >= LONG_TERM_STAY_NIGHTS ? 'long_term_cancellation_policy' : 'cancellation_policy')
  return {
    product_id: home.product_id, name: home.name, location_id: home.location_id, timezone: home.timezone, currency: home.currency, tax_behavior: home.base_price_tax_behavior,
    check_in_date: checkIn, check_out_date: checkOut, check_in_time: home.check_in_time, check_out_time: home.check_out_time,
    nights: count_, adults, children, infants, nightly, total_minor: total, cancellation_policy: cancellationPolicy,
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
export async function pushStayHoldNights(db: DbClient, env: StayMutationEnv, organizationId: string, productId: string, checkIn: string, checkOut: string): Promise<SuccessfulChannelPush | null> {
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const home = await readStayHome(db, access, productId)
  const channelPush = await pushNights(db, env, access, productId, [[checkIn, checkOut]])
  const completed = await completeChannelPush(channelPush, { product_id: productId, ranges: [[checkIn, checkOut]] }, async () => {
    await publishStayInvalidation(env, { type: 'nights.changed', organizationId, locationId: home.location_id, productId, stayId: null }, { updated_at: new Date().toISOString() })
    return {}
  })
  return completed.channel_push
}

/**
 * Lapsed checkout holds still claiming nights: the nights are reopened on each
 * home's channel, then their claims are deleted. A night another write already
 * reclaimed was cleared by that write and is not here.
 */
export async function releaseLapsedStayHolds(db: DbClient, env: StayMutationEnv): Promise<{ released: number; channel_push: SuccessfulChannelPush[] }> {
  const lapsed = await queryAll<{ hold_id: string; organization_id: string; product_id: string; check_in: string; check_out: string }>(db, `
    SELECT stay_nights.hold_id, stay_nights.organization_id, stay_nights.product_id, MIN(stay_nights.date) AS check_in, date(MAX(stay_nights.date), '+1 day') AS check_out
      FROM stay_nights WHERE ${LAPSED_HOLD_CLAIM_SQL}
     GROUP BY stay_nights.hold_id, stay_nights.organization_id, stay_nights.product_id LIMIT 100`)
  const pushes: SuccessfulChannelPush[] = []
  const failures: unknown[] = []
  let released = 0
  for (const hold of lapsed) {
    // The calendar already reads a lapsed claim as free, so the channel is told first; the claims
    // go only after completion. A failed hold retains its claims and reports
    // its error after every other independent hold has had its turn.
    try {
      const pushed = await pushStayHoldNights(db, env, hold.organization_id, hold.product_id, hold.check_in, hold.check_out)
      if (pushed) pushes.push(pushed)
      await executeBatch(db, [{ query: `DELETE FROM stay_nights WHERE hold_id = ? AND ${LAPSED_HOLD_CLAIM_SQL}`, params: [hold.hold_id] }], { operation: 'Release lapsed stay hold' })
      released += 1
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} lapsed stay holds could not be released. ${failures.map(error => error instanceof Error ? error.message : String(error)).join(' ')}`)
  return { released, channel_push: pushes }
}

/** What a captured checkout made a stay of: its frozen quote and the guest who paid. */
export interface CheckoutStay {
  quote: Pick<StayQuote, 'product_id' | 'check_in_date' | 'check_out_date' | 'adults' | 'children' | 'infants' | 'total_minor' | 'currency' | 'cancellation_policy'>
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
                guest_name, guest_email, guest_phone, user_id, total_minor, currency, notes, idempotency_key, booking_received_at, created_at, updated_at, cancellation_policy)
              SELECT ?, ?, ?, 'direct', 'app', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM payments WHERE id = ? AND organization_id = ? AND state = 'captured' AND refunded_amount = 0)`,
      params: [input.stayId, input.organizationId, quote.product_id, quote.check_in_date, quote.check_out_date, quote.adults, quote.children, quote.infants,
        guest.name, guest.email, guest.phone, input.buyerUserId, quote.total_minor, quote.currency, guest.notes, `checkout:${input.paymentId}`, input.now, input.now, input.now, quote.cancellation_policy,
        input.paymentId, input.organizationId],
    },
    organizationEventQuery({ organizationId: input.organizationId, locationId: input.locationId, actorId: null, eventType: 'stay.created', entityType: 'stay', entityId: input.stayId, metadata: { channel: 'direct', payment_id: input.paymentId }, onlyIfPreviousChangedOneRow: true }),
    ...reconcileNightsQueries(input.organizationId, input.stayId),
    ...stayThreadQueries({ organizationId: input.organizationId, stayId: input.stayId, now: input.now, openedBy: 'guest' }),
  ]
}

/** After a stay is made from a checkout: its scheduled messages, its channel and the screens showing it. */
export async function completeStayFromCheckout(db: DbClient, env: StayMutationEnv, organizationId: string, stayId: string): Promise<{ stay: Stay; channel_push: SuccessfulChannelPush | null }> {
  const stay = await storedStay(db, organizationId, stayId)
  await planStayMessages(db, organizationId, stayId)
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
  return completeChannelPush(channelPush, { product_id: stay.product_id, stay_id: stayId, version: stay.version, ranges: [[stay.check_in_date, stay.check_out_date]] }, async () => {
    await publishStayChange(env, db, organizationId, stay, true)
    return { stay }
  })
}

/** The stay a captured checkout made, read for its confirmation. */
export async function readCheckoutStay(db: DbClient, organizationId: string, stayId: string): Promise<Stay & { home: StayHome }> {
  const stay = await storedStay(db, organizationId, stayId)
  const [home] = await stayHomesWhere(db, organizationId, stay.product_id, { sql: '1 = 1', params: [] })
  if (!home) throw new Error(`Stay ${stayId} has no home`)
  return { ...stay, home }
}

/**
 * Linked calendars. A home listed on Vrbo links its Vrbo calendar by iCal
 * address: the nights Vrbo shows taken are claimed here like any stay's, so a
 * host stay or site checkout on them is refused, an Airbnb booking on them
 * lands overbooked, and Airbnb is told they are taken. Vrbo reads the home's
 * own taken nights from its export address. iCal carries dates only.
 */
export type StayCalendarChannel = 'vrbo'

export interface StayCalendarLink {
  channel: StayCalendarChannel
  /** The address KrabiClaw reads the Vrbo calendar from. */
  import_url: string
  /** The address to paste into Vrbo: this home's taken nights, other than Vrbo's own. */
  export_url: string
  /** When the Vrbo calendar was last read; null until the first read. */
  synced_at: string | null
  /** Why the last read failed; null when it succeeded or has not run. */
  sync_error: string | null
  /** Future nights Vrbo shows taken that another stay here already holds: double bookings for the host to resolve. */
  conflicts: string[]
}

interface StayCalendarLinkRow { id: string; organization_id: string; product_id: string; channel: StayCalendarChannel; import_url: string; export_token: string; blocked_json: string; synced_at: string | null; sync_error: string | null }

const CALENDAR_LINK_COLUMNS = 'id, organization_id, product_id, channel, import_url, export_token, blocked_json, synced_at, sync_error'

type CalendarLinkEnv = StayMutationEnv & { BETTER_AUTH_URL?: string }

/** The export address on the app's own origin. */
function exportUrl(env: CalendarLinkEnv, token: string): string {
  const origin = env.BETTER_AUTH_URL?.replace(/\/$/, '')
  if (!origin) fail(500, 'BETTER_AUTH_URL_REQUIRED', 'BETTER_AUTH_URL is required to address a calendar export', 'export_url')
  return `${origin}/api/public/stay-calendars/${token}.ics`
}

function blockedRanges(row: StayCalendarLinkRow): Array<[string, string]> {
  const parsed: unknown = JSON.parse(row.blocked_json)
  if (!Array.isArray(parsed) || !parsed.every(range => Array.isArray(range) && range.length === 2 && range.every(day => typeof day === 'string' && DATE.test(day)))) {
    fail(500, 'STAY_CALENDAR_LINK_INVALID', 'The linked calendar\'s saved nights are not readable', 'blocked_json')
  }
  return parsed as Array<[string, string]>
}

/** Each night of the ranges, from `from` (inclusive) to `to` (exclusive). */
function rangeNights(ranges: ReadonlyArray<readonly [string, string]>, from: string, to: string): string[] {
  const nights = new Set<string>()
  for (const [start, end] of ranges) {
    for (let night = start < from ? from : start; night < end && night < to; night = addDays(night, 1)) nights.add(night)
  }
  return [...nights].sort()
}

/** Consecutive nights as [start, end) ranges. */
function nightRuns(nights: readonly string[]): Array<[string, string]> {
  const runs: Array<[string, string]> = []
  for (const night of [...nights].sort()) {
    const last = runs.at(-1)
    if (last && last[1] === night) last[1] = addDays(night, 1)
    else runs.push([night, addDays(night, 1)])
  }
  return runs
}

async function calendarLinkView(db: DbClient, env: CalendarLinkEnv, row: StayCalendarLinkRow, timezone: string): Promise<StayCalendarLink> {
  const today = homeToday(timezone)
  const wanted = rangeNights(blockedRanges(row), today, addDays(today, MAX_CALENDAR_DAYS))
  const conflicts = wanted.length ? await queryAll<{ date: string }>(db, `SELECT date FROM stay_nights
      WHERE organization_id = ? AND product_id = ? AND date IN (SELECT value FROM json_each(?)) AND calendar_link_id IS NOT ?
        AND NOT (${LAPSED_HOLD_CLAIM_SQL}) ORDER BY date`, [row.organization_id, row.product_id, JSON.stringify(wanted), row.id]) : []
  return {
    channel: row.channel, import_url: row.import_url, export_url: exportUrl(env, row.export_token),
    synced_at: row.synced_at, sync_error: row.sync_error, conflicts: conflicts.map(night => night.date),
  }
}

async function homeCalendarLink(db: DbClient, organizationId: string, productId: string): Promise<StayCalendarLinkRow | null> {
  return queryFirst<StayCalendarLinkRow>(db, `SELECT ${CALENDAR_LINK_COLUMNS} FROM stay_calendar_links WHERE organization_id = ? AND product_id = ? AND channel = 'vrbo'`, [organizationId, productId])
}

/** The home's linked Vrbo calendar; null when the home has none. */
export async function readStayCalendarLink(db: DbClient, env: CalendarLinkEnv, access: StayAccess, productId: string): Promise<StayCalendarLink | null> {
  // Both addresses are credentials to the calendars; only a manager sees them.
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  const row = await homeCalendarLink(db, access.organizationId, home.product_id)
  return row ? calendarLinkView(db, env, row, home.timezone) : null
}

/** An iCal DATE value (RFC 5545 3.3.4) as YYYY-MM-DD. */
function icalDate(line: string): string {
  const value = line.slice(line.indexOf(':') + 1).trim()
  const params = line.slice(0, line.indexOf(':')).split(';').slice(1)
  if (params.some(param => /^VALUE=/i.test(param) && param.toUpperCase() !== 'VALUE=DATE') || !/^\d{8}$/.test(value)) {
    throw new Error(`The calendar has a time where a date belongs (${line.slice(0, 80)}); only all-day dates are read`)
  }
  const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error(`The calendar has an invalid date (${value})`)
  return day
}

/** The [start, end) date ranges of an iCal calendar's events, other than cancelled ones. */
export function parseIcalRanges(text: string): Array<[string, string]> {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  if (lines[0]?.trim() !== 'BEGIN:VCALENDAR') throw new Error('The address did not return an iCal calendar')
  const ranges: Array<[string, string]> = []
  let event: { start?: string; end?: string; cancelled: boolean } | null = null
  let closed = false
  for (const line of lines) {
    if (line === 'END:VCALENDAR') { closed = true; break }
    const name = line.split(/[;:]/, 1)[0]!.toUpperCase()
    if (line === 'BEGIN:VEVENT') event = { cancelled: false }
    else if (!event) continue
    else if (name === 'DTSTART') event.start = icalDate(line)
    else if (name === 'DTEND') event.end = icalDate(line)
    else if (name === 'STATUS') event.cancelled = line.slice(line.indexOf(':') + 1).trim().toUpperCase() === 'CANCELLED'
    else if (line === 'END:VEVENT') {
      if (!event.start) throw new Error('The calendar has an event without a start date')
      // RFC 5545 3.6.1: an all-day event without DTEND lasts its start day.
      const end = event.end ?? addDays(event.start, 1)
      if (end <= event.start) throw new Error(`The calendar has an event ending before it starts (${event.start})`)
      if (!event.cancelled) ranges.push([event.start, end])
      event = null
    }
  }
  if (event || !closed) throw new Error('The calendar ended before END:VCALENDAR; it was not read whole')
  return ranges
}

/**
 * Read the linked Vrbo calendar and claim the nights it shows taken from today
 * on; nights it no longer shows are released. Airbnb is told the nights that
 * changed. A failed read is recorded on the link and thrown; the earlier
 * claims stay, as the last calendar Vrbo served.
 */
async function syncCalendarLink(db: DbClient, env: CalendarLinkEnv, row: StayCalendarLinkRow): Promise<StayCalendarLink & { channel_push: SuccessfulChannelPush | null }> {
  const access: StayAccess = { organizationId: row.organization_id, actorId: 'system', manage: true }
  const home = await readStayHome(db, access, row.product_id)
  const recordFailure = async (message: string, code: string, cause?: unknown): Promise<never> => {
    await execute(db, 'UPDATE stay_calendar_links SET sync_error = ?, updated_at = ? WHERE id = ? AND import_url = ? AND synced_at IS ?', [message, new Date().toISOString(), row.id, row.import_url, row.synced_at])
    throw new HTTPError({ statusCode: 502, message: `The Vrbo calendar could not be read. ${message}`, data: { code, field: 'import_url', product_id: row.product_id, committed: true }, cause })
  }
  let ranges: Array<[string, string]>
  try {
    const response = await fetch(row.import_url, { headers: { accept: 'text/calendar' } })
    if (!response.ok || !response.body) return await recordFailure(`Vrbo answered HTTP ${response.status}${response.body ? '' : ' with no calendar'}.`, 'STAY_CALENDAR_READ_FAILED')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength
      if (size > MAX_CALENDAR_BYTES) {
        await reader.cancel()
        return await recordFailure(`The calendar is larger than ${MAX_CALENDAR_BYTES / 1_000_000} MB.`, 'STAY_CALENDAR_TOO_LARGE')
      }
      chunks.push(part.value)
    }
    const body = new Uint8Array(size)
    chunks.reduce((offset, chunk) => { body.set(chunk, offset); return offset + chunk.byteLength }, 0)
    ranges = parseIcalRanges(new TextDecoder().decode(body))
  } catch (error) {
    if (error instanceof HTTPError) throw error
    return await recordFailure(error instanceof Error ? error.message : String(error), 'STAY_CALENDAR_INVALID', error)
  }
  const today = homeToday(home.timezone)
  const nights = rangeNights(ranges, today, addDays(today, MAX_CALENDAR_DAYS))
  const claimed = async () => (await queryAll<{ date: string }>(db, 'SELECT date FROM stay_nights WHERE calendar_link_id = ? ORDER BY date', [row.id])).map(night => night.date)
  const before = await claimed()
  const now = new Date().toISOString()
  const wanted = JSON.stringify(nights)
  // Every write applies only while the link still holds the address and last read this read
  // started from, so a slower read (of a replaced address, or one another read overtook)
  // changes nothing and tells no channel.
  const current = 'EXISTS (SELECT 1 FROM stay_calendar_links WHERE id = ? AND import_url = ? AND synced_at IS ?)'
  const guard = [row.id, row.import_url, row.synced_at]
  const results = await executeBatch(db, [
    { query: `DELETE FROM stay_nights WHERE product_id = ? AND date IN (SELECT value FROM json_each(?)) AND ${LAPSED_HOLD_CLAIM_SQL} AND ${current}`, params: [row.product_id, wanted, ...guard] },
    { query: `DELETE FROM stay_nights WHERE calendar_link_id = ? AND date NOT IN (SELECT value FROM json_each(?)) AND ${current}`, params: [row.id, wanted, ...guard] },
    {
      query: `INSERT INTO stay_nights (organization_id, product_id, date, calendar_link_id) SELECT ?, ?, value, ? FROM json_each(?) WHERE ${current}
              ON CONFLICT (product_id, date) DO NOTHING`,
      params: [row.organization_id, row.product_id, row.id, wanted, ...guard],
    },
    { query: 'UPDATE stay_calendar_links SET blocked_json = ?, synced_at = ?, sync_error = NULL, updated_at = ? WHERE id = ? AND import_url = ? AND synced_at IS ?', params: [JSON.stringify(ranges), now, now, ...guard] },
  ], { operation: 'Sync linked calendar' })
  const applied = results[3]?.meta.changes
  if (applied !== 0 && applied !== 1) fail(500, 'STAY_CALENDAR_WRITE_RESULT_REQUIRED', 'The linked calendar write did not report its affected row count', 'changes')
  const after = await claimed()
  const changed = nightRuns([...before.filter(night => !after.includes(night)), ...after.filter(night => !before.includes(night))])
  const saved = await homeCalendarLink(db, row.organization_id, row.product_id)
  if (!saved) fail(409, 'STAY_CALENDAR_LINK_REMOVED', 'The linked calendar was removed while it was being read', 'import_url')
  // Another read finished first and owns the claims and their channel push.
  if (applied === 0) return { ...await calendarLinkView(db, env, saved, home.timezone), channel_push: null }
  if (!changed.length) return { ...await calendarLinkView(db, env, saved, home.timezone), channel_push: null }
  const channelPush = await pushNights(db, env, access, row.product_id, changed)
  return completeChannelPush(channelPush, { product_id: row.product_id, updated_at: now, ranges: changed }, async () => {
    await publishStayInvalidation(env, { type: 'nights.changed', organizationId: row.organization_id, locationId: home.location_id, productId: row.product_id, stayId: null }, { updated_at: now })
    return calendarLinkView(db, env, saved, home.timezone)
  })
}

/** Link the home's Vrbo calendar, or change its address, and read it now. */
export async function setStayCalendarLink(db: DbClient, env: CalendarLinkEnv, access: StayAccess, productId: string, input: Record<string, unknown>): Promise<StayCalendarLink & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  const url = typeof input.import_url === 'string' ? input.import_url.trim() : ''
  const parsed = url.length <= 2000 && URL.canParse(url) ? new URL(url) : null
  if (!parsed || parsed.protocol !== 'https:') fail(422, 'INVALID_STAY_CALENDAR_URL', 'import_url must be the https iCal address Vrbo shows under Calendar sync (Export calendar)', 'import_url')
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  const now = new Date().toISOString()
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  await executeBatch(db, [
    {
      query: `INSERT INTO stay_calendar_links (id, organization_id, product_id, channel, import_url, export_token, created_at, updated_at, created_by, updated_by)
              VALUES (?, ?, ?, 'vrbo', ?, ?, ?, ?, ?, ?)
              ON CONFLICT (product_id, channel) DO UPDATE SET import_url = excluded.import_url, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      params: [crypto.randomUUID(), access.organizationId, home.product_id, parsed.href, token, now, now, access.actorId, access.actorId],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.calendar_linked', entityType: 'product', entityId: home.product_id, metadata: { channel: 'vrbo' } }),
  ], { operation: 'Link stay calendar' })
  const row = await homeCalendarLink(db, access.organizationId, home.product_id)
  if (!row) fail(500, 'STAY_CALENDAR_LINK_NOT_READABLE', 'The linked calendar could not be read back', 'import_url')
  return syncCalendarLink(db, env, row)
}

/** Unlink the home's Vrbo calendar: its nights are released and Airbnb is told. */
export async function removeStayCalendarLink(db: DbClient, env: StayMutationEnv, access: StayAccess, productId: string): Promise<{ channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  const row = await homeCalendarLink(db, access.organizationId, home.product_id)
  if (!row) fail(404, 'STAY_CALENDAR_LINK_NOT_FOUND', 'This home has no linked Vrbo calendar', 'product_id')
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  const released = (await queryAll<{ date: string }>(db, 'SELECT date FROM stay_nights WHERE calendar_link_id = ? ORDER BY date', [row.id])).map(night => night.date)
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: 'DELETE FROM stay_calendar_links WHERE id = ?', params: [row.id] },
    organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.calendar_unlinked', entityType: 'product', entityId: home.product_id, metadata: { channel: row.channel } }),
  ], { operation: 'Unlink stay calendar' })
  const ranges = nightRuns(released)
  const channelPush = ranges.length ? await pushNights(db, env, access, home.product_id, ranges) : null
  return completeChannelPush(channelPush, { product_id: home.product_id, updated_at: now, ranges }, async () => {
    if (ranges.length) await publishStayInvalidation(env, { type: 'nights.changed', organizationId: access.organizationId, locationId: home.location_id, productId: home.product_id, stayId: null }, { updated_at: now })
    return {}
  })
}

/** Read every linked calendar at once, so a slow site holds up no other; failures are reported after all have finished. */
export async function syncStayCalendarLinks(db: DbClient, env: CalendarLinkEnv): Promise<{ synced: number }> {
  const rows = await queryAll<StayCalendarLinkRow>(db, `SELECT ${CALENDAR_LINK_COLUMNS} FROM stay_calendar_links`)
  const failures = (await Promise.allSettled(rows.map(row => syncCalendarLink(db, env, row))))
    .flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, `${failures.length} of ${rows.length} linked calendars could not be synced. ${failures.map(error => error instanceof Error ? error.message : String(error)).join(' ')}`)
  return { synced: rows.length }
}

/**
 * The home's taken nights, from today, as the iCal calendar Vrbo reads from
 * the export address. Nights the Vrbo calendar itself holds are left out, so
 * Vrbo never reads its own bookings back. Nothing about the guest is shown.
 */
export async function stayCalendarExport(db: DbClient, token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404, 'STAY_CALENDAR_NOT_FOUND', 'This calendar address does not exist', 'token')
  const row = await queryFirst<StayCalendarLinkRow>(db, `SELECT ${CALENDAR_LINK_COLUMNS} FROM stay_calendar_links WHERE export_token = ?`, [token])
  if (!row) fail(404, 'STAY_CALENDAR_NOT_FOUND', 'This calendar address does not exist', 'token')
  const [home] = await stayHomesWhere(db, row.organization_id, row.product_id, { sql: '1 = 1', params: [] })
  if (!home) fail(404, 'STAY_CALENDAR_NOT_FOUND', 'This calendar address does not exist', 'token')
  const today = homeToday(home.timezone)
  const nights = await homeNights(db, row.organization_id, home, today, addDays(today, MAX_CALENDAR_DAYS))
  const taken = nights.filter(night => !night.available && night.calendar !== row.channel).map(night => night.date)
  const compact = (day: string) => day.replaceAll('-', '')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KrabiClaw//Stay calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...nightRuns(taken).flatMap(([start, end]) => [
      'BEGIN:VEVENT', `UID:${row.product_id}-${compact(start)}@krabiclaw.com`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(start)}`, `DTEND;VALUE=DATE:${compact(end)}`, 'SUMMARY:Not available', 'END:VEVENT',
    ]),
    'END:VCALENDAR', '',
  ].join('\r\n')
}
