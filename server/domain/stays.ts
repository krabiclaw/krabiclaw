import { HTTPError } from 'nitro'
import { notifyStayReady, stayReadyRevisionQueries, stayReadyTaskQueries, turnoverTaskQueries } from '~/server/domain/tasks'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { formAnswersFingerprint, formAnswerSnapshotsSchema, formQuestionsRevision, parseStoredFormQuestions, type FormAnswerSnapshot, type FormQuestion } from '~/shared/form-questions'
import { acceptFormAnswers } from '~/server/domain/form-questions'
import { MAX_STAY_NIGHTS, NIGHT_PRICE_CHANGE_PERCENT, STAY_CALENDAR_DAYS, changeNightPrice, parseStayCalendarRules, resolveStayNightPolicy, type StayCalendarRules, STAY_CHANNELS, STAY_CHANNEL_LABELS, isChannelManagedStay, STAY_PAYMENT_METHODS, stayGuestFirstName, type StayChannel, type StayPaymentMethod } from '~/shared/bookings'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { d1JsonStringSet, execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedMemberSql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery, type OrganizationEvent } from '~/server/utils/organization-events'
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
import { stayNightlyGroups, AIRBNB_CANCELLATION_CATEGORIES, AIRBNB_LONG_TERM_CANCELLATION_IDS, isStayAmenity, parseStayAmenityAnswers, parseStayMapSharing, STAY_ALARM_DETAIL_KEYS, STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES, type StayAmenityAnswer, type StayMapSharing, STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS, type StayAmenity, type StayCancellationPolicy, type StayCheckInMethod, type StayCheckoutTask, type StayListingType, type StayLongTermCancellationPolicy, type StayPropertySizeUnit, type StayPropertyType, type StayPropertyTypeGroup } from '~/shared/stay-listing'
import { validateProductDetails, validateStayAlarmDetails, stayHouseRuleLines } from '~/shared/product-details'
import { staySafetyLines, stayAlarmLines } from '~/shared/stay-safety'
import { formatCalendarDate, formatTime, formatTimestamp, isValidTimezone, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { createProduct, getProduct, readStayCalendarRules, setProductPublication, stayImportWrittenQuery, stayWeekendPriceSql, updateProduct, type StayImportWrite } from '~/server/utils/product-management'
import type { Product, UpdateProductInput } from '~/server/types/products'
import { createGuestUser, type CloudflareEnv } from '~/server/utils/auth'
import { currencyFractionDigits, isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { selectPrice, type Price, type PriceTaxBehavior } from '~/shared/prices'
import type { ChannexEnv } from '~/server/integrations/channex/client'
import { completeChannelPush, configureStayCalendar, deliverStayNights, pushAirbnbListingSettings, pushStayCalendar, pushStayNights, requireChannelPush, type AirbnbListingSettings, type ChannelPushCompletion, type ChannexMapping } from '~/server/integrations/channex/ari'
import type { ChannelPush, SuccessfulChannelPush } from '~/shared/channel-push'
import { bookingContactQuery, bookingConversationQueries, bookingDay, isBookingDay, nightsBoundary } from '~/server/domain/requests'
import { bookingPolicy, type BookingPolicy } from '~/server/utils/booking-policy-summary'
import { requireBookingConfig } from '~/server/utils/availability'
import { openingMessageQueries, openingSentence } from '~/server/domain/guest-threads/opening'
import { ownedBuyerRequest } from '~/server/domain/payments/buyer'
import { publishBusinessInvalidation, publishConversationEvent, publishStayInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { planHomeMessages, planSourceMessages } from '~/server/domain/scheduled-guest-messages'
import { listingCalendar } from '~/server/integrations/channex/airbnb-listing'
import { joinBookingConversationQueries } from '~/server/domain/guest-threads/channel-messages'
import { toE164 } from '~/utils/phone'
import { arrangeProductPhotos, readProductPhotos, readStayHomeAccessibility, readStayPhotoRooms, type MediaPlacementItem } from '~/server/utils/media-placement'
import { addStayPhotoRoomPlacementsQuery, buildDeleteOwnerPlacementsQuery, deleteMediaAsset, getMediaAsset, updateMediaAssetMetadata } from '~/server/utils/media-asset-manager'
import { sanitizeFilename, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, sniffMediaMimeType } from '~/server/utils/media-mime'
import { mediaStillUrl, MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'
import { isStayPhotoRoomType, isStaySleepingArrangements, MAX_STAY_BEDS_PER_TYPE, type StayPhotoRoom, type StayPhotoRoomType } from '~/shared/stay-photos'
import { isStayHomeAccessibility, isStayRoomAccessibility, type StayHomeAccessibility, type StayRoomAccessibility } from '~/shared/stay-accessibility'
import { publicResourceCacheInvalidationQuery, purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { requireStays } from '~/server/utils/cms-capabilities'

/**
 * Places to stay: homes, their nights, and the nights unit of a booking. A
 * stay is a `bookings` row with no session whose product is a home; it holds
 * the nights [check-in, checkout) at that home. Its night claims (stay_nights)
 * are written in the same batch as the booking, so the primary key on
 * (product_id, date) is the overlap guard: two writes for one night cannot
 * both commit. Dashboard routes, MCP tools and the native app's API all call
 * these functions; none of them reads or writes the tables directly.
 */

/** Who is asking: managers act on every home; assigned members read the homes they look after. */
export type StayAccess = { organizationId: string; actorId: string; audit?: OrganizationEvent['context'] } & ({ manage: true } | { manage: false; userId: string })
type StayMutationEnv = ChannexEnv & GuestInboxPublicationEnv

/** Resolve a member's stay access from their Better Auth role: operations update manages, operations assigned reads assigned homes. */
export async function stayAccessFor(principal: MemberAccessPrincipal): Promise<StayAccess> {
  if (await roleAllows({ ...principal, permissions: { operations: ['update'] } })) return { organizationId: principal.organizationId, actorId: principal.userId, manage: true }
  await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
  return { organizationId: principal.organizationId, actorId: principal.userId, manage: false, userId: principal.userId }
}

export const STAY_STATUSES = ['pending', 'confirmed', 'cancelled'] as const

/** A nights booking: a booking at a home, read with its check-in and checkout days in the home's clock. */
export interface Stay {
  /** The listing a channel reservation is booked on when the host moved the guest elsewhere; null when they sleep where they booked. */
  booked_product_id: string | null
  /** That listing's name for the host; null when they sleep where they booked. */
  booked_home_name: string | null
  id: string
  product_id: string
  location_id: string
  /** The home's location timezone: its dates and times are read in it. */
  timezone: string
  channel: StayChannel
  owner: 'app' | 'channel'
  status: typeof STAY_STATUSES[number]
  overbooked: boolean
  /** When the guest arrives and leaves: instants, or the day alone where the home had no check-in or checkout time. */
  starts_at: string
  ends_at: string
  /** The check-in and checkout days in the home's clock. */
  check_in_date: string
  check_out_date: string
  adults: number
  children: number
  infants: number
  party_size: number
  /** The guest as their conversation names them; null for a channel conversation that named no one. */
  guest_name: string | null
  guest_email: string | null
  guest_phone: string | null
  user_id: string | null
  total_minor: number
  currency: string
  /** The host's own note, never shown to the guest. */
  private_notes: string | null
  provider: 'channex' | null
  external_booking_id: string | null
  channel_booking_id: string | null
  /** The reservation on its channel's host pages, from its confirmation code; null where the channel has none KrabiClaw links to. */
  channel_booking_url: string | null
  /** The guest conversation in the inbox; every booking has one. */
  conversation_id: string
  cancelled_at: string | null
  cancellation_reason: string | null
  /** The policy a guest booked under on the site; null for a stay not paid there. */
  cancellation_policy: StayBookedPolicy | null
  /** Staff recorded the guest did not arrive; their review invitation is never sent. */
  no_show_at: string | null
  /** The guest's answers to the home's questions, worded as they answered them; empty when none were asked. */
  answers: FormAnswerSnapshot[]
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
export const STAY_TURNOVER_FIELDS = ['id', 'product_id', 'location_id', 'timezone', 'status', 'starts_at', 'ends_at', 'check_in_date', 'check_out_date', 'adults', 'children', 'infants', 'guest_name', 'no_show_at'] as const
export type StayTurnover = Pick<Stay, typeof STAY_TURNOVER_FIELDS[number]>

export function stayTurnover(stay: Stay): StayTurnover {
  const turnover = Object.fromEntries(STAY_TURNOVER_FIELDS.map(field => [field, stay[field]])) as StayTurnover
  return { ...turnover, guest_name: stayGuestFirstName(stay.guest_name) }
}

export interface StayPayment {
  id: string
  booking_id: string
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
  /** The home's one variant, its nightly offer: what each of its bookings names. */
  variant_id: string
  /** The Product version used when saving listing accessibility. */
  product_updated_at: string
  /** Public listing title, independently editable from the operator name. */
  name: string
  internal_name: string
  location_id: string
  timezone: string
  currency: CurrencyCode
  base_price_minor: number | null
  /** How tax relates to the base nightly price; null when the home has no base price. */
  base_price_tax_behavior: PriceTaxBehavior | null
  check_in_time: string | null
  /** The end of the check-in window, local HH:MM; null is a flexible end. Earlier than check_in_time is after midnight. */
  check_in_end_time: string | null
  check_out_time: string | null
  max_guests: number
  min_nights: number
  calendar_rules: StayCalendarRules | null
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
  /** The member (member.id) who looks after the home; that member sees its stays. */
  assigned_member_id: string | null
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
  /** The host's own questions asked with each direct stay, and the revision a form built from them carries. */
  questions: FormQuestion[]
  questions_revision: string
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
  booking_id: string | null
  closed: boolean
  price_minor: number | null
  min_stay_arrival: number
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
/** Every home's nights at once: three months, a window a multi-calendar pages through. */
export const MAX_HOMES_CALENDAR_DAYS = 92
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

function count(value: unknown, field: string, min: number, max = 99): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(422, 'INVALID_STAY_FIELD', `${field} must be a whole number from ${min} to ${max}`, field)
  return value
}

function amount(value: unknown, field: string, allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!allowNegative && value < 0)) fail(422, 'INVALID_AMOUNT', `${field} must be a whole number of minor units${allowNegative ? '' : ' of at least 0'}`, field)
  return value
}

/** A nights booking at its home, with its conversation's guest contact: `s` is the booking. */
const STAY_FROM = `bookings s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
  JOIN conversations r ON r.organization_id = s.organization_id AND r.booking_id = s.id AND r.kind = 'booking'`
const STAY_COLUMNS = `s.id, s.product_id, s.booked_product_id, (SELECT b.internal_name FROM product_stay_configs b WHERE b.organization_id = s.organization_id AND b.product_id = s.booked_product_id) AS booked_home_name, s.location_id, s.timezone, s.channel, s.owner, s.status, s.overbooked, s.starts_at, s.ends_at,
  s.adults, s.children, s.infants, s.party_size, json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email, json_extract(r.payload_json, '$.guest.phone') AS guest_phone,
  s.user_id, s.total_minor, s.currency, s.private_notes, s.provider, s.external_booking_id, s.channel_booking_id, r.id AS conversation_id, s.cancelled_at, s.cancellation_reason,
  json_extract(s.policy_json, '$.cancellation') AS cancellation_policy, s.no_show_at, s.answers, s.version, s.created_at, s.updated_at`

function mapStay(row: Record<string, unknown>): Stay {
  const code = row.channel_booking_id
  const timezone = String(row.timezone)
  if (row.adults === null || row.children === null || row.infants === null || row.total_minor === null || row.currency === null) throw new Error(`Stay ${String(row.id)} has no party breakdown or total`)
  return { ...row, overbooked: Number(row.overbooked) === 1, answers: formAnswerSnapshotsSchema.parse(JSON.parse(String(row.answers))),
    check_in_date: bookingDay(String(row.starts_at), timezone), check_out_date: bookingDay(String(row.ends_at), timezone),
    channel_booking_url: row.channel === 'airbnb' && typeof code === 'string' ? `https://www.airbnb.com/hosting/reservations/details/${encodeURIComponent(code)}` : null } as unknown as Stay
}

/** The SQL bounds of [from, to) days a stay's stored ends can fall in, widened for ends stored as instants; rows are then kept by their days. */
function stayOverlapSql(from: string, to: string): { sql: string; params: string[] } {
  return { sql: `s.starts_at < ? AND s.ends_at > ?`, params: [`${addDays(to, 1)}T14:00:00.000Z`, `${addDays(from, -1)}T10:00:00.000Z`] }
}

function staysOverlap(stay: Pick<Stay, 'check_in_date' | 'check_out_date'>, from: string, to: string): boolean {
  return stay.check_in_date < to && stay.check_out_date > from
}

/** A channel's stay is changed on its channel: refused, linking to the reservation there when KrabiClaw can. */
function channelOwned(stay: Stay, state: 'belongs to' | 'is paid through'): never {
  const url = stay.channel_booking_url
  fail(409, 'STAY_NOT_EDITABLE', url ? `This stay ${state} ${STAY_CHANNEL_LABELS[stay.channel]}; change it there: ${url}` : `This stay ${state} its channel; change it there`, undefined, { channel_booking_url: url })
}

/** The SQL that limits rows to homes this caller may see, and its parameters. */
function visibleHomes(access: StayAccess, alias = 'c'): { sql: string; params: string[] } {
  return access.manage ? { sql: '1 = 1', params: [] } : {
    sql: `EXISTS (SELECT 1 FROM product_booking_configs looked_after WHERE looked_after.organization_id = ${alias}.organization_id AND looked_after.product_id = ${alias}.product_id AND ${assignedMemberSql('looked_after')})`,
    params: [access.userId],
  }
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
    SELECT p.id AS product_id, (SELECT json_group_array(v.id) FROM product_variants v WHERE v.organization_id = c.organization_id AND v.product_id = c.product_id) AS variant_ids, p.updated_at AS product_updated_at, p.name, c.internal_name, p.description, p.details_json, c.location_id, l.timezone, l.address, l.latitude, l.longitude, l.stay_map_sharing, o.default_currency,
           b.check_in_time, b.check_in_end_time, b.check_out_time, b.default_capacity AS max_guests, b.min_nights, b.calendar_rules, ${stayWeekendPriceSql('c')} AS weekend_price_minor, c.property_type_group, c.property_type,
           c.listing_type, c.total_floors, c.listing_floor, c.year_built, c.property_size, c.property_size_unit, c.bedrooms, c.beds, c.bathrooms, c.amenities,
           b.cancellation_policy, b.long_term_cancellation_policy, c.check_in_method, c.check_in_instructions, c.wifi_network, c.wifi_password,
           c.directions, c.house_manual, c.checkout_instructions, b.assigned_member_id, b.questions,
           COALESCE((SELECT pp.published FROM product_publications pp WHERE pp.organization_id = c.organization_id AND pp.product_id = c.product_id), 0) AS published,
           ${liveHomeSql('p')} AS live, m.enabled AS channel_enabled, m.import_stage AS channel_stage, m.listing_id AS airbnb_listing_id
      FROM product_stay_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN product_channel_mappings m ON m.organization_id = c.organization_id AND m.product_id = c.product_id AND m.provider = 'channex'
     WHERE c.organization_id = ? ${productId !== null ? 'AND c.product_id = ?' : ''} AND ${scope.sql}
     ORDER BY c.internal_name, p.id`, [organizationId, ...(productId !== null ? [productId] : []), ...scope.params])
  if (!rows.length) return []
  const prices = await queryAll<Price & { product_id: string }>(db, `
    SELECT pr.*, v.product_id FROM prices pr
      JOIN product_variants v ON v.organization_id = pr.organization_id AND v.id = pr.product_variant_id
      JOIN product_stay_configs c ON c.organization_id = v.organization_id AND c.product_id = v.product_id
     WHERE pr.organization_id = ? ${productId ? 'AND v.product_id = ?' : ''} AND v.active = 1 AND pr.stay_date IS NULL AND pr.weekend = 0
     ORDER BY v.sort_order, v.id`, [organizationId, ...(productId ? [productId] : [])])
  const productIds = rows.map(row => String(row.product_id))
  const [photos, photoRooms, accessibility] = await Promise.all([
    readProductPhotos(db, { organizationId, productIds }),
    readStayPhotoRooms(db, organizationId, productIds),
    readStayHomeAccessibility(db, organizationId, productIds),
  ])
  return rows.map((row) => {
    if (typeof row.internal_name !== 'string' || !row.internal_name.trim()) throw new Error(`Home ${row.product_id} has no internal name`)
    const variants = JSON.parse(String(row.variant_ids)) as string[]
    if (variants.length !== 1) throw new Error(`Home ${row.product_id} has ${variants.length} variants; a home has exactly one`)
    const amenityAnswers = parseStayAmenityAnswers(JSON.parse(String(row.amenities)))
    const details = validateProductDetails('stay', JSON.parse(String(row.details_json)))
    validateStayAlarmDetails(details, amenityAnswers)
    if (!isCurrencyCode(row.default_currency)) throw new Error(`Organization ${organizationId} has an unsupported default currency`)
    const own = prices.filter(price => price.product_id === row.product_id).map(price => ({ ...price, active: Number(price.active) === 1 }))
    const base = selectPrice(own, { currency: row.default_currency, location_id: String(row.location_id) })
    return {
      product_id: String(row.product_id), variant_id: variants[0]!, product_updated_at: String(row.product_updated_at), name: String(row.name), internal_name: String(row.internal_name), location_id: String(row.location_id), timezone: String(row.timezone),
      currency: row.default_currency, base_price_minor: base ? base.unit_amount : null, base_price_tax_behavior: base ? base.tax_behavior : null,
      check_in_time: nullableText(row.check_in_time), check_in_end_time: nullableText(row.check_in_end_time), check_out_time: nullableText(row.check_out_time), max_guests: Number(row.max_guests), min_nights: Number(row.min_nights), calendar_rules: readStayCalendarRules(row.calendar_rules, row.weekend_price_minor),
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
      ...(() => { const questions = parseStoredFormQuestions(String(row.questions)); return { questions, questions_revision: formQuestionsRevision(questions) } })(),
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
  await requireStays(db, access.organizationId)
  return await stayHomes(db, access, null)
}

export async function readStayHome(db: DbClient, access: StayAccess, productId: string): Promise<StayHome> {
  const [home] = await stayHomes(db, access, productId)
  if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  return home
}

/** A new place to stay: the location it is at and its stay rules, checked. */
export interface NewStayHome {
  internal_name?: string
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
  check_in_time: string | null
  /** Null is a flexible end. */
  check_in_end_time: string | null
  check_out_time: string | null
  max_guests: number
  min_nights: number
  calendar_rules?: StayCalendarRules | null
  base_price_minor: number | null
  /** Left out, a new home starts on Airbnb's own: NEW_HOME_CANCELLATION_POLICIES. */
  cancellation_policy?: StayCancellationPolicy | null
  long_term_cancellation_policy?: StayLongTermCancellationPolicy | null
  /** The member (member.id) who looks after the home and handles its stays. */
  assigned_member_id: string
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
    name: (required: boolean) => text('name', PRODUCT_LIMITS.name, required),
    maxGuests: (required: boolean) => whole('max_guests', 1, 99, required),
    minNights: (required: boolean) => whole('min_nights', 1, MAX_STAY_NIGHTS, required),
    basePrice: () => whole('base_price_minor', 0, Number.MAX_SAFE_INTEGER, false),
  }
}

/** Read a new home's details from a request body; each problem names its field. */
export function stayHomeInput(body: Record<string, unknown>): NewStayHome {
  const { text, timezone, time, name, maxGuests, minNights, basePrice } = homeDetails(body)
  const policy = <K extends 'cancellation_policy' | 'long_term_cancellation_policy'>(key: K, codes: Record<NonNullable<NewStayHome[K]>, unknown>): Partial<Pick<NewStayHome, K>> => {
    const value = body[key]
    if (value === undefined) return {}
    if (value === null) return { [key]: null } as Partial<Pick<NewStayHome, K>>
    if (typeof value !== 'string' || !Object.hasOwn(codes, value)) fail(422, 'INVALID_DETAIL', `${key} must be one of ${Object.keys(codes).join(', ')}`, key)
    return { [key]: value } as Partial<Pick<NewStayHome, K>>
  }
  const home: NewStayHome = {
    name: name(true)!, ...(Object.hasOwn(body, 'internal_name') ? { internal_name: text('internal_name', PRODUCT_LIMITS.name, true)! } : {}), timezone: timezone(true)!,
    ...homeAddress(body, ''),
    phone: text('phone', 32, false), email: text('email', 254, false),
    check_in_time: time('check_in_time', false), check_in_end_time: time('check_in_end_time', false), check_out_time: time('check_out_time', false),
    max_guests: maxGuests(true)!, min_nights: minNights(true)!,
    ...('calendar_rules' in body ? { calendar_rules: homeCalendarRules(body.calendar_rules) } : {}),
    base_price_minor: basePrice(),
    // Left out, the product writer gives a new home Airbnb's own; an empty one is refused before the location is made.
    ...policy('cancellation_policy', STAY_CANCELLATION_POLICIES),
    ...policy('long_term_cancellation_policy', STAY_LONG_TERM_CANCELLATION_POLICIES),
    assigned_member_id: text('assigned_member_id', 200, true)!,
  }
  if (home.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(home.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email', 'email')
  return home
}

function homeCalendarRules(value: unknown): StayCalendarRules | null {
  try { return parseStayCalendarRules(value) }
  catch (error) {
    if (!(error instanceof TypeError)) throw error
    fail(422, 'INVALID_DETAIL', error.message, 'calendar_rules')
  }
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
const EDITABLE_HOME_FIELDS = ['internal_name', 'name', 'description', 'published', 'timezone', 'check_in_time', 'check_in_end_time', 'check_out_time', 'max_guests', 'min_nights', 'calendar_rules', 'base_price_minor',
  'assigned_member_id', 'questions', 'expected_questions_revision', ...LISTING_FIELDS, ...Object.values(STAY_ALARM_DETAIL_KEYS), ...ARRIVAL_FIELDS, ...LOCATION_FIELDS] as const

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
 * is a member (member.id) of this organization, or null. On a
 * connected home, a new base price or minimum stay is pushed for the nights
 * ahead, because nights without their own value use them.
 */
export async function updateStayHome(env: CloudflareEnv, db: DbClient, access: StayAccess, productId: string, body: Record<string, unknown>, stayImport?: StayImportWrite): Promise<{ home: StayHome; channel_push: SuccessfulChannelPush | null; airbnb_unsynced: ReturnType<typeof airbnbUnsynced> }> {
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  const unknown = Object.keys(body).find(key => !(EDITABLE_HOME_FIELDS as readonly string[]).includes(key))
  if (unknown) fail(422, 'INVALID_DETAIL', `${unknown} cannot be changed here`, unknown)
  if (!Object.keys(body).length) fail(422, 'INVALID_DETAIL', 'Name at least one detail to change')
  for (const key of ['internal_name', 'name', 'timezone', 'max_guests', 'min_nights'] as const) {
    const value = body[key]
    if (key in body && (value === null || (typeof value === 'string' && !value.trim()))) fail(422, 'INVALID_DETAIL', `${key} cannot be empty`, key)
  }
  const { timezone, time, name, maxGuests, minNights, basePrice } = homeDetails(body)
  // Every field is checked before anything is written.
  const zone = timezone(false)
  const stay: NonNullable<UpdateProductInput['stay']> = {}
  if ('internal_name' in body) {
    if (typeof body.internal_name !== 'string' || !body.internal_name.trim() || body.internal_name.trim().length > PRODUCT_LIMITS.name) fail(422, 'INVALID_DETAIL', `internal_name must contain 1 to ${PRODUCT_LIMITS.name} characters`, 'internal_name')
    stay.internal_name = body.internal_name.trim()
  }
  if ('check_in_time' in body) stay.check_in_time = time('check_in_time', false)
  // null is a real value here: the check-in window has a flexible end.
  if ('check_in_end_time' in body) stay.check_in_end_time = time('check_in_end_time', false)
  if ('check_out_time' in body) stay.check_out_time = time('check_out_time', false)
  const guests = maxGuests(false)
  if (guests !== null) stay.max_guests = guests
  const nights = minNights(false)
  if (nights !== null) stay.min_nights = nights
  if ('calendar_rules' in body) stay.calendar_rules = homeCalendarRules(body.calendar_rules)
  const arrival = arrivalPatch(body)
  const location = locationPatch(body)
  if ('published' in body && typeof body.published !== 'boolean') fail(422, 'INVALID_DETAIL', 'published must be true or false', 'published')
  // Publication is refused until the home can take bookings; on its own, a refusal leaves nothing else half-saved.
  if ('published' in body && Object.keys(body).length > 1) fail(422, 'INVALID_DETAIL', 'Change published on its own', 'published')
  if ('description' in body && typeof body.description !== 'string') fail(422, 'INVALID_DETAIL', 'description must be text; send an empty one to clear it', 'description')
  for (const key of LISTING_FIELDS) if (key in body) (stay as Record<string, unknown>)[key] = body[key]
  if (body.assigned_member_id !== undefined) stay.assigned_member_id = body.assigned_member_id as string | null
  // Questions are replaced whole by the product writer, against the revision the host read.
  if ('questions' in body) Object.assign(stay, { questions: body.questions, expected_questions_revision: body.expected_questions_revision })
  else if ('expected_questions_revision' in body) fail(422, 'INVALID_DETAIL', 'expected_questions_revision is only sent with questions', 'expected_questions_revision')
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
    if (price !== null) patch.variants = [{ id: variant.id, prices: [base ? { id: base.id, unit_amount: price } : { unit_amount: price, location_id: home.location_id }] }]
    else if (base) patch.variants = [{ id: variant.id, prices_mode: 'replace', prices: variant.prices.filter(other => other.id !== base.id).map(other => ({ id: other.id })) }]
  }
  const pushes = pricing || ('min_nights' in body && nights !== home.min_nights) || ('calendar_rules' in body && JSON.stringify(stay.calendar_rules) !== JSON.stringify(home.calendar_rules))
  // Clearing an already absent base price still asks for channel completion,
  // but creates no product pricing patch for updateProduct to preflight.
  if (pushes && patch.variants === undefined && patch.stay?.min_nights === undefined) await requireChannelPush(db, env, access.organizationId, productId)
  const saved = Object.keys(patch).length ? await updateProduct(db, { organizationId: access.organizationId, productId, patch, actor: { actorId: access.actorId }, env, deferStayNightPush: true, stayImport }) : null
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
    const writes: BatchQuery[] = [{
      query: `UPDATE product_stay_configs SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ?`,
      params: [...columns.map(column => arrival[column]!), instructionsAt, access.actorId, access.organizationId, productId],
    }, organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.instructions_updated', entityType: 'stay_home', entityId: productId,
      metadata: { fields: columns.sort().join(',') }, onlyIfPreviousChangedOneRow: true })]
    const importWrittenIndex = writes.length
    if (stayImport) writes.push(stayImportWrittenQuery(access.organizationId, productId, stayImport, columns))
    const results = await executeBatch(db, writes, { operation: 'Update home arrival guide' })
    if (results[0]?.meta.changes !== 1) fail(409, 'HOME_CHANGED', 'The home changed before its arrival guide was saved; reload it', 'product_id')
    if (stayImport && (!results[importWrittenIndex] || results[importWrittenIndex].meta.changes !== 1)) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.', undefined, { committed: true, product_id: productId })
  }
  const product = pushes || settings !== null ? await getProduct(db, access.organizationId, productId) : null
  const channelPush = product ? await pushStayHomeChannel(db, env, access, product, { nights: pushes, settings }) : null
  return completeChannelPush(channelPush, { product_id: productId, ...(product ? { updated_at: product.updated_at } : {}) }, async () => {
    const updated = await readStayHome(db, access, productId)
    if (zone !== null && zone !== home.timezone) await planHomeMessages(db, access.organizationId, home.location_id)
    if (product && pushes && channelPush !== null) {
      await publishStayInvalidation(env, { type: 'nights.changed', organization_id: access.organizationId, product_id: productId, location_id: updated.location_id, booking_id: null }, { updated_at: product.updated_at })
    }
    // A product or location change already announced itself; the arrival guide and the listing switch do here.
    if (instructionsAt !== null || 'published' in body) {
      await publishStayInvalidation(env, { type: 'stay.changed', organization_id: access.organizationId, product_id: productId, location_id: updated.location_id, booking_id: null }, { updated_at: instructionsAt ?? new Date().toISOString() })
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
      ...(home.base_price_minor === null ? {} : { variants: [{ name: home.name, prices: [{ unit_amount: home.base_price_minor, location_id: locationId }] }] }),
      stay: { ...(home.internal_name === undefined ? {} : { internal_name: home.internal_name }), location_id: locationId, check_in_time: home.check_in_time, check_in_end_time: home.check_in_end_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, calendar_rules: home.calendar_rules, assigned_member_id: home.assigned_member_id,
        ...(home.cancellation_policy === undefined ? {} : { cancellation_policy: home.cancellation_policy }),
        ...(home.long_term_cancellation_policy === undefined ? {} : { long_term_cancellation_policy: home.long_term_cancellation_policy }) },
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
  // The placement batch already advances the revision read by public pages.
  await publishBusinessInvalidation(env, access.organizationId)
  const updated = await readStayHome(db, access, home.product_id)
  await publishStayInvalidation(env, { type: 'stay.changed', organization_id: access.organizationId, product_id: home.product_id, location_id: home.location_id, booking_id: null }, { updated_at: new Date().toISOString() })
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
  await publishStayInvalidation(env, { type: 'stay.changed', organization_id: access.organizationId, product_id: productId, location_id: home.location_id, booking_id: null }, { updated_at: new Date().toISOString() })
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
  await publishStayInvalidation(env, { type: 'stay.changed', organization_id: access.organizationId, product_id: home.product_id, location_id: home.location_id, booking_id: null }, { updated_at: new Date().toISOString() })
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
    buildDeleteOwnerPlacementsQuery({ organizationId: access.organizationId, ownerType: 'stay_photo_room', ownerId: roomId }),
    buildDeleteOwnerPlacementsQuery({ organizationId: access.organizationId, ownerType: 'stay_room_accessibility', ownerId: roomId }),
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
        OR (SELECT r.id FROM product_stay_photo_rooms r JOIN media_placements m ON m.organization_id = r.organization_id
          AND m.owner_type = 'stay_photo_room' AND m.owner_id = r.id AND m.status = 'active' WHERE r.organization_id = ? AND r.product_id = ?
          AND m.asset_id = json_extract(selected.value, '$.photo_id')) IS NOT json_extract(selected.value, '$.expected_room_id'))
      )`,
    params: [access.organizationId, productId, roomId, creating ? 1 : 0, access.organizationId, productId, roomId, selected, access.organizationId, productId, access.organizationId, productId],
  }
  const assignments: BatchQuery[] = [{
    query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'stay_photo_room'
      AND owner_id IN (SELECT id FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ?)
      AND asset_id IN (SELECT json_extract(value, '$.photo_id') FROM json_each(?))`,
    params: [access.organizationId, access.organizationId, productId, selected],
  }, ...(roomId === null ? [] : [addStayPhotoRoomPlacementsQuery(access.organizationId, productId, roomId, photos.map(photo => photo.photo_id))])]
  try {
    await executeBatch(db, [
      guard,
      ...(creating ? [stayPhotoRoomInsert(access, productId, roomId!, body.new_room_type as StayPhotoRoomType)] : []),
      ...assignments,
      publicResourceCacheInvalidationQuery(access.organizationId, 'stay-photo-move'),
    ], { operation: 'Move stay photos' })
  } catch (error) {
    if (/NOT NULL constraint failed: product_stay_configs\.updated_at|media_placements_sort_order_check|FOREIGN KEY constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
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
  const window = stayOverlapSql(from, to)
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM ${STAY_FROM}
     WHERE s.organization_id = ? AND s.product_session_id IS NULL AND ${window.sql}
       ${input.productId ? 'AND s.product_id = ?' : ''} ${input.includeCancelled ? '' : "AND s.status <> 'cancelled'"} AND ${scope.sql}
     ORDER BY s.starts_at, s.id`, [access.organizationId, ...window.params, ...(input.productId ? [input.productId] : []), ...scope.params])
  return rows.map(mapStay).filter(stay => staysOverlap(stay, from, to))
    .sort((a, b) => a.check_in_date.localeCompare(b.check_in_date) || a.id.localeCompare(b.id))
    .map(stay => access.manage ? stay : stayTurnover(stay)) as Array<StayView<A>>
}

export async function getStay<A extends StayAccess>(db: DbClient, access: A, stayId: string): Promise<StayDetailView<A>> {
  const scope = visibleHomes(access)
  const row = await queryFirst<Record<string, unknown> & Pick<StayDetail, 'guest_image_url'>>(db, `
    SELECT ${STAY_COLUMNS}, (SELECT u.image FROM user u WHERE u.id = s.user_id) AS guest_image_url
      FROM ${STAY_FROM}
     WHERE s.organization_id = ? AND s.id = ? AND s.product_session_id IS NULL AND ${scope.sql}`, [access.organizationId, stayId, ...scope.params])
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That stay is not in this organization')
  const stay = mapStay(row)
  if (!access.manage) return stayTurnover(stay) as StayDetailView<A>
  const [payments, online] = await Promise.all([
    queryAll<StayPayment>(db, `
      SELECT id, booking_id, amount_minor, currency, method, paid_on, reference, note, created_at, created_by
        FROM offline_payments WHERE organization_id = ? AND booking_id = ? ORDER BY paid_on, created_at`, [access.organizationId, stayId]),
    queryAll<{ id: string; currency: string; amount: number; captured_amount: number; refunded_amount: number; receipt_url: string | null; created_at: string }>(db, `
      SELECT id, currency, amount, captured_amount, refunded_amount, receipt_url, created_at
        FROM payments WHERE organization_id = ? AND subject_type = 'booking' AND subject_id = ?`, [access.organizationId, stayId]),
  ])
  if (online.length > 1) fail(500, 'STAY_PAYMENT_AMBIGUOUS', 'This stay has more than one online payment', 'online_payment')
  const onlinePayment: StayOnlinePayment | null = online[0] ? {
    payment_id: online[0].id, currency: online[0].currency, amount_minor: online[0].amount,
    captured_minor: online[0].captured_amount, refunded_minor: online[0].refunded_amount, receipt_url: online[0].receipt_url, created_at: online[0].created_at,
  } : null
  const paid = payments.reduce((sum, payment) => sum + payment.amount_minor, 0) + (onlinePayment ? onlinePayment.captured_minor - onlinePayment.refunded_minor : 0)
  const status = isChannelManagedStay(stay) ? null
    : paid === 0 ? 'unpaid' : paid < stay.total_minor ? 'partial' : paid === stay.total_minor ? 'paid' : 'overpaid'
  return { ...stay, guest_image_url: row.guest_image_url, payments, online_payment: onlinePayment, paid_minor: paid, payment_status: status } as StayDetailView<A>
}

/** The price of an inventory date is the dated price of its home's variant. */
export const STAY_NIGHT_PRICE_SQL = `(SELECT pr.unit_amount FROM product_variants v JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id
  WHERE v.organization_id = n.organization_id AND v.product_id = n.product_id AND pr.stay_date = n.date)`

/** Every night of [from, to) at one home: whether it is free, its price and rules, and the stay holding it. */
export async function readStayCalendar<A extends StayAccess>(db: DbClient, access: A, input: { productId: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Array<StayView<A>> }> {
  const { from, to } = range(input, STAY_CALENDAR_DAYS)
  const home = await readStayHome(db, access, input.productId)
  const [nights, stays] = await Promise.all([homeNights(db, access.organizationId, home, from, to), staysOverlapping(db, access, { from, to, productId: input.productId })])
  return { home, nights, stays }
}

/**
 * Every night of [from, to) at every home this caller may see, the
 * multi-calendar's read: each home with its nights, and the stays holding any
 * of them. A night's booking_id names its booking.
 */
export async function readStayCalendars<A extends StayAccess>(db: DbClient, access: A, input: { from: unknown; to: unknown }): Promise<{ from: string; to: string; homes: Array<{ home: StayHome; nights: StayNight[] }>; stays: Array<StayView<A>> }> {
  const { from, to } = range(input, MAX_HOMES_CALENDAR_DAYS)
  const [homes, stays] = await Promise.all([stayHomes(db, access, null), staysOverlapping(db, access, { from, to })])
  const nights = homes.length ? await homesNights(db, access.organizationId, homes, from, to) : []
  return { from, to, homes: homes.map((home, index) => ({ home, nights: nights[index]! })), stays }
}

export interface StayGapCandidate {
  productId: string
  name: string
  locationId: string
  from: string
  /** Exclusive: the next recorded stay arrives on this date. */
  to: string
  nights: number
  bookable: boolean
  restriction: string | null
}

/** Bounded gaps between actual stays, using the same nightly policy as a quote. */
export async function readStayGapCandidates(db: DbClient, access: StayAccess, input: { from: unknown; to: unknown }): Promise<StayGapCandidate[]> {
  const calendar = await readStayCalendars(db, access, input)
  const gaps: StayGapCandidate[] = []
  for (const { home, nights } of calendar.homes) {
    if (!home.live) continue
    for (let index = 0; index < nights.length;) {
      if (!nights[index]!.available) { index++; continue }
      const start = index
      while (index < nights.length && nights[index]!.available) index++
      const before = nights[start - 1], departure = nights[index]
      if (!before?.booking_id || !departure?.booking_id) continue
      const stayed = nights.slice(start, index)
      if ([...stayed, departure].some(night => night.channel?.state === 'pending' || night.channel?.state === 'needs_review')) continue
      if (stayed[0]!.date < homeToday(home.timezone)) continue
      let restriction: string | null = null
      try {
        await quoteStay(db, access.organizationId, home, { check_in_date: stayed[0]!.date, check_out_date: departure.date, adults: 1 })
      } catch (error) {
        if (!(error instanceof HTTPError) || error.statusCode < 400 || error.statusCode >= 500) throw error
        restriction = error.message
      }
      gaps.push({ productId: home.product_id, name: home.name, locationId: home.location_id,
        from: stayed[0]!.date, to: departure.date, nights: stayed.length, bookable: restriction === null, restriction })
    }
  }
  return gaps.sort((a, b) => a.from.localeCompare(b.from) || a.productId.localeCompare(b.productId))
}

/** A hold's claim counts while its hold is active and unexpired; this selects the claims that no longer do. */
const LAPSED_HOLD_CLAIM_SQL = `stay_nights.hold_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_checkout_holds h
  WHERE h.id = stay_nights.hold_id AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

/** Every night of [from, to) at one home, read for whoever already has the home. */
async function homeNights(db: DbClient, organizationId: string, home: StayHome, from: string, to: string): Promise<StayNight[]> {
  return (await homesNights(db, organizationId, [home], from, to))[0]!
}

/** Every night of [from, to) at each of these homes, in their order: four queries for any number of homes. */
async function homesNights(db: DbClient, organizationId: string, homes: readonly StayHome[], from: string, to: string): Promise<StayNight[][]> {
  const ids = d1JsonStringSet(homes.map(home => home.product_id))
  const [overrides, claims, pushes, movedAway] = await Promise.all([
    queryAll<Record<string, unknown>>(db, `SELECT n.*, ${STAY_NIGHT_PRICE_SQL} AS price_minor FROM product_nights n WHERE n.organization_id = ? AND n.product_id IN (SELECT value FROM json_each(?)) AND n.date >= ? AND n.date < ?`, [organizationId, ids, from, to]),
    queryAll<{ product_id: string; date: string; booking_id: string | null; held_until: string | null; calendar: StayCalendarChannel | null }>(db, `SELECT stay_nights.product_id, stay_nights.date, stay_nights.booking_id, h.expires_at AS held_until, k.channel AS calendar FROM stay_nights
      LEFT JOIN payment_checkout_holds h ON h.id = stay_nights.hold_id
      LEFT JOIN stay_calendar_links k ON k.id = stay_nights.calendar_link_id
      WHERE stay_nights.organization_id = ? AND stay_nights.product_id IN (SELECT value FROM json_each(?)) AND stay_nights.date >= ? AND stay_nights.date < ? AND NOT (${LAPSED_HOLD_CLAIM_SQL})`, [organizationId, ids, from, to]),
    queryAll<{ product_id: string; date: string; state: 'pending' | 'pushed' | 'needs_review'; detail: string | null }>(db, 'SELECT product_id, date, state, detail FROM channel_night_pushes WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) AND date >= ? AND date < ?', [organizationId, ids, from, to]),
    // A reservation stays on the listing it was booked on after its guest moved: the channel still holds those nights, the nights it claims at the home it moved to.
    queryAll<{ id: string; booked_product_id: string; date: string }>(db, `SELECT s.id, s.booked_product_id, n.date FROM bookings s JOIN stay_nights n ON n.organization_id = s.organization_id AND n.booking_id = s.id
      WHERE s.organization_id = ? AND s.booked_product_id IN (SELECT value FROM json_each(?)) AND s.status <> 'cancelled' AND n.date >= ? AND n.date < ?`, [organizationId, ids, from, to]),
  ])
  const overrideByNight = new Map(overrides.map(row => [`${String(row.product_id)} ${String(row.date)}`, row]))
  const claimByNight = new Map(claims.map(row => [`${row.product_id} ${row.date}`, row]))
  for (const night of movedAway) {
    const key = `${night.booked_product_id} ${night.date}`
    if (!claimByNight.has(key)) claimByNight.set(key, { product_id: night.booked_product_id, date: night.date, booking_id: night.id, held_until: null, calendar: null })
  }
  const pushByNight = new Map(pushes.map(row => [`${row.product_id} ${row.date}`, { state: row.state, detail: row.detail }]))
  return homes.map((home) => {
    const nights: StayNight[] = []
    for (let offset = 0; offset < days(from, to); offset++) {
      const night = addDays(from, offset)
      const key = `${home.product_id} ${night}`
      const row = overrideByNight.get(key)
      const claim = claimByNight.get(key)
      const stayId = claim?.booking_id ?? null
      const heldUntil = claim && claim.booking_id === null ? claim.held_until : null
      const closed = Number(row?.closed ?? 0) === 1
      nights.push({
        date: night, available: !closed && !claim, booking_id: stayId, closed,
        ...resolveStayNightPolicy(home, night, {
          price_minor: row?.price_minor == null ? null : Number(row.price_minor),
          min_stay_arrival: row?.min_stay_arrival == null ? null : Number(row.min_stay_arrival),
        }),
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
export async function syncStayCalendar(db: DbClient, env: ChannexEnv, access: StayAccess, productId: string, mapping: ChannexMapping): Promise<ChannelPush> {
  const home = await readStayHome(db, access, productId)
  return pushStayCalendar(db, env, access.organizationId, home, mapping, (from, to) => homeNights(db, access.organizationId, home, from, to))
}

/** Verify occupied/closed dates against Airbnb itself, rather than trusting an outbound delivery receipt. */
export async function verifyStayCalendarOccupancy(db: DbClient, env: ChannexEnv, access: StayAccess, productId: string, dates: readonly string[]): Promise<{
  state: 'verified' | 'needs_attention' | 'not_connected'; checked_dates: string[]; unverified_dates: string[]; mismatches: string[]; detail: string | null
}> {
  requireManager(access)
  const home = await readStayHome(db, access, productId)
  const requested = [...new Set(dates.map(value => date(value, 'date')))].sort()
  const mapping = await queryFirst<{ listing_id: string; channel_id: string; enabled: number; import_stage: string; status: string | null; connected_channel_id: string | null }>(db, `
    SELECT m.listing_id, m.channel_id, m.enabled, m.import_stage, c.status, c.channel_id AS connected_channel_id
    FROM product_channel_mappings m LEFT JOIN channex_connections c ON c.organization_id = m.organization_id
    WHERE m.organization_id = ? AND m.product_id = ? AND m.provider = 'channex'`, [access.organizationId, productId])
  if (!mapping || mapping.status !== 'connected') return { state: 'not_connected', checked_dates: [], unverified_dates: requested, mismatches: [], detail: 'Airbnb is not connected for this home. Its channel availability has not been verified.' }
  if (mapping.enabled !== 1 || mapping.import_stage !== 'complete' || mapping.channel_id !== mapping.connected_channel_id) return {
    state: 'needs_attention', checked_dates: [], unverified_dates: requested, mismatches: [], detail: 'Finish connecting this home to its selected Airbnb account before verifying availability.',
  }
  const from = homeToday(home.timezone)
  const to = addDays(from, STAY_CALENDAR_DAYS)
  const checked = requested.filter(value => value >= from && value < to)
  const unverified = requested.filter(value => value < from || value >= to)
  const [actual, local] = await Promise.all([
    listingCalendar(env, mapping.channel_id, mapping.listing_id, home.timezone),
    homeNights(db, access.organizationId, home, from, to),
  ])
  const actualByDate = new Map(actual.map(night => [night.date, night]))
  const localByDate = new Map(local.map(night => [night.date, night]))
  const mismatches = checked.filter(value => actualByDate.get(value)?.availability !== 0 || localByDate.get(value)?.available !== false)
  return {
    state: mismatches.length || unverified.length ? 'needs_attention' : 'verified', checked_dates: checked, unverified_dates: unverified, mismatches,
    detail: mismatches.length ? 'Some occupied or blocked nights are still available in KrabiClaw or Airbnb.' : unverified.length ? `Airbnb read-back covers ${from} through ${addDays(to, -1)}. The other dates have not been verified.` : null,
  }
}

/**
 * Deliver pending nights and extend dated delivery as the booking window rolls.
 * Native rate-plan defaults cover weekday minimums and base prices.
 * Only a differing weekend price needs dated delivery as new dates open.
 */
export async function deliverPendingChannelNights(db: DbClient, env: StayMutationEnv): Promise<{ homes: number }> {
  // Each home on Channex with nights waiting to go, or whose weekend price needs the newly opened dates.
  const homes = await queryAll<{ organization_id: string; product_id: string; due: number }>(db, `SELECT m.organization_id, m.product_id, due FROM (
      SELECT m.organization_id, m.product_id, m.enabled, ${stayWeekendPriceSql('m')} AS weekend_price_minor,
        EXISTS (SELECT 1 FROM channel_night_pushes p WHERE p.organization_id = m.organization_id AND p.product_id = m.product_id
          AND p.provider = 'channex' AND p.state = 'pending') AS due
        FROM product_channel_mappings m WHERE m.provider = 'channex') m
     WHERE due = 1 OR (m.enabled = 1 AND m.weekend_price_minor IS NOT NULL)`)
  const failures: string[] = []
  let delivered = 0
  for (const row of homes) {
    try {
      const home = await readStayHome(db, { organizationId: row.organization_id, actorId: 'system', manage: true }, row.product_id)
      const from = homeToday(home.timezone)
      const to = addDays(from, STAY_CALENDAR_DAYS)
      // Partial date edits make the outbox sparse, so each weekend needs its own delivery row.
      const known = home.calendar_rules?.weekend_price_minor === undefined ? [] : await queryAll<{ date: string }>(db, "SELECT date FROM channel_night_pushes WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND date >= ? AND date < ?", [row.organization_id, row.product_id, from, to])
      const queued = new Set(known.map(night => night.date))
      const added = home.calendar_rules?.weekend_price_minor === undefined ? [] : Array.from({ length: STAY_CALENDAR_DAYS }, (_, offset) => addDays(from, offset)).filter(date => !queued.has(date) && resolveStayNightPolicy(home, date).price_minor !== home.base_price_minor)
      if (!added.length && !row.due) continue
      const read = (from: string, to: string) => homeNights(db, row.organization_id, home, from, to)
      if (added.length) await pushStayNights(db, env, row.organization_id, home, added, read)
      else await deliverStayNights(db, env, row.organization_id, home, read)
      delivered++
      await publishStayInvalidation(env, { type: 'nights.changed', organization_id: row.organization_id, location_id: home.location_id, product_id: home.product_id, booking_id: null }, { updated_at: new Date().toISOString() })
    } catch (error) {
      failures.push(`${row.product_id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} home(s) could not deliver their channel nights: ${failures.join('; ')}`)
  return { homes: delivered }
}

/** A base price or minimum stay changes the same 500 future nights on every write surface. */
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
/** House rules Airbnb takes as guest controls, by product detail. */
const AIRBNB_GUEST_CONTROLS = { pets_allowed: 'allows_pets_as_host', smoking_allowed: 'allows_smoking_as_host', events_allowed: 'allows_events_as_host' } as const
/**
 * Which of a connected home's Airbnb listing settings a product write changes:
 * the check-in and checkout hours and house rules, the cancellation policies,
 * and the minimum stay. The policies are their own section so an edit that
 * leaves them alone never restates Airbnb's cancellation settings.
 */
export type AirbnbSettingSections = { booking: boolean; cancellation: boolean; availability: boolean }

/** Compare complete normalized snapshots to select the sections this write changes. */
export function touchesAirbnbSettings(patch: UpdateProductInput, previous: UpdateProductInput): AirbnbSettingSections | null {
  const changed = (field: 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'cancellation_policy' | 'long_term_cancellation_policy') => patch.stay?.[field] !== undefined && patch.stay[field] !== previous.stay?.[field]
  const sections = {
    booking: (['check_in_time', 'check_in_end_time', 'check_out_time'] as const).some(changed)
      || (Object.keys(AIRBNB_GUEST_CONTROLS) as Array<keyof typeof AIRBNB_GUEST_CONTROLS>).some(key => patch.details?.[key] !== previous.details?.[key]),
    cancellation: (['cancellation_policy', 'long_term_cancellation_policy'] as const).some(changed),
    availability: (patch.stay?.min_nights !== undefined && patch.stay.min_nights !== previous.stay?.min_nights)
      || (patch.stay?.calendar_rules !== undefined && JSON.stringify(patch.stay.calendar_rules) !== JSON.stringify(previous.stay?.calendar_rules)),
  }
  return sections.booking || sections.cancellation || sections.availability ? sections : null
}

type AirbnbHomeSettings = Pick<StayHome, 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'cancellation_policy' | 'long_term_cancellation_policy' | 'min_nights'>

/**
 * A home's Airbnb listing settings, or why one of its values cannot be one.
 * Airbnb takes whole hours: a check-in start from 08:00 to 02:00 the next day
 * ("8"–"26"), an end up to 03:00 ("27") or flexible, and a checkout hour.
 * Only the sections a write changed are sent, and only what the home has: an
 * unset house rule is left as Airbnb has it. Prices are not listing settings
 * here: every night's price, the base price's included, already reaches
 * Airbnb with the nightly calendar.
 */
function airbnbListingSettings(home: AirbnbHomeSettings, details: Product['details'], sections: AirbnbSettingSections): AirbnbListingSettings | { refusal: string; field: string } {
  const hours = sections.booking ? airbnbBookingSettings(home, details) : {}
  if ('refusal' in hours) return hours as { refusal: string; field: string }
  const cancellation = sections.cancellation ? airbnbCancellationSettings(home) : {}
  if ('refusal' in cancellation) return cancellation as { refusal: string; field: string }
  return { booking: { ...hours, ...cancellation }, availability: sections.availability ? { default_min_nights: home.min_nights } : {} }
}

function airbnbBookingSettings(home: AirbnbHomeSettings, details: Product['details']): Record<string, unknown> | { refusal: string; field: string } {
  const hour = (time: string, field: string, label: string): number | { refusal: string; field: string } => {
    const [hh, mm] = time.split(':')
    return mm === '00' ? Number(hh) : { refusal: `Airbnb takes ${label} in whole hours; ${time} cannot be sent to Airbnb`, field }
  }
  const booking: Record<string, unknown> = {}
  if (home.check_in_time !== null) {
    const start = hour(home.check_in_time, 'check_in_time', 'the check-in start')
    if (typeof start !== 'number') return start
    const startHour = start < 8 ? start + 24 : start
    if (startHour > 26) return { refusal: `Airbnb's check-in start is between 08:00 and 02:00; ${home.check_in_time} cannot be sent to Airbnb`, field: 'check_in_time' }
    booking.check_in_time_start = String(startHour)
    if (home.check_in_end_time === null) booking.check_in_time_end = 'FLEXIBLE'
    else {
      const end = hour(home.check_in_end_time, 'check_in_end_time', 'the check-in end')
      if (typeof end !== 'number') return end
      const endHour = startHour >= 24 || end <= start ? end + 24 : end
      if (endHour > 27 || endHour <= startHour) return { refusal: `Airbnb's check-in end is after the start and no later than 03:00; ${home.check_in_end_time} cannot be sent to Airbnb`, field: 'check_in_end_time' }
      booking.check_in_time_end = String(endHour)
    }
  }
  if (home.check_out_time !== null) {
    const checkout = hour(home.check_out_time, 'check_out_time', 'checkout')
    if (typeof checkout !== 'number') return checkout
    booking.check_out_time = checkout
  }
  const controls = Object.fromEntries((Object.entries(AIRBNB_GUEST_CONTROLS) as Array<[keyof typeof AIRBNB_GUEST_CONTROLS, string]>).flatMap(([key, control]) => typeof details[key] === 'boolean' ? [[control, details[key]]] : []))
  if (Object.keys(controls).length) booking.guest_controls = controls
  return booking
}

/** A home's two policies as Airbnb's own options of the same title and wording. Airbnb has no Strict to set. */
function airbnbCancellationSettings(home: AirbnbHomeSettings): Record<string, unknown> | { refusal: string; field: string } {
  const categories: Partial<Record<StayCancellationPolicy, string>> = AIRBNB_CANCELLATION_CATEGORIES
  const category = home.cancellation_policy ? categories[home.cancellation_policy] : undefined
  if (home.cancellation_policy && !category) return { refusal: `Airbnb has no ${STAY_CANCELLATION_POLICIES[home.cancellation_policy].label} cancellation policy. Choose Flexible, Moderate, Limited or Firm for a home that syncs with Airbnb.`, field: 'cancellation_policy' }
  const settings = {
    ...(category ? { cancellation_policy_category: category } : {}),
    ...(home.long_term_cancellation_policy ? { lts_cancellation_policy_id: AIRBNB_LONG_TERM_CANCELLATION_IDS[home.long_term_cancellation_policy] } : {}),
  }
  return Object.keys(settings).length ? { cancellation_policy_settings: settings } : {}
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
    await configureStayCalendar(db, env, access.organizationId, home)
    const today = homeToday(home.timezone)
    return await pushNights(db, env, access, product.id, [[today, addDays(today, STAY_CALENDAR_DAYS)]])
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
}

/**
 * Make a nights booking's claims match what its write committed: release the
 * nights it no longer holds, then claim the ones it lacks. Every statement is
 * guarded by the version, home and ends the write gives the booking, so a
 * batch whose version-guarded write lost a race changes no claim. A cancelled or
 * overbooked booking holds none. A long stay is still one statement each.
 */
function reconcileNightsQueries(organizationId: string, stayId: string, written: { version: number; updated_at: string; product_id: string; starts_at: string; ends_at: string; check_in_date: string; check_out_date: string }): BatchQuery[] {
  // Two writes from one version both name the next one: the stored time, home and ends say whose write committed.
  const committed = 'EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = ? AND b.id = ? AND b.version = ? AND b.updated_at = ? AND b.product_id = ? AND b.starts_at = ? AND b.ends_at = ?'
  const guard = [organizationId, stayId, written.version, written.updated_at, written.product_id, written.starts_at, written.ends_at]
  return [{
    // A lapsed checkout hold on one of these nights no longer holds it.
    query: `DELETE FROM stay_nights WHERE ${LAPSED_HOLD_CLAIM_SQL} AND stay_nights.product_id = ? AND stay_nights.date >= ? AND stay_nights.date < ? AND ${committed})`,
    params: [written.product_id, written.check_in_date, written.check_out_date, ...guard],
  }, {
    query: `DELETE FROM stay_nights WHERE organization_id = ? AND booking_id = ? AND ${committed}
              AND (b.status = 'cancelled' OR b.overbooked = 1 OR stay_nights.product_id <> ? OR stay_nights.date < ? OR stay_nights.date >= ?))`,
    params: [organizationId, stayId, ...guard, written.product_id, written.check_in_date, written.check_out_date],
  }, {
    query: `WITH RECURSIVE night(d) AS (SELECT ? UNION ALL SELECT date(d, '+1 day') FROM night WHERE date(d, '+1 day') < ?)
            INSERT INTO stay_nights (organization_id, product_id, date, booking_id)
            SELECT ?, ?, d, ? FROM night
             WHERE ${committed} AND b.product_id = ? AND b.status <> 'cancelled' AND b.overbooked = 0)
               AND NOT EXISTS (SELECT 1 FROM stay_nights own WHERE own.organization_id = ? AND own.booking_id = ? AND own.date = night.d)`,
    params: [written.check_in_date, written.check_out_date, organizationId, written.product_id, stayId, ...guard, written.product_id, organizationId, stayId],
  }]
}

/**
 * A listing whose guest was moved elsewhere keeps its nights for that stay: the
 * channel still sells it as taken, and its nights carry no claim rows at the
 * listing because a claim names the home the guest sleeps in. Those nights
 * are the moved booking's claims at its new home. This statement refuses the
 * batch, in the same transaction as the write it follows, when the home takes
 * a stay over nights another booking holds as its booked listing. `json()` of
 * plain text is the batch's one way to fail on a read.
 */
function bookedListingGuardQuery(organizationId: string, productId: string, stayId: string, checkIn: string, checkOut: string): BatchQuery {
  return {
    query: `SELECT CASE WHEN EXISTS (SELECT 1 FROM bookings b JOIN stay_nights n ON n.organization_id = b.organization_id AND n.booking_id = b.id
              WHERE b.organization_id = ? AND b.booked_product_id = ? AND b.id <> ? AND b.status <> 'cancelled' AND n.date >= ? AND n.date < ?) THEN json('STAY_BOOKED_LISTING_HELD') ELSE NULL END`,
    params: [organizationId, productId, stayId, checkIn, checkOut],
  }
}

/**
 * The guards for the nights a write newly takes on a home: none when the stay
 * already held every night there, otherwise the stretch before and the stretch
 * after what it held. A stay that already overlapped a reservation later moved
 * off its listing keeps its own nights and is edited freely within them.
 */
function bookedListingGuardQueries(organizationId: string, productId: string, stayId: string, held: { product_id: string; check_in_date: string; check_out_date: string } | null, next: { check_in_date: string; check_out_date: string }): BatchQuery[] {
  if (!held || held.product_id !== productId) return [bookedListingGuardQuery(organizationId, productId, stayId, next.check_in_date, next.check_out_date)]
  const guards: BatchQuery[] = []
  if (next.check_in_date < held.check_in_date) guards.push(bookedListingGuardQuery(organizationId, productId, stayId, next.check_in_date, held.check_in_date < next.check_out_date ? held.check_in_date : next.check_out_date))
  if (next.check_out_date > held.check_out_date) guards.push(bookedListingGuardQuery(organizationId, productId, stayId, held.check_out_date > next.check_in_date ? held.check_out_date : next.check_in_date, next.check_out_date))
  return guards
}

/** The booked-listing guard above is the only `json()` of plain text in a stay batch. */
function isBookedListingHeld(error: unknown): boolean {
  return /malformed JSON/.test(error instanceof Error ? error.message : String(error))
}

export function isStayNightConflict(error: unknown): boolean {
  return /UNIQUE constraint failed: stay_nights\./.test(error instanceof Error ? error.message : String(error))
}

interface StayFields {
  check_in_date: string
  check_out_date: string
  /** The time the guest said they arrive, local HH:MM; null for the home's check-in time. */
  arrival_time: string | null
  adults: number
  children: number
  infants: number
  guest_name: string
  guest_email: string | null
  guest_phone: string | null
  total_minor: number
  private_notes: string | null
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
    guest_email: email, guest_phone: phone, total_minor: amount(input.total_minor, 'total_minor'),
    private_notes: optionalText(input.private_notes, 'private_notes', 2000),
  }
}

/** What a stay's fields store on its booking: its ends in the home's clock and its one count. */
function stayWindow(fields: Pick<StayFields, 'check_in_date' | 'check_out_date' | 'arrival_time'>, home: Pick<StayHome, 'check_in_time' | 'check_out_time' | 'timezone'>) {
  return {
    starts_at: nightsBoundary(fields.check_in_date, fields.arrival_time ?? home.check_in_time, home.timezone),
    ends_at: nightsBoundary(fields.check_out_date, home.check_out_time, home.timezone),
  }
}

/** The local HH:MM a stored stay start falls at, when it is not the home's check-in time: the arrival its host recorded. */
function recordedArrival(stay: Pick<Stay, 'starts_at' | 'timezone'>, home: Pick<StayHome, 'check_in_time'>): string | null {
  if (isBookingDay(stay.starts_at)) return null
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: stay.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(stay.starts_at))
  return time === home.check_in_time ? null : time
}

/** The terms a nights booking is made under: the home's guest terms, its payment, and the cancellation policy a guest paying on the site agreed to. */
async function stayPolicy(db: DbClient, organizationId: string, productId: string, payment: { price: Pick<Price, 'unit_amount' | 'currency' | 'tax_behavior'> } | null, cancellation: StayBookedPolicy | null): Promise<string> {
  const config = await requireBookingConfig(db, organizationId, productId)
  return JSON.stringify({ ...bookingPolicy(config, payment?.price ?? null), cancellation } satisfies BookingPolicy)
}

/**
 * Add a stay the host took themselves (phone, walk-in, repeat guest). It holds
 * its nights or is refused with STAY_OVERLAP; it never lands on a held night.
 * Closed nights, minimum nights and per-night stay rules are what the host
 * offers guests and channels; a stay the host enters is the host's own
 * decision, so those rules do not refuse it. Only another stay does.
 */
export interface HostawayStaySource {
  source: 'hostaway'
  source_id: string
  row: Record<string, string>
  fingerprint: string
  channel?: StayChannel
  channel_booking_id?: string | null
}

async function publishCreatedStay(db: DbClient, env: StayMutationEnv, access: StayAccess & { manage: true }, stay: StayDetail): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  await planSourceMessages(db, access.organizationId, stay.id)
  const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
  return completeChannelPush(channelPush, { product_id: stay.product_id, booking_id: stay.id, version: stay.version, ranges: [[stay.check_in_date, stay.check_out_date]] }, async () => {
    await publishStayChange(env, db, access.organizationId, stay, true)
    return getStay(db, access, stay.id)
  })
}

