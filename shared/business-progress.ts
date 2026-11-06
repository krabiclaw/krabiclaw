import { z } from 'zod'
import type { BusinessProgressOperation } from './business-outcomes'

const instant = z.iso.datetime({ precision: 3 })
const authoredText = z.string().trim().min(1).max(2000)
export const createBusinessGoalSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  intent: authoredText,
  constraints: authoredText.nullable().optional(),
  targetAt: instant.nullable().optional(),
}).strict()

export const updateBusinessGoalSchema = z.object({
  revision: instant,
  intent: authoredText.optional(),
  constraints: authoredText.nullable().optional(),
  targetAt: instant.nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== 'revision'), 'Provide a goal field to change')

export const businessProgressReferenceSchema = z.object({
  operation: z.enum(['article.update', 'article.publish', 'guest_thread.reply']),
  subjectId: z.string().trim().min(1).max(200),
}).strict()

export const recommendationFeedbackSchema = businessProgressReferenceSchema.extend({
  evidenceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  goalId: z.string().min(1).max(200).optional(),
  goalRevision: instant.optional(),
  decision: z.enum(['accept', 'dismiss', 'defer', 'correct']),
  note: authoredText.nullable().optional(),
  deferUntil: instant.nullable().optional(),
  revision: instant.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.goalId) !== Boolean(value.goalRevision)) context.addIssue({ code: 'custom', message: 'goalId and goalRevision must be supplied together', path: ['goalRevision'] })
  if (value.decision === 'correct' && !value.note) context.addIssue({ code: 'custom', message: 'A correction requires a note', path: ['note'] })
  if ((value.decision === 'defer') !== Boolean(value.deferUntil)) context.addIssue({ code: 'custom', message: 'Only a deferral requires deferUntil', path: ['deferUntil'] })
})

export interface BusinessGoal {
  id: string
  intent: string
  constraints: string | null
  targetAt: string | null
  status: 'active' | 'archived'
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  revision: string
}

export interface RecommendationFeedback {
  id: string
  actorId: string
  operation: BusinessProgressOperation
  subjectId: string
  evidenceRevision: string
  goalId: string | null
  goalRevision: string | null
  decision: 'accept' | 'dismiss' | 'defer' | 'correct'
  note: string | null
  deferUntil: string | null
  createdAt: string
  revision: string
}

export interface RecommendationFeedbackView extends RecommendationFeedback {
  /** Applicability to the evidence named by this person, not a recommendation or an authorization to hide work. */
  applicability: {
    current: boolean
    reasons: Array<'subject_missing' | 'evidence_changed' | 'goal_changed' | 'goal_archived' | 'defer_elapsed'>
  }
}
