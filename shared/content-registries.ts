import { TENANT_PAGE_BLOCK_REGISTRY, type TenantPageBlockType, type TenantPageField } from '../utils/tenant-page-blocks'
import { PRICING_CALCULATOR_SCHEMA } from '../utils/blawby-pricing'

export const CONTENT_DOCUMENT_KINDS = [
  'page',
  'article',
  'social_post',
  'qa',
] as const

export type ContentDocumentKind = typeof CONTENT_DOCUMENT_KINDS[number]

export const PUBLICATION_CONTENT_BLOCK_TYPES = [
  'heading',
  'markdown',
  'image',
  'gallery',
  'video',
  'faq',
  'how_to',
  'divider',
  'ai_assistance',
  'cta',
  'callout',
] as const

export type PublicationContentBlockType = typeof PUBLICATION_CONTENT_BLOCK_TYPES[number]

export type LocalizedContentFieldSegment = string | '*'

/** Plain text is interpolated; Markdown is parsed and sanitized. */
export type ContentTextFormat = 'plain' | 'markdown'

export interface ContentBlockTextField {
  /** Path into the block's data. `*` walks every element of an array. */
  readonly path: readonly LocalizedContentFieldSegment[]
  readonly format: ContentTextFormat
}

/** The block registry owns the text fields shared by authoring and localization. */
function blockTextFields(fields: Readonly<Record<string, TenantPageField>>, prefix: LocalizedContentFieldSegment[] = []): ContentBlockTextField[] {
  const collected: ContentBlockTextField[] = []
  for (const [key, field] of Object.entries(fields)) {
    if (field.kind === 'list') {
      // A list of records describes its item's fields; a list of plain strings
      // is itself the text — how_to's tools and supplies are the latter.
      if (field.of) collected.push(...blockTextFields(field.of, [...prefix, key, '*']))
      else if (field.translatable !== false) collected.push({ path: [...prefix, key, '*'], format: 'plain' })
      continue
    }
    // A record is one object of named fields — a button's label and url.
    if (field.kind === 'record') {
      if (field.of) collected.push(...blockTextFields(field.of, [...prefix, key]))
      continue
    }
    if (field.kind !== 'text' && field.kind !== 'markdown') continue
    if (field.translatable === false) continue
    collected.push({ path: [...prefix, key], format: field.kind === 'markdown' ? 'markdown' : 'plain' })
  }
  return collected
}

export const CONTENT_BLOCK_TEXT_FIELDS = Object.fromEntries(
  Object.entries(TENANT_PAGE_BLOCK_REGISTRY).map(([type, definition]) => [type, blockTextFields(definition.fields)]),
) as unknown as Record<ContentBlockType, readonly ContentBlockTextField[]>

// This is the publication block contract for tenant-authored text. Structural
// fields, URLs, flags, and media references are intentionally absent.
export const PUBLICATION_CONTENT_BLOCK_LOCALIZED_FIELDS = Object.fromEntries(
  PUBLICATION_CONTENT_BLOCK_TYPES.map(type => [type, CONTENT_BLOCK_TEXT_FIELDS[type].map(field => field.path)]),
) as unknown as Record<PublicationContentBlockType, ReadonlyArray<readonly LocalizedContentFieldSegment[]>>

export const CONTENT_BLOCK_TYPES = Object.keys(TENANT_PAGE_BLOCK_REGISTRY) as readonly TenantPageBlockType[]

export type ContentBlockType = TenantPageBlockType

export const LOCALIZED_RESOURCE_TYPES = [
  'organization', 'business_location', 'product', 'collection', 'article_category', 'media_asset',
] as const

export type LocalizedResourceType = typeof LOCALIZED_RESOURCE_TYPES[number]

export type ContentFieldPath = ReadonlyArray<string | number>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Resolves one declared field pattern against a block's data, expanding `*`
 * into the indices the array actually holds. A pattern that does not match
 * anything yields nothing rather than an empty slot.
 */
export function expandContentFieldPath(
  data: Record<string, unknown>,
  pattern: readonly LocalizedContentFieldSegment[],
  path: ContentFieldPath = [],
): ContentFieldPath[] {
  const [segment, ...remaining] = pattern
  if (segment === undefined) return [path]
  if (segment !== '*') return expandContentFieldPath(data, remaining, [...path, segment])
  const collection = readContentFieldValue(data, path)
  if (!Array.isArray(collection)) return []
  return collection.flatMap((_, index) => expandContentFieldPath(data, remaining, [...path, index]))
}

export function readContentFieldValue(data: Record<string, unknown>, path: ContentFieldPath): unknown {
  let value: unknown = data
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value)) return undefined
      value = value[segment]
    } else {
      if (!isRecord(value)) return undefined
      value = value[segment]
    }
  }
  return value
}

/** JSON Schema comes from the same field registry the editor and writer use. */
function fieldSchema(key: string, field: TenantPageField): Record<string, unknown> {
  if (field.kind === 'record') return fieldsSchema(field.of ?? {})
  if (field.kind === 'list') return { type: 'array', ...(field.min !== undefined ? { minItems: field.min } : {}), items: field.of ? fieldsSchema(field.of) : { type: 'string' } }
  if (field.kind === 'number') return { type: 'integer', ...(field.min !== undefined ? { minimum: field.min } : {}), ...(field.max !== undefined ? { maximum: field.max } : {}) }
  if (field.kind === 'reference' && key.endsWith('_ids')) return { type: 'array', ...(field.min !== undefined ? { minItems: field.min } : {}), items: { type: 'string', minLength: 1, pattern: '\\S' }, uniqueItems: true }
  if (field.kind === 'calculator') return PRICING_CALCULATOR_SCHEMA
  return { type: field.required ? 'string' : ['string', 'null'], ...(field.options?.length ? { enum: [...field.options.map(option => option.value), ...(!field.required ? [null] : [])] } : {}), ...(field.kind === 'markdown' ? { description: 'Markdown.' } : {}) }
}

function fieldsSchema(fields: Readonly<Record<string, TenantPageField>>): Record<string, unknown> {
  const dataFields = Object.entries(fields).filter(([, field]) => field.kind !== 'media' && field.store !== 'level')
  return { type: 'object', properties: Object.fromEntries(dataFields.map(([key, field]) => [key, fieldSchema(key, field)])),
    required: dataFields.filter(([, field]) => field.required && !field.availableWhen).map(([key]) => key), additionalProperties: false }
}

const blockDataDefinitions = Object.fromEntries(
  CONTENT_BLOCK_TYPES.map(type => [`content_${type}`, fieldsSchema(TENANT_PAGE_BLOCK_REGISTRY[type].fields)]),
)

export function contentBlockDataSchema(type: ContentBlockType) {
  return { $ref: `#/$defs/content_${type}` }
}

/** Include each referenced block contract once at the tool schema root. */
export function contentBlockSchemaDefinitions(schema: unknown, knownDefinitions: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const definitions: Record<string, unknown> = {}
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!isRecord(value)) return
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
      const name = value.$ref.slice('#/$defs/'.length)
      if (name.startsWith('content_') || Object.hasOwn(knownDefinitions, name)) {
        const definition = Object.hasOwn(knownDefinitions, name) ? knownDefinitions[name] : blockDataDefinitions[name]
        if (!definition) throw new Error(`Unknown block schema ${name}`)
        if (!Object.hasOwn(definitions, name)) {
          definitions[name] = definition
          visit(definition)
        }
      }
    }
    Object.values(value).forEach(visit)
  }
  visit(schema)
  return definitions
}
