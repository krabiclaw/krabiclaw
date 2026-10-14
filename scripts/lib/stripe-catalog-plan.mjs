import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { INCLUDED_LOCATIONS, NEW_SALE_PAID_PLAN_IDS, PAID_PLAN_PRICES, planPriceTiers } from '../../shared/billing-model.ts'

export const CATALOG_PLAN_SCHEMA_VERSION = 11
export const CATALOG_APPLY_JOURNAL_SCHEMA_VERSION = 1
export const CATALOG_APPLY_JOURNAL_KIND = 'stripe-catalog-apply-journal'
export const CATALOG_PLAN_KIND = 'stripe-catalog-plan'
export const OFFERED_PLAN_IDS = Object.freeze([...NEW_SALE_PAID_PLAN_IDS, 'site_language'])
export const RETIRED_PLAN_IDS = Object.freeze(['managed', 'seo_accelerator'])
export const RETIRED_ADDON_TYPES = Object.freeze(['translation', 'seasonal', 'gbp_setup'])
export const CATALOG_PLAN_SCOPES = Object.freeze(['full', 'retirement-only'])
export const STRIPE_CATALOG_REQUEST_TIMEOUT_MS = 10_000
const SUPPORTED_OPERATION_TYPES = new Set([
  'archive_product',
  'clear_product_default_price',
  'upload_product_image',
  'create_product',
  'create_price',
  'deactivate_price',
  'migrate_subscription_price',
  'update_product',
])
const CLOSED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired'])
const DESTRUCTIVE_OPERATION_TYPES = new Set(['archive_product', 'clear_product_default_price', 'deactivate_price'])
const CANONICAL_PRODUCT_METADATA_KEYS = Object.freeze([
  'plan_id',
  'product_family',
  'highlighted',
  'badge',
  'monthly_price_id',
  'annual_price_id',
  'seat_price_id',
  'currency',
  'catalog_image_sha256',
])

export const PLAN_DEFINITIONS = Object.freeze([
  {
    name: 'Growth',
    description: 'Your website, your domain — manage supported content through your dashboard and ChatGPT.',
    planId: 'growth',
    amountCents: PAID_PLAN_PRICES.growth.monthly,
    annualAmountCents: PAID_PLAN_PRICES.growth.annual,
    perLocation: true,
    highlighted: true,
    badge: 'Most Popular',
    imagePath: 'scripts/assets/stripe/growth.jpg',
    features: [
      'Business websites for restaurants, experiences and professional services',
      'Your own domain (yourbusiness.com)',
      'Update supported content, menus and photos through ChatGPT',
      'Bookings, consultation requests and ticketed experiences',
      'WhatsApp booking and reservation notifications — setup required',
      'Publish to connected Facebook, Instagram and Discord channels',
      'Google Places re-imports and weekly Google review refresh',
    ],
  },
  {
    name: 'Commerce',
    description: 'Everything in Growth, plus online payments for bookings and one-time orders.',
    planId: 'commerce',
    amountCents: PAID_PLAN_PRICES.commerce.monthly,
    perLocation: true,
    highlighted: false,
    features: [
      'Everything in Growth',
      'Stripe Checkout for paid bookings and one-time orders',
      'Buyer receipts and purchase history',
      'Refund, dispute and payout management',
      '1.4% of payment volume, plus Stripe fees.',
    ],
  },
  {
    name: 'Marketing',
    description: 'Everything in Commerce, plus Google Ads campaigns and omnichannel launches run from your dashboard and ChatGPT.',
    planId: 'marketing',
    amountCents: PAID_PLAN_PRICES.marketing.monthly,
    perLocation: true,
    highlighted: false,
    features: [
      'Everything in Commerce',
      'Create, clone, pause and budget Google Ads search campaigns',
      'One launch across Google Ads, Instagram, Facebook, Discord and your site',
      'Ad spend, clicks, impressions and conversions in your analytics',
      '10% of monthly ad spend for campaigns we manage.',
    ],
  },
  {
    name: 'Site Language',
    description: 'One manually localized language for one Growth site.',
    planId: 'site_language',
    productFamily: 'site_language',
    amountCents: 500,
    annualAmountCents: 6000,
    highlighted: false,
    features: [],
  },
])

const IMAGE_MIME_TYPES = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

export function sha256Json(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function keyMode(key) {
  if (/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(String(key ?? ''))) return 'test'
  if (/^(?:sk|rk)_live_[A-Za-z0-9]+$/.test(String(key ?? ''))) return 'live'
  return 'unknown'
}

export function assertCatalogModeKey(key, requiredMode = 'test') {
  if (!['test', 'live'].includes(requiredMode)) throw new Error('Stripe catalog mode must be test or live.')
  if (keyMode(key) !== requiredMode) {
    throw new Error(`Stripe catalog operations require a ${requiredMode}-mode key (sk_${requiredMode}_ or rk_${requiredMode}_).`)
  }
}

function normalizeCatalogPlanScope(value = 'full') {
  const scope = String(value ?? '').trim().toLowerCase() || 'full'
  if (!CATALOG_PLAN_SCOPES.includes(scope)) {
    throw new Error(`Unsupported Stripe catalog plan scope ${scope}. Expected full or retirement-only.`)
  }
  return scope
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {}
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value ?? '')]).sort(([a], [b]) => a.localeCompare(b)))
}

function normalizeMarketingFeatures(features) {
  if (!Array.isArray(features)) return []
  return features.map(feature => ({
    name: typeof feature?.name === 'string' ? feature.name : null,
  }))
}

function normalizeProduct(product) {
  return {
    id: String(product.id),
    active: Boolean(product.active),
    name: product.name ?? null,
    description: product.description ?? null,
    marketing_features: normalizeMarketingFeatures(product.marketing_features),
    metadata: normalizeMetadata(product.metadata),
    default_price: typeof product.default_price === 'string'
      ? product.default_price
      : product.default_price?.id ?? null,
    images: Array.isArray(product.images) ? [...product.images] : [],
    unit_label: product.unit_label ?? null,
  }
}

function normalizePrice(price) {
  return {
    id: String(price.id),
    product: typeof price.product === 'string' ? price.product : price.product?.id ?? null,
    active: Boolean(price.active),
    type: price.type ?? null,
    currency: price.currency ?? null,
    unit_amount: price.unit_amount ?? null,
    billing_scheme: price.billing_scheme ?? null,
    tiers_mode: price.tiers_mode ?? null,
    // In the create shape: the last bound is 'inf', and a charge Stripe reports
    // as null was never set, so it is absent rather than zero.
    tiers: Array.isArray(price.tiers)
      ? price.tiers.map(tier => ({
          up_to: tier.up_to ?? 'inf',
          ...(tier.flat_amount === null || tier.flat_amount === undefined ? {} : { flat_amount: tier.flat_amount }),
          ...(tier.unit_amount === null || tier.unit_amount === undefined ? {} : { unit_amount: tier.unit_amount }),
        }))
      : null,
    lookup_key: typeof price.lookup_key === 'string' ? price.lookup_key : null,
    metadata: normalizeMetadata(price.metadata),
    recurring: price.recurring
      ? {
          interval: price.recurring.interval ?? null,
          interval_count: price.recurring.interval_count ?? null,
        }
      : null,
  }
}

