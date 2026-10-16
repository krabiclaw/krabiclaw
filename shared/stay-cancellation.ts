import type { StayCancellationPolicy, StayLongTermCancellationPolicy } from './stay-listing'
import { localDateTimeToInstant } from '../utils/timezone'

/**
 * What a guest's cancellation returns, by the policy the stay was booked under,
 * as Airbnb's Help Center states each policy (airbnb.com/help/article/475).
 * The amounts are the nights' prices the guest paid; KrabiClaw adds no
 * service fee or taxes to a stay, so there is nothing else to return.
 */

/** Stays of this many nights or more take the home's long-term policy. */
export const LONG_TERM_STAY_NIGHTS = 28

/** The policy a stay was booked under: one of the home's two, chosen by the stay's length. */
export type StayBookedPolicy = StayCancellationPolicy | `long_term_${StayLongTermCancellationPolicy}`
export const STAY_BOOKED_POLICIES = ['flexible', 'moderate', 'limited', 'firm', 'strict', 'long_term_firm', 'long_term_strict'] as const satisfies readonly StayBookedPolicy[]

export function bookedPolicyFor(nights: number, home: { cancellation_policy: StayCancellationPolicy | null; long_term_cancellation_policy: StayLongTermCancellationPolicy | null }): StayBookedPolicy | null {
  if (nights >= LONG_TERM_STAY_NIGHTS) return home.long_term_cancellation_policy === null ? null : `long_term_${home.long_term_cancellation_policy}`
  return home.cancellation_policy
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface StayCancellationInput {
  policy: StayBookedPolicy
  /** Each night the guest paid for, in order. */
  nightly: ReadonlyArray<{ date: string; price_minor: number }>
  /** When the stay was booked. */
  booked_at: string
  /** When the guest cancels. */
  now: string
  timezone: string
  /** The home's check-in time: a night is spent once its check-in time has passed where the home is. */
  check_in_time: string
}

/** The minor amount a guest's own cancellation refunds; 0 when the policy returns nothing. */
export function stayCancellationRefund(input: StayCancellationInput): number {
  const nightStarts = input.nightly.map(night => localDateTimeToInstant(night.date, input.check_in_time, input.timezone, 'compatible').getTime())
  const now = Date.parse(input.now)
  const booked = Date.parse(input.booked_at)
  const checkIn = nightStarts[0]!
  const before = now < checkIn
  const untilCheckIn = checkIn - now
  const prices = input.nightly.map(night => night.price_minor)
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const total = sum(prices)
  const spent = nightStarts.filter(start => start <= now).length
  const half = (amount: number) => Math.round(amount / 2)

  if (input.policy === 'long_term_firm' || input.policy === 'long_term_strict') {
    const free = input.policy === 'long_term_firm'
      ? before && untilCheckIn >= 30 * DAY
      : now - booked <= 48 * HOUR && checkIn - booked >= 28 * DAY
    // After that, the nights spent and the next 30 are not refunded.
    return free ? total : sum(prices.slice(spent + 30))
  }

  // Every standard policy is free for 24 hours after booking, if booked at least 7 days before check-in.
  if (now - booked <= DAY && checkIn - booked >= 7 * DAY) return total
  switch (input.policy) {
    case 'flexible':
      // The guest pays the nights spent and one more night.
      return before && untilCheckIn >= DAY ? total : sum(prices.slice(spent + 1))
    case 'moderate':
      // The guest pays the nights spent, one more night and half of the rest.
      return before && untilCheckIn >= 5 * DAY ? total : half(sum(prices.slice(spent + 1)))
    case 'limited':
      return !before ? 0 : untilCheckIn >= 14 * DAY ? total : untilCheckIn >= 7 * DAY ? half(total) : 0
    case 'firm':
      return !before ? 0 : untilCheckIn >= 30 * DAY ? total : untilCheckIn >= 7 * DAY ? half(total) : 0
    case 'strict':
      return before && untilCheckIn >= 7 * DAY ? half(total) : 0
  }
}
