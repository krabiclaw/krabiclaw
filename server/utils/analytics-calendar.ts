import { HTTPError } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'

import { isValidCalendarDate, addLocalDays, localDateAt, localDateTimeToInstant } from '~/utils/timezone'

export function localDateBounds(date: string, timeZone: string) {
  return {
    start: localDateTimeToInstant(date, '00:00', timeZone, 'compatible').toISOString(),
    end: localDateTimeToInstant(addLocalDays(date, 1), '00:00', timeZone, 'compatible').toISOString(),
  }
}

function enumerateLocalDates(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let date = startDate; date <= endDate; date = addLocalDays(date, 1)) dates.push(date)
  return dates
}

export function parseAnalyticsRange(input: {
  startDate?: string
  endDate?: string
  timeZone: string
  now: Date
}): { startDate: string; endDate: string; dates: string[]; previousStartDate: string; previousEndDate: string } {
  const today = localDateAt(input.now, input.timeZone)
  const endDate = input.endDate ?? today
  if (!isValidCalendarDate(endDate)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'endDate must be a valid YYYY-MM-DD date' })
  }
  const startDate = input.startDate ?? addLocalDays(endDate, -29)
  if (!isValidCalendarDate(startDate)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'startDate must be a valid YYYY-MM-DD date' })
  }
  if (startDate > endDate) throw new HTTPError({ statusCode: 400, statusMessage: 'startDate must not be after endDate' })
  const dates = enumerateLocalDates(startDate, endDate)
  if (dates.length > 365) throw new HTTPError({ statusCode: 400, statusMessage: 'Date range exceeds the 365-day maximum' })
  return {
    startDate,
    endDate,
    dates,
    previousStartDate: addLocalDays(startDate, -dates.length),
    previousEndDate: addLocalDays(startDate, -1),
  }
}

/** The organization's analytics calendar: the clock its days are counted in and when its visits began to be recorded. */
export async function resolveOrganizationAnalyticsContext(db: DbClient, organizationId: string): Promise<{ organizationId: string; timezone: string; analyticsDataStartAt: string | null }> {
  const row = await queryFirst<{ id: string; analytics_data_start_at: string | null; timezone: string }>(db, 'SELECT id, analytics_data_start_at, timezone FROM organization WHERE id = ? LIMIT 1', [organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return { organizationId: row.id, timezone: row.timezone, analyticsDataStartAt: row.analytics_data_start_at }
}
