import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createTeamThread, teamAccessFor } from '~/server/domain/team-messages'

// Start a conversation, or reuse the one with exactly these members about the same stay.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'send')
  const body = await readStrictBody<{ memberIds?: unknown; stayId?: unknown }>(event, { memberIds: 'unknown', stayId: 'string' })
  const thread = await createTeamThread(env, db, access, { memberIds: body.memberIds, stayId: body.stayId })
  return jsonResponse({ id: thread.id }, { status: thread.created ? 201 : 200 })
})
