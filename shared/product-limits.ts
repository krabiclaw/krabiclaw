/**
 * Product field limits, shared by the server validator and the dashboard form.
 *
 * These live in `shared/` rather than beside the validator because the form has
 * to stop the tenant building a product the server will reject — a control must
 * not be able to build an invalid state — and `server/utils/product-validation`
 * imports Nitro, so a page cannot read the limits from there.
 */
export const PRODUCT_LIMITS = {
  batchCreate: 400,
  reconcile: 200,
  name: 240,
  slug: 240,
  description: 10_000,
  marketingFeatures: 15,
  marketingFeature: 500,
  metadataEntries: 50,
  metadataKey: 40,
  metadataValue: 500,
  unitLabel: 40,
  taxCode: 60,
  sku: 120,
  variants: 250,
  details: 64,
  orderUrl: 2_048,
  collectionName: 120,
  collectionDescription: 2_000,
  collectionProducts: 2_000,
} as const

/** A slug is lowercase kebab-case. The server rejects anything else. */
export const PRODUCT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A metadata key is a short lowercase identifier. Values are plain strings. */
export const PRODUCT_METADATA_KEY = /^[a-z0-9][a-z0-9_-]*$/
