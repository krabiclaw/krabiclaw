import { jsonResponse } from '~/server/utils/api-response'
import { requireLocationAccess } from '~/server/utils/location-access'
import { queryAll } from '~/server/db'
import { attachReviewMedia } from '~/server/utils/organization-reviews'
import { submittedReviewRequestSql } from '~/server/utils/review-requests'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')

  if (!organizationId || !locationId) {
    return jsonResponse({ error: 'Organization ID and location ID are required' }, { status: 400 })
  }

  const { db } = await requireLocationAccess(event, organizationId, locationId)

  const results = await queryAll<ApiValue>(db, `
    SELECT r.id, r.author_name, r.rating, r.title, r.content, r.owner_reply, r.owner_reply_at,
      r.source, r.status, r.helpful_count, r.user_id, r.booking_id, ${submittedReviewRequestSql('r')} AS review_request_id, r.created_at, r.updated_at
    FROM reviews r
    WHERE r.organization_id = ? AND r.location_id = ?
    ORDER BY r.created_at DESC
  `, [organizationId, locationId])

  const reviews = await attachReviewMedia(db, organizationId, (results ?? []) as Array<Record<string, unknown>>)

  return jsonResponse({ success: true, reviews })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
