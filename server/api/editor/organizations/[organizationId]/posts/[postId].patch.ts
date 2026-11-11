import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { getPost, updatePost } from '~/server/utils/post-management'
import { PostValidationError } from '~/shared/posts'
import { assertResourceAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const postId = getRouterParam(event, 'postId')
  if (!organizationId || !postId) return jsonResponse({ error: 'Organization ID and Post ID required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const { updated_at: expectedUpdatedAt, ...changes } = await readStrictBody<Record<string, unknown> & { updated_at: string }>(event, {
    updated_at: 'string', title: 'unknown', body: 'unknown', slug: 'unknown',
    location_id: 'unknown', visibility: 'unknown', call_to_action: 'unknown',
  })
  if (!expectedUpdatedAt) return jsonResponse({ error: 'updated_at is required' }, { status: 400 })

  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })

  const existingPost = await getPost(db, env, organization.id, postId)
  if (!existingPost) return jsonResponse({ error: 'Post not found' }, { status: 404 })

  const principal = memberAccessPrincipal(organization.membership, { env, event })
  await assertResourceAccess(db, { ...principal, resourceLocationId: existingPost.location_id ?? null })
  // Moving the post to a different location is itself checked against the
  // target scope, not just the post's current one.
  if ('location_id' in changes) {
    await assertResourceAccess(db, { ...principal, resourceLocationId: typeof changes.location_id === 'string' && changes.location_id ? changes.location_id : null })
  }

  try {
    const post = await updatePost(db, env, organization.id, postId, { changes, expectedUpdatedAt }, session.user.id)
    if (!post) return jsonResponse({ error: 'Post not found' }, { status: 404 })
    return jsonResponse({ success: true, post })
  } catch (error) {
    if (error instanceof PostValidationError) return jsonResponse({ error: error.message }, { status: error.statusCode })
    throw error
  }
})
