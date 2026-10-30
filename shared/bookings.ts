/** Session Bookings support instant confirmation or staff review. */

export const PRODUCT_SESSION_STATUSES = ['scheduled', 'cancelled'] as const
export type ProductSessionStatus = typeof PRODUCT_SESSION_STATUSES[number]

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled'] as const
export type BookingStatus = typeof BOOKING_STATUSES[number]

export const RESERVATION_STATUSES = ['confirmed', 'cancelled'] as const
export type ReservationStatus = typeof RESERVATION_STATUSES[number]

/** Airbnb's documented maximum length of stay; inventory may cover a shorter date window. */
export const MAX_STAY_NIGHTS = 1125
/** The dated inventory shared by the guest calendar and the Channex import/push. */
export const STAY_CALENDAR_DAYS = 500

/** Optional listing rules actually supplied by its host or imported channel. */
export interface StayCalendarRules {
  /** Monday first. Airbnb's -1 explicitly leaves that weekday to the listing default. */
  day_of_week_min_nights?: number[]
  /** Airbnb's actual Friday/Saturday nightly amount, in the home's currency minor units. */
  weekend_price_minor?: number
}

/** Validate the one persisted listing-policy representation at every write/read boundary. */
export function parseStayCalendarRules(value: unknown): StayCalendarRules | null {
  if (value === null) return null
  const invalid = (message: string): never => { throw new TypeError(`calendar_rules ${message}`) }
  if (typeof value !== 'object' || Array.isArray(value)) invalid('must be an object or null')
  const rules = value as Record<string, unknown>
  const extra = Object.keys(rules).find(key => !['day_of_week_min_nights', 'weekend_price_minor'].includes(key))
  if (extra) invalid(`contains an unknown field: ${extra}`)
  const minimum = (night: unknown): night is number => typeof night === 'number' && Number.isInteger(night) && night >= 1 && night <= MAX_STAY_NIGHTS
  const result: StayCalendarRules = {}
  if (rules.day_of_week_min_nights !== undefined) {
    const weekdays = rules.day_of_week_min_nights
    if (!Array.isArray(weekdays) || weekdays.length !== 7 || weekdays.some(night => night !== -1 && !minimum(night))) invalid(`day_of_week_min_nights must have seven Monday-first values, each -1 or 1 to ${MAX_STAY_NIGHTS}`)
    result.day_of_week_min_nights = [...weekdays as number[]]
  }
  if (rules.weekend_price_minor !== undefined) {
    if (typeof rules.weekend_price_minor !== 'number' || !Number.isSafeInteger(rules.weekend_price_minor) || rules.weekend_price_minor < 0) invalid('weekend_price_minor must be a nonnegative integer')
    result.weekend_price_minor = rules.weekend_price_minor as number
  }
  return Object.keys(result).length ? result : null
}

/** Dated overrides inherit the actual listing rules, then its canonical defaults. */
export function resolveStayNightPolicy(home: { min_nights: number; base_price_minor: number | null; calendar_rules: StayCalendarRules | null }, date: string, override?: { min_stay_arrival?: number | null; price_minor?: number | null }): { min_stay_arrival: number; price_minor: number | null } {
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
  const rules = home.calendar_rules
  const weekdayMinimum = rules?.day_of_week_min_nights?.[weekday]
  return {
    min_stay_arrival: override?.min_stay_arrival ?? (weekdayMinimum !== undefined && weekdayMinimum > 0 ? weekdayMinimum : home.min_nights),
    price_minor: override?.price_minor ?? ((weekday === 4 || weekday === 5) && rules?.weekend_price_minor !== undefined ? rules.weekend_price_minor : home.base_price_minor),
  }
}
export const STAY_CHANNELS = ['airbnb', 'vrbo', 'booking_com', 'direct'] as const
export type StayChannel = typeof STAY_CHANNELS[number]
export const STAY_CHANNEL_LABELS: Record<StayChannel, string> = { airbnb: 'Airbnb', vrbo: 'Vrbo', booking_com: 'Booking.com', direct: 'Direct' }

/**
 * The guest's first name, as a member looking after the home reads it. A
 * channel sends the surname apart, but a site checkout and a host can save the
 * whole name in guest_name, so its first word is the first name.
 */
export function stayGuestFirstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null
}
export const STAY_PAYMENT_METHODS = ['cash', 'bank_transfer', 'card_external', 'other'] as const
export type StayPaymentMethod = typeof STAY_PAYMENT_METHODS[number]
export const STAY_PAYMENT_METHOD_LABELS: Record<StayPaymentMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', card_external: 'Card (outside KrabiClaw)', other: 'Other' }

export const LOCATION_RESERVATION_OVERRIDE_STATUSES = ['open', 'closed'] as const
export type LocationReservationOverrideStatus = typeof LOCATION_RESERVATION_OVERRIDE_STATUSES[number]

/** Pending review requests and confirmed bookings both hold capacity. */
export function bookingConsumesCapacity(booking: { status: BookingStatus }): boolean {
  return booking.status === 'pending' || booking.status === 'confirmed'
}

/** The same rule as SQL, for use inside a capacity-claim predicate. */
export const CAPACITY_CONSUMING_SQL = `b.status IN ('pending', 'confirmed')`

export const RESERVATION_CAPACITY_CONSUMING_SQL = `r.status = 'confirmed'`

/**
 * Done is a fact about the clock, not a stored state: a booking that was not
 * cancelled and whose end has passed is complete. `ends_at`, never `starts_at`
 * — a dinner booked 19:00–21:00 is not over at 19:01.
 */
export function isBookingComplete(booking: { status: BookingStatus; ends_at: string }, at: string): boolean {
  return booking.status === 'confirmed' && booking.ends_at < at
}

/**
 * The stable identity of a generated occurrence.
 *
 * Deliberately built from the rule and the INTENDED local start, never the
 * actual `starts_at`. Rescheduling a session changes its instant but not this
 * key, so regeneration finds the existing row and leaves it alone instead of
 * recreating the occurrence at its original time.
 */
export function occurrenceKey(ruleId: string, localDate: string, localStartTime: string): string {
  return `${ruleId}:${localDate}T${localStartTime}`
}

/** How far ahead a guest can book, in days. The public page and the session generator read the same number. */
export const PUBLIC_BOOKING_WINDOW_DAYS = 31