/** Retry the visibility/delivery of a committed migration using the stay as the host now has it, without restoring stale CSV fields. */
export async function resumeImportedStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  const receipt = await queryFirst(db, `SELECT id FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.created'
    AND json_extract(payload_json, '$.entityId') = ? AND json_extract(payload_json, '$.metadata.imported.source') = 'hostaway'`, [access.organizationId, stayId])
  if (!receipt) fail(422, 'STAY_NOT_IMPORTED', 'This stay has no Hostaway import receipt', 'booking_id')
  return publishCreatedStay(db, env, access, stay)
}

export async function createStay(db: DbClient, env: StayMutationEnv & CloudflareEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; idempotency_key: string }, options?: { imported: HostawayStaySource }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  const imported = options?.imported
  if (imported && (imported.source !== 'hostaway' || !imported.source_id || key !== `hostaway:${imported.source_id}` || !imported.fingerprint)) fail(422, 'INVALID_STAY_FIELD', 'An imported stay needs its source reservation, fingerprint and matching idempotency key', 'imported')
  const channel = imported?.channel ?? 'direct'
  const channelBookingId = imported?.channel_booking_id ?? null
  if (!STAY_CHANNELS.includes(channel) || (channel !== 'direct' && !channelBookingId)) fail(422, 'INVALID_STAY_FIELD', 'An imported channel booking needs its actual channel confirmation reference', 'channel_booking_id')
  const home = await readStayHome(db, access, input.product_id)
  const fields = stayFields(input, home)
  const window = stayWindow(fields, home)
  // A payment the guest already made is written with the stay, so a stay never exists without it.
  const payment = input.payment === undefined || input.payment === null ? null : stayPaymentFields(input.payment, 'payment.', false)
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  // The guest's answers to the home's questions, as the host took them; a retry with other answers is another stay.
  const answered = JSON.stringify(formAnswersFingerprint(input.answers))
  const replay = async () => {
    const existing = await queryFirst<Record<string, unknown>>(db, `SELECT ${STAY_COLUMNS} FROM ${STAY_FROM} WHERE s.organization_id = ? AND s.idempotency_key = ?`, [access.organizationId, key])
    if (!existing) return null
    const stored = mapStay(existing)
    const asked = { ...fields, ...window }
    const kept = { check_in_date: stored.check_in_date, check_out_date: stored.check_out_date, starts_at: stored.starts_at, ends_at: stored.ends_at, adults: stored.adults, children: stored.children, infants: stored.infants,
      guest_name: stored.guest_name, guest_email: stored.guest_email, guest_phone: stored.guest_phone, total_minor: stored.total_minor, private_notes: stored.private_notes }
    if (stored.product_id !== home.product_id || stored.channel !== channel || stored.channel_booking_id !== channelBookingId || Object.entries(kept).some(([field, value]) => asked[field as keyof typeof asked] !== value)
      || JSON.stringify(formAnswersFingerprint(stored.answers)) !== answered) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a stay with different saved details. Reload the stay before another change; a create retry does not edit an existing stay.', 'idempotency_key')
    }
    const initialPayment = await queryFirst<StayPaymentFields>(db,
      'SELECT amount_minor, method, paid_on, reference, note FROM offline_payments WHERE organization_id = ? AND booking_id = ? AND idempotency_key = ?', [access.organizationId, stored.id, `${key}:payment`]) ?? null
    if ((payment === null) !== (initialPayment === null) || (payment && initialPayment && Object.entries(payment).some(([field, value]) => initialPayment[field as keyof StayPaymentFields] !== value))) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a stay with a different saved initial payment', 'idempotency_key')
    }
    return getStay(db, access, stored.id)
  }
  // A replay pushes again, so retrying a create whose push did not land repairs it.
  const pushed = (stay: StayDetail) => publishCreatedStay(db, env, access, stay)
  const earlier = await replay()
  if (earlier) return pushed(earlier)
  // A stay the host takes asks the home's questions as its direct booking does; the host's words are in the site's own language.
  const answers = imported ? [] : await acceptFormAnswers(db, { kind: 'booking', organizationId: access.organizationId, productId: home.product_id }, {
    locale: null, answers: input.answers, questionsRevision: input.questions_revision, revisionRequired: false })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const [policy, guestUserId] = await Promise.all([stayPolicy(db, access.organizationId, home.product_id, null, null), createGuestUser(env, fields.guest_name)])
  const turnovers = await turnoverTaskQueries(db, { organizationId: access.organizationId, now, before: null,
    after: { id, product_id: home.product_id, status: 'confirmed', check_in_date: fields.check_in_date, check_out_date: fields.check_out_date } })
  try {
    await executeBatch(db, [
      {
        query: `INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants,
                  status, answers, private_notes, policy_json, total_minor, currency, idempotency_key, version, channel, owner, channel_booking_id, received_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, 1, ?, 'app', ?, ?, ?, ?)`,
        params: [id, access.organizationId, guestUserId, home.product_id, home.variant_id, home.location_id, window.starts_at, window.ends_at, home.timezone, fields.adults + fields.children, fields.adults, fields.children, fields.infants,
          JSON.stringify(answers), fields.private_notes, policy, fields.total_minor, home.currency, key, channel, channelBookingId, imported ? null : now, now, now],
      },
      ...bookedListingGuardQueries(access.organizationId, home.product_id, id, null, fields),
      ...reconcileNightsQueries(access.organizationId, id, { updated_at: now, version: 1, product_id: home.product_id, ...window, check_in_date: fields.check_in_date, check_out_date: fields.check_out_date }),
      ...bookingConversationQueries({ organizationId: access.organizationId, bookingId: id, requestId: crypto.randomUUID(), locationId: home.location_id, userId: guestUserId, now,
        guest: { name: fields.guest_name, email: fields.guest_email, phone: fields.guest_phone } }),
      organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.created', entityType: 'stay', entityId: id,
        context: access.audit, afterState: { ...fields, channel, channel_booking_id: channelBookingId }, ...(imported ? { metadata: { imported } } : {}) }),
      ...(payment ? stayPaymentInsert(access, { id, currency: home.currency, location_id: home.location_id }, payment, `${key}:payment`, now) : []),
      ...turnovers,
    ], { operation: 'Create stay' })
  } catch (error) {
    if (isStayNightConflict(error) || isBookedListingHeld(error)) fail(409, 'STAY_OVERLAP', 'Another stay or a linked calendar already holds one of these nights', 'check_in_date')
    if (/UNIQUE constraint failed: bookings\.organization_id, bookings\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
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
  if (isChannelManagedStay(stay)) channelOwned(stay, 'belongs to')
  if (stay.status === 'cancelled') fail(409, 'STAY_NOT_EDITABLE', 'This stay is cancelled')
  if (expectedVersion !== stay.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  return stay
}

/** The version-guarded update leads its batch; whether it applied is read from its result. */
function versionChanged(results: unknown): boolean {
  return (results as Array<{ meta?: { changes?: number } }>)[0]?.meta?.changes === 1
}

export async function updateStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: Record<string, unknown> & { version: unknown }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const current = await requireAppStay(db, access, stayId, input.version)
  const home = await readStayHome(db, access, current.product_id)
  const before: StayFields = { check_in_date: current.check_in_date, check_out_date: current.check_out_date, arrival_time: recordedArrival(current, home), adults: current.adults, children: current.children, infants: current.infants,
    guest_name: current.guest_name ?? '', guest_email: current.guest_email, guest_phone: current.guest_phone, total_minor: current.total_minor, private_notes: current.private_notes }
  const fields = stayFields({ ...before, ...input }, home)
  if (!Object.entries(fields).some(([field, value]) => value !== before[field as keyof StayFields])) fail(422, 'INVALID_STAY_FIELD', 'Provide at least one changed stay field', 'stay')
  const window = stayWindow(fields, home)
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  const next = current.version + 1
  const now = new Date().toISOString()
  const turnovers = await turnoverTaskQueries(db, { organizationId: access.organizationId, now, before: current,
    after: { id: stayId, product_id: current.product_id, status: current.status, check_in_date: fields.check_in_date, check_out_date: fields.check_out_date } })
  let results: unknown
  try {
    results = await executeBatch(db, [
      {
        query: `UPDATE bookings SET starts_at = ?, ends_at = ?, party_size = ?, adults = ?, children = ?, infants = ?, total_minor = ?, private_notes = ?, version = ?, updated_at = ?
                WHERE organization_id = ? AND id = ? AND version = ? AND owner = 'app' AND status <> 'cancelled' AND product_session_id IS NULL`,
        params: [window.starts_at, window.ends_at, fields.adults + fields.children, fields.adults, fields.children, fields.infants, fields.total_minor, fields.private_notes, next, now,
          access.organizationId, stayId, current.version],
      },
      organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.updated', entityType: 'stay', entityId: stayId, onlyIfPreviousChangedOneRow: true }),
      bookingContactQuery({ organizationId: access.organizationId, bookingId: stayId, version: next, updatedAt: now, locationId: home.location_id, guest: { name: fields.guest_name, email: fields.guest_email, phone: fields.guest_phone } }),
      ...bookedListingGuardQueries(access.organizationId, current.product_id, stayId, current, fields),
      ...reconcileNightsQueries(access.organizationId, stayId, { updated_at: now, version: next, product_id: current.product_id, ...window, check_in_date: fields.check_in_date, check_out_date: fields.check_out_date }),
      ...turnovers,
    ], { operation: 'Update stay' })
  } catch (error) {
    if (isStayNightConflict(error) || isBookedListingHeld(error)) fail(409, 'STAY_OVERLAP', 'Another stay or a linked calendar already holds one of these nights', 'check_in_date')
    throw error
  }
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  await planSourceMessages(db, access.organizationId, stayId)
  const stay = await getStay(db, access, stayId)
  // The nights it released and the nights it now holds.
  const ranges = [[current.check_in_date, current.check_out_date], [stay.check_in_date, stay.check_out_date]] as const
  const changed = current.check_in_date === stay.check_in_date && current.check_out_date === stay.check_out_date ? [] : ranges
  const channelPush = await pushNights(db, env, access, stay.product_id, changed)
  return completeChannelPush(channelPush, { product_id: stay.product_id, booking_id: stayId, version: stay.version, ranges: changed }, async () => {
    await publishStayChange(env, db, access.organizationId, stay, changed.length > 0)
    return getStay(db, access, stayId)
  })
}

export interface StayMoveOption {
  product_id: string
  name: string
  internal_name: string
  same_address: boolean
  /** Straight-line distance from where the stay is now; null until both homes have a map pin. */
  distance_meters: number | null
  /** The [from, to) ranges of this stay's nights the home cannot give it. Empty means it is free for the whole stay. */
  taken: Array<{ from: string; to: string }>
  /** Whether the home has the check-in instructions the guest must be sent. */
  has_instructions: boolean
}

function distanceMeters(a: StayHome, b: StayHome): number | null {
  if (a.latitude === null || a.longitude === null || b.latitude === null || b.longitude === null) return null
  const radians = (value: number) => value * Math.PI / 180
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(radians(b.longitude - a.longitude) / 2) ** 2
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)))
}

