import { z } from 'zod'

export const experienceSetupStep = z.enum(['title', 'description', 'location', 'host', 'duration', 'capacity', 'price', 'session', 'complete'])

const dashboardPath = z.string().startsWith('/dashboard/')

export const experienceSetupScreen = z.object({
  step: experienceSetupStep,
  title: z.string(),
  detail: z.string(),
  label: z.string(),
  value: z.string(),
  choices: z.array(z.object({ value: z.string(), label: z.string(), detail: z.string().optional() })),
  max_length: z.number().int().positive().optional(),
  currency: z.string().optional(),
  today: z.string().optional(),
  position: z.number().int().positive(),
  total: z.number().int().positive(),
  back_to: dashboardPath,
  exit_to: dashboardPath,
  next_label: z.string(),
  back_label: z.string(),
  exit_label: z.string(),
  calendar_to: dashboardPath.optional(),
  preview_to: dashboardPath.optional(),
})
