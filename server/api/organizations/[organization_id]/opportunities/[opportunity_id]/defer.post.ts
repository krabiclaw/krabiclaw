import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { deferOpportunity } from '~/server/domain/opportunities'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, principal } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { until: 'string' })
  return jsonResponse({ opportunity: await deferOpportunity(db, principal, routeId(event, 'opportunity_id'), body) })
})
