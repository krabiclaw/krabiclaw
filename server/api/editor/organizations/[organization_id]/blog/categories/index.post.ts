import { jsonResponse, readStrictBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { createArticleCategory } from '~/server/utils/content/article-categories'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

// The dashboard's half of create_article_category.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, session, organization } = await requireOrganizationAccess(event, organizationId)
    const body = await readStrictBody<{ collection: unknown; name: unknown; description?: unknown; parent_id?: unknown }>(event, { collection: 'unknown', name: 'unknown', description: 'unknown', parent_id: 'unknown' })
    const category = await createArticleCategory(db, { organizationId: organization.id, collection: body.collection, name: body.name, description: body.description, parentId: body.parent_id, actorId: session.user.id })
    return jsonResponse({ category }, { status: 201 })
  } catch (error) {
    rethrowHttpError(error)
    console.error('article_category_create_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to create category' }, { status: 500 })
  }
})
