import { buildPublicReviewAggregate, normalizePublicReviewAggregateRows, type PublicReviewAggregateLocation } from '~/server/utils/public-review-aggregate'
import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '../db/index.ts'
import { publicResourceCacheInvalidationQuery } from './public-resource-cache.ts'
import { loadPublicSocialMedia } from './public-social-image.ts'
import { groupMediaPlacements, mediaPlacementsQuery } from './media-asset-manager.ts'
import { publicLocationIsProtected } from '~/shared/location-sharing'
import { projectPublicLocationReview, publicReviewLocationProtectedSql } from './public-location-privacy.ts'
import type { ReviewCategory } from '~/shared/review-questions'
import { submittedReviewRequestSql } from '~/server/utils/review-requests'
import { publicSocialMediaFromPlacements } from '~/utils/social-metadata'


type ReviewLocationScope = string | { sql: string; params: unknown[] }

export function publicReviewListQuery(organization: string | { sql: string }, locationId?: ReviewLocationScope, limit = 50): BatchQuery {
  return {
    query: `SELECT r.id, r.author_name, r.rating, r.content, r.created_at, r.source,
        r.original_review_date, r.original_reference, r.google_review_metadata, r.owner_reply, r.owner_reply_at,
        ${locationId ? 'r.title, r.helpful_count,' : 'r.location_id, bl.title AS location_title,'}
        ${publicReviewLocationProtectedSql('r')} AS is_stay_location
      FROM reviews r ${locationId ? '' : 'LEFT JOIN business_locations bl ON bl.id = r.location_id AND bl.organization_id = r.organization_id'}
      WHERE r.organization_id = ${typeof organization === 'string' ? '?' : organization.sql}
        AND r.status = 'approved'${locationId ? ` AND r.location_id = ${typeof locationId === 'string' ? '?' : locationId.sql}` : ''}
      ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id LIMIT ?`,
    params: [...(typeof organization === 'string' ? [organization] : []), ...(typeof locationId === 'string' ? [locationId] : locationId?.params ?? []), limit],
  }
}

export function visiblePublicReview({ is_stay_location, ...review }: Record<string, unknown>) {
  return projectPublicLocationReview(review, publicLocationIsProtected(is_stay_location))
}

export async function readPublicLocationReviews(db: DbClient, organizationId: string,
  location: PublicReviewAggregateLocation & { id: string }, full = true) {
  const plan = preparePublicLocationReviews(organizationId, location.id, full)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read public location reviews' }), organizationId, location)
}

export function preparePublicLocationReviews(organization: string | { sql: string }, location: ReviewLocationScope, full = true) {
  const list = publicReviewListQuery(organization, location, full ? 50 : 3)
  const queries = [list, ...(full ? [{
    query: `SELECT rating FROM reviews WHERE organization_id = ${typeof organization === 'string' ? '?' : organization.sql}
      AND location_id = ${typeof location === 'string' ? '?' : location.sql} AND status = 'approved'`,
    params: [...(typeof organization === 'string' ? [organization] : []), ...(typeof location === 'string' ? [location] : location.params)],
  }, mediaPlacementsQuery({
    organizationId: organization, ownerType: 'review', owners: { sql: `SELECT id FROM (${list.query})`, params: list.params },
    includeOrganizationFallback: true,
  })] : [])]
  return { queries, read([listed, ratings, media]: D1Result[], id: string, aggregateLocation: PublicReviewAggregateLocation) {
    const placements = media ? groupMediaPlacements(media.results) : null
    const fallback = placements?.get(id) ?? []
    return {
      reviews: (listed!.results as Record<string, unknown>[]).map(row => {
        const review = visiblePublicReview(row)
        return placements
          ? { ...review, ...publicSocialMediaFromPlacements('review', placements.get(String(row.id)) ?? [], fallback) }
          : review
      }),
      aggregate: ratings ? buildPublicReviewAggregate(normalizePublicReviewAggregateRows(ratings.results as { rating?: unknown }[]), aggregateLocation) : null,
    }
  } }
}

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

/**
 * `locationId` names one location's reviews, `null` the reviews attached to no
 * location, and omitting it lists every review on the site.
 */
export async function listOrganizationReviews(db: DbClient, organizationId: string, options: { publishedOnly?: boolean; locationId?: string | null } = {}): Promise<Array<Record<string, unknown> & { publication_authorized: boolean; verified: boolean; category_ratings?: Array<{ category: ReviewCategory; rating: number }> }>> {
  const plan = prepareOrganizationReviews(organizationId, options)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read organization reviews' }), organizationId)
}

export function prepareOrganizationReviews(organizationId: string | { sql: string }, options: { publishedOnly?: boolean; locationId?: string | null } = {}) {
  const org = typeof organizationId === 'string' ? '?' : organizationId.sql
  const orgParams = typeof organizationId === 'string' ? [organizationId] : []
  const locationFilter = options.locationId ? ' AND r.location_id = ?' : options.locationId === null ? ' AND r.location_id IS NULL' : ''
  const scope = `r.organization_id = ${org}${locationFilter}${options.publishedOnly ? " AND r.status = 'approved'" : ''}`
  const params = options.locationId ? [...orgParams, options.locationId] : orgParams
  const queries = [{ query: `
    SELECT r.id, r.organization_id, r.location_id, r.author_name,
           r.rating, r.title, r.content, r.owner_reply, r.owner_reply_at, r.helpful_count, r.status, r.source,
           ${submittedReviewRequestSql('r')} AS review_request_id, entered_by_user_id, collection_method, original_review_date,
           original_reference, google_review_metadata, publication_authorized, created_at, updated_at,
           ${options.publishedOnly ? '' : `r.private_feedback,
             (SELECT json_group_array(json_object('category', category, 'rating', rating) ORDER BY category)
                FROM review_category_ratings WHERE review_id = r.id) AS category_ratings_json,`}
           ${publicReviewLocationProtectedSql('r')} AS is_stay_location
    FROM reviews r
    WHERE ${scope}
    ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id ASC
  `, params }, mediaPlacementsQuery({
    organizationId, ownerType: 'review', owners: { sql: `SELECT r.id FROM reviews r WHERE ${scope}`, params },
    includeOrganizationFallback: true,
  })]
  return { queries, read: ([listed, media]: D1Result[], id: string) => {
    const placements = groupMediaPlacements(media!.results)
    const fallback = placements.get(id) ?? []
    return (listed!.results as Record<string, unknown>[]).map(({ is_stay_location, category_ratings_json, ...row }) => ({
      ...publicReviewRow(row, options.publishedOnly === true && publicLocationIsProtected(is_stay_location), options.publishedOnly === true),
      ...publicSocialMediaFromPlacements('review', placements.get(String(row.id)) ?? [], fallback),
      ...(typeof category_ratings_json === 'string'
        ? { category_ratings: JSON.parse(category_ratings_json) as Array<{ category: ReviewCategory; rating: number }> } : {}),
    }))
  } }
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
