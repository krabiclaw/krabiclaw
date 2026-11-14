import { parseDate } from '@internationalized/date'
import { isValidCalendarDate, localNow } from '~/utils/timezone'
import type { BookableSession } from '~/server/utils/availability'
import { PRODUCT_SESSION_STATUSES } from '~/shared/bookings'
import { isRecord } from '~/utils/api-clients'

export function isSessionAvailability(value: unknown): value is BookableSession {
  return isRecord(value)
    && ['id', 'organization_id', 'product_id', 'timezone', 'starts_at', 'ends_at'].every(field => typeof value[field] === 'string')
    && ['location_id', 'availability_rule_id', 'source_occurrence_key', 'created_at', 'updated_at', 'created_by', 'updated_by'].every(field => value[field] === null || typeof value[field] === 'string')
    && typeof value.status === 'string' && (PRODUCT_SESSION_STATUSES as readonly string[]).includes(value.status)
    && (value.capacity === null || Number.isSafeInteger(value.capacity))
    && (value.remaining === null || Number.isSafeInteger(value.remaining))
    && Number.isSafeInteger(value.claimed) && typeof value.is_full === 'boolean'
}

export function isSessionResponse(value: unknown): value is { success: true; session: BookableSession } {
  return isRecord(value) && value.success === true && isSessionAvailability(value.session)
}

export function isSessionsResponse(value: unknown): value is { success: true; sessions: BookableSession[] } {
  return isRecord(value) && value.success === true && Array.isArray(value.sessions) && value.sessions.every(isSessionAvailability)
}

export function sessionCalendarMonth(month: string) {
  if (!isValidCalendarDate(`${month}-01`)) throw new Error('Choose a valid calendar month')
  const first = parseDate(`${month}-01`)
  const next = first.add({ months: 1 })
  return {
    previous: first.subtract({ months: 1 }).toString().slice(0, 7),
    next: next.toString().slice(0, 7),
    from: first.subtract({ days: 1 }).toDate('UTC').toISOString(),
    to: next.add({ days: 1 }).toDate('UTC').toISOString(),
    labelStart: first.toString(),
    dayOf(session: Pick<BookableSession, 'starts_at' | 'timezone'>) {
      const day = localNow(session.timezone, new Date(session.starts_at)).date
      return day.startsWith(`${month}-`) ? day : null
    },
  }
}
