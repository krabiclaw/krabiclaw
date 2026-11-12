import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingContext } from '~/server/utils/dashboard-bookings'
import { listDashboardBookingChangeSessions } from '~/server/utils/dashboard-booking-details'
import { listStayMoveOptions } from '~/server/domain/stays'

export default defineHandler(async event => {
  const { db, access, bookingId, booking } = await dashboardBookingContext(event)
  const query = getQuery(event)
  const options = booking.unit === 'nights'
    ? await listStayMoveOptions(db, access, bookingId)
    : await listDashboardBookingChangeSessions(event, { bookingId, from: query.from, to: query.to, locationId: query.location_id })
  return jsonResponse({ options })
})
