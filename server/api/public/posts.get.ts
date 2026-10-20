import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { defineHandler } from 'nitro';
import { getQuery } from 'nitro/h3';
import { apiErrorResponse, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { listPublicSocialPosts } from '~/server/utils/post-management'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'

/**
 * The public feed, a page at a time: what `/posts` loads beyond its first page
 * and what a location's feed reads. The cursor is the repository's own.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return apiErrorResponse(event, 404, 'TENANT_NOT_FOUND', 'Unknown tenant')

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return apiErrorResponse(event, 503, 'DATABASE_UNAVAILABLE', 'Public post data is temporarily unavailable')

  const query = getQuery(event)
  const locale = query.locale === undefined ? await getSourceLocale(db, organizationId) : assertExactCanonicalLocale(query.locale)
  const locationId = typeof query.location_id === 'string' && query.location_id ? query.location_id : null
  const resource = `public-posts:${organizationId}:${locale}:${locationId ?? ''}`
  let window
  try {
    window = mcpPageWindow({ limit: query.limit === undefined ? 12 : Number(query.limit), ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}) }, { resource })
  } catch (error) {
    return apiErrorResponse(event, 400, 'INVALID_PAGE', error instanceof Error ? error.message : 'Invalid page')
  }
  return jsonResponse({ success: true, ...(await listPublicSocialPosts(env, db, organizationId, { locale, locationId, window, resource })) })
})
