import { defineHandler } from 'nitro'
import { releaseStayNights } from '~/server/domain/stays'
import { dashboardBookingContext, nightBooking } from '~/server/utils/dashboard-bookings'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'

export default defineHandler(async event => {
  const { db, env, access, bookingId } = await dashboardBookingContext(event, 'update')
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse({ booking: nightBooking(await releaseStayNights(db, env, access, bookingId, body)) })
})
