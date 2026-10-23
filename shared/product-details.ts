import { PRODUCT_LIMITS } from './product-limits.ts'
import { STAY_SAFETY_DETAIL_FIELDS, STAY_SAFETY_FIELDS, STAY_SAFETY_DETAIL_KEYS } from './stay-safety.ts'
import { STAY_ALARM_AMENITIES, STAY_ALARM_DETAIL_KEYS, stayAmenityAvailability, type StayAmenityAnswer } from './stay-listing.ts'

/** Named product facts shared by validation, CMS, MCP, localization and templates. */
export const PRODUCT_KINDS = ['dish', 'experience', 'service', 'item', 'stay'] as const
export const PRODUCT_KIND_LABELS = { dish: 'Food or drink', experience: 'Experience or class', service: 'Practice area or consultation', item: 'Physical item', stay: 'Place to stay' } as const
export type ProductKind = typeof PRODUCT_KINDS[number]
/** The recognizable kind choices used by the CMS. */
export const PRODUCT_KIND_ICONS = {
  dish: 'i-lucide-utensils', experience: 'i-lucide-compass', service: 'i-lucide-scale', item: 'i-lucide-package', stay: 'i-lucide-house',
} as const satisfies Record<ProductKind, string>
export type ProductDetailValue = string | string[] | boolean
export type ProductDetails = Partial<Record<ProductDetailKey, ProductDetailValue>>
/** In an explicit merge, null removes only the named fact. */
export type ProductDetailsPatch = Partial<Record<ProductDetailKey, ProductDetailValue | null>>

export function validateStayAlarmDetails(details: Readonly<Record<string, unknown>>, answers: readonly StayAmenityAnswer[]): void {
  for (const code of STAY_ALARM_AMENITIES) {
    if (details[STAY_ALARM_DETAIL_KEYS[code]] !== undefined && stayAmenityAvailability(answers, code) !== true) throw new ProductDetailError(`details.${STAY_ALARM_DETAIL_KEYS[code]} requires the ${code} amenity to be present`)
  }
}

/** A translation cannot restore details cleared from the source alarm fact. */
export function projectStayAlarmDetails<T extends Record<string, unknown>>(details: T, source: Readonly<Record<string, unknown>>, answers: readonly StayAmenityAnswer[]): T {
  const projected = { ...details }
  for (const code of STAY_ALARM_AMENITIES) if (stayAmenityAvailability(answers, code) !== true || typeof source[STAY_ALARM_DETAIL_KEYS[code]] !== 'string') Reflect.deleteProperty(projected, STAY_ALARM_DETAIL_KEYS[code])
  return projected
}
export interface ProductDetailField {
  id: string
  key: ProductDetailKey
  name: string
  description: string
  /** A pictogram for a recognizable domain concern, rather than a scalar field. */
  icon?: string
  value_type: 'single_line_text' | 'multi_line_text' | 'list.single_line_text' | 'boolean'
  validations: { max_length?: number; max_items?: number; choices?: string[] }
  localizable: boolean
  kinds: readonly ProductKind[]
}
/** Public house rules. A missing choice means the host has not said. */
export const STAY_HOUSE_RULE_TOGGLES = {
  pets_allowed: { name: 'Pets allowed', description: 'Let guests know if they can bring pets.', allowedLabel: 'Pets allowed', disallowedLabel: 'No pets', value_type: 'boolean', kinds: ['stay'] },
  events_allowed: { name: 'Events allowed', description: 'Whether guests may host events at the property.', allowedLabel: 'Events allowed', disallowedLabel: 'No events', value_type: 'boolean', kinds: ['stay'] },
  smoking_allowed: { name: 'Smoking, vaping, e-cigarettes allowed', description: 'Whether guests may smoke or vape at the property.', allowedLabel: 'Smoking, vaping and e-cigarettes allowed', disallowedLabel: 'No smoking, vaping or e-cigarettes', value_type: 'boolean', kinds: ['stay'] },
  quiet_hours: { name: 'Quiet hours', description: 'Hours when guests should keep noise to a minimum.', allowedLabel: 'Quiet hours', disallowedLabel: 'No quiet hours', value_type: 'boolean', kinds: ['stay'] },
  commercial_photography_allowed: { name: 'Commercial photography and filming allowed', description: 'Whether guests may take commercial photos or film at the property.', allowedLabel: 'Commercial photography and filming allowed', disallowedLabel: 'No commercial photography or filming', value_type: 'boolean', kinds: ['stay'] },
} as const
export const STAY_QUIET_HOUR_TIMES = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)