/** The nights a home cannot give this stay; the stay's own hold on its booked listing does not count. */
function nightsTaken(nights: readonly StayNight[], stayId: string): Array<{ from: string; to: string }> {
  const ranges: Array<{ from: string; to: string }> = []
  for (const night of nights) {
    if (night.available || night.booking_id === stayId) continue
    const next = addDays(night.date, 1)
    const last = ranges.at(-1)
    if (last?.to === night.date) last.to = next
    else ranges.push({ from: night.date, to: next })
  }
  return ranges
}

/** The host's other homes for this stay's nights, free ones first and nearest first. */
export async function listStayMoveOptions(db: DbClient, access: StayAccess, stayId: string): Promise<StayMoveOption[]> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  const homes = await listStayHomes(db, access)
  const current = homes.find(home => home.product_id === stay.product_id)
  if (!current) fail(404, 'STAY_HOME_NOT_FOUND', 'The stay’s home was not found', 'product_id')
  const others = homes.filter(home => home.product_id !== stay.product_id)
  const [nights, instructions] = await Promise.all([
    homesNights(db, access.organizationId, others, stay.check_in_date, stay.check_out_date),
    queryAll<{ product_id: string }>(db, `SELECT product_id FROM product_stay_configs WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))
      AND trim(COALESCE(check_in_instructions, '')) <> ''`, [access.organizationId, d1JsonStringSet(others.map(home => home.product_id))]),
  ])
  const ready = new Set(instructions.map(row => row.product_id))
  return others.map((home, index) => ({
    product_id: home.product_id, name: home.name, internal_name: home.internal_name,
    same_address: home.address !== null && home.address.address === current.address?.address,
    distance_meters: distanceMeters(current, home), taken: nightsTaken(nights[index]!, stayId), has_instructions: ready.has(home.product_id),
  })).sort((a, b) => Number(a.taken.length > 0) - Number(b.taken.length > 0) || Number(b.same_address) - Number(a.same_address)
    || (a.distance_meters ?? Infinity) - (b.distance_meters ?? Infinity) || a.internal_name.localeCompare(b.internal_name))
}

