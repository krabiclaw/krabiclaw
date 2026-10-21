import { parseGoogleReviewMetadata } from '~/shared/google-review'

/** Privacy follows the canonical home owner, including mixed catalogs and unpublished homes. */
export function publicLocationPrivacySql(alias: string): string {
  return `${alias}.stay_map_sharing, ${publicLocationProtectedSql(alias)} AS is_stay_location`
}

export function publicLocationProtectedSql(alias: string): string {
  return protectedLocationSql(`${alias}.organization_id`, `${alias}.id`)
}

export function publicReviewLocationProtectedSql(alias: string): string {
  return protectedLocationSql(`${alias}.organization_id`, `${alias}.location_id`)
}

function protectedLocationSql(organizationId: string, locationId: string): string {
  return `(EXISTS (SELECT 1 FROM organization privacy_org WHERE privacy_org.id = ${organizationId} AND privacy_org.vertical = 'lodging')
      OR EXISTS (SELECT 1 FROM product_stay_configs privacy_stay
          JOIN products privacy_product ON privacy_product.id = privacy_stay.product_id AND privacy_product.organization_id = privacy_stay.organization_id AND privacy_product.kind = 'stay'
         WHERE privacy_stay.organization_id = ${organizationId} AND privacy_stay.location_id = ${locationId}))`
}

/** A Google review's deep links identify the same private property as its Places ID. */
export function projectPublicLocationReview<T extends { original_reference?: unknown; google_review_metadata?: unknown }>(review: T, protectedLocation: boolean) {
  const metadata = parseGoogleReviewMetadata(review.google_review_metadata)
  return {
    ...review,
    original_reference: protectedLocation ? null : review.original_reference,
    google_review_metadata: metadata && protectedLocation ? { ...metadata, flag_content_uri: null } : metadata,
  }
}
