// Reading a block's fields, for the components that draw them.
//
// A template's component takes the block and reads it. It used to take a dozen
// named props, which meant a dispatcher stood between the document and the
// markup converting one into the other — about 130 lines of it on the platform
// page alone, and it was that dispatcher that needed `data.section` to know
// which block to convert for which component.
//
// `data` is a free object, so every read is a narrowing, and an absent or
// wrong-typed field reads as empty rather than throwing in a render.

import type { TenantPageBlock } from '~/utils/tenant-page-blocks'

export type BlockRecord = Record<string, unknown>

export function blockText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The value, or null — for a field a component treats as absent when empty. */
export function blockTextOrNull(value: unknown): string | null {
  return blockText(value) || null
}

export function blockRecords(value: unknown): BlockRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is BlockRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

export function blockStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
}

/**
 * Whether a link belongs to this site, and so takes the visitor's locale. An
 * absolute URL belongs to someone else and is left exactly as it was written —
 * running it through `localePath` produced `/th/https://example.com`.
 */
export function isInternalRoute(url: string): boolean {
  // `//example.com` is an absolute URL wearing a leading slash: the browser
  // reads it as a host, so localizing it would send the visitor to
  // `/th//example.com` and, unlocalized, straight off the site.
  return url.startsWith('/') && !url.startsWith('//')
}

/** A block's media placement in a slot, in the order it was arranged. */
export function blockMedia(block: TenantPageBlock, slot: string) {
  return block.media
    .filter(item => item.slot === slot)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

/**
 * A heading cut into the part before its emphasised phrase, the phrase, and the
 * part after — so the phrase can carry colour where it actually sits. A title
 * that does not contain the phrase keeps no accent, so a heading in a locale
 * the phrase was never translated into reads whole rather than gaining a stray
 * English word.
 */
export function splitAccent(title: string, accent?: string | null): { before: string; accent: string; after: string } {
  const phrase = accent ?? ''
  const index = phrase ? title.indexOf(phrase) : -1
  return index >= 0
    ? { before: title.slice(0, index), accent: phrase, after: title.slice(index + phrase.length) }
    : { before: title, accent: '', after: '' }
}

/**
 * The prose block a page with pictures draws beside them, in the hero's own
 * column: the markdown block straight after the hero. The hero draws it there
 * and the renderer skips it — one answer read by both, rather than drawing the
 * block twice.
 */
export function overviewProseBlockId(page: {
  path: string
  blocks: ReadonlyArray<{ id: string; type: string }>
  media: ReadonlyArray<{ kind: string | null; slot: string }>
}): string | null {
  if (page.path === '/') return null
  if (!page.media.some(item => item.kind === 'image' && (item.slot === 'cover' || item.slot === 'gallery'))) return null
  const heroIndex = page.blocks.findIndex(block => block.type === 'hero')
  if (heroIndex < 0) return null
  const next = page.blocks[heroIndex + 1]
  return next?.type === 'markdown' ? next.id : null
}
