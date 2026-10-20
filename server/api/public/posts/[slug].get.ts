import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam } from 'nitro/h3';
import { apiErrorResponse, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getPublicSocialPost } from '~/server/utils/post-management'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'

/** One post for client-side navigation: the same reader the page's SSR uses. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return apiErrorResponse(event, 400, 'POST_PARAMS_REQUIRED', 'Organization ID and post slug are required')

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return apiErrorResponse(event, 503, 'DATABASE_UNAVAILABLE', 'Public post data is temporarily unavailable')

  const query = getQuery(event)
  const locale = query.locale === undefined ? await getSourceLocale(db, organizationId) : assertExactCanonicalLocale(query.locale)
  const previewAuthorized = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env))
  const post = await getPublicSocialPost(env, db, organizationId, slug, locale, previewAuthorized)
  if (!post) return apiErrorResponse(event, 404, 'POST_NOT_FOUND', 'Post not found')

  return jsonResponse({ success: true, post })
})
