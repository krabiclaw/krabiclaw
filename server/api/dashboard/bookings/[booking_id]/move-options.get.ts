import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingContext } from '~/server/utils/dashboard-bookings'
import { listDashboardBookingChangeSessions } from '~/server/utils/dashboard-booking-details'

/** The sessions a booked visit can change to; a stay changes its dates in its change step. */
export default defineHandler(async event => {
  const { bookingId, booking } = await dashboardBookingContext(event, 'update')
  if (booking.unit === 'nights') throw new HTTPError({ statusCode: 404, message: 'A stay has no sessions to change to', data: { code: 'BOOKING_CHANGE_OPTIONS_NOT_FOUND', field: 'booking_id' } })
  const query = getQuery(event)
  return jsonResponse({ options: await listDashboardBookingChangeSessions(event, { bookingId, from: query.from, to: query.to, locationId: query.location_id }) })
})