async function listAll(list, params) {
  const rows = []
  let startingAfter
  while (true) {
    const page = await list({ ...params, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    rows.push(...(page.data ?? []))
    if (!page.has_more || page.data?.length === 0) break
    startingAfter = page.data[page.data.length - 1]?.id
    if (!startingAfter) throw new Error('Stripe list response reported more rows without a final id.')
  }
  return rows
}

export async function readCatalogSnapshot(readAdapter, { accountMode = 'unknown' } = {}) {
  const [account, activeProducts, inactiveProducts] = await Promise.all([
    readAdapter.account.retrieve(),
    listAll(readAdapter.products.list.bind(readAdapter.products), { active: true, limit: 100 }),
    listAll(readAdapter.products.list.bind(readAdapter.products), { active: false, limit: 100 }),
  ])
  const accountId = typeof account?.id === 'string' ? account.id.trim() : ''
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    throw new Error('Stripe catalog snapshot could not prove the exact account ID.')
  }
  const products = [...new Map([...activeProducts, ...inactiveProducts]
    .map(product => [product.id, product])).values()]
    .map(normalizeProduct)
    .sort((a, b) => a.id.localeCompare(b.id))
  // Keep the signed snapshot complete. Product metadata determines whether a
  // product is actionable, but every price (recurring or one-time, active or
  // inactive) is included so an unknown catalog row cannot drift unnoticed.
  const pricesByProduct = {}
  for (const product of products) {
    const rows = []
    for (const active of [true, false]) {
      rows.push(...await listAll(
        readAdapter.prices.list.bind(readAdapter.prices),
        { product: product.id, active, limit: 100, expand: ['data.tiers'] },
      ))
    }
    pricesByProduct[product.id] = [...new Map(rows.map(price => [price.id, price])).values()]
      .map(normalizePrice)
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  // Subscriptions billed on any offered plan product, so a price replacement
  // can move them before the old price is retired. Only the fields that move
  // are kept, so renewals do not read as drift.
  const planProductIds = new Set(products.filter(product => NEW_SALE_PAID_PLAN_IDS.includes(productPlanId(product))).map(product => product.id))
  const subscriptions = []
  if (planProductIds.size > 0) {
    for (const subscription of await listAll(readAdapter.subscriptions.list.bind(readAdapter.subscriptions), { status: 'all', limit: 100 })) {
      if (CLOSED_SUBSCRIPTION_STATUSES.has(subscription.status)) continue
      const items = subscription.items?.data ?? []
      if (subscription.items?.has_more) throw new Error(`Stripe subscription ${subscription.id} has more items than one page.`)
      if (!items.some(item => planProductIds.has(typeof item.price?.product === 'string' ? item.price.product : item.price?.product?.id))) continue
      subscriptions.push(normalizeSubscription(subscription))
    }
  }
  subscriptions.sort((a, b) => a.id.localeCompare(b.id))
  return { accountId, accountMode, products, pricesByProduct, subscriptions }
}

function normalizeSubscription(subscription) {
  return {
    id: String(subscription.id),
    status: subscription.status ?? null,
    schedule: typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id ?? null,
    items: (subscription.items?.data ?? [])
      .map(item => ({ id: String(item.id), price: item.price?.id ?? null, quantity: item.quantity ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export async function createCatalogPlan({
  readAdapter,
  filesAdapter,
  imageFiles,
  accountMode = 'unknown',
  canonicalProductIds,
  canonicalProducts,
  scope = 'full',
  retirementOnly = false,
}) {
  const snapshot = await readCatalogSnapshot(readAdapter, { accountMode })
  const describedImages = imageFiles ?? await filesAdapter?.describeImageFiles?.() ?? {}
  const planningScope = normalizeCatalogPlanScope(retirementOnly ? 'retirement-only' : scope)
  return buildCatalogPlan({
    snapshot,
    imageFiles: describedImages,
    canonicalProductIds: canonicalProductIds ?? canonicalProducts,
    scope: planningScope,
  })
}

function canonicalProductMetadata(definition, priceRef, annualPriceRef, imageSha256, existingMetadata = {}) {
  const metadata = {
    highlighted: definition.highlighted ? 'true' : 'false',
    monthly_price_id: priceRef,
    currency: 'usd',
  }
  if (definition.productFamily) metadata.product_family = definition.productFamily
  else metadata.plan_id = definition.planId
  if (definition.badge) metadata.badge = definition.badge
  if (annualPriceRef) metadata.annual_price_id = annualPriceRef
  if (existingMetadata.seat_price_id) metadata.seat_price_id = String(existingMetadata.seat_price_id)
  if (imageSha256 !== undefined) {
    if (imageSha256) metadata.catalog_image_sha256 = imageSha256
  } else if (existingMetadata.catalog_image_sha256) {
    metadata.catalog_image_sha256 = String(existingMetadata.catalog_image_sha256)
  }
  return metadata
}

function productPatch(
  definition,
  priceRef,
  annualPriceRef,
  imageRef,
  imageSha256,
  existingMetadata = {},
) {
  const metadata = canonicalProductMetadata(definition, priceRef, annualPriceRef, imageSha256, existingMetadata)
  for (const key of CANONICAL_PRODUCT_METADATA_KEYS) {
    if (!Object.hasOwn(metadata, key) && existingMetadata[key]) metadata[key] = ''
  }
  const patch = {
    name: definition.name,
    description: definition.description,
    marketing_features: definition.features.map(name => ({ name })),
    metadata,
    default_price: priceRef,
    ...(definition.perLocation ? { unit_label: 'location' } : {}),
  }
  if (imageRef) patch.images = [imageRef]
  return patch
}

function canonicalProductState(product) {
  const metadata = normalizeMetadata(product.metadata)
  return {
    name: product.name ?? null,
    description: product.description ?? null,
    marketing_features: normalizeMarketingFeatures(product.marketing_features),
    metadata: Object.fromEntries(CANONICAL_PRODUCT_METADATA_KEYS
      .filter(key => metadata[key] !== undefined && metadata[key] !== '')
      .map(key => [key, metadata[key]])),
    default_price: product.default_price ?? null,
    unit_label: product.unit_label ?? null,
  }
}

function desiredCanonicalProductState(definition, priceRef, annualPriceRef, imageSha256, existingMetadata, existingUnitLabel = null) {
  return canonicalProductState({
    name: definition.name,
    description: definition.description,
    marketing_features: definition.features.map(name => ({ name })),
    metadata: canonicalProductMetadata(definition, priceRef, annualPriceRef, imageSha256, existingMetadata),
    default_price: priceRef,
    unit_label: definition.perLocation ? 'location' : existingUnitLabel,
  })
}

function existingProductNeedsUpdate(existing, definition, priceRef, annualPriceRef, imageSha256) {
  return stableJson(canonicalProductState(existing))
    !== stableJson(desiredCanonicalProductState(definition, priceRef, annualPriceRef, imageSha256, existing.metadata, existing.unit_label ?? null))
}

/**
 * The exact price an offered definition sells at one interval. Paid plans are
 * graduated per location (`planPriceTiers`); Site Language is a flat unit price.
 */
export function desiredPriceParams(definition, interval) {
  const amount = interval === 'year' ? definition.annualAmountCents : definition.amountCents
  const base = { currency: 'usd', recurring: { interval, interval_count: 1 } }
  return definition.perLocation
    ? { ...base, billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: planPriceTiers(amount, interval) }
    : { ...base, billing_scheme: 'per_unit', unit_amount: amount }
}

function isRecurringBasePrice(price, seatPriceId) {
  return price.active !== false
    && price.id !== seatPriceId
    && (price.recurring?.interval === 'month' || price.recurring?.interval === 'year')
}

/**
 * The one active price matching the definition at this interval, or null when
 * it has to be created. A price at another amount or scheme is not canonical:
 * it is retired by the signed plan after its subscriptions move.
 */
function resolveCanonicalPrice(product, prices, definition, interval, seatPriceId) {
  const desired = desiredPriceParams(definition, interval)
  const candidates = prices.filter(price => isRecurringBasePrice(price, seatPriceId) && matchesPriceParams(price, desired))
  if (candidates.length === 0) return null
  const intervalLabel = interval === 'year' ? 'annual' : interval
  const metadataPriceId = product.metadata?.[interval === 'month' ? 'monthly_price_id' : 'annual_price_id']?.trim()
  const selected = candidates.find(price => price.id === metadataPriceId)
  if (selected) return selected
  if (candidates.length !== 1) {
    throw new Error(`Stripe product ${product.id} has ${candidates.length} identical ${intervalLabel} prices; archive the duplicates before planning.`)
  }
  return candidates[0]
}

function imageOperation(definition, imageFiles, existing) {
  const image = imageFiles?.[definition.planId]
  if (image === undefined) return null
  if (!image.exists) {
    throw new Error(`Stripe catalog image is missing: ${image.path ?? definition.imagePath ?? definition.planId}`)
  }
  if (typeof image.sha256 !== 'string' || image.sha256.length === 0) {
    throw new Error(`Stripe catalog image is missing its SHA-256: ${image.path ?? definition.planId}`)
  }
  const existingImageHash = existing?.metadata?.catalog_image_sha256?.trim()
  const existingImagePresent = Array.isArray(existing?.images)
    && existing.images.some(value => typeof value === 'string' && value.trim().length > 0)
  if (existing && existingImageHash === image.sha256 && existingImagePresent) return null
  return {
    type: 'upload_product_image',
    planId: definition.planId,
    path: image.path,
    sha256: image.sha256,
    mimeType: image.mimeType,
    fileName: image.fileName,
  }
}

function productPlanId(product) {
  return typeof product?.metadata?.plan_id === 'string' ? product.metadata.plan_id.trim() : ''
}

function productCatalogId(product) {
  const planId = productPlanId(product)
  if (planId) return planId
  const family = typeof product?.metadata?.product_family === 'string'
    ? product.metadata.product_family.trim().toLowerCase()
    : ''
  return family === 'site_language' ? family : ''
}

function retiredCatalogFamily(product) {
  const planId = productPlanId(product)
  if (RETIRED_PLAN_IDS.includes(planId)) return `plan:${planId}`
  const addonType = typeof product?.metadata?.addon_type === 'string'
    ? product.metadata.addon_type.trim().toLowerCase()
    : ''
  if (RETIRED_ADDON_TYPES.includes(addonType)) return `addon:${addonType}`
  return null
}

function normalizeCanonicalProductIds(canonicalProductIds) {
  if (canonicalProductIds == null) return {}
  if (typeof canonicalProductIds !== 'object' || Array.isArray(canonicalProductIds)) {
    throw new Error('Canonical product overrides must be a plan_id to product ID map.')
  }
  return Object.fromEntries(Object.entries(canonicalProductIds)
    .map(([planId, productId]) => [String(planId).trim(), String(productId).trim()])
    .sort(([a], [b]) => a.localeCompare(b)))
}

function resolveCanonicalProducts(snapshot, canonicalProductIds) {
  const overrides = normalizeCanonicalProductIds(canonicalProductIds)
  const activeProducts = snapshot.products.filter(product => product.active !== false)
  const productsByPlan = new Map()

  for (const product of activeProducts) {
    const planId = productCatalogId(product)
    if (!OFFERED_PLAN_IDS.includes(planId)) continue
    const products = productsByPlan.get(planId) ?? []
    products.push(product)
    productsByPlan.set(planId, products)
  }
  for (const products of productsByPlan.values()) products.sort((a, b) => a.id.localeCompare(b.id))

  for (const [planId, productId] of Object.entries(overrides)) {
    if (!OFFERED_PLAN_IDS.includes(planId)) {
      throw new Error(`Canonical product override has unsupported plan ID ${planId}.`)
    }
    const product = activeProducts.find(candidate => candidate.id === productId)
    if (!product || productCatalogId(product) !== planId) {
      throw new Error(`Canonical product override ${planId}=${productId} must reference the active ${planId} catalog product.`)
    }
  }

  const canonicalIds = {}
  for (const [planId, products] of productsByPlan.entries()) {
    const override = overrides[planId]
    if (products.length > 1 && !override) {
      const ids = products.map(product => product.id).join(', ')
      throw new Error(`Stripe has multiple active products for plan ${planId}: ${ids}. Supply --canonical-product ${planId}=<product-id>.`)
    }
    const selected = override
      ? products.find(product => product.id === override)
      : products[0]
    if (!selected) {
      throw new Error(`Canonical product override ${planId}=${override} is not an active product for plan ${planId}.`)
    }
    canonicalIds[planId] = selected.id
  }

  return {
    canonicalIds: Object.fromEntries(Object.entries(canonicalIds).sort(([a], [b]) => a.localeCompare(b))),
    productsByPlan,
  }
}

function assertRetirementOnlyGrowthSafety(snapshot, productsByPlan) {
  const growthProducts = productsByPlan.get('growth') ?? []
  if (growthProducts.length !== 1) {
    const ids = growthProducts.map(product => product.id).join(', ') || 'none'
    throw new Error(`Retirement-only catalog planning requires exactly one active canonical Growth product; found ${growthProducts.length} (${ids}).`)
  }
  const growth = growthProducts[0]
  const definition = PLAN_DEFINITIONS.find(candidate => candidate.planId === 'growth')
  const prices = [...(snapshot.pricesByProduct[growth.id] ?? [])].sort((a, b) => a.id.localeCompare(b.id))
  const seatPriceId = growth.metadata?.seat_price_id?.trim()
  if (!resolveCanonicalPrice(growth, prices, definition, 'month', seatPriceId)) {
    throw new Error(`Retirement-only catalog planning requires the canonical Growth monthly price on ${growth.id}.`)
  }
  return growth
}

export function buildCatalogPlan({ snapshot, imageFiles = {}, canonicalProductIds, canonicalProducts, scope = 'full', retirementOnly = false }) {
  const planningScope = normalizeCatalogPlanScope(retirementOnly ? 'retirement-only' : scope)
  if (planningScope === 'retirement-only') {
    // Retirement-only planning must not let a canonical override hide an
    // ambiguous Growth catalog.  Validate the live active set before the
    // general resolver (which otherwise accepts an explicit duplicate
    // override) so every retirement plan proves one and only one Growth
    // product is present.
    const activeGrowthProducts = snapshot.products
      .filter(product => product.active !== false && productPlanId(product) === 'growth')
      .sort((a, b) => a.id.localeCompare(b.id))
    if (activeGrowthProducts.length !== 1) {
      const ids = activeGrowthProducts.map(product => product.id).join(', ') || 'none'
      throw new Error(`Retirement-only catalog planning requires exactly one active canonical Growth product; found ${activeGrowthProducts.length} (${ids}).`)
    }
  }
  const { canonicalIds, productsByPlan } = resolveCanonicalProducts(
    snapshot,
    canonicalProductIds ?? canonicalProducts,
  )
  if (planningScope === 'retirement-only') assertRetirementOnlyGrowthSafety(snapshot, productsByPlan)
  const canonicalOperations = []
  const destructiveOperations = []

  // Keep offered-product creation/reconciliation ahead of every destructive
  // operation. The operator can therefore revalidate the canonical Growth
  // product, prices, and image before retiring duplicates or old products.
  if (planningScope !== 'retirement-only') for (const definition of PLAN_DEFINITIONS) {
    const products = productsByPlan.get(definition.planId) ?? []
    const canonicalProductId = canonicalIds[definition.planId]
    const existing = canonicalProductId
      ? products.find(product => product.id === canonicalProductId) ?? null
      : null
    const productRef = existing ? { id: existing.id } : { ref: { kind: 'product', planId: definition.planId } }

    const imageDescriptor = imageFiles?.[definition.planId]
    const image = imageOperation(definition, imageFiles, existing)
    const desiredImageSha256 = imageDescriptor === undefined
      ? undefined
      : imageDescriptor.exists
        ? imageDescriptor.sha256
        : null

    const prices = existing
      ? [...(snapshot.pricesByProduct[existing.id] ?? [])].sort((a, b) => a.id.localeCompare(b.id))
      : []
    const seatPriceId = existing?.metadata?.seat_price_id?.trim()
    const canonical = existing ? resolveCanonicalPrice(existing, prices, definition, 'month', seatPriceId) : null
    const annual = existing && definition.annualAmountCents ? resolveCanonicalPrice(existing, prices, definition, 'year', seatPriceId) : null
    const priceRef = canonical
      ? canonical.id
      : { ref: { kind: 'price', planId: definition.planId } }
    const annualPriceRef = annual
      ? annual.id
      : definition.annualAmountCents
        ? { ref: { kind: 'price', planId: `${definition.planId}_annual` } }
        : null

    if (!existing) {
      canonicalOperations.push({
        type: 'create_product',
        planId: definition.planId,
        params: {
          name: definition.name,
          description: definition.description,
          marketing_features: definition.features.map(name => ({ name })),
          metadata: {
            ...(definition.productFamily
              ? { product_family: definition.productFamily }
              : { plan_id: definition.planId }),
            highlighted: definition.highlighted ? 'true' : 'false',
            ...(definition.badge ? { badge: definition.badge } : {}),
          },
        },
      })
    }

    if (!canonical) {
      canonicalOperations.push({
        type: 'create_price',
        planId: definition.planId,
        product: productRef,
        params: desiredPriceParams(definition, 'month'),
      })
    }


    if (!annual && definition.annualAmountCents) {
      canonicalOperations.push({
        type: 'create_price',
        planId: `${definition.planId}_annual`,
        catalogProductId: definition.planId,
        product: productRef,
        params: desiredPriceParams(definition, 'year'),
      })
    }

    if (image) canonicalOperations.push(image)

    for (const price of prices) {
      if (!isRecurringBasePrice(price, seatPriceId) || price.id === canonical?.id || price.id === annual?.id) continue
      destructiveOperations.push({ type: 'deactivate_price', productId: existing?.id, priceId: price.id, expected: price })
    }

    const updateParams = productPatch(
      definition,
      priceRef,
      annualPriceRef,
      image ? { ref: { kind: 'file', planId: definition.planId } } : null,
      desiredImageSha256,
      existing?.metadata,
    )
    if (!existing || image || existingProductNeedsUpdate(existing, definition, priceRef, annualPriceRef, desiredImageSha256)) {
      canonicalOperations.push({
        type: 'update_product',
        product: productRef,
        params: updateParams,
      })
    }

    // Every open subscription billed on this plan, on any of its products, moves
    // to the canonical price for its interval before an old price is retired.
    // Quantity is the locations covered; the included ones cost the same.
    if (definition.perLocation) {
      const planProductIds = new Set(snapshot.products.filter(product => productPlanId(product) === definition.planId).map(product => product.id))
      const pricesById = new Map(Object.values(snapshot.pricesByProduct).flat().map(price => [price.id, price]))
      for (const subscription of snapshot.subscriptions ?? []) {
        for (const item of subscription.items) {
          const price = pricesById.get(item.price)
          if (!price || !planProductIds.has(price.product)) continue
          const interval = price.recurring?.interval
          const target = interval === 'year' ? annual : interval === 'month' ? canonical : null
          if (interval !== 'month' && interval !== 'year') throw new Error(`Subscription ${subscription.id} is billed on ${definition.planId} price ${price.id} with no plan interval.`)
          if (interval === 'year' && !definition.annualAmountCents) throw new Error(`Subscription ${subscription.id} is billed annually on ${definition.planId}, which has no annual price.`)
          const quantity = Math.max(INCLUDED_LOCATIONS, item.quantity ?? 1)
          if (target && price.id === target.id) continue
          if (subscription.schedule) throw new Error(`Subscription ${subscription.id} has schedule ${subscription.schedule}; release it before its price is replaced.`)
          if (subscription.items.length !== 1) throw new Error(`Subscription ${subscription.id} has ${subscription.items.length} items; a plan subscription has one.`)
          canonicalOperations.push({
            type: 'migrate_subscription_price',
            planId: definition.planId,
            subscriptionId: subscription.id,
            itemId: item.id,
            fromPriceId: price.id,
            price: target ? target.id : { ref: { kind: 'price', planId: interval === 'year' ? `${definition.planId}_annual` : definition.planId } },
            quantity,
            expected: subscription,
          })
        }
      }
    }

    for (const duplicate of products.filter(product => product.id !== existing?.id)) {
      for (const price of [...(snapshot.pricesByProduct[duplicate.id] ?? [])]
        .filter(price => price.active !== false)
        .sort((a, b) => a.id.localeCompare(b.id))) {
        destructiveOperations.push({
          type: 'deactivate_price',
          productId: duplicate.id,
          priceId: price.id,
          expected: price,
        })
      }
      destructiveOperations.push({
        type: 'archive_product',
        productId: duplicate.id,
        expected: duplicate,
      })
    }
  }

  for (const product of [...snapshot.products].sort((a, b) => a.id.localeCompare(b.id))) {
    const planId = productCatalogId(product)
    const retiredProduct = retiredCatalogFamily(product) !== null
    const inactiveOfferedProduct = OFFERED_PLAN_IDS.includes(planId) && product.active === false
    if (!retiredProduct && !inactiveOfferedProduct) continue
    const activePrices = [...(snapshot.pricesByProduct[product.id] ?? [])]
      .filter(price => price.active !== false)
      .sort((a, b) => a.id.localeCompare(b.id))
    let expectedArchiveProduct = product
    if (retiredProduct && product.active !== false) {
      const defaultPriceId = typeof product.default_price === 'string' ? product.default_price.trim() : ''
      const defaultPrice = activePrices.find(price => price.id === defaultPriceId)
      if (defaultPrice) {
        destructiveOperations.push({
          type: 'clear_product_default_price',
          productId: product.id,
          defaultPriceId,
          expectedDefaultPriceId: defaultPriceId,
          expectedDefaultPrice: defaultPrice,
          expected: product,
        })
        expectedArchiveProduct = { ...product, default_price: null }
      }
    }
    for (const price of activePrices) {
      destructiveOperations.push({
        type: 'deactivate_price',
        productId: product.id,
        priceId: price.id,
        expected: price,
      })
    }
    if (retiredProduct && product.active !== false) {
      destructiveOperations.push({
        type: 'archive_product',
        productId: product.id,
        expected: expectedArchiveProduct,
      })
    }
  }

  const operations = [...canonicalOperations, ...destructiveOperations]

  const plan = {
    schemaVersion: CATALOG_PLAN_SCHEMA_VERSION,
    kind: CATALOG_PLAN_KIND,
    scope: planningScope,
    accountId: snapshot.accountId,
    accountMode: snapshot.accountMode,
    canonicalProductIds: canonicalIds,
    providerSnapshot: snapshot,
    providerSnapshotSha256: sha256Json(snapshot),
    operations,
  }
  return { ...plan, planSha256: sha256Json(plan) }
}

export function planSha256(plan) {
  const { planSha256: _ignored, ...unsigned } = plan
  return sha256Json(unsigned)
}

export function assertPlanIntegrity(plan, confirmedSha256) {
  const computed = planSha256(plan)
  if (plan.planSha256 !== computed) throw new Error('Stripe catalog plan file hash is invalid or the file was edited.')
  if (confirmedSha256 !== computed) throw new Error('Stripe catalog plan SHA-256 confirmation does not match the plan file.')
  return computed
}

function assertCatalogPlanSchema(plan) {
  if (plan?.schemaVersion !== CATALOG_PLAN_SCHEMA_VERSION) {
    throw new Error(`Unsupported Stripe catalog plan schema version: ${String(plan?.schemaVersion ?? 'missing')}. Expected ${CATALOG_PLAN_SCHEMA_VERSION}.`)
  }
  if (plan?.kind !== CATALOG_PLAN_KIND) {
    throw new Error(`Unsupported Stripe catalog plan kind: ${String(plan?.kind ?? 'missing')}.`)
  }
  if (!CATALOG_PLAN_SCOPES.includes(plan?.scope)) {
    throw new Error(`Unsupported Stripe catalog plan scope: ${String(plan?.scope ?? 'missing')}.`)
  }
  if (
    typeof plan?.accountId !== 'string'
    || !/^acct_[A-Za-z0-9]+$/.test(plan.accountId)
    || plan.providerSnapshot?.accountId !== plan.accountId
  ) {
    throw new Error('Stripe catalog plan is not bound to one exact Stripe account ID.')
  }
}

function resolveReference(value, context) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => resolveReference(item, context))
  if (value.ref?.kind === 'product') return context.products[value.ref.planId]?.id ?? context.products[value.ref.planId]
  if (value.ref?.kind === 'price') return context.prices[value.ref.planId]?.id ?? context.prices[value.ref.planId]
  if (value.ref?.kind === 'file') return context.files[value.ref.planId]
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveReference(nested, context)]))
}

function assertExpectedProduct(snapshot, operation) {
  const current = snapshot.products.find(product => product.id === operation.productId)
  if (!current || stableJson(current) !== stableJson(operation.expected)) {
    throw new Error(`Provider snapshot drift detected for product ${operation.productId}.`)
  }
}

function assertExpectedPrice(snapshot, operation) {
  const current = Object.values(snapshot.pricesByProduct).flat().find(price => price.id === operation.priceId)
  if (!current || stableJson(current) !== stableJson(operation.expected)) {
    throw new Error(`Provider snapshot drift detected for price ${operation.priceId}.`)
  }
}

function operationIdentity(operation) {
  return {
    type: operation?.type ?? null,
    planId: operation?.planId ?? null,
    catalogProductId: operation?.catalogProductId ?? null,
    productId: operation?.productId ?? null,
    priceId: operation?.priceId ?? null,
    defaultPriceId: operation?.defaultPriceId ?? null,
    product: operation?.product?.id ?? operation?.product?.ref?.planId ?? null,
    subscriptionId: operation?.subscriptionId ?? null,
  }
}

function operationFingerprint(operation) {
  return sha256Json(operation)
}

function operationIdempotencyKey(planSha256, index, operation) {
  return `krabiclaw-catalog-${planSha256}-${index}-${operation.type}`
}

function sanitizeEvidence(value, depth = 0) {
  if (depth > 3) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+\b/g, '[redacted-stripe-key]')
      .replace(/\bwhsec_[A-Za-z0-9]+\b/g, '[redacted-webhook-secret]')
      .slice(0, 500)
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeEvidence(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value).slice(0, 500)
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (/secret|token|authorization|password|private.?key/i.test(key)) continue
    result[key] = sanitizeEvidence(child, depth + 1)
  }
  return result
}

