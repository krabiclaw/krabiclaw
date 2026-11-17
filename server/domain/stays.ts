import { bookingReviewDueAt, historicalNoShowAtSql } from '~/server/utils/review-requests'
import { changedTaskIds, publishEvent, type DomainEvent, type EventsEnv } from '~/server/events'
import { PUBLIC_PROVIDER_JSON_SQL, PUBLISHED_PROFILE_SQL, RESERVATION_HOST_SQL, type PublicProvider } from '~/shared/member-scheduling'
import { bookChannelConversationGuest, reconcileGuestListingParticipants } from '~/server/domain/conversation-participants'
import { HTTPError } from 'nitro'
import { bookingStatusQuery } from '~/server/domain/bookings'
import { CURRENT_GUEST_SQL, messageQueries, readGuestConversation } from '~/server/domain/conversations'
import { readTurnoverHomes, TURNOVER_HOME_FROM, turnoverHomeColumns, turnoverTaskQueries, type TurnoverHome } from '~/server/domain/tasks'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { formAnswersFingerprint, formAnswerSnapshotsSchema, formQuestionsRevision, parseStoredFormQuestions, type FormAnswerSnapshot, type FormQuestion } from '~/shared/form-questions'
import { validateFormAnswers } from '~/server/domain/form-questions'
import { MAX_STAY_NIGHTS, NIGHT_PRICE_CHANGE_PERCENT, STAY_CALENDAR_DAYS, STAY_DIRECT_DISCOUNTS, stayChannelCalendarRules, changeNightPrice, parseStayCalendarRules, resolveStayNightPolicy, type StayCalendarRules, STAY_CHANNELS, STAY_CHANNEL_LABELS, isChannelManagedStay, STAY_PAYMENT_METHODS, stayGuestFirstName, type StayChannel, type StayPaymentMethod } from '~/shared/bookings'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertResponsibleMember, assertRoleAllows, assignedMemberSql, BATCH_VIEWER, bookingOperationsScope, withViewer, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { bookedRecordsInRange, businessWideViewer, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { organizationEventQuery, type OrganizationEvent } from '~/server/utils/organization-events'
import { createLocation, updateLocation, type UpdateLocationInput } from '~/server/utils/location-management'
import { liveHomeSql } from '~/server/utils/billing'
import { parsePostalAddress, type PostalAddress } from '~/utils/postal-address'
import { calculateMapUrl, coordinatesFailure } from '~/utils/location-map'
import { visitRefundPaymentQuery, visitRefundQueries } from '~/server/domain/payments/visit-refund'
import { bookedPolicyFor, LONG_TERM_STAY_NIGHTS, stayCancellationRefund, type StayBookedPolicy, type StayCancellationInput } from '~/shared/stay-cancellation'
import { executeRefund, requirePayment, type Payment } from '~/server/domain/payments'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import { isRecord } from '~/server/utils/type-guards'
import { isStayCheckInMethod, STAY_ARRIVAL_TEXT_LIMITS, STAY_CHECKOUT_DETAILS_LIMIT, type StayArrivalGuide } from '~/shared/stay-arrival'
import { stayNightlyGroups, AIRBNB_CANCELLATION_CATEGORIES, AIRBNB_LONG_TERM_CANCELLATION_IDS, isStayAmenity, parseStayAmenityAnswers, parseStayMapSharing, STAY_ALARM_DETAIL_KEYS, STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES, type StayAmenityAnswer, type StayMapSharing, STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS, type StayAmenity, type StayCancellationPolicy, type StayCheckInMethod, type StayCheckoutTask, type StayListingType, type StayLongTermCancellationPolicy, type StayPropertySizeUnit, type StayPropertyType, type StayPropertyTypeGroup } from '~/shared/stay-listing'
import { validateProductDetails, validateStayAlarmDetails, stayHouseRuleLines, type ProductDetails } from '~/shared/product-details'
import { staySafetyLines, stayAlarmLines } from '~/shared/stay-safety'
import { formatTime, isValidInstant, isValidTimezone, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { createProduct, getProduct, readStayCalendarRules, setProductPublication, stayImportWrittenQuery, stayWeekendPriceSql, updateProduct, type StayImportWrite } from '~/server/utils/product-management'
import type { Product, ProductStayConfig, UpdateProductInput } from '~/server/types/products'
import type { CloudflareEnv } from '~/server/utils/auth'
import { currencyFractionDigits, isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { selectPrice, type Price, type PriceTaxBehavior } from '~/shared/prices'
import type { ChannexEnv } from '~/server/integrations/channex/client'
import { completeChannelPush, configureStayCalendar, deliverStayNights, pendingChannelNightsQuery, pushAirbnbListingSettings, pushStayCalendar, pushStayNights, requireChannelPush, type AirbnbListingSettings, type ChannelPushCompletion, type ChannexMapping } from '~/server/integrations/channex/ari'
import type { ChannelPush, SuccessfulChannelPush } from '~/shared/channel-push'
import { bookingContactQuery, bookingConversationQueries, bookingDay, isBookingDay, nightsBoundary, noStayRequestPaymentInFlightSql, requestInsertQueries, stayRequestPayBySql, stayRequestProgress, stayRequestRespondBySql, threadPayloadForGuest, validateGuestRequest } from '~/server/domain/requests'
import { bookingPolicy, parseBookingPolicy, type BookingPolicy } from '~/server/utils/booking-policy-summary'
import { assertBookingBatchWrite, bookingBatchWriteRefused, requireBookingConfig } from '~/server/utils/availability'
import { GUEST_NOTE_EVENT, openingMessageQueries, openingSentence } from '~/server/domain/guest-threads/opening'
import { conversationTaskQueries } from '~/server/domain/guest-threads/repository'
import { ownedBuyerRequest } from '~/server/domain/payments/buyer'
import { publishBusinessInvalidation, publishConversationEvent, publishStayInvalidation, scheduleBusinessWake, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
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
type StayMutationEnv = ChannexEnv & GuestInboxPublicationEnv & EventsEnv

/** Resolve a member's stay access from their Better Auth role: operations update manages, operations assigned reads assigned homes. */
export async function stayAccessFor(principal: MemberAccessPrincipal): Promise<StayAccess> {
  const scope = await bookingOperationsScope(principal)
  if (scope === 'manage') return { organizationId: principal.organizationId, actorId: principal.userId, manage: true }
  if (scope === null) await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
  return { organizationId: principal.organizationId, actorId: principal.userId, manage: false, userId: principal.userId }
}

export const STAY_STATUSES = ['pending', 'confirmed', 'cancelled'] as const

/** A nights booking: a booking at a home, read with its check-in and checkout days in the home's clock. */
export interface Stay {
  id: string
  product_id: string
  /** The listing the channel reservation was booked on, when the guest sleeps elsewhere. */
  booked_product_id: string | null
  booked_home_name: string | null
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
  /** The reservation on its channel's host pages, from its confirmation code; null where the channel has none Blawby links to. */
  channel_booking_url: string | null
  /** The guest conversation in the inbox; every booking has one. */
  conversation_id: string
  cancelled_at: string | null
  cancellation_reason: string | null
  /** An earlier no-show, as recorded in its conversation. */
  no_show_at: string | null
  request_status: 'awaiting_approval' | 'awaiting_payment' | null
  respond_by: string | null
  pay_by: string | null
  /** The policy a guest booked under on the site; null for a stay not paid there. */
  cancellation_policy: StayBookedPolicy | null
  /** The guest's answers to the home's questions, worded as they answered them; empty when none were asked. */
  answers: FormAnswerSnapshot[]
  version: number
  created_at: string
  updated_at: string
}

/**
 * A stay as a member responsible for its home sees it: the Turnovers view.
 * Dates, arrival, the guest's first name and party. Owners and admins read the whole stay.
 */
export const STAY_TURNOVER_FIELDS = ['id', 'product_id', 'location_id', 'timezone', 'status', 'starts_at', 'ends_at', 'check_in_date', 'check_out_date', 'adults', 'children', 'infants', 'guest_name'] as const
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
  updated_at: string
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
  host_profile_published: boolean
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
   * Blawby: its night changes go nowhere else. A connected home pushes its
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
  /** What the connected channel last took for this night; null when the home has no channel or the night was never pushed. */
  channel: { state: 'pending' | 'pushed' | 'needs_review'; detail: string | null } | null
}

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

function isStayDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const instant = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value
}

function date(value: unknown, field: string): string {
  if (!isStayDate(value)) fail(422, 'INVALID_DATE', `${field} must be a YYYY-MM-DD date`, field)
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

function assertStayCheckoutHorizon(checkOut: string, today: string) {
  if (checkOut > addDays(today, STAY_CALENDAR_DAYS)) fail(422, 'STAY_TOO_FAR_AHEAD', `Stays can be booked up to ${STAY_CALENDAR_DAYS} days ahead`, 'check_out_date')
}

function range(input: { from: unknown; to: unknown }, max?: number): { from: string; to: string } {
  const from = date(input.from, 'from')
  const to = date(input.to, 'to')
  const span = days(from, to)
  if (span < 1) fail(422, 'INVALID_RANGE', 'to must be after from', 'to')
  if (max !== undefined && span > max) fail(422, 'INVALID_RANGE', `to must be at most ${max} days after from`, 'to')
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
const STAY_COLUMNS = `s.id, s.product_id, s.booked_product_id,
  (SELECT COALESCE(home.internal_name, p.name) FROM product_stay_configs home
    JOIN products p ON p.organization_id=home.organization_id AND p.id=home.product_id
    WHERE home.organization_id=s.organization_id AND home.product_id=s.booked_product_id) AS booked_home_name,
  s.location_id, s.timezone, s.channel, s.owner, s.status, s.overbooked, s.starts_at, s.ends_at,
  s.adults, s.children, s.infants, s.party_size, json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email, json_extract(r.payload_json, '$.guest.phone') AS guest_phone,
  s.user_id, s.total_minor, s.currency, s.private_notes, s.provider, s.external_booking_id, s.channel_booking_id, r.id AS conversation_id, s.cancelled_at, s.cancellation_reason,
  json_extract(s.policy_json, '$.cancellation') AS cancellation_policy, ${historicalNoShowAtSql('r')} AS no_show_at, s.answers, s.version, s.created_at, s.updated_at,
  ${stayRequestRespondBySql('s')} AS respond_by, ${stayRequestPayBySql('r.id')} AS pay_by`

function mapStay(row: Record<string, unknown>): Stay {
  const code = row.channel_booking_id
  const timezone = String(row.timezone)
  if (row.adults === null || row.children === null || row.infants === null || row.total_minor === null || row.currency === null) throw new Error(`Stay ${String(row.id)} has no party breakdown or total`)
  return { ...row, ...stayRequestProgress({ status: row.status as Stay['status'], respond_by: row.respond_by as string | null, pay_by: row.pay_by as string | null }),
    overbooked: Number(row.overbooked) === 1, answers: formAnswerSnapshotsSchema.parse(JSON.parse(String(row.answers))),
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

/** A channel's stay is changed on its channel: refused, linking to the reservation there when Blawby can. */
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
  const homes = await stayHomeRows(db, organizationId, productId, scope)
  const productIds = homes.map(home => home.product_id)
  if (!productIds.length) return []
  const [photos, photoRooms, accessibility] = await Promise.all([
    readProductPhotos(db, { organizationId, productIds }),
    readStayPhotoRooms(db, organizationId, productIds),
    readStayHomeAccessibility(db, organizationId, productIds),
  ])
  return homes.map(home => ({
    ...home,
    photos: (photos.get(home.product_id) ?? []).map(stayPhoto),
    photo_rooms: photoRooms.get(home.product_id) ?? [],
    accessibility: accessibility.get(home.product_id)!,
  }))
}

/** A home's settings and nightly offer, without its photos, rooms and accessibility: what its calendar reads. */
type StayHomeCore = Omit<StayHome, 'photos' | 'photo_rooms' | 'accessibility'>

/** The statements that read homes and their nightly prices, for a caller's batch; `organization` is SQL naming the organization. */
function stayHomeQueries(organization: BatchQuery, productId: string | null, scope: { sql: string; params: unknown[] }): [BatchQuery, BatchQuery] {
  return [{
    query: `
    SELECT p.id AS product_id, (SELECT json_group_array(v.id) FROM product_variants v WHERE v.organization_id = c.organization_id AND v.product_id = c.product_id) AS variant_ids, p.updated_at, p.name, c.internal_name, p.description, p.details_json, c.location_id, l.timezone, l.address, l.latitude, l.longitude, l.stay_map_sharing, o.default_currency,
           b.check_in_time, b.check_in_end_time, b.check_out_time, b.default_capacity AS max_guests, b.min_nights, b.calendar_rules, ${stayWeekendPriceSql('c')} AS weekend_price_minor, c.property_type_group, c.property_type,
           c.listing_type, c.total_floors, c.listing_floor, c.year_built, c.property_size, c.property_size_unit, c.bedrooms, c.beds, c.bathrooms, c.amenities,
           b.cancellation_policy, b.long_term_cancellation_policy, c.check_in_method, c.check_in_instructions, c.wifi_network, c.wifi_password,
           p.tax_code, b.advance_notice_minutes, b.party_size_min, b.party_size_max, b.minimum_guest_age, b.accessibility_contact_required,
           c.directions, c.house_manual, c.checkout_instructions, b.assigned_member_id, b.questions,
           EXISTS(SELECT 1 FROM member_scheduling ms WHERE ms.organization_id = c.organization_id
             AND ms.member_id = b.assigned_member_id AND ${PUBLISHED_PROFILE_SQL}) AS host_profile_published,
           COALESCE((SELECT pp.published FROM product_publications pp WHERE pp.organization_id = c.organization_id AND pp.product_id = c.product_id), 0) AS published,
           ${liveHomeSql('p')} AS live, m.enabled AS channel_enabled, m.import_stage AS channel_stage, m.listing_id AS airbnb_listing_id
      FROM product_stay_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      JOIN organization o ON o.id = c.organization_id
      LEFT JOIN product_channel_mappings m ON m.organization_id = c.organization_id AND m.product_id = c.product_id AND m.provider = 'channex'
     WHERE c.organization_id = ${organization.query} ${productId !== null ? 'AND c.product_id = ?' : ''} AND ${scope.sql}
     ORDER BY c.internal_name, p.id`,
    params: [...organization.params!, ...(productId !== null ? [productId] : []), ...scope.params],
  }, {
    query: `SELECT pr.*, v.product_id FROM prices pr
      JOIN product_variants v ON v.organization_id = pr.organization_id AND v.id = pr.product_variant_id
      JOIN product_stay_configs c ON c.organization_id = v.organization_id AND c.product_id = v.product_id
     WHERE pr.organization_id = ${organization.query} ${productId ? 'AND v.product_id = ?' : ''} AND v.active = 1 AND pr.stay_date IS NULL AND pr.weekend = 0
     ORDER BY v.sort_order, v.id`,
    params: [...organization.params!, ...(productId ? [productId] : [])],
  }]
}

async function stayHomeRows(db: DbClient, organizationId: string, productId: string | null, scope: { sql: string; params: string[] }): Promise<StayHomeCore[]> {
  const [rows, prices] = await executeBatch(db, stayHomeQueries({ query: '?', params: [organizationId] }, productId, scope), { operation: 'Read homes' })
  return stayHomesFrom(rows!.results as Array<Record<string, unknown>>, prices!.results as Array<Price & { product_id: string }>)
}

/** Homes from their rows and prices, each checked as it is read. */
function stayHomesFrom(rows: Array<Record<string, unknown>>, prices: Array<Price & { product_id: string }>): StayHomeCore[] {
  return rows.map((row) => {
    if (typeof row.internal_name !== 'string' || !row.internal_name.trim()) throw new Error(`Home ${row.product_id} has no internal name`)
    const variants = JSON.parse(String(row.variant_ids)) as string[]
    if (variants.length !== 1) throw new Error(`Home ${row.product_id} has ${variants.length} variants; a home has exactly one`)
    const amenityAnswers = parseStayAmenityAnswers(JSON.parse(String(row.amenities)))
    const details = validateProductDetails('stay', JSON.parse(String(row.details_json)))
    validateStayAlarmDetails(details, amenityAnswers)
    if (!isCurrencyCode(row.default_currency)) throw new Error(`The organization of home ${String(row.product_id)} has an unsupported default currency`)
    const own = prices.filter(price => price.product_id === row.product_id).map(price => ({ ...price, active: Number(price.active) === 1 }))
    const base = selectPrice(own, { currency: row.default_currency, location_id: String(row.location_id) })
    return {
      product_id: String(row.product_id), variant_id: variants[0]!, updated_at: String(row.updated_at), name: String(row.name), internal_name: String(row.internal_name), location_id: String(row.location_id), timezone: String(row.timezone),
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
      host_profile_published: Number(row.host_profile_published) === 1,
      assigned_member_id: row.assigned_member_id === null ? null : String(row.assigned_member_id),
      ...(() => { const questions = parseStoredFormQuestions(String(row.questions)); return { questions, questions_revision: formQuestionsRevision(questions) } })(),
      channel: row.channel_stage === null ? null : {
        provider: 'channex',
        status: Number(row.channel_enabled) === 1 ? 'connected' : row.channel_stage === 'reservations' || row.channel_stage === 'messages' || row.channel_stage === 'complete' ? 'disconnected' : 'importing',
      },
      airbnb_listing_id: row.airbnb_listing_id === null ? null : String(row.airbnb_listing_id),
      airbnb_editor_url: row.airbnb_listing_id === null ? null : airbnbEditorUrl(String(row.airbnb_listing_id), 'details'),
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
  listing?: Pick<ProductStayConfig, 'property_type_group' | 'property_type' | 'bedrooms' | 'beds' | 'bathrooms'> & Partial<Pick<ProductStayConfig, 'listing_type' | 'amenities'>>
  description?: string
  details?: Parameters<typeof createProduct>[1]['product']['details']
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
    ...homeAddress(body),
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

export function stayHomeSetupAddress(body: Record<string, unknown>) {
  return { ...homeAddress(body), timezone: homeDetails(body).timezone(true)! }
}

/** A home's address read from a request; each problem names its field under the prefix. */
function homeAddress(body: Record<string, unknown>, prefix = ''): Pick<NewStayHome, 'address' | 'city' | 'state' | 'country' | 'zip_code'> {
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
  const pushes = pricing || ('min_nights' in body && nights !== home.min_nights) || ('calendar_rules' in body && JSON.stringify(stayChannelCalendarRules(stay.calendar_rules)) !== JSON.stringify(stayChannelCalendarRules(home.calendar_rules)))
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
      ...('check_in_instructions' in arrival ? { event: { type: 'stay.guide_changed', organization_id: access.organizationId, product_id: productId } } : {}),
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
export async function createStayHome(env: Parameters<typeof createLocation>[0], db: DbClient, access: StayAccess, home: NewStayHome, idempotencyKey: string, existingLocationId?: string): Promise<StayHome> {
  requireManager(access)
  await assertResponsibleMember(db, access.organizationId, home)
  const locationId = existingLocationId ?? await createStayHomeLocation(env, db, access, home, idempotencyKey)
  const product = await createProduct(db, {
    organizationId: access.organizationId, actor: { actorId: access.actorId }, idempotencyKey, env,
    // On the site unpublished, like a product added in the editor, so it can carry photos and a page.
    publication: { published: false },
    product: {
      kind: 'stay', name: home.name, ...(home.details === undefined ? {} : { details: home.details }), ...(home.description === undefined ? {} : { description: home.description }),
      ...(home.base_price_minor === null ? {} : { variants: [{ name: home.name, prices: [{ unit_amount: home.base_price_minor, location_id: locationId }] }] }),
      stay: { ...home.listing, ...(home.internal_name === undefined ? {} : { internal_name: home.internal_name }), location_id: locationId, check_in_time: home.check_in_time, check_in_end_time: home.check_in_end_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, calendar_rules: home.calendar_rules, assigned_member_id: home.assigned_member_id,
        ...(home.cancellation_policy === undefined ? {} : { cancellation_policy: home.cancellation_policy }),
        ...(home.long_term_cancellation_policy === undefined ? {} : { long_term_cancellation_policy: home.long_term_cancellation_policy }) },
    },
  })
  return await readStayHome(db, access, product.id)
}

async function createStayHomeLocation(env: Parameters<typeof createLocation>[0], db: DbClient, access: StayAccess, home: NewStayHome, idempotencyKey: string) {
  const located = await createLocation(env, db as D1Database, access.organizationId, {
    title: home.name, timezone: home.timezone, phone: home.phone, email: home.email,
    address: postalAddress(home),
  }, access.actorId, { idempotencyKey })
  if (located.status !== 201) locationFailure(located)
  const location = 'location' in located.data ? located.data.location : undefined
  if (!location || typeof location.id !== 'string' || !location.id.trim()) fail(502, 'INVALID_LOCATION_RESPONSE', 'Location creation did not return the location id', 'data.location.id')
  return location.id
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
  const unknown = Object.keys(body).find(key => !['updated_at', 'accessibility'].includes(key))
  if (unknown) fail(422, 'INVALID_STAY_ACCESSIBILITY', `${unknown} cannot be changed here`, unknown)
  if (typeof body.updated_at !== 'string' || !Number.isFinite(Date.parse(body.updated_at))) fail(422, 'INVALID_STAY_ACCESSIBILITY', 'Provide the Product updated_at value from the latest read', 'updated_at')
  if (!isStayHomeAccessibility(body.accessibility)) fail(422, 'INVALID_STAY_ACCESSIBILITY', 'Choose a listing accessibility feature and true, false or null. A true answer needs unique photo IDs; false or null needs an empty photo list.', 'accessibility')
  if (body.updated_at !== home.updated_at) fail(409, 'STAY_ACCESSIBILITY_CHANGED', 'The listing changed while you were editing. Reload the accessibility information and try again.', 'updated_at')
  await updateProduct(db, {
    organizationId: access.organizationId, productId, patch: {}, actor: { actorId: access.actorId }, env,
    stayAccessibilityUpdate: { expectedUpdatedAt: body.updated_at, accessibility: body.accessibility },
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

function stayDetailQuery(access: StayAccess, stayId: string): BatchQuery {
  const scope = visibleHomes(access)
  const paymentColumns = access.manage ? `,
    (SELECT json_group_array(json_object('id', id, 'booking_id', booking_id, 'amount_minor', amount_minor, 'currency', currency,
      'method', method, 'paid_on', paid_on, 'reference', reference, 'note', note, 'created_at', created_at, 'created_by', created_by))
      FROM (SELECT * FROM offline_payments WHERE organization_id = s.organization_id AND booking_id = s.id ORDER BY paid_on, created_at)
    ) AS offline_payments_json,
    (SELECT json_group_array(json_object('payment_id', id, 'currency', currency, 'amount_minor', amount, 'captured_minor', captured_amount,
      'refunded_minor', refunded_amount, 'receipt_url', receipt_url, 'created_at', created_at))
      FROM payments WHERE organization_id = s.organization_id AND subject_type = 'booking' AND subject_id = s.id
    ) AS online_payments_json` : ''
  return {
    query: `SELECT ${STAY_COLUMNS}, (SELECT u.image FROM user u WHERE u.id = s.user_id) AS guest_image_url ${paymentColumns}
      FROM ${STAY_FROM}
     WHERE s.organization_id = ? AND s.id = ? AND s.product_session_id IS NULL AND ${scope.sql}`,
    params: [access.organizationId, stayId, ...scope.params],
  }
}

function stayDetailFrom<A extends StayAccess>(access: A, row: unknown): StayDetailView<A> {
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That stay is not in this organization')
  const { offline_payments_json: offline, online_payments_json: online, guest_image_url, ...record } = row as Record<string, unknown>
    & Pick<StayDetail, 'guest_image_url'> & { offline_payments_json?: string; online_payments_json?: string }
  const stay = mapStay(record)
  if (!access.manage) return stayTurnover(stay) as StayDetailView<A>
  if (offline === undefined || online === undefined) throw new Error('The stay detail query did not return its payment data')
  const payments = JSON.parse(offline) as StayPayment[]
  const onlinePayments = JSON.parse(online) as StayOnlinePayment[]
  if (onlinePayments.length > 1) fail(500, 'STAY_PAYMENT_AMBIGUOUS', 'This stay has more than one online payment', 'online_payment')
  const online_payment = onlinePayments[0] ?? null
  const paid = payments.reduce((sum, payment) => sum + payment.amount_minor, 0) + (online_payment ? online_payment.captured_minor - online_payment.refunded_minor : 0)
  const status = isChannelManagedStay(stay) ? null
    : paid === 0 ? 'unpaid' : paid < stay.total_minor ? 'partial' : paid === stay.total_minor ? 'paid' : 'overpaid'
  return { ...stay, guest_image_url, payments, online_payment, paid_minor: paid, payment_status: status } as StayDetailView<A>
}

export async function getStay<A extends StayAccess>(db: DbClient, access: A, stayId: string): Promise<StayDetailView<A>> {
  const { query, params } = stayDetailQuery(access, stayId)
  return stayDetailFrom(access, await queryFirst(db, query, params))
}

/** The price of an inventory date is the dated price of its home's variant. */
const STAY_NIGHT_PRICE_SQL = `(SELECT pr.unit_amount FROM product_variants v JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id
  WHERE v.organization_id = n.organization_id AND v.product_id = n.product_id AND pr.stay_date = n.date)`

/**
 * The homes calendar for a caller with a resolved stay access: one home's
 * nights, or every home's it may see, with the stays holding them, in the one
 * batch the host Calendar reads. A night's booking_id names its booking.
 */
export async function readStayCalendar(db: DbClient, access: StayAccess, input: { productId?: string; from: unknown; to: unknown }): Promise<{ from: string; to: string } & ReturnType<typeof stayCalendarOf>> {
  const { from, to } = range(input)
  const viewer: BatchQuery = { query: 'SELECT ? AS organization_id, ? AS user_id, NULL AS member_id, ? AS organization_wide', params: [access.organizationId, access.actorId, access.manage ? 1 : 0] }
  const calendar = stayCalendarOf(await executeBatch(db, stayCalendarQueries(viewer, { from, to, productId: input.productId ?? null }), { operation: 'Read homes calendar' }), access.manage, { from, to })
  if (input.productId && !calendar.homes.length) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  return { from, to, ...calendar }
}

/** One home's calendar from the homes calendar read: what get_stay_calendar and a nights write answer with. */
export async function readHomeCalendar(db: DbClient, access: StayAccess, input: { productId: string; from: unknown; to: unknown }): Promise<{ home: StayCalendarHome; nights: StayNight[]; stays: StayCalendarStay[] }> {
  const { homes: [entry], stays } = await readStayCalendar(db, access, input)
  return { home: entry!.home, nights: entry!.nights, stays }
}

/** What of a home the host calendar draws. */
export const STAY_CALENDAR_HOME_FIELDS = ['product_id', 'name', 'internal_name', 'timezone', 'currency', 'base_price_minor', 'min_nights', 'calendar_rules', 'address', 'cancellation_policy', 'long_term_cancellation_policy'] as const
export type StayCalendarHome = Pick<StayHome, typeof STAY_CALENDAR_HOME_FIELDS[number]>

/** A stay as the host calendar draws it; a member reads the guest's first name and no channel. */
export interface StayCalendarStay {
  unit: 'nights'
  booking_id: string
  conversation_id: string | null
  product_id: string
  status: 'pending' | 'confirmed' | 'cancelled'
  guest_name: string | null
  adults: number
  children: number
  check_in_date: string
  check_out_date: string
  channel?: StayChannel
}

/**
 * The host calendar's statements for the batch the membership (BATCH_VIEWER)
 * leads: the homes the viewer may see and their prices, the booked records,
 * and the nights of [from, to), each statement taking its homes from the same
 * visible-homes subquery.
 */
export function stayCalendarQueries(membership: BatchQuery, input: { from: string; to: string; productId: string | null }): BatchQuery[] {
  const organization: BatchQuery = { query: BATCH_VIEWER.organization, params: [] }
  const scope = { sql: `(${BATCH_VIEWER.organizationWide} = 1 OR EXISTS (SELECT 1 FROM product_booking_configs looked_after WHERE looked_after.organization_id = c.organization_id
    AND looked_after.product_id = c.product_id AND ${assignedMemberSql('looked_after', BATCH_VIEWER.user)}))`, params: [] }
  const homes: BatchQuery = { query: `SELECT c.product_id FROM product_stay_configs c WHERE c.organization_id = ${BATCH_VIEWER.organization}
    ${input.productId ? 'AND c.product_id = ?' : ''} AND ${scope.sql}`, params: input.productId ? [input.productId] : [] }
  // The calendar keeps the stays of the homes it shows, so it reads every booked record of the business.
  return [
    ...stayHomeQueries(organization, input.productId, scope).map(query => withViewer(membership, query)),
    withViewer(businessWideViewer(membership), bookedRecordsInRange(BATCH_VIEWER, input)),
    ...homeNightsQueries(organization, homes, input.from, input.to, true).map(query => withViewer(membership, query)),
  ]
}

/** The stays among booked records that `keep` keeps and that hold a night of [from, to), as the calendar and the bookings list show them, earliest check-in first. */
export function calendarStays(records: BookedRecordInRange[], manage: boolean, window: { from: string; to: string }, keep: (record: BookedRecordInRange) => boolean): Array<StayCalendarStay & { name: string }> {
  return records.flatMap((record) => {
    if (record.unit !== 'nights' || record.conversation_id === null || !keep(record)) return []
    if (record.adults === null || record.children === null) throw new Error(`Stay ${record.id} has no party breakdown`)
    const stay = { unit: 'nights' as const, booking_id: record.id, conversation_id: record.viewer_seated ? record.conversation_id : null, product_id: record.product_id, status: record.status,
      guest_name: manage ? record.guest_name : stayGuestFirstName(record.guest_name), adults: record.adults, children: record.children,
      check_in_date: bookingDay(record.starts_at, record.timezone), check_out_date: bookingDay(record.ends_at, record.timezone), ...(manage ? { channel: record.channel } : {}), name: record.product_name }
    return staysOverlap(stay, window.from, window.to) ? [stay] : []
  }).sort((a, b) => a.check_in_date.localeCompare(b.check_in_date) || a.booking_id.localeCompare(b.booking_id))
}

/** The host calendar from `stayCalendarQueries`' results. */
export function stayCalendarOf(results: Array<{ results: unknown[] }>, manage: boolean, window: { from: string; to: string }): { homes: Array<{ home: StayCalendarHome; nights: StayNight[] }>; stays: StayCalendarStay[] } {
  const [rows, prices, records, ...nightResults] = results
  const homes = stayHomesFrom(rows!.results as Array<Record<string, unknown>>, prices!.results as Array<Price & { product_id: string }>)
  const nights = homeNightsFrom(homes, nightResults, window.from, window.to) as StayNight[][]
  const shown = new Set(homes.map(home => home.product_id))
  const stays = calendarStays(records!.results as BookedRecordInRange[], manage, window, record => shown.has(record.product_id)).map(({ name: _name, ...stay }) => stay)
  return {
    homes: homes.map((home, index) => ({ home: Object.fromEntries(STAY_CALENDAR_HOME_FIELDS.map(field => [field, home[field]])) as StayCalendarHome, nights: nights[index]! })),
    stays,
  }
}

/** Every night of [from, to) at one home, read for whoever already has the home. */
async function homeNights(db: DbClient, organizationId: string, home: StayHomeCore, from: string, to: string): Promise<StayNight[]> {
  return (await homesNights(db, organizationId, [home], from, to))[0]!
}

/**
 * The statements that read the nights of [from, to) at the homes `products`
 * selects: overrides, booking claims, overbooked channel stays and, when asked,
 * what each channel last took. `organization` is SQL naming the organization.
 */
function homeNightsQueries(organization: BatchQuery, products: BatchQuery, from: string, to: string, channel: boolean, checkInventory = true): BatchQuery[] {
  const org = organization.query, ids = products.query
  const overrides = {
    query: `SELECT n.*, ${STAY_NIGHT_PRICE_SQL} AS price_minor FROM product_nights n WHERE n.organization_id = ${org} AND n.product_id IN (${ids}) AND n.date >= ? AND n.date < ?`,
    params: [...organization.params!, ...products.params!, from, to],
  }
  if (!checkInventory) return [overrides]
  const window = stayOverlapSql(from, to)
  return [overrides, {
    query: `SELECT product_id, date, booking_id FROM stay_nights
      WHERE organization_id = ${org} AND product_id IN (${ids}) AND date >= ? AND date < ? AND booking_id IS NOT NULL
      UNION ALL
      SELECT s.booked_product_id AS product_id, n.date, n.booking_id FROM bookings s
      JOIN stay_nights n ON n.organization_id = s.organization_id AND n.booking_id = s.id
      WHERE s.organization_id = ${org} AND s.booked_product_id IN (${ids}) AND s.status = 'confirmed'
        AND n.date >= ? AND n.date < ?
        AND NOT EXISTS (SELECT 1 FROM stay_nights own
          WHERE own.product_id = s.booked_product_id AND own.date = n.date AND own.booking_id IS NOT NULL)`,
    params: [...organization.params!, ...products.params!, from, to, ...organization.params!, ...products.params!, from, to],
  }, {
    query: `SELECT id, version, product_id, booked_product_id, starts_at, ends_at, timezone FROM bookings s
      WHERE organization_id = ${org} AND owner = 'channel' AND status = 'confirmed' AND overbooked = 1 AND ${window.sql}
        AND (product_id IN (${ids}) OR booked_product_id IN (${ids}))`,
    params: [...organization.params!, ...window.params, ...products.params!, ...products.params!],
  }, ...(channel ? [{
    query: `SELECT product_id, date, state, detail FROM channel_night_pushes WHERE organization_id = ${org} AND product_id IN (${ids}) AND date >= ? AND date < ?`,
    params: [...organization.params!, ...products.params!, from, to],
  }] : [])]
}

/** Every night of [from, to) at each of these homes, in their order, with what their channel last took. */
async function homesNights(db: DbClient, organizationId: string, homes: readonly StayHomeCore[], from: string, to: string): Promise<StayNight[][]> {
  return homeNightsFrom(homes, await executeBatch(db, homeNightsQueries({ query: '?', params: [organizationId] }, { query: 'SELECT value FROM json_each(?)', params: [d1JsonStringSet(homes.map(home => home.product_id))] }, from, to, true), { operation: 'Read home nights' }), from, to) as StayNight[][]
}

/** Every night of [from, to) at each of these homes, as a guest reads them: no channel state. */
async function homesOpenNights(db: DbClient, organizationId: string, homes: readonly StayHomeCore[], from: string, to: string): Promise<Array<Array<Omit<StayNight, 'channel'>>>> {
  return homeNightsFrom(homes, await executeBatch(db, homeNightsQueries({ query: '?', params: [organizationId] }, { query: 'SELECT value FROM json_each(?)', params: [d1JsonStringSet(homes.map(home => home.product_id))] }, from, to, false), { operation: 'Read home nights' }), from, to)
}

/** The nights of each home, from `homeNightsQueries`' results; with the channel statement, each night carries what its channel last took. */
function homeNightsFrom(homes: ReadonlyArray<Pick<StayHomeCore, 'product_id' | 'min_nights' | 'base_price_minor' | 'calendar_rules'>>, results: Array<{ results: unknown[] }>, from: string, to: string): Array<Array<Omit<StayNight, 'channel'> & Partial<Pick<StayNight, 'channel'>>>> {
  const [overrides, claims = [], overbooked = [], pushes] = results.map(result => result.results) as [
    Array<Record<string, unknown>>,
    Array<{ product_id: string; date: string; booking_id: string }>,
    Array<OverbookedStay & { product_id: string; booked_product_id: string | null }>,
    Array<{ product_id: string; date: string; state: 'pending' | 'pushed' | 'needs_review'; detail: string | null }> | undefined,
  ]
  const pushByNight = pushes && new Map(pushes.map(row => [`${row.product_id} ${row.date}`, { state: row.state, detail: row.detail }]))
  const overrideByNight = new Map(overrides.map(row => [`${String(row.product_id)} ${String(row.date)}`, row]))
  const bookingByNight = new Map(claims.map(row => [`${row.product_id} ${row.date}`, row.booking_id]))
  // The channel's confirmed booking still occupies its dates while the host resolves the overlap.
  for (const stay of overbooked) {
    const starts = bookingDay(stay.starts_at, stay.timezone)
    const ends = bookingDay(stay.ends_at, stay.timezone)
    for (const productId of [stay.product_id, stay.booked_product_id]) {
      if (productId === null) continue
      for (let day = starts < from ? from : starts; day < ends && day < to; day = addDays(day, 1)) {
        const key = `${productId} ${day}`
        if (!bookingByNight.has(key)) bookingByNight.set(key, stay.id)
      }
    }
  }
  return homes.map((home) => {
    const nights: Array<Omit<StayNight, 'channel'> & Partial<Pick<StayNight, 'channel'>>> = []
    for (let offset = 0; offset < days(from, to); offset++) {
      const night = addDays(from, offset)
      const key = `${home.product_id} ${night}`
      const row = overrideByNight.get(key)
      const stayId = bookingByNight.get(key) ?? null
      const closed = Number(row?.closed ?? 0) === 1
      nights.push({
        date: night, available: !closed && stayId === null, booking_id: stayId, closed,
        ...resolveStayNightPolicy(home, night, {
          price_minor: row?.price_minor == null ? null : Number(row.price_minor),
          min_stay_arrival: row?.min_stay_arrival == null ? null : Number(row.min_stay_arrival),
        }),
        max_stay: row?.max_stay == null ? null : Number(row.max_stay),
        closed_to_arrival: Number(row?.closed_to_arrival ?? 0) === 1,
        closed_to_departure: Number(row?.closed_to_departure ?? 0) === 1,
        source: row ? row.source as 'host' | 'import' : null,
        ...(pushByNight ? { channel: pushByNight.get(key) ?? null } : {}),
      })
    }
    return nights
  })
}

function nightDates(ranges: ReadonlyArray<readonly [string, string]>): string[] {
  return ranges.flatMap(([from, to]) => Array.from({ length: days(from, to) }, (_, offset) => addDays(from, offset)))
}

/**
 * Tell the home's channel, if it has one, the current state of these nights:
 * they join its delivery outbox and go now unless Channex's rate limit or a
 * retry wait holds them. The outcome is part of the write's result; a night
 * the channel did not take reads needs_review on the calendar.
 */
async function pushNights(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, ranges: ReadonlyArray<readonly [string, string]>): Promise<ChannelPushCompletion> {
  try {
    const [home] = await stayHomeRows(db, access.organizationId, productId, { sql: '1 = 1', params: [] })
    if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
    return await pushStayNights(db, env, access.organizationId, home, nightDates(ranges), (from, to) => homeNights(db, access.organizationId, home, from, to))
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
}

/**
 * The full sync of a home's calendar to the Channex property it is mapped to,
 * enabled or not: an import's inventory, or a home syncing again. Fails the
 * way a save's push fails; the caller decides what its import does with it.
 */
export async function syncStayCalendar(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, access: StayAccess, productId: string, mapping: ChannexMapping): Promise<ChannelPush> {
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
    detail: mismatches.length ? 'Some occupied or blocked nights are still available in Blawby or Airbnb.' : unverified.length ? `Airbnb read-back covers ${from} through ${addDays(to, -1)}. The other dates have not been verified.` : null,
  }
}

/**
 * Deliver pending nights and extend dated delivery as the booking window rolls.
 * Native rate-plan defaults cover weekday minimums and base prices.
 * Only a differing weekend price needs dated delivery as new dates open.
 */
export async function deliverPendingChannelNights(env: CloudflareEnv, organizationId: string, now: number): Promise<number | null> {
  const db = env.DB
  const homes = await queryAll<{ product_id: string; due: number }>(db, `SELECT m.product_id, due FROM (
      SELECT m.product_id, ${stayWeekendPriceSql('m')} AS weekend_price_minor,
        EXISTS (SELECT 1 FROM channel_night_pushes p WHERE p.organization_id = m.organization_id AND p.product_id = m.product_id
          AND p.provider = 'channex' AND p.state = 'pending') AS due
        FROM product_channel_mappings m WHERE m.organization_id = ? AND m.provider = 'channex' AND m.enabled = 1) m
     WHERE due = 1 OR m.weekend_price_minor IS NOT NULL`, [organizationId])
  let next = Infinity
  for (const row of homes) {
    const home = await readStayHome(db, { organizationId, actorId: 'system', manage: true }, row.product_id)
    const from = localDateAt(new Date(now), home.timezone)
    const to = addDays(from, STAY_CALENDAR_DAYS)
    const weekendPrice = home.calendar_rules?.weekend_price_minor
    const added: string[] = []
    if (weekendPrice !== undefined && weekendPrice !== home.base_price_minor) {
      const known = await queryAll<{ date: string }>(db, "SELECT date FROM channel_night_pushes WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND date >= ? AND date < ?", [organizationId, row.product_id, from, to])
      const queued = new Set(known.map(night => night.date))
      const hasWeekendPrice = (night: string) => resolveStayNightPolicy(home, night).price_minor !== home.base_price_minor
      for (let offset = 0; offset < STAY_CALENDAR_DAYS; offset++) {
        const night = addDays(from, offset)
        if (!queued.has(night) && hasWeekendPrice(night)) added.push(night)
      }
      // Once the horizon is full, only the next Friday/Saturday calls for a dated price.
      let entersIn = 1
      while (!hasWeekendPrice(addDays(to, entersIn - 1))) entersIn++
      next = Math.min(next, localDateTimeToInstant(addDays(from, entersIn), '00:00', home.timezone, 'compatible').getTime())
    }
    if (!added.length && !row.due) continue
    const read = (start: string, end: string) => homeNights(db, organizationId, home, start, end)
    if (added.length) await pushStayNights(db, env, organizationId, home, added, read)
    else {
      const retryAt = await deliverStayNights(db, env, organizationId, home, read)
      if (retryAt !== null) next = Math.min(next, retryAt)
    }
    await publishStayInvalidation(env, { type: 'nights.changed', organization_id: organizationId, location_id: home.location_id, product_id: home.product_id, booking_id: null }, { updated_at: new Date().toISOString() })
  }
  return Number.isFinite(next) ? next : null
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
      || (patch.stay?.calendar_rules !== undefined && JSON.stringify(stayChannelCalendarRules(patch.stay.calendar_rules)) !== JSON.stringify(stayChannelCalendarRules(previous.stay?.calendar_rules))),
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
export async function pushStayHomeChannel(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, access: StayAccess, product: Pick<Product, 'id' | 'updated_at'>, changes: { nights: boolean; settings: AirbnbSettingSections | null }): Promise<ChannelPushCompletion> {
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
    if (home.calendar_rules?.weekend_price_minor !== undefined) await scheduleBusinessWake(env, access.organizationId, 'channex_ari', Date.now())
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
  const claimsNights = `${committed} AND b.status <> 'cancelled' AND b.overbooked = 0)`
  return [assertBookingBatchWrite({
    // A moved channel guest still takes the original listing's nights. Keep
    // existing claims and refuse a new claim for any of the nights they hold.
    query: `NOT EXISTS (SELECT 1 FROM bookings moved
      JOIN stay_nights n ON n.organization_id = moved.organization_id AND n.booking_id = moved.id
      WHERE moved.organization_id = ? AND moved.booked_product_id = ? AND moved.id <> ?
        AND moved.status = 'confirmed' AND n.date >= ? AND n.date < ?
        AND ${claimsNights} AND NOT EXISTS (SELECT 1 FROM stay_nights own
          WHERE own.product_id = moved.booked_product_id AND own.date = n.date AND own.booking_id = ?))`,
    params: [organizationId, written.product_id, stayId, written.check_in_date, written.check_out_date, ...guard, stayId],
  }), {
    query: `DELETE FROM stay_nights WHERE organization_id = ? AND booking_id = ? AND ${committed}
              AND (b.status = 'cancelled' OR b.overbooked = 1 OR stay_nights.product_id <> ? OR stay_nights.date < ? OR stay_nights.date >= ?))`,
    params: [organizationId, stayId, ...guard, written.product_id, written.check_in_date, written.check_out_date],
  }, {
    // The old Worker may still have written an obsolete inventory claim before cutover.
    query: `DELETE FROM stay_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ?
      AND booking_id IS NULL AND ${claimsNights}`,
    params: [organizationId, written.product_id, written.check_in_date, written.check_out_date, ...guard],
  }, {
    query: `WITH RECURSIVE night(d) AS (SELECT ? UNION ALL SELECT date(d, '+1 day') FROM night WHERE date(d, '+1 day') < ?)
            INSERT INTO stay_nights (organization_id, product_id, date, booking_id)
            SELECT ?, ?, d, ? FROM night
             WHERE ${committed} AND b.product_id = ? AND b.status <> 'cancelled' AND b.overbooked = 0)
               AND NOT EXISTS (SELECT 1 FROM stay_nights own WHERE own.organization_id = ? AND own.booking_id = ? AND own.date = night.d)`,
    params: [written.check_in_date, written.check_out_date, organizationId, written.product_id, stayId, ...guard, written.product_id, organizationId, stayId],
  }]
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

function stayFields(input: Record<string, unknown>, home: Pick<StayHome, 'max_guests'>): StayFields {
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

/** The terms a nights booking is made under: the home's guest terms, its payment, and the home's cancellation policy for its length; a stay imported from another channel has that channel's, which Blawby does not hold. */
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

async function publishBookingNights(env: StayMutationEnv, organizationId: string, stay: StayDetail, taskIds: string[], quiet = false): Promise<StayDetail> {
  await publishStayChange(env, organizationId, stay, [[stay.check_in_date, stay.check_out_date]], true, taskIds, quiet)
  return stay
}

/** Retry the visibility/delivery of a committed migration using the stay as the host now has it, without restoring stale CSV fields. */
export async function resumeImportedStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string): Promise<StayDetail> {
  requireManager(access)
  const stay = await getStay(db, access, stayId)
  const receipt = await queryFirst(db, `SELECT id FROM activity_entries WHERE organization_id = ? AND event_name = 'stay.created'
    AND json_extract(payload_json, '$.entityId') = ? AND json_extract(payload_json, '$.metadata.imported.source') = 'hostaway'`, [access.organizationId, stayId])
  if (!receipt) fail(422, 'STAY_NOT_IMPORTED', 'This stay has no Hostaway import receipt', 'booking_id')
  return publishBookingNights(env, access.organizationId, stay, [], true)
}

type StayCreationHome = TurnoverHome & Pick<StayHome, 'max_guests' | 'cancellation_policy' | 'long_term_cancellation_policy'>
  & Omit<Parameters<typeof bookingPolicy>[0], 'accessibility_contact_required' | 'online_payment_required'>
  & {
    variant_ids: string
    currency: string
    questions: string
    accessibility_contact_required: number
    online_payment_required: number
    replay: number
  }

export async function createStay(db: DbClient, env: StayMutationEnv & CloudflareEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; idempotency_key: string }, options?: { imported: HostawayStaySource }): Promise<StayDetail> {
  requireManager(access)
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!key || key.length > 200) fail(422, 'INVALID_STAY_FIELD', 'idempotency_key must be 1 to 200 characters', 'idempotency_key')
  const imported = options?.imported
  if (imported && (imported.source !== 'hostaway' || !imported.source_id || key !== `hostaway:${imported.source_id}` || !imported.fingerprint)) fail(422, 'INVALID_STAY_FIELD', 'An imported stay needs its source reservation, fingerprint and matching idempotency key', 'imported')
  const channel = imported?.channel ?? 'direct'
  const channelBookingId = imported?.channel_booking_id ?? null
  if (!STAY_CHANNELS.includes(channel) || (channel !== 'direct' && !channelBookingId)) fail(422, 'INVALID_STAY_FIELD', 'An imported channel booking needs its actual channel confirmation reference', 'channel_booking_id')
  const publish = (stay: StayDetail, taskIds: string[] = []) => publishBookingNights(env, access.organizationId, stay, taskIds, imported !== undefined)
  const home = await queryFirst<StayCreationHome>(db, `
    SELECT ${turnoverHomeColumns('?')}, o.default_currency AS currency, b.default_capacity AS max_guests,
           b.cancellation_policy, b.long_term_cancellation_policy, b.questions, b.advance_notice_minutes,
           b.party_size_min, b.party_size_max, b.minimum_guest_age, b.accessibility_contact_required,
           b.online_payment_required, b.payment_basis, b.payment_min_party_size,
           (SELECT json_group_array(v.id) FROM product_variants v WHERE v.organization_id = c.organization_id AND v.product_id = c.product_id) AS variant_ids,
           EXISTS (SELECT 1 FROM bookings s WHERE s.organization_id = c.organization_id AND s.idempotency_key = ?) AS replay
      FROM ${TURNOVER_HOME_FROM}
      JOIN organization o ON o.id = c.organization_id
     WHERE c.organization_id = ? AND c.product_id = ?
  `, [typeof input.check_in_date === 'string' ? input.check_in_date : null, key, access.organizationId, input.product_id])
  if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  const variants = JSON.parse(home.variant_ids) as string[]
  if (variants.length !== 1) throw new Error(`Home ${home.product_id} has ${variants.length} variants; a home has exactly one`)
  if (!isCurrencyCode(home.currency)) throw new Error(`The organization of home ${home.product_id} has an unsupported default currency`)
  const fields = stayFields(input, home)
  const window = stayWindow(fields, home)
  // A payment the guest already made is written with the stay, so a stay never exists without it.
  const payment = input.payment === undefined || input.payment === null ? null : stayPaymentFields(input.payment, 'payment.', false)
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
  if (home.replay) {
    const earlier = await replay()
    if (earlier) return publish(earlier)
  }
  if (!imported) assertStayCheckoutHorizon(fields.check_out_date, homeToday(home.timezone))
  // A stay the host takes asks the home's questions as its direct booking does; the host's words are in the site's own language.
  const questions = parseStoredFormQuestions(home.questions)
  const answers = imported ? [] : validateFormAnswers({ questions, questions_revision: formQuestionsRevision(questions) }, {
    answers: input.answers, questionsRevision: input.questions_revision, revisionRequired: false })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const cancellation = imported ? null : bookedPolicyFor(days(fields.check_in_date, fields.check_out_date), home)
  const policy = { ...bookingPolicy({ ...home, accessibility_contact_required: home.accessibility_contact_required === 1,
    online_payment_required: home.online_payment_required === 1 }, null), cancellation } satisfies BookingPolicy
  const conversationId = crypto.randomUUID()
  const partySize = fields.adults + fields.children
  const turnovers = turnoverTaskQueries({ organizationId: access.organizationId, now, before: null, homes: [home],
    after: { id, product_id: home.product_id, status: 'confirmed', check_in_date: fields.check_in_date, check_out_date: fields.check_out_date } })
  let writes: Awaited<ReturnType<typeof executeBatch>>
  try {
    writes = await executeBatch(db, [
      {
        query: `INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants,
                  status, answers, private_notes, policy_json, total_minor, currency, idempotency_key, version, channel, owner, channel_booking_id, received_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, 1, ?, 'app', ?, ?, ?, ?)`,
        params: [id, access.organizationId, null, home.product_id, variants[0]!, home.location_id, window.starts_at, window.ends_at, home.timezone, partySize, fields.adults, fields.children, fields.infants,
          JSON.stringify(answers), fields.private_notes, JSON.stringify(policy), fields.total_minor, home.currency, key, channel, channelBookingId, imported ? null : now, now, now],
      },
      ...reconcileNightsQueries(access.organizationId, id, { updated_at: now, version: 1, product_id: home.product_id, ...window, check_in_date: fields.check_in_date, check_out_date: fields.check_out_date }),
      ...bookingConversationQueries({ organizationId: access.organizationId, bookingId: id, requestId: conversationId, locationId: home.location_id, userId: null, now,
        guest: { name: fields.guest_name, email: fields.guest_email, phone: fields.guest_phone } }),
      publicResourceCacheInvalidationQuery(access.organizationId, 'guest-thread-create'),
      organizationEventQuery({ organizationId: access.organizationId, locationId: home.location_id, actorId: access.actorId, eventType: 'stay.created', entityType: 'stay', entityId: id,
        context: access.audit, afterState: { ...fields, channel, channel_booking_id: channelBookingId }, ...(imported ? { metadata: { imported } } : {}) }),
      ...(payment ? stayPaymentInsert(access, { id, currency: home.currency, location_id: home.location_id }, payment, `${key}:payment`, now) : []),
      ...turnovers.queries,
      stayDetailQuery(access, id),
    ], { operation: 'Create stay' })
  } catch (error) {
    if (isStayNightConflict(error) || bookingBatchWriteRefused(error)) fail(409, 'STAY_OVERLAP', 'Another stay already holds one of these nights', 'check_in_date')
    if (/UNIQUE constraint failed: bookings\.organization_id, bookings\.idempotency_key/.test(error instanceof Error ? error.message : String(error))) {
      const concurrent = await replay()
      if (concurrent) return publish(concurrent)
    }
    throw error
  }
  return publish(stayDetailFrom(access, writes.at(-1)?.results[0]), changedTaskIds(writes))
}

export function assertStayRequestEditable(stay: Pick<Stay, 'status' | 'respond_by'>): void {
  if (stay.status === 'pending' && stay.respond_by) fail(409, 'STAY_REQUEST_PENDING', 'A stay request can be edited once the guest has paid.', 'booking_id')
}

function stayTurnoverHomeQuery(organizationId: string, stayId: string, checkIn: string | null): BatchQuery {
  // The current stay's UTC day may be a day after its local arrival day.
  const anchor = "MIN(COALESCE(date(?), date(s.starts_at)), date(s.starts_at, '-1 day'))"
  return {
    query: `SELECT ${turnoverHomeColumns(anchor)}, b.default_capacity AS max_guests FROM ${TURNOVER_HOME_FROM}
      JOIN bookings s ON s.organization_id = c.organization_id AND s.product_id = c.product_id
      WHERE s.organization_id = ? AND s.id = ? AND s.product_session_id IS NULL`,
    params: [checkIn, organizationId, stayId],
  }
}

/** The version-guarded update leads its batch; whether it applied is read from its result. */
function versionChanged(results: unknown): boolean {
  return (results as Array<{ meta?: { changes?: number } }>)[0]?.meta?.changes === 1
}

export async function updateStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: Record<string, unknown> & { version: unknown }): Promise<StayDetail> {
  requireManager(access)
  const [currentResult, homeResult] = await executeBatch(db, [
    stayDetailQuery(access, stayId),
    stayTurnoverHomeQuery(access.organizationId, stayId, typeof input.check_in_date === 'string' ? input.check_in_date : null),
  ], { operation: 'Read stay for edit' })
  const current = stayDetailFrom(access, currentResult?.results[0])
  if (isChannelManagedStay(current)) channelOwned(current, 'belongs to')
  if (current.status === 'cancelled') fail(409, 'STAY_NOT_EDITABLE', 'This stay is cancelled')
  assertStayRequestEditable(current)
  if (input.version !== current.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  const home = homeResult?.results[0] as (TurnoverHome & Pick<StayHome, 'max_guests'>) | undefined
  if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  const before: StayFields = { check_in_date: current.check_in_date, check_out_date: current.check_out_date, arrival_time: recordedArrival(current, home), adults: current.adults, children: current.children, infants: current.infants,
    guest_name: current.guest_name ?? '', guest_email: current.guest_email, guest_phone: current.guest_phone, total_minor: current.total_minor, private_notes: current.private_notes }
  const fields = stayFields({ ...before, ...input }, home)
  if (fields.check_in_date !== before.check_in_date || fields.check_out_date !== before.check_out_date) {
    assertStayCheckoutHorizon(fields.check_out_date, homeToday(home.timezone))
  }
  if (!Object.entries(fields).some(([field, value]) => value !== before[field as keyof StayFields])) fail(422, 'INVALID_STAY_FIELD', 'Provide at least one changed stay field', 'stay')
  const window = stayWindow(fields, home)
  const next = current.version + 1
  const now = new Date().toISOString()
  const nightsChanged = before.check_in_date !== fields.check_in_date || before.check_out_date !== fields.check_out_date
  const ranges = nightsChanged ? [[before.check_in_date, before.check_out_date], [fields.check_in_date, fields.check_out_date]] as const : []
  const today = localDateAt(new Date(now), home.timezone)
  const dates = [...new Set(nightDates(ranges).filter(day => day >= today))]
  const ari = dates.length ? [pendingChannelNightsQuery(access.organizationId, current.product_id, dates, now, {
    query: `EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND version = ? AND updated_at = ?)
      AND EXISTS (SELECT 1 FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND enabled = 1)`,
    params: [access.organizationId, stayId, next, now, access.organizationId, current.product_id],
  })] : []
  const turnovers = turnoverTaskQueries({ organizationId: access.organizationId, now, before: current, homes: [home],
    after: { id: stayId, product_id: current.product_id, status: current.status, check_in_date: fields.check_in_date, check_out_date: fields.check_out_date } })
  let results: Awaited<ReturnType<typeof executeBatch>>
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
      ...reconcileNightsQueries(access.organizationId, stayId, { updated_at: now, version: next, product_id: current.product_id, ...window, check_in_date: fields.check_in_date, check_out_date: fields.check_out_date }),
      ...turnovers.queries,
      ...ari,
      stayDetailQuery(access, stayId),
    ], { operation: 'Update stay' })
  } catch (error) {
    if (isStayNightConflict(error) || bookingBatchWriteRefused(error)) fail(409, 'STAY_OVERLAP', 'Another stay already holds one of these nights', 'check_in_date')
    throw error
  }
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  const stay = stayDetailFrom(access, results.at(-1)?.results[0])
  try {
    await publishStayChange(env, access.organizationId, stay, ranges, nightsChanged, changedTaskIds(results))
  } catch (publicationError) {
    if (ari.length && results.at(-2)?.meta.changes) {
      try {
        await scheduleBusinessWake(env, access.organizationId, 'channex_ari', Date.now())
      } catch (wakeError) {
        throw new AggregateError([publicationError, wakeError], 'The stay was saved but its event and channel wake both failed', { cause: wakeError })
      }
    }
    throw publicationError
  }
  return stay
}

function stayCancellationQueries(organizationId: string, stay: Stay, now: string, input: {
  reason: string | null; guard: BatchQuery; homes: TurnoverHome[]
  actorId?: string; metadata?: unknown
}) {
  const after = { ...stay, status: 'cancelled' as const }
  const { queries, keys } = turnoverTaskQueries({ organizationId, before: stay, after, now, homes: input.homes })
  return {
    queries: [
      bookingStatusQuery({ organizationId, bookingId: stay.id, status: 'cancelled', reason: input.reason, now, guard: input.guard }),
      organizationEventQuery({ organizationId, locationId: stay.location_id, actorId: input.actorId, eventType: 'stay.cancelled',
        entityType: 'stay', entityId: stay.id, metadata: input.metadata, onlyIfPreviousChangedOneRow: true }),
      ...stayNightReleaseQueries(stay, organizationId, now),
      ...queries,
    ], keys,
  }
}

function turnoverTaskIdsQuery(organizationId: string, keys: string[]): BatchQuery {
  return {
    query: 'SELECT id AS changed_task_id FROM tasks WHERE organization_id=? AND dedupe_key IN (SELECT value FROM json_each(?))',
    params: [organizationId, d1JsonStringSet(keys)],
  }
}

/**
 * The host cancels a stay. One the guest paid for on the site returns the whole
 * payment, as Airbnb's host cancellation does: the refund is queued in the same
 * batch, only under the host's approved financial authorization, and sent by
 * the caller that holds it (server/api/dashboard/payments/refund.post.ts).
 * Without one the cancellation is refused with where to approve it.
 */
export async function cancelStay(db: DbClient, env: StayMutationEnv, access: StayAccess, stayId: string, input: { version: unknown; reason?: unknown; authorization_id?: string; financial_writes_allowed?: boolean; actorRole: string }): Promise<StayDetail> {
  requireManager(access)
  const [currentResult, paymentResult, homeResult] = await executeBatch(db, [
    stayDetailQuery(access, stayId),
    visitRefundPaymentQuery(access.organizationId, stayId),
    stayTurnoverHomeQuery(access.organizationId, stayId, null),
  ], { operation: 'Read stay for cancellation' })
  const current = stayDetailFrom(access, currentResult?.results[0])
  if (isChannelManagedStay(current)) channelOwned(current, 'belongs to')
  if (input.version !== current.version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  const reason = optionalText(input.reason, 'reason', 500)
  // A current-version replay publishes the saved cancellation without another mutation or refund intent.
  if (current.status === 'cancelled') return publishBookingNights(env, access.organizationId, current, [])
  const home = homeResult?.results[0] as TurnoverHome | undefined
  if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  const next = current.version + 1
  const now = new Date().toISOString()
  const refund = await visitRefundQueries(db, {
    action: 'cancel', organizationId: access.organizationId, actorUserId: access.actorId, bookingId: stayId,
    authorizationId: input.authorization_id, financialWritesAllowed: input.financial_writes_allowed, note: reason ?? undefined, now,
    payment: (paymentResult?.results[0] as Payment | undefined) ?? null, actorRole: () => Promise.resolve(input.actorRole),
    committed: { query: "EXISTS(SELECT 1 FROM bookings WHERE organization_id=? AND id=? AND status='cancelled' AND version=?)", params: [access.organizationId, stayId, next] },
  })
  const cancellation = stayCancellationQueries(access.organizationId, current, now, {
    reason, actorId: access.actorId, homes: [home],
    guard: { query: `version = ? AND owner = 'app' AND status <> 'cancelled' AND product_session_id IS NULL AND (${refund.guard?.query ?? '1 = 1'})`,
      params: [current.version, ...(refund.guard?.params ?? [])] },
  })
  const results = await executeBatch(db, [
    ...cancellation.queries,
    ...refund.queries,
    stayDetailQuery(access, stayId),
  ], { operation: 'Cancel stay' })
  if (!versionChanged(results)) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
  return publishBookingNights(env, access.organizationId, stayDetailFrom(access, results.at(-1)?.results[0]), changedTaskIds(results))
}

/** Stripe proved this checkout's debit failed. Release the stay without a guest or member acting on it. */
export async function cancelFailedCheckoutStay(db: DbClient, env: StayMutationEnv, input: {
  organizationId: string; bookingId: string; reason: string; now: string; guard: BatchQuery; revokeReview: BatchQuery
}): Promise<void> {
  const { organizationId, bookingId, reason, now } = input
  const stay = await storedStay(db, organizationId, bookingId)
  if (stay.status !== 'confirmed' && (stay.status !== 'cancelled' || stay.cancellation_reason !== reason)) return
  const cancellation = stayCancellationQueries(organizationId, stay, now, {
    reason, homes: await readTurnoverHomes(db, { organizationId, before: stay, after: stay }),
    guard: { query: `status = 'confirmed' AND product_session_id IS NULL AND version = ? AND (${input.guard.query})`,
      params: [stay.version, ...(input.guard.params ?? [])] },
  })
  const taskIdsQuery = turnoverTaskIdsQuery(organizationId, cancellation.keys)
  let taskIds: string[]
  if (stay.status === 'confirmed') {
    const writes = await executeBatch(db, [...cancellation.queries, input.revokeReview, taskIdsQuery], { operation: 'Cancel stay after failed payment' })
    if (!versionChanged(writes)) throw new Error(`Stay ${bookingId} changed before payment failure cancellation`)
    taskIds = changedTaskIds(writes)
  } else {
    const rows = await queryAll<{ changed_task_id: string }>(db, taskIdsQuery.query, taskIdsQuery.params)
    taskIds = rows.map(row => row.changed_task_id)
  }
  const saved = stay.status === 'cancelled' ? stay : await storedStay(db, organizationId, bookingId)
  await publishStayChange(env, organizationId, saved, [[saved.check_in_date, saved.check_out_date]], true, taskIds)
}

/** What cancelling a stay returns to its guest now, by the policy they booked under, out of what they paid. */
export interface StayCancellationQuote { policy: StayBookedPolicy; paid_minor: number; refund_minor: number; currency: string }

/** The guest's own direct stay, with the payment its cancellation may refund. */
async function ownedPaidStay(db: DbClient, organizationId: string, stayId: string, buyerUserId: string) {
  const stay = await ownedDirectStay(db, organizationId, stayId, buyerUserId)
  const payment = await queryFirst<Payment>(db, "SELECT * FROM payments WHERE organization_id = ? AND subject_type = 'booking' AND subject_id = ? AND captured_amount > 0", [organizationId, stayId])
  if (!payment) fail(409, 'STAY_NOT_PAID_ONLINE', 'This stay was not paid on the site. Contact the host to cancel it.', 'booking_id')
  return { stay, payment }
}

async function ownedDirectStay(db: DbClient, organizationId: string, stayId: string, buyerUserId: string): Promise<Stay> {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT ${STAY_COLUMNS} FROM ${STAY_FROM}
     WHERE s.organization_id=? AND s.id=? AND s.user_id=? AND r.user_id=s.user_id AND ${CURRENT_GUEST_SQL('r')}
       AND s.owner='app' AND s.channel='direct' AND s.product_session_id IS NULL`, [organizationId, stayId, buyerUserId])
  if (!row) fail(404, 'STAY_NOT_FOUND', 'That stay is not yours to cancel', 'booking_id')
  return mapStay(row)
}

async function guestStayCancellationQuote(db: DbClient, stay: Stay, payment: Payment, now: string): Promise<StayCancellationQuote> {
  if (!stay.cancellation_policy) throw new Error(`Stay ${stay.id} was paid on the site without a cancellation policy`)
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  const purchase = isRecord(snapshot) ? snapshot.stay : undefined
  if (!isRecord(purchase) || !Array.isArray(purchase.nightly)) throw new Error(`Stay ${stay.id} payment has no nightly prices`)
  const home = await queryFirst<{ check_in_time: string | null }>(db, 'SELECT check_in_time FROM product_booking_configs WHERE organization_id = ? AND product_id = ?', [payment.organization_id, stay.product_id])
  if (!home) throw new Error(`Stay ${stay.id} has no home`)
  if (home.check_in_time === null) fail(409, 'STAY_CANCELLATION_TIME_REQUIRED', 'The home has no check-in time for calculating the cancellation refund. Contact the host to cancel.', 'check_in_time')
  const held = payment.captured_amount - payment.refunded_amount
  const owed = stayCancellationRefund({ policy: stay.cancellation_policy, nightly: purchase.nightly as StayCancellationInput['nightly'], booked_at: stay.created_at, now, timezone: stay.timezone, check_in_time: home.check_in_time })
  return { policy: stay.cancellation_policy, paid_minor: payment.captured_amount, refund_minor: Math.min(owed, held), currency: payment.currency }
}

export interface StayReservationHome {
  name: string
  internal_name: string
  organization_name: string
  check_in_time: string | null
  check_in_end_time: string | null
  check_out_time: string | null
  photo_urls: string[]
  listing: { slug: string; subdomain: string; canonical_domain: string | null } | null
  contact_phone: string | null
  location: { address: PostalAddress | null; latitude: number | null; longitude: number | null; maps_url: string | null } | null
  arrival_guide: StayArrivalGuide | null
  house_rules: string[]
  safety: string[]
  host: PublicProvider | null
  co_hosts: PublicProvider[]
}

/** The same home and host the reservation shows in both inboxes. */
export async function readStayReservationHome(db: DbClient, input: {
  organizationId: string
  productId: string
  showLocation: boolean
  showArrival: boolean
}): Promise<StayReservationHome> {
  const { organizationId, productId, showLocation, showArrival } = input
  const [house, photos] = await Promise.all([
    queryFirst<Pick<StayHome, 'name' | 'internal_name' | 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'check_in_method' | 'check_in_instructions' | 'wifi_network' | 'wifi_password' | 'directions' | 'house_manual'>
      & { organization_name: string; listing_slug: string | null; subdomain: string | null; canonical_domain: string | null; contact_phone: string | null; checkout_instructions: string; amenities: string; details_json: string; address: string | null; latitude: number | null; longitude: number | null; maps_url: string | null; host_json: string | null; co_hosts_json: string }>(db, `SELECT p.name, c.internal_name, o.name AS organization_name, b.check_in_time, b.check_in_end_time, b.check_out_time,
      c.check_in_method, c.check_in_instructions, c.wifi_network, c.wifi_password, c.directions, c.house_manual, c.checkout_instructions, c.amenities, p.details_json,
      CASE WHEN ${PUBLIC_STAY_SQL} THEN p.slug END AS listing_slug, o.subdomain,
      (SELECT domain FROM organization_domains WHERE organization_id = o.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS canonical_domain,
      CASE WHEN l.status = 'active' THEN l.phone END AS contact_phone,
      l.address, l.latitude, l.longitude, l.maps_url,
      ${RESERVATION_HOST_SQL} AS host_json,
      (SELECT json_group_array(json(profile)) FROM (
        SELECT ${PUBLIC_PROVIDER_JSON_SQL} AS profile
        FROM listing_message_members grant
        JOIN member_scheduling ms ON ms.organization_id = grant.organization_id AND ms.member_id = grant.member_id
        WHERE grant.organization_id = c.organization_id AND grant.listing_id = c.product_id
          AND grant.member_id IS NOT b.assigned_member_id AND ${PUBLISHED_PROFILE_SQL}
        ORDER BY lower(ms.public_name), ms.member_id
      )) AS co_hosts_json
      FROM product_stay_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      JOIN organization o ON o.id = c.organization_id
      JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      LEFT JOIN member m ON m.organizationId = b.organization_id AND m.id = b.assigned_member_id
      LEFT JOIN user u ON u.id = m.userId
      LEFT JOIN member_scheduling ms ON ms.organization_id = b.organization_id AND ms.member_id = b.assigned_member_id
      WHERE c.organization_id = ? AND c.product_id = ?`, [organizationId, productId]),
    readProductPhotos(db, { organizationId, productIds: [productId] }),
  ])
  if (!house) throw new Error(`The reservation has no home (${productId})`)
  const details = JSON.parse(house.details_json) as ProductDetails
  const address = showLocation ? parsePostalAddress(house.address) : null
  const pinFailure = showLocation ? coordinatesFailure(house) : null
  if (pinFailure) fail(500, 'INVALID_STORED_LOCATION', pinFailure.error, pinFailure.field)
  return {
    name: house.name, internal_name: house.internal_name, organization_name: house.organization_name,
    check_in_time: house.check_in_time, check_in_end_time: house.check_in_end_time, check_out_time: house.check_out_time,
    photo_urls: (photos.get(productId) ?? []).map(mediaStillUrl).filter((url): url is string => url !== null),
    listing: house.listing_slug && house.subdomain ? { slug: house.listing_slug, subdomain: house.subdomain, canonical_domain: house.canonical_domain } : null,
    contact_phone: showLocation ? house.contact_phone : null,
    location: showLocation ? { address, latitude: house.latitude, longitude: house.longitude,
      maps_url: calculateMapUrl({ title: '', address, latitude: house.latitude, longitude: house.longitude, maps_url: house.maps_url }) } : null,
    arrival_guide: showArrival ? { product_id: productId, check_in_method: house.check_in_method, check_in_instructions: house.check_in_instructions,
      wifi_network: house.wifi_network, wifi_password: house.wifi_password, directions: house.directions, house_manual: house.house_manual,
      checkout_instructions: JSON.parse(house.checkout_instructions) as StayCheckoutInstruction[] } : null,
    house_rules: showLocation ? stayHouseRuleLines(details, value => formatTime(value, 'en')) : [],
    safety: showLocation ? [...staySafetyLines(details), ...stayAlarmLines(parseStayAmenityAnswers(JSON.parse(house.amenities)), details, { includeUnknown: true })] : [],
    host: house.host_json === null ? null : JSON.parse(house.host_json) as PublicProvider,
    co_hosts: JSON.parse(house.co_hosts_json) as PublicProvider[],
  }
}

/** A guest's own stay as their account reads it: the stay, its home and host, and what cancelling returns now. */
export interface GuestStay {
  /** The business the stay is with: a business's site shows only its own. */
  organization_id: string
  stay: StayDetail
  home: Omit<StayReservationHome, 'internal_name'>
  /** Null once the stay is cancelled, or for a stay not paid on the site. */
  cancellation: StayCancellationQuote | null
  payment_processing: boolean
}

/** The account's stay by its activity ID: its conversation's ID, or the stay's own when it has none. */
export async function readGuestStay(db: DbClient, buyerUserId: string, activityId: string): Promise<GuestStay> {
  const now = new Date()
  const owned = await queryFirst<{ id: string; conversation_id: string; organization_id: string; product_id: string; paid_online: number; payment_processing: number }>(db, `
    SELECT s.id, r.id AS conversation_id, s.organization_id, s.product_id,
           EXISTS (SELECT 1 FROM payments WHERE organization_id = s.organization_id AND subject_type = 'booking' AND subject_id = s.id AND captured_amount > 0) AS paid_online,
           CASE WHEN s.status='pending' AND ${stayRequestRespondBySql('s')} IS NOT NULL THEN NOT (${noStayRequestPaymentInFlightSql('r.id')}) ELSE 0 END AS payment_processing
      FROM conversations r JOIN bookings s ON s.id = r.booking_id AND s.organization_id = r.organization_id
     WHERE r.id = ? AND r.kind = 'booking' AND s.user_id = ? AND s.owner = 'app' AND s.product_session_id IS NULL`, [now.toISOString(), activityId, buyerUserId])
  if (!owned) fail(404, 'STAY_NOT_FOUND', 'That stay is not in your account', 'booking_id')
  await ownedBuyerRequest(db, buyerUserId, owned.conversation_id)
  const stay = await getStay(db, { organizationId: owned.organization_id, actorId: buyerUserId, manage: true }, owned.id)
  if (stay.user_id !== buyerUserId || isChannelManagedStay(stay)) fail(404, 'STAY_NOT_FOUND', 'That stay is not in your account', 'booking_id')
  const confirmed = stay.status === 'confirmed'
  const showArrival = confirmed && (isBookingDay(stay.ends_at)
    ? localDateAt(now, stay.timezone) <= stay.check_out_date : now.getTime() < Date.parse(stay.ends_at))
  const { internal_name: _internalName, ...home } = await readStayReservationHome(db, {
    organizationId: owned.organization_id, productId: owned.product_id, showLocation: confirmed, showArrival,
  })
  const paidStay = stay.status !== 'cancelled' && owned.paid_online === 1 && home.check_in_time !== null
    ? await ownedPaidStay(db, owned.organization_id, owned.id, buyerUserId) : null
  const cancellation = paidStay ? await guestStayCancellationQuote(db, paidStay.stay, paidStay.payment, now.toISOString()) : null
  return { organization_id: owned.organization_id, stay, home, cancellation, payment_processing: owned.payment_processing === 1 }
}

/**
 * The guest cancels their own stay. The policy they booked under decides the
 * refund, which is queued in the same batch as the cancellation and sent to
 * Stripe after it; a retry of a cancelled stay sends a refund that did not go.
 */
export async function cancelStayAsGuest(db: DbClient, env: StayMutationEnv & CloudflareEnv, organizationId: string, stayId: string, buyerUserId: string, now = new Date().toISOString(), version?: number): Promise<{ stay: Stay; refund_minor: number }> {
  const owned = await ownedDirectStay(db, organizationId, stayId, buyerUserId)
  if (owned.respond_by && (owned.status === 'pending' || owned.cancellation_reason === 'guest_withdrew')) {
    if (owned.status === 'pending' && version !== undefined && version !== owned.version) {
      fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it. Reload and try again.', 'version')
    }
    const withdrawn = owned.status === 'pending' ? await cancelUnpaidStayRequest(db, env, organizationId, owned, now, buyerUserId)
      : await publishStayRequest(db, env, organizationId, owned.id)
    if (!withdrawn) fail(409, 'STAY_REQUEST_NOT_CANCELLABLE', 'This stay changed or its payment is processing.', 'booking_id')
    return { stay: withdrawn, refund_minor: 0 }
  }
  const { stay: initial, payment } = await ownedPaidStay(db, organizationId, stayId, buyerUserId)
  let stay = initial
  let taskIds: string[] = []
  const key = `guest-cancelled-stay:${stayId}`
  if (stay.status !== 'cancelled') {
    if (version !== undefined && stay.version !== version) fail(409, 'STAY_VERSION_CONFLICT', 'This stay changed since you opened it; reload it and try again', 'version')
    const quote = await guestStayCancellationQuote(db, stay, payment, now)
    const next = stay.version + 1
    // Stripe's full-remaining refund when the policy returns everything still held.
    const amount = quote.refund_minor === payment.captured_amount - payment.refunded_amount ? null : quote.refund_minor
    const cancellation = stayCancellationQueries(organizationId, stay, now, {
      reason: 'guest_cancelled', actorId: buyerUserId, metadata: { by: 'guest', refund_minor: quote.refund_minor },
      homes: await readTurnoverHomes(db, { organizationId, before: stay, after: stay }),
      guard: { query: `version = ? AND user_id = ? AND owner = 'app' AND channel = 'direct' AND status <> 'cancelled' AND product_session_id IS NULL
          AND EXISTS (SELECT 1 FROM conversations r WHERE r.id=? AND r.booking_id=bookings.id AND r.organization_id=bookings.organization_id AND r.user_id=? AND ${CURRENT_GUEST_SQL('r')})
          AND NOT EXISTS (SELECT 1 FROM payment_refunds WHERE payment_id = ? AND status IN ('queued','creating','pending','requires_action'))`,
        params: [stay.version, buyerUserId, stay.conversation_id, buyerUserId, payment.id] },
    })
    const results = await executeBatch(db, [
      ...cancellation.queries,
      ...(quote.refund_minor > 0 ? [{
        query: `INSERT INTO payment_refunds (id, payment_id, idempotency_key, amount, reason, status, created_by, created_at, updated_at)
                SELECT ?, ?, ?, ?, 'requested_by_customer', 'queued', ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND status = 'cancelled' AND version = ?)
                ON CONFLICT(idempotency_key) DO NOTHING`,
        params: [crypto.randomUUID(), payment.id, key, amount, buyerUserId, now, now, organizationId, stayId, next],
      }] : []),
    ], { operation: 'Guest cancels stay' })
    taskIds = changedTaskIds(results)
    if (!versionChanged(results)) {
      const latest = await ownedPaidStay(db, organizationId, stayId, buyerUserId)
      if (latest.stay.status !== 'cancelled' || latest.payment.id !== payment.id) fail(409, 'STAY_NOT_CANCELLABLE', 'This stay changed or a refund is already on its way. Reload it and try again.', 'booking_id')
      stay = latest.stay
    }
  }
  if (stay.status === 'cancelled' && stay.cancellation_reason !== 'guest_cancelled') {
    fail(409, 'STAY_ALREADY_CANCELLED', 'This stay was already cancelled', 'booking_id')
  }
  const saved = stay.status === 'cancelled' ? stay : await storedStay(db, organizationId, stayId)
  const refund = await queryFirst<{ amount: number | null }>(db, 'SELECT amount FROM payment_refunds WHERE payment_id = ? AND idempotency_key = ?', [payment.id, key])
  let refundMinor = 0
  if (refund) {
    const refunded = await requirePayment(db, organizationId, payment.id)
    const completed = await executeRefund(db, paymentsStripe(env, Boolean(refunded.livemode)), refunded, refund.amount, key, 'requested_by_customer', buyerUserId, env)
    const receipt = await queryFirst<{ amount: number; status: string; stripe_refund_id: string }>(db, 'SELECT amount, status, stripe_refund_id FROM payment_refunds WHERE payment_id = ? AND idempotency_key = ?', [payment.id, key])
    if (!receipt || !Number.isSafeInteger(receipt.amount) || receipt.amount < 0 || receipt.status !== completed.status || receipt.stripe_refund_id !== completed.stripe_refund_id) throw new Error('The cancelled stay refund could not be verified')
    refundMinor = receipt.amount
  }
  await publishStayChange(env, organizationId, saved, [[saved.check_in_date, saved.check_out_date]], true, taskIds, false, refundMinor)
  return { stay: saved, refund_minor: refundMinor }
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
  if (stay.request_status) fail(409, 'STAY_REQUEST_PENDING', 'The guest pays for this stay online after approval.', 'booking_id')
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

export async function setStayNights(db: DbClient, env: StayMutationEnv, access: StayAccess, input: Record<string, unknown> & { product_id: string; from: unknown; to: unknown }): Promise<{ home: StayCalendarHome; nights: StayNight[]; stays: StayCalendarStay[]; channel_push: SuccessfulChannelPush | null }> {
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
  const listingGuard = { query: "SELECT CASE WHEN EXISTS (SELECT 1 FROM products WHERE organization_id = ? AND id = ? AND updated_at = ?) THEN NULL ELSE json('Stay listing changed') END", params: [access.organizationId, home.product_id, home.updated_at] }
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
    if ((await readStayHome(db, access, home.product_id)).updated_at !== home.updated_at) {
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
    // The home's calendar as the host Calendar reads it, after the write.
    return readHomeCalendar(db, access, { productId: home.product_id, from, to })
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
  // An ordinary revision keeps a moved guest where they sleep. A revision for a different listing re-maps the stay.
  const landing = existing?.booked_product_id === productId ? existing.product_id : productId
  const bookedProductId = landing === productId ? null : productId
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
  const publish = async (stored: Stay, currentRevisionId: string | null, taskIds: string[]) => {
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
    const priorHomes: Array<{ product_id: string; location_id: string }> = []
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
        priorHomes.push({ product_id: product, location_id: location })
      }
    } else if (currentRevisionId === booking.revision_id) {
      throw new HTTPError({ statusCode: 503, message: 'The saved channel revision has no audit identifying its affected homes', data: { code: 'CHANNEL_REVISION_AUDIT_REQUIRED', field: 'revision_id', committed: true, revision_id: booking.revision_id, booking_id: stored.id, product_id: stored.product_id, version: stored.version } })
    }
    await publishStayChange(env, organizationId, stored, [], true, taskIds, booking.imported === true, undefined, priorHomes)
  }
  if (existing && existing.provider_updated_at !== null && existing.provider_updated_at >= booking.provider_updated_at) {
    const stored = await storedStay(db, organizationId, existing.id)
    await publish(stored, existing.revision_id, [])
    return { ...await storedStay(db, organizationId, existing.id), applied: false, change: existing.revision_id === booking.revision_id ? await recordedChange() : null }
  }
  const id = existing?.id ?? crypto.randomUUID()
  const previous = existing ? await storedStay(db, organizationId, existing.id) : null
  const [home] = await stayHomesWhere(db, organizationId, landing, { sql: '1 = 1', params: [] })
  if (!home) fail(404, 'STAY_HOME_NOT_FOUND', 'The channel booking home was not found', 'product_id')
  const guestName = [booking.guest_name, booking.guest_surname].map(part => part?.trim()).filter(Boolean).join(' ') || null
  // A reservation naming no one uses the channel's reservation title.
  const reservation = `${STAY_CHANNEL_LABELS[booking.channel]} reservation ${booking.channel_booking_id ?? booking.external_booking_id}`
  const guestUserId = existing?.user_id ?? null
  const window = stayWindow({ check_in_date: booking.check_in_date, check_out_date: booking.check_out_date, arrival_time: null }, home)
  const policy = await stayPolicy(db, organizationId, landing, null, null)
  const version = previous ? previous.version + 1 : 1
  const now = new Date().toISOString()
  const change = { organizationId, before: previous,
    after: { id, product_id: landing, status: booking.cancelled ? 'cancelled' as const : 'confirmed' as const, check_in_date: booking.check_in_date, check_out_date: booking.check_out_date } }
  const turnovers = turnoverTaskQueries({ ...change, now, homes: await readTurnoverHomes(db, change) })
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
      booking.provider_updated_at, booking.cancelled ? now : null, booking.imported || booking.cancelled ? null : now, now, now, bookedProductId, existing?.id ?? null, previous?.product_id ?? null, previous?.version ?? null],
  },
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
  bookChannelConversationGuest(organizationId, id, version),
  ...bookingConversationQueries({ organizationId, bookingId: id, requestId: crypto.randomUUID(), locationId: home.location_id, userId: guestUserId, now,
    guest: { name: guestName, email: booking.guest_email, phone: booking.guest_phone }, ...(guestName === null ? { participant: { kind: 'channel' as const, title: reservation } } : {}) }),
  publicResourceCacheInvalidationQuery(organizationId, 'guest-thread-create'),
  bookingContactQuery({ organizationId, bookingId: id, version, updatedAt: now, locationId: home.location_id, guest: { name: guestName, email: booking.guest_email, phone: booking.guest_phone } }),
  ...reconcileGuestListingParticipants(organizationId, { query: 'c.booking_id = ?', params: [id] }),
  ...turnovers.queries,
  ]
  let writes: Awaited<ReturnType<typeof executeBatch>>
  try {
    writes = await executeBatch(db, write(0), { operation: 'Apply channel booking' })
  } catch (error) {
    if (!isStayNightConflict(error) && !bookingBatchWriteRefused(error)) throw error
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
  await publish(stored, current.revision_id, changedTaskIds(writes))
  return { ...await storedStay(db, organizationId, stored.id), applied: changed === 1, change: changed === 1 ? await recordedChange() : null }
}

async function publishStayChange(
  env: EventsEnv,
  organizationId: string,
  stay: Stay,
  ranges: ReadonlyArray<readonly [string, string]>,
  nightsChanged: boolean,
  taskIds: string[],
  quiet = false,
  guestCancellationRefund?: number,
  priorHomes?: ReadonlyArray<{ product_id: string; location_id: string }>,
): Promise<void> {
  await publishEvent(env, {
    type: 'stay.changed', organization_id: organizationId, booking_id: stay.id, product_id: stay.product_id,
    location_id: stay.location_id, conversation_id: stay.conversation_id, version: stay.version,
    nights_changed: nightsChanged, push_ranges: ranges, quiet, task_ids: taskIds,
    ...(priorHomes?.length ? { prior_homes: priorHomes } : {}),
    ...(stay.status === 'confirmed' && stay.channel === 'direct' ? { review_due_at: bookingReviewDueAt(stay.ends_at) } : {}),
    ...(stay.status === 'pending' && stay.respond_by ? { checkout_expires_at: stay.pay_by ?? stay.respond_by } : {}),
    ...(guestCancellationRefund === undefined ? {} : { guest_cancellation_refund_minor: guestCancellationRefund }),
  })
}

/** Respond to the committed stay using the current booking and inventory. */
export async function reactToStayChange(env: CloudflareEnv, event: Extract<DomainEvent, { type: 'stay.changed' }>): Promise<void> {
  const db = env.DB
  const { organization_id, location_id, product_id, booking_id, conversation_id, version, push_ranges } = event
  if (event.checkout_saved) {
    await completeStayFromCheckout(db, env, organization_id, booking_id)
  } else {
    await planSourceMessages(db, organization_id, booking_id)
  }
  const outcome = push_ranges.length
    ? await pushNights(db, env, { organizationId: organization_id, actorId: 'system', manage: true }, product_id, push_ranges)
    : null
  await completeChannelPush(outcome, { product_id, booking_id, version, ranges: push_ranges }, async () => {
    for (const home of event.prior_homes ?? []) {
      const affected = { organization_id, booking_id, ...home }
      await publishStayInvalidation(env, { ...affected, type: 'stay.changed' }, { version })
      await publishStayInvalidation(env, { ...affected, type: 'nights.changed' }, { version })
    }
    const input = { organization_id, location_id, product_id, booking_id }
    await publishStayInvalidation(env, { ...input, type: 'stay.changed' }, { version })
    if (event.nights_changed) await publishStayInvalidation(env, { ...input, type: 'nights.changed' }, { version })
    await publishConversationEvent(env, db, { conversationId: conversation_id, type: 'MESSAGE_UPDATE' })
    if (event.guest_cancellation_refund_minor !== undefined) {
      const { notifyStayCancelled } = await import('~/server/utils/notifications')
      await notifyStayCancelled(env, db, organization_id, booking_id, 'guest', event.guest_cancellation_refund_minor)
    }
    return {}
  })
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
 * full. At Pay, the booking claims its nights in the batch that saves it.
 */

/** A home a guest can book on the site: active, published on the site and at its active location. */
export async function readPublicStayHome(db: DbClient, organizationId: string, productId: string) {
  const [rows, prices] = await executeBatch(db, publicStayHomeQueries(organizationId, productId), { operation: 'Read public stay terms' })
  return publicStayHomeFrom(rows!, prices!)
}

export function publicStayHomeQueries(organizationId: string, productId: string) {
  return stayHomeQueries({ query: '?', params: [organizationId] }, productId, { sql: PUBLIC_STAY_SQL, params: [] })
}

export function publicStayHomeFrom(rows: D1Result, prices: D1Result) {
  const data = rows.results as Array<Record<string, unknown>>
  const [home] = stayHomesFrom(data, prices.results as Array<Price & { product_id: string }>)
  if (!home) fail(404, 'STAY_NOT_FOUND', 'That place to stay is not open for booking', 'slug')
  const row = data[0]!
  const guestTerms = bookingPolicy({
    advance_notice_minutes: nullableNumber(row.advance_notice_minutes),
    party_size_min: nullableNumber(row.party_size_min),
    party_size_max: nullableNumber(row.party_size_max),
    minimum_guest_age: nullableNumber(row.minimum_guest_age),
    accessibility_contact_required: Number(row.accessibility_contact_required) === 1,
  }, null)
  return { ...home, tax_code: nullableText(row.tax_code), guestTerms }
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

function publicNight(night: Omit<StayNight, 'channel'>, today: string, lastDeparture: string): PublicStayNight {
  return {
    date: night.date,
    available: night.available && night.price_minor !== null && night.date >= today && night.date < lastDeparture,
    price_minor: night.price_minor,
    min_stay_arrival: night.min_stay_arrival,
    max_stay: night.max_stay,
    closed_to_arrival: night.closed_to_arrival,
    closed_to_departure: night.closed_to_departure,
  }
}

/** The bookable nights of [from, to), plus `to` so the guest can select that departure. No claims are shown. */
export async function readPublicStayCalendar(db: DbClient, organizationId: string, productId: string, input: { from: unknown; to: unknown }): Promise<PublicStayCalendar> {
  const home = await readPublicStayHome(db, organizationId, productId)
  const { from, to } = range(input)
  const today = homeToday(home.timezone)
  const lastDeparture = addDays(today, STAY_CALENDAR_DAYS)
  const start = from < today ? today : from
  const departure = to > lastDeparture ? lastDeparture : to
  const nights = start > departure ? [] : (await homesOpenNights(db, organizationId, [home], start, addDays(departure, 1)))[0]!
  return {
    home: { currency: home.currency, timezone: home.timezone, today, check_in_time: home.check_in_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, calendar_rules: home.calendar_rules, base_price_minor: home.base_price_minor },
    nights: nights.map(night => publicNight(night, today, lastDeparture)),
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
function stayNightRestriction(stayed: readonly Omit<StayNight, 'channel'>[], departure: Omit<StayNight, 'channel'>, checkInventory: boolean): { statusCode: number; code: string; message: string; field: string; detail?: Record<string, unknown> } | null {
  const arrival = stayed[0]
  if (!arrival) throw new Error('A stay interval requires at least one night')
  if (checkInventory) {
    const taken = stayed.filter(night => !night.available).map(night => night.date)
    if (taken.length) return { statusCode: 409, code: 'STAY_NIGHTS_UNAVAILABLE', message: 'Some of these nights are no longer available', field: 'check_in_date', detail: { dates: taken } }
  }
  const unpriced = stayed.find(night => night.price_minor === null)
  if (unpriced) return { statusCode: 409, code: 'STAY_NIGHT_UNPRICED', message: `${unpriced.date} has no nightly price yet`, field: 'check_in_date', detail: { date: unpriced.date } }
  if (arrival.closed_to_arrival) return { statusCode: 422, code: 'STAY_CLOSED_TO_ARRIVAL', message: `Guests cannot check in on ${arrival.date}`, field: 'check_in_date' }
  if (departure.closed_to_departure) return { statusCode: 422, code: 'STAY_CLOSED_TO_DEPARTURE', message: `Guests cannot check out on ${departure.date}`, field: 'check_out_date' }
  if (stayed.length < arrival.min_stay_arrival) return { statusCode: 422, code: 'STAY_MIN_NIGHTS', message: `Stays arriving on ${arrival.date} are at least ${arrival.min_stay_arrival} nights`, field: 'check_out_date', detail: { min_nights: arrival.min_stay_arrival } }
  if (arrival.max_stay !== null && stayed.length > arrival.max_stay) return { statusCode: 422, code: 'STAY_MAX_NIGHTS', message: `Stays arriving on ${arrival.date} are at most ${arrival.max_stay} nights`, field: 'check_out_date', detail: { max_nights: arrival.max_stay } }
  return null
}

export async function quoteStay(db: DbClient, organizationId: string, home: StayHomeCore, input: StayQuoteInput): Promise<StayQuote> {
  const queries = stayQuoteNightQueries(organizationId, home.product_id, input)
  const nights = queries.length ? await executeBatch(db, queries, { operation: 'Read quote nights' }) : []
  const { quote } = quoteStayAvailability(organizationId, home, input, nights)
  return quote
}

/** Dates must bound the calendar read even before the home clock can validate them. */
export function stayQuoteNightQueries(organizationId: string, productId: string, input: Pick<StayQuoteInput, 'check_in_date' | 'check_out_date'>, { checkInventory = true } = {}): BatchQuery[] {
  const { check_in_date: from, check_out_date: until } = input
  if (!isStayDate(from) || !isStayDate(until) || from >= until || days(from, until) > MAX_STAY_NIGHTS) return []
  return homeNightsQueries({ query: '?', params: [organizationId] }, { query: '?', params: [productId] }, from, addDays(until, 1), false, checkInventory)
}

export function quoteStayAvailability(organizationId: string, home: StayHomeCore, input: StayQuoteInput, nights: D1Result[], { checkInventory = true } = {}) {
  const checkIn = date(input.check_in_date, 'check_in_date')
  const checkOut = date(input.check_out_date, 'check_out_date')
  const today = homeToday(home.timezone)
  if (checkIn < today) fail(422, 'STAY_CHECK_IN_PAST', 'Check-in cannot be before today where the home is', 'check_in_date', { today })
  const count_ = days(checkIn, checkOut)
  if (count_ < 1) fail(422, 'INVALID_DATE', 'check_out_date must be after check_in_date', 'check_out_date')
  if (count_ > MAX_STAY_NIGHTS) fail(422, 'STAY_TOO_LONG', `A stay is at most ${MAX_STAY_NIGHTS} nights`, 'check_out_date', { max_nights: MAX_STAY_NIGHTS })
  assertStayCheckoutHorizon(checkOut, today)
  const adults = count(input.adults, 'adults', 1)
  const children = count(input.children ?? 0, 'children', 0)
  const infants = count(input.infants ?? 0, 'infants', 0)
  if (adults + children > home.max_guests) fail(422, 'STAY_TOO_MANY_GUESTS', `This home sleeps at most ${home.max_guests} guests`, 'adults', { max_guests: home.max_guests })
  // The check-out day is read too: closed to departure is a rule of that day.
  const to = addDays(checkOut, 1)
  const [all] = homeNightsFrom([home], nights, checkIn, to)
  const stayed = all!.slice(0, count_)
  const departure = all![count_]!
  const restriction = stayNightRestriction(stayed, departure, checkInventory)
  if (restriction) fail(restriction.statusCode, restriction.code, restriction.message, restriction.field, restriction.detail)
  if (home.base_price_tax_behavior === null) fail(409, 'STAY_BASE_PRICE_REQUIRED', 'This home has no base nightly price', 'base_price_minor')
  const discounts = home.calendar_rules?.direct_discounts
  const leadDays = days(today, checkIn)
  const discount = Math.max(0, ...Object.entries(STAY_DIRECT_DISCOUNTS).map(([key, rule]) =>
    rule.eligible(count_, leadDays) ? discounts?.[key as keyof typeof STAY_DIRECT_DISCOUNTS] ?? 0 : 0))
  const nightly = stayed.map(night => ({ date: night.date, price_minor: discount ? changeNightPrice(night.price_minor!, -discount) : night.price_minor! }))
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
  const quote: StayQuote = {
    product_id: home.product_id, name: home.name, location_id: home.location_id, timezone: home.timezone, currency: home.currency, tax_behavior: home.base_price_tax_behavior,
    check_in_date: checkIn, check_out_date: checkOut, check_in_time: home.check_in_time, check_out_time: home.check_out_time,
    nights: count_, adults, children, infants, nightly, total_minor: total, cancellation_policy: cancellationPolicy,
    nightly_groups: stayNightlyGroups(nightly.map(night => night.price_minor)).map(group => ({ price_minor: group.price, nights: group.nights, total_minor: group.price * group.nights })),
    price_summary: { basis: monthly ? 'month' : 'stay', amount_minor: amount, display_amount_minor: displayAmount },
  }
  const channelAvailability = checkInventory
    ? observedStayChannelAvailability({ organizationId, productId: home.product_id, checkIn, checkOut }, nights[2]!.results as OverbookedStay[])
    : null
  return { quote, channelAvailability }
}

/** The home must still be bookable and its nights open when the booking is saved. */
export async function stayHoldPredicate(db: DbClient, input: StayAvailability, observed?: BatchQuery) {
  const channel = observed ?? await stayChannelAvailability(db, input)
  return {
    query: `EXISTS (SELECT 1 FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
              WHERE p.organization_id = ? AND p.id = ? AND ${PUBLIC_STAY_SQL})
            AND NOT EXISTS (SELECT 1 FROM product_nights WHERE organization_id = ? AND product_id = ? AND date >= ? AND date < ? AND closed = 1)
            AND ${channel.query}`,
    params: [input.organizationId, input.productId, input.organizationId, input.productId, input.checkIn, input.checkOut, ...(channel.params ?? [])],
  }
}

/** The checkout's frozen quote and guest details. */
export interface CheckoutStay {
  quote: Pick<StayQuote, 'product_id' | 'check_in_date' | 'check_out_date' | 'adults' | 'children' | 'infants' | 'total_minor' | 'currency' | 'cancellation_policy'>
  /** `answers` are the home's questions as the guest answered them, frozen with the purchase. */
  guest: { name: string; email: string; phone: string | null; notes: string | null; answers?: FormAnswerSnapshot[] }
}

/** The checkout home's clock, variant and title. */
export type CheckoutHome = Pick<StayHome, 'name' | 'location_id' | 'timezone' | 'check_in_time' | 'check_out_time' | 'variant_id'>

/** The terms a guest paying for nights on the site agreed to: the home's guest terms, the whole amount paid online, and the cancellation policy they booked under. */
export function stayCheckoutPolicy(guestTerms: BookingPolicy, quote: CheckoutStay['quote'] & { tax_behavior: PriceTaxBehavior }): BookingPolicy {
  return { ...guestTerms, payment: { basis: 'per_booking', unit_amount: quote.total_minor, currency: quote.currency, tax_behavior: quote.tax_behavior, min_party_size: null }, cancellation: quote.cancellation_policy }
}

/** Both parties have up to one day, ending before the stay's check-in. */
export function stayRequestDeadline(now: string, startsAt: string, timezone: string): string {
  const arrival = isBookingDay(startsAt) ? localDateTimeToInstant(startsAt, '00:00', timezone, 'earlier').toISOString() : startsAt
  return new Date(Math.min(Date.parse(now) + 86_400_000, Date.parse(arrival))).toISOString()
}

type StayAvailability = { organizationId: string; productId: string; checkIn: string; checkOut: string }
type OverbookedStay = { id: string; version: number; starts_at: string; ends_at: string; timezone: string }
const OVERBOOKED_HOME_SQL = "s.organization_id=? AND s.owner='channel' AND s.status='confirmed' AND (? IN (s.product_id, s.booked_product_id)) AND s.overbooked=1"

/** Channel stays normally have local-date claims. An overbooking has no claims, so read its dates in its own saved timezone and guard the observation in the write. */
export async function stayChannelAvailability(db: DbClient, input: StayAvailability) {
  const { organizationId, productId, checkIn, checkOut } = input
  const window = stayOverlapSql(checkIn, checkOut)
  const candidates = await queryAll<OverbookedStay>(db, `
    SELECT s.id, s.version, s.starts_at, s.ends_at, s.timezone FROM bookings s
    WHERE ${OVERBOOKED_HOME_SQL} AND ${window.sql}`, [organizationId, productId, ...window.params])
  return observedStayChannelAvailability(input, candidates)
}

function observedStayChannelAvailability({ organizationId, productId, checkIn, checkOut }: StayAvailability, candidates: OverbookedStay[]): BatchQuery & { params: unknown[] } {
  const window = stayOverlapSql(checkIn, checkOut)
  if (candidates.some(stay => bookingDay(stay.starts_at, stay.timezone) < checkOut && bookingDay(stay.ends_at, stay.timezone) > checkIn)) {
    return { query: '0=1', params: [] }
  }
  return {
    query: `NOT EXISTS (SELECT 1 FROM bookings s JOIN stay_nights n ON n.organization_id=s.organization_id AND n.booking_id=s.id
      WHERE s.organization_id=? AND s.status='confirmed' AND n.date>=? AND n.date<?
        AND ((s.product_id=? AND s.owner='channel') OR s.booked_product_id=?))
      AND NOT EXISTS (SELECT 1 FROM bookings s WHERE ${OVERBOOKED_HOME_SQL} AND ${window.sql}
        AND NOT EXISTS (SELECT 1 FROM json_each(?) observed
          WHERE json_extract(observed.value,'$[0]')=s.id AND json_extract(observed.value,'$[1]')=s.version))`,
    params: [organizationId, checkIn, checkOut, productId, productId, organizationId, productId, ...window.params, JSON.stringify(candidates.map(({ id, version }) => [id, version]))],
  }
}

export async function approvedStayPaymentPredicate(db: DbClient, input: {
  organizationId: string; productId: string; checkIn: string; checkOut: string;
  bookingId: string; buyerUserId: string; conversationId: string; version: number; through: string
}) {
  const { organizationId, bookingId, buyerUserId, conversationId, version, through } = input
  const channel = await stayChannelAvailability(db, input)
  return {
    query: `EXISTS (SELECT 1 FROM bookings b JOIN conversations r ON r.booking_id=b.id AND r.organization_id=b.organization_id
      WHERE b.organization_id=? AND b.id=? AND b.user_id=? AND b.version=? AND b.status='pending' AND b.owner='app'
        AND b.channel='direct' AND b.product_session_id IS NULL AND r.id=? AND r.kind='booking'
        AND r.user_id=b.user_id AND ${CURRENT_GUEST_SQL('r')} AND ${stayRequestRespondBySql('b')} IS NOT NULL
        AND b.product_id=? AND json_extract(b.policy_json, '$.stay_request.quote.check_in_date')=?
        AND json_extract(b.policy_json, '$.stay_request.quote.check_out_date')=? AND ${channel.query}
        AND (SELECT count(*) FROM stay_nights n WHERE n.organization_id=b.organization_id AND n.product_id=b.product_id
          AND n.booking_id=b.id AND n.date >= json_extract(b.policy_json, '$.stay_request.quote.check_in_date')
          AND n.date < json_extract(b.policy_json, '$.stay_request.quote.check_out_date')) = json_extract(b.policy_json, '$.stay_request.quote.nights')
        AND ${stayRequestPayBySql('r.id')} > ?)`,
    params: [organizationId, bookingId, buyerUserId, version, conversationId, input.productId, input.checkIn, input.checkOut, ...channel.params, through],
  }
}

/** The guest's request and price are one booking, with the same night claim used for every other stay. */
export async function createStayRequest(db: DbClient, env: StayMutationEnv, input: {
  organizationId: string; buyerUserId: string; key: string; fingerprint: string; home: StayHomeCore; quote: StayQuote;
  guest: CheckoutStay['guest']; locale: string; ipHash: string; policy: BookingPolicy; channelAvailability?: BatchQuery
  /** How the guest arrived on the website (bookings.website_source). */
  websiteSource: string | null
}) {
  const { organizationId, buyerUserId, key, fingerprint, home, quote, guest } = input
  const bookingId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const now = new Date().toISOString()
  const window = stayWindow({ ...quote, arrival_time: null }, home)
  const respondBy = stayRequestDeadline(now, window.starts_at, quote.timezone)
  if (respondBy <= now) fail(409, 'STAY_REQUEST_CHECK_IN_PASSED', 'Choose a check-in time that has not passed.', 'check_in_date')
  const policy = input.policy
  const stayRequest = { respond_by: respondBy, quote }
  const publicNights = await stayHoldPredicate(db, { organizationId, productId: home.product_id, checkIn: quote.check_in_date, checkOut: quote.check_out_date }, input.channelAvailability)
  const contact = threadPayloadForGuest({ ...guest, locale: input.locale, ipHash: input.ipHash })
  contact.provenance = { source: 'website', external_reference: null, actor_user_id: null, idempotency_key: key, fingerprint,
    guest_acknowledgement: true, creation_kind: 'ordinary', creation_status: 'pending', followups_completed: false }
  try {
    await executeBatch(db, [{
      query: `INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone,
                  party_size, adults, children, infants, status, answers, policy_json, total_minor, currency, idempotency_key, website_source, received_at, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${publicNights.query}
              ON CONFLICT(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      params: [bookingId, organizationId, buyerUserId, home.product_id, home.variant_id, home.location_id, window.starts_at, window.ends_at, quote.timezone,
        quote.adults + quote.children, quote.adults, quote.children, quote.infants, JSON.stringify(guest.answers ?? []), JSON.stringify({ ...policy, stay_request: stayRequest }),
        quote.total_minor, quote.currency, key, input.websiteSource, now, now, now, ...publicNights.params!],
    }, assertBookingBatchWrite({ query: 'EXISTS (SELECT 1 FROM bookings WHERE organization_id=? AND id=?)', params: [organizationId, bookingId] }),
    ...reconcileNightsQueries(organizationId, bookingId, { ...window, updated_at: now, version: 1, product_id: home.product_id,
      check_in_date: quote.check_in_date, check_out_date: quote.check_out_date }),
    ...requestInsertQueries({
      id: conversationId, kind: 'booking', organization_id: organizationId, location_id: home.location_id, booking_id: bookingId,
      user_id: buyerUserId, payload: contact, created_at: now,
    }, { query: 'SELECT 1 FROM bookings WHERE id=?', params: [bookingId] }, {
      opening: openingSentence({ kind: 'stay', homeTitle: quote.name, checkIn: quote.check_in_date, checkOut: quote.check_out_date,
        guests: quote.adults + quote.children, guestName: guest.name, guestPhone: guest.phone, answers: guest.answers ?? [] }),
      note: guest.notes,
    }),
    ...conversationTaskQueries(conversationId, now)], { operation: 'Request a stay' })
  } catch (cause) {
    if (isStayNightConflict(cause) || bookingBatchWriteRefused(cause)) fail(409, 'STAY_NIGHTS_UNAVAILABLE', 'Some of these nights are no longer available.', 'check_in_date')
    throw cause
  }
  return publishStayRequest(db, env, organizationId, bookingId)
}

/** The public request is complete only when its calendar and conversation are visible. */
export async function publishStayRequest(db: DbClient, env: StayMutationEnv, organizationId: string, bookingId: string) {
  const access: StayAccess = { organizationId, actorId: 'system', manage: true }
  return publishBookingNights(env, organizationId, await getStay(db, access, bookingId), [])
}

export function stayNightReleaseQueries(stay: Pick<Stay, 'id' | 'product_id' | 'starts_at' | 'ends_at' | 'check_in_date' | 'check_out_date' | 'version'>, organizationId: string, now: string) {
  return reconcileNightsQueries(organizationId, stay.id, { ...stay, updated_at: now, version: stay.version + 1 })
}

async function cancelUnpaidStayRequest(db: DbClient, env: StayMutationEnv, organizationId: string, stay: Stay, now: string, buyerUserId?: string) {
  const reason = buyerUserId ? 'guest_withdrew' : 'stay_request_expired'
  const [result] = await executeBatch(db, [
    bookingStatusQuery({ organizationId, bookingId: stay.id, status: 'cancelled', reason, now, guard: {
      query: `status='pending' AND version=? AND owner='app' AND channel='direct' AND product_session_id IS NULL
        AND ${stayRequestRespondBySql('bookings')} IS NOT NULL AND ${noStayRequestPaymentInFlightSql('?')}
        AND ${buyerUserId ? `user_id=? AND EXISTS (SELECT 1 FROM conversations r WHERE r.id=? AND r.user_id=bookings.user_id AND ${CURRENT_GUEST_SQL('r')})`
          : `COALESCE(${stayRequestPayBySql('?')}, ${stayRequestRespondBySql('bookings')}) <= ?`}`,
      params: [stay.version, stay.conversation_id, now, ...(buyerUserId ? [buyerUserId, stay.conversation_id] : [stay.conversation_id, now])],
    } }),
    ...stayNightReleaseQueries(stay, organizationId, now),
    ...messageQueries({
      conversationId: stay.conversation_id, authorKind: buyerUserId ? 'guest' : 'krabiclaw', authorUserId: buyerUserId ?? null,
      eventName: 'booking.cancel', body: buyerUserId ? 'The guest withdrew their stay request.' : 'The stay request expired.',
      occurredAt: now, dedupeKey: `booking:${stay.id}:${reason}`,
      guard: { sql: "EXISTS (SELECT 1 FROM bookings b WHERE b.id=c.booking_id AND b.organization_id=c.organization_id AND b.version=? AND b.updated_at=? AND b.cancellation_reason=?)",
        params: [stay.version + 1, now, reason] },
    }).queries,
    ...conversationTaskQueries(stay.conversation_id, now),
  ], { operation: 'Release unpaid stay request' })
  if (result?.meta.changes !== 1) return null
  return publishStayRequest(db, env, organizationId, stay.id)
}

/** Release a request at its stored deadline, including replay of an expired booking's publication. */
export async function expireStayRequest(db: DbClient, env: StayMutationEnv, organizationId: string, bookingId: string): Promise<void> {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT ${STAY_COLUMNS} FROM ${STAY_FROM}
    WHERE s.organization_id = ? AND s.id = ? AND s.product_session_id IS NULL AND s.owner = 'app' AND s.channel = 'direct'
      AND ${stayRequestRespondBySql('s')} IS NOT NULL`, [organizationId, bookingId])
  if (!row) return
  const stay = mapStay(row)
  if (stay.status === 'pending') {
    await cancelUnpaidStayRequest(db, env, organizationId, stay, new Date().toISOString())
  } else if (stay.status === 'cancelled' && stay.cancellation_reason === 'stay_request_expired') {
    await publishStayRequest(db, env, organizationId, stay.id)
  }
}

/** Publish currently due stay requests and return the next deadline. */
export async function dispatchStayCheckoutDeadlines(env: CloudflareEnv, organizationId: string, now: number): Promise<number | null> {
  const instant = new Date(now).toISOString()
  const checkout = await queryAll<{ id: string | null; due_at: string | null }>(env.DB, `
    WITH deadlines AS (
      SELECT b.id, MAX(COALESCE(${stayRequestPayBySql('c.id')}, ${stayRequestRespondBySql('b')}), COALESCE((
        SELECT MAX(h.expires_at) FROM payment_checkout_holds h JOIN payments p ON p.id = h.payment_id AND p.organization_id = h.organization_id
        WHERE h.organization_id = b.organization_id AND h.conversation_id = c.id AND h.status = 'active'
          AND json_type(p.review_json, '$.confirmation_started_at') = 'text'
      ), '')) AS due_at
      FROM bookings b JOIN conversations c ON c.organization_id = b.organization_id AND c.booking_id = b.id AND c.kind = 'booking'
      WHERE b.organization_id = ? AND b.status = 'pending' AND b.product_session_id IS NULL AND b.owner = 'app' AND b.channel = 'direct'
        AND ${stayRequestRespondBySql('b')} IS NOT NULL
    )
    SELECT id, due_at FROM deadlines WHERE due_at <= ?
    UNION ALL SELECT NULL, MIN(due_at) FROM deadlines WHERE due_at > ?`, [organizationId, instant, instant])
  for (const row of checkout) {
    if (row.id !== null) await publishEvent(env, { type: 'stay.checkout_expired', organization_id: organizationId, kind: 'request', id: row.id })
  }
  const next = checkout.find(row => row.id === null)?.due_at
  return next ? Date.parse(next) : null
}

/** Read the approved booking under its guest, using the terms accepted with the request. */
export async function readApprovedStayCheckout(db: DbClient, organizationId: string, bookingId: string, buyerUserId: string) {
  const now = new Date().toISOString()
  const approved = await queryFirst<{ policy_json: string; conversation_id: string; version: number; pay_by: string | null; in_flight: number; tax_code: string | null }>(db, `
    SELECT b.policy_json, r.id AS conversation_id, b.version, p.tax_code, ${stayRequestPayBySql('r.id')} AS pay_by, NOT (${noStayRequestPaymentInFlightSql('r.id')}) AS in_flight
      FROM bookings b JOIN conversations r ON r.booking_id=b.id AND r.organization_id=b.organization_id AND r.kind='booking'
      JOIN products p ON p.id=b.product_id AND p.organization_id=b.organization_id
     WHERE b.organization_id=? AND b.id=? AND b.user_id=? AND r.user_id=b.user_id AND ${CURRENT_GUEST_SQL('r')}
       AND b.owner='app' AND b.channel='direct' AND b.product_session_id IS NULL AND b.status='pending'`,
  [now, organizationId, bookingId, buyerUserId])
  if (!approved?.pay_by || !isValidInstant(approved.pay_by) || (approved.pay_by <= now && approved.in_flight !== 1)) {
    fail(409, 'STAY_REQUEST_NOT_PAYABLE', 'This stay request is no longer available to pay.', 'booking_id')
  }
  const policy = parseBookingPolicy(approved.policy_json)
  const stored: unknown = JSON.parse(approved.policy_json)
  const request = isRecord(stored) ? stored.stay_request : null
  const quote = isRecord(request) ? request.quote : null
  if (!isRecord(quote) || !policy.payment || quote.total_minor !== policy.payment.unit_amount || quote.currency !== policy.payment.currency
    || quote.tax_behavior !== policy.payment.tax_behavior || quote.cancellation_policy !== policy.cancellation || !Array.isArray(quote.nightly)) {
    throw new Error('The approved stay has no valid frozen quote')
  }
  const [conversation, stay, note] = await Promise.all([
    readGuestConversation(db, buyerUserId, approved.conversation_id),
    storedStay(db, organizationId, bookingId),
    queryFirst<{ body: string | null }>(db, 'SELECT body FROM messages WHERE conversation_id=? AND event_name=?', [approved.conversation_id, GUEST_NOTE_EVENT]),
  ])
  const thread = conversation?.kind === 'booking' && conversation.organization_id === organizationId
    && conversation.booking_id === bookingId && conversation.user_id === buyerUserId ? await validateGuestRequest(db, conversation) : null
  if (thread?.kind !== 'booking' || !thread.payload.guest.name || !thread.payload.guest.email || quote.product_id !== stay.product_id
    || quote.check_in_date !== stay.check_in_date || quote.check_out_date !== stay.check_out_date || quote.timezone !== stay.timezone) {
    throw new Error('The approved stay no longer matches its guest or frozen quote')
  }
  const guest: CheckoutStay['guest'] = { ...thread.payload.guest, name: thread.payload.guest.name, email: thread.payload.guest.email, notes: note?.body ?? null, answers: stay.answers }
  return { quote: quote as unknown as StayQuote, guest, policy, taxCode: approved.tax_code,
    expiresAt: approved.pay_by, conversationId: approved.conversation_id, version: approved.version }
}

export function checkoutStayChangedEvent(input: {
  organizationId: string; stayId: string; productId: string; locationId: string; conversationId: string;
  version: number; range: readonly [string, string] | null; endsAt: string;
}): Extract<DomainEvent, { type: 'stay.changed' }> {
  return {
    type: 'stay.changed', checkout_saved: true, organization_id: input.organizationId,
    booking_id: input.stayId, product_id: input.productId, location_id: input.locationId,
    conversation_id: input.conversationId, version: input.version, nights_changed: input.range !== null,
    push_ranges: input.range ? [input.range] : [], review_due_at: bookingReviewDueAt(input.endsAt), quiet: false, task_ids: [],
  }
}

/** Save the confirmed stay, claim its nights and open its conversation in one batch. */
export function stayFromCheckoutQueries(input: { organizationId: string; stayId: string; paymentId: string; buyerUserId: string; now: string; stay: CheckoutStay; home: CheckoutHome; policy: string; availability: BatchQuery
  /** How the guest who paid arrived on the website (bookings.website_source). */
  websiteSource: string | null }): BatchQuery[] {
  const { quote, guest } = input.stay
  const window = stayWindow({ check_in_date: quote.check_in_date, check_out_date: quote.check_out_date, arrival_time: null }, input.home)
  const requestId = crypto.randomUUID()
  return [
    {
      query: `INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants,
                status, answers, policy_json, total_minor, currency, idempotency_key, version, channel, owner, website_source, received_at, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, 1, 'direct', 'app', ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM payments WHERE id = ? AND organization_id = ? AND refunded_amount = 0) AND (${input.availability.query})`,
      params: [input.stayId, input.organizationId, input.buyerUserId, quote.product_id, input.home.variant_id, input.home.location_id, window.starts_at, window.ends_at, input.home.timezone,
        quote.adults + quote.children, quote.adults, quote.children, quote.infants, JSON.stringify(guest.answers ?? []), input.policy, quote.total_minor, quote.currency, `checkout:${input.paymentId}`,
        input.websiteSource, input.now, input.now, input.now, input.paymentId, input.organizationId, ...(input.availability.params ?? [])],
      event: checkoutStayChangedEvent({ organizationId: input.organizationId, stayId: input.stayId, productId: quote.product_id,
        locationId: input.home.location_id, conversationId: requestId, version: 1, range: [quote.check_in_date, quote.check_out_date], endsAt: window.ends_at }),
    },
    organizationEventQuery({ organizationId: input.organizationId, locationId: input.home.location_id, actorId: null, eventType: 'stay.created', entityType: 'stay', entityId: input.stayId, metadata: { channel: 'direct', payment_id: input.paymentId }, onlyIfPreviousChangedOneRow: true }),
    assertBookingBatchWrite({ query: 'EXISTS (SELECT 1 FROM bookings WHERE organization_id=? AND id=?)', params: [input.organizationId, input.stayId] }),
    ...reconcileNightsQueries(input.organizationId, input.stayId, { updated_at: input.now, version: 1, product_id: quote.product_id, ...window, check_in_date: quote.check_in_date, check_out_date: quote.check_out_date }),
    ...bookingConversationQueries({ organizationId: input.organizationId, bookingId: input.stayId, requestId, locationId: input.home.location_id, userId: input.buyerUserId, now: input.now,
      guest: { name: guest.name, email: guest.email, phone: guest.phone } }),
    // The stay's own message opens its conversation, then the guest's note.
    ...openingMessageQueries({ conversationId: requestId, at: input.now, guestUserId: input.buyerUserId, openedByUserId: input.buyerUserId, note: guest.notes,
      body: openingSentence({ kind: 'stay', homeTitle: input.home.name, checkIn: quote.check_in_date, checkOut: quote.check_out_date, guests: quote.adults + quote.children,
        guestName: guest.name, guestPhone: guest.phone, answers: guest.answers ?? [] }) }),
  ]
}

/** Schedule turnover and cache updates after the checkout saves its booking. */
async function completeStayFromCheckout(db: DbClient, env: CloudflareEnv, organizationId: string, stayId: string): Promise<void> {
  const stay = await storedStay(db, organizationId, stayId)
  const change = { organizationId, before: null, after: stay }
  const homes = await readTurnoverHomes(db, change)
  const { queries, keys } = turnoverTaskQueries({ ...change, homes, now: new Date().toISOString() })
  const results = await executeBatch(db, [
    ...queries,
    publicResourceCacheInvalidationQuery(organizationId, 'guest-thread-create'),
    // Redelivery also announces committed tasks if the previous queue send failed.
    turnoverTaskIdsQuery(organizationId, keys),
  ], { operation: 'Complete checkout stay turnover and cache invalidation' })
  const taskIds = changedTaskIds(results)
  if (taskIds.length) {
    const { postJobs } = await import('~/server/domain/cleaner-jobs')
    await postJobs(env, db, organizationId, taskIds, false)
  }
}

/** The stay a captured checkout made, read for its confirmation. */
export async function readCheckoutStay(db: DbClient, organizationId: string, stayId: string): Promise<Stay & { home: StayHome }> {
  const stay = await storedStay(db, organizationId, stayId)
  const [home] = await stayHomesWhere(db, organizationId, stay.product_id, { sql: '1 = 1', params: [] })
  if (!home) throw new Error(`Stay ${stayId} has no home`)
  return { ...stay, home }
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
