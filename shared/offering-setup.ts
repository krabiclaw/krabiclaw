import { z } from 'zod'

const choice = z.object({ value: z.string(), label: z.string(), detail: z.string().optional() })
const field = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'textarea', 'choice', 'money', 'number', 'photo', 'date', 'time', 'timezone']),
  value: z.string(),
  choices: z.array(choice).optional(),
  optional: z.boolean().optional(),
  max_length: z.number().int().positive().optional(),
  symbol: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  min_date: z.string().optional(),
  placeholder: z.string().optional(),
  display_url: z.string().optional(),
})
const path = z.string().startsWith('/dashboard/')
export const offeringSetupResponse = z.union([
  z.object({
    step: z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      position: z.number().int().positive(),
      total: z.number().int().positive(),
      fields: z.array(field),
      next_label: z.string(),
    }),
    revision: z.string().optional(),
    back_to: path,
    exit_to: path,
    back_label: z.string(),
    exit_label: z.string(),
  }),
  z.object({ to: path, guide: z.literal(true).optional(), product_id: z.string().optional(), location_id: z.string().optional() }),
])
export const offeringSetupAnswer = z.object({
  action: z.enum(['next', 'exit']),
  step: z.string().max(64),
  values: z.record(z.string(), z.string().max(10_000)),
  revision: z.string().optional(),
}).strict()

export type OfferingSetupField = z.infer<typeof field>
export type OfferingSetupResponse = z.infer<typeof offeringSetupResponse>
export type OfferingSetupAnswer = z.infer<typeof offeringSetupAnswer>