const STAY_MOVED_MESSAGE_TITLE = 'Your stay has moved'

function stayMovedMessage(stay: Stay, from: StayHome, to: StayHome, instructions: string): string {
  const first = stayGuestFirstName(stay.guest_name)
  const day = (date: string) => formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
  const at = (date: string, time: string | null) => time === null ? day(date) : `${day(date)}, ${formatTimestamp(localDateTimeToInstant(date, time, to.timezone, 'compatible'), 'en', to.timezone, { hour: 'numeric', minute: '2-digit' })}`
  const address = to.address && [to.address.address, to.address.city, to.address.state].filter(Boolean).join(', ')
  return [`${first ? `Hi ${first}, your` : 'Your'} stay has moved to ${to.name}. Your dates and price don’t change.`,
    [address && `Address: ${address}`, `Check-in: ${at(stay.check_in_date, to.check_in_time)}`, `Checkout: ${at(stay.check_out_date, to.check_out_time)}`].filter(Boolean).join('\n'),
    instructions.trim(), `Please use these details instead of any you received for ${from.name}.`].join('\n\n')
}

/**
 * The host moves a guest to another of their homes. The stay's nights, turnover
 * and later messages follow it; a channel reservation stays on the listing it
 * was booked on, which keeps those nights. The new home gets a job to be made
 * ready before arrival, and the guest is told in their conversation. Moving
 * back to the booked listing undoes the move.
 */
