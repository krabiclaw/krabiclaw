import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { preparePost, updatePost } from '~/server/utils/post-management'
import { PostValidationError } from '~/shared/posts'
import { assertResourceAccess, BATCH_VIEWER, memberAccessPrincipal } from '~/server/utils/member-access'


export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const postId = getRouterParam(event, 'post_id')
  if (!organizationId || !postId) return jsonResponse({ error: 'Organization ID and Post ID required' }, { status: 400 })

  const { updated_at: expectedUpdatedAt, media, ...changes } = await readStrictBody<Record<string, unknown> & { updated_at: string }>(event, {
    updated_at: 'string', title: 'unknown', body: 'unknown', slug: 'unknown',
    location_id: 'unknown', visibility: 'unknown', call_to_action: 'unknown', media: 'unknown',
  })
  if (!expectedUpdatedAt) return jsonResponse({ error: 'updated_at is required' }, { status: 400 })

  const plan = preparePost({ sql: BATCH_VIEWER.organization }, postId, BATCH_VIEWER)
  const { db, env, organization, userId, rows } = await readDashboardMemberResources(event, organizationId, plan.queries)
  const snapshot = plan.snapshot(rows)
  if (!snapshot) return jsonResponse({ error: 'Post not found' }, { status: 404 })

  if ('location_id' in changes && changes.location_id !== snapshot.document.location_id) {
    await assertResourceAccess(db, { ...memberAccessPrincipal(organization, { env, event }),
      resourceLocationId: typeof changes.location_id === 'string' && changes.location_id ? changes.location_id : null })
  }

  try {
    const post = await updatePost(db, env, organizationId, postId, { changes, expectedUpdatedAt, media, snapshot }, userId)
    if (!post) return jsonResponse({ error: 'Post not found' }, { status: 404 })
    return jsonResponse({ success: true, post })
  } catch (error) {
    if (error instanceof PostValidationError) return jsonResponse({ error: error.message }, { status: error.statusCode })
    throw error
  }
})
