import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { acceptOpportunity } from '~/server/domain/opportunities'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, principal } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { assignedMemberId: 'nullable-string', assignedTeamId: 'nullable-string', dueAt: 'nullable-string' })
  return jsonResponse({ task: await acceptOpportunity(db, principal, routeId(event, 'opportunityId'), body) }, { status: 201 })
})
