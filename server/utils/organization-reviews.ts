import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type DbClient } from '../db/index.ts'
import { publicResourceCacheInvalidationQuery } from './public-resource-cache.ts'
import { loadPublicSocialMedia } from './public-social-image.ts'
import { publicLocationIsProtected } from '~/shared/location-sharing'
import { projectPublicLocationReview, publicReviewLocationProtectedSql } from './public-location-privacy.ts'
import { d1JsonStringSet } from '../db/d1-limits.ts'
import type { ReviewCategory } from '~/shared/review-questions'


function publicReviewRow(row: Record<string, unknown>, protectedLocation: boolean, publishedOnly: boolean): Record<string, unknown> & { publication_authorized: boolean; verified: boolean } {
  // A published review names no internal request or staff account, and
  // carries nothing the guest told the business privately.
  const { review_request_id: _request, entered_by_user_id: _enteredBy, private_feedback: _private, ...visible } = row
  return {
    ...projectPublicLocationReview(publishedOnly ? visible : row, protectedLocation),
    publication_authorized: Boolean(row.publication_authorized),
    verified: row.source === 'direct' && typeof row.review_request_id === 'string' && Boolean(row.review_request_id),
  }
}

/** The optional per-question scores beside each review's overall rating, for those who may read them. */
export async function attachReviewCategoryRatings<T extends Record<string, unknown>>(db: DbClient, reviews: T[]): Promise<Array<T & { category_ratings: Array<{ category: ReviewCategory; rating: number }> }>> {
  const ids = reviews.map(review => String(review.id))
  const rows = ids.length
    ? await queryAll<{ review_id: string; category: ReviewCategory; rating: number }>(db, 'SELECT review_id, category, rating FROM review_category_ratings WHERE review_id IN (SELECT value FROM json_each(?)) ORDER BY review_id, category', [d1JsonStringSet(ids)])
    : []
  return reviews.map(review => ({ ...review, category_ratings: rows.filter(row => row.review_id === String(review.id)).map(({ category, rating }) => ({ category, rating })) }))
}

/**
 * `locationId` names one location's reviews, `null` the reviews attached to no
 * location, and omitting it lists every review on the site.
 */
export async function listOrganizationReviews(db: DbClient, organizationId: string, options: { publishedOnly?: boolean; locationId?: string | null } = {}): Promise<Array<Record<string, unknown> & { publication_authorized: boolean; verified: boolean; category_ratings?: Array<{ category: ReviewCategory; rating: number }> }>> {
  const locationFilter = options.locationId ? ' AND r.location_id = ?' : options.locationId === null ? ' AND r.location_id IS NULL' : ''
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT r.id, r.organization_id, r.location_id, r.author_name,
           r.rating, r.title, r.content, r.owner_reply, r.owner_reply_at, r.helpful_count, r.status, r.source,
           review_request_id, entered_by_user_id, collection_method, original_review_date,
           original_reference, google_review_metadata, publication_authorized, created_at, updated_at,
           ${options.publishedOnly ? '' : 'r.private_feedback,'}
           ${publicReviewLocationProtectedSql('r')} AS is_stay_location
    FROM reviews r
    WHERE r.organization_id = ?${locationFilter}${options.publishedOnly ? " AND r.status = 'approved'" : ''}
    ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id ASC
  `, options.locationId ? [organizationId, options.locationId] : [organizationId])
  const reviews = await attachReviewMedia(db, organizationId, rows.map(({ is_stay_location, ...row }) =>
    publicReviewRow(row, options.publishedOnly === true && publicLocationIsProtected(is_stay_location), options.publishedOnly === true)))
  // The public reads a review's words and overall rating; the per-question scores are the team's.
  if (options.publishedOnly) return reviews
  return await attachReviewCategoryRatings(db, reviews)
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
 * `pending` is only ever the state a public guest submission arrives in, and
 * `private` a guest's review without consent to publish, which stays private.
 */
export async function setReviewStatus(db: DbClient, organizationId: string, reviewId: string, status: unknown) {
  if (status !== 'approved' && status !== 'rejected') throw new HTTPError({ statusCode: 400, statusMessage: 'status must be approved or rejected' })
  const review = await queryFirst<{ id: string; status: string }>(db, 'SELECT id, status FROM reviews WHERE id = ? AND organization_id = ?', [reviewId, organizationId])
  if (!review) throw new HTTPError({ statusCode: 404, statusMessage: 'Review not found' })
  // A guest who did not consent to publication left private feedback; there is nothing to publish.
  if (review.status === 'private') throw new HTTPError({ statusCode: 409, statusMessage: 'This guest shared their review privately, so it cannot be published', data: { code: 'REVIEW_NOT_PUBLIC', field: 'status' } })
  const updatedAt = new Date().toISOString()
  const [update] = await executeBatch(db, [
    { query: "UPDATE reviews SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND status <> 'private'", params: [status, updatedAt, reviewId, organizationId] },
    publicResourceCacheInvalidationQuery(organizationId, 'review-status'),
  ])
  if (Number(update?.meta.changes ?? 0) !== 1) throw new Error(`Review ${reviewId} status update changed ${update?.meta.changes ?? 0} rows`)
  return { review_id: reviewId, status, updated_at: updatedAt }
}
