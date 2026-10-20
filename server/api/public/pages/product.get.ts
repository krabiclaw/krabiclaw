import { getSourceLocale } from '~/server/utils/organization-locales'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { assertExactCanonicalLocale } from '~/server/utils/localization'
import { previewSecretOf, resolvePreviewAuthorization } from '~/server/utils/preview-token'
import { loadPublicPageProductDetail, publicProductDetailPayload } from '~/server/utils/public-products'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const query = getQuery(event)
  if (typeof query.path !== 'string') throw new HTTPError({ statusCode: 400, statusMessage: 'Page path is required' })
  const env = cloudflareEnv(event)
  const locale = assertExactCanonicalLocale(query.locale ?? await getSourceLocale(env.DB, organizationId))
  const preview = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env))
  const detail = await loadPublicPageProductDetail(env, env.DB, organizationId, preview, query.path, locale, typeof query.location_id === 'string' ? query.location_id : null)
  return jsonResponse(detail ? await publicProductDetailPayload(env.DB, env, detail) : null)
})
