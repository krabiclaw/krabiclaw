export interface CatalogRow {
  id: string
  label: string
  summary?: string
  eyebrow?: string
  icon?: string
  optional_detail?: boolean
  image?: string | null
  external_url?: string | null
  copy_value?: string
  to?: string
  authorization?: string
  group?: string
  plan?: string | null
  native?: string
  replace?: boolean
  query?: Record<string, string>
  status?: 'success' | 'neutral' | 'error'
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
  timezone?: string
  /** What the picker offers: pictures, videos, either, or a PDF document. */
  media_kind?: 'image' | 'video' | 'any' | 'document'
}

export interface CatalogScreen {
  title: string
  preview_url?: string | null
  destination?: { view: string; query: Record<string, string> }
  rows: CatalogRow[]
  groups?: Array<{ id: string; label: string }>
  filters?: Array<{ value: string; label: string }>
  fields: CatalogField[]
  revision?: string
  save_label?: string
  allow_unchanged?: boolean
  empty_title?: string
}
