/** Named product facts shared by validation, CMS, MCP, localization and templates. */
export const PRODUCT_KINDS = ['dish', 'experience', 'service', 'item', 'stay'] as const
export const PRODUCT_KIND_LABELS = { dish: 'Food or drink', experience: 'Experience or class', service: 'Service or appointment', item: 'Physical item', stay: 'Place to stay' } as const
export type ProductKind = typeof PRODUCT_KINDS[number]
export type ProductDetailValue = string | string[] | boolean
export type ProductDetails = Partial<Record<ProductDetailKey, ProductDetailValue>>
export interface ProductDetailField {
  id: string
  key: ProductDetailKey
  name: string
  description: string
  value_type: 'single_line_text' | 'multi_line_text' | 'list.single_line_text' | 'boolean'
  validations: { max_length?: number; max_items?: number; choices?: string[] }
  localizable: boolean
  kinds: readonly ProductKind[]
}
const DETAIL_FIELDS = {
  pricing_note: { name: 'Price wording', description: 'An explicitly stated price such as Market price; use only when no numeric price is set.', value_type: 'single_line_text', kinds: PRODUCT_KINDS },
  tagline: { name: 'Short introduction', description: 'A short sentence shown below the product title.', value_type: 'single_line_text', kinds: PRODUCT_KINDS },
  featured: { name: 'Featured', description: 'Highlight this item on the menu and homepage.', value_type: 'boolean', kinds: PRODUCT_KINDS },
  dietary_notes: { name: 'Dietary information', description: 'Merchant-stated dietary facts displayed with a dish.', value_type: 'list.single_line_text', kinds: ['dish'] },
  allergens: { name: 'Allergens', description: 'Allergens the merchant states this dish contains.', value_type: 'list.single_line_text', kinds: ['dish'] },
  ingredients: { name: 'Ingredients', description: 'Ingredients shown in the dish details.', value_type: 'list.single_line_text', kinds: ['dish'] },
  noodle: { name: 'Noodles', description: 'Authored noodle information shown as dish facts; these do not establish purchasable variants.', value_type: 'list.single_line_text', kinds: ['dish'] },
  sizes: { name: 'Serving sizes', description: 'Authored serving information; priced choices belong in variants.', value_type: 'list.single_line_text', kinds: ['dish'] },
  soup: { name: 'Soup', description: 'Authored soup information shown with the dish.', value_type: 'list.single_line_text', kinds: ['dish'] },
  toppings: { name: 'Toppings', description: 'Authored topping information; priced choices belong in variants.', value_type: 'list.single_line_text', kinds: ['dish'] },
  meeting_point: { name: 'Where to meet', description: 'Instructions shown in the meeting section; meeting mode and video links are set in scheduling.', value_type: 'multi_line_text', kinds: ['experience', 'service'] },
  included_items: { name: 'What is included', description: 'Items or work included in the stated price, shown in their own public section.', value_type: 'list.single_line_text', kinds: ['experience', 'service'] },
  what_to_bring: { name: 'What to bring', description: 'Items customers should bring, shown in the preparation section.', value_type: 'list.single_line_text', kinds: ['experience', 'service'] },
  preparation: { name: 'Before you arrive', description: 'Preparation instructions shown to customers before a session or appointment.', value_type: 'multi_line_text', kinds: ['experience', 'service'] },
  cancellation_policy: { name: 'Cancellation policy', description: 'The merchant’s stated cancellation terms, displayed publicly; this text does not automate refunds.', value_type: 'multi_line_text', kinds: ['experience', 'service', 'stay'] },
  house_rules: { name: 'House rules', description: 'The host’s rules for guests staying in the home, shown with the listing.', value_type: 'multi_line_text', kinds: ['stay'] },
  amenities: { name: 'Amenities', description: 'What the home offers guests, such as Wifi or a kitchen.', value_type: 'list.single_line_text', kinds: ['stay'] },
  materials: { name: 'Materials', description: 'Materials the item is made from, shown in its details.', value_type: 'list.single_line_text', kinds: ['item'] },
  dimensions: { name: 'Dimensions', description: 'Item measurements including their units, shown in its details.', value_type: 'single_line_text', kinds: ['item'] },
  care_instructions: { name: 'Care instructions', description: 'How to care for the item, shown in its details.', value_type: 'multi_line_text', kinds: ['item'] },
} as const
export type ProductDetailKey = keyof typeof DETAIL_FIELDS
export const PRODUCT_DETAIL_FIELDS: readonly ProductDetailField[] = Object.entries(DETAIL_FIELDS).map(([key, field]) => ({ ...field, id: key, key: key as ProductDetailKey, localizable: field.value_type !== 'boolean', validations: {} }))
export const PRICING_NOTE_HANDLE = 'pricing_note'
export const EXPERIENCE_ATTRIBUTE_HANDLES = { tagline: 'tagline', meetingPoint: 'meeting_point', includedItems: 'included_items', whatToBring: 'what_to_bring' } as const
export function productDetailFields(kind: ProductKind): ProductDetailField[] {
  return PRODUCT_DETAIL_FIELDS.filter(field => field.kinds.includes(kind))
}
export function productDetailKey(field: Pick<ProductDetailField, 'key'>): ProductDetailKey { return field.key }
export function isProductDetailLocalizable(field: ProductDetailField): boolean { return field.localizable }
export function assertProductKind(value: unknown): ProductKind {
  if (typeof value !== 'string' || !PRODUCT_KINDS.includes(value as ProductKind)) throw new ProductDetailError('kind must be dish, experience, service, item or stay')
  return value as ProductKind
}
export function validateProductDetails(kind: ProductKind, value: unknown, localizableOnly = false): ProductDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductDetailError('details must be an object')
  const fields = new Map(productDetailFields(kind).filter(field => !localizableOnly || field.localizable).map(field => [field.key, field]))
  const result: ProductDetails = localizableOnly ? {} : { featured: false }
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.get(key as ProductDetailKey)
    if (!field) throw new ProductDetailError(`details.${key} is not a field for ${kind}`)
    result[field.key] = validateProductDetailValue(field, entry)
  }
  return result
}

