import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { getTeamThread, listTeamMessages, teamAccessFor } from '~/server/domain/team-messages'

// The conversation and its messages, newest first; before + beforeId page back from the oldest message loaded.
// Reading writes nothing: opening it reads it through with POST …/conversations/:id/read.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  const query = getQuery(event)
  const threadId = getRouterParam(event, 'threadId') ?? ''
  const thread = await getTeamThread(env, db, access, threadId)
  return jsonResponse({ thread, ...await listTeamMessages(db, access, threadId, { limit: query.limit, before: query.before, beforeId: query.beforeId }) })
})
