import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { isDashboardRecordType, loadDashboardBookingDetails } from '~/server/utils/dashboard-booking-details'

export default defineHandler(async (event) => {
  const bookingType = getRouterParam(event, 'booking_type')
  const bookingId = getRouterParam(event, 'record_id')
  if (!isDashboardRecordType(bookingType) || bookingType === 'booking' || !bookingId) {
    throw new HTTPError({ statusCode: 400, message: 'Valid booking type and ID are required' })
  }
  const booking = await loadDashboardBookingDetails(event, { type: bookingType, bookingId })
  return jsonResponse({ booking })
})
