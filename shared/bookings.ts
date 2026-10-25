/** Session Bookings support instant confirmation or staff review. */

export const PRODUCT_SESSION_STATUSES = ['scheduled', 'cancelled'] as const
export type ProductSessionStatus = typeof PRODUCT_SESSION_STATUSES[number]

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled'] as const
export type BookingStatus = typeof BOOKING_STATUSES[number]

export const RESERVATION_STATUSES = ['confirmed', 'cancelled'] as const
export type ReservationStatus = typeof RESERVATION_STATUSES[number]

export const MAX_STAY_NIGHTS = 365
export const STAY_CHANNELS = ['airbnb', 'vrbo', 'booking_com', 'direct'] as const
export type StayChannel = typeof STAY_CHANNELS[number]
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
