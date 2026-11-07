import { localizationError } from './localization-errors.ts'
import { validateProductDetails, assertProductKind, ProductDetailError, productDetailsSchema, type ProductKind } from '../../shared/product-details.ts'

import { LOCALIZED_RESOURCE_TYPES, type LocalizedResourceType } from '../../shared/content-registries.ts'
import { formQuestionLocalizationSchema } from '../../shared/form-questions.ts'
import { hasPublicLocationPages } from '../../utils/site-routing.ts'
export { LOCALIZED_RESOURCE_TYPES, type LocalizedResourceType } from '../../shared/content-registries.ts'

export type LocalizedValues = Record<string, unknown>

// `form_questions` is a question collection's wording, keyed by question and
// choice ID (shared/form-questions.ts); the collection itself is its owner's.
type ValueShape = 'text' | 'string_array' | 'details' | 'form_questions' | { readonly [field: string]: ValueShape }

/**
 * How a localized resource is addressed publicly.
 *
 * - `stored`: the resource has exactly one public route, and the localized
 *   path is stored on its localization row.
 * - `derived`: the resource reaches the public through a location that offers
 *   it, so its localized path is the locale prefix on that location-scoped
 *   route. A Product offered at two locations has two localized routes, and no
 *   single stored path could name both.
 * - `none`: the resource has no route of its own.
 */
type LocalizedRouteAddressing = 'none' | 'stored' | 'derived'

/**
 * How a row of the resource's table is bound to the tenant localizing it.
 *
 * - `self`: the organization row itself; a tenant localizes only itself.
 * - `organization_column`: the row carries the organization it belongs to.
 *
 * There used to be a third, `publication`: a Product had no site column and
 * reached a site through `product_publications`, because one organization could
 * carry several sites. It carries one tenant, so a Product is bound by its own
 * `organization_id` like everything else.
 */
export type ResourceTenantScope = 'self' | 'organization_column'

interface ResourceLocalizationDefinition {
  table: string
  tenantScope: ResourceTenantScope
  fields: Readonly<Record<string, ValueShape>>
  route: LocalizedRouteAddressing
  /** Fields a legal practice's published language must translate: its name and its consultation call to action. */
  publishedLegalPracticeFields?: readonly string[]
}

// The parts of an address that are words. `regionCode` is an ISO code and a
// postcode is digits; neither is translated, and a reader that needs them takes
// them from the location's own address.
const ADDRESS_FIELDS = { addressLines: 'string_array', locality: 'text',
  sublocality: 'text', administrativeArea: 'text' } as const

export const RESOURCE_LOCALIZATION_REGISTRY: Readonly<Record<LocalizedResourceType, ResourceLocalizationDefinition>> = Object.freeze({
  organization: { table: 'organization', tenantScope: 'self', fields: { name: 'text', brand_description: 'text', seo_title: 'text', seo_description: 'text',
    compliance: { service_area: 'text', disclaimer: 'text', footer_disclaimer: 'text' }, consultation: { cta_label: 'text' }, inquiry_questions: 'form_questions' }, route: 'none',
    publishedLegalPracticeFields: ['name', 'consultation.cta_label'] },
  business_location: { table: 'business_locations', tenantScope: 'organization_column', fields: { title: 'text', address: ADDRESS_FIELDS,
    description: 'text', short_description: 'text', seo_title: 'text', seo_description: 'text',
    reservation_questions: 'form_questions' }, route: 'stored' },
  // Product SEO is owned by the canonical content document, so it is not
  // localized here: a second SEO source would be a second thing to keep true.
  product: { table: 'products', tenantScope: 'organization_column', fields: { name: 'text', description: 'text',
    marketing_features: 'string_array', unit_label: 'text', details: 'details', questions: 'form_questions' }, route: 'derived' },
  collection: { table: 'collections', tenantScope: 'organization_column', fields: { name: 'text', description: 'text' }, route: 'none' },
  // A category's page is at its collection's path under the site's locale prefix; its slug is not translated.
  article_category: { table: 'article_categories', tenantScope: 'organization_column', fields: { name: 'text', description: 'text' }, route: 'none' },
  media_asset: { table: 'media_assets', tenantScope: 'organization_column', fields: { alt_text: 'text' }, route: 'none' },
})

