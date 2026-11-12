import { apiErrorResponse, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getPublicReview } from '~/server/utils/review-management'

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  const slug = getRouterParam(event, 'slug')
  const reviewId = getRouterParam(event, 'review_id')
  if (!organizationId || !slug || !reviewId) return apiErrorResponse(event, 400, 'REVIEW_PARAMS_REQUIRED', 'Organization, location, and review identifiers are required')

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return apiErrorResponse(event, 503, 'DATABASE_UNAVAILABLE', 'Review data is temporarily unavailable')

  const review = await getPublicReview(db, organizationId, slug, reviewId)
  if (!review) return apiErrorResponse(event, 404, 'REVIEW_NOT_FOUND', 'Review not found')

  return jsonResponse({ review })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
