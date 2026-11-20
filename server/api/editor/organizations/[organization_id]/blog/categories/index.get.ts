import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { articleCategoriesQuery, readArticleCategories } from '~/server/utils/content/article-categories'
import { isArticleCollection } from '~/utils/article-collections'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID is required' })
  const { collection, category_id } = getQuery(event)
  if (category_id !== undefined && (typeof category_id !== 'string' || !category_id || collection !== undefined)
    || category_id === undefined && !isArticleCollection(collection)) throw new HTTPError({ statusCode: 400, message: 'Choose a collection or category' })
  const selected = typeof category_id === 'string'
    ? { sql: `(SELECT collection FROM article_categories WHERE organization_id = ${BATCH_VIEWER.organization} AND id = ?)`, params: [category_id] }
    : collection as 'blog' | 'docs'
  const plan = articleCategoriesQuery({ sql: BATCH_VIEWER.organization }, selected)
  const { db, env, organization, rows } = await readDashboardMemberResources(event, organizationId, [plan])
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  const categories = readArticleCategories(rows[0]!.results)
  if (category_id && !categories.some(row => row.id === category_id)) throw new HTTPError({ statusCode: 404, message: 'Category not found' })
  return jsonResponse({ categories })
})
