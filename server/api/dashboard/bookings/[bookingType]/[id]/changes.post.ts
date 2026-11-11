import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { apiErrorResponse, jsonResponse } from '~/server/utils/api-response'
import { isDashboardBookingType, requestDashboardBookingChange } from '~/server/utils/dashboard-booking-details'

export default defineHandler(async (event) => {
  const bookingType = getRouterParam(event, 'bookingType')
  const bookingId = getRouterParam(event, 'id')
  if (!isDashboardBookingType(bookingType) || !bookingId) {
    throw new HTTPError({ statusCode: 400, message: 'Valid booking type and ID are required' })
  }
  try {
    const booking = await requestDashboardBookingChange(event, {
      type: bookingType,
      bookingId,
      body: await readBody(event),
    })
    return jsonResponse({ booking })
  } catch (error) {
    if (error instanceof HTTPError && error.statusCode < 500) return apiErrorResponse(event, error.statusCode, `HTTP_${error.statusCode}`, error.message)
    throw error
  }
})
