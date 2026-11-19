import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingCalendar, readCalendarPlacePresence } from '~/server/utils/dashboard-bookings'

export default defineHandler(async event => {
  const query = getQuery(event)
  return jsonResponse(await (query.view === 'scope' ? readCalendarPlacePresence(event) : dashboardBookingCalendar(event, query)))
})
