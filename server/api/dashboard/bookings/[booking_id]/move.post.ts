import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { dashboardBookingContext, dashboardBookingDetails, nightBooking } from '~/server/utils/dashboard-bookings'
import { changeBooking } from '~/server/domain/guest-threads/booking-changes'

export default defineHandler(async event => {
  const { db, env, access, organization, bookingId, userId } = await dashboardBookingContext(event)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const result = await changeBooking(db, env, {
    organizationId: organization.id, bookingId, actorUserId: userId, body, apply: body.apply !== false, stayAccess: access,
    idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined,
  })
  if (result.kind === 'stay') return jsonResponse({ booking: nightBooking(result.stay) })
  return jsonResponse({ ...await dashboardBookingDetails(event), change_status: result.changeStatus })
})
