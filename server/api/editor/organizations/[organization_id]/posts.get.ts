import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { listPosts } from '~/server/utils/post-management'
import { PostValidationError } from '~/shared/posts'
import { assertResourceAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })

  const query = getQuery(event)
  const status = typeof query.status === 'string' && query.status ? query.status : null
  const locationId = typeof query.location_id === 'string' && query.location_id.trim() ? query.location_id.trim() : null

  // No location_id filter means "every post across the organization" — only
  // an organization-wide member may see that; a location-scoped editor must
  // filter to their own location.
  await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), resourceLocationId: locationId })
  const resource = { resource: `posts:${organization.id}:${status ?? ''}:${locationId ?? ''}` }
  try {
    const page = await listPosts(db, env, organization.id, { status, locationId }, mcpPageWindow({
      ...(typeof query.limit === 'string' ? { limit: Number(query.limit) } : {}),
      ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
    }, resource), resource)
    return jsonResponse({ success: true, ...page })
  } catch (error) {
    if (error instanceof PostValidationError) return jsonResponse({ error: error.message }, { status: 400 })
    throw error
  }
})
