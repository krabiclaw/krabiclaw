import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingContext, dashboardBookingDetails, nightBooking } from '~/server/utils/dashboard-bookings'
import { assertStayRequestEditable, updateStay } from '~/server/domain/stays'
import { setBookingNote } from '~/server/domain/bookings'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async event => {
  const { db, env, access, organization, bookingId, booking, patchBody: body, stayEdit } = await dashboardBookingContext(event, 'update', true)
  if (!body) throw new HTTPError({ statusCode: 400, message: 'Request body is required', data: { code: 'INVALID_BODY', field: 'body' } })
  if (booking.unit === 'nights' && stayEdit) {
    return jsonResponse({ booking: nightBooking(await updateStay(db, env, access, bookingId, { ...body, version: body.version }, stayEdit)) })
  }
  if (booking.unit === 'nights') {
    if (!access.manage) throw new HTTPError({ statusCode: 403, message: 'Booking update access is required' })
    assertStayRequestEditable(booking)
  }
  if (stayEdit) throw new HTTPError({ statusCode: 422, message: 'Use the booking move action to change an appointment' })
  await setBookingNote(db, { organizationId: organization.id, bookingId }, body)
  await publishConversationEvent(env, db, { conversationId: booking.conversation_id, type: 'MESSAGE_UPDATE' })
  return jsonResponse(await dashboardBookingDetails(event))
})
