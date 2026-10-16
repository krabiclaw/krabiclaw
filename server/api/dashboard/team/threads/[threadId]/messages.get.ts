import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listTeamMessages, teamAccessFor } from '~/server/domain/team-messages'

// Newest first; before + beforeId page back from the oldest message loaded.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  const query = getQuery(event)
  return jsonResponse(await listTeamMessages(db, access, getRouterParam(event, 'threadId') ?? '', { limit: query.limit, before: query.before, beforeId: query.beforeId }))
})
