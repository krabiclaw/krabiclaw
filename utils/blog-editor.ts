import { PUBLICATION_CONTENT_BLOCK_LOCALIZED_FIELDS, expandContentFieldPath, readContentFieldValue, type PublicationContentBlockType } from '~/shared/content-registries'

export type BlogVisibility = 'listed' | 'unlisted'

export interface EditorContentBlock {
  id?: string
  type: string
  position?: number
  level?: number | null
  parent_block_id?: string | null
  data: Record<string, unknown>
  media?: Array<{ asset_id: string; slot: string; sort_order?: number; public_url?: string | null; thumbnail_url?: string | null; kind?: string | null; alt_text?: string | null; caption?: string | null }>
  updated_at?: string
}

export type BlogLocalizedFieldPath = readonly (string | number)[]

export interface BlogLocalizedTextField {
  path: BlogLocalizedFieldPath
  label: string
  value: string
  rows: number
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function localizedTextField(data: Record<string, unknown>, path: BlogLocalizedFieldPath): BlogLocalizedTextField[] {
  const value = readBlogLocalizedText(data, path)
  if (value === undefined) return []
  return [{
    path,
    label: path.map(segment => typeof segment === 'number' ? String(segment + 1) : segment.replaceAll('_', ' ')).join(' · '),
    value,
    rows: path.at(-1) === 'markdown' ? 8 : 2,
  }]
}


export function blogLocalizedTextFields(block: Pick<EditorContentBlock, 'type' | 'data'>): BlogLocalizedTextField[] {
  if (!(block.type in PUBLICATION_CONTENT_BLOCK_LOCALIZED_FIELDS)) return []
  const patterns = PUBLICATION_CONTENT_BLOCK_LOCALIZED_FIELDS[block.type as PublicationContentBlockType]
  return patterns.flatMap(pattern => expandContentFieldPath(block.data, pattern).flatMap(path => localizedTextField(block.data, path)))
}


export function readBlogLocalizedText(data: Record<string, unknown>, path: BlogLocalizedFieldPath): string | undefined {
  const value = readContentFieldValue(data, path)
  return typeof value === 'string' ? value : undefined
}

export function writeBlogLocalizedText(data: Record<string, unknown>, path: BlogLocalizedFieldPath, text: string): void {
  let parent: unknown = data
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === 'number') {
      if (!Array.isArray(parent)) return
      parent = parent[segment]
    } else {
      if (!objectRecord(parent)) return
      parent = parent[segment]
    }
  }
  const finalSegment = path.at(-1)
  if (typeof finalSegment === 'number') {
    if (Array.isArray(parent)) parent[finalSegment] = text
  } else if (typeof finalSegment === 'string' && objectRecord(parent)) {
    parent[finalSegment] = text
  }
}

/**
 * A deep, proxy-free copy of editor blocks.
 *
 * `toRaw` is shallow: it unwraps the array but every object read out of a
 * reactive array is still a proxy, and `structuredClone` throws
 * `DataCloneError: [object Array] could not be cloned` on the first nested
 * proxy it reaches — a block's `media`, or an FAQ's `items`. That fired from
 * the autosave watcher on every structural insert, so adding an image killed
 * the save and the block never persisted.
 *
 * Blocks are JSON by definition; they are stored in `content_blocks.data_json`
 * and sent as JSON. A round-trip through it is the same serialization the
 * payload already undergoes, and it unwraps every proxy at every depth.
 */
export function cloneEditorBlocks<T>(blocks: T): T {
  return JSON.parse(JSON.stringify(blocks)) as T
}

export function blankBlogLocalizedText<T extends EditorContentBlock>(block: T): T {
  const blank = cloneEditorBlocks(block)
  for (const field of blogLocalizedTextFields(blank)) writeBlogLocalizedText(blank.data, field.path, '')
  if (blank.media) {
    blank.media = blank.media.map(item => ({ ...item, alt_text: null, caption: null }))
  }
  return blank
}

export function initialBlogEditorBlocks(): EditorContentBlock[] {
  return [{ type: 'markdown', data: { markdown: '', editor_mode: 'rich' } }]
}

const PLACEHOLDER_RE = /\{\{\s*component\b[^}]*\}\}/gi

export function plainTextFromMarkdown(markdown: string) {
  return markdown
    .replace(PLACEHOLDER_RE, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function generatedExcerpt(blocks: EditorContentBlock[], maxLength = 180) {
  const prose = blocks
    .filter(block => block.type === 'markdown' || block.type === 'heading')
    .map(block => block.type === 'heading' ? String(block.data.text || '') : String(block.data.markdown || ''))
    .map(plainTextFromMarkdown)
    .find(Boolean) || ''
  if (prose.length <= maxLength) return prose
  return `${prose.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}…`
}

export function normalizeBlogSlug(value: string, fallback = 'post') {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

export function firstImageAssetId(blocks: EditorContentBlock[]) {
  const image = blocks.find(block => block.type === 'image' && block.data.status !== 'inactive')
  return image?.media?.find(item => item.slot === 'media')?.asset_id ?? null
}

export function resolveSlugMutation(input: {
  requestedSlug: string | null | undefined
  title: string
  currentSlug: string
  manuallyOverridden: boolean
}) {
  if (input.requestedSlug === null) return { slug: normalizeBlogSlug(input.title), manuallyOverridden: false }
  if (typeof input.requestedSlug === 'string') return { slug: normalizeBlogSlug(input.requestedSlug), manuallyOverridden: true }
  return {
    slug: input.manuallyOverridden ? input.currentSlug : normalizeBlogSlug(input.title),
    manuallyOverridden: input.manuallyOverridden,
  }
}
