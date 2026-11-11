import { FAQ_BLOCK_SOURCES, FAQ_BLOCK_SOURCE_LABELS } from '~/shared/faq-block'
import {
  TENANT_PAGE_BLOCK_REGISTRY,
  normalizeTenantPageBlocks,
  type TenantPageBlock,
  type TenantPageBlockType,
} from './tenant-page-blocks'

type EditorData = Record<string, unknown>

export const FAQ_SOURCE_OPTIONS = FAQ_BLOCK_SOURCES.map(value => ({ label: FAQ_BLOCK_SOURCE_LABELS[value], value }))

/**
 * A new block's starting data, derived from what its fields declare.
 *
 * This was a hand-written switch over every type — a fourth copy of the field
 * list, which is how `location_grid` came to seed a `source` key the registry
 * never declared.
 */
export function createTenantPageEditorData(type: TenantPageBlockType): EditorData {
  const fields = TENANT_PAGE_BLOCK_REGISTRY[type]?.fields ?? {}
  const data: EditorData = {}
  for (const [key, field] of Object.entries(fields)) {
    // A block's own column and its media placements are not its data.
    if (field.store === 'level' || field.kind === 'media' || field.kind === 'calculator') continue
    if (field.kind === 'list') data[key] = []
    else if (field.kind === 'reference') data[key] = key.endsWith('_ids') ? [] : ''
    // A number is stored as one; its default is declared as text like every other.
    else if (field.default !== undefined) data[key] = field.kind === 'number' ? Number(field.default) : field.default
    // An enum without a default, or an optional record such as a button, is unset until chosen.
    else if (field.kind === 'enum' || field.kind === 'record') continue
    else data[key] = ''
  }
  return data
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectArray(data: EditorData, key: string): Array<Record<string, unknown>> {
  const value = data[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
}

function stringArray(data: EditorData, key: string): string[] {
  const value = data[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
}

function itemText(item: Record<string, unknown>, key: string, aliases: string[] = []): string {
  for (const candidate of [key, ...aliases]) {
    const value = text(item[candidate])
    if (value) return value
  }
  return ''
}

function addError(errors: string[], message: string) {
  if (!errors.includes(message)) errors.push(message)
}

function validateButtons(errors: string[], data: EditorData, label: string) {
  const buttons = objectArray(data, 'buttons')
  buttons.forEach((button, index) => {
    const buttonLabel = itemText(button, 'label')
    const url = itemText(button, 'url')
    if (!buttonLabel && !url) addError(errors, `${label} ${index + 1} needs a label or URL.`)
    if (buttonLabel && !url) addError(errors, `${label} ${index + 1} needs a URL.`)
    if (url && !buttonLabel) addError(errors, `${label} ${index + 1} needs a label.`)
  })
}

function validateGridItems(errors: string[], data: EditorData, label = 'Item') {
  const items = objectArray(data, 'items')
  items.forEach((item, index) => {
    if (!itemText(item, 'title', ['name'])) addError(errors, `${label} ${index + 1} needs a title.`)
  })
}

/**
 * Whether this block authors its own rows. The registry says so: a grid's
 * `items` field is declared only for the sources that hold items, so there is
 * no second list of which sources read their rows from elsewhere.
 */
function authorsOwnItems(block: TenantPageBlock): boolean {
  const items = TENANT_PAGE_BLOCK_REGISTRY[block.type]?.fields.items
  if (!items) return false
  if (!items.availableWhen) return true
  const controller = TENANT_PAGE_BLOCK_REGISTRY[block.type]!.fields[items.availableWhen.field]
  const value = text(block.data[items.availableWhen.field]) || controller?.default || ''
  return items.availableWhen.equals.includes(value)
}

export function validateTenantPageBlock(block: TenantPageBlock): string[] {
  const errors: string[] = []
  const definition = TENANT_PAGE_BLOCK_REGISTRY[block.type]
  if (!definition) return [`${String(block.type)} is not a registered block type.`]

  try {
    normalizeTenantPageBlocks([block])
  } catch (error) {
    addError(errors, error instanceof Error ? error.message.replace(/^blocks\[0\]\.?/, '') : 'Block data is invalid.')
  }

  const data = block.data
  switch (block.type) {
    case 'heading':
      if (!text(data.text)) addError(errors, 'Heading text is required.')
      break
    case 'markdown':
      if (!text(data.markdown)) addError(errors, 'Rich text is empty.')
      break
    case 'image':
    case 'gallery':
      break
    case 'faq':
      if (authorsOwnItems(block)) {
        const items = objectArray(data, 'items')
        items.forEach((item, index) => {
          if (!itemText(item, 'title', ['question'])) addError(errors, `Question ${index + 1} needs a question.`)
        })
      }
      break
    case 'testimonial_grid':
      break
    case 'cta':
    case 'contact_cta':
    case 'booking_cta':
      if (Boolean(text(data.label)) !== Boolean(text(data.url))) addError(errors, 'CTA label and URL must be provided together.')
      break
    case 'callout':
      validateButtons(errors, data, 'Callout button')
      break
    case 'hero':
      if (Boolean(text(data.cta_label)) !== Boolean(text(data.cta_url))) addError(errors, 'Hero CTA label and URL must be provided together.')
      break
    case 'button_group':
      validateButtons(errors, data, 'Button')
      break
    case 'social_posts': {
      const action = data.call_to_action && typeof data.call_to_action === 'object' ? data.call_to_action as Record<string, unknown> : null
      if (action && Boolean(text(action.label)) !== Boolean(text(action.url))) addError(errors, 'Button label and URL must be provided together.')
      break
    }
    case 'feature_grid':
    case 'page_grid':
    case 'product_grid':
    case 'location_grid':
      // A grid that names a source renders what that source returns; only a
      // grid that authors its own rows has rows to validate.
      if (authorsOwnItems(block)) validateGridItems(errors, data, 'Grid item')
      // A reference grid names what it shows. There is no "everything on the
      // site" source: a grid that silently grew when a page or product was
      // added is a grid nobody chose the contents of.
      if (block.type === 'page_grid') {
        if (!stringArray(data, 'page_ids').length) addError(errors, 'Choose at least one page.')
        break
      }
      if (block.type === 'product_grid') {
        const hasCollection = Boolean(text(data.collection_id))
        const hasProducts = stringArray(data, 'product_ids').length > 0
        if (hasCollection && hasProducts) addError(errors, 'Choose either a collection or specific products, not both.')
        if (!hasCollection && !hasProducts) addError(errors, 'Choose a collection or at least one product.')
        break
      }
      if (block.type === 'location_grid' && !stringArray(data, 'location_ids').length && !objectArray(data, 'items').length) addError(errors, 'Add at least one location reference or manual item.')
      break
    case 'team_grid':
      objectArray(data, 'items').forEach((item, index) => {
        if (!itemText(item, 'first_name') && !itemText(item, 'last_name')) {
          addError(errors, `Team member ${index + 1} needs a name.`)
        }
      })
      break
    case 'donation_choices':
      if (!text(data.destination)) addError(errors, 'Donation destination is required.')
      objectArray(data, 'tiers').forEach((item, index) => {
        if (!itemText(item, 'amount')) addError(errors, `Donation tier ${index + 1} needs an amount.`)
        if (!itemText(item, 'title')) addError(errors, `Donation tier ${index + 1} needs a title.`)
      })
      break
    case 'divider':
      break
  }

  return errors
}

export function tenantPageBlockSummary(block: TenantPageBlock): string {
  const data = block.data
  const summary = [data.title, data.text, data.eyebrow, data.markdown, data.description]
    .find(value => text(value))
  if (summary) return text(summary).slice(0, 120)
  return TENANT_PAGE_BLOCK_REGISTRY[block.type]?.label ?? 'Block'
}
