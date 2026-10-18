import { TENANT_PAGE_BLOCK_REGISTRY, type TenantPageBlock, type TenantPageBlockType, type TenantPageField } from '~/utils/tenant-page-blocks'

/**
 * Where a block's controls live in the editor chain.
 *
 * Derived from the block's declared fields, so this restates nothing. It was a
 * second hand-written table beside the registry, which is how a block could
 * grow a field that no screen ever showed.
 *
 * It exists because `DESIGN.md` measures a leaf by its controls: a block with
 * one concern is a leaf, and a block with several is a hub whose concerns each
 * sit one level deeper. Which of the two a block is, is a fact about that block
 * type, so it is written down once rather than re-derived by each screen.
 */
export type TenantPageBlockSectionKind = 'leaf' | 'list'

/** The nested arrays a block stores its own records in. */
export type TenantPageBlockCollection = 'items' | 'buttons' | 'steps' | 'tiers'

export interface TenantPageBlockSection {
  /** The route segment, and the key the editors switch on. */
  key: string
  label: string
  icon?: string
  kind: TenantPageBlockSectionKind
  /** Which array a `list` section browses. */
  collection?: TenantPageBlockCollection
  /**
   * Restricts the section to blocks whose stored `source` is one of these. A
   * feature grid drawing its rows from published posts has no manual items to
   * browse, and a calculator has no items at all.
   */
  sources?: readonly string[]
}

const SECTION_PRESENTATION: Record<string, { label: string; icon?: string }> = {
  content: { label: 'Content' },
  copy: { label: 'Copy' },
  button: { label: 'Button', icon: 'i-lucide-mouse-pointer-click' },
  buttons: { label: 'Buttons', icon: 'i-lucide-mouse-pointer-click' },
  settings: { label: 'Settings' },
  items: { label: 'Items', icon: 'i-lucide-layout-list' },
  steps: { label: 'Steps', icon: 'i-lucide-list-ordered' },
  tiers: { label: 'Amounts', icon: 'i-lucide-hand-heart' },
  headline: { label: 'Headline' },
  pages: { label: 'Pages', icon: 'i-lucide-files' },
  locations: { label: 'Locations', icon: 'i-lucide-map-pin' },
  products: { label: 'Products', icon: 'i-lucide-package' },
  materials: { label: 'Tools and supplies', icon: 'i-lucide-wrench' },
  destination: { label: 'Destination', icon: 'i-lucide-navigation' },
  calculator: { label: 'Calculator', icon: 'i-lucide-calculator' },
  image: { label: 'Image', icon: 'i-lucide-image' },
  icon: { label: 'Icon', icon: 'i-lucide-shapes' },
  link: { label: 'Link' },
  posts: { label: 'Posts', icon: 'i-lucide-megaphone' },
  video: { label: 'Video', icon: 'i-lucide-video' },
  search: { label: 'Search results', icon: 'i-lucide-search' },
}

const COLLECTIONS = new Set<TenantPageBlockCollection>(['items', 'buttons', 'steps', 'tiers'])

/**
 * A block's sections are the distinct `section` values its fields declare, in
 * declaration order. They used to be a second hand-written table beside the
 * registry, which is how a block could grow a field the editor never showed.
 */
function blockSections(type: TenantPageBlockType): readonly TenantPageBlockSection[] {
  const fields = TENANT_PAGE_BLOCK_REGISTRY[type]?.fields ?? {}
  const sections: TenantPageBlockSection[] = []
  for (const [key, field] of Object.entries(fields)) {
    const sectionKey = field.section ?? 'content'
    const existing = sections.find(section => section.key === sectionKey)
    const isList = field.kind === 'list' && COLLECTIONS.has(key as TenantPageBlockCollection)
    if (existing) {
      // A section browses a collection when any field in it is one.
      if (isList && !existing.collection) {
        existing.kind = 'list'
        existing.collection = key as TenantPageBlockCollection
        existing.label = SECTION_PRESENTATION[key]?.label ?? field.label
        existing.icon = SECTION_PRESENTATION[key]?.icon
      }
      continue
    }
    sections.push({
      key: isList ? key : sectionKey,
      label: SECTION_PRESENTATION[isList ? key : sectionKey]?.label ?? field.label,
      icon: SECTION_PRESENTATION[isList ? key : sectionKey]?.icon,
      kind: isList ? 'list' : 'leaf',
      ...(isList ? { collection: key as TenantPageBlockCollection } : {}),
      ...(field.availableWhen?.field === 'source' ? { sources: field.availableWhen.equals } : {}),
    })
  }
  return sections
}

const BLOCK_SECTIONS: Record<TenantPageBlockType, readonly TenantPageBlockSection[]> = Object.fromEntries(
  (Object.keys(TENANT_PAGE_BLOCK_REGISTRY) as TenantPageBlockType[]).map(type => [type, blockSections(type)]),
) as Record<TenantPageBlockType, readonly TenantPageBlockSection[]>

/** An unset `source` means the block authors its own rows. */
export function tenantPageBlockSource(block: TenantPageBlock): string {
  const value = block.data.source
  return typeof value === 'string' && value.trim() ? value : 'manual'
}