export async function moveStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: { version: unknown; product_id: unknown }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null; scheduled_message_id: string }> {
  requireManager(access)
  const current = await getStay(db, access, stayId)
  if (current.status === 'cancelled') fail(409, 'STAY_NOT_EDITABLE', 'This stay is cancelled')
  if (input.version !== current.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  if (typeof input.product_id !== 'string' || !input.product_id) fail(422, 'INVALID_STAY_FIELD', 'Choose the home to move this stay to', 'product_id')
  if (input.product_id === current.product_id) fail(422, 'STAY_MOVE_SAME_HOME', 'The guest is already staying in this home', 'product_id')
  const [from, to] = await Promise.all([readStayHome(db, access, current.product_id), readStayHome(db, access, input.product_id)])
  if (current.check_out_date < localDateAt(new Date(), to.timezone)) fail(409, 'STAY_MOVE_ENDED', 'This stay has already ended', 'product_id')
  if (current.adults + current.children > to.max_guests) fail(422, 'STAY_MOVE_TOO_SMALL', `${to.internal_name} sleeps ${to.max_guests}; this party is ${current.adults + current.children}`, 'product_id')
  const config = await queryFirst<{ check_in_instructions: string | null; assigned_member_id: string | null }>(db,
    `SELECT c.check_in_instructions, b.assigned_member_id FROM product_stay_configs c JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
      WHERE c.organization_id = ? AND c.product_id = ?`, [access.organizationId, to.product_id])
  if (!config?.check_in_instructions?.trim()) fail(422, 'STAY_MOVE_NEEDS_INSTRUCTIONS', `Add check-in instructions to ${to.internal_name} before moving a guest there, so they can be told how to get in`, 'product_id')
  if (nightsTaken(await homeNights(db, access.organizationId, to, current.check_in_date, current.check_out_date), stayId).length) fail(409, 'STAY_MOVE_NIGHTS_TAKEN', `${to.internal_name} is not free for every night of this stay`, 'product_id')
  await Promise.all([requireChannelPush(db, env, access.organizationId, from.product_id), requireChannelPush(db, env, access.organizationId, to.product_id)])
  const listing = isChannelManagedStay(current) ? current.booked_product_id ?? current.product_id : null
  const backOnListing = to.product_id === listing
  const booked = backOnListing ? null : listing
  const next = current.version + 1
  const now = new Date().toISOString()
  const scheduledMessageId = crypto.randomUUID()
  const body = stayMovedMessage(current, from, to, config.check_in_instructions)
  if (body.length > 5000) fail(422, 'STAY_MOVE_MESSAGE_TOO_LONG', `The check-in instructions for ${to.internal_name} are too long to send in one message`, 'product_id')
  // The guest keeps their dates; the times are the new home's, or the arrival they said.
  const movedWindow = { starts_at: nightsBoundary(current.check_in_date, recordedArrival(current, from) ?? to.check_in_time, to.timezone), ends_at: nightsBoundary(current.check_out_date, to.check_out_time, to.timezone) }
  const moved = `EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND version = ? AND product_id = ?)`
  const movedParams = [access.organizationId, stayId, next, to.product_id]
  const turnovers = await turnoverTaskQueries(db, { organizationId: access.organizationId, now, before: current,
    after: { id: stayId, product_id: to.product_id, status: current.status, check_in_date: current.check_in_date, check_out_date: current.check_out_date } })
  let results: Awaited<ReturnType<typeof executeBatch>>
  try {
    results = await executeBatch(db, [
      // The claims' composite FK names the stay's home: release them before it changes.
      { query: 'DELETE FROM stay_nights WHERE organization_id = ? AND booking_id = ? AND EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND version = ?)',
        params: [access.organizationId, stayId, access.organizationId, stayId, current.version] },
      { query: `UPDATE bookings SET product_id = ?, product_variant_id = ?, location_id = ?, timezone = ?, starts_at = ?, ends_at = ?, booked_product_id = ?, overbooked = 0, version = ?, updated_at = ?
                WHERE organization_id = ? AND id = ? AND product_id = ? AND version = ? AND status <> 'cancelled' AND product_session_id IS NULL`,
        params: [to.product_id, to.variant_id, to.location_id, to.timezone, movedWindow.starts_at, movedWindow.ends_at,
          booked, next, now, access.organizationId, stayId, from.product_id, current.version] },
      organizationEventQuery({ organizationId: access.organizationId, locationId: to.location_id, actorId: access.actorId, eventType: 'stay.moved', entityType: 'stay', entityId: stayId, onlyIfPreviousChangedOneRow: true,
        metadata: { from_product_id: from.product_id, to_product_id: to.product_id, booked_product_id: booked } }),
      ...bookedListingGuardQueries(access.organizationId, to.product_id, stayId, current, current),
      ...reconcileNightsQueries(access.organizationId, stayId, { updated_at: now, version: next, product_id: to.product_id, ...movedWindow, check_in_date: current.check_in_date, check_out_date: current.check_out_date }),
      { query: `UPDATE scheduled_guest_messages SET product_id = ?, updated_at = ? WHERE organization_id = ? AND booking_id = ? AND status <> 'sent' AND ${moved}`,
        params: [to.product_id, now, access.organizationId, stayId, ...movedParams] },
      bookingContactQuery({ organizationId: access.organizationId, bookingId: stayId, version: next, updatedAt: now, locationId: to.location_id, guest: { name: current.guest_name, email: current.guest_email, phone: current.guest_phone } }),
      ...turnovers,
      ...stayReadyTaskQueries({ organizationId: access.organizationId, stayId, now, previousProductId: from.product_id, guard: { query: moved, params: movedParams },
        home: backOnListing ? null : { product_id: to.product_id, location_id: to.location_id, timezone: to.timezone, check_in_time: to.check_in_time, internal_name: to.internal_name, assigned_member_id: config.assigned_member_id },
        guestName: stayGuestFirstName(current.guest_name), checkInDate: current.check_in_date }),
      {
        query: `INSERT INTO scheduled_guest_messages (id, organization_id, product_id, booking_id, template_id, template_title, template_version, body, due_at, timezone, status, created_at, updated_at)
                SELECT ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, 'pending', ?, ? WHERE ${moved}`,
        params: [scheduledMessageId, access.organizationId, to.product_id, stayId, STAY_MOVED_MESSAGE_TITLE, body, now, to.timezone, now, now, ...movedParams],
      },
    ], { operation: 'Move stay' })
  } catch (error) {
    if (isStayNightConflict(error) || isBookedListingHeld(error)) fail(409, 'STAY_MOVE_NIGHTS_TAKEN', `${to.internal_name} is not free for every night of this stay`, 'product_id')
    throw error
  }
  if (results[1]?.meta.changes !== 1) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  if (results.at(-1)?.meta.changes !== 1) throw new Error('The stay moved without its queued guest message')
  await planSourceMessages(db, access.organizationId, stayId)
  const range = [[current.check_in_date, current.check_out_date]] as const
  const released = await pushNights(db, env, access, from.product_id, range)
  const held = await pushNights(db, env, access, to.product_id, range)
  const channelPush = released instanceof Error || released?.state === 'needs_review' ? released : held
  return completeChannelPush(channelPush, { product_id: to.product_id, booking_id: stayId, version: next, ranges: range }, async () => {
    const stay = await getStay(db, access, stayId)
    await publishStayChange(env, db, access.organizationId, stay, true)
    const released = { organization_id: access.organizationId, location_id: from.location_id, product_id: from.product_id, booking_id: stayId }
    await publishStayInvalidation(env, { ...released, type: 'stay.changed' }, { version: next })
    await publishStayInvalidation(env, { ...released, type: 'nights.changed' }, { version: next })
    if (!backOnListing) await notifyStayReady(env as CloudflareEnv, db, { organizationId: access.organizationId, stayId, productId: to.product_id, actorUserId: access.actorId })
    return { ...stay, scheduled_message_id: scheduledMessageId }
  })
}

/**
 * The host cancels a stay. One the guest paid for on the site returns the whole
 * payment, as Airbnb's host cancellation does: the refund is queued in the same
 * batch, only under the host's approved financial authorization, and sent by
 * the caller that holds it (server/api/dashboard/payments/refund.post.ts).
 * Without one the cancellation is refused with where to approve it.
 */
export async function cancelStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: { version: unknown; reason?: unknown; authorization_id?: string; financial_writes_allowed?: boolean }): Promise<StayDetail & { channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const current = await getStay(db, access, stayId)
  if (isChannelManagedStay(current)) channelOwned(current, 'belongs to')
  if (input.version !== current.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  const reason = optionalText(input.reason, 'reason', 500)
  const complete = async (version: number) => {
    const channelPush = await pushNights(db, env, access, current.product_id, [[current.check_in_date, current.check_out_date]])
    return completeChannelPush(channelPush, { product_id: current.product_id, booking_id: stayId, version, ranges: [[current.check_in_date, current.check_out_date]] }, async () => {
      await planSourceMessages(db, access.organizationId, stayId)
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
    action: 'cancel', organizationId: access.organizationId, actorUserId: access.actorId, bookingId: stayId,
    authorizationId: input.authorization_id, financialWritesAllowed: input.financial_writes_allowed, note: reason ?? undefined, now,
    committed: { query: "EXISTS(SELECT 1 FROM bookings WHERE organization_id=? AND id=? AND status='cancelled' AND version=?)", params: [access.organizationId, stayId, next] },
  })
  const turnovers = await turnoverTaskQueries(db, { organizationId: access.organizationId, now, before: current, after: { ...current, status: 'cancelled' } })
  const results = await executeBatch(db, [
    {
      query: `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, version = ?, updated_at = ?
              WHERE organization_id = ? AND id = ? AND version = ? AND owner = 'app' AND status <> 'cancelled' AND product_session_id IS NULL AND (${refund.guard?.query ?? '1 = 1'})`,
      params: [now, reason, next, now, access.organizationId, stayId, current.version, ...(refund.guard?.params ?? [])],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: current.location_id, actorId: access.actorId, eventType: 'stay.cancelled', entityType: 'stay', entityId: stayId, onlyIfPreviousChangedOneRow: true }),
    ...reconcileNightsQueries(access.organizationId, stayId, { updated_at: now, version: next, product_id: current.product_id, starts_at: current.starts_at, ends_at: current.ends_at, check_in_date: current.check_in_date, check_out_date: current.check_out_date }),
    ...refund.queries,
    ...turnovers,
    ...stayReadyRevisionQueries({ organizationId: access.organizationId, stayId, now, cancelled: true,
      guard: { query: "EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND status = 'cancelled' AND version = ?)", params: [access.organizationId, stayId, next] } }),
  ], { operation: 'Cancel stay' })
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  return complete(next)
}

/** What cancelling a stay returns to its guest now, by the policy they booked under, out of what they paid. */
export interface StayCancellationQuote { policy: StayBookedPolicy; paid_minor: number; refund_minor: number; currency: string }

/** The guest's own stay, paid on the site and still theirs to cancel, with what cancelling returns now. */
async function guestStayCancellation(db: DbClient, organizationId: string, stayId: string, buyerUserId: string, now: string) {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT ${STAY_COLUMNS} FROM ${STAY_FROM}
     WHERE s.organization_id = ? AND s.id = ? AND s.user_id = ? AND s.owner = 'app' AND s.channel = 'direct' AND s.product_session_id IS NULL`, [organizationId, stayId, buyerUserId])
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That stay is not yours to cancel', 'booking_id')
  const stay = mapStay(row)
  const payment = await queryFirst<Payment>(db, "SELECT * FROM payments WHERE organization_id = ? AND subject_type = 'booking' AND subject_id = ? AND captured_amount > 0", [organizationId, stayId])
  if (!payment) fail(409, 'STAY_NOT_PAID_ONLINE', 'This stay was not paid on the site. Contact the host to cancel it.', 'booking_id')
  if (!stay.cancellation_policy) throw new Error(`Stay ${stayId} was paid on the site without a cancellation policy`)
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  const purchase = isRecord(snapshot) ? snapshot.stay : undefined
  if (!isRecord(purchase) || !Array.isArray(purchase.nightly)) throw new Error(`Stay ${stayId} payment has no nightly prices`)
  const home = await queryFirst<{ check_in_time: string | null }>(db, 'SELECT check_in_time FROM product_booking_configs WHERE organization_id = ? AND product_id = ?', [organizationId, stay.product_id])
  if (!home) throw new Error(`Stay ${stayId} has no home`)
  if (home.check_in_time === null) fail(409, 'STAY_CANCELLATION_TIME_REQUIRED', 'The home has no check-in time for calculating the cancellation refund. Contact the host to cancel.', 'check_in_time')
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
  home: { name: string; organization_name: string; check_in_time: string | null; check_out_time: string | null; image_url: string | null; location: { address: PostalAddress | null; latitude: number | null; longitude: number | null; maps_url: string | null } | null; arrival_guide: StayArrivalGuide | null; house_rules: string[]; safety: string[] }
  /** Null once the stay is cancelled, or for a stay not paid on the site. */
  cancellation: StayCancellationQuote | null
}

/** The account's stay by its activity ID: its conversation's ID, or the stay's own when it has none. */
export async function readGuestStay(db: DbClient, buyerUserId: string, activityId: string): Promise<GuestStay> {
  const owned = await queryFirst<{ id: string; conversation_id: string; organization_id: string; product_id: string; status: string; name: string; organization_name: string; check_in_time: string | null; check_out_time: string | null; address: string | null; latitude: number | null; longitude: number | null; maps_url: string | null; paid_online: number }>(db, `
    SELECT s.id, r.id AS conversation_id, s.organization_id, s.product_id, s.status, p.name, o.name AS organization_name, b.check_in_time, b.check_out_time, l.address, l.latitude, l.longitude, l.maps_url,
           EXISTS (SELECT 1 FROM payments WHERE organization_id = s.organization_id AND subject_type = 'booking' AND subject_id = s.id AND captured_amount > 0) AS paid_online
      FROM conversations r JOIN bookings s ON s.id = r.booking_id AND s.organization_id = r.organization_id
      JOIN products p ON p.organization_id = s.organization_id AND p.id = s.product_id
      JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN product_booking_configs b ON b.organization_id = s.organization_id AND b.product_id = s.product_id
      JOIN organization o ON o.id = s.organization_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE r.id = ? AND r.kind = 'booking' AND s.user_id = ? AND s.owner = 'app' AND s.product_session_id IS NULL`, [activityId, buyerUserId])
  if (!owned) fail(404, 'STAY_NOT_FOUND', 'That stay is not in your account', 'booking_id')
  await ownedBuyerRequest(db, buyerUserId, owned.conversation_id)
  const [stay, pictures] = await Promise.all([
    getStay(db, { organizationId: owned.organization_id, actorId: buyerUserId, manage: true }, owned.id),
    loadOwnerPictures(db, owned.organization_id, 'product', [owned.product_id], { organizationFallback: false }),
  ])
  if (stay.user_id !== buyerUserId || isChannelManagedStay(stay)) fail(404, 'STAY_NOT_FOUND', 'That stay is not in your account', 'booking_id')
  const cancellation = stay.status !== 'cancelled' && owned.paid_online === 1 && owned.check_in_time !== null
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
    if (isBookingDay(stay.ends_at) ? localDateAt(new Date(), stay.timezone) <= stay.check_out_date : Date.now() < Date.parse(stay.ends_at)) {
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
    const turnovers = await turnoverTaskQueries(db, { organizationId, now, before: stay, after: { ...stay, status: 'cancelled' } })
    const results = await executeBatch(db, [
      {
        query: `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancellation_reason = 'guest_cancelled', version = ?, updated_at = ?
                WHERE organization_id = ? AND id = ? AND version = ? AND user_id = ? AND status <> 'cancelled' AND product_session_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM payment_refunds WHERE payment_id = ? AND status IN ('queued','creating','pending','requires_action'))`,
        params: [now, next, now, organizationId, stayId, stay.version, buyerUserId, payment.id],
      },
      organizationEventQuery({ organizationId, locationId: stay.location_id, actorId: buyerUserId, eventType: 'stay.cancelled', entityType: 'stay', entityId: stayId, metadata: { by: 'guest', refund_minor: quote.refund_minor }, onlyIfPreviousChangedOneRow: true }),
      ...reconcileNightsQueries(organizationId, stayId, { updated_at: now, version: next, product_id: stay.product_id, starts_at: stay.starts_at, ends_at: stay.ends_at, check_in_date: stay.check_in_date, check_out_date: stay.check_out_date }),
      ...(quote.refund_minor > 0 ? [{
        query: `INSERT INTO payment_refunds (id, payment_id, idempotency_key, amount, reason, status, created_by, created_at, updated_at)
                SELECT ?, ?, ?, ?, 'requested_by_customer', 'queued', ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND status = 'cancelled' AND version = ?)
                ON CONFLICT(idempotency_key) DO NOTHING`,
        params: [crypto.randomUUID(), payment.id, key, amount, buyerUserId, now, now, organizationId, stayId, next],
      }] : []),
      ...turnovers,
    ], { operation: 'Guest cancels stay' })
    if (!versionChanged(results)) fail(409, 'STAY_NOT_CANCELLABLE', 'This stay changed or a refund is already on its way. Reload it and try again.', 'booking_id')
  } else if (stay.cancellation_reason !== 'guest_cancelled') {
    fail(409, 'STAY_ALREADY_CANCELLED', 'This stay was already cancelled', 'booking_id')
  }
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
  return completeChannelPush(channelPush, { product_id: stay.product_id, booking_id: stayId, version: stay.status === 'cancelled' ? stay.version : stay.version + 1, ranges: [[stay.check_in_date, stay.check_out_date]] }, async () => {
    await planSourceMessages(db, organizationId, stayId)
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
      query: `INSERT INTO offline_payments (id, organization_id, booking_id, amount_minor, currency, method, paid_on, reference, note, idempotency_key, created_at, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, access.organizationId, stay.id, payment.amount_minor, stay.currency, payment.method, payment.paid_on, payment.reference, payment.note, key, now, access.actorId],
    },
    organizationEventQuery({ organizationId: access.organizationId, locationId: stay.location_id, actorId: access.actorId, eventType: 'stay.payment_recorded', entityType: 'stay', entityId: stay.id, metadata: { payment_id: id, amount_minor: payment.amount_minor } }),
  ]
}

