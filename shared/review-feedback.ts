import { z } from 'zod'
import { REVIEW_CATEGORY_KEYS, REVIEW_SUBJECTS } from './review-questions'

const count = z.number().int().nonnegative()
const average = z.number().nullable()

/**
 * What invited guests told the business about their visits, over a period:
 * every submission, public or private, whether or not it was published. It is
 * internal feedback, distinct from the published reviews a website shows. A
 * member reads only the visits they are responsible for.
 */
export const reviewFeedbackSchema = z.object({
  period: z.object({ startDate: z.string(), endDate: z.string(), timezone: z.string() }),
  /** True when the reader sees every visit, false when only their own responsibility. */
  organizationWide: z.boolean(),
  responses: count,
  overall: z.object({ average, count }),
  privateFeedbackCount: count,
  subjects: z.array(z.object({
    subject: z.enum(REVIEW_SUBJECTS),
    label: z.string(),
    responses: count,
    average,
    categories: z.array(z.object({ key: z.enum(REVIEW_CATEGORY_KEYS as [string, ...string[]]), label: z.string(), average, count })),
  })),
  months: z.array(z.object({ month: z.string(), responses: count, average })),
  recent: z.array(z.object({
    id: z.string(),
    author: z.string(),
    rating: z.number().int().min(1).max(5),
    subject: z.enum(REVIEW_SUBJECTS),
    visitTitle: z.string().nullable(),
    createdAt: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'private']),
    title: z.string().nullable(),
    content: z.string().nullable(),
    privateFeedback: z.string().nullable(),
    categories: z.array(z.object({ key: z.string(), label: z.string(), rating: z.number().int().min(1).max(5) })),
  })),
})

export type ReviewFeedback = z.infer<typeof reviewFeedbackSchema>
