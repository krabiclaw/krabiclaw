import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { operateTeamGroup, type TeamGroupOperationInput } from '~/server/domain/team-messages'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = memberAccessPrincipal(organization, { env, event })
  const body = await readStrictBody<TeamGroupOperationInput>(event, {
    action: 'string', idempotency_key: 'string', name: 'nullable-string', member_user_ids: 'unknown', user_id: 'string',
  })
  return jsonResponse(await operateTeamGroup(env, db, access, getRouterParam(event, 'conversation_id') ?? '', body))
})
