import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { listOpportunities } from '~/server/domain/opportunities'
import { taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, principal } = await taskRouteContext(event)
  const query = getQuery(event)
  const locationId = typeof query.locationId === 'string' && query.locationId ? query.locationId : undefined
  return jsonResponse(await listOpportunities(db, principal, { locationId }), { headers: { 'cache-control': 'private, no-store' } })
})
