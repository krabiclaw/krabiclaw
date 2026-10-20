import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listTeamThreads, teamAccessFor } from '~/server/domain/team-messages'

// The caller's team conversations, newest activity first.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  const query = getQuery(event)
  const locationId = typeof query.locationId === 'string' && query.locationId ? query.locationId : undefined
  const stayId = typeof query.stayId === 'string' && query.stayId ? query.stayId : undefined
  return jsonResponse({ threads: await listTeamThreads(env, db, access, { locationId, stayId }) })
})
