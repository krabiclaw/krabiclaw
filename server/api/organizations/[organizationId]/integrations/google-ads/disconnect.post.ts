import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { releaseIntegration } from '~/server/utils/integration-release'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, organization } = await requireOrganizationAccess(event, organizationId)
  const result = await releaseIntegration(env, organization.id, 'google-ads')

  return jsonResponse({ success: true, ...result })
})
