import { HTTPError } from 'nitro'
import tzLookup from '@photostructure/tz-lookup'
import { isValidTimezone } from '~/utils/timezone'
import { DETAIL_FIELDS, type AirbnbPropertyType, type DetailField } from '~/shared/airbnb-import'
import { AIRBNB_CANCELLATION_CATEGORIES, AIRBNB_LONG_TERM_CANCELLATION_IDS, type StayCancellationPolicy, type StayLongTermCancellationPolicy } from '~/shared/stay-listing'
import { channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, integer, object, received, string, type JsonRecord } from './data'

/**
 * What an Airbnb listing says about itself, read through Channex: its details,
 * its content (photos, texts, amenities, rooms) and its next 500 nights. Airbnb's listing (checked live on 2026-10-22) has
 * no time zone, email or phone: the time zone comes from the listing's
 * coordinates and the contact details from the organization, since Channex
 * requires a contact email and phone on a property before it connects to
 * Airbnb. A field still unknown after that is reported as missing for the
 * host to supply; nothing is filled in for them.
 */

/**
 * Airbnb's `property_type_category` (as Channex's `listing_details` returns it;
 * "house" and "townhouse" read live on 2026-10-25) to Channex's `property_type`,
 * whose vacation-rental values Channex documents as apartment, boat, chalet,
 * country_house, farm_stay, holiday_home, homestay and villa (Properties API).
 * Airbnb's apartments group is an apartment; its stand-alone or terraced house
 * is a holiday home. A category not listed here stops the import for review.
 */
const AIRBNB_PROPERTY_TYPES: Readonly<Record<string, AirbnbPropertyType>> = {
  apartment: 'apartment', condominium: 'apartment', serviced_apartment: 'apartment', loft: 'apartment',
  house: 'holiday_home', townhouse: 'holiday_home', villa: 'villa', chalet: 'chalet',
}
export const CALENDAR_NIGHTS = 500

export interface ListingDetails {
  id: string
  title: string
  currency: string
  maxGuests: number
  defaultOccupancy: number
  /** The base nightly rate as Airbnb states it, a decimal string. */
  nightlyRate: string
  fields: Partial<Record<DetailField, string>>
  missingFields: DetailField[]
  /**
   * Airbnb's check-in window and checkout (`booking_settings.check_in_time_start`,
   * `check_in_time_end`, `check_out_time`) as local HH:MM. A start or checkout
   * Airbnb has not set is null, and the import refuses it; a flexible or unset
   * end is null.
   */
  checkInTime: string | null
  checkInEndTime: string | null
  checkOutTime: string | null
  /**
   * Airbnb's policies (`booking_settings.cancellation_policy_settings`) as ours,
   * for stays under 28 nights and for longer ones; null where Airbnb sent none.
   */
  cancellationPolicy: StayCancellationPolicy | null
  longTermCancellationPolicy: StayLongTermCancellationPolicy | null
}

/** The organization's guest contact details, which every imported home carries. */
export interface OrganizationContact {
  email: string | null
  phone: string | null
}

export interface ListingNight {
  date: string
  availability: 0 | 1
  rate: string
  minStay: number
  maxStay: number
  closedToArrival: boolean
  closedToDeparture: boolean
}

function fail(statusCode: number, code: string, message: string): never {
  throw new HTTPError({ statusCode, message, data: { code } })
}

function provided<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ChannexDataError) fail(502, 'INVALID_PROVIDER_RESPONSE', `Airbnb returned an invalid listing: ${error.message}`)
    throw error
  }
}

function amount(value: unknown, label: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ChannexDataError(`${label} is missing or invalid (got ${received(value)}). Review the listing on Airbnb.`)
  return String(value)
}

/**
 * Airbnb states check-in hours as strings, "16", from "8" to "27" where 24 and
 * later are the small hours of the next day, or "FLEXIBLE" / "NOT_SELECTED";
 * checkout as an integer hour, 0 to 23. Channex documents both
 * (Channels.AirbnbListingBookingSettings). A word is null; anything else is
 * not a shape Airbnb sends.
 */
function hourTime(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === 'FLEXIBLE' || value === 'NOT_SELECTED') return null
  const hour = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(hour) || hour < 0 || hour > 27) throw new ChannexDataError(`${label} must be an hour or FLEXIBLE (got ${received(value)})`)
  return `${String(hour % 24).padStart(2, '0')}:00`
}

