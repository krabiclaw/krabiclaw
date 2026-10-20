import { HTTPError } from 'nitro'
import { channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, integer, object, string } from './data'

/**
 * What an Airbnb listing says about itself, read through Channex: its details
 * and its next 500 nights. A field
 * Airbnb leaves out is reported as missing for the host to supply; nothing is
 * filled in for them.
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

export async function listingDetails(env: ChannexEnv, channelId: string, listingId: string): Promise<ListingDetails> {
  const raw = await channexRequest(env, `/channels/${encodeURIComponent(channelId)}/action/listing_details?${new URLSearchParams({ listing_id: listingId })}`)
  return provided(() => {
    const listing = object(object(raw.data, 'Listing details').listing, 'Airbnb listing')
    if (listing.id !== listingId) throw new ChannexDataError('Airbnb returned a different listing')
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
