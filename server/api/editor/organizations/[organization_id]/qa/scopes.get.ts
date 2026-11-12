import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)
  
  const scopes = await db.prepare(`
    SELECT DISTINCT scope_path AS page_path
    FROM content_documents
    WHERE kind = 'qa' AND row_role = 'root' AND organization_id = ? AND location_id IS NULL AND scope_path IS NOT NULL
    ORDER BY page_path ASC
  `).bind(organizationId).all()
  
  return jsonResponse(scopes.results ?? [])
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