export class ProductDetailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductDetailError'
  }
}

const DEFAULT_TEXT_MAX_LENGTH = 1_000
const DEFAULT_MULTILINE_MAX_LENGTH = 10_000
const DEFAULT_LIST_MAX_ITEMS = 100

export function productDetailsSchema(kind?: ProductKind, localizableOnly = false): Record<string, unknown> {
  const fields = kind ? productDetailFields(kind) : PRODUCT_DETAIL_FIELDS
  return { type: 'object', additionalProperties: false, properties: Object.fromEntries(fields.filter(field => !localizableOnly || field.localizable).map(field => {
    if (field.value_type === 'boolean') return [field.key, { type: 'boolean', description: field.description }]
    const multiline = field.value_type === 'multi_line_text'
    const text = { type: 'string', minLength: 1,
      maxLength: field.validations.max_length ?? (multiline ? DEFAULT_MULTILINE_MAX_LENGTH : DEFAULT_TEXT_MAX_LENGTH),
      pattern: multiline ? '\\S' : '^(?=[\\s\\S]*\\S)[^\\r\\n]*$',
      ...(field.validations.choices ? { enum: field.validations.choices } : {}),
    }
    return [field.key, { ...(field.value_type === 'list.single_line_text'
      ? { type: 'array', maxItems: field.validations.max_items ?? DEFAULT_LIST_MAX_ITEMS, uniqueItems: true, items: text }
      : text), description: field.description }]
  })) }
}

function assertText(value: unknown, rules: ProductDetailField['validations'], fallbackMax: number, label: string): string {
  if (typeof value !== 'string') throw new ProductDetailError(`${label} must be a string`)
  if (value.trim() === '') throw new ProductDetailError(`${label} must not be blank`)
  const max = rules.max_length ?? fallbackMax
  if (value.length > max) throw new ProductDetailError(`${label} must be at most ${max} characters`)
  if (rules.choices && !rules.choices.includes(value)) {
    throw new ProductDetailError(`${label} must be one of: ${rules.choices.join(', ')}`)
  }
  return value
}

/**
 * The single validation implementation. Imports, CMS, MCP, onboarding and
 * every other mutation path call this — there is no second copy that accepts
 * a value this one would reject.
 */
export function validateProductDetailValue(definition: ProductDetailField, value: unknown): ProductDetailValue {
  const rules = definition.validations
  switch (definition.value_type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new ProductDetailError(`${definition.key} must be a boolean`)
      return value
    case 'single_line_text': {
      const text = assertText(value, rules, DEFAULT_TEXT_MAX_LENGTH, definition.key)
      if (/[\r\n]/.test(text)) throw new ProductDetailError(`${definition.key} must be a single line`)
      return text
    }
    case 'multi_line_text':
      return assertText(value, rules, DEFAULT_MULTILINE_MAX_LENGTH, definition.key)
    case 'list.single_line_text': {
      if (!Array.isArray(value)) throw new ProductDetailError(`${definition.key} must be a list`)
      const max = rules.max_items ?? DEFAULT_LIST_MAX_ITEMS
      if (value.length > max) throw new ProductDetailError(`${definition.key} must have at most ${max} entries`)
      const items = value.map((entry, index) => {
        const text = assertText(entry, rules, DEFAULT_TEXT_MAX_LENGTH, `${definition.key}[${index}]`)
        if (/[\r\n]/.test(text)) throw new ProductDetailError(`${definition.key}[${index}] must be a single line`)
        return text
      })
      if (new Set(items).size !== items.length) throw new ProductDetailError(`${definition.key} entries must be distinct`)
      return items
    }
  }
}
