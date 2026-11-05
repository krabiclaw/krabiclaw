/*
  How the inbox says a time, a date range and a person, formatted once here on
  the server for every surface: the web list and conversation, the iOS tab and
  the message emails read these strings and format nothing of their own.

  Airbnb's forms, read from its hosting inbox: a list time is "2:33 PM" today,
  "Yesterday", "Mon" within six days, "Nov 2" this year and "Nov 2, 2025"
  before it; a thread's day headers say Today, Yesterday, the weekday, then the
  date; a stay's dates are "Oct 16 – 23", naming the month once when it does not
  change. Every one of them is read in the home's own timezone.
*/

import { formatCalendarDate, formatCalendarRange } from '~/utils/timezone'

const LOCALE = 'en-US'

function parts(instant: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat(LOCALE, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(instant).map(part => [part.type, part.value]))
  return { year: Number(values.year), key: `${values.year}-${values.month}-${values.day}` }
}

/** Whole calendar days from `instant`'s date to `now`'s date, both in `timeZone`. */
function daysBefore(instant: Date, now: Date, timeZone: string): number {
  return Math.round((Date.parse(`${parts(now, timeZone).key}T00:00:00Z`) - Date.parse(`${parts(instant, timeZone).key}T00:00:00Z`)) / 86_400_000)
}

/** The local calendar date an instant falls on, as YYYY-MM-DD; what a run of messages is grouped under. */
export function localDateKey(instant: string, timeZone: string): string {
  return parts(new Date(instant), timeZone).key
}

/** "2:33 PM". */
export function clockTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(instant))
}

function monthDay(instant: Date, timeZone: string, withYear: boolean): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(instant)
}

/** The list row's time: "2:33 PM", "Yesterday", "Mon", "Nov 2", "Nov 2, 2025". */
export function listTime(instant: string, timeZone: string, now: Date): string {
  const at = new Date(instant)
  const days = daysBefore(at, now, timeZone)
  if (days <= 0) return clockTime(instant, timeZone)
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: 'short' }).format(at)
  return monthDay(at, timeZone, parts(at, timeZone).year !== parts(now, timeZone).year)
}

/** A thread's day header: "Today", "Yesterday", "Tuesday", "Nov 2", "Nov 2, 2025". */
export function dayLabel(instant: string, timeZone: string, now: Date): string {
  const at = new Date(instant)
  const days = daysBefore(at, now, timeZone)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: 'long' }).format(at)
  return monthDay(at, timeZone, parts(at, timeZone).year !== parts(now, timeZone).year)
}

/** "Fri, Nov 6, 3:00 PM": when a pending message goes out. */
export function sendTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant))
}

/** One calendar date: "Jul 20". */
export function calendarDate(date: string): string {
  return formatCalendarDate(date, LOCALE, { month: 'short', day: 'numeric' })
}

/**
 * What a stay's row and header say about when: its dates, or, where Airbnb's
 * row would, "In 3 days" before an arrival this week and "Check out tomorrow"
 * on the last night.
 */
export function stayWhen(checkIn: string, checkOut: string, now: Date, timeZone: string): string {
  const today = parts(now, timeZone).key
  const until = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  const arrival = until(checkIn)
  if (arrival >= 2 && arrival <= 6) return `In ${arrival} days`
  if (arrival <= 0 && until(checkOut) === 1) return 'Check out tomorrow'
  return formatCalendarRange(checkIn, checkOut, LOCALE)
}

/** The first word of a name, which is what Airbnb and the inbox call a person. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0]
  if (!first) throw new Error('A person in a conversation has no name')
  return first
}

/** The letter in a person's circle. */
export function initial(name: string): string {
  const letter = [...name.trim()][0]
  if (!letter) throw new Error('A person in a conversation has no name')
  return letter.toUpperCase()
}

/**
 * Channex's message time. Channex sends a time with no zone; its messages land
 * here seconds after that time read as UTC (Derek's first message: provider
 * 01:13:26, mirrored 01:13:37Z), so a zone-free provider time is UTC. A time
 * with an offset is taken as given.
 */
export function providerInstant(value: string): string {
  const instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? new Date(value) : new Date(`${value.slice(0, 23)}Z`)
  if (!Number.isFinite(instant.getTime())) throw new Error(`The provider time ${value} is not a time`)
  return instant.toISOString()
}