function sanitizeError(error) {
  return sanitizeEvidence({
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    code: error?.code,
    status: error?.status,
  })
}

function writeJsonAtomic(path, value) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

function readApplyJournal(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read Stripe catalog apply journal ${path}: ${error?.message ?? String(error)}`, { cause: error })
  }
}

function createApplyJournal(path, plan, hash) {
  const now = new Date().toISOString()
  const journal = {
    schemaVersion: CATALOG_APPLY_JOURNAL_SCHEMA_VERSION,
    kind: CATALOG_APPLY_JOURNAL_KIND,
    planSha256: hash,
    providerSnapshotSha256: plan.providerSnapshotSha256,
    accountId: plan.accountId,
    accountMode: plan.accountMode,
    scope: plan.scope,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    journalPath: basename(path),
    operations: plan.operations.map((operation, index) => ({
      index,
      operationSha256: operationFingerprint(operation),
      identity: operationIdentity(operation),
      type: operation.type,
      status: 'pending',
      evidence: null,
      error: null,
    })),
    nextSafeAction: 'Resume only this exact signed plan after reviewing the journal.',
  }
  writeJsonAtomic(path, journal)
  return journal
}

function assertJournalMatches(journal, path, plan, hash) {
  if (!journal || typeof journal !== 'object') throw new Error(`Stripe catalog apply journal ${path} is not an object.`)
  if (journal.schemaVersion !== CATALOG_APPLY_JOURNAL_SCHEMA_VERSION || journal.kind !== CATALOG_APPLY_JOURNAL_KIND) {
    throw new Error(`Stripe catalog apply journal ${path} has an unsupported schema or kind.`)
  }
  if (journal.planSha256 !== hash) throw new Error(`Stripe catalog apply journal ${path} belongs to a different plan SHA-256.`)
  if (journal.providerSnapshotSha256 !== plan.providerSnapshotSha256) throw new Error(`Stripe catalog apply journal ${path} belongs to a different provider snapshot.`)
  if (journal.accountId !== plan.accountId) throw new Error(`Stripe catalog apply journal ${path} belongs to a different Stripe account.`)
  if (journal.accountMode !== plan.accountMode) throw new Error(`Stripe catalog apply journal ${path} belongs to a different Stripe account mode.`)
  if (journal.scope !== plan.scope) throw new Error(`Stripe catalog apply journal ${path} belongs to a different catalog planning scope.`)
  if (!Array.isArray(journal.operations) || journal.operations.length !== plan.operations.length) {
    throw new Error(`Stripe catalog apply journal ${path} does not match the signed plan operations.`)
  }
  for (const [index, operation] of plan.operations.entries()) {
    const entry = journal.operations[index]
    if (
      entry?.index !== index
      || entry.operationSha256 !== operationFingerprint(operation)
      || entry.type !== operation.type
    ) {
      throw new Error(`Stripe catalog apply journal ${path} does not match operation ${index} of the signed plan.`)
    }
    if (!['pending', 'running', 'applied', 'failed'].includes(entry.status)) {
      throw new Error(`Stripe catalog apply journal ${path} has an invalid status for operation ${index}.`)
    }
  }
  if (!['pending', 'incomplete', 'complete'].includes(journal.status)) {
    throw new Error(`Stripe catalog apply journal ${path} has an invalid journal status.`)
  }
}

function persistApplyJournal(path, journal) {
  journal.updatedAt = new Date().toISOString()
  writeJsonAtomic(path, journal)
}

function mutationEvidence(result, fallback = {}) {
  const evidence = { ...fallback }
  if (typeof result === 'string') {
    evidence.url = result
  } else if (result && typeof result === 'object') {
    if (typeof result.id === 'string') evidence.id = result.id
    if (typeof result.url === 'string') evidence.url = result.url
    if (typeof result.object === 'string') evidence.object = result.object
  }
  return sanitizeEvidence(evidence)
}

function contextFromJournal(journal) {
  const context = { products: {}, prices: {}, files: {} }
  for (const entry of journal.operations) {
    if (entry.status !== 'applied') continue
    const evidence = entry.evidence ?? {}
    if (entry.type === 'create_product' && entry.identity.planId && evidence.id) {
      context.products[entry.identity.planId] = { id: evidence.id }
    }
    if (entry.type === 'create_price' && entry.identity.planId && evidence.id) {
      context.prices[entry.identity.planId] = { id: evidence.id }
    }
    if (entry.type === 'upload_product_image' && entry.identity.planId && evidence.url) {
      context.files[entry.identity.planId] = evidence.url
    }
  }
  return context
}

function imageFilesFromPlan(plan) {
  return Object.fromEntries(plan.operations
    .filter(operation => operation.type === 'upload_product_image')
    .map(operation => [operation.planId, {
      path: operation.path,
      exists: true,
      sha256: operation.sha256,
      mimeType: operation.mimeType,
      fileName: operation.fileName,
    }]))
}

function findCurrentProduct(snapshot, productId) {
  return snapshot.products.find(product => product.id === productId) ?? null
}

function findCurrentSubscription(snapshot, subscriptionId) {
  return (snapshot.subscriptions ?? []).find(subscription => subscription.id === subscriptionId) ?? null
}

function findCurrentPrice(snapshot, priceId) {
  return Object.values(snapshot.pricesByProduct).flat().find(price => price.id === priceId) ?? null
}

function valuesEqual(value, expected) {
  return stableJson(value) === stableJson(expected)
}

function matchesProductPatch(product, patch) {
  if (!product) return false
  for (const [key, expected] of Object.entries(patch ?? {})) {
    if (key === 'metadata') {
      const actual = normalizeMetadata(product.metadata)
      for (const [metadataKey, metadataValue] of Object.entries(expected ?? {})) {
        if (String(actual[metadataKey] ?? '') !== String(metadataValue ?? '')) return false
      }
      continue
    }
    if (key === 'marketing_features') {
      if (!valuesEqual(normalizeMarketingFeatures(product.marketing_features), normalizeMarketingFeatures(expected))) return false
      continue
    }
    if (!valuesEqual(product[key], expected)) return false
  }
  return true
}

function matchesPriceParams(price, params) {
  if (!price) return false
  for (const [key, expected] of Object.entries(params ?? {})) {
    if (key === 'product') continue
    if (!valuesEqual(price[key], expected)) return false
  }
  return true
}

function resolveProductId(operation, context) {
  const resolved = operation.product?.id ?? resolveReference(operation.product, context)
  return typeof resolved === 'string' ? resolved : resolved?.id ?? null
}

function operationAlreadyApplied(snapshot, operation, context, entry) {
  if (operation.type === 'archive_product') {
    const product = findCurrentProduct(snapshot, operation.productId)
    return !product || product.active === false
  }
  if (operation.type === 'clear_product_default_price') {
    const product = findCurrentProduct(snapshot, operation.productId)
    return !product || product.active === false || product.default_price === null
  }
  if (operation.type === 'deactivate_price') {
    const price = findCurrentPrice(snapshot, operation.priceId)
    return !price || price.active === false
  }
  if (operation.type === 'create_product') {
    const knownId = entry.evidence?.id ?? context.products[operation.planId]?.id
    const product = knownId
      ? findCurrentProduct(snapshot, knownId)
      : snapshot.products.find(candidate =>
          candidate.active !== false
          && (
            candidate.metadata?.plan_id === operation.params?.metadata?.plan_id
            || candidate.metadata?.product_family === operation.params?.metadata?.product_family
          ),
        )
    return Boolean(product && product.active !== false && matchesProductPatch(product, operation.params))
  }
  if (operation.type === 'create_price') {
    const productId = resolveProductId(operation, context)
    if (!productId) return false
    const knownId = entry.evidence?.id ?? context.prices[operation.planId]?.id
    const candidates = (snapshot.pricesByProduct[productId] ?? [])
      .filter(price => price.active !== false)
      .filter(price => knownId ? price.id === knownId : true)
    return candidates.some(price => matchesPriceParams(price, { ...operation.params, product: productId }))
  }
  if (operation.type === 'update_product') {
    const productId = resolveProductId(operation, context)
    const product = productId ? findCurrentProduct(snapshot, productId) : null
    return Boolean(product && product.active !== false && matchesProductPatch(product, resolveReference(operation.params, context)))
  }
  if (operation.type === 'migrate_subscription_price') {
    const priceId = resolveReference(operation.price, context)
    const item = findCurrentSubscription(snapshot, operation.subscriptionId)?.items.find(candidate => candidate.id === operation.itemId)
    return Boolean(priceId && item && item.price === priceId && item.quantity === operation.quantity)
  }
  // Uploaded files are not enumerable through the catalog API. A journaled
  // applied state is the only safe proof; never upload a second file solely
  // because a process died after the provider accepted the first upload.
  return operation.type === 'upload_product_image' && entry.status === 'applied' && Boolean(entry.evidence?.url)
}

function inferredAppliedEvidence(snapshot, operation, context, entry) {
  if (operation.type === 'archive_product') return { id: operation.productId }
  if (operation.type === 'clear_product_default_price') {
    return { id: operation.productId, defaultPriceId: operation.defaultPriceId }
  }
  if (operation.type === 'deactivate_price') return { id: operation.priceId }
  if (operation.type === 'create_product') {
    const knownId = entry.evidence?.id ?? context.products[operation.planId]?.id
    const product = knownId
      ? findCurrentProduct(snapshot, knownId)
      : snapshot.products.find(candidate =>
          candidate.active !== false
          && (
            candidate.metadata?.plan_id === operation.params?.metadata?.plan_id
            || candidate.metadata?.product_family === operation.params?.metadata?.product_family
          )
          && matchesProductPatch(candidate, operation.params),
        )
    return product?.id ? { id: product.id } : {}
  }
  if (operation.type === 'create_price') {
    const productId = resolveProductId(operation, context)
    const knownId = entry.evidence?.id ?? context.prices[operation.planId]?.id
    const prices = productId ? snapshot.pricesByProduct[productId] ?? [] : []
    const price = prices
      .filter(candidate => candidate.active !== false)
      .find(candidate => (knownId ? candidate.id === knownId : true) && matchesPriceParams(candidate, { ...operation.params, product: productId }))
    return price?.id ? { id: price.id, product: productId } : {}
  }
  if (operation.type === 'update_product') {
    const productId = resolveProductId(operation, context)
    return productId ? { id: productId } : {}
  }
  if (operation.type === 'migrate_subscription_price') return { id: operation.subscriptionId }
  return entry.evidence ?? {}
}

function assertSignedProductPrecondition(snapshot, plan, productId, planId) {
  const current = findCurrentProduct(snapshot, productId)
  if (!current || current.active === false) throw new Error(`Provider precondition failed: product ${productId} is not active.`)
  const signedProduct = plan.providerSnapshot.products.find(product => product.id === productId)
  if (signedProduct) {
    if (!valuesEqual(current, signedProduct)) throw new Error(`Provider snapshot drift detected for product ${productId}.`)
    return current
  }
  const createOperation = plan.operations.find(operation => operation.type === 'create_product' && operation.planId === planId)
  if (!createOperation || !matchesProductPatch(current, createOperation.params)) {
    throw new Error(`Provider precondition failed: created product ${productId} does not match the signed catalog operation.`)
  }
  return current
}

function assertOperationPrecondition(snapshot, plan, operation, context, entry) {
  if (operationAlreadyApplied(snapshot, operation, context, entry)) return { alreadyApplied: true }
  if (DESTRUCTIVE_OPERATION_TYPES.has(operation.type)) {
    if (operation.type === 'archive_product') assertExpectedProduct(snapshot, operation)
    else if (operation.type === 'clear_product_default_price') {
      assertExpectedProduct(snapshot, operation)
      const current = findCurrentProduct(snapshot, operation.productId)
      if (current?.default_price !== operation.expectedDefaultPriceId) {
        throw new Error(`Provider precondition failed: product ${operation.productId} default price drifted from ${operation.expectedDefaultPriceId}.`)
      }
      const currentDefaultPrice = findCurrentPrice(snapshot, operation.defaultPriceId)
      if (!currentDefaultPrice || currentDefaultPrice.active === false) {
        throw new Error(`Provider precondition failed: default price ${operation.defaultPriceId} for product ${operation.productId} is not active.`)
      }
      if (operation.expectedDefaultPrice && stableJson(currentDefaultPrice) !== stableJson(operation.expectedDefaultPrice)) {
        throw new Error(`Provider snapshot drift detected for default price ${operation.defaultPriceId}.`)
      }
    } else {
      assertExpectedPrice(snapshot, operation)
      const owningProduct = snapshot.products.find(product =>
        product.active !== false
        && retiredCatalogFamily(product) !== null
        && product.default_price === operation.priceId,
      )
      if (owningProduct) {
        throw new Error(`Provider precondition failed: product ${owningProduct.id} still has ${operation.priceId} as its default price; clear it first.`)
      }
    }
    return { alreadyApplied: false }
  }
  if (operation.type === 'create_product') {
    // create_product's own params never carry metadata (a later update_product
    // sets it once the product/price IDs exist), so identity must resolve
    // through productCatalogId's plan_id/product_family reader against the
    // operation's planId, not operation.params.metadata.
    const duplicate = snapshot.products.find(candidate =>
      candidate.active !== false
      && productCatalogId(candidate) !== ''
      && productCatalogId(candidate) === operation.planId,
    )
    if (duplicate) throw new Error(`Provider precondition failed: active canonical product ${duplicate.id} does not match the signed create operation.`)
    return { alreadyApplied: false }
  }
  if (operation.type === 'create_price') {
    const productId = resolveProductId(operation, context)
    if (!productId) throw new Error(`Unable to resolve product for ${operation.planId} price creation.`)
    assertSignedProductPrecondition(snapshot, plan, productId, operation.catalogProductId ?? operation.planId)
    return { alreadyApplied: false }
  }
  if (operation.type === 'update_product') {
    const productId = resolveProductId(operation, context)
    if (!productId) throw new Error('Provider precondition failed: canonical product is not active for update.')
    const planId = operation.planId ?? operation.product?.ref?.planId
    assertSignedProductPrecondition(snapshot, plan, productId, planId)
    return { alreadyApplied: false }
  }
  if (operation.type === 'upload_product_image') {
    const planId = operation.planId
    const productId = plan.canonicalProductIds?.[planId] ?? context.products[planId]?.id
    if (productId) assertSignedProductPrecondition(snapshot, plan, productId, planId)
    return { alreadyApplied: false }
  }
  if (operation.type === 'migrate_subscription_price') {
    const current = findCurrentSubscription(snapshot, operation.subscriptionId)
    if (!current || !valuesEqual(current, operation.expected)) {
      throw new Error(`Provider snapshot drift detected for subscription ${operation.subscriptionId}.`)
    }
    const priceId = resolveReference(operation.price, context)
    const target = typeof priceId === 'string' ? findCurrentPrice(snapshot, priceId) : null
    if (!target || target.active === false) {
      throw new Error(`Provider precondition failed: replacement price for subscription ${operation.subscriptionId} is not active.`)
    }
    return { alreadyApplied: false }
  }
  throw new Error(`Unsupported Stripe catalog operation: ${operation.type}`)
}

async function assertCanonicalReadiness(plan, snapshot, filesAdapter) {
  assertCatalogAccountBinding(plan, snapshot)
  const remainingPlan = buildCatalogPlan({
    snapshot,
    imageFiles: imageFilesFromPlan(plan),
    canonicalProductIds: plan.canonicalProductIds,
    scope: plan.scope,
  })
  const remainingCanonical = remainingPlan.operations.filter(operation => !DESTRUCTIVE_OPERATION_TYPES.has(operation.type))
  if (remainingCanonical.length > 0) {
    const summary = remainingCanonical.map(operation => `${operation.type}:${operation.planId ?? operation.productId ?? operation.priceId ?? 'unknown'}`).join(', ')
    throw new Error(`Canonical offered catalog is not fully revalidated; no destructive operation is safe (${summary}).`)
  }
  if (filesAdapter?.verifyProductImage) {
    for (const operation of plan.operations.filter(candidate => candidate.type === 'upload_product_image')) {
      // Verify the local source again immediately before destructive work.
      // This does not contact Stripe and prevents an old image from being
      // attached after the reviewed plan has gone stale on disk.
      await filesAdapter.verifyProductImage(operation)
    }
  }
  return remainingPlan
}

function assertCatalogAccountBinding(plan, snapshot) {
  if (snapshot.accountId !== plan.accountId) {
    throw new Error(`Stripe catalog plan belongs to account ${plan.accountId}, not ${snapshot.accountId}.`)
  }
}

export class CatalogApplyIncompleteError extends Error {
  constructor(message, { journalPath, nextSafeAction, journal } = {}) {
    super(message)
    this.name = 'CatalogApplyIncompleteError'
    this.status = 'incomplete'
    this.journalPath = journalPath
    this.nextSafeAction = nextSafeAction
    this.journal = journal
  }
}

export async function applyCatalogPlan({
  plan,
  confirmedSha256,
  key,
  readAdapter,
  mutationAdapter,
  filesAdapter,
  journalPath,
  requiredMode = 'test',
}) {
  if (typeof journalPath !== 'string' || journalPath.trim().length === 0) {
    throw new Error('Stripe catalog apply requires an explicit journal path.')
  }
  assertCatalogPlanSchema(plan)
  assertCatalogModeKey(key, requiredMode)
  const hash = assertPlanIntegrity(plan, confirmedSha256)
  if (plan.accountMode !== requiredMode) throw new Error(`Stripe catalog apply requires a ${requiredMode}-mode plan.`)
  if (!Array.isArray(plan.operations)) throw new Error('Stripe catalog plan operations must be an array.')
  for (const operation of plan.operations) {
    if (!SUPPORTED_OPERATION_TYPES.has(operation?.type)) {
      throw new Error(`Unsupported Stripe catalog operation: ${operation?.type ?? 'missing type'}`)
    }
  }

  if (filesAdapter?.verifyProductImage) {
    for (const operation of plan.operations.filter(operation => operation.type === 'upload_product_image')) {
      await filesAdapter.verifyProductImage(operation)
    }
  }

  const initialSnapshot = await readCatalogSnapshot(readAdapter, { accountMode: plan.accountMode })
  assertCatalogAccountBinding(plan, initialSnapshot)
  let journal
  const journalExists = existsSync(journalPath)
  if (journalExists) {
    journal = readApplyJournal(journalPath)
    assertJournalMatches(journal, journalPath, plan, hash)
  } else {
    if (sha256Json(initialSnapshot) !== plan.providerSnapshotSha256) {
      throw new Error('Provider snapshot drift detected; regenerate and review a new plan before applying.')
    }
    // This write is deliberately before the first provider mutation.
    journal = createApplyJournal(journalPath, plan, hash)
  }

  const context = contextFromJournal(journal)
  const runOperation = async (operation, index) => {
    const idempotencyKey = operationIdempotencyKey(hash, index, operation)
    const requestOptions = { idempotencyKey }
    if (operation.type === 'archive_product') {
      const result = await mutationAdapter.products.update(operation.productId, { active: false }, requestOptions)
      return mutationEvidence(result, { id: operation.productId })
    }
    if (operation.type === 'clear_product_default_price') {
      const result = await mutationAdapter.products.update(operation.productId, { default_price: '' }, requestOptions)
      return mutationEvidence(result, { id: operation.productId, defaultPriceId: operation.defaultPriceId })
    }
    if (operation.type === 'upload_product_image') {
      if (!filesAdapter?.uploadProductImage) throw new Error('Plan requires a files adapter for image upload.')
      const result = await filesAdapter.uploadProductImage(operation, requestOptions)
      if (typeof result !== 'string' || result.length === 0) throw new Error('Stripe catalog image upload did not return a file URL.')
      context.files[operation.planId] = result
      return mutationEvidence(result)
    }
    if (operation.type === 'create_product') {
      const result = await mutationAdapter.products.create(operation.params, requestOptions)
      if (!result?.id) throw new Error(`Stripe product creation for ${operation.planId} did not return an ID.`)
      context.products[operation.planId] = { id: result.id }
      return mutationEvidence(result)
    }
    if (operation.type === 'create_price') {
      const product = resolveProductId(operation, context)
      if (!product) throw new Error(`Unable to resolve product for ${operation.planId} price creation.`)
      const result = await mutationAdapter.prices.create({ ...operation.params, product }, requestOptions)
      if (!result?.id) throw new Error(`Stripe price creation for ${operation.planId} did not return an ID.`)
      context.prices[operation.planId] = { id: result.id }
      return mutationEvidence(result, { product })
    }
    if (operation.type === 'deactivate_price') {
      const result = await mutationAdapter.prices.update(operation.priceId, { active: false }, requestOptions)
      return mutationEvidence(result, { id: operation.priceId })
    }
    if (operation.type === 'migrate_subscription_price') {
      const price = resolveReference(operation.price, context)
      if (typeof price !== 'string') throw new Error(`Unable to resolve the replacement price for subscription ${operation.subscriptionId}.`)
      // Same amount for the included locations, so nothing is prorated.
      const result = await mutationAdapter.subscriptions.update(operation.subscriptionId, {
        items: [{ id: operation.itemId, price, quantity: operation.quantity }],
        proration_behavior: 'none',
      }, requestOptions)
      return mutationEvidence(result, { id: operation.subscriptionId })
    }
    if (operation.type === 'update_product') {
      const productId = resolveProductId(operation, context)
      if (!productId) throw new Error('Unable to resolve product for product update.')
      const params = resolveReference(operation.params, context)
      const result = await mutationAdapter.products.update(productId, params, requestOptions)
      return mutationEvidence(result, { id: productId })
    }
    throw new Error(`Unsupported Stripe catalog operation: ${operation.type}`)
  }

  for (const [index, operation] of plan.operations.entries()) {
    const entry = journal.operations[index]
    if (entry.status === 'applied') continue

    let snapshot
    try {
      snapshot = await readCatalogSnapshot(readAdapter, { accountMode: plan.accountMode })
      assertCatalogAccountBinding(plan, snapshot)
      const precondition = assertOperationPrecondition(snapshot, plan, operation, context, entry)
      if (precondition.alreadyApplied) {
        entry.status = 'applied'
        entry.error = null
        entry.evidence = mutationEvidence(null, inferredAppliedEvidence(snapshot, operation, context, entry))
        if (operation.type === 'create_product' && entry.evidence.id) context.products[operation.planId] = { id: entry.evidence.id }
        if (operation.type === 'create_price' && entry.evidence.id) context.prices[operation.planId] = { id: entry.evidence.id }
        persistApplyJournal(journalPath, journal)
        continue
      }
      if (DESTRUCTIVE_OPERATION_TYPES.has(operation.type)) {
        await assertCanonicalReadiness(plan, snapshot, filesAdapter)
      }
      entry.status = 'running'
      entry.error = null
      persistApplyJournal(journalPath, journal)
      entry.evidence = await runOperation(operation, index)
      entry.status = 'applied'
      persistApplyJournal(journalPath, journal)
    } catch (error) {
      entry.status = 'failed'
      entry.error = sanitizeError(error)
      journal.status = 'incomplete'
      journal.nextSafeAction = `Review operation ${index} (${operation.type}) and resume only this exact signed plan after correcting the named precondition or provider failure.`
      persistApplyJournal(journalPath, journal)
      if (error instanceof CatalogApplyIncompleteError) throw error
      throw new CatalogApplyIncompleteError(
        `Stripe catalog apply stopped at operation ${index} (${operation.type}); status=incomplete.`,
        {
          journalPath,
          nextSafeAction: journal.nextSafeAction,
          journal,
        },
      )
    }
  }

  let finalSnapshot
  let remainingPlan
  try {
    finalSnapshot = await readCatalogSnapshot(readAdapter, { accountMode: plan.accountMode })
    assertCatalogAccountBinding(plan, finalSnapshot)
    remainingPlan = buildCatalogPlan({
      snapshot: finalSnapshot,
      imageFiles: imageFilesFromPlan(plan),
      canonicalProductIds: plan.canonicalProductIds,
      scope: plan.scope,
    })
  } catch (_error) {
    journal.status = 'incomplete'
    journal.nextSafeAction = 'Review final provider drift and regenerate a new plan; this journal cannot claim completion.'
    persistApplyJournal(journalPath, journal)
    throw new CatalogApplyIncompleteError(
      `Stripe catalog apply could not prove zero remaining operations; status=incomplete.`,
      { journalPath, nextSafeAction: journal.nextSafeAction, journal },
    )
  }
  if (remainingPlan.operations.length > 0) {
    journal.status = 'incomplete'
    journal.nextSafeAction = 'Review the remaining provider drift and regenerate a signed plan; this journal cannot claim completion.'
    persistApplyJournal(journalPath, journal)
    throw new CatalogApplyIncompleteError(
      `Stripe catalog apply could not prove zero remaining operations (${remainingPlan.operations.length}: ${remainingPlan.operations.map(operation => `${operation.type}:${operation.planId ?? operation.productId ?? operation.priceId ?? 'unknown'}`).join(', ')}); status=incomplete.`,
      { journalPath, nextSafeAction: journal.nextSafeAction, journal },
    )
  }

  journal.status = 'complete'
  journal.nextSafeAction = null
  for (const entry of journal.operations) {
    if (entry.status !== 'applied') entry.status = 'applied'
  }
  persistApplyJournal(journalPath, journal)
  return {
    status: 'complete',
    planSha256: hash,
    appliedOperations: journal.operations.filter(entry => entry.status === 'applied').length,
    journalPath,
  }
}

export function imageMimeType(path) {
  return IMAGE_MIME_TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'image/png'
}
