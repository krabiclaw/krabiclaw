import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { dashboardBookingContext, dashboardBookingDetails, nightBooking } from '~/server/utils/dashboard-bookings'
import { updateStay } from '~/server/domain/stays'
import { setBookingNote } from '~/server/domain/bookings'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async event => {
  const { db, env, access, organization, bookingId, booking } = await dashboardBookingContext(event)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  if (booking.unit === 'nights' && Object.keys(body).some(field => field !== 'version' && field !== 'private_notes')) {
    return jsonResponse({ booking: nightBooking(await updateStay(db, env, access, bookingId, { ...body, version: body.version })) })
  }
  if (booking.unit === 'nights' && !access.manage) throw new HTTPError({ statusCode: 403, message: 'Booking update access is required' })
  if (Object.keys(body).some(field => field !== 'version' && field !== 'private_notes')) throw new HTTPError({ statusCode: 422, message: 'Use the booking move action to change an appointment' })
  await setBookingNote(db, { organizationId: organization.id, bookingId }, body)
  await publishConversationEvent(env, db, { conversationId: booking.conversation_id, type: 'MESSAGE_UPDATE' })
  return jsonResponse(await dashboardBookingDetails(event))
})
