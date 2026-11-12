import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireBlogAccess } from '~/server/utils/blog-access'
import { reorderArticles } from '~/server/utils/content/publishing'
import { isArticleCollection } from '~/utils/article-collections'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

// The dashboard's half of reorder_blog_posts: the same domain function, so a
// collection's order is one contract whichever surface sets it.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db } = await requireBlogAccess(event, organizationId)
    const body = await readStrictBody<{ collection: unknown; post_ids: unknown }>(event, { collection: 'unknown', post_ids: 'unknown' })
    if (!isArticleCollection(body.collection)) return jsonResponse({ error: 'collection must be blog or docs' }, { status: 400 })
    if (!Array.isArray(body.post_ids) || body.post_ids.some(id => typeof id !== 'string' || !id.trim())) {
      return jsonResponse({ error: 'post_ids must contain non-empty post IDs' }, { status: 400 })
    }
    await reorderArticles(db, organizationId, body.collection, body.post_ids.map(id => String(id).trim()))
    return jsonResponse({ success: true })
  } catch (error) {
    rethrowHttpError(error)
    console.error('articles_reorder_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to reorder articles' }, { status: 500 })
  }
})
