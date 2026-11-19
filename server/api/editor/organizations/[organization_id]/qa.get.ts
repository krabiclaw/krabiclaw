import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { prepareDashboardQa } from '~/server/utils/location-qa'
import { requireWebsiteAccess } from '~/server/utils/tenant-pages-api'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const qa = prepareDashboardQa(null, getQuery(event))
  const { rows } = await requireWebsiteAccess(event, organizationId, qa.queries)
  return jsonResponse(qa.read(rows))
})
