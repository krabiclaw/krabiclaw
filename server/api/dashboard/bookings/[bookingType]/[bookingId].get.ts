import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { isDashboardRecordType, loadDashboardBookingDetails } from '~/server/utils/dashboard-booking-details'
import { getNotificationAccess } from '~/server/utils/notification-access'
import { unreadScheduleNotificationIds } from '~/server/utils/notification-acknowledgement'

export default defineHandler(async (event) => {
  const bookingType = getRouterParam(event, 'bookingType')
  const bookingId = getRouterParam(event, 'bookingId')
  if (!isDashboardRecordType(bookingType) || !bookingId) {
    throw new HTTPError({ statusCode: 400, message: 'Valid booking type and ID are required' })
  }
  const access = await getNotificationAccess(event)
  const unreadNotificationIds = bookingType === 'booking' || bookingType === 'reservation'
    ? await unreadScheduleNotificationIds(access.db, access, bookingType, bookingId) : []
  const booking = await loadDashboardBookingDetails(event, { type: bookingType, bookingId })
  return jsonResponse({ booking, unreadNotificationIds })
})
