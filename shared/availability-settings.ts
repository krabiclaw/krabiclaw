// The calendar's Settings sheet, in Airbnb's shape: every setting is a card
// that shows its value and opens a picker of a few choices, and each choice
// is one value of a field the policy already has.
import { WEEKDAYS, type OpeningHours } from '~/shared/reservation-hours'

const HOUR = 60
const DAY = 24 * HOUR

/**
 * The one cancellation rule for every reservation, class and consultation,
 * Airbnb's 1-day policy (airbnb.com/help/article/1565): a full refund until 24
 * hours before the start. Changes close at the same moment.
 */
export const FREE_CANCELLATION_MINUTES = DAY

/**
 * How long before the start a class's or consultation's changes and free
 * cancellation close: its advance notice, never less than the 1-day rule. A
 * table reservation passes null: its notice governs booking only.
 */
export function changeNoticeMinutes(advanceNoticeMinutes: number | null): number {
  return Math.max(FREE_CANCELLATION_MINUTES, advanceNoticeMinutes ?? 0)
}

export function freeCancellationUntil(startsAt: string, advanceNoticeMinutes: number | null): string {
  return new Date(Date.parse(startsAt) - changeNoticeMinutes(advanceNoticeMinutes) * 60_000).toISOString()
}

/** A start inside the advance notice is not offered, and a guest's own cancellation closes there too. */
export function outsideNotice(startsAt: string, advanceNoticeMinutes: number | null, now = Date.now()): boolean {
  return Date.parse(startsAt) > now + (advanceNoticeMinutes ?? 0) * 60_000
}

/** "24 hours", "2 days": a notice in the guest's language. One day reads as the 24 hours guests already know. */
export function noticeDuration(minutes: number, locale: string): string {
  const [value, unit] = minutes > DAY && minutes % DAY === 0 ? [minutes / DAY, 'day'] : minutes % HOUR === 0 ? [minutes / HOUR, 'hour'] : [minutes, 'minute']
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value)
}

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
