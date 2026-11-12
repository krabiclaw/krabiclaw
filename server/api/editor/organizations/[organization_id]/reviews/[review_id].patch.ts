import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { setReviewStatus } from '~/server/utils/organization-reviews'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const reviewId = getRouterParam(event, 'review_id')
  if (!organizationId || !reviewId) return jsonResponse({ error: 'Organization ID and review ID are required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<unknown>(event)
  const status = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).status : undefined
  return jsonResponse(await setReviewStatus(db, organizationId, reviewId, status))
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody } from 'nitro/h3';
