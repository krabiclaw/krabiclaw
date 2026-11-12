import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { updateArticleCategory } from '~/server/utils/content/article-categories'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

// The dashboard's half of update_article_category.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const categoryId = getRouterParam(event, 'category_id')
  if (!organizationId || !categoryId) return jsonResponse({ error: 'Organization ID and category ID are required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readStrictBody<{ name?: unknown; description?: unknown; parent_id?: unknown }>(event, { name: 'unknown', description: 'unknown', parent_id: 'unknown' })
    const category = await updateArticleCategory(db, { organizationId: organization.id, categoryId, name: body.name, description: body.description, parentId: body.parent_id, actorId: session.user.id })
    return jsonResponse({ category })
  } catch (error) {
    rethrowHttpError(error)
    console.error('article_category_update_failed', { organizationId, categoryId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to update category' }, { status: 500 })
  }
})