export async function recordStayPayment(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, stayId: string, input: Record<string, unknown>): Promise<{ stay: StayDetail; payment: StayPayment }> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (isChannelManagedStay(stay)) channelOwned(stay, 'is paid through')
  const payment = stayPaymentFields(input, '', true)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  // Read the exact recorded row by its durable key, never by its position in
  // payment history. A retry also finishes a failed dashboard publication.
  const replay = async () => {
    const existing = await queryFirst<StayPaymentFields & { id: string; booking_id: string }>(db,
      'SELECT id, booking_id, amount_minor, method, paid_on, reference, note FROM offline_payments WHERE organization_id = ? AND idempotency_key = ?', [access.organizationId, key])
    if (!existing) return null
    if (existing.booking_id !== stayId || Object.entries(payment).some(([field, value]) => existing[field as keyof StayPaymentFields] !== value)) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency_key was already used for a different payment', 'idempotency_key')
    await publishStayInvalidation(env, { type: 'stay.changed', organization_id: access.organizationId, location_id: stay.location_id, product_id: stay.product_id, booking_id: stayId }, { version: stay.version })
    const updated = await getStay(db, access, stayId)
    const recorded = updated.payments.find(entry => entry.id === existing.id)
    if (!recorded) fail(409, 'PAYMENT_CHANGED', 'The payment was recorded but removed before readback. Reload the stay before another change.', 'payment_id', { committed: true, booking_id: stayId })
    return { stay: updated, payment: recorded }
  }
  const earlier = await replay()
  if (earlier) return earlier
  try {
    await executeBatch(db, stayPaymentInsert(access, stay, payment, key, new Date().toISOString()), { operation: 'Record stay payment' })
  } catch (error) {
    if (/UNIQUE constraint failed: offline_payments\.organization_id, offline_payments\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
    throw error
  }
  const recorded = await replay()
  if (!recorded) fail(409, 'PAYMENT_CHANGED', 'The payment was recorded but removed before readback. Reload the stay before another change.', 'payment_id', { committed: true, booking_id: stayId })
  return recorded
}

export async function deleteStayPayment(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, stayId: string, paymentId: string): Promise<StayDetail> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  if (!stay.payments.some(payment => payment.id === paymentId)) fail(404, 'PAYMENT_NOT_FOUND', 'That payment is not on this stay')
  await executeBatch(db, [
    { query: 'DELETE FROM offline_payments WHERE organization_id = ? AND booking_id = ? AND id = ?', params: [access.organizationId, stayId, paymentId] },
    organizationEventQuery({ organizationId: access.organizationId, locationId: stay.location_id, actorId: access.actorId, eventType: 'stay.payment_deleted', entityType: 'stay', entityId: stayId, metadata: { payment_id: paymentId }, onlyIfPreviousChangedOneRow: true }),
  ], { operation: 'Delete stay payment' })
  await publishStayInvalidation(env, { type: 'stay.changed', organization_id: access.organizationId, location_id: stay.location_id, product_id: stay.product_id, booking_id: stayId }, { version: stay.version })
  return getStay(db, access, stayId)
}

/**
 * Set the host's rules for a run of nights. A field left out keeps each
 * night's current value; `price_minor: null` returns a night to the base
 * price. `reset: true` removes every override in the range instead.
 */
/** Both snapshots execute inside the calendar write's D1 batch, so concurrent writes cannot contaminate the evidence. */
function nightAudit(home: StayHome, access: StayAccess, dates: readonly string[], eventType: 'stay.nights_changed' | 'stay.nights_imported', metadata: unknown, receivedNights?: readonly ImportedNight[]) {
  const id = crypto.randomUUID()
  const snapshot = {
    query: `SELECT json_object('defaults', json(?), 'nights', json_group_array(json_object(
      'date', d.value, 'override', CASE WHEN n.date IS NULL THEN NULL ELSE json_object(
        'closed', n.closed, 'price_minor', ${STAY_NIGHT_PRICE_SQL}, 'min_stay_arrival', n.min_stay_arrival,
        'max_stay', n.max_stay, 'closed_to_arrival', n.closed_to_arrival, 'closed_to_departure', n.closed_to_departure,
        'source', n.source, 'updated_at', n.updated_at, 'updated_by', n.updated_by) END)))
      FROM json_each(?) d LEFT JOIN product_nights n ON n.organization_id = ? AND n.product_id = ? AND n.date = d.value`,
    params: [JSON.stringify({ currency: home.currency, base_price_minor: home.base_price_minor, min_nights: home.min_nights, calendar_rules: home.calendar_rules }), JSON.stringify([...dates].sort()), access.organizationId, home.product_id],
  } satisfies BatchQuery
  return {
    before: organizationEventQuery({ id, organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId,
      eventType, entityType: 'product', entityId: home.product_id, context: access.audit, metadata,
      beforeStateQuery: receivedNights ? { query: `SELECT json_set((${snapshot.query}), '$.received_nights', json(?))`, params: [...snapshot.params, JSON.stringify(receivedNights)] } : snapshot }),
    after: { query: `UPDATE activity_entries SET payload_json = json_set(payload_json, '$.afterState', json((${snapshot.query}))) WHERE id = ?`, params: [...snapshot.params, id] },
  }
}

export async function setStayNights(db: DbClient, env: StayMutationEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; from: unknown; to: unknown }): Promise<{ home: StayHome; nights: StayNight[]; stays: Stay[]; channel_push: SuccessfulChannelPush | null }> {
  requireManager(access)
  const unknown = Object.keys(input).find(key => !['organization_id', 'product_id', 'from', 'to', 'weekdays', 'reset', 'closed', 'price_minor', 'price_change_percent', 'min_stay_arrival', 'max_stay', 'closed_to_arrival', 'closed_to_departure'].includes(key))
  if (unknown) fail(422, 'INVALID_STAY_FIELD', `${unknown} is not a night setting`, unknown)
  const { from, to } = range(input, STAY_CALENDAR_DAYS)
  // Weekdays narrow [from, to) to the nights falling on them, 0 Sunday to 6 Saturday.
  let weekdays: number[] | null = null
  if (input.weekdays !== undefined) {
    if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) || new Set(input.weekdays).size !== input.weekdays.length) {
      fail(422, 'INVALID_STAY_FIELD', 'weekdays must list distinct whole numbers from 0 (Sunday) to 6 (Saturday)', 'weekdays')
    }
    weekdays = input.weekdays as number[]
  }
  const dates = Array.from({ length: days(from, to) }, (_, offset) => addDays(from, offset)).filter(night => !weekdays || weekdays.includes(new Date(`${night}T00:00:00Z`).getUTCDay()))
  if (!dates.length) fail(422, 'INVALID_STAY_FIELD', 'No night in this range falls on the chosen weekdays', 'weekdays')
  const home = await readStayHome(db, access, input.product_id)
  const patch: Record<string, number | null> = {}
  if (input.closed !== undefined) { if (typeof input.closed !== 'boolean') fail(422, 'INVALID_STAY_FIELD', 'closed must be true or false', 'closed'); patch.closed = input.closed ? 1 : 0 }
  const price = input.price_minor === undefined || input.price_minor === null ? input.price_minor : amount(input.price_minor, 'price_minor')
  let percent: number | null = null
  if (input.price_change_percent !== undefined) {
    if (input.price_minor !== undefined) fail(422, 'INVALID_STAY_FIELD', 'Set a nightly price or change it by a percent, not both', 'price_change_percent')
    percent = count(input.price_change_percent, 'price_change_percent', -NIGHT_PRICE_CHANGE_PERCENT, NIGHT_PRICE_CHANGE_PERCENT)
    if (percent === 0) fail(422, 'INVALID_STAY_FIELD', 'price_change_percent must change the price', 'price_change_percent')
  }
  for (const field of ['min_stay_arrival', 'max_stay'] as const) {
    if (input[field] !== undefined) patch[field] = input[field] === null ? null : count(input[field], field, 1, MAX_STAY_NIGHTS)
  }
  for (const field of ['closed_to_arrival', 'closed_to_departure'] as const) {
    if (input[field] !== undefined) { if (typeof input[field] !== 'boolean') fail(422, 'INVALID_STAY_FIELD', `${field} must be true or false`, field); patch[field] = input[field] ? 1 : 0 }
  }
  const reset = input.reset === true
  if (reset === (Object.keys(patch).length > 0 || price !== undefined || percent !== null)) fail(422, 'INVALID_STAY_FIELD', reset ? 'reset cannot be combined with night settings' : 'Name at least one night setting to change, or reset')
  // A percent moves each night's own current price: its set price, read and changed in the one
  // statement so two changes at once both land, or the listing's for that date when it has none.
  const listing = new Map<string, number>()
  if (percent !== null) {
    for (const night of await homeNights(db, access.organizationId, home, from, to)) {
      if (!dates.includes(night.date)) continue
      if (night.price_minor === null) fail(422, 'STAY_PRICE_MISSING', `${night.date} has no price to change; set a nightly price instead`, 'price_change_percent')
      if (changeNightPrice(night.price_minor, percent) > Number.MAX_SAFE_INTEGER) fail(422, 'INVALID_AMOUNT', `${night.date}'s price would be too large`, 'price_change_percent')
      const listed = resolveStayNightPolicy(home, night.date).price_minor
      if (listed !== null) listing.set(night.date, changeNightPrice(listed, percent))
    }
  }
  await requireChannelPush(db, env, access.organizationId, home.product_id)
  const now = new Date().toISOString()
  const columns = Object.keys(patch)
  const nights = JSON.stringify(dates.map(date => ({
    id: crypto.randomUUID(), date, price_minor: percent === null ? price ?? null : listing.get(date) ?? null,
  })))
  const written = [...columns, ...(price !== undefined || percent !== null ? ['price_minor'] : [])]
  const audit = nightAudit(home, access, dates, 'stay.nights_changed', {
    from, to, reset, fields: written.join(','), settings: { ...patch, ...(price === undefined ? {} : { price_minor: price }) },
    ...(weekdays ? { weekdays: weekdays.join(',') } : {}), ...(percent === null ? {} : { price_change_percent: percent }),
  })
  // A night with no price of its own moves from the listing's price as read above; the batch refuses if the listing changed since.
  const listingGuard = { query: "SELECT CASE WHEN EXISTS (SELECT 1 FROM products WHERE organization_id = ? AND id = ? AND updated_at = ?) THEN NULL ELSE json('Stay listing changed') END", params: [access.organizationId, home.product_id, home.product_updated_at] }
  const datesSql = "SELECT json_extract(value, '$.date') FROM json_each(?)"
  const priceScope = 'organization_id = ? AND product_variant_id = ?'
  const priceParams = [access.organizationId, home.variant_id]
  const prices: BatchQuery[] = []
  if (reset || price === null) prices.push({
    query: `DELETE FROM prices WHERE ${priceScope} AND stay_date IN (${datesSql})`, params: [...priceParams, nights],
  })
  else if (price !== undefined || percent !== null) prices.push({
    query: `INSERT INTO prices (id, organization_id, product_variant_id, stay_date, currency, unit_amount, source, created_at, updated_at, created_by, updated_by)
      SELECT json_extract(d.value, '$.id'), ?, ?, json_extract(d.value, '$.date'), ?,
        CASE WHEN p.id IS NOT NULL AND ? IS NOT NULL THEN (p.unit_amount * (100 + CAST(? AS INTEGER)) + 50) / 100 ELSE json_extract(d.value, '$.price_minor') END,
        'host', ?, ?, ?, ?
      FROM json_each(?) d LEFT JOIN prices p ON p.organization_id = ? AND p.product_variant_id = ? AND p.stay_date = json_extract(d.value, '$.date')
      WHERE true ON CONFLICT (product_variant_id, stay_date) DO UPDATE SET unit_amount = excluded.unit_amount, currency = excluded.currency,
        source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    params: [...priceParams, home.currency, percent, percent, now, now, access.actorId, access.actorId, nights, ...priceParams],
  })
  if (percent !== null) prices.push({
    query: `SELECT CASE WHEN EXISTS (SELECT 1 FROM prices WHERE ${priceScope} AND stay_date IN (${datesSql}) AND unit_amount > 9007199254740991) THEN json('Night price too large') ELSE NULL END`,
    params: [...priceParams, nights],
  })
  await executeBatch(db, [
    listingGuard, audit.before,
    reset
      ? { query: `DELETE FROM product_nights WHERE organization_id = ? AND product_id = ? AND date IN (${datesSql})`, params: [access.organizationId, home.product_id, nights] }
      : {
          query: `INSERT INTO product_nights (organization_id, product_id, date, source, updated_at, updated_by${columns.map(column => `, ${column}`).join('')})
                  SELECT ?, ?, json_extract(value, '$.date'), 'host', ?, ?${columns.map(() => ', ?').join('')} FROM json_each(?) WHERE true
                  ON CONFLICT (product_id, date) DO UPDATE SET source = 'host', updated_at = excluded.updated_at, updated_by = excluded.updated_by${columns.map(column => `, ${column} = excluded.${column}`).join('')}`,
          params: [access.organizationId, home.product_id, now, access.actorId, ...columns.map(column => patch[column]), nights],
        },
    ...prices,
    audit.after,
  ], { operation: 'Set stay nights' }).catch(async (cause: unknown) => {
    if (percent !== null && String(cause).includes('Night price too large')) fail(422, 'INVALID_AMOUNT', 'A night’s price would be too large', 'price_change_percent')
    if ((await readStayHome(db, access, home.product_id)).product_updated_at !== home.product_updated_at) {
      fail(409, 'STAY_HOME_CHANGED', 'The listing changed while its nights were being edited. Reload the calendar and try again.', 'product_id')
    }
    throw cause
  })
  // The channel hears the runs of nights that changed.
  const ranges: Array<[string, string]> = []
  for (const night of dates) {
    const last = ranges.at(-1)
    if (last?.[1] === night) last[1] = addDays(night, 1)
    else ranges.push([night, addDays(night, 1)])
  }
  const channelPush = await pushNights(db, env, access, home.product_id, ranges)
  return completeChannelPush(channelPush, { product_id: home.product_id, updated_at: now, ranges }, async () => {
    await publishStayInvalidation(env, { type: 'nights.changed', organization_id: access.organizationId, location_id: home.location_id, product_id: home.product_id, booking_id: null }, { updated_at: now })
    return readStayCalendar(db, access, { productId: home.product_id, from, to })
  })
}

/** One night of a channel's calendar. Airbnb's minimum applies to arrivals on that date. */
export interface ImportedNight {
  date: string
  available: boolean
  price_minor: number | null
  min_stay_arrival: number | null
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
  const audit = nightAudit(home, access, nights.map(night => night.date), 'stay.nights_imported', {
    from: nights[0]!.date, to: nights.at(-1)!.date, nights: nights.length, provider: 'channex',
  }, nights)
  const incoming = JSON.stringify(nights.map(night => ({
    id: crypto.randomUUID(), date: night.date, closed: night.available ? 0 : 1, price_minor: night.price_minor,
    min_stay_arrival: night.min_stay_arrival, max_stay: night.max_stay,
    closed_to_arrival: night.closed_to_arrival ? 1 : 0, closed_to_departure: night.closed_to_departure ? 1 : 0,
  })))
  const importedDates = `FROM json_each(?) d JOIN product_nights n ON n.organization_id = ? AND n.product_id = ? AND n.date = json_extract(d.value, '$.date')
    WHERE n.source = 'import'`
  const dateParams = [incoming, access.organizationId, home.product_id]
  await executeBatch(db, [
    audit.before,
    {
      query: `INSERT INTO product_nights (organization_id, product_id, date, closed, min_stay_arrival, max_stay, closed_to_arrival, closed_to_departure, source, updated_at, updated_by)
              SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.closed'), json_extract(value, '$.min_stay_arrival'),
                     json_extract(value, '$.max_stay'), json_extract(value, '$.closed_to_arrival'), json_extract(value, '$.closed_to_departure'), 'import', ?, ?
                FROM json_each(?) WHERE true
              ON CONFLICT (product_id, date) DO UPDATE SET closed = excluded.closed, min_stay_arrival = excluded.min_stay_arrival,
                max_stay = excluded.max_stay, closed_to_arrival = excluded.closed_to_arrival, closed_to_departure = excluded.closed_to_departure,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by
              WHERE product_nights.source = 'import'`,
      params: [access.organizationId, home.product_id, now, access.actorId, incoming],
    }, {
      query: `DELETE FROM prices WHERE organization_id = ? AND product_variant_id = ? AND stay_date IN
        (SELECT n.date ${importedDates} AND json_extract(d.value, '$.price_minor') IS NULL)`,
      params: [access.organizationId, home.variant_id, ...dateParams],
    }, {
      query: `INSERT INTO prices (id, organization_id, product_variant_id, stay_date, currency, unit_amount, source, created_at, updated_at, created_by, updated_by)
        SELECT json_extract(d.value, '$.id'), ?, ?, n.date, ?, json_extract(d.value, '$.price_minor'), 'import', ?, ?, ?, ?
        ${importedDates} AND json_extract(d.value, '$.price_minor') IS NOT NULL
        ON CONFLICT (product_variant_id, stay_date) DO UPDATE SET currency = excluded.currency, unit_amount = excluded.unit_amount,
          source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      params: [access.organizationId, home.variant_id, home.currency, now, now, access.actorId, access.actorId, ...dateParams],
    },
    audit.after,
  ], { operation: 'Import stay nights' })
  await publishStayInvalidation(env, { type: 'nights.changed', organization_id: access.organizationId, location_id: home.location_id, product_id: home.product_id, booking_id: null }, { updated_at: now })
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
  /** Channex loaded it from the channel's existing reservations (a home's import), rather than receiving it as it was booked. */
  imported: boolean
}

/**
 * Lands a channel booking on a home (conflict rule 1). A channel stay always
 * lands: if one of its nights is already held, it is stored overbooked and
 * holds no night, for the host to resolve. A delivery older than the stay
 * already stored changes nothing, so repeated and out-of-order deliveries are
 * harmless. Returns the stay as stored.
 */
/** What a channel revision changed on its stay, as its owners are told it. */
export type ChannelStayTerms = Pick<Stay, 'status' | 'overbooked' | 'product_id' | 'check_in_date' | 'check_out_date' | 'adults' | 'children' | 'infants' | 'total_minor'>

/**
 * The stay as the revision left it, whether this revision changed it, and —
 * for the revision that wrote it, and on a replay while it is the stay's
 * current revision — the terms it replaced and the terms it wrote, read back
 * from the revision's own audit so a replay finds the same change. `change`
 * is null for a revision another has superseded, and for one landed before
 * its terms were recorded.
 */
