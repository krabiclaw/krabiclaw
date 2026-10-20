import { isValidTimezone, localDateAt, localPartsAt, assertCalendarDate, addLocalDays, localNow, formatTime, MINUTE_TIME_PATTERN, calendarDateSchema as dateSchema, minuteTimeSchema as timeSchema } from '../utils/timezone.ts'
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export type Weekday = (typeof WEEKDAYS)[number]
export type WeekPoint = { day: number; hour: number; minute: number }
export type WeeklyPeriod = { open: WeekPoint; close: WeekPoint } | { open: { day: 0; hour: 0; minute: 0 }; close?: never }
export type OpeningHours = { periods: WeeklyPeriod[] } | null
export type DatePeriod = { open_time: string; close_time: string; close_day_offset: 0 | 1 }
export type Closure = { kind: 'closure'; starts_on: string; ends_on: string | null; note: string | null }
export type SpecialHours = Array<Closure | { kind: 'hours'; date: string; periods: DatePeriod[]; note: string | null }> | null
export type HoursInterval = { start: number; end: number }
const DAY = 1440
const WEEK = DAY * 7
export const TIME_PATTERN = MINUTE_TIME_PATTERN

const pointSchema = { type: 'object', additionalProperties: false, required: ['day', 'hour', 'minute'], properties: {
  day: { type: 'integer', minimum: 0, maximum: 6 }, hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 },
} }
export const openingHoursSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['periods'], properties: {
  periods: { type: 'array', items: { anyOf: [
    { type: 'object', additionalProperties: false, required: ['open', 'close'], properties: { open: pointSchema, close: pointSchema } },
    { type: 'object', additionalProperties: false, required: ['open'], properties: { open: { type: 'object', additionalProperties: false, required: ['day', 'hour', 'minute'], properties: { day: { const: 0 }, hour: { const: 0 }, minute: { const: 0 } } } } },
  ] } },
} }] }
const noteSchema = { type: ['string', 'null'], maxLength: 1000 }
export const specialHoursSchema = { anyOf: [{ type: 'null' }, { type: 'array', items: { anyOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'starts_on', 'ends_on', 'note'], properties: { kind: { const: 'closure' }, starts_on: dateSchema, ends_on: { anyOf: [dateSchema, { type: 'null' }] }, note: noteSchema } },
  { type: 'object', additionalProperties: false, required: ['kind', 'date', 'periods', 'note'], properties: { kind: { const: 'hours' }, date: dateSchema, note: noteSchema, periods: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['open_time', 'close_time', 'close_day_offset'], properties: { open_time: timeSchema, close_time: timeSchema, close_day_offset: { enum: [0, 1] } } } } } },
] } }] }

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid hours object or unsupported field')
  return value as Record<string, unknown>
}
function point(value: unknown): WeekPoint {
  const p = record(value, ['day', 'hour', 'minute'])
  if (typeof p.day !== 'number' || !Number.isInteger(p.day) || p.day < 0 || p.day > 6
    || typeof p.hour !== 'number' || !Number.isInteger(p.hour) || p.hour < 0 || p.hour > 23
    || typeof p.minute !== 'number' || !Number.isInteger(p.minute) || p.minute < 0 || p.minute > 59) throw new Error('Invalid weekly hours endpoint')
  return { day: p.day, hour: p.hour, minute: p.minute }
}
const weekMinute = (p: WeekPoint) => p.day * DAY + p.hour * 60 + p.minute
export const toMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
export const toTimeString = (minute: number): string => `${String(Math.floor(((minute % DAY) + DAY) % DAY / 60)).padStart(2, '0')}:${String(((minute % 60) + 60) % 60).padStart(2, '0')}`
function rejectOverlap(intervals: HoursInterval[]): void {
  const sorted = intervals.toSorted((a, b) => a.start - b.start)
  if (sorted.some((p, i) => i > 0 && p.start < sorted[i - 1]!.end)) throw new Error('Hours periods must not overlap')
}
export function parseOpeningHours(value: unknown): OpeningHours {
  if (value === null) return null
  const hours = record(value, ['periods'])
  if (!Array.isArray(hours.periods)) throw new Error('opening_hours.periods must be an array')
  const periods = hours.periods.map((value): WeeklyPeriod => {
    const p = record(value, ['open', 'close'])
    const open = point(p.open)
    if (p.close === undefined) {
      if (open.day !== 0 || open.hour !== 0 || open.minute !== 0) throw new Error('Always-open hours require Sunday 00:00 with no close')
      return { open: { day: 0, hour: 0, minute: 0 } }
    }
    const close = point(p.close)
    if (weekMinute(open) === weekMinute(close)) throw new Error('Opening and closing endpoints must differ')
    return { open, close }
  })
  rejectOverlap(periods.flatMap(p => {
    if (!p.close) return [{ start: 0, end: WEEK }]
    const start = weekMinute(p.open)
    const end = weekMinute(p.close)
    return end > start ? [{ start, end }] : [{ start, end: WEEK }, { start: 0, end }]
  }))
  return { periods }
}
export function parseSpecialHours(value: unknown): SpecialHours {
  if (value === null) return null
  if (!Array.isArray(value)) throw new Error('special_hours must be an array or null')
  const dates = new Set<string>()
  return value.map((value): NonNullable<SpecialHours>[number] => {
    const item = record(value, ['kind', 'starts_on', 'ends_on', 'date', 'periods', 'note'])
    if (item.note !== null && (typeof item.note !== 'string' || item.note.length > 1000)) throw new Error('Hours note must be text or null')
    if (item.kind === 'closure') {
      record(value, ['kind', 'starts_on', 'ends_on', 'note'])
      assertCalendarDate(item.starts_on)
      if (item.ends_on !== null) {
        assertCalendarDate(item.ends_on)
        if (item.ends_on < item.starts_on) throw new Error('Closure ends_on must not precede starts_on')
      }
      return { kind: 'closure', starts_on: item.starts_on, ends_on: item.ends_on, note: item.note }
    }
    if (item.kind !== 'hours') throw new Error('Special hours kind must be closure or hours')
    record(value, ['kind', 'date', 'periods', 'note'])
    assertCalendarDate(item.date)
    if (dates.has(item.date)) throw new Error('Only one hours override is allowed per date')
    dates.add(item.date)
    if (!Array.isArray(item.periods)) throw new Error('Dated hours periods must be an array')
    const periods = item.periods.map((value): DatePeriod => {
      const p = record(value, ['open_time', 'close_time', 'close_day_offset'])
      if (typeof p.open_time !== 'string' || !TIME_PATTERN.test(p.open_time) || typeof p.close_time !== 'string' || !TIME_PATTERN.test(p.close_time) || (p.close_day_offset !== 0 && p.close_day_offset !== 1)) throw new Error('Invalid dated hours endpoint')
      if (toMinutes(p.close_time) + p.close_day_offset * DAY <= toMinutes(p.open_time)) throw new Error('Dated closing endpoint must follow opening')
      return { open_time: p.open_time, close_time: p.close_time, close_day_offset: p.close_day_offset }
    })
    rejectOverlap(periods.map(p => ({ start: toMinutes(p.open_time), end: toMinutes(p.close_time) + p.close_day_offset * DAY })))
    return { kind: 'hours', date: item.date, periods, note: item.note }
  })
}
/**
 * The tenant's special hours with the dates from `from` to `to` closed: one
 * closure for the range, beside whatever was there.
 */
