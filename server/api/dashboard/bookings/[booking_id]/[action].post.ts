import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody, readStrictBody } from '~/server/utils/api-response'
import { dashboardBookingContext, dashboardBookingDetails, nightBooking } from '~/server/utils/dashboard-bookings'
import { executeBookingStatus } from '~/server/domain/guest-threads/operations'
import { respondToStayChangeRequest } from '~/server/domain/guest-threads/stay-change-requests'
import { assertConversationAccess } from '~/server/domain/conversations'
import { roleAllows } from '~/server/utils/member-access'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async event => {
  const action = getRouterParam(event, 'action')
  const stayChange = action === 'accept_change' || action === 'decline_change'
  if (!stayChange && action !== 'confirm' && action !== 'reject' && action !== 'cancel' && action !== 'no_show') throw new HTTPError({ statusCode: 404, message: 'Booking action not found' })
  const context = await dashboardBookingContext(event)
  const { db, env, organization, userId, access, principal, bookingId, booking } = context
  if (booking.unit === 'nights' && !access.manage) {
    throw new HTTPError({ statusCode: 403, message: 'Only organization owners and admins can change stays', data: { code: 'STAY_ROLE_REQUIRED' } })
  }
  if (stayChange) {
    if (booking.unit !== 'nights') throw new HTTPError({ statusCode: 404, message: 'Booking action not found' })
    const thread = await assertConversationAccess(db, principal, booking.conversation_id, true)
    if (thread.booking_id !== bookingId) throw new HTTPError({ statusCode: 404, message: 'Booking conversation not found' })
    const { message_id: messageId } = await readStrictBody<{ message_id?: string }>(event, { message_id: 'string' })
    if (!messageId?.trim()) {
      throw new HTTPError({ statusCode: 400, message: 'Name the change request to answer', data: { code: 'VALIDATION_ERROR', field: 'message_id' } })
    }
    await respondToStayChangeRequest(db, env, { thread, requestId: messageId, decision: action === 'accept_change' ? 'accept' : 'decline', actorUserId: userId })
    return new Response(null, { status: 204 })
  }
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const { version } = body
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new HTTPError({ statusCode: 400, message: 'Booking version is required' })
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : event.req.headers.get('idempotency-key') ?? undefined
  const result = await executeBookingStatus(db, {
    bookingId, version, organizationId: organization.id, threadId: booking.conversation_id, actorUserId: userId, action, idempotencyKey, env, stayAccess: access,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    financialAuthorizationId: typeof body.authorization_id === 'string' ? body.authorization_id : undefined,
    financialWritesAllowed: await roleAllows({ ...principal, permissions: { payments: ['refund'] } }),
  })
  if (result.kind === 'stay') return jsonResponse({ booking: nightBooking(result.stay) })
  const { outcome } = result
  if (outcome.ok || outcome.reason === 'delivery_failed') {
    await publishConversationEvent(env, db, { conversationId: booking.conversation_id, type: 'MESSAGE_CREATE' })
  }
  if (outcome.ok) return jsonResponse(await dashboardBookingDetails(event))
  if (outcome.reason === 'delivery_failed') return jsonResponse({ ...outcome, error: outcome.message }, { status: outcome.status })
  const code = 'code' in outcome ? outcome.code : outcome.reason.toUpperCase()
  return jsonResponse({ code, error: 'message' in outcome ? outcome.message : outcome.reason }, { status: outcome.status })
})
