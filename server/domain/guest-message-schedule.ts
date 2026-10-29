import { HTTPError } from 'nitro'
import { addLocalDays, isValidCalendarDate, isValidTimezone, localDateAt, localDateTimeToInstant, MINUTE_TIME_PATTERN } from '~/utils/timezone'

export type GuestMessageSchedule = {
  trigger: 'booking_received'
  delayMinutes: 5
  productIds: string[]
} | {
  trigger: 'check_in' | 'check_out'
  offsetDays: number
  localTime: string
  productIds: string[]
}

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
  if (value === null || value === undefined) messagingError(422, 'MESSAGE_SCHEDULE_REQUIRED', 'An automatic message needs a schedule: when it is sent, and to which homes', 'schedule')
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Provide a schedule object', 'schedule')
  const schedule = value as Record<string, unknown>
  if (schedule.trigger !== 'booking_received' && schedule.trigger !== 'check_in' && schedule.trigger !== 'check_out') invalid('Choose booking_received, check_in, or check_out', 'schedule.trigger')
  if (!Array.isArray(schedule.productIds) || schedule.productIds.length < 1 || schedule.productIds.length > 100
    || schedule.productIds.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())) {
    invalid('Select 1 to 100 canonical home product IDs', 'schedule.productIds')
  }
  const productIds = schedule.productIds as string[]
  if (new Set(productIds).size !== productIds.length) invalid('Select each home only once', 'schedule.productIds')
  if (schedule.trigger === 'booking_received') {
    if (schedule.delayMinutes !== 5 || Object.keys(schedule).some(key => !['trigger', 'delayMinutes', 'productIds'].includes(key))) {
      invalid('New-reservation messages send 5 minutes after KrabiClaw receives an eligible new reservation', 'schedule.delayMinutes')
    }
    return { trigger: 'booking_received', delayMinutes: 5, productIds }
  }
  if (typeof schedule.offsetDays !== 'number' || !Number.isInteger(schedule.offsetDays) || schedule.offsetDays < -7 || schedule.offsetDays > 7) invalid('Choose from 7 days before through 7 days after the stay date', 'schedule.offsetDays')
  if (typeof schedule.localTime !== 'string' || !MINUTE_TIME_PATTERN.test(schedule.localTime)) invalid('Provide a local 24-hour HH:mm time', 'schedule.localTime')
  if (Object.keys(schedule).some(key => !['trigger', 'offsetDays', 'localTime', 'productIds'].includes(key))) invalid('The schedule contains unsupported fields', 'schedule')
  return { trigger: schedule.trigger as 'check_in' | 'check_out', offsetDays: schedule.offsetDays as number, localTime: schedule.localTime as string, productIds }
}

/** The installed date library owns timezone conversion and DST rejection. */
export function guestMessageDueAt(schedule: Exclude<GuestMessageSchedule, { trigger: 'booking_received' }>, stay: { check_in_date: string; check_out_date: string }, timezone: string): string {
  const source = schedule.trigger === 'check_in' ? stay.check_in_date : stay.check_out_date
  if (!isValidCalendarDate(source)) messagingError(500, 'INVALID_STAY_DATE', 'The stay has an invalid calendar date', `stay.${schedule.trigger}_date`)
  if (!isValidTimezone(timezone) || /^[+-]/.test(timezone)) messagingError(500, 'INVALID_HOME_TIMEZONE', 'Scheduled messages require the home’s IANA timezone', 'home.timezone')
  const day = addLocalDays(source, schedule.offsetDays)
  try {
    return localDateTimeToInstant(day, schedule.localTime, timezone, 'reject').toISOString()
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    const earlier = localDateTimeToInstant(day, schedule.localTime, timezone, 'earlier')
    const repeated = localDateAt(earlier, timezone) === day
      && new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(earlier) === schedule.localTime
    messagingError(422, repeated ? 'SCHEDULE_TIME_IS_AMBIGUOUS' : 'SCHEDULE_TIME_DOES_NOT_EXIST',
      `${schedule.localTime} ${repeated ? 'occurs twice' : 'does not exist'} on ${day} in ${timezone}; choose another time`, 'schedule.localTime')
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
  const hasMore = rows.length > query.limit
  return { items: rows.slice(0, query.limit), pagination: { ...query, hasMore, nextOffset: hasMore ? query.offset + query.limit : null } }
}
