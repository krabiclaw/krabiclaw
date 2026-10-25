import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { reportTeamMessage, teamAccessFor } from '~/server/domain/team-messages'

// POST /api/dashboard/team/threads/:threadId/messages/:messageId/report {reason, idempotencyKey}
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await teamAccessFor(memberAccessPrincipal(organization, { env, event }), organization.memberId, 'read')
  const body = await readStrictBody<{ reason?: unknown; idempotencyKey?: unknown }>(event, { reason: 'string', idempotencyKey: 'string' })
  const report = await reportTeamMessage(env, db, access, getRouterParam(event, 'threadId') ?? '', getRouterParam(event, 'messageId') ?? '', { reason: body.reason, idempotencyKey: body.idempotencyKey })
  return jsonResponse({ report: { id: report.id, status: report.status } }, { status: 201 })
})
