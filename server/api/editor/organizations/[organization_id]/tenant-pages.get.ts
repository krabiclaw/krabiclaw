import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { listTenantPages } from '~/server/utils/content/pages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)
  
  const pages = await listTenantPages(db, organizationId)
  return jsonResponse(pages.map(page => ({ path: page.path, title: page.title })))
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
