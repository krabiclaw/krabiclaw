import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { operateTeamGroup, teamAccessFor, type TeamGroupOperationInput } from '~/server/domain/team-messages'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'send')
  const body = await readStrictBody<TeamGroupOperationInput>(event, {
    action: 'string', idempotencyKey: 'string', name: 'nullable-string', memberIds: 'unknown', userId: 'string',
  })
  return jsonResponse(await operateTeamGroup(env, db, access, getRouterParam(event, 'threadId') ?? '', body))
})
