import { jsonResponse } from '~/server/utils/api-response'
import { qaListQuery, qaPageScopesQuery } from '~/server/utils/location-qa'
import { executeBatch } from '~/server/db'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)
  const query = getQuery(event)
  const pagePath = typeof query.page_path === 'string' ? String(query.page_path) : null
  const qaId = typeof query.id === 'string' ? query.id : null
  const [list, scopes] = await executeBatch(db, [
    qaListQuery(organizationId, null, 'en', false, pagePath, qaId),
    ...(query.scopes === '1' ? [qaPageScopesQuery(organizationId)] : []),
  ], { operation: 'Read Q&A' })
  return jsonResponse({ qa: list!.results, ...(scopes ? { page_scopes: scopes.results } : {}) })
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
