import { jsonResponse } from '~/server/utils/api-response'
import { getOrganizationDomainsDashboardPayload } from '~/server/utils/domain-read-model'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { db } = await requireOrganizationAccess(event, organizationId)

  const payload = await getOrganizationDomainsDashboardPayload(db, organizationId)

  return jsonResponse({ success: true, ...payload, organization_id: organizationId })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
