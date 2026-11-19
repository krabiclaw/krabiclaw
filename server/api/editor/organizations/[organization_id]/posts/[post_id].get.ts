import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { BATCH_VIEWER } from '~/server/utils/member-access'
import { preparePost } from '~/server/utils/post-management'
import { readWebsiteMember } from '~/server/utils/tenant-pages-api'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const postId = getRouterParam(event, 'post_id')
  if (!organizationId || !postId) return jsonResponse({ error: 'Organization ID and Post ID required' }, { status: 400 })
  const plan = preparePost({ sql: BATCH_VIEWER.organization }, postId, BATCH_VIEWER)
  const { env, rows } = await readWebsiteMember(event, organizationId, plan.queries)
  const post = await plan.read(rows, env)
  if (!post) return jsonResponse({ error: 'Post not found' }, { status: 404 })
  return jsonResponse({ success: true, post }, { headers: { 'cache-control': 'private, no-store' } })
})
