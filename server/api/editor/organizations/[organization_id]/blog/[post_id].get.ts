import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { prepareBlogPost } from '~/server/utils/content/publishing'
import { requireWebsiteAccess, websiteEditorOrganization } from '~/server/utils/tenant-pages-api'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')
  const postId = getRouterParam(event, 'post_id')
  if (!organizationId || !postId) return jsonResponse({ error: 'Organization and article IDs are required' }, { status: 400 })
  const article = prepareBlogPost(postId, websiteEditorOrganization)
  const { env, rows } = await requireWebsiteAccess(event, organizationId, article.queries)
  return jsonResponse({ post: await article.read(rows, env) }, { headers: { 'cache-control': 'private, no-store' } })
})
