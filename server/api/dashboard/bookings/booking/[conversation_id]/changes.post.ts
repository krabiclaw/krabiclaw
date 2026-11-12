import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { apiErrorResponse, jsonResponse } from '~/server/utils/api-response'
import { requestDashboardBookingChange } from '~/server/utils/dashboard-booking-details'

export default defineHandler(async (event) => {
  const conversationId = getRouterParam(event, 'conversation_id')
  if (!conversationId) {
    throw new HTTPError({ statusCode: 400, message: 'Conversation ID is required' })
  }
  try {
    const booking = await requestDashboardBookingChange(event, {
      type: 'booking',
      bookingId: conversationId,
      body: await readBody(event),
    })
    return jsonResponse({ booking })
  } catch (error) {
    if (error instanceof HTTPError && error.statusCode < 500) return apiErrorResponse(event, error.statusCode, `HTTP_${error.statusCode}`, error.message)
    throw error
  }
})
