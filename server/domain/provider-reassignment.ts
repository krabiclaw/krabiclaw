import { addLocalDays, localDateAt } from '~/utils/timezone'
import { HTTPError } from 'nitro'
import { queryFirst } from '~/server/db'
import { sessionMemberSql } from '~/server/utils/provider-allocation'
import { listSessions, materializeSessions } from '~/server/utils/availability'
import { requireSchedulingAccess, refreshMemberBusy, type SchedulingActor } from './member-scheduling'
import { getGuestRequest } from './requests'
import { requestBookingChange } from './guest-threads/booking-changes'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'

/** One client's attorney changes only after that client accepts the conversation proposal. */
export async function reassignBookingProvider(actor: SchedulingActor, input: { booking_id: string; member_id: string; expected_updated_at: string; idempotency_key: string }) {
  if (!input || (['booking_id', 'member_id', 'expected_updated_at', 'idempotency_key'] as const).some(field => typeof input[field] !== 'string' || !input[field]) || input.idempotency_key.length > 120) throw new HTTPError({ statusCode: 400, message: 'Booking, member, current revision and durable request key are required' })
  await requireSchedulingAccess(actor, input.member_id, true)
  const db = actor.env.DB
  const booking = await queryFirst<{ id: string; request_id: string | null; product_session_id: string; product_id: string; party_size: number; assigned_member_id: string | null; updated_at: string; starts_at: string; ends_at: string; timezone: string; location_id: string | null }>(db,
    "SELECT b.*,s.starts_at,s.ends_at,s.timezone,s.location_id FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id WHERE b.id=? AND b.organization_id=? AND b.status IN ('pending','confirmed')", [input.booking_id, actor.organizationId])
  if (!booking?.request_id) throw new HTTPError({ statusCode: 404, message: 'Live consultation with a client conversation not found' })
  const thread = await getGuestRequest(db, booking.request_id, actor.organizationId, 'booking')
  if (!thread) throw new HTTPError({ statusCode: 404, message: 'Consultation conversation not found' })
  const key = `provider:${actor.organizationId}:${input.idempotency_key}`
  const prior = await queryFirst<{ payload_json: string; actor_user_id: string | null }>(db, 'SELECT payload_json,actor_user_id FROM activity_entries WHERE dedupe_key=?', [`booking-change-request:${thread.id}:${key}`])
  let sessionId: string
  let partySize = booking.party_size
  let expectedUpdatedAt: string
  if (prior) {
    const proposal = JSON.parse(prior.payload_json)
    if (proposal.before.recordId !== booking.id || proposal.after.assignedMemberId !== input.member_id || prior.actor_user_id !== actor.userId || proposal.before.operationalUpdatedAt !== input.expected_updated_at) throw new HTTPError({ statusCode: 409, message: 'Request key belongs to a different attorney change' })
    partySize = proposal.after.partySize
    sessionId = proposal.after.sessionId
    expectedUpdatedAt = proposal.updatedAt
  } else {
    if (booking.updated_at !== input.expected_updated_at) throw new HTTPError({ statusCode: 409, message: 'The consultation changed. Reload before requesting an attorney change.' })
    if (booking.assigned_member_id === input.member_id) throw new HTTPError({ statusCode: 409, message: 'This consultation is already with that attorney' })
    const config = await queryFirst(db, "SELECT 1 FROM product_booking_configs WHERE organization_id=? AND product_id=? AND scheduling_mode='provider'", [actor.organizationId, booking.product_id])
    if (!config) throw new HTTPError({ statusCode: 409, message: 'This consultation is not scheduled with an attorney' })
    await refreshMemberBusy(db, actor.env, input.member_id, true)
    await materializeSessions(db, { organizationId: actor.organizationId, productId: booking.product_id, actorId: actor.userId, throughDate: addLocalDays(localDateAt(new Date(booking.starts_at), booking.timezone), 1) })
    const sessions = await listSessions(db, { organizationId: actor.organizationId, productId: booking.product_id, fromInstant: booking.starts_at, toInstant: new Date(Date.parse(booking.starts_at) + 1).toISOString() })
    const target = sessions.filter(session => session.starts_at === booking.starts_at && session.ends_at === booking.ends_at && session.location_id === booking.location_id && session.assigned_member_id === input.member_id)
    if (target.length !== 1) throw new HTTPError({ statusCode: 409, message: 'That attorney has no available consultation at this time. Choose a published consultation time.' })
    sessionId = target[0]!.id
    expectedUpdatedAt = thread.updated_at
  }
  const result = await requestBookingChange(db, actor.env, thread, actor.userId, { kind: 'booking', sessionId, assignedMemberId: input.member_id, partySize, expectedUpdatedAt, expectedOperationalUpdatedAt: input.expected_updated_at }, key)
  await publishGuestInboxThreadEvent(actor.env, db, { threadId: thread.id, type: 'thread.changed' })
  const current = await queryFirst<{ session_id: string; assigned_member_id: string | null }>(db, `SELECT b.product_session_id session_id,b.assigned_member_id FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND ${sessionMemberSql('s')} IS b.assigned_member_id WHERE b.id=? AND b.organization_id=?`, [booking.id, actor.organizationId])
  if (!current) throw new HTTPError({ statusCode: 409, message: 'The consultation assignment could not be read back' })
  return { ...current, request_id: thread.id, change_status: result.changeStatus }
}
