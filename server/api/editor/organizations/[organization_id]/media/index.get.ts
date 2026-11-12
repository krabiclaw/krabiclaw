// GET /api/editor/organizations/[organizationId]/media?kind=image&limit=50&offset=0
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardMedia } from '~/server/utils/dashboard-editor-resources'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const query = getQuery(event)
  const id = typeof query.id === 'string' ? query.id : undefined
  const kind = typeof query.kind === 'string' ? query.kind : undefined
  const ownerType = typeof query.owner_type === 'string' ? query.owner_type : undefined
  const ownerId = typeof query.owner_id === 'string' ? query.owner_id : undefined
  const slot = typeof query.slot === 'string' ? query.slot : undefined
  const search = typeof query.search === 'string' ? query.search : undefined
  const parsedLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : Number.NaN
  const parsedOffset = typeof query.offset === 'string' ? Number.parseInt(query.offset, 10) : Number.NaN
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0

  return jsonResponse(await loadDashboardMedia(event, organizationId, {
    id, kind, ownerType, ownerId, slot, search, limit, offset, }))
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
