// GET /api/dashboard/locations/[id] — Fetch a single location for the workspace page
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardLocationContext } from '~/server/utils/dashboard-context'
import { parseLocationPayload } from '~/server/utils/location-payload'

export default defineHandler(async (event) => {
  const locationId = getRouterParam(event, 'id')
  if (!locationId) return jsonResponse({ error: 'Location ID required' }, { status: 400 })

  const { location } = await getDashboardLocationContext(event, locationId)

  return jsonResponse({
    success: true,
    location: parseLocationPayload(location),
  })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
