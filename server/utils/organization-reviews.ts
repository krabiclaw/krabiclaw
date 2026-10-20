import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type DbClient } from '../db/index.ts'
import { publicResourceCacheInvalidationQuery } from './public-resource-cache.ts'
import { loadPublicSocialMedia } from './public-social-image.ts'
import { publicLocationIsProtected } from '~/shared/location-sharing'
import { projectPublicLocationReview, publicReviewLocationProtectedSql } from './public-location-privacy.ts'


function publicReviewRow(row: Record<string, unknown>, protectedLocation: boolean): Record<string, unknown> & { publication_authorized: boolean; verified: boolean } {
  return {
    ...projectPublicLocationReview(row, protectedLocation),
    publication_authorized: Boolean(row.publication_authorized),
    verified: row.source === 'direct' && typeof row.review_request_id === 'string' && Boolean(row.review_request_id),
  }
}

export async function listOrganizationReviews(db: DbClient, organizationId: string, options: { publishedOnly?: boolean; locationId?: string | null } = {}) {
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT r.id, r.organization_id, r.location_id, r.author_name,
           r.rating, r.title, r.content, r.owner_reply, r.owner_reply_at, r.helpful_count, r.status, r.source,
           review_request_id, entered_by_user_id, collection_method, original_review_date,
           original_reference, google_review_metadata, publication_authorized, created_at, updated_at,
           ${publicReviewLocationProtectedSql('r')} AS is_stay_location
    FROM reviews r
    WHERE r.organization_id = ? AND ${options.locationId ? 'r.location_id = ?' : 'r.location_id IS NULL'}${options.publishedOnly ? " AND r.status = 'approved'" : ''}
    ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id ASC
  `, options.locationId ? [organizationId, options.locationId] : [organizationId])
  return await attachReviewMedia(db, organizationId, rows.map(({ is_stay_location, ...row }) =>
    publicReviewRow(row, options.publishedOnly === true && publicLocationIsProtected(is_stay_location))))
}

export async function attachReviewMedia<T extends Record<string, unknown>>(db: DbClient, organizationId: string, reviews: T[]) {
  const placements = await loadPublicSocialMedia(db, organizationId, 'review', reviews.map(review => String(review.id)))
  return reviews.map(review => {
    const socialMedia = placements.get(String(review.id)) ?? { media: [], social_image: null }
    return { ...review, ...socialMedia }
  })
}

/**
 * The one moderation write. `approved` publishes a review on the tenant's
 * public site; `rejected` is what the dashboard calls Archived and hides it.
 * `pending` is only ever the state a guest submission arrives in.
 */
export async function setReviewStatus(db: DbClient, organizationId: string, reviewId: string, status: unknown) {
  if (status !== 'approved' && status !== 'rejected') throw new HTTPError({ statusCode: 400, statusMessage: 'status must be approved or rejected' })
  const review = await queryFirst<{ id: string }>(db, 'SELECT id FROM reviews WHERE id = ? AND organization_id = ?', [reviewId, organizationId])
  if (!review) throw new HTTPError({ statusCode: 404, statusMessage: 'Review not found' })
  const updatedAt = new Date().toISOString()
  const [update] = await executeBatch(db, [
    { query: 'UPDATE reviews SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?', params: [status, updatedAt, reviewId, organizationId] },
    publicResourceCacheInvalidationQuery(organizationId, 'review-status'),
  ])
  if (Number(update?.meta.changes ?? 0) !== 1) throw new Error(`Review ${reviewId} status update changed ${update?.meta.changes ?? 0} rows`)
  return { review_id: reviewId, status, updated_at: updatedAt }
}
