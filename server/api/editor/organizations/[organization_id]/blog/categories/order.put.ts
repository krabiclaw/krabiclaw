import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { reorderArticleCategories } from '~/server/utils/content/article-categories'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

// The dashboard's half of reorder_article_categories.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readStrictBody<{ collection: unknown; parent_id?: unknown; category_ids: unknown }>(event, { collection: 'unknown', parent_id: 'unknown', category_ids: 'unknown' })
    const categories = await reorderArticleCategories(db, { organizationId: organization.id, collection: body.collection, parentId: body.parent_id, categoryIds: body.category_ids, actorId: session.user.id })
    return jsonResponse({ categories })
  } catch (error) {
    rethrowHttpError(error)
    console.error('article_categories_reorder_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to reorder categories' }, { status: 500 })
  }
})
