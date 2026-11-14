import { jsonResponse } from '~/server/utils/api-response'
import { listQaPageScopes } from '~/server/utils/location-qa'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)

  return jsonResponse(await listQaPageScopes(db, organizationId))
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
