import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { prepareDashboardQa } from '~/server/utils/location-qa'


export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const locationId = getRouterParam(event, 'location_id')
  if (!organizationId || !locationId) return jsonResponse({ error: 'Missing params' }, { status: 400 })
  const qa = prepareDashboardQa(locationId, getQuery(event))
  const { rows } = await readDashboardMemberResources(event, organizationId, qa.queries)
  return jsonResponse(qa.read(rows))
})
