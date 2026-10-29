import { HTTPError } from 'nitro'
import type { H3Event } from 'nitro/h3'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows, assignedGuestThreadScope, isOrganizationWideRole } from '~/server/utils/member-access'
import { attachReviewCategoryRatings } from '~/server/utils/organization-reviews'
import { REVIEW_CATEGORIES, REVIEW_SUBJECTS, REVIEW_SUBJECT_LABELS, reviewSubject } from '~/shared/review-questions'
import { reviewFeedbackSchema, type ReviewFeedback } from '~/shared/review-feedback'
import { addLocalDays, isValidCalendarDate, localDateAt, localDateTimeToInstant } from '~/utils/timezone'

const DEFAULT_DAYS = 90
const MAX_DAYS = 366

function averageOf(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null
}

/**
 * Feedback from invited guests over a period in the organization's own dates.
 * Owners and admins read every visit; a member reads the visits whose
 * conversation is theirs under the shared responsibility scope, and nothing
 * else of the organization's performance.
 */
export async function loadReviewFeedback(db: DbClient, input: {
  organizationId: string
  userId: string
  organizationWide: boolean
  /** The period ending today, in the organization's dates; or an explicit start and end. */
  days?: number
  startDate?: string
  endDate?: string
}): Promise<ReviewFeedback> {
  const organization = await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [input.organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  const timezone = organization.timezone
  const endDate = input.endDate ?? localDateAt(new Date(), timezone)
  if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DAYS)) {
    throw new HTTPError({ statusCode: 400, message: `Choose between 1 and ${MAX_DAYS} days`, data: { code: 'INVALID_RANGE', field: 'days' } })
  }
  const startDate = input.startDate ?? addLocalDays(endDate, 1 - (input.days ?? DEFAULT_DAYS))
  if (!isValidCalendarDate(startDate) || !isValidCalendarDate(endDate) || startDate > endDate || addLocalDays(startDate, MAX_DAYS) <= endDate) {
    throw new HTTPError({ statusCode: 400, message: `Choose a start and end date no more than ${MAX_DAYS} days apart`, data: { code: 'INVALID_RANGE', field: 'startDate' } })
  }
  const from = localDateTimeToInstant(startDate, '00:00', timezone, 'compatible').toISOString()
  const until = localDateTimeToInstant(addLocalDays(endDate, 1), '00:00', timezone, 'compatible').toISOString()

  const scope = input.organizationWide ? null : assignedGuestThreadScope('q', input.userId)
  const rows = await queryAll<{ id: string; author_name: string; rating: number; status: ReviewFeedback['recent'][number]['status']; title: string | null; content: string | null
    private_feedback: string | null; created_at: string; booking_type: 'reservation' | 'booking' | 'stay'; product_kind: string | null; visit_title: string | null }>(db, `
    SELECT r.id, r.author_name, r.rating, r.status, r.title, r.content, r.private_feedback, r.created_at, r.booking_type,
           p.kind AS product_kind, COALESCE(p.name, bl.title) AS visit_title
      FROM reviews r
      LEFT JOIN products p ON p.organization_id = r.organization_id AND p.id = r.product_id
      LEFT JOIN business_locations bl ON bl.id = r.location_id AND bl.organization_id = r.organization_id
     WHERE r.organization_id = ? AND r.source = 'direct' AND r.booking_type IN ('reservation', 'booking', 'stay')
       AND r.created_at >= ? AND r.created_at < ?
       ${scope ? `AND EXISTS (SELECT 1 FROM requests q WHERE q.id = r.booking_id AND q.organization_id = r.organization_id AND ${scope.sql})` : ''}
     ORDER BY r.created_at DESC, r.id`, [input.organizationId, from, until, ...(scope?.params ?? [])])
  const reviews = (await attachReviewCategoryRatings(db, rows)).map(row => ({ ...row, subject: reviewSubject(row.booking_type, row.product_kind) }))

  const subjects = REVIEW_SUBJECTS.flatMap(subject => {
    const answered = reviews.filter(review => review.subject === subject)
    if (!answered.length) return []
    return [{
      subject,
      label: REVIEW_SUBJECT_LABELS[subject],
      responses: answered.length,
      average: averageOf(answered.map(review => review.rating)),
      // An unanswered question counts for nothing: only the scores given are averaged.
      categories: REVIEW_CATEGORIES[subject].map(question => {
        const scores = answered.flatMap(review => review.category_ratings.filter(rating => rating.category === question.key).map(rating => rating.rating))
        return { key: question.key, label: question.label, average: averageOf(scores), count: scores.length }
      }),
    }]
  })
  const months = [...new Set(reviews.map(review => localDateAt(new Date(review.created_at), timezone).slice(0, 7)))].sort().map(month => {
    const inMonth = reviews.filter(review => localDateAt(new Date(review.created_at), timezone).startsWith(month))
    return { month, responses: inMonth.length, average: averageOf(inMonth.map(review => review.rating)) }
  })
  const labelOf = (subject: typeof REVIEW_SUBJECTS[number], key: string) => REVIEW_CATEGORIES[subject].find(question => question.key === key)?.label ?? key

  return reviewFeedbackSchema.parse({
    period: { startDate, endDate, timezone },
    organizationWide: input.organizationWide,
    responses: reviews.length,
    overall: { average: averageOf(reviews.map(review => review.rating)), count: reviews.length },
    privateFeedbackCount: reviews.filter(review => review.private_feedback !== null).length,
    subjects,
    months,
    recent: reviews.slice(0, 20).map(review => ({
      id: review.id,
      author: review.author_name,
      rating: review.rating,
      subject: review.subject,
      visitTitle: review.visit_title,
      createdAt: review.created_at,
      status: review.status,
      title: review.title,
      content: review.content,
      privateFeedback: review.private_feedback,
      categories: review.category_ratings.map(rating => ({ key: rating.category, label: labelOf(review.subject, rating.category), rating: rating.rating })),
    })),
  })
}

/** The dashboard's reader: owners and admins see everything, a member their own visits. */
export async function loadDashboardReviewFeedback(event: H3Event, query: { days?: number; startDate?: string; endDate?: string }): Promise<ReviewFeedback> {
  const { db, userId, organization } = await getDashboardMemberContext(event, {})
  const organizationWide = isOrganizationWideRole(organization.role)
  if (!organizationWide) await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { operations: ['assigned'] } })
  return loadReviewFeedback(db, { organizationId: organization.id, userId, organizationWide, ...query })
}
