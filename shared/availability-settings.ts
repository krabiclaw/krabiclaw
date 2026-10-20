// The calendar's Settings sheet, in Airbnb's shape: every setting is a card
// that shows its value and opens a picker of a few choices, and each choice
// is one value of a field the policy already has. The guest's sentences
// (server/utils/booking-policy-summary.ts) read those same fields, and MCP's
// reservation policy tools name the same cancellation tiers.
import { WEEKDAYS, type OpeningHours } from '~/shared/reservation-hours'
import type { LocationReservationConfigPatch } from '~/server/utils/reservations'

const HOUR = 60
const DAY = 24 * HOUR

/** How far ahead a guest must book: Airbnb's choices, with hours where a table needs them. */
export const NOTICE_OPTIONS = [
  { value: 0, label: 'No notice', description: 'Guests can book a slot right up to its start.' },
  { value: 2 * HOUR, label: '2 hours', description: 'Slots starting within 2 hours are not offered.' },
  { value: DAY, label: '1 day' },
  { value: 2 * DAY, label: '2 days' },
  { value: 3 * DAY, label: '3 days' },
  { value: 7 * DAY, label: '7 days' },
] as const

export function noticeSummary(minutes: number | null | undefined): string {
  const value = minutes ?? 0
  const option = NOTICE_OPTIONS.find(entry => entry.value === value)
  if (option) return value === 0 ? 'No notice needed' : `At least ${option.label}`
  return `At least ${formatMinutes(value)}`
}

export function seatsSummary(capacity: number | null | undefined): string {
  return capacity === null || capacity === undefined ? 'No limit' : `${capacity} per time slot`
}

/**
 * Named reservation terms shared by the calendar and MCP. Free cancellation
 * controls the deposit refund; changes use the same deadline unless the business approves an exception.
 */
export const CANCELLATION_TIERS = [
  { id: 'flexible', label: 'Flexible', minutes: 2 * HOUR, points: ['Free cancellation until 2 hours before'] },
  { id: 'moderate', label: 'Moderate', minutes: DAY, points: ['Free cancellation until 1 day before'] },
  { id: 'firm', label: 'Firm', minutes: 2 * DAY, points: ['Free cancellation until 2 days before'] },
] as const

export type CancellationTierId = typeof CANCELLATION_TIERS[number]['id']
export const CANCELLATION_TIER_IDS = CANCELLATION_TIERS.map(tier => tier.id) as CancellationTierId[]

export function cancellationTierOf(policy: Pick<LocationReservationConfigPatch, 'free_cancellation_until_minutes' | 'reschedule_allowed' | 'reschedule_cutoff_minutes'>): CancellationTierId | null {
  const minutes = policy.free_cancellation_until_minutes ?? null
  if (minutes === null) return null
  const cutoff = policy.reschedule_allowed === false ? null : policy.reschedule_cutoff_minutes ?? minutes
  return CANCELLATION_TIERS.find(tier => tier.minutes === minutes && cutoff === minutes)?.id ?? null
}

export function cancellationPatch(tier: CancellationTierId): LocationReservationConfigPatch {
  const chosen = CANCELLATION_TIERS.find(entry => entry.id === tier)!
  return { free_cancellation_until_minutes: chosen.minutes, reschedule_allowed: true, reschedule_cutoff_minutes: chosen.minutes }
}

export function cancellationSummary(policy: Pick<LocationReservationConfigPatch, 'free_cancellation_until_minutes' | 'reschedule_allowed' | 'reschedule_cutoff_minutes'>): string {
  const tier = cancellationTierOf(policy)
  if (tier) return CANCELLATION_TIERS.find(entry => entry.id === tier)!.label
  const minutes = policy.free_cancellation_until_minutes ?? null
  return minutes === null ? 'No deadline' : `Custom · free until ${formatMinutes(minutes)} before`
}

/** "Mon–Sat · Closed Sun", the way Airbnb's card states a value in one line. */
export function hoursSummary(hours: OpeningHours): string {
  if (!hours) return 'Not set'
  const open = new Set(hours.periods.map(period => period.open.day))
  if (open.size === 7 || hours.periods.some(period => !period.close)) return 'Open every day'
  if (open.size === 0) return 'Closed every day'
  const short = (day: number) => WEEKDAYS[day]!.slice(0, 3).replace(/^./, letter => letter.toUpperCase())
  const closed = WEEKDAYS.map((_, day) => day).filter(day => !open.has(day))
  return `Open ${open.size} days · Closed ${closed.map(short).join(', ')}`
}

function formatMinutes(minutes: number): string {
  if (minutes % DAY === 0) return `${minutes / DAY} day${minutes === DAY ? '' : 's'}`
  if (minutes % HOUR === 0) return `${minutes / HOUR} hour${minutes === HOUR ? '' : 's'}`
  return `${minutes} minutes`
}
