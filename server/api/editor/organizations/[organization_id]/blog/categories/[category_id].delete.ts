import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { deleteArticleCategory } from '~/server/utils/content/article-categories'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

// The dashboard's half of delete_article_category: a category with articles is refused (409).
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const categoryId = getRouterParam(event, 'category_id')
  if (!organizationId || !categoryId) return jsonResponse({ error: 'Organization ID and category ID are required' }, { status: 400 })
  try {
    const { db, organization } = await requireOrganizationAccess(event, organizationId)
    await deleteArticleCategory(db, { organizationId: organization.id, categoryId })
    return jsonResponse({ success: true, category_id: categoryId })
  } catch (error) {
    rethrowHttpError(error)
    console.error('article_category_delete_failed', { organizationId, categoryId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to delete category' }, { status: 500 })
  }
})
