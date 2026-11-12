import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { dismissOpportunity } from '~/server/domain/opportunities'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, principal } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { note: 'nullable-string' })
  return jsonResponse({ opportunity: await dismissOpportunity(db, principal, routeId(event, 'opportunity_id'), body) })
})
