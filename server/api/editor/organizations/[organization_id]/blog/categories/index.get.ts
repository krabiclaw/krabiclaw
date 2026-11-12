import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { listArticleCategories } from '~/server/utils/content/article-categories'
import { isArticleCollection } from '~/utils/article-collections'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'

// The dashboard's half of list_article_categories.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const collection = getQuery(event).collection
  if (!isArticleCollection(collection)) return jsonResponse({ error: 'collection must be blog or docs' }, { status: 400 })
  try {
    const { db, organization } = await requireOrganizationAccess(event, organizationId)
    return jsonResponse({ categories: await listArticleCategories(db, organization.id, collection) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('article_categories_list_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to list categories' }, { status: 500 })
  }
})