/**
 * Airbnb's code as our policy of the same title and wording, or null when
 * Airbnb sent none. A code with no policy here (read live on 2026-10-29:
 * `flexible`, `better_strict_with_grace_period`, `CANCEL_LONG_TERM_FAIR`,
 * `CANCEL_LONG_TERM_WITH_GRACE_PERIOD`) stops the import for review.
 */
function airbnbPolicy<T extends string>(codes: Readonly<Partial<Record<T, string>>>, value: unknown, label: string): T | null {
  if (value === undefined || value === null) return null
  const policy = (Object.keys(codes) as T[]).find(key => codes[key] === value)
  if (!policy) fail(422, 'UNSUPPORTED_CANCELLATION_POLICY', `Airbnb ${label} "${received(value)}" has no verified KrabiClaw policy. Import stopped for review.`)
  return policy
}

/** The IANA zone at the listing's coordinates. Airbnb sends none of its own. */
function coordinateTimezone(lat: unknown, lng: unknown): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const zone = tzLookup(lat, lng)
  return isValidTimezone(zone) ? zone : null
}

/** Channex's `listing_details` action: the listing record as Airbnb reports it, or a ChannexDataError. */
async function readListingRecord(env: ChannexEnv, channelId: string, listingId: string): Promise<JsonRecord> {
  const raw = await channexRequest(env, `/channels/${encodeURIComponent(channelId)}/action/listing_details?${new URLSearchParams({ listing_id: listingId })}`)
  const record = object(object(raw.data, 'Listing details').listing, 'Airbnb listing')
  if (record.id !== listingId) throw new ChannexDataError('Airbnb returned a different listing')
  return record
}

async function listingRecord(env: ChannexEnv, channelId: string, listingId: string): Promise<JsonRecord> {
  try {
    return await readListingRecord(env, channelId, listingId)
  } catch (error) {
    return provided(() => { throw error })
  }
}

/**
 * Who may book the listing instantly (`booking_settings.instant_booking_allowed_category`).
 * Channex refuses a booking-settings update without it ("can't be blank", seen on
 * 2026-10-30) and KrabiClaw has no setting of its own for it, so every update
 * restates the listing's.
 */
export async function instantBookingCategory(env: ChannexEnv, channelId: string, listingId: string): Promise<string> {
  const listing = await readListingRecord(env, channelId, listingId)
  return string(object(listing.booking_settings, 'Booking settings').instant_booking_allowed_category, 'Instant booking allowed category')
}

export async function listingDetails(env: ChannexEnv, channelId: string, listingId: string, contact: OrganizationContact): Promise<ListingDetails> {
  const listing = await listingRecord(env, channelId, listingId)
  return provided(() => {
    const pricing = object(listing.pricing_settings, 'Listing pricing')
    const fields: Partial<Record<DetailField, string>> = {}
    const sources: ReadonlyArray<readonly [DetailField, string]> = [
      ['country', 'country_code'], ['state', 'state'], ['city', 'city'], ['address', 'street'], ['zipCode', 'zipcode'],
    ]
    for (const [key, source] of sources) {
      const value = listing[source]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || !value.trim()) throw new ChannexDataError(`Airbnb listing field ${source} must be a non-empty string`)
      fields[key] = value
    }
    const timezone = coordinateTimezone(listing.lat, listing.lng)
    if (timezone) fields.timezone = timezone
    if (contact.email) fields.email = contact.email
    if (contact.phone) fields.phone = contact.phone
    const booking = listing.booking_settings === undefined || listing.booking_settings === null ? {} : object(listing.booking_settings, 'Booking settings')
    if (listing.property_type_category !== undefined && listing.property_type_category !== null) {
      const category = string(listing.property_type_category, 'Airbnb property type')
      const propertyType = Object.hasOwn(AIRBNB_PROPERTY_TYPES, category) ? AIRBNB_PROPERTY_TYPES[category] : undefined
      if (!propertyType) fail(422, 'UNSUPPORTED_PROPERTY_TYPE', `Airbnb property type "${category}" has no verified KrabiClaw mapping. Import stopped for review.`)
      fields.propertyType = propertyType
    }
    const cancellation = booking.cancellation_policy_settings === undefined || booking.cancellation_policy_settings === null ? {} : object(booking.cancellation_policy_settings, 'Cancellation policy settings')
    return {
      id: listingId, title: string(listing.name, 'Listing name'), currency: string(pricing.listing_currency, 'Currency'),
      maxGuests: integer(listing.person_capacity, 'Guest capacity', 1), defaultOccupancy: integer(pricing.guests_included, 'Included guests', 1),
      nightlyRate: amount(pricing.default_daily_price, 'Base price'), fields,
      missingFields: DETAIL_FIELDS.filter(key => fields[key] === undefined),
      checkInTime: hourTime(booking.check_in_time_start, 'booking_settings.check_in_time_start'),
      checkInEndTime: hourTime(booking.check_in_time_end, 'booking_settings.check_in_time_end'),
      checkOutTime: hourTime(booking.check_out_time, 'booking_settings.check_out_time'),
      cancellationPolicy: airbnbPolicy<StayCancellationPolicy>(AIRBNB_CANCELLATION_CATEGORIES, cancellation.cancellation_policy_category, 'cancellation policy'),
      longTermCancellationPolicy: airbnbPolicy<StayLongTermCancellationPolicy>(AIRBNB_LONG_TERM_CANCELLATION_IDS, cancellation.lts_cancellation_policy_id, 'long-term cancellation policy'),
    }
  })
}

