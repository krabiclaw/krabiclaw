import { HTTPError } from 'nitro'
import { channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, integer, object, string, type JsonRecord } from './data'

/**
 * What an Airbnb listing says about itself, read through Channex: its details,
 * its content (photos, texts, amenities, rooms) and its next 500 nights. A
 * field Airbnb leaves out is reported as missing for the host to supply;
 * nothing is filled in for them.
 */

export const DETAIL_FIELDS = ['timezone', 'email', 'phone', 'country', 'state', 'city', 'address', 'zipCode', 'propertyType', 'childBeds', 'infantCots'] as const
export type DetailField = typeof DETAIL_FIELDS[number]
export const PROPERTY_TYPES = ['apartment', 'holiday_home', 'villa', 'chalet', 'lodge'] as const
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
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ChannexDataError(`${label} is missing or invalid. Review the listing on Airbnb.`)
  return String(value)
}

/** Channex's `listing_details` action: the listing record as Airbnb reports it. */
async function listingRecord(env: ChannexEnv, channelId: string, listingId: string): Promise<JsonRecord> {
  const raw = await channexRequest(env, `/channels/${encodeURIComponent(channelId)}/action/listing_details?${new URLSearchParams({ listing_id: listingId })}`)
  return provided(() => {
    const record = object(object(raw.data, 'Listing details').listing, 'Airbnb listing')
    if (record.id !== listingId) throw new ChannexDataError('Airbnb returned a different listing')
    return record
  })
}

export async function listingDetails(env: ChannexEnv, channelId: string, listingId: string): Promise<ListingDetails> {
  const listing = await listingRecord(env, channelId, listingId)
  return provided(() => {
    const pricing = object(listing.pricing_settings, 'Listing pricing')
    const fields: Partial<Record<DetailField, string>> = {}
    const sources: ReadonlyArray<readonly [DetailField, string]> = [
      ['timezone', 'timezone'], ['email', 'email'], ['phone', 'phone'], ['country', 'country_code'],
      ['state', 'state'], ['city', 'city'], ['address', 'street'], ['zipCode', 'zipcode'],
    ]
    for (const [key, source] of sources) {
      const value = listing[source]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || !value.trim()) throw new ChannexDataError(`Airbnb listing field ${source} must be a non-empty string`)
      fields[key] = value
    }
    if (listing.property_type_category !== undefined && listing.property_type_category !== null) {
      const category = string(listing.property_type_category, 'Airbnb property type')
      if (!(PROPERTY_TYPES as readonly string[]).includes(category)) fail(422, 'UNSUPPORTED_PROPERTY_TYPE', `Airbnb property type "${category}" has no verified KrabiClaw mapping. Import stopped for review.`)
      fields.propertyType = category
    }
    // Airbnb's guest capacity does not split out children and infants, so
    // those two always come from the host.
    return {
      id: listingId, title: string(listing.name, 'Listing name'), currency: string(pricing.listing_currency, 'Currency'),
      maxGuests: integer(listing.person_capacity, 'Guest capacity', 1), defaultOccupancy: integer(pricing.guests_included, 'Included guests', 1),
      nightlyRate: amount(pricing.default_daily_price, 'Base price'), fields,
      missingFields: DETAIL_FIELDS.filter(key => fields[key] === undefined),
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
  /** The largest rendition Airbnb's listing details name: `extra_medium_url`. */
  url: string
}

export interface ListingRoom {
  type: string
  isPrivate: boolean
  beds: Array<{ type: string; quantity: number }>
}

/** A listing's content as Airbnb reports it: nothing is filled in; a text Airbnb has no value for is null. */
export interface ListingContent {
  images: ListingImage[]
  descriptions: Record<DescriptionField, string | null>
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

function count(record: JsonRecord, key: string, label: string, step: 1 | 0.5): number | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value / step)) throw new ChannexDataError(`${label} must be a count in steps of ${step}`)
  return value
}

/**
 * The listing's content. Channex documents `images` (or null), `rooms` and
 * `descriptions` (or null) on the listing and leaves their items open;
 * `amenities`, `bedrooms`, `beds`, `bathrooms`, `house_manual`, `directions`,
 * the wifi fields and `check_in_option` are undocumented fields Airbnb returns
 * (checked live, 2026-10-22), so each is null when absent and an error when
 * present in another shape.
 */
export async function listingContent(env: ChannexEnv, channelId: string, listingId: string): Promise<ListingContent> {
  const listing = await listingRecord(env, channelId, listingId)
  return provided(() => {
    const rawImages = listing.images === null || listing.images === undefined ? [] : listing.images
    if (!Array.isArray(rawImages)) throw new ChannexDataError('images must be a list or null')
    const images = rawImages.map((value, index): ListingImage => {
      const image = object(value, `images[${index}]`)
      const url = string(image.extra_medium_url, `images[${index}].extra_medium_url`)
      if (!URL.canParse(url) || new URL(url).protocol !== 'https:') throw new ChannexDataError(`images[${index}].extra_medium_url must be an https URL`)
      return { id: string(image.id, `images[${index}].id`), caption: text(image, 'caption', `images[${index}].caption`), sortOrder: integer(image.sort_order, `images[${index}].sort_order`), url }
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
    let checkInOption: ListingContent['checkInOption'] = null
    if (listing.check_in_option !== null && listing.check_in_option !== undefined) {
      const option = object(listing.check_in_option, 'check_in_option')
      checkInOption = { category: string(option.category, 'check_in_option.category'), instruction: text(option, 'instruction', 'check_in_option.instruction') }
    }
    return {
      images, descriptions, amenities: [...new Set(amenities)], rooms, checkInOption,
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
      const count = integer(day.available_count, 'Availability')
      if ((day.availability !== 'available' && day.availability !== 'unavailable') || ![0, 1].includes(count)
        || (day.availability === 'available') !== (count === 1) || typeof day.closed_to_arrival !== 'boolean' || typeof day.closed_to_departure !== 'boolean') {
        throw new ChannexDataError("This listing's calendar cannot be imported without review")
      }
      return {
        date, availability: count as 0 | 1, rate: amount(day.daily_price, 'Nightly price'),
        minStay: integer(day.min_nights, 'Minimum nights', 1), maxStay: integer(day.max_nights, 'Maximum nights'),
        closedToArrival: day.closed_to_arrival, closedToDeparture: day.closed_to_departure,
      }
    })
  })
}
