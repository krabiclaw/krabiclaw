import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { deletePost } from '~/server/utils/post-management'
import { queryFirst } from '~/server/db'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { assertResourceAccess, isOrganizationWideRole, memberAccessPrincipal } from '~/server/utils/member-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const postId = getRouterParam(event, 'post_id')
  if (!organizationId || !postId) return jsonResponse({ error: 'Organization ID and Post ID required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })
  if (!isOrganizationWideRole(organization.member_role)) {
    return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })
  }

  const post = await queryFirst<{ location_id: string | null }>(db, `
    SELECT location_id FROM content_documents
    WHERE kind = 'social_post' AND row_role = 'root' AND id = ? AND organization_id = ?
    LIMIT 1
  `, [postId, organizationId])
  if (!post) return jsonResponse({ error: 'Post not found' }, { status: 404 })
  await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), resourceLocationId: post.location_id })

  await deletePost(db, organization.id, postId, session.user.id)
  return jsonResponse({ success: true })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