const DETAIL_FIELDS = {
  pricing_note: { name: 'Price wording', description: 'An explicitly stated price such as Market price; use only when no numeric price is set.', value_type: 'single_line_text', kinds: PRODUCT_KINDS },
  tagline: { name: 'Short introduction', description: 'A short sentence shown below the product title.', value_type: 'single_line_text', kinds: PRODUCT_KINDS },
  featured: { name: 'Featured', description: 'Highlight this item on the menu and homepage.', value_type: 'boolean', kinds: PRODUCT_KINDS },
  dietary_notes: { icon: 'i-lucide-leaf', name: 'Dietary information', description: 'Merchant-stated dietary facts displayed with a dish.', value_type: 'list.single_line_text', kinds: ['dish'] },
  allergens: { icon: 'i-lucide-triangle-alert', name: 'Allergens', description: 'Allergens the merchant states this dish contains.', value_type: 'list.single_line_text', kinds: ['dish'] },
  ingredients: { icon: 'i-lucide-carrot', name: 'Ingredients', description: 'Ingredients shown in the dish details.', value_type: 'list.single_line_text', kinds: ['dish'] },
  noodle: { icon: 'i-lucide-soup', name: 'Noodles', description: 'Authored noodle information shown as dish facts; these do not establish purchasable variants.', value_type: 'list.single_line_text', kinds: ['dish'] },
  sizes: { icon: 'i-lucide-ruler', name: 'Serving sizes', description: 'Authored serving information; priced choices belong in variants.', value_type: 'list.single_line_text', kinds: ['dish'] },
  soup: { icon: 'i-lucide-soup', name: 'Soup', description: 'Authored soup information shown with the dish.', value_type: 'list.single_line_text', kinds: ['dish'] },
  toppings: { icon: 'i-lucide-salad', name: 'Toppings', description: 'Authored topping information; priced choices belong in variants.', value_type: 'list.single_line_text', kinds: ['dish'] },
  meeting_point: { icon: 'i-lucide-map-pin', name: 'Where to meet', description: 'Instructions shown in the meeting section; meeting mode and video links are set in scheduling.', value_type: 'multi_line_text', kinds: ['experience', 'service'] },
  included_items: { icon: 'i-lucide-package-check', name: 'What is included', description: 'Items or work included in the stated price, shown in their own public section.', value_type: 'list.single_line_text', kinds: ['experience', 'service'] },
  what_to_bring: { icon: 'i-lucide-backpack', name: 'What to bring', description: 'Items customers should bring, shown in the preparation section.', value_type: 'list.single_line_text', kinds: ['experience', 'service'] },
  preparation: { icon: 'i-lucide-clipboard-check', name: 'Before you arrive', description: 'Preparation instructions shown to customers before a session or appointment.', value_type: 'multi_line_text', kinds: ['experience', 'service'] },
  cancellation_policy: { icon: 'i-lucide-calendar-x', name: 'Cancellation policy', description: 'The merchant’s stated cancellation terms, displayed publicly; this text does not automate refunds.', value_type: 'multi_line_text', kinds: ['experience', 'service'] },
  your_property: { name: 'Your property', description: 'The spaces and features guests should know about this home.', value_type: 'multi_line_text', kinds: ['stay'] },
  guest_access: { name: 'Guest access', description: 'The spaces and facilities guests can use during their stay.', value_type: 'multi_line_text', kinds: ['stay'] },
  interaction_with_guests: { name: 'Interaction with guests', description: 'How guests can contact the host and what support is available.', value_type: 'multi_line_text', kinds: ['stay'] },
  other_details_to_note: { name: 'Other details to note', description: 'Additional information guests should know before booking.', value_type: 'multi_line_text', kinds: ['stay'] },
  neighborhood_description: { name: 'Neighborhood description', description: 'Host-authored information about the neighborhood around this home.', value_type: 'multi_line_text', kinds: ['stay'], localizable: true, validations: { max_length: PRODUCT_LIMITS.description } },
  getting_around: { name: 'Getting around', description: 'Host-authored transport and getting-around information for this home.', value_type: 'multi_line_text', kinds: ['stay'], localizable: true, validations: { max_length: PRODUCT_LIMITS.description } },
  house_rules: { icon: 'i-lucide-notebook-pen', name: 'House rules', description: 'The host’s rules for guests staying in the home, shown with the listing.', value_type: 'multi_line_text', kinds: ['stay'] },
  ...STAY_HOUSE_RULE_TOGGLES,
  quiet_hours_start: { name: 'Quiet hours start time', description: 'Local start of quiet hours, required with quiet hours and its end time.', value_type: 'single_line_text', localizable: false, validations: { choices: STAY_QUIET_HOUR_TIMES }, kinds: ['stay'] },
  quiet_hours_end: { name: 'Quiet hours end time', description: 'Local end of quiet hours, required with quiet hours and its start time.', value_type: 'single_line_text', localizable: false, validations: { choices: STAY_QUIET_HOUR_TIMES }, kinds: ['stay'] },
  ...STAY_SAFETY_DETAIL_FIELDS,
  materials: { icon: 'i-lucide-layers', name: 'Materials', description: 'Materials the item is made from, shown in its details.', value_type: 'list.single_line_text', kinds: ['item'] },
  dimensions: { icon: 'i-lucide-ruler', name: 'Dimensions', description: 'Item measurements including their units, shown in its details.', value_type: 'single_line_text', kinds: ['item'] },
  care_instructions: { icon: 'i-lucide-hand-heart', name: 'Care instructions', description: 'How to care for the item, shown in its details.', value_type: 'multi_line_text', kinds: ['item'] },
} as const
export type ProductDetailKey = keyof typeof DETAIL_FIELDS
/** The additional sections of a home's Description; its introduction is Product.description. */
export const STAY_DESCRIPTION_DETAIL_KEYS = ['your_property', 'guest_access', 'interaction_with_guests', 'other_details_to_note'] as const satisfies readonly ProductDetailKey[]
export const STAY_LOCATION_DETAIL_KEYS = ['neighborhood_description', 'getting_around'] as const satisfies readonly ProductDetailKey[]
export const STAY_HOUSE_RULE_DETAIL_KEYS = [...Object.keys(STAY_HOUSE_RULE_TOGGLES) as Array<keyof typeof STAY_HOUSE_RULE_TOGGLES>, 'quiet_hours_start', 'quiet_hours_end', 'house_rules'] as const satisfies readonly ProductDetailKey[]
const STAY_FOCUSED_DETAIL_KEYS: ReadonlySet<string> = new Set([...STAY_DESCRIPTION_DETAIL_KEYS, ...STAY_HOUSE_RULE_DETAIL_KEYS, ...STAY_LOCATION_DETAIL_KEYS, ...STAY_SAFETY_DETAIL_KEYS])
export function isStayFocusedDetail(key: string): boolean { return STAY_FOCUSED_DETAIL_KEYS.has(key) }
export const PRODUCT_DETAIL_FIELDS: readonly ProductDetailField[] = Object.entries(DETAIL_FIELDS).map(([key, field]) => ({ ...field, id: key, key: key as ProductDetailKey, localizable: 'localizable' in field ? field.localizable : field.value_type !== 'boolean', validations: 'validations' in field ? field.validations : {} }))
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
  if (kind === 'stay' && !localizableOnly) {
    if (result.quiet_hours === true && (result.quiet_hours_start === undefined || result.quiet_hours_end === undefined)) throw new ProductDetailError('Quiet hours need both a start time and an end time')
    if (result.quiet_hours !== true && (result.quiet_hours_start !== undefined || result.quiet_hours_end !== undefined)) throw new ProductDetailError('Quiet hours must be enabled before setting their start and end times')
    for (const [key, field] of Object.entries(STAY_SAFETY_FIELDS)) {
      if (result[field.detailsKey] !== undefined && result[key as keyof typeof STAY_SAFETY_FIELDS] !== true) throw new ProductDetailError(`details.${field.detailsKey} requires details.${key} to be true`)
    }
  }
  return result
}

