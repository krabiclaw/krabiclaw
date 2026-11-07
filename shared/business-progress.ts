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
  idempotencyKey: z.string().trim().min(1).max(200),
  intent: authoredText,
  constraints: authoredText.nullable().optional(),
  targetAt: instant.nullable().optional(),
  strategy: businessGoalStrategySchema.nullable().optional(),
}).strict()

export const updateBusinessGoalSchema = z.object({
  revision: instant,
  intent: authoredText.optional(),
  constraints: authoredText.nullable().optional(),
  targetAt: instant.nullable().optional(),
  strategy: businessGoalStrategySchema.nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== 'revision'), 'Provide a goal field to change')

export const businessProgressReferenceSchema = z.object({
  operation: z.enum(BUSINESS_PROGRESS_OPERATIONS),
  subjectId: z.string().trim().min(1).max(200),
}).strict()

export interface BusinessGoal {
  id: string
  intent: string
  constraints: string | null
  targetAt: string | null
  strategy: BusinessGoalStrategy | null
  status: 'active' | 'archived'
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  revision: string
}
