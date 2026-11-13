import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { getTeamThread, listTeamMessages } from '~/server/domain/team-messages'

// The conversation and its messages, newest first; before + before_id page back from the oldest message loaded.
// Reading writes nothing: opening it reads it through with POST …/conversations/:id/read.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = memberAccessPrincipal(organization, { env, event })
  const query = getQuery(event)
  const threadId = getRouterParam(event, 'conversation_id') ?? ''
  const [thread, page] = await Promise.all([
    getTeamThread(db, access, threadId),
    listTeamMessages(db, access, threadId, { limit: query.limit, before: query.before, before_id: query.before_id }),
  ])
  return jsonResponse({ thread, ...page })
})