/** The canonical detail update: replacement by default, or an explicit focused merge. */
export function patchProductDetails(kind: ProductKind, current: ProductDetails, patch?: ProductDetailsPatch, mode?: 'merge' | 'replace'): ProductDetails {
  if (mode !== undefined && mode !== 'merge' && mode !== 'replace') throw new ProductDetailError('details_mode must be merge or replace')
  if (patch === undefined) {
    if (mode !== undefined) throw new ProductDetailError('details_mode requires details')
    return validateProductDetails(kind, current)
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProductDetailError('details must be an object')
  if (mode !== 'merge') return validateProductDetails(kind, { featured: current.featured ?? false, ...patch })
  const fields = new Set(productDetailFields(kind).map(field => field.key))
  const merged = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!fields.has(key as ProductDetailKey)) throw new ProductDetailError(`details.${key} is not a field for ${kind}`)
    if (value === null) Reflect.deleteProperty(merged, key)
    else merged[key as ProductDetailKey] = value
  }
  return validateProductDetails(kind, merged)
}

/** One authored rule projection for the listing, saved summaries and team guide. */
export function stayHouseRuleLines(details: ProductDetails, clock: (value: string) => string): string[] {
  const lines: string[] = []
  for (const [key, rule] of Object.entries(STAY_HOUSE_RULE_TOGGLES)) {
    const value = details[key as keyof typeof STAY_HOUSE_RULE_TOGGLES]
    if (typeof value !== 'boolean') continue
    if (key === 'quiet_hours' && value) {
      if (typeof details.quiet_hours_start !== 'string' || typeof details.quiet_hours_end !== 'string') throw new ProductDetailError('Quiet hours need both a start time and an end time')
      lines.push(`${rule.allowedLabel}: ${clock(details.quiet_hours_start)} – ${clock(details.quiet_hours_end)}`)
    } else lines.push(value ? rule.allowedLabel : rule.disallowedLabel)
  }
  if (typeof details.house_rules === 'string') lines.push(details.house_rules)
  return lines
}