export function closeDates(special: SpecialHours, from: string, to: string): SpecialHours {
  assertCalendarDate(from)
  assertCalendarDate(to)
  if (to < from) throw new Error('A closure ends on or after the day it starts')
  return [...(special ?? []), { kind: 'closure', starts_on: from, ends_on: to, note: null }]
}
/**
 * The tenant's special hours with the dates from `from` to `to` open again:
 * every closure covering any of them is cut around the range, so the days
 * outside it stay closed with their note.
 */
export function openDates(special: SpecialHours, from: string, to: string): SpecialHours {
  assertCalendarDate(from)
  assertCalendarDate(to)
  if (to < from) throw new Error('A range ends on or after the day it starts')
  if (!special) return null
  const next = special.flatMap((entry): NonNullable<SpecialHours> => {
    // Dated hours with no periods close that date as surely as a closure does.
    if (entry.kind === 'hours') return entry.periods.length === 0 && entry.date >= from && entry.date <= to ? [] : [entry]
    if (entry.starts_on > to || (entry.ends_on !== null && entry.ends_on < from)) return [entry]
    const before = entry.starts_on < from ? [{ ...entry, ends_on: addLocalDays(from, -1) }] : []
    const after = entry.ends_on === null || entry.ends_on > to ? [{ ...entry, starts_on: addLocalDays(to, 1) }] : []
    return [...before, ...after]
  })
  return next.length ? next : null
}
export function closureOnDate(special: SpecialHours, date: string): Closure | undefined {
  return special?.find((p): p is Closure => p.kind === 'closure' && p.starts_on <= date && (p.ends_on === null || p.ends_on >= date))
}
export function datedHours(special: SpecialHours, date: string) {
  return special?.find(p => p.kind === 'hours' && p.date === date)
}
export function getDateIntervals(hours: OpeningHours, special: SpecialHours, date: string): HoursInterval[] | null {
  if (closureOnDate(special, date)) return []
  const dated = datedHours(special, date)
  const previousDate = addLocalDays(date, -1)
  const previous = datedHours(special, previousDate)
  const nextDate = addLocalDays(date, 1)
  const nextReplacesSpill = Boolean(datedHours(special, nextDate) || closureOnDate(special, nextDate))
  const bounds = new Date(`${date}T00:00:00Z`).getUTCDay() * DAY
  let periods: HoursInterval[]
  if (dated?.kind === 'hours') {
    periods = dated.periods.map(p => ({ start: toMinutes(p.open_time), end: toMinutes(p.close_time) + p.close_day_offset * DAY }))
  } else {
    periods = hours?.periods.flatMap((p): HoursInterval[] => {
      if (!p.close) return [{ start: 0, end: DAY * 2 }]
      const start = weekMinute(p.open)
      const close = weekMinute(p.close)
      const end = close > start ? close : close + WEEK
      return [-WEEK, 0, WEEK].flatMap(offset => {
        if (start + offset >= bounds + DAY || end + offset <= bounds) return []
        if (start + offset < bounds && start + offset >= bounds - DAY && (previous || closureOnDate(special, previousDate))) return []
        return [{ start: start + offset - bounds, end: end + offset - bounds }]
      })
    }) ?? []
    if (previous?.kind === 'hours' && !closureOnDate(special, previousDate)) periods.push(...previous.periods.filter(p => p.close_day_offset === 1 && toMinutes(p.close_time) > 0).map(p => ({ start: toMinutes(p.open_time) - DAY, end: toMinutes(p.close_time) })))
    if (!hours && !previous) return null
  }
  const merged: HoursInterval[] = []
  for (const period of periods.toSorted((a, b) => a.start - b.start)) {
    const end = nextReplacesSpill ? Math.min(DAY, period.end) : period.end
    const previous = merged.at(-1)
    if (previous && previous.end >= period.start) previous.end = Math.max(previous.end, end)
    else merged.push({ start: period.start, end })
  }
  return merged
}
export function generateReservationTimes(hours: OpeningHours, date: string, { intervalMinutes = 30, lastSeatingBufferMinutes = 60, specialHours = null as SpecialHours } = {}): string[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || !Number.isInteger(lastSeatingBufferMinutes) || lastSeatingBufferMinutes < 0) throw new Error('Invalid reservation interval or last seating buffer')
  const slots = new Set<string>()
  for (const { start, end } of getDateIntervals(hours, specialHours, date) ?? []) {
    for (let minute = start < 0 ? start + Math.ceil(-start / intervalMinutes) * intervalMinutes : start; minute < DAY && minute <= end - lastSeatingBufferMinutes; minute += intervalMinutes) slots.add(toTimeString(minute))
  }
  return [...slots].sort()
}
export function getTodayHoursLabel(hours: OpeningHours, closedLabel: string, timezone?: string | null, now = new Date(), special: SpecialHours = null, locale = 'en'): string | null {
  if (!timezone) return null
  const intervals = getDateIntervals(hours, special, localNow(timezone, now).date)
  if (intervals === null) return null
  return intervals.length ? intervals.map(p => `${formatTime(toTimeString(Math.max(0, p.start)), locale)} – ${formatTime(toTimeString(p.end), locale)}`).join(', ') : closedLabel
}
export interface OpeningHoursSpecification {
  '@type': 'OpeningHoursSpecification'
  dayOfWeek: string
  opens: string
  closes: string
}

