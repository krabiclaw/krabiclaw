import { z } from 'zod'
import { BUSINESS_PROGRESS_OPERATIONS } from './business-outcomes'

const instant = z.iso.datetime({ precision: 3 })
const authoredText = z.string().trim().min(1).max(2000)
export const businessGoalStrategySchema = z.object({
  channels: z.array(z.enum(['blog', 'social', 'google_ads'])).max(3).refine(channels => new Set(channels).size === channels.length, 'Choose each channel once'),
  payments: z.boolean().optional(),
  availability: z.boolean().optional(),
}).strict()
export type BusinessGoalStrategy = z.infer<typeof businessGoalStrategySchema>
export const createBusinessGoalSchema = z.object({
  idempotency_key: z.string().trim().min(1).max(200),
  intent: authoredText,
  constraints: authoredText.nullable().optional(),
  target_at: instant.nullable().optional(),
  strategy: businessGoalStrategySchema.nullable().optional(),
}).strict()

export const updateBusinessGoalSchema = z.object({
  updated_at: instant,
  intent: authoredText.optional(),
  constraints: authoredText.nullable().optional(),
  target_at: instant.nullable().optional(),
  strategy: businessGoalStrategySchema.nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== 'updated_at'), 'Provide a goal field to change')

export const businessProgressReferenceSchema = z.object({
  operation: z.enum(BUSINESS_PROGRESS_OPERATIONS),
  subject_id: z.string().trim().min(1).max(200),
}).strict()

export interface BusinessGoal {
  id: string
  intent: string
  constraints: string | null
  target_at: string | null
  strategy: BusinessGoalStrategy | null
  status: 'active' | 'archived'
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
}
