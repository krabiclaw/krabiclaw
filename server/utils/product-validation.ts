import { HTTPError } from 'nitro'
import type { ProductVariantInput } from '~/server/types/products'
import { PRODUCT_LIMITS, PRODUCT_METADATA_KEY, PRODUCT_SLUG } from '~/shared/product-limits'

export { PRODUCT_LIMITS, PRODUCT_SLUG }

function invalid(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

export function requireTrimmedProductString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) invalid(`${field} is required`)
  if (normalized.length > maxLength) invalid(`${field} must be at most ${maxLength} characters`)
  return normalized
}

export function normalizeOptionalProductString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') invalid(`${field} must be a string or null`)
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maxLength) invalid(`${field} must be at most ${maxLength} characters`)
  return normalized
}

/**
 * Stripe Product `marketing_features`: generic selling bullets.
 *
 * Deliberately NOT a place to merge inclusions, preparation instructions,
 * policies and specifications — each of those is a named field for the product kind
 * with its own type, and collapsing them here is what made `details_json`
 * unreadable.
 */
export function validateProductMarketingFeatures(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid('marketing_features must be an array')
  if (value.length > PRODUCT_LIMITS.marketingFeatures) {
    invalid(`marketing_features may contain at most ${PRODUCT_LIMITS.marketingFeatures} entries`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const normalized = requireTrimmedProductString(entry, `marketing_features[${index}]`, PRODUCT_LIMITS.marketingFeature)
    if (/[\r\n]/.test(normalized)) invalid(`marketing_features[${index}] must be a single line`)
    if (seen.has(normalized)) invalid('marketing_features must be unique')
    seen.add(normalized)
    return normalized
  })
}

/**
 * A validated string-to-string annotation map.
 *
 * No pricing, scheduling, stock, permission, routing or filtering behavior may
 * read this. Anything a surface must understand gets a named detail field or
 * a column; anything here is opaque to the domain by construction.
 */
export function validateProductMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) invalid('metadata must be an object')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > PRODUCT_LIMITS.metadataEntries) {
    invalid(`metadata may contain at most ${PRODUCT_LIMITS.metadataEntries} entries`)
  }
  const normalized: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (key.length > PRODUCT_LIMITS.metadataKey) invalid(`metadata key "${key}" is too long`)
    if (!PRODUCT_METADATA_KEY.test(key)) invalid(`metadata key "${key}" must be a lowercase identifier`)
    if (typeof entry !== 'string') invalid(`metadata.${key} must be a string`)
    if (entry.length > PRODUCT_LIMITS.metadataValue) invalid(`metadata.${key} is too long`)
    normalized[key] = entry
  }
  return normalized
}

/** A unit noun such as 'person' or 'night'. Pricing prose belongs in blocks. */
export function validateProductUnitLabel(value: unknown): string | null {
  const normalized = normalizeOptionalProductString(value, 'unit_label', PRODUCT_LIMITS.unitLabel)
  if (normalized === null) return null
  if (/[\r\n]/.test(normalized)) invalid('unit_label must be a single line')
  if (normalized.split(/\s+/).length > 3) invalid('unit_label must be a unit noun, not a sentence')
  return normalized
}

export function validateProductSlug(value: unknown, field = 'slug'): string {
  const normalized = requireTrimmedProductString(value, field, PRODUCT_LIMITS.slug).toLowerCase()
  if (!PRODUCT_SLUG.test(normalized)) invalid(`${field} must be lowercase kebab-case`)
  return normalized
}

export interface NormalizedProductVariant {
  id?: string
  name: string
  sku: string | null
  active: boolean
  sort_order: number
}

export function validateProductVariants(value: unknown): NormalizedProductVariant[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid('variants must be an array')
  if (value.length === 0) invalid('a product must have at least one variant')
  if (value.length > PRODUCT_LIMITS.variants) invalid(`a product may have at most ${PRODUCT_LIMITS.variants} variants`)

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`variants[${index}] must be an object`)
    const variant = entry as ProductVariantInput
    const name = requireTrimmedProductString(variant.name, `variants[${index}].name`, PRODUCT_LIMITS.name)
    return {
      id: variant.id,
      name,
      sku: normalizeOptionalProductString(variant.sku, `variants[${index}].sku`, PRODUCT_LIMITS.sku),
      active: variant.active ?? true,
      sort_order: variant.sort_order ?? index,
    }
  })
}

/**
 * The narrower ordering destination — a delivery partner, a booking host.
 *
 * NOT the public product page: that is resolved from an explicit publication
 * and site context. Stripe's Product `url` is the page; this is not equivalent
 * to it and the two are never synchronized into each other.
 */
export function validateProductOrderUrl(value: unknown): string | null {
  const normalized = normalizeOptionalProductString(value, 'order_url', PRODUCT_LIMITS.orderUrl)
  if (normalized === null) return null
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    invalid('order_url must be an absolute HTTPS URL')
  }
  if (url.protocol !== 'https:' || !url.hostname) invalid('order_url must be an absolute HTTPS URL')
  if (url.username || url.password) invalid('order_url must not contain credentials')
  let fragment = url.hash.slice(1)
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const decoded = decodeURIComponent(fragment)
      if (decoded === fragment) break
      fragment = decoded
    }
  } catch {
    invalid('order_url fragment must use valid percent encoding')
  }
  if (/(?:^|[^a-z])(?:javascript|data)\s*:/i.test(fragment)) {
    invalid('order_url fragment contains an unsafe protocol')
  }
  return url.toString()
}