/** The sections this block actually has, given what it currently stores. */
export function tenantPageBlockSections(block: TenantPageBlock): readonly TenantPageBlockSection[] {
  const sections = BLOCK_SECTIONS[block.type] ?? []
  const source = tenantPageBlockSource(block)
  return sections.filter(section => !section.sources || section.sources.includes(source))
}

/**
 * A block with two or more sections routes onward; one section renders in place
 * at the block's own level, because a lone row that opens the only thing below
 * it is a level that says nothing.
 */
export function tenantPageBlockIsHub(block: TenantPageBlock): boolean {
  return tenantPageBlockSections(block).length > 1
}

export function tenantPageBlockLabel(type: string): string {
  return TENANT_PAGE_BLOCK_REGISTRY[type as TenantPageBlockType]?.label ?? type
}

/** How one record of a nested collection is named in its list and its heading. */
export const TENANT_PAGE_RECORD_NOUNS: Record<TenantPageBlockCollection, { one: string; add: string }> = {
  items: { one: 'Item', add: 'Add an item' },
  buttons: { one: 'Button', add: 'Add a button' },
  steps: { one: 'Step', add: 'Add a step' },
  tiers: { one: 'Tier', add: 'Add a tier' },
}

/** One concern of a record inside a nested collection. */
export interface TenantPageRecordSection {
  key: string
  label: string
}

const GRID_ITEM_SECTIONS: readonly TenantPageRecordSection[] = [
  { key: 'copy', label: 'Copy' },
  { key: 'image', label: 'Image' },
  { key: 'link', label: 'Link' },
]

const FEATURE_ITEM_SECTIONS: readonly TenantPageRecordSection[] = [
  { key: 'copy', label: 'Copy' },
  { key: 'icon', label: 'Icon' },
  { key: 'image', label: 'Image' },
  { key: 'link', label: 'Link' },
]

const SHOWCASE_ITEM_SECTIONS: readonly TenantPageRecordSection[] = [
  { key: 'copy', label: 'Statement' },
  { key: 'pictures', label: 'Pictures' },
]

const LANGUAGE_ITEM_SECTIONS: readonly TenantPageRecordSection[] = [
  { key: 'copy', label: 'Language' },
  { key: 'image', label: 'Picture' },
]

const STEP_ITEM_SECTIONS: readonly TenantPageRecordSection[] = [
  { key: 'copy', label: 'Step' },
]

const PERSON_SECTIONS: readonly TenantPageRecordSection[] = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'bio', label: 'Bio' },
  { key: 'photo', label: 'Photo' },
]

/**
 * A record with one concern is a leaf and has no sections of its own — a button
 * is a label and where it goes, and asking for those on two screens would be a
 * level that carries nothing. A grid item or a person has several, so it is a
 * hub like anything else that does.
 */
export function tenantPageRecordSections(
  blockType: TenantPageBlockType,
  collection: TenantPageBlockCollection,
): readonly TenantPageRecordSection[] {
  if (collection !== 'items') return []
  if (blockType === 'team_grid') return PERSON_SECTIONS
  if (blockType === 'feature_grid') return FEATURE_ITEM_SECTIONS
  if (blockType === 'showcase') return SHOWCASE_ITEM_SECTIONS
  if (blockType === 'language_reach') return LANGUAGE_ITEM_SECTIONS
  if (blockType === 'steps') return STEP_ITEM_SECTIONS
  return GRID_ITEM_SECTIONS
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

/** Names one record in its list, its heading and its control labels. */
export function tenantPageRecordTitle(
  record: Record<string, unknown>,
  blockType: TenantPageBlockType,
  collection: TenantPageBlockCollection,
  index: number,
): string {
  const fallback = `${TENANT_PAGE_RECORD_NOUNS[collection].one} ${index + 1}`
  if (collection === 'buttons') return text(record.label) || fallback
  if (collection === 'steps') return text(record.name) || fallback
  if (collection === 'tiers') return text(record.title) || text(record.amount) || fallback
  if (blockType === 'team_grid') {
    return [text(record.first_name), text(record.last_name)].filter(Boolean).join(' ') || fallback
  }
  return text(record.title) || text(record.name) || fallback
}

/**
 * The controls one leaf shows: the fields declaring that section, in
 * declaration order, minus the lists (a list section browses records instead).
 *
 * A section is one concern of the block, and its fields are the controls that
 * answer it.
 */
export function tenantPageBlockFieldsForSection(
  block: TenantPageBlock,
  sectionKey: string,
): Array<{ key: string; field: TenantPageField }> {
  const fields = TENANT_PAGE_BLOCK_REGISTRY[block.type]?.fields ?? {}
  const source = tenantPageBlockSource(block)
  const entries = Object.entries(fields)
    .filter(([key, field]) => {
      if (field.kind === 'list' && COLLECTIONS.has(key as TenantPageBlockCollection)) return false
      if ((field.section ?? 'content') !== sectionKey) return false
      return !field.availableWhen || field.availableWhen.equals.includes(String(block.data[field.availableWhen.field] ?? source))
    })
    .map(([key, field]) => ({ key, field }))
  return entries
}
