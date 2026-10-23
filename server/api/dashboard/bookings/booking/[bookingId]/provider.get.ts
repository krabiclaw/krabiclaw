import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { queryAll, queryFirst } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { providerUnavailableSql } from '~/server/utils/provider-allocation'
import { refreshMemberBusy } from '~/server/domain/member-scheduling'

/** Who could take this booking: every team member with working hours, and whether they're free then, by the same check the move makes. */
export default defineHandler(async event => {
  const { env, organization } = await getDashboardContext(event, {})
  const bookingId = getRouterParam(event, 'bookingId')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking required' })
  const booking = await queryFirst<{ id: string }>(env.DB, "SELECT id FROM bookings WHERE id=? AND organization_id=? AND status IN ('pending','confirmed')", [bookingId, organization.id])
  if (!booking) throw new HTTPError({ statusCode: 404, message: 'Live booking not found' })
  const scheduled = await queryAll<{ member_id: string }>(env.DB, 'SELECT member_id FROM member_scheduling WHERE organization_id=? AND timezone IS NOT NULL', [organization.id])
  for (const row of scheduled) await refreshMemberBusy(env.DB, env, row.member_id)
  const members = await queryAll<{ id: string; name: string; image: string | null; current: number; available: number }>(env.DB, `
    SELECT m.id, COALESCE(NULLIF(ms.public_name,''), u.name, u.email) name, COALESCE(ms.public_photo_url, u.image) image,
      m.id IS b.assigned_member_id current, NOT ${providerUnavailableSql('s', 'NULL', 'NULL', 'm.id')} available
    FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
      JOIN member m ON m.organizationId=b.organization_id JOIN user u ON u.id=m.userId
      JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId AND ms.timezone IS NOT NULL
    WHERE b.id=? AND b.organization_id=? ORDER BY current DESC, available DESC, name`, [bookingId, organization.id])
  return jsonResponse({ members: members.map(member => ({ ...member, current: Boolean(member.current), available: Boolean(member.available) })) })
})
