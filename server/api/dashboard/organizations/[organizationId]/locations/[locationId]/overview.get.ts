import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardLocationOverview } from '~/server/utils/dashboard-editor-resources'

/**
 * The location hub's whole payload in one read.
 *
 * The page used to compose this client-side from three endpoints while the
 * server rendered it from `loadDashboardLocationOverview` — two assemblies of
 * the same screen that could disagree. Both now go through the loader.
 */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !locationId) throw new HTTPError({ statusCode: 400, statusMessage: 'Organization ID and Location ID are required' })
  return jsonResponse(await loadDashboardLocationOverview(event, organizationId, locationId))
})
