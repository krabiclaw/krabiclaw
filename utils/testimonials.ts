// The owner-entered testimonial as the editor endpoint returns it.
import {
  OWNER_REVIEW_COLLECTION_METHODS,
  OWNER_REVIEW_COLLECTION_METHOD_LABELS,
  OWNER_REVIEW_STATUSES,
  type OwnerReviewCollectionMethod as CollectionMethod,
  type OwnerReviewStatus as TestimonialStatus,
} from '~/shared/organization-reviews'

export type { CollectionMethod, TestimonialStatus }

export interface OrganizationTestimonial {
  id: string
  author_name: string
  rating: number
  title: string | null
  /** Null for a guest's private review, which has no public text. */
  content: string | null
  /** What the guest told the business privately; never published. */
  private_feedback: string | null
  /** Optional scores for the visit's fixed questions; a skipped question has none. */
  category_ratings: Array<{ category: string; rating: number }>
  collection_method: CollectionMethod | null
  original_review_date: string | null
  original_reference: string | null
  publication_authorized: boolean
  status: TestimonialStatus
  created_at: string
}

export const COLLECTION_METHOD_LABELS = OWNER_REVIEW_COLLECTION_METHOD_LABELS

// `rejected` is the stored status of a review the owner archived: hidden from the public site.
export const REVIEW_STATUS_LABELS: Record<TestimonialStatus, string> = { pending: 'Pending', approved: 'Published', rejected: 'Draft', private: 'Private' }

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

export const isOrganizationTestimonial = (value: unknown): value is OrganizationTestimonial =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.author_name === 'string'
  && typeof value.rating === 'number'
  && isStringOrNull(value.content)
  && isStringOrNull(value.private_feedback)
  && Array.isArray(value.category_ratings) && value.category_ratings.every(rating => isRecord(rating) && typeof rating.category === 'string' && typeof rating.rating === 'number')
  && isStringOrNull(value.title)
  && (value.collection_method === null || OWNER_REVIEW_COLLECTION_METHODS.some(method => method === value.collection_method))
  && isStringOrNull(value.original_review_date)
  && isStringOrNull(value.original_reference)
  && typeof value.publication_authorized === 'boolean'
  && OWNER_REVIEW_STATUSES.some(status => status === value.status)
  && typeof value.created_at === 'string'

export const isTestimonialsResponse = (value: unknown): value is { reviews: OrganizationTestimonial[] } =>
  isRecord(value) && Array.isArray(value.reviews) && value.reviews.every(isOrganizationTestimonial)
