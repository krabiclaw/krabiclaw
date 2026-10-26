import { z } from 'zod'
import type { BusinessProgressReference } from './business-outcomes'
import type { BusinessGoal } from './business-progress'

export const recommendationPreviewSchema = z.object({
  goalIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20).optional(),
  availableMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  asOf: z.iso.datetime({ precision: 3 }).optional(),
  limit: z.number().int().min(1).max(3).default(2),
}).strict().refine(value => !value.goalIds || new Set(value.goalIds).size === value.goalIds.length, 'goalIds must be distinct')

export interface RecommendationPreview {
  /** Transient evaluation identity; neither a task nor proof of actual owner exposure. */
  previewId: string
  contextRevision: string
  evaluatedAt: string
  goals: BusinessGoal[]
  decision: 'recommendations' | 'no_suggestion' | 'needs_context'
  summary: string
  recommendations: Array<{
    /** Canonical operation + subject; independent of generated wording and preview identity. */
    id: string
    reference: BusinessProgressReference
    goalIds: string[]
    intendedOutcome: string
    whyNow: string
    uncertainties: string[]
    capability: { toolName: string; description: string }
  }>
  questions: string[]
  considered: Array<{
    id: string
    reference: BusinessProgressReference
    eligibility: { available: boolean; reasons: string[] }
    allowedGoalIds: string[]
  }>
  coverage: {
    articles: { scanned: number; hasMore: boolean }
    guestThreads: { scanned: number; hasMore: boolean }
    supportedOperations: string[]
    unknowns: string[]
  }
  reasoning: {
    model: string | null
    policyVersion: string
    latencyMs: number
    usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
  }
}
