import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listTeamMembers, teamAccessFor } from '~/server/domain/team-messages'

// Everyone a member can start a team conversation with, the caller included.
export default defineHandler(async (event) => {
  const { env, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  return jsonResponse({ members: await listTeamMembers(env, access) })
})