export class ProductDetailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductDetailError'
  }
}

const DEFAULT_TEXT_MAX_LENGTH = 1_000
const DEFAULT_MULTILINE_MAX_LENGTH = PRODUCT_LIMITS.description
const DEFAULT_LIST_MAX_ITEMS = 100

export function productDetailsSchema(kind?: ProductKind, localizableOnly = false, clearable = false): Record<string, unknown> {
  const fields = kind ? productDetailFields(kind) : PRODUCT_DETAIL_FIELDS
  return { type: 'object', additionalProperties: false, properties: Object.fromEntries(fields.filter(field => !localizableOnly || field.localizable).map(field => {
    if (field.value_type === 'boolean') return [field.key, { type: clearable ? ['boolean', 'null'] : 'boolean', description: field.description }]
    const multiline = field.value_type === 'multi_line_text'
    const text = { type: 'string', minLength: 1,
      maxLength: field.validations.max_length ?? (multiline ? DEFAULT_MULTILINE_MAX_LENGTH : DEFAULT_TEXT_MAX_LENGTH),
      pattern: multiline ? '\\S' : '^(?=[\\s\\S]*\\S)[^\\r\\n]*$',
      ...(field.validations.choices ? { enum: field.validations.choices } : {}),
    }
    const value = { ...(field.value_type === 'list.single_line_text'
      ? { type: 'array', maxItems: field.validations.max_items ?? DEFAULT_LIST_MAX_ITEMS, uniqueItems: true, items: text }
      : text), description: field.description }
    return [field.key, clearable ? { anyOf: [value, { type: 'null' }], description: field.description } : value]
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