const SCHEMA_WEEKDAY = WEEKDAYS.map(day => `https://schema.org/${day[0]!.toUpperCase()}${day.slice(1)}`)

/**
 * The weekly hours as schema.org states them, read from the stored periods.
 *
 * This reads the canonical `periods` through the same interval logic the page
 * renders from, so the markup and the visible table cannot disagree. It does
 * not parse the formatted table back into times: that is display text, built
 * for a locale and a reader, and a machine-readable claim must not be recovered
 * from it.
 *
 * A period running past midnight is stated on the day it opens, closing at
 * 23:59 — schema.org has no way to say "and on into tomorrow" on one entry.
 */
export function schemaOpeningHours(hours: OpeningHours): OpeningHoursSpecification[] {
  if (hours === null) return []
  // Seven consecutive dates, so every weekday is read once. 2024-01-01 is a
  // Monday; the weekday is taken from the date rather than from the offset.
  return Array.from({ length: 7 }, (_, index) => addLocalDays('2024-01-01', index)).flatMap((date) => {
    const dayOfWeek = SCHEMA_WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!
    return (getDateIntervals(hours, null, date) ?? []).map(interval => ({
      '@type': 'OpeningHoursSpecification' as const,
      dayOfWeek,
      opens: toTimeString(Math.max(0, interval.start)),
      closes: interval.end >= DAY ? '23:59' : toTimeString(interval.end),
    }))
  })
}

