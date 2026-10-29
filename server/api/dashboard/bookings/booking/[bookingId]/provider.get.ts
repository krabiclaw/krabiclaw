import { addLocalDays, localDateAt } from '~/utils/timezone'
import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { queryAll, queryFirst } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertAssignedBookingAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { listSessions, materializeSessions, sessionAllocationPredicate } from '~/server/utils/availability'
import { refreshProductBusy } from '~/server/domain/member-scheduling'

/** Offer only attorneys with a canonical consultation at the existing time. */
export default defineHandler(async event => {
  const { env, organization, userId } = await getDashboardContext(event, {})
  const bookingId = getRouterParam(event, 'bookingId')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking required' })
  await assertAssignedBookingAccess(env.DB, { ...memberAccessPrincipal(organization, { env }), bookingId })
  const booking = await queryFirst<{ id: string; product_id: string; assigned_member_id: string | null; starts_at: string; ends_at: string; timezone: string; location_id: string | null; party_size: number }>(env.DB,
    "SELECT b.id,b.product_id,b.assigned_member_id,b.party_size,s.starts_at,s.ends_at,s.timezone,s.location_id FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id WHERE b.id=? AND b.organization_id=? AND b.status IN ('pending','confirmed')", [bookingId, organization.id])
  if (!booking) throw new HTTPError({ statusCode: 404, message: 'Live consultation not found' })
  await materializeSessions(env.DB, { organizationId: organization.id, productId: booking.product_id, actorId: userId, throughDate: addLocalDays(localDateAt(new Date(booking.starts_at), booking.timezone), 1) })
  await refreshProductBusy(env.DB, env, organization.id, booking.product_id)
  const sessions = (await listSessions(env.DB, { organizationId: organization.id, productId: booking.product_id, fromInstant: booking.starts_at, toInstant: new Date(Date.parse(booking.starts_at) + 1).toISOString() }))
    .filter(session => session.starts_at === booking.starts_at && session.ends_at === booking.ends_at && session.location_id === booking.location_id)
  const members = await queryAll<{ id: string; name: string; image: string | null; current: number }>(env.DB, `SELECT m.id,${MEMBER_NAME_SQL} name,COALESCE(ms.public_photo_url,u.image) image,m.id IS ? current
    FROM member m JOIN user u ON u.id=m.userId JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId
    WHERE m.organizationId=? AND (m.id=? OR (u.emailVerified=1 AND ms.public_approved=1 AND length(trim(ms.public_name))>0 AND m.id IN (SELECT value FROM json_each(?)))) ORDER BY current DESC,name`,
    [booking.assigned_member_id, organization.id, booking.assigned_member_id, JSON.stringify(sessions.flatMap(session => session.assigned_member_id ? [session.assigned_member_id] : []))])
  const candidates = []
  for (const member of members) {
    const targets = sessions.filter(session => session.assigned_member_id === member.id)
    let available = Boolean(member.current)
    if (!member.current && targets.length === 1) {
      const allocation = await sessionAllocationPredicate(env.DB, { organizationId: organization.id, productId: booking.product_id, sessionId: targets[0]!.id, partySize: booking.party_size, replacingBookingId: booking.id, now: new Date().toISOString() })
      available = Boolean(await queryFirst(env.DB, `SELECT 1 WHERE ${allocation.query}`, allocation.params))
    }
    candidates.push({ ...member, current: Boolean(member.current), available })
  }
  return jsonResponse({ members: candidates })
})
