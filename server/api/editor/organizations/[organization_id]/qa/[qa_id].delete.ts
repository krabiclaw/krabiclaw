import { jsonResponse } from '~/server/utils/api-response'
import { deleteQa } from '~/server/utils/location-qa'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const qaId = getRouterParam(event, 'qa_id')
  if (!organizationId || !qaId) return jsonResponse({ error: 'Missing params' }, { status: 400 })
  const { db, organization } = await requireOrganizationAccess(event, organizationId)
  const pagePath = typeof getQuery(event).page_path === 'string' ? String(getQuery(event).page_path) : null
  const result = await deleteQa(db, { organizationId: organization.id, locationId: null, pagePath }, qaId)
  return jsonResponse(result.data, { status: result.status })
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
