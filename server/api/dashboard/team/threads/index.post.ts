import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createTeamThread, teamAccessFor } from '~/server/domain/team-messages'

// Manual groups replay a caller's creation key; direct/contextual chats reuse their roster.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'send')
  const body = await readStrictBody<{ memberIds?: unknown; stayId?: unknown; locationId?: unknown; name?: unknown; idempotencyKey?: unknown }>(event, {
    memberIds: 'unknown',
    stayId: 'string',
    locationId: 'string',
    name: 'nullable-string',
    idempotencyKey: 'string',
  })
  const thread = await createTeamThread(env, db, access, {
    memberIds: body.memberIds,
    stayId: body.stayId,
    locationId: body.locationId,
    ...(body.name === undefined ? {} : { name: body.name }),
    idempotencyKey: body.idempotencyKey,
  })
  return jsonResponse({ id: thread.id }, { status: thread.created ? 201 : 200 })
})
