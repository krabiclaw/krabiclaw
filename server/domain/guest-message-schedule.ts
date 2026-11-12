import { HTTPError } from 'nitro'
import { addLocalDays, isValidCalendarDate, isValidInstant, isValidTimezone, localDateAt, localDateTimeToInstant, MINUTE_TIME_PATTERN } from '~/utils/timezone'

/**
 * When an automatic message is sent, and for which offerings. check_in and
 * check_out are the start and end of whatever was booked: a stay's first and
 * last day, a consultation's, class's or table's start and end. offset_days and
 * local_time name a day and a clock time there; offset_hours counts from the
 * instant itself. product_ids names the booked offerings by product: a home, an
 * experience, a consultation or a restaurant's tables (BOOKING_RECORDS_SQL
 * offering_id).
 */
export type GuestMessageSchedule = ({
  trigger: 'booking_received'
  delay_minutes: 5
} | {
  trigger: 'check_in' | 'check_out'
  offset_days: number
  local_time: string
} | {
  trigger: 'check_in' | 'check_out'
  offset_hours: number
}) & { product_ids: string[] }

export function messagingError(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, message, data: { code, field } })
}

export function messageText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    messagingError(422, 'INVALID_MESSAGING_FIELD', `${field} must contain 1 to ${maximum} characters`, field)
  }
  return value.trim()
}

/**
 * An automatic message's schedule. A write must name one; a stored row read
 * back without one is returned as null for its reader to refuse.
 */
export function parseGuestMessageSchedule(value: unknown, stored = false): GuestMessageSchedule | null {
  const invalid = (message: string, field: string): never => messagingError(stored ? 500 : 422, stored ? 'INVALID_MESSAGE_TEMPLATE' : 'INVALID_MESSAGING_FIELD', message, field)
  if (value === null && stored) return null
  if (value === null || value === undefined) messagingError(422, 'MESSAGE_SCHEDULE_REQUIRED', 'An automatic message needs a schedule: when it is sent, and for which offerings', 'schedule')
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Provide a schedule object', 'schedule')
  const schedule = value as Record<string, unknown>
  if (schedule.trigger !== 'booking_received' && schedule.trigger !== 'check_in' && schedule.trigger !== 'check_out') invalid('Choose booking_received, check_in, or check_out', 'schedule.trigger')
  const ids = schedule.product_ids as unknown[]
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())) invalid('Select 1 to 100 offerings', 'schedule.product_ids')
  if (new Set(ids).size !== ids.length) invalid('Select each offering only once', 'schedule.product_ids')
  const scope = { product_ids: ids as string[] }
  const only = (keys: string[]) => { if (Object.keys(schedule).some(key => ![...keys, 'trigger', 'product_ids'].includes(key))) invalid('The schedule contains unsupported fields', 'schedule') }
  if (schedule.trigger === 'booking_received') {
    if (schedule.delay_minutes !== 5) invalid('New-booking messages send 5 minutes after KrabiClaw receives an eligible new booking', 'schedule.delay_minutes')
    only(['delay_minutes'])
    return { trigger: 'booking_received', delay_minutes: 5, ...scope }
  }
  const trigger = schedule.trigger as 'check_in' | 'check_out'
  if ('offset_hours' in schedule) {
    if (typeof schedule.offset_hours !== 'number' || !Number.isInteger(schedule.offset_hours) || schedule.offset_hours < -72 || schedule.offset_hours > 72) invalid('Choose from 72 hours before through 72 hours after', 'schedule.offset_hours')
    only(['offset_hours'])
    return { trigger, offset_hours: schedule.offset_hours as number, ...scope }
  }
  if (typeof schedule.offset_days !== 'number' || !Number.isInteger(schedule.offset_days) || schedule.offset_days < -7 || schedule.offset_days > 7) invalid('Choose from 7 days before through 7 days after', 'schedule.offset_days')
  if (typeof schedule.local_time !== 'string' || !MINUTE_TIME_PATTERN.test(schedule.local_time)) invalid('Provide a local 24-hour HH:mm time', 'schedule.local_time')
  only(['offset_days', 'local_time'])
  return { trigger, offset_days: schedule.offset_days as number, local_time: schedule.local_time as string, ...scope }
}