export async function applyChannelBooking(db: DbClient, env: GuestInboxPublicationEnv & CloudflareEnv, organizationId: string, productId: string, booking: ChannelBooking): Promise<Stay & { applied: boolean; change: { previous: ChannelStayTerms | null; terms: ChannelStayTerms } | null }> {
  date(booking.check_in_date, 'check_in_date')
  date(booking.check_out_date, 'check_out_date')
  if (booking.check_out_date <= booking.check_in_date) throw new Error(`Channel booking ${booking.external_booking_id} ends before it starts`)
  if (booking.adults < 1) throw new Error(`Channel booking ${booking.external_booking_id} has no adult guest`)
  if (!/^[A-Z]{3}$/.test(booking.currency)) throw new Error(`Channel booking ${booking.external_booking_id} has an invalid currency`)
  type ChannelStayRow = { id: string; product_id: string; booked_product_id: string | null; provider_updated_at: string | null; revision_id: string | null; external_booking_id: string | null; user_id: string | null; conversation_id: string | null }
  const currentChannelStay = () => queryFirst<ChannelStayRow>(db,
    `SELECT id, product_id, booked_product_id, provider_updated_at, revision_id, external_booking_id, user_id, (SELECT c.id FROM conversations c WHERE c.booking_id = bookings.id AND c.kind = 'booking') AS conversation_id FROM bookings WHERE provider = ? AND external_booking_id = ?`, [booking.provider, booking.external_booking_id])
  // The same reservation under a new provider booking id (a re-import after a
  // new Channex account) is the stay it already is: the revision's write moves
  // it onto the new id, when that revision is newer than the stay.
  const existing = await currentChannelStay() ?? (booking.channel_booking_id === null ? null : await queryFirst<ChannelStayRow>(db,
    `SELECT id, product_id, booked_product_id, provider_updated_at, revision_id, external_booking_id, user_id, (SELECT c.id FROM conversations c WHERE c.booking_id = bookings.id AND c.kind = 'booking') AS conversation_id FROM bookings WHERE organization_id = ? AND channel = ? AND channel_booking_id = ?
      AND ((provider = ? AND external_booking_id <> ?) OR owner = 'app')`,
    [organizationId, booking.channel, booking.channel_booking_id, booking.provider, booking.external_booking_id]))
  // A revision names the listing it was booked on. A guest the host moved stays where they sleep; a revision for another listing is a real re-map.
  const landing = existing?.booked_product_id === productId ? existing.product_id : productId
  if (existing?.external_booking_id === null && existing.product_id !== landing) fail(409, 'CHANNEL_MIGRATION_HOME_CONFLICT', 'This reservation was imported into a different occupied home. Resolve its property assignment before accepting the channel revision.', 'product_id')
  const reimported = existing && existing.external_booking_id !== booking.external_booking_id ? existing.external_booking_id : null
  const conversation = await queryFirst<{ organization_id: string; product_id: string; conversation_id: string }>(db,
    'SELECT organization_id, product_id, conversation_id AS conversation_id FROM channel_threads WHERE provider = ? AND external_booking_id = ?', [booking.provider, booking.external_booking_id])
  if (conversation && (conversation.organization_id !== organizationId || conversation.product_id !== productId)) {
    throw new HTTPError({ statusCode: 409, message: 'The provider booking and conversation belong to different homes', data: { code: 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', field: 'external_booking_id' } })
  }
  // The channel's conversation about this reservation is its booking's one conversation: a booking that opened its own joins it.
  const joinChannelConversation = async (bookingId: string, from: string, into: string) => executeBatch(db,
    await joinBookingConversationQueries(db, { organizationId, bookingId, from, into, now: new Date().toISOString() }), { operation: 'Join channel booking conversation' })
  if (conversation && existing && existing.conversation_id !== null && existing.conversation_id !== conversation.conversation_id) await joinChannelConversation(existing.id, existing.conversation_id, conversation.conversation_id)
  const revisionKey = `channel-revision:${JSON.stringify([organizationId, booking.provider, booking.external_booking_id, booking.revision_id])}`
  const recordedChange = async (): Promise<{ previous: ChannelStayTerms | null; terms: ChannelStayTerms } | null> => {
    const audit = await queryFirst<{ previous: string | null; terms: string | null; type: string | null }>(db, `SELECT json_extract(payload_json, '$.metadata.previous_terms') AS previous,
      json_extract(payload_json, '$.metadata.terms') AS terms, json_type(payload_json, '$.metadata.previous_terms') AS type
      FROM activity_entries WHERE organization_id = ? AND dedupe_key = ?`, [organizationId, revisionKey])
    if (!audit) throw new HTTPError({ statusCode: 503, message: 'The saved channel revision has no audit', data: { code: 'CHANNEL_REVISION_AUDIT_REQUIRED', field: 'revision_id', revision_id: booking.revision_id } })
    if (audit.type === null) return null
    if (!audit.terms) throw new HTTPError({ statusCode: 500, message: 'The channel revision audit records what it replaced but not what it wrote', data: { code: 'CHANNEL_REVISION_AUDIT_INVALID', field: 'terms', revision_id: booking.revision_id } })
    const read = (value: string) => { const terms = JSON.parse(value) as ChannelStayTerms; return { ...terms, overbooked: Boolean(terms.overbooked) } }
    return { previous: audit.type === 'null' ? null : read(audit.previous!), terms: read(audit.terms) }
  }
  const publish = async (stored: Stay, currentRevisionId: string | null) => {
    if (currentRevisionId === null) throw new HTTPError({ statusCode: 503, message: 'The saved channel stay has no current revision identity', data: { code: 'CHANNEL_REVISION_ID_REQUIRED', field: 'revision_id', committed: true, booking_id: stored.id, product_id: stored.product_id, version: stored.version } })
    const receipt = await queryFirst<Record<string, unknown>>(db, `SELECT
      json_extract(payload_json, '$.entityId') AS booking_id,
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
      FROM activity_entries WHERE organization_id = ? AND dedupe_key = ?`, [organizationId, revisionKey])
    if (receipt) {
      const scope = (product: unknown, location: unknown) => typeof product === 'string' && Boolean(product) && typeof location === 'string' && Boolean(location)
      if (receipt.booking_id !== stored.id || receipt.provider !== booking.provider || receipt.external_booking_id !== booking.external_booking_id || receipt.revision_id !== booking.revision_id || receipt.provider_updated_at !== booking.provider_updated_at
        || !scope(receipt.product_id, receipt.location_id)
        || !((receipt.previous_product_id === null && receipt.previous_location_id === null && receipt.previous_product_type === 'null' && receipt.previous_location_type === 'null') || scope(receipt.previous_product_id, receipt.previous_location_id))) {
        throw new HTTPError({ statusCode: 500, message: 'The channel revision audit has invalid affected home identities', data: { code: 'CHANNEL_REVISION_AUDIT_INVALID', field: 'revision_id', revision_id: booking.revision_id, booking_id: stored.id } })
      }
      const published = new Set([stored.product_id])
      for (const [product, location] of [[receipt.previous_product_id, receipt.previous_location_id], [receipt.product_id, receipt.location_id]]) {
        if (typeof product !== 'string' || typeof location !== 'string' || published.has(product)) continue
        published.add(product)
        const affected = { organization_id: organizationId, location_id: location, product_id: product, booking_id: stored.id }
        await publishStayInvalidation(env, { ...affected, type: 'stay.changed' }, { version: stored.version })
        await publishStayInvalidation(env, { ...affected, type: 'nights.changed' }, { version: stored.version })
      }
    } else if (currentRevisionId === booking.revision_id) {
      throw new HTTPError({ statusCode: 503, message: 'The saved channel revision has no audit identifying its affected homes', data: { code: 'CHANNEL_REVISION_AUDIT_REQUIRED', field: 'revision_id', committed: true, revision_id: booking.revision_id, booking_id: stored.id, product_id: stored.product_id, version: stored.version } })
    }
    await publishStayChange(env, db, organizationId, stored, true)
  }
  if (existing && existing.provider_updated_at !== null && existing.provider_updated_at >= booking.provider_updated_at) {
    await planSourceMessages(db, organizationId, existing.id)
    const stored = await storedStay(db, organizationId, existing.id)
    await publish(stored, existing.revision_id)
    return { ...await storedStay(db, organizationId, existing.id), applied: false, change: existing.revision_id === booking.revision_id ? await recordedChange() : null }
  }
  const id = existing?.id ?? crypto.randomUUID()
  const previous = existing ? await storedStay(db, organizationId, existing.id) : null
  const [home] = await stayHomesWhere(db, organizationId, landing, { sql: '1 = 1', params: [] })
  if (!home) fail(404, 'STAY_HOME_NOT_FOUND', 'The channel booking home was not found', 'product_id')
  const guestName = [booking.guest_name, booking.guest_surname].map(part => part?.trim()).filter(Boolean).join(' ') || null
  // Every guest is a Better Auth user, an anonymous one carrying what the channel gave. A channel may send a
  // reservation naming no one: its conversation is then titled by the reservation, as a channel's own is, and
  // names no guest. A conversation the channel opened before the booking is the booking's.
  const reservation = `${STAY_CHANNEL_LABELS[booking.channel]} reservation ${booking.channel_booking_id ?? booking.external_booking_id}`
  const guestUserId = existing?.user_id ?? await createGuestUser(env, guestName ?? reservation)
  const window = stayWindow({ check_in_date: booking.check_in_date, check_out_date: booking.check_out_date, arrival_time: null }, home)
  const policy = await stayPolicy(db, organizationId, landing, null, null)
  const version = previous ? previous.version + 1 : 1
  const now = new Date().toISOString()
  const turnovers = await turnoverTaskQueries(db, { organizationId, now, before: previous,
    after: { id, product_id: landing, status: booking.cancelled ? 'cancelled' : 'confirmed', check_in_date: booking.check_in_date, check_out_date: booking.check_out_date } })
  // A moved guest's make-ready job follows the reservation's revisions: its home is where they sleep, not the listing the revision names.
  const landingHome = existing?.booked_product_id === productId && !booking.cancelled ? await queryFirst<{ check_in_time: string | null; timezone: string }>(db,
    `SELECT b.check_in_time, l.timezone FROM product_stay_configs c JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id
      JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id WHERE c.organization_id = ? AND c.product_id = ?`,
    [organizationId, landing]) : null
  const readyJob = existing?.booked_product_id === productId ? stayReadyRevisionQueries({ organizationId, stayId: id, now, cancelled: booking.cancelled,
    guard: { query: 'EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND revision_id = ?)', params: [organizationId, id, booking.revision_id] },
    dueAt: landingHome ? (landingHome.check_in_time === null ? null : localDateTimeToInstant(booking.check_in_date, landingHome.check_in_time, landingHome.timezone, 'compatible').toISOString()) : undefined,
    checkInDate: booking.check_in_date, guestName: stayGuestFirstName(booking.guest_name) }) : []
  const write = (overbooked: 0 | 1): BatchQuery[] => [...(existing?.external_booking_id === null ? [{
    // An imported OTA confirmation becomes channel-owned when its real revision arrives; keep its one stay and night claims.
    query: `UPDATE bookings SET owner = 'channel', provider = ?, external_booking_id = ? WHERE organization_id = ? AND id = ?
      AND owner = 'app' AND channel = ? AND channel_booking_id = ? AND product_id = ? AND version = ?`,
    params: [booking.provider, booking.external_booking_id, organizationId, existing.id, booking.channel, booking.channel_booking_id, previous?.product_id ?? null, previous?.version ?? null],
  }] : []), ...(reimported === null ? [] : [{
    query: `UPDATE bookings SET external_booking_id = ? WHERE organization_id = ? AND id = ? AND provider = ? AND external_booking_id = ?
      AND (provider_updated_at IS NULL OR provider_updated_at < ?)`,
    params: [booking.external_booking_id, organizationId, existing?.id ?? null, booking.provider, reimported, booking.provider_updated_at],
  }]), {
    // The claims' composite FK names the stay's home. Release a real move's
    // old claims before changing that home, under the same upsert guard. The
    // entire batch rolls back if its new claims or any later write fails.
    query: `DELETE FROM stay_nights WHERE organization_id = ? AND booking_id = ? AND product_id <> ?
      AND EXISTS (SELECT 1 FROM bookings st WHERE st.organization_id = ? AND st.id = ? AND st.product_id = ?
        AND (st.provider_updated_at IS NULL OR st.provider_updated_at < ?))`,
    params: [organizationId, id, landing, organizationId, existing?.id ?? null, previous?.product_id ?? null, booking.provider_updated_at],
  }, {
    query: `INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants,
              channel, owner, status, overbooked, policy_json, total_minor, currency, provider, external_booking_id, channel_booking_id, revision_id,
              provider_updated_at, cancelled_at, received_at, version, created_at, updated_at, booked_product_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'channel', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT (provider, external_booking_id) WHERE external_booking_id IS NOT NULL DO UPDATE SET
              product_id = excluded.product_id, product_variant_id = excluded.product_variant_id, location_id = excluded.location_id, timezone = excluded.timezone,
              starts_at = excluded.starts_at, ends_at = excluded.ends_at, channel = excluded.channel, status = excluded.status, overbooked = excluded.overbooked,
              party_size = excluded.party_size, adults = excluded.adults, children = excluded.children, infants = excluded.infants,
              total_minor = excluded.total_minor, currency = excluded.currency, channel_booking_id = excluded.channel_booking_id,
              revision_id = excluded.revision_id, provider_updated_at = excluded.provider_updated_at,
              cancelled_at = CASE WHEN excluded.status = 'cancelled' THEN COALESCE(bookings.cancelled_at, excluded.cancelled_at) ELSE NULL END,
              version = bookings.version + 1, updated_at = excluded.updated_at, booked_product_id = excluded.booked_product_id
            WHERE bookings.organization_id = excluded.organization_id AND bookings.id = ? AND bookings.product_id = ? AND bookings.version IS ?
              AND (bookings.provider_updated_at IS NULL OR bookings.provider_updated_at < excluded.provider_updated_at)`,
    params: [id, organizationId, guestUserId, landing, home.variant_id, home.location_id, window.starts_at, window.ends_at, home.timezone,
      booking.adults + booking.children, booking.adults, booking.children, booking.infants, booking.channel, booking.cancelled ? 'cancelled' : 'confirmed', overbooked, policy,
      booking.total_minor, booking.currency, booking.provider, booking.external_booking_id, booking.channel_booking_id, booking.revision_id,
      // A booking received as it happened starts the new-reservation messages; the import's history never does. An update keeps the first answer.
      booking.provider_updated_at, booking.cancelled ? now : null, booking.imported || booking.cancelled ? null : now, now, now, landing === productId ? null : productId, existing?.id ?? null, previous?.product_id ?? null, previous?.version ?? null],
  },
  // A listing whose guest was moved elsewhere still holds its nights: a second reservation landing on them is an overbooking, like one landing on claimed nights.
  // A stay that was cancelled or overbooked held no nights, so a revision that brings it back takes every night anew.
  ...(overbooked === 0 && !booking.cancelled ? bookedListingGuardQueries(organizationId, landing, id, previous && previous.status !== 'cancelled' && !previous.overbooked ? previous : null, booking) : []),
  organizationEventQuery({ organizationId, locationId: home.location_id, actorId: null, eventType: existing ? 'stay.updated' : 'stay.created', entityType: 'stay', entityId: id,
    dedupeKey: revisionKey, onlyIfPreviousChangedOneRow: true, metadata: { channel: booking.channel, overbooked: overbooked === 1,
      provider: booking.provider, external_booking_id: booking.external_booking_id, revision_id: booking.revision_id, provider_updated_at: booking.provider_updated_at,
      previous_product_id: previous?.product_id ?? null, previous_location_id: previous?.location_id ?? null, product_id: landing, location_id: home.location_id,
      previous_terms: previous && { status: previous.status, overbooked: previous.overbooked, product_id: previous.product_id, check_in_date: previous.check_in_date, check_out_date: previous.check_out_date,
        adults: previous.adults, children: previous.children, infants: previous.infants, total_minor: previous.total_minor },
      terms: { status: booking.cancelled ? 'cancelled' : 'confirmed', overbooked: overbooked === 1, product_id: landing, check_in_date: booking.check_in_date, check_out_date: booking.check_out_date,
        adults: booking.adults, children: booking.children, infants: booking.infants, total_minor: booking.total_minor } } }),
  ...reconcileNightsQueries(organizationId, id, { updated_at: now, version, product_id: landing, ...window, check_in_date: booking.check_in_date, check_out_date: booking.check_out_date }),
  // The conversation the channel opened before the guest booked is the booking's; otherwise the booking opens its own.
  {
    query: `UPDATE conversations SET booking_id = b.id, user_id = b.user_id, location_id = b.location_id FROM bookings b JOIN channel_threads t
        ON t.provider = b.provider AND t.external_booking_id = b.external_booking_id
        AND t.organization_id = b.organization_id AND t.product_id = COALESCE(b.booked_product_id, b.product_id)
      WHERE b.id = ? AND b.organization_id = ? AND b.product_id = ? AND b.version = ?
        AND conversations.id = t.conversation_id AND conversations.organization_id = b.organization_id AND conversations.kind = 'booking' AND conversations.booking_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM conversations booked WHERE booked.booking_id = b.id AND booked.kind = 'booking')`,
    params: [id, organizationId, landing, version],
  },
  ...bookingConversationQueries({ organizationId, bookingId: id, requestId: crypto.randomUUID(), locationId: home.location_id, userId: guestUserId, now,
    guest: { name: guestName, email: booking.guest_email, phone: booking.guest_phone }, ...(guestName === null ? { participant: { kind: 'channel' as const, title: reservation } } : {}) }),
  bookingContactQuery({ organizationId, bookingId: id, version, updatedAt: now, locationId: home.location_id, guest: { name: guestName, email: booking.guest_email, phone: booking.guest_phone } }),
  ...turnovers,
  ...readyJob,
  ]
  let writes: Awaited<ReturnType<typeof executeBatch>>
  try {
    writes = await executeBatch(db, write(0), { operation: 'Apply channel booking' })
  } catch (error) {
    if (!isStayNightConflict(error) && !isBookedListingHeld(error)) throw error
    // Rule 1: another stay holds one of these nights. The channel stay still lands, flagged and holding none.
    writes = await executeBatch(db, write(1), { operation: 'Apply overbooked channel booking' })
  }
  const changed = writes[existing?.external_booking_id === null || reimported !== null ? 2 : 1]?.meta.changes
  if (changed !== 0 && changed !== 1) fail(500, 'CHANNEL_REVISION_WRITE_RESULT_REQUIRED', 'The channel revision write did not report its affected row count', 'changes')
  const current = await currentChannelStay()
  if (!current) fail(500, 'CHANNEL_STAY_NOT_READABLE', 'The saved channel booking could not be read', 'external_booking_id')
  const stored = await storedStay(db, organizationId, current.id)
  if (changed === 0 && (current.provider_updated_at === null || current.provider_updated_at < booking.provider_updated_at)) {
    throw new HTTPError({ statusCode: 409, message: 'The channel booking home changed concurrently. Retry this revision from the feed.', data: { code: 'CHANNEL_REVISION_CONFLICT', field: 'revision_id', revision_id: booking.revision_id, booking_id: stored.id, version: stored.version } })
  }
  const linked = await queryFirst<{ conversation_id: string | null; mapped_conversation_id: string | null }>(db, `SELECT (SELECT c.id FROM conversations c WHERE c.booking_id = s.id AND c.kind = 'booking') AS conversation_id, t.conversation_id AS mapped_conversation_id FROM bookings s
    LEFT JOIN channel_threads t ON t.provider = s.provider AND t.external_booking_id = s.external_booking_id WHERE s.id = ?`, [stored.id])
  if (linked?.mapped_conversation_id && linked.conversation_id !== null && linked.conversation_id !== linked.mapped_conversation_id) await joinChannelConversation(stored.id, linked.conversation_id, linked.mapped_conversation_id)
  await planSourceMessages(db, organizationId, stored.id)
  await publish(stored, current.revision_id)
  return { ...await storedStay(db, organizationId, stored.id), applied: changed === 1, change: changed === 1 ? await recordedChange() : null }
}

async function publishStayChange(env: GuestInboxPublicationEnv, db: DbClient, organizationId: string, stay: Stay, nightsChanged: boolean): Promise<void> {
  const input = { organization_id: organizationId, location_id: stay.location_id, product_id: stay.product_id, booking_id: stay.id }
  await publishStayInvalidation(env, { ...input, type: 'stay.changed' }, { version: stay.version })
  if (nightsChanged) await publishStayInvalidation(env, { ...input, type: 'nights.changed' }, { version: stay.version })
  try {
    await publishConversationEvent(env, db, { conversationId: stay.conversation_id, type: 'MESSAGE_UPDATE' })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The stay was saved, but its conversation update could not be published. Reload before retrying.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, booking_id: stay.id, product_id: stay.product_id, version: stay.version, conversation_id: stay.conversation_id }, cause })
  }
}

