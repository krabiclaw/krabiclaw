import { z } from 'zod'

export interface CatalogRow {
  id: string
  label: string
  summary?: string
  eyebrow?: string
  optional_detail?: boolean
  image?: string | null
  to?: string
  native?: string
  query?: Record<string, string>
  status?: 'success' | 'neutral'
  placeholder?: boolean
}

export interface CatalogField {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'number' | 'money' | 'toggle' | 'select' | 'photo' | 'datetime' | 'order'
  value: string
  choices?: Array<{ value: string; label: string; image?: string | null }>
  optional?: boolean
  display_url?: string | null
  playback_url?: string | null
  hint?: string
  media_kind?: 'image' | 'video' | 'any'
}

export interface CatalogScreen {
  title: string
  rows: CatalogRow[]
  fields: CatalogField[]
  revision?: string
  save_label?: string
  allow_unchanged?: boolean
  empty_title?: string
}

export const catalogAnswer = z.object({
  values: z.record(z.string(), z.string().max(10_000)),
  revision: z.string(),
  idempotency_key: z.uuid(),
}).strict()

export type CatalogAnswer = z.infer<typeof catalogAnswer>
