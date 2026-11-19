import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { preparePostList } from '~/server/utils/post-management'
import { PostValidationError } from '~/shared/posts'
import { BATCH_VIEWER } from '~/server/utils/member-access'
import { readWebsiteMember } from '~/server/utils/tenant-pages-api'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const query = getQuery(event)
  const status = typeof query.status === 'string' && query.status ? query.status : null
  const locationId = typeof query.location_id === 'string' && query.location_id.trim() ? query.location_id.trim() : null

  const resource = { resource: `posts:${organizationId}:${status ?? ''}:${locationId ?? ''}` }
  try {
    const list = preparePostList({ sql: BATCH_VIEWER.organization }, { status, locationId }, mcpPageWindow({
      ...(typeof query.limit === 'string' ? { limit: Number(query.limit) } : {}),
      ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
    }, resource), BATCH_VIEWER)
    const { rows } = await readWebsiteMember(event, organizationId, list.queries)
    return jsonResponse({ success: true, ...list.read(rows, resource) })
  } catch (error) {
    if (error instanceof PostValidationError) return jsonResponse({ error: error.message }, { status: 400 })
    throw error
  }
})
