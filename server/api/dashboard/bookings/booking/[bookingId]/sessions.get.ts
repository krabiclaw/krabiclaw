import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { listDashboardBookingChangeSessions } from '~/server/utils/dashboard-booking-details'

// One day's sessions of a booking's offering, for changing that booking.
export default defineHandler(async (event) => {
  const bookingId = getRouterParam(event, 'bookingId')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  return jsonResponse({ sessions: await listDashboardBookingChangeSessions(event, { bookingId, date: getQuery(event).date }) })
})