/** The listing texts Airbnb's editor holds, by Airbnb's field name. `name` and `locale` are not content. */
export const DESCRIPTION_FIELDS = ['summary', 'description', 'space', 'access', 'interaction', 'neighborhood_overview', 'transit', 'notes', 'house_rules'] as const
export type DescriptionField = typeof DESCRIPTION_FIELDS[number]

export interface ListingImage {
  /** Airbnb's image id, unique across listings (`<listing id>_<photo id>`). */
  id: string
  caption: string | null
  sortOrder: number
  /**
   * The photo at 2560 px wide: `extra_medium_url` (450×300) with its query
   * replaced by `im_w=2560`. Airbnb's image server answers that width and 404s
   * at 3840 (observed 2026-10-23, not documented); Channex names no larger URL.
   */
  url: string
}

/** The width imported photos are fetched at. */
export const PHOTO_WIDTH = 2560

export interface ListingRoom {
  type: string
  isPrivate: boolean
  beds: Array<{ type: string; quantity: number }>
}

/** A listing's content as Airbnb reports it: nothing is filled in; a text Airbnb has no value for is null. */
export interface ListingContent {
  images: ListingImage[]
  descriptions: Record<DescriptionField, string | null>
  /** `booking_settings.guest_controls`: whether the host allows pets, events and smoking; null where Airbnb has no answer. */
  guestControls: { pets: boolean | null; events: boolean | null; smoking: boolean | null }
  /** Top-level `quiet_hours` as local HH:MM: null when Airbnb leaves it out, false when the list is empty. */
  quietHours: { start: string; end: string } | false | null
  /** The check-in window and checkout, as `listingDetails` reads them. */
  checkInTime: string | null
  checkInEndTime: string | null
  checkOutTime: string | null
  /** Airbnb's amenity constants reported present (`is_present`), plus its `listing_views`, in Airbnb's spelling. */
  amenities: string[]
  bedrooms: number | null
  beds: number | null
  bathrooms: number | null
  rooms: ListingRoom[]
  houseManual: string | null
  directions: string | null
  wifiNetwork: string | null
  wifiPassword: string | null
  checkInOption: { category: string; instruction: string | null } | null
}

/** A text Airbnb may leave out or leave blank: null for both; anything else must be a string. */
function text(record: JsonRecord, key: string, label: string): string | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ChannexDataError(`${label} must be text`)
  return value.trim() ? value : null
}

function flag(record: JsonRecord, key: string, label: string): boolean | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new ChannexDataError(`${label} must be true, false or null (got ${received(value)})`)
  return value
}

function count(record: JsonRecord, key: string, label: string, step: 1 | 0.5): number | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value / step)) throw new ChannexDataError(`${label} must be a count in steps of ${step}`)
  return value
}

/**
 * The listing's content. Channex documents `images` (or null), `rooms`,
 * `descriptions` (or null) and `booking_settings` (its check-in hours and
 * `guest_controls`) and leaves the items open; `amenities`, `bedrooms`,
 * `beds`, `bathrooms`, `house_manual`, `directions`, the wifi fields,
 * `quiet_hours` and `check_in_option` are undocumented fields Airbnb returns
 * (checked live on listings 2465888 and 39313043, 2026-10-22/23), so each is
 * null when absent and an error when present in another shape. `quiet_hours`
 * is on the listing itself, not in `guest_controls`.
 */