/**
 * The start or end a schedule counts from: its local calendar day, and its
 * instant when the booking has one (a stay's needs its home's check-in or
 * checkout time).
 */
export interface ScheduleAnchor { date: string; instant: string | null }

/** The installed date library owns timezone conversion and DST rejection. */
export function guestMessageDueAt(schedule: Exclude<GuestMessageSchedule, { trigger: 'booking_received' }>, anchors: { check_in: ScheduleAnchor; check_out: ScheduleAnchor }, timezone: string): string {
  const anchor = anchors[schedule.trigger]
  if (!isValidTimezone(timezone) || /^[+-]/.test(timezone)) messagingError(500, 'INVALID_HOME_TIMEZONE', 'Scheduled messages require the booking’s IANA timezone', 'timezone')
  if ('offset_hours' in schedule) {
    if (anchor.instant === null) {
      messagingError(422, schedule.trigger === 'check_in' ? 'CHECK_IN_TIME_REQUIRED' : 'CHECK_OUT_TIME_REQUIRED',
        `Set the home’s ${schedule.trigger === 'check_in' ? 'check-in' : 'checkout'} time to send a message hours ${schedule.offset_hours < 0 ? 'before' : 'after'} it`, schedule.trigger === 'check_in' ? 'home.check_in_time' : 'home.check_out_time')
    }
    if (!isValidInstant(anchor.instant)) messagingError(500, 'INVALID_BOOKING_TIME', 'The booking has an invalid start or end time', schedule.trigger)
    return new Date(Date.parse(anchor.instant) + schedule.offset_hours * 3_600_000).toISOString()
  }
  if (!isValidCalendarDate(anchor.date)) messagingError(500, 'INVALID_STAY_DATE', 'The booking has an invalid calendar date', schedule.trigger)
  const day = addLocalDays(anchor.date, schedule.offset_days)
  try {
    return localDateTimeToInstant(day, schedule.local_time, timezone, 'reject').toISOString()
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    const earlier = localDateTimeToInstant(day, schedule.local_time, timezone, 'earlier')
    const repeated = localDateAt(earlier, timezone) === day
      && new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(earlier) === schedule.local_time
    messagingError(422, repeated ? 'SCHEDULE_TIME_IS_AMBIGUOUS' : 'SCHEDULE_TIME_DOES_NOT_EXIST',
      `${schedule.local_time} ${repeated ? 'occurs twice' : 'does not exist'} on ${day} in ${timezone}; choose another time`, 'schedule.local_time')
  }
}

export interface MessageListQuery { limit: number; offset: number }

export function parseMessageListQuery(query: Record<string, unknown>, allowed: readonly string[] = []): MessageListQuery {
  const unsupported = Object.keys(query).find(key => !['org', 'limit', 'offset', ...allowed].includes(key))
  if (unsupported) messagingError(400, 'INVALID_MESSAGING_QUERY', `Unsupported query parameter: ${unsupported}`, unsupported)
  const integer = (field: 'limit' | 'offset', minimum: number, maximum: number): number => {
    const value = query[field]
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
      messagingError(400, 'INVALID_MESSAGING_QUERY', `${field} must be an integer from ${minimum} to ${maximum}`, field)
    }
    return Number(value)
  }
  return { limit: integer('limit', 1, 100), offset: integer('offset', 0, Number.MAX_SAFE_INTEGER) }
}

export function messageListPage<T>(rows: T[], query: MessageListQuery) {
  const has_more = rows.length > query.limit
  return { items: rows.slice(0, query.limit), pagination: { ...query, has_more, next_offset: has_more ? query.offset + query.limit : null } }
}
