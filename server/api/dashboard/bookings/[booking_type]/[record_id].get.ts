import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardPurchaseDetails } from '~/server/utils/dashboard-booking-details'

export default defineHandler(async (event) => {
  const bookingType = getRouterParam(event, 'booking_type')
  const bookingId = getRouterParam(event, 'record_id')
  if (bookingType !== 'payment' || !bookingId) {
    throw new HTTPError({ statusCode: 400, message: 'Valid booking type and ID are required' })
  }
  const booking = await loadDashboardPurchaseDetails(event, bookingId)
  return jsonResponse({ booking })
})