export function isOpenNow(hours: OpeningHours, timezone?: string | null, now = new Date(), special: SpecialHours = null): boolean | undefined {
  if (!timezone) return undefined
  const local = localNow(timezone, now)
  const periods = getDateIntervals(hours, special, local.date)
  return periods === null ? undefined : periods.some(p => p.start <= toMinutes(local.time) && p.end > toMinutes(local.time))
}
export function normalizeGoogleOpeningHours(periods: unknown): OpeningHours {
  if (periods === null || periods === undefined) return null
  if (!Array.isArray(periods)) throw new Error('Google opening periods must be an array')
  const endpoint = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Google hours endpoint')
    const p = value as Record<string, unknown>
    return { day: p.day, hour: p.hour ?? 0, minute: p.minute ?? 0 }
  }
  return parseOpeningHours({ periods: periods.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Google hours period')
    const p = value as Record<string, unknown>
    return { open: endpoint(p.open), ...(p.close === undefined ? {} : { close: endpoint(p.close) }) }
  }) })
}

export function locationAllowsBooking(session: { starts_at: string; ends_at: string }, location: { timezone: string | null; status: string; opening_hours: string | null; special_hours: string | null }): boolean {
  if (location.status !== 'active' || !location.timezone || !isValidTimezone(location.timezone)) return false
  const starts = new Date(session.starts_at), ends = new Date(session.ends_at)
  const date = localDateAt(starts, location.timezone)
  const endDate = localDateAt(ends, location.timezone)
  const intervals = getDateIntervals(parseOpeningHours(location.opening_hours ? JSON.parse(location.opening_hours) : null), parseSpecialHours(location.special_hours ? JSON.parse(location.special_hours) : null), date)
  // Unknown opening hours do not override an explicitly scheduled session.
  if (intervals === null) return true
  const start = localPartsAt(starts, location.timezone), end = localPartsAt(ends, location.timezone)
  const firstMinute = start.hour * 60 + start.minute
  const lastMinute = end.hour * 60 + end.minute + (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 60000
  return intervals.some(interval => firstMinute >= interval.start && lastMinute <= interval.end)
}