function localizedShapeSchema(shape: ValueShape): Record<string, unknown> {
  if (shape === 'text') return { type: 'string' }
  if (shape === 'string_array') return { type: 'array', items: { type: 'string', pattern: '^[\\s\\S]*\\S[\\s\\S]*$' } }
  if (shape === 'details') return productDetailsSchema(undefined, true)
  if (shape === 'form_questions') return {
    type: 'object', description: 'Translated question wording keyed by question ID: { label?, help_text?, choices?: { <choice ID>: label } }.',
    additionalProperties: { type: 'object', properties: { label: { type: 'string' }, help_text: { type: 'string' }, choices: { type: 'object', additionalProperties: { type: 'string' } } }, additionalProperties: false },
  }
  return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, nested]) => [key, localizedShapeSchema(nested)])), additionalProperties: false }
}

export function localizedResourceValuesSchema(resourceType: LocalizedResourceType): Record<string, unknown> {
  return localizedShapeSchema(RESOURCE_LOCALIZATION_REGISTRY[resourceType].fields)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validateDetails(field: string, value: unknown, kind: ProductKind | undefined): void {
  try { validateProductDetails(assertProductKind(kind), value, true) }
  catch (error) {
    if (!(error instanceof ProductDetailError)) throw error
    localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `${field}: ${error.message}`, { field })
  }
}

function validateShape(field: string, value: unknown, shape: ValueShape, kind?: ProductKind): void {
  if (shape === 'text' && typeof value === 'string') return
  if (typeof shape === 'object' && isRecord(value)) {
    if (Object.keys(value).some(key => !Object.hasOwn(shape, key))) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `${field} contains unknown localized fields`, { field })
    for (const [key, nested] of Object.entries(value)) validateShape(`${field}.${key}`, nested, shape[key]!, kind)
    return
  }
  if (shape === 'details') { validateDetails(field, value, kind); return }
  if (shape === 'form_questions') {
    const parsed = formQuestionLocalizationSchema.safeParse(value)
    if (parsed.success) return
    localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `${field}: ${parsed.error.issues[0]!.message}`, { field })
  }
  if (shape === 'string_array') {
    if (Array.isArray(value) && value.every(isNonBlankText)) return
  }
  localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `${field} has an invalid localized value shape`, { field })
}

export function parseLocalizedResourceType(value: unknown): LocalizedResourceType {
  if (typeof value === 'string' && (LOCALIZED_RESOURCE_TYPES as readonly string[]).includes(value)) {
    return value as LocalizedResourceType
  }
  localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Unsupported localized resource type', { resource_type: value })
}

export function validateLocalizedValues(
  resourceType: LocalizedResourceType,
  input: unknown,
  kind?: ProductKind,
  context?: { publishedLegalPractice?: boolean },
): LocalizedValues {
  if (!isRecord(input)) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'values must be an object')
  const definition = RESOURCE_LOCALIZATION_REGISTRY[resourceType]
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(definition.fields, key)).sort()
  if (unknown.length) {
    localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `Unknown localized field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, { fields: unknown })
  }
  for (const [field, shape] of Object.entries(definition.fields)) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    if (value === undefined || value === null) {
      localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `${field} must be omitted instead of null`, { field })
    }
    if (shape === 'text' && typeof value !== 'string') {
      localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', `${field} must be a string`, { field })
    }
    validateShape(field, value, shape, kind)
  }
  const requiredFields = context?.publishedLegalPractice ? definition.publishedLegalPracticeFields : undefined
  const missing = requiredFields?.filter((field) => {
    let value: unknown = input
    for (const segment of field.split('.')) value = isRecord(value) ? value[segment] : undefined
    return !isNonBlankText(value)
  })
  if (missing?.length) {
    localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'Required organization fields must contain translated text', { missing })
  }
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)))
}

export function validateLocalizedRoutePath(resourceType: LocalizedResourceType, locale: string, routePath: unknown, canonicalSlug?: string, savedRoutePath?: string | null, vertical?: string): string | null {
  const definition = RESOURCE_LOCALIZATION_REGISTRY[resourceType]
  if (definition.route !== 'stored' || (resourceType === 'business_location' && !hasPublicLocationPages(vertical))) {
    if (routePath !== undefined && routePath !== null) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', resourceType + ' does not accept route_path')
    return null
  }
  if (savedRoutePath !== undefined) {
    if (!savedRoutePath) localizationError(500, 'LOCALIZATION_VALIDATION_FAILED', 'The location translation has no saved route')
    if (routePath != null && routePath !== savedRoutePath) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'A translation keeps its canonical path')
    return savedRoutePath
  }
  if (!canonicalSlug || /[/?#]/.test(canonicalSlug)) localizationError(500, 'LOCALIZATION_VALIDATION_FAILED', 'The location has no valid canonical slug')
  const path = `/${locale}/locations/${canonicalSlug}`
  if (routePath != null && routePath !== path) localizationError(422, 'LOCALIZATION_VALIDATION_FAILED', 'The location route is determined by its saved slug', { route_path: path })
  return path
}