export async function listingContent(env: ChannexEnv, channelId: string, listingId: string): Promise<ListingContent> {
  const listing = await listingRecord(env, channelId, listingId)
  return provided(() => {
    const rawImages = listing.images === null || listing.images === undefined ? [] : listing.images
    if (!Array.isArray(rawImages)) throw new ChannexDataError('images must be a list or null')
    const images = rawImages.map((value, index): ListingImage => {
      const image = object(value, `images[${index}]`)
      const source = string(image.extra_medium_url, `images[${index}].extra_medium_url`)
      if (!URL.canParse(source) || new URL(source).protocol !== 'https:') throw new ChannexDataError(`images[${index}].extra_medium_url must be an https URL`)
      const url = new URL(source)
      url.search = `?im_w=${PHOTO_WIDTH}`
      return { id: string(image.id, `images[${index}].id`), caption: text(image, 'caption', `images[${index}].caption`), sortOrder: integer(image.sort_order, `images[${index}].sort_order`), url: url.toString() }
    }).sort((a, b) => a.sortOrder - b.sortOrder)
    if (new Set(images.map(image => image.id)).size !== images.length) throw new ChannexDataError('images must have distinct ids')
    const texts = listing.descriptions === null || listing.descriptions === undefined ? {} : object(listing.descriptions, 'descriptions')
    const descriptions = Object.fromEntries(DESCRIPTION_FIELDS.map(key => [key, text(texts, key, `descriptions.${key}`)])) as Record<DescriptionField, string | null>
    const amenities: string[] = []
    if (listing.amenities !== null && listing.amenities !== undefined) {
      for (const [key, value] of Object.entries(object(listing.amenities, 'amenities'))) {
        const amenity = object(value, `amenities.${key}`)
        if (typeof amenity.is_present !== 'boolean') throw new ChannexDataError(`amenities.${key}.is_present must be true or false`)
        if (amenity.is_present) amenities.push(key)
      }
    }
    if (listing.listing_views !== null && listing.listing_views !== undefined) {
      if (!Array.isArray(listing.listing_views)) throw new ChannexDataError('listing_views must be a list')
      amenities.push(...listing.listing_views.map((value, index) => string(value, `listing_views[${index}]`)))
    }
    if (!Array.isArray(listing.rooms)) throw new ChannexDataError('rooms must be a list')
    const rooms = listing.rooms.map((value, index): ListingRoom => {
      const room = object(value, `rooms[${index}]`)
      if (typeof room.is_private !== 'boolean') throw new ChannexDataError(`rooms[${index}].is_private must be true or false`)
      if (!Array.isArray(room.beds)) throw new ChannexDataError(`rooms[${index}].beds must be a list`)
      return {
        type: string(room.room_type, `rooms[${index}].room_type`), isPrivate: room.is_private,
        beds: room.beds.map((entry, bed) => {
          const record = object(entry, `rooms[${index}].beds[${bed}]`)
          return { type: string(record.type, `rooms[${index}].beds[${bed}].type`), quantity: integer(record.quantity, `rooms[${index}].beds[${bed}].quantity`, 1) }
        }),
      }
    })
    const booking = listing.booking_settings === undefined || listing.booking_settings === null ? {} : object(listing.booking_settings, 'booking_settings')
    const controls = booking.guest_controls === undefined || booking.guest_controls === null ? {} : object(booking.guest_controls, 'booking_settings.guest_controls')
    let quietHours: ListingContent['quietHours'] = null
    if (listing.quiet_hours !== undefined && listing.quiet_hours !== null) {
      if (!Array.isArray(listing.quiet_hours) || listing.quiet_hours.length > 1) throw new ChannexDataError(`quiet_hours must be a list of at most one window (got ${received(listing.quiet_hours)})`)
      const window = listing.quiet_hours[0] === undefined ? null : object(listing.quiet_hours[0], 'quiet_hours[0]')
      if (window) {
        const start = hourTime(string(window.start_time, 'quiet_hours[0].start_time'), 'quiet_hours[0].start_time')
        const end = hourTime(string(window.end_time, 'quiet_hours[0].end_time'), 'quiet_hours[0].end_time')
        if (!start || !end) throw new ChannexDataError('quiet_hours[0] must name a start and an end hour')
        quietHours = { start, end }
      } else quietHours = false
    }
    let checkInOption: ListingContent['checkInOption'] = null
    if (listing.check_in_option !== null && listing.check_in_option !== undefined) {
      const option = object(listing.check_in_option, 'check_in_option')
      checkInOption = { category: string(option.category, 'check_in_option.category'), instruction: text(option, 'instruction', 'check_in_option.instruction') }
    }
    return {
      images, descriptions, amenities: [...new Set(amenities)], rooms, checkInOption, quietHours,
      guestControls: {
        pets: flag(controls, 'allows_pets_as_host', 'guest_controls.allows_pets_as_host'), events: flag(controls, 'allows_events_as_host', 'guest_controls.allows_events_as_host'),
        smoking: flag(controls, 'allows_smoking_as_host', 'guest_controls.allows_smoking_as_host'),
      },
      checkInTime: hourTime(booking.check_in_time_start, 'booking_settings.check_in_time_start'),
      checkInEndTime: hourTime(booking.check_in_time_end, 'booking_settings.check_in_time_end'),
      checkOutTime: hourTime(booking.check_out_time, 'booking_settings.check_out_time'),
      bedrooms: count(listing, 'bedrooms', 'bedrooms', 1), beds: count(listing, 'beds', 'beds', 1), bathrooms: count(listing, 'bathrooms', 'bathrooms', 0.5),
      houseManual: text(listing, 'house_manual', 'house_manual'), directions: text(listing, 'directions', 'directions'),
      wifiNetwork: text(listing, 'wifi_network', 'wifi_network'), wifiPassword: text(listing, 'wifi_password', 'wifi_password'),
    }
  })
}

