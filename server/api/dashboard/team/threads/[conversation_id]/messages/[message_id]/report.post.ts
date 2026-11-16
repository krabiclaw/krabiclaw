import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { reportTeamMessage } from '~/server/domain/team-messages'
import { conversationIdParam } from '~/server/utils/conversation-request'

// POST /api/dashboard/team/threads/:threadId/messages/:messageId/report {reason, idempotency_key}
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = memberAccessPrincipal(organization, { env, event })
  const body = await readStrictBody<{ reason?: unknown; idempotency_key?: unknown }>(event, { reason: 'string', idempotency_key: 'string' })
  const report = await reportTeamMessage(env, db, access, conversationIdParam(event), getRouterParam(event, 'message_id') ?? '', { reason: body.reason, idempotency_key: body.idempotency_key })
  return jsonResponse({ report: { id: report.id, status: report.status } }, { status: 201 })
})
