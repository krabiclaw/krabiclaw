import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingContext, nightBooking } from '~/server/utils/dashboard-bookings'
import { assertStayRequestEditable, updateStay } from '~/server/domain/stays'
import { setBookingNote } from '~/server/domain/bookings'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { timeRequestPhase } from '~/server/utils/request-metrics'

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
  const saved = await setBookingNote(db, { organizationId: organization.id, bookingId }, body)
  await timeRequestPhase(event, 'booking_broadcast', () => publishConversationEvent(env, db, {
    conversationId: booking.conversation_id,
    type: 'MESSAGE_UPDATE',
    conversation: { id: booking.conversation_id, organization_id: organization.id, location_id: booking.conversation_location_id, kind: 'booking' },
  }))
  return jsonResponse({ booking: saved })
})
