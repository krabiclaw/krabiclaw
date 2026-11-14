import { LONG_TERM_STAY_NIGHTS } from './stay-cancellation.ts'

/** Session Bookings support instant confirmation or staff review. */

export const PRODUCT_SESSION_STATUSES = ['scheduled', 'cancelled'] as const
export type ProductSessionStatus = typeof PRODUCT_SESSION_STATUSES[number]

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled'] as const
export type BookingStatus = typeof BOOKING_STATUSES[number]

/** Channex's Airbnb availability-settings schema caps stay lengths at 1125 nights.
 * A published home may have no stay inside its current inventory window.
 * @see https://docs.channex.io/api-v.1-documentation/airbnb-api.md
 */
export const MAX_STAY_NIGHTS = 1125
/** How far ahead a guest can book, measured on the offering's local calendar. */
export const BOOKING_HORIZON_DAYS = 500
export const AVAILABILITY_PAGE_DAYS = 31
/** The dated inventory also shared with the Channex import/push. */
export const STAY_CALENDAR_DAYS = BOOKING_HORIZON_DAYS

export const STAY_DIRECT_DISCOUNTS = {
  last_minute_percent: { label: 'Last-minute discount', detail: 'For bookings made 14 days or less before arrival', eligible: (_nights: number, leadDays: number) => leadDays <= 14 },
  weekly_percent: { label: 'Weekly discount', detail: 'For stays of 7 nights or more', eligible: (nights: number) => nights >= 7 },
  monthly_percent: { label: 'Monthly discount', detail: `For stays of ${LONG_TERM_STAY_NIGHTS} nights or more`, eligible: (nights: number) => nights >= LONG_TERM_STAY_NIGHTS },
} as const

/** Optional listing rules actually supplied by its host or imported channel. */
export interface StayCalendarRules {
  /** Monday first. Airbnb's -1 explicitly leaves that weekday to the listing default. */
  day_of_week_min_nights?: number[]
  /** Airbnb's actual Friday/Saturday nightly amount, in the home's currency minor units. */
  weekend_price_minor?: number
  direct_discounts?: Partial<Record<keyof typeof STAY_DIRECT_DISCOUNTS, number>>
}

/** Validate the one persisted listing-policy representation at every write/read boundary. */
export function parseStayCalendarRules(value: unknown): StayCalendarRules | null {
  if (value === null) return null
  const invalid = (message: string): never => { throw new TypeError(`calendar_rules ${message}`) }
  if (typeof value !== 'object' || Array.isArray(value)) invalid('must be an object or null')
  const rules = value as Record<string, unknown>
  const extra = Object.keys(rules).find(key => !['day_of_week_min_nights', 'weekend_price_minor', 'direct_discounts'].includes(key))
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
  if (rules.direct_discounts !== undefined) {
    const discounts = rules.direct_discounts
    if (!discounts || typeof discounts !== 'object' || Array.isArray(discounts)) invalid('direct_discounts must be an object')
    const entries = Object.entries(discounts as Record<string, unknown>)
    for (const [key, percent] of entries) {
      if (!Object.hasOwn(STAY_DIRECT_DISCOUNTS, key) || typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 99) {
        invalid('direct_discounts must use supported discounts from 1 to 99 percent')
      }
    }
    if (entries.length) result.direct_discounts = Object.fromEntries(entries)
  }
  return Object.keys(result).length ? result : null
}

/** Channel inventory and rates do not include discounts for direct bookings. */
export function stayChannelCalendarRules(rules: StayCalendarRules | null | undefined): StayCalendarRules | null {
  const { direct_discounts: _discounts, ...channelRules } = rules ?? {}
  return Object.keys(channelRules).length ? channelRules : null
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
/** The percent a nights write may move each selected night's price by, either way. */
export const NIGHT_PRICE_CHANGE_PERCENT = 50
/** A night's price moved by a whole percent, rounded to its minor unit: the nights write and its read-back agree on this. */
export function changeNightPrice(priceMinor: number, percent: number): number {
  // Exact integers, half up: floating point loses minor units on large amounts.
  const scaled = BigInt(priceMinor) * BigInt(100 + percent)
  return Number(scaled / 100n + (scaled % 100n >= 50n ? 1n : 0n))
}
export const STAY_CHANNELS = ['airbnb', 'vrbo', 'booking_com', 'direct'] as const
export type StayChannel = typeof STAY_CHANNELS[number]

/** A migrated OTA reservation stays managed on its channel before its provider revision arrives. */
export function isChannelManagedStay(stay: { owner: 'app' | 'channel'; channel: StayChannel }): boolean {
  return stay.owner === 'channel' || stay.channel !== 'direct'
}
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

/** Pending review requests and confirmed bookings both hold capacity. */
export function bookingConsumesCapacity(booking: { status: BookingStatus }): boolean {
  return booking.status === 'pending' || booking.status === 'confirmed'
}

/** The same rule as SQL, for use inside a capacity-claim predicate. */
export const CAPACITY_CONSUMING_SQL = `b.status IN ('pending', 'confirmed')`

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
 * key, so the calendar keeps the original occurrence attached to the saved row.
 */
export function occurrenceKey(ruleId: string, localDate: string, localStartTime: string): string {
  return `${ruleId}:${localDate}T${localStartTime}`
}