async function storedStay(db: DbClient, organizationId: string, stayId: string): Promise<Stay> {
  const row = await queryFirst<Record<string, unknown>>(db, `
    SELECT ${STAY_COLUMNS} FROM ${STAY_FROM}
     WHERE s.organization_id = ? AND s.id = ? AND s.product_session_id IS NULL`, [organizationId, stayId])
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
  max_stay: number | null
  closed_to_arrival: boolean
  closed_to_departure: boolean
}

export interface PublicStayCalendar {
  home: { currency: CurrencyCode; timezone: string; today: string; check_in_time: string | null; check_out_time: string | null; max_guests: number; min_nights: number; calendar_rules: StayCalendarRules | null; base_price_minor: number | null }
  nights: PublicStayNight[]
}

function publicNight(night: StayNight, today: string): PublicStayNight {
  return {
    date: night.date,
    available: night.available && night.price_minor !== null && night.date >= today,
    price_minor: night.price_minor,
    min_stay_arrival: night.min_stay_arrival,
    max_stay: night.max_stay,
    closed_to_arrival: night.closed_to_arrival,
    closed_to_departure: night.closed_to_departure,
  }
}

/** The bookable nights of [from, to), plus `to` so the guest can select that departure. No claims are shown. */
export async function readPublicStayCalendar(db: DbClient, organizationId: string, slug: string, input: { from: unknown; to: unknown }): Promise<PublicStayCalendar> {
  const { from, to } = range(input, STAY_CALENDAR_DAYS)
  const home = await readPublicStayHome(db, organizationId, slug)
  const today = homeToday(home.timezone)
  const nights = await homeNights(db, organizationId, home, from, addDays(to, 1))
  return {
    home: { currency: home.currency, timezone: home.timezone, today, check_in_time: home.check_in_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, calendar_rules: home.calendar_rules, base_price_minor: home.base_price_minor },
    nights: nights.map(night => publicNight(night, today)),
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
  check_in_time: string | null
  check_out_time: string | null
  nights: number
  adults: number
  children: number
  infants: number
  nightly: Array<{ date: string; price_minor: number }>
  total_minor: number
  nightly_groups: Array<{ price_minor: number; nights: number; total_minor: number }>
  /** Guest comparison amounts derived from this quote; total_minor remains the booking amount. */
  price_summary: { basis: 'stay' | 'month'; amount_minor: number; display_amount_minor: number }
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
function stayNightRestriction(stayed: readonly StayNight[], departure: StayNight): { statusCode: number; code: string; message: string; field: string; detail?: Record<string, unknown> } | null {
  const arrival = stayed[0]
  if (!arrival) throw new Error('A stay interval requires at least one night')
  const taken = stayed.filter(night => !night.available).map(night => night.date)
  if (taken.length) return { statusCode: 409, code: 'STAY_NIGHTS_UNAVAILABLE', message: 'Some of these nights are no longer available', field: 'check_in_date', detail: { dates: taken } }
  const unpriced = stayed.find(night => night.price_minor === null)
  if (unpriced) return { statusCode: 409, code: 'STAY_NIGHT_UNPRICED', message: `${unpriced.date} has no nightly price yet`, field: 'check_in_date', detail: { date: unpriced.date } }
  if (arrival.closed_to_arrival) return { statusCode: 422, code: 'STAY_CLOSED_TO_ARRIVAL', message: `Guests cannot check in on ${arrival.date}`, field: 'check_in_date' }
  if (departure.closed_to_departure) return { statusCode: 422, code: 'STAY_CLOSED_TO_DEPARTURE', message: `Guests cannot check out on ${departure.date}`, field: 'check_out_date' }
  if (stayed.length < arrival.min_stay_arrival) return { statusCode: 422, code: 'STAY_MIN_NIGHTS', message: `Stays arriving on ${arrival.date} are at least ${arrival.min_stay_arrival} nights`, field: 'check_out_date', detail: { min_nights: arrival.min_stay_arrival } }
  if (arrival.max_stay !== null && stayed.length > arrival.max_stay) return { statusCode: 422, code: 'STAY_MAX_NIGHTS', message: `Stays arriving on ${arrival.date} are at most ${arrival.max_stay} nights`, field: 'check_out_date', detail: { max_nights: arrival.max_stay } }
  return null
}

export async function quoteStay(db: DbClient, organizationId: string, home: StayHome, input: StayQuoteInput): Promise<StayQuote> {
  const checkIn = date(input.check_in_date, 'check_in_date')
  const checkOut = date(input.check_out_date, 'check_out_date')
  const today = homeToday(home.timezone)
  if (checkIn < today) fail(422, 'STAY_CHECK_IN_PAST', 'Check-in cannot be before today where the home is', 'check_in_date', { today })
  const count_ = days(checkIn, checkOut)
  if (count_ < 1) fail(422, 'INVALID_DATE', 'check_out_date must be after check_in_date', 'check_out_date')
  if (count_ > MAX_STAY_NIGHTS) fail(422, 'STAY_TOO_LONG', `A stay is at most ${MAX_STAY_NIGHTS} nights`, 'check_out_date', { max_nights: MAX_STAY_NIGHTS })
  if (checkOut > addDays(today, STAY_CALENDAR_DAYS)) fail(422, 'STAY_TOO_FAR_AHEAD', `Stays can be booked up to ${STAY_CALENDAR_DAYS} days ahead`, 'check_out_date')
  const adults = count(input.adults, 'adults', 1)
  const children = count(input.children ?? 0, 'children', 0)
  const infants = count(input.infants ?? 0, 'infants', 0)
  if (adults + children > home.max_guests) fail(422, 'STAY_TOO_MANY_GUESTS', `This home sleeps at most ${home.max_guests} guests`, 'adults', { max_guests: home.max_guests })
  // The check-out day is read too: closed to departure is a rule of that day.
  const all = await homeNights(db, organizationId, home, checkIn, addDays(checkOut, 1))
  const stayed = all.slice(0, count_)
  const departure = all[count_]!
  const restriction = stayNightRestriction(stayed, departure)
  if (restriction) fail(restriction.statusCode, restriction.code, restriction.message, restriction.field, restriction.detail)
  if (home.base_price_tax_behavior === null) fail(409, 'STAY_BASE_PRICE_REQUIRED', 'This home has no base nightly price', 'base_price_minor')
  const nightly = stayed.map(night => ({ date: night.date, price_minor: night.price_minor! }))
  const total = nightly.reduce((sum, night) => sum + night.price_minor, 0)
  if (!Number.isSafeInteger(total) || total < 1) fail(409, 'STAY_TOTAL_INVALID', 'These nights have no amount to pay', 'check_in_date')
  const monthly = count_ >= LONG_TERM_STAY_NIGHTS
  // Airbnb's average monthly comparison is a 30-night equivalent, independent of payment timing.
  const denominator = BigInt(monthly ? count_ : 1)
  const numerator = BigInt(total) * (monthly ? 30n : 1n)
  const amount = Number((numerator + denominator / 2n) / denominator)
  const unit = 10 ** currencyFractionDigits(home.currency)
  const displayAmount = Number((BigInt(amount) + BigInt(unit) - 1n) / BigInt(unit) * BigInt(unit))
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(displayAmount)) fail(409, 'STAY_TOTAL_INVALID', 'These nights have no valid comparison amount', 'check_in_date')
  const cancellationPolicy = bookedPolicyFor(count_, home)
  if (!cancellationPolicy) fail(409, 'STAY_CANCELLATION_POLICY_REQUIRED', `This home has no cancellation policy for stays of ${count_ >= LONG_TERM_STAY_NIGHTS ? `${LONG_TERM_STAY_NIGHTS} nights or more` : `under ${LONG_TERM_STAY_NIGHTS} nights`}`, count_ >= LONG_TERM_STAY_NIGHTS ? 'long_term_cancellation_policy' : 'cancellation_policy')
  return {
    product_id: home.product_id, name: home.name, location_id: home.location_id, timezone: home.timezone, currency: home.currency, tax_behavior: home.base_price_tax_behavior,
    check_in_date: checkIn, check_out_date: checkOut, check_in_time: home.check_in_time, check_out_time: home.check_out_time,
    nights: count_, adults, children, infants, nightly, total_minor: total, cancellation_policy: cancellationPolicy,
    nightly_groups: stayNightlyGroups(nightly.map(night => night.price_minor)).map(group => ({ price_minor: group.price, nights: group.nights, total_minor: group.price * group.nights })),
    price_summary: { basis: monthly ? 'month' : 'stay', amount_minor: amount, display_amount_minor: displayAmount },
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
            AND NOT EXISTS (SELECT 1 FROM product_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? AND closed = 1)
            AND NOT EXISTS (SELECT 1 FROM bookings b JOIN stay_nights n ON n.organization_id = b.organization_id AND n.booking_id = b.id
              WHERE b.organization_id = ? AND b.booked_product_id = ? AND b.status <> 'cancelled' AND n.date >= ? AND n.date < ?)`,
    params: [input.organizationId, input.productId, input.organizationId, input.productId, input.checkIn, input.checkOut, input.organizationId, input.productId, input.checkIn, input.checkOut],
  }
}

/** Tell the home's channel about nights a checkout hold took or gave back, and the calendar that they changed. */
export async function pushStayHoldNights(db: DbClient, env: StayMutationEnv, organizationId: string, productId: string, checkIn: string, checkOut: string): Promise<SuccessfulChannelPush | null> {
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const home = await readStayHome(db, access, productId)
  const channelPush = await pushNights(db, env, access, productId, [[checkIn, checkOut]])
  const completed = await completeChannelPush(channelPush, { product_id: productId, ranges: [[checkIn, checkOut]] }, async () => {
    await publishStayInvalidation(env, { type: 'nights.changed', organization_id: organizationId, location_id: home.location_id, product_id: productId, booking_id: null }, { updated_at: new Date().toISOString() })
    return {}
  })
  return completed.channel_push
}

/**
 * Lapsed checkout holds still claiming nights: the nights are reopened on each
 * home's channel, then their claims are deleted. A night another write already
 * reclaimed was cleared by that write and is not here.
 */
export async function releaseLapsedStayHolds(db: DbClient, env: StayMutationEnv, paymentId?: string): Promise<{ released: number; channel_push: SuccessfulChannelPush[] }> {
  const lapsed = await queryAll<{ hold_id: string; organization_id: string; product_id: string; check_in: string; check_out: string }>(db, `
    SELECT stay_nights.hold_id, stay_nights.organization_id, stay_nights.product_id, MIN(stay_nights.date) AS check_in, date(MAX(stay_nights.date), '+1 day') AS check_out
      FROM stay_nights WHERE ${LAPSED_HOLD_CLAIM_SQL}
       AND (? IS NULL OR hold_id IN (SELECT id FROM payment_checkout_holds WHERE payment_id = ?))
     GROUP BY stay_nights.hold_id, stay_nights.organization_id, stay_nights.product_id LIMIT 100`, [paymentId ?? null, paymentId ?? null])
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
  /** `answers` are the home's questions as the guest answered them, frozen with the purchase. */
  guest: { name: string; email: string; phone: string | null; notes: string | null; answers?: FormAnswerSnapshot[] }
}

/** The home a captured checkout's stay is made at: its clock, its variant and its title. */
export type CheckoutHome = Pick<StayHome, 'name' | 'location_id' | 'timezone' | 'check_in_time' | 'check_out_time' | 'variant_id'>

/** The terms a guest paying for nights on the site agreed to: the home's guest terms, the whole amount paid online, and the cancellation policy they booked under. */
export async function stayCheckoutPolicy(db: DbClient, organizationId: string, quote: CheckoutStay['quote'] & { tax_behavior: PriceTaxBehavior }): Promise<string> {
  const config = await requireBookingConfig(db, organizationId, quote.product_id)
  return JSON.stringify({ ...bookingPolicy(config, null), payment: { basis: 'per_booking', unit_amount: quote.total_minor, currency: quote.currency, tax_behavior: quote.tax_behavior, min_party_size: null }, cancellation: quote.cancellation_policy } satisfies BookingPolicy)
}

/**
 * The batch that makes a captured stay hold a confirmed direct stay: the hold's
 * claims go, the booking takes the same nights (failing the batch on a night
 * someone else now holds), and its guest conversation opens.
 */
export function stayFromCheckoutQueries(input: { organizationId: string; stayId: string; holdId: string; paymentId: string; buyerUserId: string; now: string; stay: CheckoutStay; home: CheckoutHome; policy: string }): BatchQuery[] {
  const { quote, guest } = input.stay
  const window = stayWindow({ check_in_date: quote.check_in_date, check_out_date: quote.check_out_date, arrival_time: null }, input.home)
  const requestId = crypto.randomUUID()
  return [
    { query: 'DELETE FROM stay_nights WHERE hold_id = ?', params: [input.holdId] },
    {
      query: `INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants,
                status, answers, policy_json, total_minor, currency, idempotency_key, version, channel, owner, received_at, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, 1, 'direct', 'app', ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM payments WHERE id = ? AND organization_id = ? AND refunded_amount = 0)`,
      params: [input.stayId, input.organizationId, input.buyerUserId, quote.product_id, input.home.variant_id, input.home.location_id, window.starts_at, window.ends_at, input.home.timezone,
        quote.adults + quote.children, quote.adults, quote.children, quote.infants, JSON.stringify(guest.answers ?? []), input.policy, quote.total_minor, quote.currency, `checkout:${input.paymentId}`,
        input.now, input.now, input.now, input.paymentId, input.organizationId],
    },
    organizationEventQuery({ organizationId: input.organizationId, locationId: input.home.location_id, actorId: null, eventType: 'stay.created', entityType: 'stay', entityId: input.stayId, metadata: { channel: 'direct', payment_id: input.paymentId }, onlyIfPreviousChangedOneRow: true }),
    ...reconcileNightsQueries(input.organizationId, input.stayId, { updated_at: input.now, version: 1, product_id: quote.product_id, ...window, check_in_date: quote.check_in_date, check_out_date: quote.check_out_date }),
    ...bookingConversationQueries({ organizationId: input.organizationId, bookingId: input.stayId, requestId, locationId: input.home.location_id, userId: input.buyerUserId, now: input.now,
      guest: { name: guest.name, email: guest.email, phone: guest.phone } }),
    // The stay's own message opens its conversation, then the guest's note.
    ...openingMessageQueries({ conversationId: requestId, at: input.now, guestUserId: input.buyerUserId, openedByUserId: input.buyerUserId, note: guest.notes,
      body: openingSentence({ kind: 'stay', homeTitle: input.home.name, checkIn: quote.check_in_date, checkOut: quote.check_out_date, guests: quote.adults + quote.children,
        guestName: guest.name, guestPhone: guest.phone, answers: guest.answers ?? [] }) }),
  ]
}

/** After a stay is made from a checkout: its scheduled messages, its channel and the screens showing it. */
export async function completeStayFromCheckout(db: DbClient, env: StayMutationEnv, organizationId: string, stayId: string): Promise<{ stay: Stay; channel_push: SuccessfulChannelPush | null }> {
  const stay = await storedStay(db, organizationId, stayId)
  await planSourceMessages(db, organizationId, stayId)
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  const channelPush = await pushNights(db, env, access, stay.product_id, [[stay.check_in_date, stay.check_out_date]])
  return completeChannelPush(channelPush, { product_id: stay.product_id, booking_id: stayId, version: stay.version, ranges: [[stay.check_in_date, stay.check_out_date]] }, async () => {
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
  const wanted = rangeNights(blockedRanges(row), today, addDays(today, STAY_CALENDAR_DAYS))
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
  const nights = rangeNights(ranges, today, addDays(today, STAY_CALENDAR_DAYS))
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
    await publishStayInvalidation(env, { type: 'nights.changed', organization_id: row.organization_id, location_id: home.location_id, product_id: row.product_id, booking_id: null }, { updated_at: now })
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
    if (ranges.length) await publishStayInvalidation(env, { type: 'nights.changed', organization_id: access.organizationId, location_id: home.location_id, product_id: home.product_id, booking_id: null }, { updated_at: now })
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
  const nights = await homeNights(db, row.organization_id, home, today, addDays(today, STAY_CALENDAR_DAYS))
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

/** Channel reservation values by arrival date. A reservation amount is never a bank-transfer record. */
export async function channelReservationAmounts(db: DbClient, organizationId: string, from: string, until: string) {
  // The arrival day is read in each home's clock; SQL narrows by instants a day wider either side.
  const reservations = await queryAll<{ channel: string; currency: string; total_minor: number; starts_at: string; timezone: string }>(db,
    `SELECT channel, currency, total_minor, starts_at, timezone FROM bookings
      WHERE organization_id = ? AND owner = 'channel' AND status = 'confirmed' AND product_session_id IS NULL AND starts_at >= ? AND starts_at < ?`,
    [organizationId, addDays(from, -1), `${addDays(until, 1)}T14:00:00.000Z`])
  const totals = new Map<string, { channel: string; currency: string; amount: number; count: number }>()
  for (const reservation of reservations) {
    const arrival = bookingDay(reservation.starts_at, reservation.timezone)
    if (arrival < from || arrival >= until) continue
    const key = `${reservation.channel} ${reservation.currency}`
    const total = totals.get(key) ?? { channel: reservation.channel, currency: reservation.currency, amount: 0, count: 0 }
    totals.set(key, { ...total, amount: total.amount + reservation.total_minor, count: total.count + 1 })
  }
  const rows = [...totals.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.currency.localeCompare(b.currency))
  for (const row of rows) {
    if (!['airbnb', 'booking_com', 'vrbo'].includes(row.channel) || !isCurrencyCode(row.currency)
      || !Number.isSafeInteger(row.amount) || row.amount < 0 || !Number.isSafeInteger(row.count) || row.count < 1) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'A channel reservation summary is invalid',
        data: { code: 'CHANNEL_RESERVATION_AMOUNT_INVALID', field: `channelReservations.${row.channel}.${row.currency}` } })
    }
  }
  return rows
}
