import { queryFirst, type DbClient, type QueryResultRow } from '~/server/db'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import { publicLocationIsProtected } from '~/shared/location-sharing'
import { projectPublicLocationReview, publicReviewLocationProtectedSql } from '~/server/utils/public-location-privacy'

export async function getPublicReview(db: DbClient, organizationId: string, locationSlug: string, reviewId: string) {
  const review = await queryFirst<QueryResultRow>(db, `
    SELECT r.id, r.author_name, r.rating, r.title, r.content,
           r.owner_reply, r.owner_reply_at, r.source, r.created_at, r.original_review_date, r.original_reference, r.google_review_metadata,
           r.helpful_count, bl.title AS location_title, bl.slug AS location_slug,
           s.name AS organization_name, ${publicReviewLocationProtectedSql('r')} AS is_stay_location
    FROM reviews r
    JOIN business_locations bl ON bl.id = r.location_id
    JOIN organization s ON s.id = r.organization_id
    WHERE r.id = ?
      AND r.organization_id = ?
      AND bl.slug = ?
      AND r.status = 'approved'
    LIMIT 1
  `, [reviewId, organizationId, locationSlug])
  if (!review) return null

  const socialMedia = (await loadPublicSocialMedia(db, organizationId, 'review', [reviewId])).get(reviewId)

  const { is_stay_location, ...publicReview } = review
  return {
    ...projectPublicLocationReview(publicReview, publicLocationIsProtected(is_stay_location)),
    media: socialMedia?.media ?? [],
    social_image: socialMedia?.social_image ?? null,
  }
}