function localToday(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** The listing's next 500 nights, starting today where the home is. All 500 or none. */
export async function listingCalendar(env: ChannexEnv, channelId: string, listingId: string, timezone: string): Promise<ListingNight[]> {
  const from = localToday(timezone)
  const to = addDays(from, CALENDAR_NIGHTS - 1)
  const raw = await channexRequest(env, `/channels/${encodeURIComponent(channelId)}/action/get_listing_calendar?${new URLSearchParams({ listing_id: listingId, date_from: from, date_to: to })}`)
  return provided(() => {
    const calendar = object(object(raw.data, 'Calendar response').calendar, 'Listing calendar')
    if (calendar.listing_id !== listingId || calendar.start_date !== from || calendar.end_date !== to || !Array.isArray(calendar.days) || calendar.days.length !== CALENDAR_NIGHTS) {
      throw new ChannexDataError('Airbnb did not return the complete calendar. Import stopped before changing availability.')
    }
    const days = calendar.days.map(value => object(value, 'Calendar day'))
    return Array.from({ length: CALENDAR_NIGHTS }, (_, offset) => {
      const date = addDays(from, offset)
      const matching = days.filter(day => day.date === date)
      if (matching.length !== 1) throw new ChannexDataError('Airbnb returned missing or duplicate calendar dates')
      const day = matching[0]!
      // A bad day names its date and the value Airbnb sent, so the host and the
      // worker log both show which night stopped the import.
      try {
        // Airbnb's calendar (checked live on 2026-10-22) carries availability only as
        // this string; the available_count Channex's schema lists is never sent.
        if (day.availability !== 'available' && day.availability !== 'unavailable') {
          throw new ChannexDataError(`This listing's calendar cannot be imported without review (availability ${received(day.availability)})`)
        }
        if (typeof day.closed_to_arrival !== 'boolean' || typeof day.closed_to_departure !== 'boolean') {
          throw new ChannexDataError(`Closed-to-arrival and closed-to-departure must be booleans (got ${received(day.closed_to_arrival)} and ${received(day.closed_to_departure)})`)
        }
        return {
          date, availability: day.availability === 'available' ? 1 : 0, rate: amount(day.daily_price, 'Nightly price'),
          minStay: integer(day.min_nights, 'Minimum nights', 1), maxStay: integer(day.max_nights, 'Maximum nights'),
          closedToArrival: day.closed_to_arrival, closedToDeparture: day.closed_to_departure,
        }
      } catch (error) {
        if (error instanceof ChannexDataError) throw new ChannexDataError(`${error.message} (night ${date})`)
        throw error
      }
    })
  })
}
