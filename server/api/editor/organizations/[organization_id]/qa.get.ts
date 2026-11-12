import { jsonResponse } from '~/server/utils/api-response'
import { listQa } from '~/server/utils/location-qa'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)
  const query = getQuery(event)
  const pagePath = typeof query.page_path === 'string' ? String(query.page_path) : null
  const qaId = typeof query.id === 'string' ? query.id : null
  return jsonResponse({ qa: await listQa(db, organizationId, null, false, pagePath, 'en', qaId) })
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
