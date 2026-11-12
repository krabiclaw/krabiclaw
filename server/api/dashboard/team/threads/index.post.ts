import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createTeamThread, teamAccessFor, type TeamConversationInput } from '~/server/domain/team-messages'

// Manual groups replay a caller's creation key; direct/contextual chats reuse their roster.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'send')
  const body = await readStrictBody<TeamConversationInput>(event, {
    member_user_ids: 'unknown',
    booking_id: 'string',
    location_id: 'string',
    name: 'nullable-string',
    idempotency_key: 'string',
  })
  const thread = await createTeamThread(env, db, access, body)
  return jsonResponse({ conversation_id: thread.id }, { status: thread.created ? 201 : 200 })
})
