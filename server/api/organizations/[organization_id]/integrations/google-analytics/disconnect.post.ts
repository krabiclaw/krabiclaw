import { jsonResponse } from '~/server/utils/api-response'
import { releaseIntegration } from '~/server/utils/integration-release'
import { requireOrganizationAccess } from '~/server/utils/location-access'

// One shape for every product: authorize, then hand the whole removal to the
// shared release path.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, organization} = await requireOrganizationAccess(event, organizationId)
  const result = await releaseIntegration(env, organization.id, 'google-analytics')

  return jsonResponse({ success: true, ...result })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
