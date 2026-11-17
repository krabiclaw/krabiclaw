import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { getOrganizationMembersData, getStaffInviteScreen } from '~/server/utils/dashboard-members'

export default defineHandler(async (event) => {
  const { env, db, organization, userId } = await getDashboardMemberContext(event, {})
  if (getQuery(event).view === 'invite') return jsonResponse(await getStaffInviteScreen(env, db, organization), { headers: { 'cache-control': 'private, no-store' } })
  return jsonResponse(await getOrganizationMembersData(env, organization, userId))
})
