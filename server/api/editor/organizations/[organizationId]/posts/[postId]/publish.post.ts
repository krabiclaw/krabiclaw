import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { queryFirst } from '~/server/db'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { assertResourceAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { parsePublishTargets, publishPost } from '~/server/utils/social-publication'

/** The dashboard's publish: the same targets and the same result as publish_post. */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const postId = getRouterParam(event, 'postId')
  if (!organizationId || !postId) return jsonResponse({ error: 'Organization ID and Post ID required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const body = await readStrictBody<{ updated_at: string; targets: unknown }>(event, { updated_at: 'string', targets: 'unknown' })
  const targets = parsePublishTargets(body.targets)
  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })

  const postScope = await queryFirst<{ location_id: string | null }>(db, `
    SELECT location_id FROM content_documents
     WHERE kind = 'social_post' AND row_role = 'root' AND id = ? AND organization_id = ?
     LIMIT 1
  `, [postId, organization.id])
  if (!postScope) return jsonResponse({ error: 'Post not found' }, { status: 404 })
  await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), resourceLocationId: postScope.location_id })

  return jsonResponse(await publishPost(env, organization.id, postId, { expectedUpdatedAt: body.updated_at, targets }, session.user.id))
})
