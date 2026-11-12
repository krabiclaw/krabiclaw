// GET /api/editor/organizations/[organizationId]/contact-submissions
import { jsonResponse } from '~/server/utils/api-response'
import { listContactSubmissions } from '~/server/utils/mcp-workflows'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const { db } = await requireOrganizationAccess(event, organizationId)

  const submissions = await listContactSubmissions(db, organizationId)
  return jsonResponse({ submissions })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
