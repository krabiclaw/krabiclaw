export interface GoogleReviewMetadata {
  author_uri: string | null
  author_photo_uri: string | null
  language_code: string | null
  original_text: string | null
  original_language_code: string | null
  flag_content_uri: string | null
  visit_date: { year: number; month: number } | null
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Google review object')
  return value as Record<string, unknown>
}

function text(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('Invalid Google review text')
  return value
}

function url(value: unknown): string | null {
  const result = text(value)
  if (result !== null && new URL(result).protocol !== 'https:') throw new Error('Invalid Google review URL')
  return result
}

function visitDate(value: unknown): GoogleReviewMetadata['visit_date'] {
  if (value == null) return null
  const date = record(value)
  if (typeof date.year !== 'number' || !Number.isInteger(date.year) || date.year < 1
    || typeof date.month !== 'number' || !Number.isInteger(date.month) || date.month < 1 || date.month > 12) throw new Error('Invalid Google review visit date')
  return { year: date.year, month: date.month }
}

export function parseGoogleReviewMetadata(value: unknown): GoogleReviewMetadata | null {
  if (value == null) return null
  const data = record(typeof value === 'string' ? JSON.parse(value) : value)
  return {
    author_uri: url(data.author_uri), author_photo_uri: url(data.author_photo_uri),
    language_code: text(data.language_code), original_text: text(data.original_text),
    original_language_code: text(data.original_language_code), flag_content_uri: url(data.flag_content_uri),
    visit_date: visitDate(data.visit_date),
  }
}

export function normalizeGoogleReview(value: unknown) {
  const review = record(value)
  const author = review.authorAttribution == null ? {} : record(review.authorAttribution)
  const content = review.text == null ? {} : record(review.text)
  const original = review.originalText == null ? {} : record(review.originalText)
  const google_review_id = text(review.name)
  // A review always names its author; Google's display name is the only one an imported review has.
  const author_name = text(author.displayName)?.trim()
  const original_review_date = text(review.publishTime)
  if (!google_review_id || !/^places\/[^/]+\/reviews\/[^/]+$/.test(google_review_id) || !author_name
    || typeof review.rating !== 'number' || !Number.isFinite(review.rating) || review.rating < 1 || review.rating > 5
    || !original_review_date || Number.isNaN(Date.parse(original_review_date))) throw new Error('Invalid Google review identity, rating, or timestamp')
  return {
    google_review_id, author_name, rating: review.rating, content: text(content.text), original_review_date,
    original_reference: url(review.googleMapsUri),
    google_review_metadata: {
      author_uri: url(author.uri), author_photo_uri: url(author.photoUri), language_code: text(content.languageCode),
      original_text: text(original.text), original_language_code: text(original.languageCode),
      flag_content_uri: url(review.flagContentUri), visit_date: visitDate(review.visitDate),
    } satisfies GoogleReviewMetadata,
  }
}

export type GoogleReview = ReturnType<typeof normalizeGoogleReview>
