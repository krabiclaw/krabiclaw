import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardLocationQa } from '~/server/utils/dashboard-editor-resources'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const locationId = getRouterParam(event, 'location_id')
  if (!organizationId || !locationId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  return jsonResponse(await loadDashboardLocationQa(event, organizationId, locationId))
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
