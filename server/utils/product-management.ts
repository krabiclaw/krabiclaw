import { getSourceLocale } from '~/server/utils/organization-locales'
import { ASSIGNED_SERVICE_SQL } from '~/server/utils/member-access'
import type { ProductBookingSetupInput, SessionAvailability } from '~/server/utils/availability'
import { HTTPError } from 'nitro'
import { d1JsonArray, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { MAX_D1_BATCH_STATEMENTS } from '~/server/db/d1-limits'
import { resourceLocalizationDeletionQueries } from '~/server/utils/localization'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import { buildDeleteOwnerPlacementsQuery, readMediaPlacements } from '~/server/utils/media-asset-manager'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { creationDedupeKey, creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { assertTenantPagePathAvailable, isProductPageConflict, prepareTenantPageCreate, prepareTenantPageDelete, refreshTenantPageCard, type TenantPageEditorInput } from '~/server/utils/content/pages'
import { loadOrganizationTemplate } from '~/server/utils/content/publishing'
import { publishStayInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { requireChannelPush } from '~/server/integrations/channex/ari'
import type { ChannelPush } from '~/shared/channel-push'
import type { CloudflareEnv } from '~/server/utils/auth'
import { readStripeCheckoutSetup } from '~/server/utils/stripe-connect'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import {
  assertNoConflictingPrices,
  assertPriceShape,
  PRICE_RECURRING_INTERVALS,
  PRICE_TAX_BEHAVIORS,
  PRICE_TYPES,
  selectPrice,
  type Price,
  type PriceInput,
  type PriceSelection,
} from '~/shared/prices'
import { assertProductKind, validateProductDetails, ProductDetailError, PRICING_NOTE_HANDLE, PRODUCT_KINDS, type ProductDetailValue, type ProductKind } from '~/shared/product-details'
import type { CatalogCounts } from '~/utils/product-presentation'
import type {
  Collection,
  CreateCollectionInput,
  CreateProductInput,
  Product,
  ProductOption,
  ProductSource,
  ProductStayConfig,
  ProductVariant,
  ProductVariantInput,
  ProductVariantPatchInput,
  ReconcileProductInput,
  UpdateCollectionInput,
  UpdateProductInput,
} from '~/server/types/products'
import {
  PRODUCT_LIMITS,
  normalizeOptionalProductString,
  requireTrimmedProductString,
  validateProductMarketingFeatures,
  validateProductMetadata,
  validateProductOptions,
  validateProductOrderUrl,
  validateProductUnitLabel,
  validateProductVariants,
  type NormalizedProductOption,
  type NormalizedProductVariant,
} from '~/server/utils/product-validation'

/**
 * The canonical catalog write and read path.
 *
 * Products belong to the organization. Where they are published, where they
 * are offered, what they cost, how they are grouped and what they are made of
 * are all relationships, loaded alongside the product and never flattened into
 * it. There is no second catalog for a vertical.
 */

const MAX_SLUG_SUFFIX_ATTEMPTS = 100

/** Coarse publication gate; public catalogue readers also require booking readiness. */
export const PUBLIC_PRODUCT_SQL = `pub.published = 1 AND (p.kind <> 'experience' OR NULLIF(trim(p.order_url), '') IS NOT NULL
  OR EXISTS (SELECT 1 FROM product_booking_configs cfg WHERE cfg.product_id = p.id AND cfg.organization_id = p.organization_id AND cfg.duration_minutes > 0))
  AND (p.kind <> 'stay' OR NULLIF(trim(p.order_url), '') IS NOT NULL)`

/** Guests book a place to stay through its external booking link until KrabiClaw takes direct stays. */
function assertStayPublishable(product: { kind: ProductKind; order_url: string | null }): void {
  if (product.kind === 'stay' && !product.order_url?.trim()) conflict('Add the link where guests book this place to stay before publishing it')
}

type Row = Record<string, unknown>

function notFound(message = 'Product not found'): never {
  throw new HTTPError({ statusCode: 404, statusMessage: message })
}

function invalid(message: string): never {
  throw new HTTPError({ statusCode: 400, statusMessage: message })
}

function conflict(message: string): never {
  throw new HTTPError({ statusCode: 409, statusMessage: message })
}

function parseJsonArray<T>(value: unknown, field: string): T[] {
  if (typeof value !== 'string') throw new Error(`Product ${field} is not stored as JSON`)
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error(`Product ${field} must be a JSON array`)
  return parsed as T[]
}

function parseJsonObject(value: unknown, field: string): Record<string, string> {
  if (typeof value !== 'string') throw new Error(`Product ${field} is not stored as JSON`)
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Product ${field} must be a JSON object`)
  return parsed as Record<string, string>
}

const PRODUCT_COLUMNS = `
  p.id, p.organization_id, p.name, p.slug, p.description, p.active, p.order_url, p.unit_label,
  p.marketing_features, p.metadata, p.tax_code, p.source,
  p.kind, p.details_json, p.created_at, p.updated_at, p.created_by, p.updated_by
`

function mapProductRow(row: Row): Product {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description),
    active: Number(row.active) === 1,
    order_url: row.order_url === null ? null : String(row.order_url),
    unit_label: row.unit_label === null ? null : String(row.unit_label),
    marketing_features: parseJsonArray<string>(row.marketing_features, 'marketing_features'),
    metadata: parseJsonObject(row.metadata, 'metadata'),
    tax_code: row.tax_code === null ? null : String(row.tax_code),
    options: [],
    variants: [],
    kind: assertProductKind(row.kind),
    details: validateProductDetails(assertProductKind(row.kind), JSON.parse(String(row.details_json))),
    publications: [],
    locations: [],
    collections: [],
    booking: null,
    stay: null,
    page: null,
    image: null,
    gallery: [],
    media: [],
    social_image: null,
    source: String(row.source) as ProductSource,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    created_by: String(row.created_by),
    updated_by: String(row.updated_by),
  }
}

function mapPriceRow(row: Row): Price {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    product_variant_id: String(row.product_variant_id),
    location_id: row.location_id === null ? null : String(row.location_id),
    active: Number(row.active) === 1,
    currency: String(row.currency) as CurrencyCode,
    unit_amount: Number(row.unit_amount),
    type: String(row.type) as Price['type'],
    recurring_interval: row.recurring_interval === null ? null : String(row.recurring_interval) as Price['recurring_interval'],
    recurring_interval_count: row.recurring_interval_count === null ? null : Number(row.recurring_interval_count),
    tax_behavior: String(row.tax_behavior) as Price['tax_behavior'],
    compare_at_unit_amount: row.compare_at_unit_amount === null ? null : Number(row.compare_at_unit_amount),
    valid_from_at: row.valid_from_at === null ? null : String(row.valid_from_at),
    valid_until_at: row.valid_until_at === null ? null : String(row.valid_until_at),
    source: String(row.source),
    created_by: String(row.created_by),
    updated_by: String(row.updated_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

/**
 * Load every relationship a Product owns, in one pass per relation.
 *
 * Deliberately not a single join: variants x prices x publications x locations
 * x collections x details multiplies rows, and reconstructing distinct sets
 * from that product is where duplicate and dropped children come from.
 */
async function hydrate(db: DbClient, organizationId: string, products: Product[]): Promise<Product[]> {
  if (products.length === 0) return products
  const ids = d1JsonArray(products.map(product => product.id))
  const byId = new Map(products.map(product => [product.id, product]))

  // One batch, not nine round trips. The databases are a long way from the
  // Workers that read them, so each extra statement is real latency on every
  // catalog page; D1 charges one round trip for the batch.
  const batched = await executeBatch(db, [
    { query: `SELECT id, product_id, name, sort_order FROM product_options
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order, id`, params: [organizationId, ids] },
    { query: `SELECT id, product_id, product_option_id, value, sort_order FROM product_option_values
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order, id`, params: [organizationId, ids] },
    { query: `SELECT id, product_id, name, sku, active, sort_order FROM product_variants
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order, id`, params: [organizationId, ids] },
    { query: `SELECT product_variant_id, product_option_id, product_option_value_id FROM product_variant_option_values
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))`, params: [organizationId, ids] },
    { query: `SELECT pr.* FROM prices pr
      JOIN product_variants v ON v.id = pr.product_variant_id AND v.organization_id = pr.organization_id
      WHERE pr.organization_id = ? AND v.product_id IN (SELECT value FROM json_each(?))
      ORDER BY pr.product_variant_id, pr.valid_from_at, pr.id`, params: [organizationId, ids] },
    { query: `SELECT product_id, organization_id, published FROM product_publications
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY organization_id`, params: [organizationId, ids] },
    { query: `SELECT product_id, location_id, active, published FROM product_locations
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY location_id`, params: [organizationId, ids] },
    { query: `SELECT product_id, collection_id, sort_order FROM collection_products
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY collection_id`, params: [organizationId, ids] },
    { query: `SELECT product_id, duration_minutes, default_capacity, confirmation_mode, online_payment_required, held_online, scheduling_mode, assigned_member_id, assigned_team_id FROM product_booking_configs
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))`, params: [organizationId, ids] },
    // The page each product owns: the source row that carries its product_id.
    { query: `SELECT product_id, id, path, title FROM content_documents
      WHERE organization_id = ? AND row_role = 'root' AND kind = 'page' AND product_id IN (SELECT value FROM json_each(?))`, params: [organizationId, ids] },
    { query: `SELECT product_id, location_id, check_in_time, check_out_time, max_guests, min_nights, assigned_member_id, assigned_team_id FROM product_stay_configs
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))`, params: [organizationId, ids] },
  ], { operation: 'Hydrate products' })
  const rowsAt = (index: number): Row[] => (batched[index] as { results?: Row[] })?.results ?? []
  const optionRows = rowsAt(0)
  const valueRows = rowsAt(1)
  const variantRows = rowsAt(2)
  const selectionRows = rowsAt(3)
  const priceRows = rowsAt(4)
  const publicationRows = rowsAt(5)
  const locationRows = rowsAt(6)
  const collectionRows = rowsAt(7)
  const bookingRows = rowsAt(8)
  const pageRows = rowsAt(9)
  for (const row of rowsAt(10)) {
    const product = byId.get(String(row.product_id))
    if (product) product.stay = {
      location_id: String(row.location_id), check_in_time: String(row.check_in_time), check_out_time: String(row.check_out_time),
      max_guests: Number(row.max_guests), min_nights: Number(row.min_nights),
      assigned_member_id: row.assigned_member_id === null ? null : String(row.assigned_member_id),
      assigned_team_id: row.assigned_team_id === null ? null : String(row.assigned_team_id),
    }
  }
  for (const row of pageRows) {
    const product = byId.get(String(row.product_id))
    if (product) product.page = { id: String(row.id), path: String(row.path), title: String(row.title) }
  }

  // The row's existence is the capability, so a product with no row keeps the
  // null it was mapped with.
  for (const row of bookingRows) {
    const product = byId.get(String(row.product_id))
    if (!product) continue
    product.booking = {
      duration_minutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
      default_capacity: row.default_capacity === null ? null : Number(row.default_capacity),
      confirmation_mode: row.confirmation_mode as 'instant' | 'review', online_payment_required: Number(row.online_payment_required) === 1,
      held_online: Number(row.held_online) === 1,
      scheduling_mode: row.scheduling_mode as 'legacy' | 'provider', assigned_member_id: row.assigned_member_id === null ? null : String(row.assigned_member_id),
      assigned_team_id: row.assigned_team_id === null ? null : String(row.assigned_team_id),
    }
  }

  const valuesByOption = new Map<string, { id: string; value: string; sort_order: number }[]>()
  for (const row of valueRows) {
    const list = valuesByOption.get(String(row.product_option_id)) ?? []
    list.push({ id: String(row.id), value: String(row.value), sort_order: Number(row.sort_order) })
    valuesByOption.set(String(row.product_option_id), list)
  }
  for (const row of optionRows) {
    const option: ProductOption = {
      id: String(row.id), name: String(row.name), sort_order: Number(row.sort_order),
      values: valuesByOption.get(String(row.id)) ?? [],
    }
    byId.get(String(row.product_id))?.options.push(option)
  }

  const selectionsByVariant = new Map<string, Record<string, string>>()
  for (const row of selectionRows) {
    const current = selectionsByVariant.get(String(row.product_variant_id)) ?? {}
    current[String(row.product_option_id)] = String(row.product_option_value_id)
    selectionsByVariant.set(String(row.product_variant_id), current)
  }
  const pricesByVariant = new Map<string, Price[]>()
  for (const row of priceRows) {
    const list = pricesByVariant.get(String(row.product_variant_id)) ?? []
    list.push(mapPriceRow(row))
    pricesByVariant.set(String(row.product_variant_id), list)
  }
  for (const row of variantRows) {
    const variant: ProductVariant = {
      id: String(row.id), product_id: String(row.product_id), name: String(row.name),
      sku: row.sku === null ? null : String(row.sku), active: Number(row.active) === 1,
      sort_order: Number(row.sort_order),
      option_values: selectionsByVariant.get(String(row.id)) ?? {},
      prices: pricesByVariant.get(String(row.id)) ?? [],
    }
    byId.get(String(row.product_id))?.variants.push(variant)
  }

  for (const row of publicationRows) {
    byId.get(String(row.product_id))?.publications.push({ organization_id: String(row.organization_id), published: Number(row.published) === 1 })
  }
  for (const row of locationRows) {
    byId.get(String(row.product_id))?.locations.push({
      location_id: String(row.location_id), active: Number(row.active) === 1, published: Number(row.published) === 1,
    })
  }
  for (const row of collectionRows) {
    byId.get(String(row.product_id))?.collections.push({ collection_id: String(row.collection_id), sort_order: Number(row.sort_order) })
  }

  return products
}

/**
 * Attach media for a specific site.
 *
 * Media placements are site-scoped while the catalog is organization-scoped,
 * so the caller must say which site's imagery it wants. There is no "the
 * product's image" independent of a site, and no default site is assumed.
 */
export async function hydrateProductMedia(db: DbClient, organizationId: string, products: Product[]): Promise<Product[]> {
  if (!products.length) return products
  const placements = await loadPublicSocialMedia(db, organizationId, 'product', products.map(product => product.id))
  return products.map((product) => {
    const socialMedia = placements.get(product.id) ?? { media: [], social_image: null }
    return {
      ...product,
      image: socialMedia.media.find(item => item.slot === 'image') ?? null,
      gallery: socialMedia.media.filter(item => item.slot === 'gallery'),
      media: socialMedia.media,
      social_image: socialMedia.social_image,
    }
  })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getProduct(db: DbClient, organizationId: string, productId: string): Promise<Product> {
  const row = await queryFirst<Row>(db, `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.organization_id = ? AND p.id = ?`, [organizationId, productId])
  if (!row) notFound()
  const [product] = await hydrate(db, organizationId, [mapProductRow(row)])
  return product!
}

export async function listProducts(db: DbClient, organizationId: string): Promise<Product[]> {
  const rows = await queryAll<Row>(db, `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.organization_id = ? ORDER BY p.name, p.id`, [organizationId])
  return hydrate(db, organizationId, rows.map(mapProductRow))
}

/**
 * Products a site carries.
 *
 * `publishedOnly` narrows to published rows. There is no fallback to the
 * organization catalog when a site has published nothing: an empty site
 * catalog renders an empty state that says so.
 */
/** Public experiences use the same readiness check as publication, including sold-out sessions. */
async function publicProductWindow(db: DbClient, organizationId: string, products: Product[], window?: { limit: number; offset: number }, env?: CloudflareEnv, sharedPaymentSetup?: () => ReturnType<typeof readStripeCheckoutSetup>, bookableOnly = false): Promise<Product[]> {
  let setup: ReturnType<typeof readStripeCheckoutSetup> | undefined
  const paymentSetup = sharedPaymentSetup ?? (() => {
    if (!env) throw new Error('The organization environment is required to assess paid booking readiness')
    return setup ??= readStripeCheckoutSetup(db, organizationId, env)
  })
  // Readiness needs the currency and the scheduled sessions; a catalog of N
  // products read both N times. They are read once here and handed down.
  const needsReadiness = products.filter(product => bookableOnly ? Boolean(product.booking || product.order_url) : product.kind === 'experience' || Boolean(product.booking))
  const { listSessions } = await import('~/server/utils/availability')
  const [activeLocationIds, currency, allSessions] = await Promise.all([
    bookableOnly ? queryAll<{ id: string }>(db, "SELECT id FROM business_locations WHERE organization_id = ? AND status = 'active'", [organizationId]).then(rows => new Set(rows.map(location => location.id))) : undefined,
    needsReadiness.some(product => !product.order_url) ? organizationDefaultCurrency(db, organizationId) : undefined,
    needsReadiness.some(product => !product.order_url) ? listSessions(db, { organizationId, fromInstant: new Date().toISOString(), toInstant: new Date(Date.now() + 400 * 86_400_000).toISOString() }) : [],
  ])
  const sessionsByProduct = new Map<string, SessionAvailability[]>()
  for (const session of allSessions) {
    const list = sessionsByProduct.get(session.product_id) ?? []
    list.push(session)
    sessionsByProduct.set(session.product_id, list)
  }
  const readiness = (product: Product, extra: { requireActive?: boolean; activeLocationIds?: ReadonlySet<string> } = {}) =>
    productBookingReadiness(db, organizationId, product, { env, paymentSetup, currency, sessions: sessionsByProduct.get(product.id) ?? [], ...extra })
  const visible = await Promise.all(products.map(async product => bookableOnly
    ? Boolean(product.booking || product.order_url) && (await readiness(product, { requireActive: true, activeLocationIds })).ready
    : (product.kind !== 'experience' && !product.booking) || (await readiness(product)).ready))
  const published = products.filter((_, index) => visible[index])
  return window ? published.slice(window.offset, window.offset + window.limit + 1) : published
}

interface ProductListInput {
  organizationId: string; kind?: ProductKind; featured?: boolean; publishedOnly?: boolean; bookableOnly?: boolean; assignedUserId?: string; window?: { limit: number; offset: number }; env?: CloudflareEnv; paymentSetup?: () => ReturnType<typeof readStripeCheckoutSetup>
}

export interface ProductListResult {
  products: Product[]
  counts: { total: number; by_kind: Record<ProductKind, number> }
}

function productListCounts(rows: readonly { kind: ProductKind; count?: number }[]): ProductListResult['counts'] {
  const by_kind = Object.fromEntries(PRODUCT_KINDS.map(kind => [kind, 0])) as Record<ProductKind, number>
  for (const row of rows) by_kind[row.kind] += Number(row.count ?? 1)
  return { total: Object.values(by_kind).reduce((total, count) => total + count, 0), by_kind }
}

/** Editable catalogue pages read one extra row. Public readiness and counts precede pagination. */
export function listOrganizationProducts(db: DbClient, input: ProductListInput & { withCounts: true }): Promise<ProductListResult>
export function listOrganizationProducts(db: DbClient, input: ProductListInput & { withCounts?: false }): Promise<Product[]>
export async function listOrganizationProducts(db: DbClient, input: ProductListInput & { withCounts?: boolean }): Promise<Product[] | ProductListResult> {
  const requireReadiness = input.publishedOnly === true && (input.bookableOnly || !input.kind || input.kind === 'experience' || input.kind === 'service')
  const window = requireReadiness ? undefined : input.window
  const selection = `FROM products p
    JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
    WHERE p.organization_id = ? AND (? = 0 OR (${PUBLIC_PRODUCT_SQL}))${input.kind ? ' AND p.kind = ?' : ''}${input.featured === undefined ? '' : " AND COALESCE(json_extract(p.details_json, '$.featured'), 0) = ?"}${input.assignedUserId ? ` AND (${ASSIGNED_SERVICE_SQL})` : ''}`
  const params = [input.organizationId, input.publishedOnly ? 1 : 0,
    ...(input.kind ? [input.kind] : []),
    ...(input.featured === undefined ? [] : [Number(input.featured)]),
    ...(input.assignedUserId ? [input.assignedUserId, input.assignedUserId] : [])]
  const [rows, counts] = await Promise.all([
    queryAll<Row>(db, `SELECT ${PRODUCT_COLUMNS} ${selection} ORDER BY p.name, p.id ${window ? 'LIMIT ? OFFSET ?' : ''}`, [...params, ...(window ? [window.limit + 1, window.offset] : [])]),
    input.withCounts && window ? queryAll<{ kind: ProductKind; count: number }>(db, `SELECT p.kind, count(*) AS count ${selection} GROUP BY p.kind`, params) : undefined,
  ])
  const products = await hydrate(db, input.organizationId, rows.map(mapProductRow))
  if (!input.withCounts) return requireReadiness ? publicProductWindow(db, input.organizationId, products, input.window, input.env, input.paymentSetup, input.bookableOnly) : products
  const matching = requireReadiness ? await publicProductWindow(db, input.organizationId, products, undefined, input.env, input.paymentSetup, input.bookableOnly) : products
  return { products: requireReadiness && input.window ? matching.slice(input.window.offset, input.window.offset + input.window.limit + 1) : matching, counts: productListCounts(counts ?? matching) }
}

/**
 * Products offered at one location. Membership is its own relationship, not a
 * price.
 *
 * `publishedOnly` asks the public question: a product is publicly visible at a
 * location when both the organization and location publish it. Pausing an
 * offering disables ordering or booking while its information stays visible.
 */
export function listLocationProducts(db: DbClient, input: ProductListInput & { locationId: string; withCounts: true }): Promise<ProductListResult>
export function listLocationProducts(db: DbClient, input: ProductListInput & { locationId: string; withCounts?: false }): Promise<Product[]>
export async function listLocationProducts(db: DbClient, input: ProductListInput & { locationId: string; withCounts?: boolean }): Promise<Product[] | ProductListResult> {
  const published = input.publishedOnly === true
  const requireReadiness = published && (input.bookableOnly || !input.kind || input.kind === 'experience' || input.kind === 'service')
  const window = requireReadiness ? undefined : input.window
  const selection = `FROM products p
    JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id
    ${published ? `JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      AND (${PUBLIC_PRODUCT_SQL})` : ''}
    WHERE p.organization_id = ? AND pl.location_id = ?${published ? ' AND pl.published = 1' : ''}${input.kind ? ' AND p.kind = ?' : ''}${input.featured === undefined ? '' : " AND COALESCE(json_extract(p.details_json, '$.featured'), 0) = ?"}${input.assignedUserId ? ` AND (${ASSIGNED_SERVICE_SQL})` : ''}`
  const params = [input.organizationId, input.locationId,
    ...(input.kind ? [input.kind] : []),
    ...(input.featured === undefined ? [] : [Number(input.featured)]),
    ...(input.assignedUserId ? [input.assignedUserId, input.assignedUserId] : [])]
  const [rows, counts] = await Promise.all([
    queryAll<Row>(db, `SELECT ${PRODUCT_COLUMNS} ${selection} ORDER BY p.name, p.id ${window ? 'LIMIT ? OFFSET ?' : ''}`, [...params, ...(window ? [window.limit + 1, window.offset] : [])]),
    input.withCounts && window ? queryAll<{ kind: ProductKind; count: number }>(db, `SELECT p.kind, count(*) AS count ${selection} GROUP BY p.kind`, params) : undefined,
  ])
  const products = await hydrate(db, input.organizationId, rows.map(mapProductRow))
  if (!input.withCounts) return requireReadiness ? publicProductWindow(db, input.organizationId, products, input.window, input.env, input.paymentSetup, input.bookableOnly) : products
  const matching = requireReadiness ? await publicProductWindow(db, input.organizationId, products, undefined, input.env, input.paymentSetup, input.bookableOnly) : products
  return { products: requireReadiness && input.window ? matching.slice(input.window.offset, input.window.offset + input.window.limit + 1) : matching, counts: productListCounts(counts ?? matching) }
}

/** Count the location’s products by their explicit type without hydrating the catalog. */
export async function summarizeLocationProducts(db: DbClient, input: {
  organizationId: string; locationId: string
}): Promise<CatalogCounts> {
  const row = await queryFirst<{ total: number; experiences: number; dishes: number }>(db, `
    SELECT count(*) AS total,
           count(CASE WHEN p.kind = 'experience' THEN 1 END) AS experiences,
           count(CASE WHEN p.kind = 'dish' THEN 1 END) AS dishes
      FROM products p
      JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id
     WHERE p.organization_id = ? AND pl.location_id = ?
  `, [input.organizationId, input.locationId])
  // The same two numbers countCatalog reads off the rows, so a surface is
  // assigned identically whether the caller counted rows or SQL did.
  return { total: Number(row?.total ?? 0), experiences: Number(row?.experiences ?? 0), dishes: Number(row?.dishes ?? 0) }
}

export async function listCollectionProducts(db: DbClient, input: {
  organizationId: string; collectionId: string
}): Promise<Product[]> {
  const rows = await queryAll<Row>(db, `
    SELECT ${PRODUCT_COLUMNS} FROM products p
    JOIN collection_products cp ON cp.product_id = p.id AND cp.organization_id = p.organization_id
    WHERE p.organization_id = ? AND cp.collection_id = ?
    ORDER BY cp.sort_order, p.id
  `, [input.organizationId, input.collectionId])
  return hydrate(db, input.organizationId, rows.map(mapProductRow))
}

/**
 * The Product this site carries, or a 404.
 *
 * Ownership is the product's organization_id, independently of publication.
 */
export async function requireOrganizationProduct(db: DbClient, input: {
  organizationId: string; productId: string
}): Promise<Product> {
  return getProduct(db, input.organizationId, input.productId)
}

export async function getProductBySlug(db: DbClient, organizationId: string, slug: string): Promise<Product | null> {
  const row = await queryFirst<Row>(db, `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.organization_id = ? AND p.slug = ?`, [organizationId, slug])
  if (!row) return null
  const [product] = await hydrate(db, organizationId, [mapProductRow(row)])
  return product!
}

/**
 * Resolve the price a specific surface should show.
 *
 * A thin, explicit wrapper over the one selection contract, so callers state
 * their currency and location instead of reaching into `variant.prices` and
 * inventing a rule. It throws on ambiguity and returns null when no offer
 * applies — the caller renders an empty state, never a substitute.
 */
export function resolveVariantPrice(variant: ProductVariant, selection: PriceSelection): Price | null {
  return selectPrice(variant.prices, selection)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface Actor { actorId: string }

/** A write receipt, never a field on a stored or read Product. */
export type ProductMutation = Product & { channel_push: ChannelPush | null }

export function slugCandidate(base: string, attempt: number): string {
  const normalized = base.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, PRODUCT_LIMITS.slug)
  const root = normalized || 'product'
  return attempt === 0 ? root : `${root}-${attempt + 1}`
}

/**
 * A slug no other product in this organization holds.
 *
 * `taken` carries the slugs a batch has already claimed but not yet written,
 * so a hundred products in one request do not all take the same free slug —
 * and do not each ask the database whether they may.
 */
/**
 * A slug nothing else in this organization holds.
 *
 * `known` is the organization's slugs, already loaded — a bulk caller reads
 * them once instead of asking the database for every candidate of every
 * product. Without it each candidate is a round trip.
 */
export async function createProductSlug(
  db: DbClient,
  organizationId: string,
  base: string,
  excludeId?: string,
  taken?: Set<string>,
  known?: ReadonlyMap<string, string>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SLUG_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = slugCandidate(base, attempt)
    if (taken?.has(candidate)) continue
    const holder = known
      ? known.get(candidate) ?? null
      : (await queryFirst<{ id: string }>(db, 'SELECT id FROM products WHERE organization_id = ? AND slug = ? AND id <> COALESCE(?, \'\')', [organizationId, candidate, excludeId ?? null]))?.id ?? null
    if (!holder || holder === excludeId) {
      taken?.add(candidate)
      return candidate
    }
  }
  conflict('Could not derive a unique product slug')
}

/** Every slug this organization holds, so a batch derives its own without asking again. */
async function loadProductSlugs(db: DbClient, organizationId: string): Promise<Map<string, string>> {
  const rows = await queryAll<{ id: string; slug: string }>(db, 'SELECT id, slug FROM products WHERE organization_id = ?', [organizationId])
  return new Map(rows.map(row => [row.slug, row.id]))
}

async function organizationDefaultCurrency(db: DbClient, organizationId: string): Promise<CurrencyCode> {
  // Currency comes from an explicit site when the caller has one. With no site
  // context the caller must supply the currency on the price itself; there is
  // no platform default standing in for a merchant's decision.
  if (!organizationId) invalid('currency is required when no organization context is given')
  const organization = await queryFirst<{ default_currency: string }>(db, 'SELECT default_currency FROM organization WHERE id = ?', [organizationId])
  if (!organization) notFound('Organization not found')
  if (!isCurrencyCode(organization.default_currency)) throw new Error(`Organization ${organizationId} has an unsupported default currency`)
  return organization.default_currency
}

interface NormalizedPrice {
  id: string
  location_id: string | null
  active: boolean
  currency: CurrencyCode
  unit_amount: number
  type: Price['type']
  recurring_interval: Price['recurring_interval']
  recurring_interval_count: number | null
  tax_behavior: Price['tax_behavior']
  compare_at_unit_amount: number | null
  valid_from_at: string | null
  valid_until_at: string | null
  source: string
}

export function normalizePriceInput(input: PriceInput, defaultCurrency: CurrencyCode | null, field = 'price'): NormalizedPrice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`${field} must be an object`)
  const currency = input.currency ?? defaultCurrency
  if (!currency || !isCurrencyCode(currency)) invalid(`${field}.currency must be a supported currency`)
  const type = input.type ?? 'one_time'
  if (!PRICE_TYPES.includes(type)) invalid(`${field}.type must be one of: ${PRICE_TYPES.join(', ')}`)
  const interval = input.recurring_interval ?? null
  if (interval !== null && !PRICE_RECURRING_INTERVALS.includes(interval)) {
    invalid(`${field}.recurring_interval must be one of: ${PRICE_RECURRING_INTERVALS.join(', ')}`)
  }
  const taxBehavior = input.tax_behavior ?? 'unspecified'
  if (!PRICE_TAX_BEHAVIORS.includes(taxBehavior)) invalid(`${field}.tax_behavior must be supported`)
  const normalized: NormalizedPrice = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : crypto.randomUUID(),
    location_id: input.location_id ?? null,
    active: input.active ?? true,
    currency,
    unit_amount: input.unit_amount,
    type,
    recurring_interval: interval,
    recurring_interval_count: input.recurring_interval_count ?? null,
    tax_behavior: taxBehavior,
    compare_at_unit_amount: input.compare_at_unit_amount ?? null,
    valid_from_at: input.valid_from_at ?? null,
    valid_until_at: input.valid_until_at ?? null,
    source: input.source ?? 'manual',
  }
  // One shape validator, shared with the read path and the Stripe adapter.
  try { assertPriceShape(normalized) }
  catch (error) { invalid(`${field}: ${error instanceof Error ? error.message : String(error)}`) }
  return normalized
}

interface PlannedOption { id: string; name: string; sort_order: number; values: { id: string; value: string; sort_order: number }[] }
interface PlannedVariant {
  id: string
  name: string
  sku: string | null
  active: boolean
  sort_order: number
  /** Resolved to concrete option and value row ids. */
  option_values: Record<string, string>
  prices: NormalizedPrice[]
}

interface PlannedProduct {
  kind: ProductKind
  id: string
  name: string
  slug: string
  description: string
  active: boolean
  order_url: string | null
  unit_label: string | null
  marketing_features: string[]
  metadata: Record<string, string>
  tax_code: string | null
  options: PlannedOption[]
  variants: PlannedVariant[]
  details: Record<string, ProductDetailValue>
  source: ProductSource
  stay: ProductStayConfig | null
}

const STAY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** A place to stay is priced per night; no other unit describes its base rate. */
function stayUnitLabel(kind: ProductKind, unitLabel: string | null): string | null {
  if (kind !== 'stay') return unitLabel
  if (unitLabel !== null && unitLabel !== 'night') invalid('A place to stay is priced per night')
  return 'night'
}

/** A place to stay is at one location of this organization, with stay settings the calendar and channels enforce. */
async function planStayConfig(db: DbClient, organizationId: string, kind: ProductKind, value: unknown): Promise<ProductStayConfig | null> {
  if (kind !== 'stay') {
    if (value !== undefined && value !== null) invalid('Only a place to stay takes stay settings')
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('A place to stay needs its location, check-in and check-out times and maximum guests')
  const stay = value as Record<string, unknown>
  const locationId = typeof stay.location_id === 'string' ? stay.location_id.trim() : ''
  if (!locationId) invalid('stay.location_id is required')
  for (const field of ['check_in_time', 'check_out_time'] as const) {
    if (typeof stay[field] !== 'string' || !STAY_TIME.test(stay[field] as string)) invalid(`stay.${field} must be a 24-hour HH:MM time`)
  }
  const maxGuests = stay.max_guests
  if (typeof maxGuests !== 'number' || !Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > 99) invalid('stay.max_guests must be a whole number from 1 to 99')
  const minNights = stay.min_nights ?? 1
  if (typeof minNights !== 'number' || !Number.isInteger(minNights) || minNights < 1 || minNights > 365) invalid('stay.min_nights must be a whole number from 1 to 365')
  const location = await queryFirst<{ id: string }>(db, 'SELECT id FROM business_locations WHERE organization_id = ? AND id = ?', [organizationId, locationId])
  if (!location) notFound('That location is not in this organization')
  const assignedMemberId = stay.assigned_member_id ?? null
  const assignedTeamId = stay.assigned_team_id ?? null
  if (assignedMemberId !== null && (typeof assignedMemberId !== 'string' || !await queryFirst(db, 'SELECT 1 FROM member WHERE organizationId = ? AND id = ?', [organizationId, assignedMemberId]))) notFound('stay.assigned_member_id is not a member of this organization')
  if (assignedTeamId !== null && (typeof assignedTeamId !== 'string' || !await queryFirst(db, 'SELECT 1 FROM team WHERE organizationId = ? AND id = ?', [organizationId, assignedTeamId]))) notFound('stay.assigned_team_id is not a team of this organization')
  return { location_id: locationId, check_in_time: stay.check_in_time as string, check_out_time: stay.check_out_time as string, max_guests: maxGuests, min_nights: minNights, assigned_member_id: assignedMemberId as string | null, assigned_team_id: assignedTeamId as string | null }
}

async function assertBookableOffering(db: DbClient, organizationId: string, product: PlannedProduct, locationId: string | null): Promise<void> {
  if (!['experience', 'service'].includes(product.kind)) invalid('Only experiences and services take scheduled bookings')
  if (!product.active) invalid('Enable this offering before publishing its bookings')
  const currency = await organizationDefaultCurrency(db, organizationId)
  const variants = product.variants.filter(variant => variant.active)
  if (!currency || !variants.length || !variants.every(variant => selectPrice(variant.prices, { currency, location_id: locationId })?.type === 'one_time')) invalid('Provide a current one-time price for every active option, including explicit zero for a free offering, before creating bookings')
}

/**
 * Give every option, value and variant a concrete id before anything is
 * written.
 *
 * Ids supplied by the caller are kept. That is what makes an edit an edit: a
 * variant that keeps its id keeps the bookings and prices pointing at it,
 * rather than being deleted and recreated as a stranger.
 */
/**
 * Give every option and value its real id, and restate each variant's
 * selections in those ids.
 *
 * A value label is unique within its option, never across them: a mug with
 * "Inside colour: White" and "Outside colour: White" has two different values
 * that read the same. Resolution is therefore per option, and a reference that
 * resolves to nothing is rejected here rather than passed through as a raw key
 * for a foreign key to refuse later.
 */
function resolveIds(options: NormalizedProductOption[], variants: NormalizedProductVariant[]): { options: PlannedOption[]; variantOptionValues: Map<string, Record<string, string>> } {
  const optionIds = new Map<string, string>()
  const valueIdsByOption = new Map<string, Map<string, string>>()
  const planned = options.map((option) => {
    const id = option.id ?? crypto.randomUUID()
    const optionKey = option.id ?? option.name
    optionIds.set(optionKey, id)
    const valueIds = new Map<string, string>()
    valueIdsByOption.set(optionKey, valueIds)
    return {
      id, name: option.name, sort_order: option.sort_order,
      values: option.values.map((value) => {
        const valueId = value.id ?? crypto.randomUUID()
        valueIds.set(value.id ?? value.value, valueId)
        return { id: valueId, value: value.value, sort_order: value.sort_order }
      }),
    }
  })
  const variantOptionValues = new Map<string, Record<string, string>>()
  variants.forEach((variant, index) => {
    variantOptionValues.set(variant.id ?? String(index), Object.fromEntries(
      Object.entries(variant.option_values).map(([optionKey, valueKey]) => {
        const optionId = optionIds.get(optionKey)
        const valueId = valueIdsByOption.get(optionKey)?.get(valueKey)
        if (!optionId || !valueId) invalid(`variants[${index}] selects ${optionKey} = ${valueKey}, which this product does not define`)
        return [optionId, valueId]
      }),
    ))
  })
  return { options: planned, variantOptionValues }
}

/**
 * Every id the caller supplied is either new or already this product's.
 *
 * The writes below upsert by primary key, so an id belonging to another
 * tenant's product would land an update on their row. Authorizing the site the
 * caller is editing says nothing about an id in the body, so each one is
 * checked against the product being written.
 */
const SUPPLIED_ID_TABLES = ['product_options', 'product_option_values', 'product_variants'] as const
type SuppliedIdTable = typeof SUPPLIED_ID_TABLES[number]
/** Who owns each supplied id today: table → id → `<organization>:<product>`. */
export type SuppliedIdOwners = ReadonlyMap<SuppliedIdTable, ReadonlyMap<string, string>>

function suppliedIds(options: NormalizedProductOption[], variants: NormalizedProductVariant[]): Record<SuppliedIdTable, string[]> {
  return {
    product_options: options.map(option => option.id).filter((id): id is string => Boolean(id)),
    product_option_values: options.flatMap(option => option.values.map(value => value.id)).filter((id): id is string => Boolean(id)),
    product_variants: variants.map(variant => variant.id).filter((id): id is string => Boolean(id)),
  }
}

/**
 * Load the owner of every id a batch supplies, in one query per table.
 *
 * The check below is the same either way; this only decides whether it costs
 * three round trips for the whole batch or three for every product in it.
 */
async function loadSuppliedIdOwners(db: DbClient, ids: Record<SuppliedIdTable, string[]>): Promise<SuppliedIdOwners> {
  const owners = new Map<SuppliedIdTable, Map<string, string>>()
  for (const table of SUPPLIED_ID_TABLES) {
    const table_ids = ids[table]
    const index = new Map<string, string>()
    owners.set(table, index)
    if (table_ids.length === 0) continue
    const rows = await queryAll<{ id: string; organization_id: string; product_id: string | null }>(db, `
      SELECT id, organization_id, product_id FROM ${table} WHERE id IN (SELECT value FROM json_each(?))
    `, [d1JsonArray(table_ids)])
    for (const row of rows) index.set(String(row.id), `${row.organization_id}:${row.product_id ?? ''}`)
  }
  return owners
}

async function assertSuppliedIdsBelongHere(
  db: DbClient,
  organizationId: string,
  productId: string | null,
  options: NormalizedProductOption[],
  variants: NormalizedProductVariant[],
  owners?: SuppliedIdOwners,
): Promise<void> {
  const supplied = suppliedIds(options, variants)
  const here = `${organizationId}:${productId ?? ''}`
  for (const table of SUPPLIED_ID_TABLES) {
    const ids = supplied[table]
    if (ids.length === 0) continue
    const foreign = owners
      ? ids.filter((id) => {
          const owner = owners.get(table)?.get(id)
          return owner !== undefined && owner !== here
        })
      : (await queryAll<{ id: string }>(db, `
          SELECT id FROM ${table}
           WHERE id IN (SELECT value FROM json_each(?))
             AND NOT (organization_id = ? AND product_id IS ?)
        `, [d1JsonArray(ids), organizationId, productId])).map(row => String(row.id))
    if (foreign.length > 0) {
      notFound(`${table.replace('product_', '').replaceAll('_', ' ')} ${foreign.join(', ')} does not belong to this product`)
    }
  }
}

/**
 * Turn an input into the exact rows a product needs.
 *
 * A product with no customer-selectable options still gets one real default
 * variant. That variant is not a placeholder and not a special case in the
 * read path — every purchase, price and booking goes through variant identity,
 * so there is exactly one purchase path in the system.
 */
async function planProduct(
  db: DbClient,
  organizationId: string,
  input: CreateProductInput,
  context: {
    organizationId?: string
    existingId?: string
    defaultCurrency?: CurrencyCode | null
    takenSlugs?: Set<string>
    /** Preloaded answers for a batch: same rules, one round trip instead of per product. */
    idOwners?: SuppliedIdOwners
    knownSlugs?: ReadonlyMap<string, string>
  },
): Promise<PlannedProduct> {
  let kind: ProductKind
  try { kind = assertProductKind(input.kind); validateProductDetails(kind, input.details ?? {}) }
  catch (error) { if (!(error instanceof ProductDetailError)) throw error; invalid(error.message) }
  const name = requireTrimmedProductString(input.name, 'name', PRODUCT_LIMITS.name)
  const options = validateProductOptions(input.options)
  const variants = input.variants === undefined
    ? [{ name, sku: null, active: true, sort_order: 0, option_values: {} } satisfies NormalizedProductVariant]
    : validateProductVariants(input.variants, options)
  if (options.length > 0 && input.variants === undefined) {
    invalid('a product with options must declare the variants that select them')
  }

  await assertSuppliedIdsBelongHere(db, organizationId, context.existingId ?? null, options, variants, context.idOwners)

  // One site has one default currency: a batch resolves it once and hands it
  // down, rather than asking the same question for every product in it.
  const defaultCurrency = context.defaultCurrency !== undefined
    ? context.defaultCurrency
    : context.organizationId ? await organizationDefaultCurrency(db, organizationId) : null
  const declaredVariants = input.variants ?? []
  const resolved = resolveIds(options, variants)
  const plannedVariants: PlannedVariant[] = variants.map((variant, index) => ({
    id: variant.id ?? crypto.randomUUID(),
    name: variant.name,
    sku: variant.sku,
    active: variant.active,
    sort_order: variant.sort_order,
    option_values: resolved.variantOptionValues.get(variant.id ?? String(index)) ?? {},
    prices: (declaredVariants[index]?.prices ?? []).map((price, priceIndex) =>
      normalizePriceInput(price, defaultCurrency, `variants[${index}].prices[${priceIndex}]`)),
  }))

  return {
    id: context.existingId ?? crypto.randomUUID(),
    name,
    slug: await createProductSlug(db, organizationId, name, context.existingId, context.takenSlugs, context.knownSlugs),
    // An empty description is a real choice, not a missing field. Only its
    // length is constrained.
    description: normalizeOptionalProductString(input.description, 'description', PRODUCT_LIMITS.description) ?? '',
    active: input.active ?? true,
    order_url: validateProductOrderUrl(input.order_url),
    unit_label: stayUnitLabel(kind, validateProductUnitLabel(input.unit_label)),
    marketing_features: validateProductMarketingFeatures(input.marketing_features),
    metadata: validateProductMetadata(input.metadata),
    tax_code: normalizeOptionalProductString(input.tax_code, 'tax_code', PRODUCT_LIMITS.taxCode),
    options: resolved.options,
    variants: plannedVariants,
    kind,
    details: validateProductDetails(kind, input.details ?? {}),
    source: input.source ?? 'manual',
    stay: await planStayConfig(db, organizationId, kind, input.stay),
  }
}

/**
 * Build the writes for one product's rows.
 *
 * Returns queries rather than executing, so create, update, batch and
 * reconcile all commit through a single `executeBatch` and cannot leave a
 * product half-written.
 */
function productWrites(
  organizationId: string,
  planned: PlannedProduct,
  actor: Actor,
  now: string,
  mode: 'insert' | 'upsert',
  // Prices are rewritten only by a caller that actually supplied variants.
  // Saving a description restates nothing about money, and must not retire and
  // remint every offer a product has.
  options: { writePrices: boolean; priceIds?: ReadonlySet<string>; writeOptions?: boolean; variantIds?: ReadonlySet<string>; expectedUpdatedAt?: string; writeStay?: boolean } = { writePrices: true },
): BatchQuery[] {
  const upsert = mode === 'upsert'
  const writes: BatchQuery[] = [{
    query: upsert
      ? `INSERT INTO products (id, organization_id, name, slug, description, active, order_url, unit_label,
             marketing_features, metadata, tax_code, source, kind, details_json, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${options.expectedUpdatedAt === undefined ? '?' : 'CASE WHEN EXISTS (SELECT 1 FROM products WHERE organization_id=? AND id=? AND updated_at=?) THEN ? ELSE NULL END'}, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, slug = excluded.slug, description = excluded.description,
             active = excluded.active, order_url = excluded.order_url, unit_label = excluded.unit_label,
             marketing_features = excluded.marketing_features, metadata = excluded.metadata,
             tax_code = excluded.tax_code, kind = excluded.kind, details_json = excluded.details_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
           WHERE products.organization_id = excluded.organization_id`
      : `INSERT INTO products (id, organization_id, name, slug, description, active, order_url, unit_label,
             marketing_features, metadata, tax_code, source, kind, details_json, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [planned.id, organizationId, planned.name, planned.slug, planned.description, planned.active ? 1 : 0,
      planned.order_url, planned.unit_label, JSON.stringify(planned.marketing_features),
      JSON.stringify(planned.metadata), planned.tax_code, planned.source, planned.kind, JSON.stringify(planned.details), now,
      ...(options.expectedUpdatedAt === undefined ? [] : [organizationId, planned.id, options.expectedUpdatedAt]), now, actor.actorId, actor.actorId],
  }]

  // Stay settings are written when created or when an edit names them, so an
  // unrelated save never restates settings someone else changed.
  if (planned.stay && options.writeStay !== false) {
    // The location relationship first: the stay settings name it, so a home's one
    // location is the relationship its config holds.
    writes.push({
      // Its one location shows it: whether the public sees it is the product's
      // publication, which a place to stay takes only with its booking link.
      query: `INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by)
               VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?) ON CONFLICT (product_id, location_id) DO NOTHING`,
      params: [organizationId, planned.id, planned.stay.location_id, now, now, actor.actorId, actor.actorId],
    }, {
      query: `INSERT INTO product_stay_configs (product_id, organization_id, location_id, check_in_time, check_out_time, max_guests, min_nights, assigned_member_id, assigned_team_id, created_at, updated_at, created_by, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (product_id) DO UPDATE SET check_in_time = excluded.check_in_time, check_out_time = excluded.check_out_time,
                 max_guests = excluded.max_guests, min_nights = excluded.min_nights, assigned_member_id = excluded.assigned_member_id,
                 assigned_team_id = excluded.assigned_team_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by
               WHERE product_stay_configs.organization_id = excluded.organization_id AND product_stay_configs.location_id = excluded.location_id`,
      params: [planned.id, organizationId, planned.stay.location_id, planned.stay.check_in_time, planned.stay.check_out_time,
        planned.stay.max_guests, planned.stay.min_nights, planned.stay.assigned_member_id, planned.stay.assigned_team_id, now, now, actor.actorId, actor.actorId],
    })
  }

  for (const option of options.writeOptions === false ? [] : planned.options) {
    writes.push({
      query: upsert
        ? `INSERT INTO product_options (id, organization_id, product_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, updated_at = excluded.updated_at
             WHERE product_options.organization_id = excluded.organization_id AND product_options.product_id = excluded.product_id`
        : `INSERT INTO product_options (id, organization_id, product_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [option.id, organizationId, planned.id, option.name, option.sort_order, now, now],
    })
    for (const value of option.values) {
      writes.push({
        query: upsert
          ? `INSERT INTO product_option_values (id, organization_id, product_id, product_option_id, value, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET value = excluded.value, sort_order = excluded.sort_order, updated_at = excluded.updated_at
               WHERE product_option_values.organization_id = excluded.organization_id AND product_option_values.product_id = excluded.product_id`
          : `INSERT INTO product_option_values (id, organization_id, product_id, product_option_id, value, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [value.id, organizationId, planned.id, option.id, value.value, value.sort_order, now, now],
      })
    }
  }

  for (const variant of planned.variants) {
    if (!options.variantIds || options.variantIds.has(variant.id)) writes.push({
      query: upsert
        ? `INSERT INTO product_variants (id, organization_id, product_id, name, sku, active, sort_order, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, sku = excluded.sku, active = excluded.active,
               sort_order = excluded.sort_order, updated_at = excluded.updated_at, updated_by = excluded.updated_by
             WHERE product_variants.organization_id = excluded.organization_id AND product_variants.product_id = excluded.product_id`
        : `INSERT INTO product_variants (id, organization_id, product_id, name, sku, active, sort_order, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [variant.id, organizationId, planned.id, variant.name, variant.sku, variant.active ? 1 : 0, variant.sort_order, now, now, actor.actorId, actor.actorId],
    })
    for (const [optionId, valueId] of Object.entries(variant.option_values)) {
      writes.push({
        query: `INSERT INTO product_variant_option_values (organization_id, product_id, product_variant_id, product_option_id, product_option_value_id)
                VALUES (?, ?, ?, ?, ?)`,
        params: [organizationId, planned.id, variant.id, optionId, valueId],
      })
    }
    for (const price of options.writePrices ? variant.prices : []) {
      if (options.priceIds && !options.priceIds.has(price.id)) continue
      // A restated price keeps its row: payments and checkout holds reference
      // price ids, and a kept row keeps when it was created.
      writes.push({
        query: upsert
          ? `INSERT INTO prices (id, organization_id, product_variant_id, location_id, active, currency, unit_amount, type,
                  recurring_interval, recurring_interval_count, tax_behavior, compare_at_unit_amount, valid_from_at, valid_until_at,
                  source, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET location_id = excluded.location_id, active = excluded.active, currency = excluded.currency,
                  unit_amount = excluded.unit_amount, type = excluded.type, recurring_interval = excluded.recurring_interval,
                  recurring_interval_count = excluded.recurring_interval_count, tax_behavior = excluded.tax_behavior,
                  compare_at_unit_amount = excluded.compare_at_unit_amount, valid_from_at = excluded.valid_from_at,
                  valid_until_at = excluded.valid_until_at, source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by
                WHERE prices.organization_id = excluded.organization_id AND prices.product_variant_id = excluded.product_variant_id`
          : `INSERT INTO prices (id, organization_id, product_variant_id, location_id, active, currency, unit_amount, type,
                  recurring_interval, recurring_interval_count, tax_behavior, compare_at_unit_amount, valid_from_at, valid_until_at,
                  source, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [price.id, organizationId, variant.id, price.location_id, price.active ? 1 : 0, price.currency, price.unit_amount,
          price.type, price.recurring_interval, price.recurring_interval_count, price.tax_behavior, price.compare_at_unit_amount,
          price.valid_from_at, price.valid_until_at, price.source, now, now, actor.actorId, actor.actorId],
      })
    }
  }

  return writes
}

function assertVariantPricesConsistent(planned: PlannedProduct): void {
  // A product is priced in numbers or in words, never both. Whichever the
  // merchant chose is the one source the page reads; two would need a
  // precedence rule, and a precedence rule is a fallback.
  const note = planned.details[PRICING_NOTE_HANDLE]
  const priced = planned.variants.some(variant => variant.prices.length > 0)
  if (typeof note === 'string' && note.trim() !== '' && priced) {
    invalid(`a product states ${PRICING_NOTE_HANDLE} or a numeric price, not both`)
  }
  for (const variant of planned.variants) {
    if (variant.prices.length < 2) continue
    // Refuse two simultaneously-valid offers of the same scope at write time,
    // so the person creating them sees the conflict instead of a customer
    // hitting an ambiguous selection at checkout.
    assertNoConflictingPrices(variant.prices.map(price => ({
      ...price,
      organization_id: 'scope',
      product_variant_id: variant.id,
      created_by: 'scope', updated_by: 'scope', created_at: '', updated_at: '',
    })))
  }
}

type ProductPageInput = { data: Omit<TenantPageEditorInput, 'productId' | 'pageId' | 'locale' | 'path'> & { path?: string }; env: CloudflareEnv }

function productPageInput(product: Pick<CreateProductInput, 'kind' | 'name' | 'description'>, env?: CloudflareEnv, page?: ProductPageInput): ProductPageInput | undefined {
  return page ?? (product.kind === 'service'
    ? { data: { title: product.name, summary: product.description ?? null, pageType: 'recipe', recipe: 'services', blocks: [] }, env: env ?? invalid('The service page requires the organization environment') }
    : undefined)
}

export async function publishStayProducts(env: CloudflareEnv, products: readonly Product[]): Promise<void> {
  for (const product of products) {
    if (product.kind !== 'stay') continue
    if (!product.stay) throw new HTTPError({ statusCode: 500, message: 'The place to stay has no home configuration', data: { code: 'STAY_HOME_CONFIGURATION_REQUIRED', field: 'stay' } })
    const input = { organizationId: product.organization_id, productId: product.id, locationId: product.stay.location_id, stayId: null }
    await publishStayInvalidation(env, { ...input, type: 'stay.changed' }, { updated_at: product.updated_at })
    await publishStayInvalidation(env, { ...input, type: 'nights.changed' }, { updated_at: product.updated_at })
  }
}


/**
 * Create one product, and — when the caller asks — the source page it owns,
 * in one batch: the product, its default variant, its publication, the page
 * and the binding commit together or not at all.
 *
 * `idempotencyKey` makes a retry of the same request return what it created:
 * the record is the creation's audit row, written in the same batch under a
 * unique key, so a lost response or a concurrent duplicate never makes a
 * second product. The same key with a different request conflicts.
 */

export async function createProduct(db: DbClient, input: {
  organizationId: string
  product: CreateProductInput
  actor: Actor
  env: CloudflareEnv
  /** Publish it on `organizationId` in the same batch — see planProductCreateWrites. */
  publication?: { published: boolean }
  /**
   * A source page created with the product and bound to it, through the one
   * page writer. A service's page may omit its path: it is given the first
   * free `/services/<slug>`, once, and keeps it when the product is renamed.
   */
  page?: ProductPageInput
  idempotencyKey?: string
  booking?: { data: ProductBookingSetupInput; env: CloudflareEnv }
}): Promise<Product> {
  const key = input.idempotencyKey?.trim()
  if (input.idempotencyKey !== undefined && (!key || key.length > 200)) invalid('idempotency_key must be 1 to 200 characters')
  const env = input.env
  const pageInput = productPageInput(input.product, env, input.page)
  const product = input.product
  const dedupeKey = key ? creationDedupeKey('product', input.organizationId, key) : null
  const requestHash = dedupeKey ? await creationRequestHash({ product, page: pageInput?.data ?? null, publication: input.publication ?? null, booking: input.booking?.data ?? null }) : null
  const replay = async (): Promise<Product | null> => {
    if (!dedupeKey) return null
    const record = await readCreationRecord(db, dedupeKey)
    if (!record) return null
    if (record.requestHash !== requestHash) conflict('This idempotency_key was already used for a different product')
    const existing = await queryFirst<{ id: string }>(db, 'SELECT id FROM products WHERE organization_id = ? AND id = ?', [input.organizationId, record.entityId])
    if (!existing) throw new HTTPError({ statusCode: 410, statusMessage: 'The product this idempotency_key created has been deleted; it is not created again' })
    const created = await getProduct(db, input.organizationId, record.entityId)
    if (created.page && pageInput) await refreshTenantPageCard(db, pageInput.env, { variantId: created.page.id, path: created.page.path }, input.actor.actorId)
    await publishStayProducts(env, [created])
    return created
  }
  const earlier = await replay()
  if (earlier) return earlier

  const planned = await planProduct(db, input.organizationId, product, { organizationId: input.organizationId })
  assertVariantPricesConsistent(planned)
  const now = new Date().toISOString()
  const writes = productWrites(input.organizationId, planned, input.actor, now, 'insert')
  if (input.booking) {
    await assertBookableOffering(db, input.organizationId, planned, input.booking.data.location_id)
    const { prepareProductBookingSetup } = await import('~/server/utils/availability')
    writes.push(...await prepareProductBookingSetup(db, { organizationId: input.organizationId, productId: planned.id, actorId: input.actor.actorId, env: input.booking.env, now, booking: input.booking.data, productInSameBatch: true }))
  }
  if (input.publication?.published && planned.kind === 'experience' && !input.booking && !planned.order_url) invalid('Provide booking details or an external booking destination before publishing an experience')
  if (input.publication?.published) assertStayPublishable(planned)
  const page = await prepareProductPageCreate(db, { organizationId: input.organizationId, product: planned, actor: input.actor, page: pageInput, env })
  if (page) writes.push(...page.queries)
  if (input.publication && input.organizationId) {
    writes.push({
      query: `INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [input.organizationId, planned.id, input.publication.published ? 1 : 0, now, now, input.actor.actorId, input.actor.actorId],
    })
    writes.push(publicResourceCacheInvalidationQuery(input.organizationId, 'product_created'))
  }
  writes.push(organizationEventQuery({
    organizationId: input.organizationId, actorId: input.actor.actorId, eventType: 'product.created', entityType: 'product', entityId: planned.id,
    ...(dedupeKey ? { metadata: { request_hash: requestHash, page_id: page?.variantId ?? null }, dedupeKey } : {}),
  }))
  if (writes.length > MAX_D1_BATCH_STATEMENTS) invalid('This offering has too many schedule entries for one atomic write')
  try {
    await executeBatch(db, writes, { operation: 'Create product' })
  } catch (error) {
    if (isUniqueDedupeConflict(error)) {
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
    if (isProductPageConflict(error)) conflict('Product already has a canonical page')
    if (input.booking) {
      const { bookingConfigurationWriteError } = await import('~/server/utils/availability')
      throw bookingConfigurationWriteError(error)
    }
    throw error
  }
  // The product and its page are committed. The page's social card is drawn
  // after, and a failure there is reported as itself; a retry under the same
  // key returns this product rather than making another.
  if (page && pageInput) await refreshTenantPageCard(db, pageInput.env, page, input.actor.actorId)
  const created = await getProduct(db, input.organizationId, planned.id)
  await publishStayProducts(env, [created])
  return created
}

/**
 * The first `/services/<slug>` no page or redirect holds, by the same rule the
 * page writer enforces. A taken candidate is the reason to try the next one;
 * running out is a conflict the caller sees.
 */
async function availableServicePagePath(db: DbClient, organizationId: string, slug: string, options: { takenPaths?: ReadonlySet<string>; replacedPages?: ReadonlyMap<string, string> } = {}): Promise<string> {
  const { template } = await loadOrganizationTemplate(db, organizationId)
  const sourceLocale = await getSourceLocale(db, organizationId)
  for (let attempt = 0; attempt < MAX_SLUG_SUFFIX_ATTEMPTS; attempt += 1) {
    const path = `/services/${slugCandidate(slug, attempt)}`
    if (options.takenPaths?.has(path)) continue
    try {
      return await assertTenantPagePathAvailable(db, { organizationId, locale: sourceLocale, path, template, excludeVariantId: options.replacedPages?.get(path) })
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) throw error
    }
  }
  conflict('Could not find a free page path for this service')
}

async function prepareProductPageCreate(db: DbClient, input: {
  organizationId: string; product: PlannedProduct; actor: Actor; env?: CloudflareEnv; page?: ProductPageInput
  takenPaths?: Set<string>; replacedPages?: ReadonlyMap<string, string>
}) {
  const pageInput = productPageInput(input.product, input.env, input.page)
  if (!pageInput) return null
  const path = pageInput.data.path ?? (input.product.kind === 'service'
    ? await availableServicePagePath(db, input.organizationId, input.product.slug, input)
    : invalid('page.path is required for this kind of product'))
  const page = await prepareTenantPageCreate(db, {
    organizationId: input.organizationId, userId: input.actor.actorId,
    data: { ...pageInput.data, path, productId: input.product.id }, env: pageInput.env,
    productInSameBatch: true, pathOwnerDeletedInSameBatch: input.replacedPages?.get(path),
  })
  input.takenPaths?.add(page.path)
  return page
}

/**
 * Plan the writes that create these products, without running them.
 *
 * The only reason this is separate from `createProductsBatch` is callers that
 * must commit product creation together with other statements in one D1 batch
 * — onboarding commit replaces a site's whole catalogue and its content in a
 * single atomic batch. They get the same planning, validation and SQL as every
 * other create; there is no second product writer.
 */
export async function planProductCreateWrites(db: DbClient, input: {
  organizationId: string
  products: CreateProductInput[]
  actor: Actor
  now: string
  env?: CloudflareEnv
  replacedProductIds?: ReadonlySet<string>
  replacedPages?: ReadonlyMap<string, string>
  /**
   * Publish the new products on `organizationId` as part of the same batch.
   *
   * A caller that writes its own publication rows leaves this out. One that
   * wants the site to carry what it just created says so here, rather than
   * following the batch with one round trip per product.
   */
  publication?: { published: boolean }
}): Promise<{ ids: string[]; queries: BatchQuery[]; pages: Array<{ variantId: string; path: string }> }> {
  if (input.products.length === 0) invalid('at least one product is required')
  if (input.products.length > PRODUCT_LIMITS.batchCreate) invalid(`at most ${PRODUCT_LIMITS.batchCreate} products may be created at once`)
  // What is the same for every product in the batch is asked once: the
  // vocabulary, the currency, the organization's slugs, and who owns any id
  // the caller supplied. Asking per product turned a hundred-row create into a
  // hundred round trips before a single row was written.
  const [knownSlugs, idOwners] = await Promise.all([
    loadProductSlugs(db, input.organizationId),
    loadSuppliedIdOwners(db, {
      product_options: input.products.flatMap(product => (product.options ?? []).map(option => option.id).filter((id): id is string => Boolean(id))),
      product_option_values: input.products.flatMap(product => (product.options ?? []).flatMap(option => (option.values ?? []).map(value => typeof value === 'string' ? null : value.id)).filter((id): id is string => Boolean(id))),
      product_variants: input.products.flatMap(product => (product.variants ?? []).map(variant => variant.id).filter((id): id is string => Boolean(id))),
    }),
  ])
  for (const [slug, id] of knownSlugs) if (input.replacedProductIds?.has(id)) knownSlugs.delete(slug)
  const defaultCurrency = input.organizationId ? await organizationDefaultCurrency(db, input.organizationId) : null
  const queries: BatchQuery[] = []
  const ids: string[] = []
  const pages: Array<{ variantId: string; path: string }> = []
  const takenPaths = new Set<string>()
  // Slugs are derived sequentially and the set carries what this batch has
  // already claimed: deriving them in parallel would let two products in one
  // batch both take the same free slug.
  const taken = new Set<string>()
  for (const product of input.products) {
    const planned = await planProduct(db, input.organizationId, product, { organizationId: input.organizationId, defaultCurrency, takenSlugs: taken, knownSlugs, idOwners })
    assertVariantPricesConsistent(planned)
    if (input.publication?.published && planned.kind === 'experience' && !planned.order_url) invalid('Create experiences with booking details before publishing them')
    queries.push(...productWrites(input.organizationId, planned, input.actor, input.now, 'insert'))
    const page = await prepareProductPageCreate(db, { ...input, product: planned, takenPaths })
    if (page) {
      queries.push(...page.queries)
      pages.push({ variantId: page.variantId, path: page.path })
    }
    if (input.publication && input.organizationId) {
      queries.push({
        query: `INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [input.organizationId, planned.id, input.publication.published ? 1 : 0,
          input.now, input.now, input.actor.actorId, input.actor.actorId],
      })
    }
    ids.push(planned.id)
  }
  // One site, one invalidation: a hundred products landing together change
  // that site's public projection once.
  if (input.publication && input.organizationId) queries.push(publicResourceCacheInvalidationQuery(input.organizationId, 'products_created'))
  return { ids, queries, pages }
}

async function readProductBatch(db: DbClient, organizationId: string, ids: string[]): Promise<Product[]> {
  const rows = await queryAll<Row>(db, `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.organization_id=? AND p.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonArray(ids)])
  if (rows.length !== ids.length) throw new HTTPError({ statusCode: 410, statusMessage: 'A product from this completed catalog operation has been removed' })
  const products = await hydrate(db, organizationId, rows.map(mapProductRow))
  const byId = new Map(products.map(product => [product.id, product]))
  return ids.map(id => byId.get(id)!)
}

async function replayCatalogWrite(db: DbClient, organizationId: string, dedupeKey: string | null, requestHash: string | null): Promise<Product[] | null> {
  if (!dedupeKey) return null
  const record = await readCreationRecord(db, dedupeKey)
  if (!record) return null
  if (record.requestHash !== requestHash || record.entityId !== organizationId) conflict('This idempotency key belongs to a different catalog update')
  const ids = record.metadata.product_ids
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Catalog audit record has invalid product IDs')
  return readProductBatch(db, organizationId, ids as string[])
}

export async function createProductsBatch(db: DbClient, input: {
  organizationId: string; products: CreateProductInput[]; actor: Actor; env: CloudflareEnv; publication?: { published: boolean }; idempotencyKey?: string
}): Promise<Product[]> {
  const complete = async (products: Product[]): Promise<Product[]> => {
    for (const product of products) if (product.page) {
      await refreshTenantPageCard(db, input.env, { variantId: product.page.id, path: product.page.path }, input.actor.actorId)
    }
    await publishStayProducts(input.env, products)
    return products
  }
  const dedupeKey = input.idempotencyKey ? `catalog-create:${input.organizationId}:${input.idempotencyKey}` : null
  const requestHash = dedupeKey ? await creationRequestHash({ products: input.products, publication: input.publication ?? null }) : null
  const replay = await replayCatalogWrite(db, input.organizationId, dedupeKey, requestHash)
  if (replay) return complete(replay)
  const { ids, queries } = await planProductCreateWrites(db, { ...input, now: new Date().toISOString() })
  queries.push(organizationEventQuery({ organizationId: input.organizationId, actorId: input.actor.actorId, eventType: 'product.created', entityType: 'catalog', entityId: input.organizationId, ...(dedupeKey ? { dedupeKey } : {}), metadata: { request_hash: requestHash, product_ids: ids, product_count: ids.length } }))
  if (queries.length > MAX_D1_BATCH_STATEMENTS) invalid('This catalog exceeds one atomic write; submit smaller batches')
  try { await executeBatch(db, queries, { operation: 'Create products' }) } catch (error) {
    if (isUniqueDedupeConflict(error)) {
      const concurrent = await replayCatalogWrite(db, input.organizationId, dedupeKey, requestHash)
      if (concurrent) return complete(concurrent)
    }
    throw error
  }
  return complete(await readProductBatch(db, input.organizationId, ids))
}

/**
 * The writes one patch makes, given the product it is patching.
 *
 * Planning is separated from loading so a batch can load every product it is
 * about in one hydration and still go through exactly this validation. The
 * caller supplies what is the same for every row — the attribute vocabulary,
 * the site's currency, the organization's slugs — and gets back the statements
 * plus the variants this patch would remove, which a caller checks against
 * bookings before running anything.
 */
async function planProductUpdate(db: DbClient, input: {
  organizationId: string
  current: Product
  patch: UpdateProductInput
  actor: Actor
  now: string
  env?: CloudflareEnv
  booking?: ProductBookingSetupInput
  defaultCurrency?: CurrencyCode | null
  takenSlugs?: Set<string>
  idOwners?: SuppliedIdOwners
  knownSlugs?: ReadonlyMap<string, string>
  cacheInvalidations: BatchQuery[]
}): Promise<{ writes: BatchQuery[]; keptVariants: string; product: PlannedProduct }> {
  const { current, patch, organizationId } = input
  const productId = current.id
  const variantsMode = patchListMode(patch.variants_mode, patch.variants, 'variants')
  const suppliedVariants = patch.variants ?? []
  const suppliedIds = new Set<string>()
  for (const [index, variant] of suppliedVariants.entries()) {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) invalid(`variants[${index}] must be an object`)
    if (variant.id && suppliedIds.has(variant.id)) invalid(`variants[${index}].id is repeated`)
    if (variant.id) suppliedIds.add(variant.id)
  }
  const variants: ProductVariantInput[] = variantsMode === 'replace'
    ? []
    : current.variants.map(variant => ({ ...variantInput(variant), prices: variant.prices.map(priceInput) }))
  for (const [index, supplied] of suppliedVariants.entries()) {
    const mergedVariant = mergeVariantPatch(supplied, current.variants.find(variant => variant.id === supplied.id), `variants[${index}]`)
    const at = supplied.id ? variants.findIndex(variant => variant.id === supplied.id) : -1
    if (at < 0) variants.push(mergedVariant)
    else variants[at] = mergedVariant
  }
  const merged: CreateProductInput = {
    kind: patch.kind ?? current.kind,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    active: patch.active ?? current.active,
    order_url: patch.order_url === undefined ? current.order_url : patch.order_url,
    unit_label: patch.unit_label === undefined ? current.unit_label : patch.unit_label,
    marketing_features: patch.marketing_features ?? current.marketing_features,
    metadata: patch.metadata ?? current.metadata,
    tax_code: patch.tax_code === undefined ? current.tax_code : patch.tax_code,
    options: patch.options ?? current.options.map(option => ({
      id: option.id, name: option.name, sort_order: option.sort_order,
      values: option.values.map(value => ({ id: value.id, value: value.value, sort_order: value.sort_order })),
    })),
    variants,
    details: { featured: current.details.featured ?? false, ...(patch.details ?? current.details) },
    // The location a home is at is fixed: a patch naming another one is refused, never merged.
    stay: current.stay ? { ...current.stay, ...patch.stay, location_id: current.stay.location_id } : patch.stay as CreateProductInput['stay'],
  }
  const patchedLocation = (patch.stay as { location_id?: unknown } | undefined)?.location_id
  if (current.stay && patchedLocation !== undefined && patchedLocation !== current.stay.location_id) conflict('A place to stay keeps its location; create a new place to stay instead')
  if ((current.kind === 'stay') !== (merged.kind === 'stay')) invalid('A place to stay keeps its kind, and another kind cannot become one; create a new place to stay instead')
  const planned = await planProduct(db, organizationId, merged, {
    organizationId: input.organizationId, existingId: productId, defaultCurrency: input.defaultCurrency,
    takenSlugs: input.takenSlugs, idOwners: input.idOwners, knownSlugs: input.knownSlugs,
  })
  // A patch that does not rename keeps the slug it has: a public path is not
  // re-derived because something else about the product changed.
  planned.slug = patch.name === undefined ? current.slug : planned.slug
  planned.source = current.source
  assertVariantPricesConsistent(planned)

  if (current.publications.some(publication => publication.organization_id === organizationId && publication.published)) assertStayPublishable(planned)
  const guardPublication = !input.booking && planned.kind === 'experience' && !planned.order_url
  let readiness: Awaited<ReturnType<typeof productBookingReadiness>> | undefined
  if (guardPublication && current.publications.some(publication => publication.organization_id === organizationId && publication.published)) {
    readiness = await productBookingReadiness(db, organizationId, { ...current, ...planned }, { env: input.env, prepareAllocation: true })
    if (!readiness.ready) throw new HTTPError({ statusCode: 409, statusMessage: 'This offering needs booking and payment setup before it can be published', data: { code: 'EXPERIENCE_BOOKING_INCOMPLETE', product_id: current.id, missing: readiness.missing } })
  }

  const keptOptions = d1JsonArray(planned.options.map(option => option.id))
  const keptValues = d1JsonArray(planned.options.flatMap(option => option.values.map(value => value.id)))
  const keptVariants = d1JsonArray(planned.variants.map(variant => variant.id))

  // A patch that says nothing about variants says nothing about money. Its
  // prices keep their rows, their identity and their scopes; only a caller
  // that restated the variants is describing the offers.
  const writesPrices = patch.variants !== undefined
  const keptPrices = d1JsonArray(planned.variants.flatMap(variant => variant.prices.map(price => price.id)))
  const currentPriceIds = new Set(current.variants.flatMap(variant => variant.prices.map(price => price.id)))
  const suppliedPriceIds = new Set(suppliedVariants.flatMap(variant => (variant.prices ?? []).map(price => price.id).filter((id): id is string => Boolean(id))))
  const priceIds = new Set(planned.variants.flatMap(variant => variant.prices)
    .filter(price => !currentPriceIds.has(price.id) || suppliedPriceIds.has(price.id)).map(price => price.id))
  const variantIds = new Set(planned.variants.filter(variant => {
    const before = current.variants.find(candidate => candidate.id === variant.id)
    return !before || variant.name !== before.name || variant.sku !== before.sku || variant.active !== before.active || variant.sort_order !== before.sort_order
  }).map(variant => variant.id))
  const writes: BatchQuery[] = [
    // Selections and named details are rebuilt wholesale: nothing
    // references them, so replacing them is simpler and cannot drift.
    { query: 'DELETE FROM product_variant_option_values WHERE organization_id = ? AND product_id = ?', params: [organizationId, productId] },
    // Only explicit replacement removes prices; merged omissions remain in the plan.
    ...(writesPrices
      ? [{ query: 'DELETE FROM prices WHERE organization_id = ? AND product_variant_id IN (SELECT id FROM product_variants WHERE organization_id = ? AND product_id = ?) AND id NOT IN (SELECT value FROM json_each(?))', params: [organizationId, organizationId, productId, keptPrices] }]
      : []),
    // Options, values and variants are UPSERTED, never dropped and recreated:
    // bookings reference variant identity, and recreating a variant under a
    // fresh id is the same as deleting it as far as they are concerned. Only
    // rows the caller actually removed are deleted — and a booking RESTRICTS
    // that delete, so a booking taken after the check above raises here and
    // takes the whole rewrite down with it. Keeping the variant row while the
    // statements around it deleted its prices and selections would preserve an
    // id and nothing it meant.
    { query: 'DELETE FROM product_variants WHERE organization_id = ? AND product_id = ? AND id NOT IN (SELECT value FROM json_each(?))', params: [organizationId, productId, keptVariants] },
    { query: 'DELETE FROM product_option_values WHERE organization_id = ? AND product_id = ? AND id NOT IN (SELECT value FROM json_each(?))', params: [organizationId, productId, keptValues] },
    { query: 'DELETE FROM product_options WHERE organization_id = ? AND product_id = ? AND id NOT IN (SELECT value FROM json_each(?))', params: [organizationId, productId, keptOptions] },
    ...productWrites(organizationId, planned, input.actor, input.now, 'upsert', {
      writePrices: writesPrices, priceIds, writeOptions: patch.options !== undefined, variantIds, writeStay: patch.stay !== undefined,
      expectedUpdatedAt: planned.kind === 'experience' && !planned.order_url ? current.updated_at : undefined,
    }),
    ...(guardPublication ? [{
      query: `UPDATE products SET updated_at=CASE WHEN NOT EXISTS (SELECT 1 FROM product_publications WHERE organization_id=? AND product_id=? AND published=1) ${readiness?.allocation ? `OR (${readiness.allocation.query})` : ''} THEN updated_at ELSE NULL END WHERE organization_id=? AND id=?`,
      params: [organizationId, productId, ...(readiness?.allocation?.params ?? []), organizationId, productId],
    }] : []),
    ...input.cacheInvalidations,
  ]
  return { writes, keptVariants, product: planned }
}

const variantInput = (variant: ProductVariant) => ({
  id: variant.id, name: variant.name, sku: variant.sku, active: variant.active, sort_order: variant.sort_order, option_values: variant.option_values,
})
const priceInput = (price: Price): PriceInput => ({
  id: price.id, unit_amount: price.unit_amount, currency: price.currency, location_id: price.location_id, active: price.active,
  type: price.type, recurring_interval: price.recurring_interval, recurring_interval_count: price.recurring_interval_count,
  tax_behavior: price.tax_behavior, compare_at_unit_amount: price.compare_at_unit_amount,
  valid_from_at: price.valid_from_at, valid_until_at: price.valid_until_at, source: price.source,
})

/**
 * An edit names what changes. A variant restated with its id keeps every field
 * it does not restate; its prices merge by id, so a price restated with its id
 * keeps its row — payments and checkout holds reference price ids — and its
 * unstated fields, and a price left out is kept. A variant or price without an
 * id is new, and must say what it is.
 */
function mergeVariantPatch(supplied: ProductVariantPatchInput, current: ProductVariant | undefined, field: string): ProductVariantInput {
  const pricesMode = patchListMode(supplied.prices_mode, supplied.prices, `${field}.prices`)
  const suppliedPriceIds = new Set<string>()
  for (const [index, price] of (supplied.prices ?? []).entries()) {
    if (!price || typeof price !== 'object' || Array.isArray(price)) invalid(`${field}.prices[${index}] must be an object`)
    if (price.id && suppliedPriceIds.has(price.id)) invalid(`${field}.prices[${index}].id is repeated`)
    if (price.id) suppliedPriceIds.add(price.id)
  }
  if (!current) {
    if (supplied.id) invalid(`${field}.id ${supplied.id} does not belong to this product`)
    if (typeof supplied.name !== 'string') invalid(`${field}.name is required for a new variant`)
    for (const [index, price] of (supplied.prices ?? []).entries()) {
      if (price.id) invalid(`${field}.prices[${index}].id names a price this product does not have`)
      if (typeof price.unit_amount !== 'number') invalid(`${field}.prices[${index}].unit_amount is required for a new price`)
    }
    return supplied as ProductVariantInput
  }
  const base = variantInput(current)
  // Prices merge by id: a restated price is updated in place, a new one is
  // added, and a price left unstated is kept unless replacement was explicit.
  const prices = pricesMode === 'replace' ? [] : current.prices.map(priceInput)
  for (const [index, price] of (supplied.prices ?? []).entries()) {
    const existing = price.id ? current.prices.find(candidate => candidate.id === price.id) : undefined
    const at = price.id ? prices.findIndex(candidate => candidate.id === price.id) : -1
    if (price.id && !existing) invalid(`${field}.prices[${index}].id ${price.id} does not belong to variant ${current.id}`)
    if (!existing && typeof price.unit_amount !== 'number') invalid(`${field}.prices[${index}].unit_amount is required for a new price`)
    const merged = existing ? { ...priceInput(existing), ...definedFields(price) } : price as PriceInput
    if (at < 0) prices.push(merged)
    else prices[at] = merged
  }
  return { ...base, ...definedFields(supplied), prices }
}

function patchListMode(mode: unknown, values: unknown, field: string): 'merge' | 'replace' {
  if (mode !== undefined && mode !== 'merge' && mode !== 'replace') invalid(`${field}_mode must be merge or replace`)
  if (mode !== undefined && values === undefined) invalid(`${field} is required when ${field}_mode is supplied`)
  if (values !== undefined && !Array.isArray(values)) invalid(`${field} must be an array`)
  return mode === 'replace' ? 'replace' : 'merge'
}

/** The fields a patch actually states; `undefined` is absence, `null` is a value. */
function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

/**
 * The variants a patch would remove that anything has ever been booked on.
 *
 * One question for however many products are being edited: the message the
 * merchant reads. The delete statements carry the same rule themselves, so a
 * booking taken between this read and the write is kept either way.
 */
async function bookedRemovals(db: DbClient, organizationId: string, products: Array<{ productId: string; keptVariants: string }>): Promise<string[]> {
  if (products.length === 0) return []
  // One statement for however many products: each entry carries its own kept
  // list, so a hundred-product reconcile asks once rather than a hundred times.
  const payload = JSON.stringify(products.map(entry => ({ product_id: entry.productId, kept: entry.keptVariants })))
  const booked = await queryAll<{ name: string }>(db, `
    SELECT v.name FROM json_each(?) entry
    JOIN product_variants v ON v.product_id = entry.value ->> '$.product_id' AND v.organization_id = ?
    WHERE v.id NOT IN (SELECT value FROM json_each(entry.value ->> '$.kept'))
      AND EXISTS (SELECT 1 FROM bookings b WHERE b.product_variant_id = v.id)
  `, [payload, organizationId])
  return booked.map(row => row.name)
}

export async function updateProduct(db: DbClient, input: {
  organizationId: string
  productId: string
  patch: UpdateProductInput
  actor: Actor
  env: CloudflareEnv
  booking?: { data: ProductBookingSetupInput; env: CloudflareEnv }
  idempotencyKey?: string
  /** updateStayHome completes once after its optional location timezone write. */
  deferStayNightPush?: true
}): Promise<ProductMutation> {
  const env = input.env
  const reprice = input.patch.variants !== undefined || input.patch.stay?.min_nights !== undefined
  const complete = async (product: Product): Promise<ProductMutation> => {
    let channelPush: ChannelPush | null = null
    if (product.kind === 'stay' && reprice && !input.deferStayNightPush) {
      if (!env) throw new HTTPError({ statusCode: 503, message: 'The saved home requires its organization environment to update the channel', data: { code: 'ORGANIZATION_ENVIRONMENT_REQUIRED', field: 'env', committed: true, product_id: product.id, updated_at: product.updated_at } })
      const { pushStayHomeNights } = await import('~/server/domain/stays')
      channelPush = await pushStayHomeNights(db, env, { organizationId: input.organizationId, actorId: input.actor.actorId, manage: true }, product)
    }
    await publishStayProducts(env, [product])
    return { ...product, channel_push: channelPush }
  }
  const dedupeKey = input.idempotencyKey ? `product-update:${input.organizationId}:${input.productId}:${input.idempotencyKey}` : null
  const requestHash = dedupeKey ? await creationRequestHash({ patch: input.patch, booking: input.booking?.data ?? null }) : null
  const replay = async () => {
    if (!dedupeKey) return null
    const record = await readCreationRecord(db, dedupeKey)
    if (!record) return null
    if (record.requestHash !== requestHash || record.entityId !== input.productId) conflict('This idempotency key belongs to a different product update')
    return getProduct(db, input.organizationId, input.productId)
  }
  const earlier = await replay()
  if (earlier) return complete(earlier)
  if (input.booking && !dedupeKey) invalid('An idempotency key is required when configuring bookable sessions')
  const current = await getProduct(db, input.organizationId, input.productId)
  const now = new Date().toISOString()
  const { writes, keptVariants, product: planned } = await planProductUpdate(db, {
    organizationId: input.organizationId, current, patch: input.patch, actor: input.actor, now,
    env: input.env, booking: input.booking?.data,
    cacheInvalidations: await productCacheInvalidations(db, input.organizationId, input.productId, 'product_updated'),
  })
  if (current.kind === 'stay' && reprice) {
    if (!env) throw new HTTPError({ statusCode: 503, message: 'The home change requires the organization environment', data: { code: 'ORGANIZATION_ENVIRONMENT_REQUIRED', field: 'env', product_id: current.id } })
    await requireChannelPush(db, env, input.organizationId, current.id)
  }

  if (input.booking) {
    await assertBookableOffering(db, input.organizationId, planned, input.booking.data.location_id)
    const { prepareProductBookingSetup } = await import('~/server/utils/availability')
    writes.push(...await prepareProductBookingSetup(db, { organizationId: input.organizationId, productId: input.productId, actorId: input.actor.actorId, env: input.booking.env, now, booking: input.booking.data }))
    writes.push({ query: `INSERT INTO product_publications(organization_id,product_id,published,created_at,updated_at,created_by,updated_by) VALUES(?,?,1,?,?,?,?) ON CONFLICT(product_id,organization_id) DO UPDATE SET published=1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`, params: [input.organizationId, input.productId, now, now, input.actor.actorId, input.actor.actorId] })
  }
  if (dedupeKey) writes.push(organizationEventQuery({ organizationId: input.organizationId, actorId: input.actor.actorId, eventType: 'product.updated', entityType: 'product', entityId: input.productId, dedupeKey, metadata: { request_hash: requestHash } }))
  if (writes.length > MAX_D1_BATCH_STATEMENTS) invalid('This offering exceeds one atomic update')

  // A variant anything was ever booked on is not removed by an edit. Stopping
  // the sale of an option is `active`, not deletion.
  const booked = await bookedRemovals(db, input.organizationId, [{ productId: input.productId, keptVariants }])
  if (booked.length > 0) {
    conflict(`${booked.join(', ')} ${booked.length > 1 ? 'have' : 'has'} bookings, so ${booked.length > 1 ? 'they cannot be removed' : 'it cannot be removed'}. Turn ${booked.length > 1 ? 'them' : 'it'} off instead.`)
  }

  // A booking taken between the check above and this batch makes the variant
  // delete raise, and D1 rolls the whole batch back: the product is exactly as
  // it was, and the merchant is told why rather than reading a constraint name.
  await executeBatch(db, writes, { operation: 'Update product' }).catch(async (error: unknown) => {
    if (isUniqueDedupeConflict(error) && await replay()) return
    if (/NOT NULL constraint failed: products\.updated_at/.test(error instanceof Error ? error.message : String(error))) {
      if (await replay()) return
      throw new HTTPError({ statusCode: 409, statusMessage: 'The offering or its availability changed while you were editing. Nothing was changed; read its current state and retry.', data: { code: 'PRODUCT_UPDATE_CONFLICT', product_id: input.productId }, cause: error })
    }
    if (input.booking) {
      const { bookingConfigurationWriteError } = await import('~/server/utils/availability')
      const configurationError = bookingConfigurationWriteError(error)
      if (configurationError !== error) throw configurationError
    }
    const raced = await bookedRemovals(db, input.organizationId, [{ productId: input.productId, keptVariants }])
    if (raced.length === 0) throw error
    conflict(`${raced.join(', ')} was booked while you were editing, so nothing was changed. Turn it off instead of removing it.`)
  })
  return complete(await getProduct(db, input.organizationId, input.productId))
}

export async function deleteProduct(db: DbClient, input: {
  organizationId: string; productId: string; env: CloudflareEnv
}): Promise<void> {
  const product = await getProduct(db, input.organizationId, input.productId)
  const bound = await queryAll<{ id: string; updated_at: string }>(db, `
    SELECT id, updated_at FROM content_documents WHERE organization_id = ? AND product_id = ? AND kind='page' AND row_role='root'
  `, [input.organizationId, input.productId])
  // The same rule an edit follows: a product anything was ever booked on is
  // not deleted. Its variants and sessions cascade, and the bookings hanging
  // off both would go with them — silently for a booking with no thread, and
  // as a raw foreign-key error for one that has a thread holding it.
  const booked = await queryFirst<{ n: number }>(db, `
    SELECT (SELECT count(*) FROM bookings WHERE organization_id = ? AND product_id = ?) + (SELECT count(*) FROM stays WHERE organization_id = ? AND product_id = ?) AS n
  `, [input.organizationId, input.productId, input.organizationId, input.productId])
  if ((booked?.n ?? 0) > 0) {
    conflict('This product has bookings or stays. Cancel them, or turn the product off instead of deleting it.')
  }
  if (await queryFirst(db, "SELECT 1 FROM payment_checkout_holds WHERE organization_id=? AND product_id=? AND status='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1", [input.organizationId, input.productId])) {
    conflict('This product has an active checkout. Turn it off instead of deleting it.')
  }
  // A home's provider conversations and saved-reply schedules name it; deleting
  // it would orphan their history and schedules.
  if (await queryFirst(db, 'SELECT 1 FROM channel_threads WHERE organization_id = ? AND product_id = ? LIMIT 1', [input.organizationId, input.productId])) {
    conflict('This home has guest conversations from its channel. Turn it off instead of deleting it.')
  }
  if (await queryFirst(db, "SELECT 1 FROM message_templates t, json_each(t.schedule_json, '$.productIds') home WHERE t.organization_id = ? AND t.schedule_json IS NOT NULL AND home.value = ? LIMIT 1", [input.organizationId, input.productId])) {
    conflict('A saved reply schedules messages for this home. Remove the home from that schedule before deleting it.')
  }
  const pages = await Promise.all(bound.map(page => prepareTenantPageDelete(db, page.id, { scope: { organizationId: input.organizationId }, expectedUpdatedAt: page.updated_at })))
  const invalidations = await productCacheInvalidations(db, input.organizationId, input.productId, 'product_deleted')
  await executeBatch(db, [
    { query: `UPDATE products SET updated_at=NULL WHERE organization_id=? AND id=? AND (EXISTS(SELECT 1 FROM bookings WHERE organization_id=? AND product_id=?)
      OR EXISTS(SELECT 1 FROM stays WHERE organization_id=? AND product_id=?)
      OR EXISTS(SELECT 1 FROM channel_threads WHERE organization_id=? AND product_id=?)
      OR EXISTS(SELECT 1 FROM message_templates t, json_each(t.schedule_json, '$.productIds') home WHERE t.organization_id=? AND t.schedule_json IS NOT NULL AND home.value=?)
      OR EXISTS(SELECT 1 FROM payment_checkout_holds WHERE organization_id=? AND product_id=? AND status='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`, params: [input.organizationId, input.productId, input.organizationId, input.productId, input.organizationId, input.productId, input.organizationId, input.productId, input.organizationId, input.productId, input.organizationId, input.productId] },
    ...pages.flatMap(page => page.queries),
    ...resourceLocalizationDeletionQueries('product', { query: 'SELECT ?', params: [input.productId] }),
    ...invalidations,
    { query: 'DELETE FROM products WHERE organization_id = ? AND id = ?', params: [input.organizationId, input.productId] },
  ], { operation: 'Delete product' }).catch(error => {
    if (/NOT NULL constraint failed: products\.updated_at/.test(error instanceof Error ? error.message : String(error))) conflict('This product received a booking, stay, guest conversation, schedule or checkout while you were deleting it. Turn it off instead of deleting it.')
    throw error
  })
  await publishStayProducts(input.env, [product])
}

/**
 * Invalidate every site projection this product appears in.
 *
 * A product published on two sites has two projections; invalidating only the
 * site the editor happened to be looking at is how one of them goes stale
 * while looking correct.
 */
async function productCacheInvalidations(db: DbClient, organizationId: string, productId: string, reason: string): Promise<BatchQuery[]> {
  const organizations = await queryAll<{ organization_id: string }>(db, `
    SELECT organization_id FROM product_publications WHERE organization_id = ? AND product_id = ?
    UNION
    SELECT organization_id FROM content_documents WHERE organization_id = ? AND product_id = ?
  `, [organizationId, productId, organizationId, productId])
  return organizations.map(row => publicResourceCacheInvalidationQuery(row.organization_id, reason))
}

// ---------------------------------------------------------------------------
// Publication and location relationships
// ---------------------------------------------------------------------------

/**
 * Publish or withhold a product on one site.
 *
 * Three controls, none implying another: `products.active` is the merchant's
 * sale switch, this row is site visibility, and `product_locations.published`
 * is per-location visibility. A withheld product is not sold out and a
 * disabled product is not unpublished.
 */
export async function productBookingReadiness(db: DbClient, organizationId: string, product: Pick<Product, 'id' | 'active' | 'order_url' | 'booking' | 'locations'> & Pick<PlannedProduct, 'variants'>, options: { requireAllocation?: boolean; prepareAllocation?: boolean; requireActive?: boolean; locationId?: string; activeLocationIds?: ReadonlySet<string>; env?: CloudflareEnv; paymentSetup?: () => ReturnType<typeof readStripeCheckoutSetup>; /** The organization's currency and the product's scheduled sessions, when the caller already read them for a whole catalog. */ currency?: CurrencyCode; sessions?: SessionAvailability[] } = {}): Promise<{ ready: boolean; missing: string[]; allocation?: BatchQuery }> {
  const missing: string[] = []
  const requireActive = options.requireAllocation || options.requireActive
  const locations = product.locations.filter(location => (options.locationId === undefined || location.location_id === options.locationId) && (!options.activeLocationIds || options.activeLocationIds.has(location.location_id)))
  if (requireActive && !product.active) missing.push('active')
  if (product.order_url) return { ready: missing.length === 0, missing }
  if (!product.booking) missing.push('booking')
  else if (!product.booking.duration_minutes) missing.push('booking.duration_minutes')
  const currency = options.currency ?? await organizationDefaultCurrency(db, organizationId)
  const { listSessions, sessionAllocationPredicate } = await import('~/server/utils/availability')
  const sessions = (options.sessions ?? await listSessions(db, { organizationId, productId: product.id, fromInstant: new Date().toISOString(), toInstant: new Date(Date.now() + 400 * 86_400_000).toISOString() }))
    .filter(session => session.location_id === null
      ? options.locationId === undefined && Boolean(product.booking?.held_online)
      : locations.some(location => location.location_id === session.location_id && location.published && (!requireActive || location.active)))
  // Scheduled seats prove the booking capability even while full or closed.
  // Publication additionally guards a real allocation in its atomic write.
  const candidate = sessions.find(session => !session.is_full)
    ?? sessions.find(session => session.capacity === null || session.capacity > 0)
  const scopes = [...new Set([
    ...locations.filter(location => location.published && (!requireActive || location.active)).map(location => location.location_id),
    ...(options.locationId === undefined && product.booking?.held_online ? [null] : []),
  ])]
  const variants = product.variants.filter(variant => variant.active)
  const prices = currency ? scopes.flatMap(locationId => variants.map(variant => selectPrice(variant.prices, { currency, location_id: locationId }))) : []
  if (!currency || !variants.length || !scopes.length || prices.some(price => price?.type !== 'one_time')) missing.push('variants.prices')
  if (product.booking?.online_payment_required && prices.some(price => price && price.unit_amount > 0)) {
    let setup: Awaited<ReturnType<typeof readStripeCheckoutSetup>>
    if (options.paymentSetup) setup = await options.paymentSetup()
    else {
      if (!options.env) throw new Error('The organization environment is required to assess paid booking readiness')
      setup = await readStripeCheckoutSetup(db, organizationId, options.env)
    }
    missing.push(...setup.missing)
  }
  if (!options.requireAllocation && !options.prepareAllocation) {
    if (!candidate) missing.push('booking.schedule')
    return { ready: missing.length === 0, missing }
  }
  const allocation = candidate ? await sessionAllocationPredicate(db, { organizationId, productId: product.id, sessionId: candidate.id, partySize: 0, now: new Date().toISOString(), requireActive: Boolean(requireActive) }) : undefined
  if (allocation) {
    allocation.query = `(${allocation.query}) AND EXISTS (SELECT 1 FROM organization WHERE id=? AND default_currency=?)
      AND EXISTS (SELECT 1 FROM product_booking_configs WHERE organization_id=? AND product_id=? AND held_online=? AND online_payment_required=?)
      AND (SELECT COUNT(*) FROM product_locations WHERE organization_id=? AND product_id=?)=?
      AND NOT EXISTS (SELECT 1 FROM product_locations pl WHERE pl.organization_id=? AND pl.product_id=? AND NOT EXISTS (
        SELECT 1 FROM json_each(?) expected WHERE json_extract(expected.value,'$.location_id')=pl.location_id AND json_extract(expected.value,'$.active')=pl.active AND json_extract(expected.value,'$.published')=pl.published))`
    allocation.params = [...allocation.params!, organizationId, currency, organizationId, product.id, product.booking?.held_online ? 1 : 0, product.booking?.online_payment_required ? 1 : 0,
      organizationId, product.id, product.locations.length, organizationId, product.id, JSON.stringify(product.locations)]
  }
  // A location's prospective flags are written before this predicate in the
  // guarded batch. Ordinary publication still evaluates the current flags.
  if (!allocation || (!options.prepareAllocation && !(await queryFirst<{ ready: number }>(db, `SELECT (${allocation.query}) AS ready`, allocation.params))?.ready)) missing.push('booking.schedule')
  return { ready: missing.length === 0, missing, allocation }
}

export async function setProductPublication(db: DbClient, input: {
  organizationId: string; productId: string; published: boolean; actor: Actor; env?: CloudflareEnv
}): Promise<void> {
  const product = await requireOrganizationProduct(db, input)
  if (input.published) assertStayPublishable(product)
  let readiness: Awaited<ReturnType<typeof productBookingReadiness>> | undefined
  let alreadyPublished = false
  if (input.published && (product.kind === 'experience' || product.booking)) {
    alreadyPublished = product.publications.some(publication => publication.organization_id === input.organizationId && publication.published)
    readiness = await productBookingReadiness(db, input.organizationId, product, { requireAllocation: !alreadyPublished, env: input.env })
    if (!readiness.ready) throw new HTTPError({ statusCode: 409, statusMessage: 'This offering needs booking and payment setup before it can be published', data: { code: 'EXPERIENCE_BOOKING_INCOMPLETE', product_id: product.id, missing: readiness.missing } })
  }
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
            VALUES (?, ?, CASE WHEN EXISTS(SELECT 1 FROM products p WHERE p.organization_id=? AND p.id=? AND p.updated_at=?) ${readiness?.allocation ? `AND (${readiness.allocation.query})` : ''} ${alreadyPublished ? 'AND EXISTS(SELECT 1 FROM product_publications WHERE organization_id=? AND product_id=? AND published=1)' : ''} THEN ? ELSE NULL END, ?, ?, ?, ?)
            ON CONFLICT (product_id, organization_id) DO UPDATE SET published = excluded.published, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    params: [input.organizationId, input.productId, input.organizationId, input.productId, product.updated_at, ...(readiness?.allocation?.params ?? []), ...(alreadyPublished ? [input.organizationId, input.productId] : []), input.published ? 1 : 0, now, now, input.actor.actorId, input.actor.actorId],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'product_publication_changed')], { operation: 'Set product publication' }).catch(error => {
    if (/NOT NULL constraint failed: product_publications\.published/.test(error instanceof Error ? error.message : String(error))) throw new HTTPError({statusCode:409,statusMessage:'The offering or its availability changed before publication. Review it and retry.',cause:error})
    throw error
  })
}

export async function removeProductPublication(db: DbClient, input: {
  organizationId: string; productId: string
}): Promise<void> {
  await executeBatch(db, [
    { query: 'DELETE FROM product_publications WHERE organization_id = ? AND product_id = ?', params: [input.organizationId, input.productId] },
    publicResourceCacheInvalidationQuery(input.organizationId, 'product_publication_changed'),
  ], { operation: 'Remove product publication' })
}

export async function setProductLocation(db: DbClient, input: {
  organizationId: string; productId: string; locationId: string; active?: boolean; published?: boolean; actor: Actor; env?: CloudflareEnv
}): Promise<void> {
  const organization = await queryFirst<{ organization_id: string }>(db, 'SELECT organization_id FROM business_locations WHERE organization_id = ? AND id = ?', [input.organizationId, input.locationId])
  if (!organization) notFound('Location not found')
  const product = await requireOrganizationProduct(db, input)
  if (product.stay && product.stay.location_id !== input.locationId) conflict('A place to stay is at exactly one location')
  const currentLocation = product.locations.find(location => location.location_id === input.locationId)
  const expectedProductUpdatedAt = product.updated_at
  const location = { location_id: input.locationId, active: input.active ?? currentLocation?.active ?? true, published: input.published ?? currentLocation?.published ?? true }
  let readiness: Awaited<ReturnType<typeof productBookingReadiness>> | undefined
  if (location.published && (product.kind === 'experience' || product.booking)) {
    const newPublication = !currentLocation?.published
    const prospective = { ...product, locations: [...product.locations.filter(existing => existing.location_id !== input.locationId), location] }
    readiness = await productBookingReadiness(db, input.organizationId, prospective, { locationId: input.locationId, prepareAllocation: newPublication, requireActive: newPublication, env: input.env })
    if (!readiness.ready) throw new HTTPError({ statusCode: 409, statusMessage: 'This offering needs booking and payment setup at this location before it can be published', data: { code: 'EXPERIENCE_BOOKING_INCOMPLETE', product_id: product.id, location_id: input.locationId, missing: readiness.missing } })
  }
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by)
            VALUES (?, ?, ?, COALESCE(?, 1), COALESCE(?, 1), ?, ?, ?, ?)
            ON CONFLICT (product_id, location_id) DO UPDATE SET active = COALESCE(?, product_locations.active), published = COALESCE(?, product_locations.published),
              updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    params: [input.organizationId, input.productId, input.locationId, input.active === undefined ? null : Number(input.active), input.published === undefined ? null : Number(input.published),
      now, now, input.actor.actorId, input.actor.actorId, input.active === undefined ? null : Number(input.active), input.published === undefined ? null : Number(input.published)],
  }, {
    query: `UPDATE product_locations SET published=CASE WHEN EXISTS (SELECT 1 FROM products WHERE organization_id=? AND id=? AND updated_at=?) ${readiness?.allocation ? `AND (${readiness.allocation.query})` : ''} THEN published ELSE NULL END
      WHERE organization_id=? AND product_id=? AND location_id=?`,
    params: [input.organizationId, input.productId, expectedProductUpdatedAt, ...(readiness?.allocation?.params ?? []), input.organizationId, input.productId, input.locationId],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'product_location_changed')], { operation: 'Set product location' }).catch(error => {
    if (/NOT NULL constraint failed: product_locations\.published/.test(error instanceof Error ? error.message : String(error))) throw new HTTPError({ statusCode: 409, statusMessage: 'The offering or its availability changed before location publication. Review it and retry.', data: { code: 'PRODUCT_LOCATION_PUBLICATION_CONFLICT', product_id: input.productId, location_id: input.locationId }, cause: error })
    throw error
  })
}

export async function removeProductLocation(db: DbClient, input: {
  organizationId: string; productId: string; locationId: string
}): Promise<void> {
  const organization = await queryFirst<{ organization_id: string }>(db, 'SELECT organization_id FROM business_locations WHERE organization_id = ? AND id = ?', [input.organizationId, input.locationId])
  if (!organization) notFound('Location not found')
  const home = await queryFirst<{ product_id: string }>(db, 'SELECT product_id FROM product_stay_configs WHERE organization_id = ? AND product_id = ? AND location_id = ?', [input.organizationId, input.productId, input.locationId])
  if (home) conflict('A place to stay cannot leave the location it is at; delete the place to stay instead')
  await executeBatch(db, [
    { query: 'DELETE FROM product_locations WHERE organization_id = ? AND product_id = ? AND location_id = ?', params: [input.organizationId, input.productId, input.locationId] },
    publicResourceCacheInvalidationQuery(input.organizationId, 'product_location_changed'),
  ], { operation: 'Remove product location' })
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** Sections as the API returns them, each with its own picture read in one query. */
async function mapCollectionRows(db: DbClient, organizationId: string, rows: Row[]): Promise<Collection[]> {
  const images = await readMediaPlacements(db, { organizationId, ownerType: 'collection', ownerIds: rows.map(row => String(row.id)), slot: 'image' })
  return rows.map(row => ({
    id: String(row.id), organization_id: String(row.organization_id),
    location_id: row.location_id === null ? null : String(row.location_id),
    name: String(row.name), slug: String(row.slug),
    description: row.description === null ? null : String(row.description),
    image: images.get(String(row.id))?.[0] ?? null,
    sort_order: Number(row.sort_order),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
    created_by: String(row.created_by), updated_by: String(row.updated_by),
  }))
}

export async function listCollections(db: DbClient, input: {
  organizationId: string; locationId?: string | null; assignedUserId?: string
}): Promise<Collection[]> {
  const rows = await queryAll<Row>(db, `
    SELECT * FROM collections
    WHERE organization_id = ? 
      AND (? = 0 OR location_id IS ?)
      ${input.assignedUserId ? `AND EXISTS (SELECT 1 FROM collection_products cp JOIN products p ON p.id = cp.product_id AND p.organization_id = cp.organization_id
        WHERE cp.collection_id = collections.id AND cp.organization_id = collections.organization_id AND (${ASSIGNED_SERVICE_SQL}))` : ''}
    ORDER BY sort_order, name, id
  `, [input.organizationId, input.locationId === undefined ? 0 : 1, input.locationId ?? null, ...(input.assignedUserId ? [input.assignedUserId, input.assignedUserId] : [])])
  return mapCollectionRows(db, input.organizationId, rows)
}

export async function createCollection(db: DbClient, input: {
  organizationId: string; collection: CreateCollectionInput; actor: Actor
}): Promise<Collection> {
  const name = requireTrimmedProductString(input.collection.name, 'name', PRODUCT_LIMITS.collectionName)
  const slug = await uniqueCollectionSlug(db, input.organizationId, input.collection.location_id ?? null, name)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `INSERT INTO collections (id, organization_id, location_id, name, slug, description, sort_order, created_at, updated_at, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [id, input.organizationId, input.collection.location_id ?? null, name, slug,
      normalizeOptionalProductString(input.collection.description, 'description', PRODUCT_LIMITS.collectionDescription),
      input.collection.sort_order ?? 0, now, now, input.actor.actorId, input.actor.actorId],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'collection_created')], { operation: 'Create collection' })
  const row = await queryFirst<Row>(db, 'SELECT * FROM collections WHERE organization_id = ? AND id = ?', [input.organizationId, id])
  return (await mapCollectionRows(db, input.organizationId, [row!]))[0]!
}

async function uniqueCollectionSlug(db: DbClient, organizationId: string, locationId: string | null, base: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_SLUG_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = slugCandidate(base, attempt)
    const clash = await queryFirst<{ id: string }>(db, `
      SELECT id FROM collections WHERE organization_id = ?  AND location_id IS ? AND slug = ?
    `, [organizationId, locationId, candidate])
    if (!clash) return candidate
  }
  conflict('Could not derive a unique collection slug')
}

export async function updateCollection(db: DbClient, input: {
  organizationId: string; collectionId: string; patch: UpdateCollectionInput; actor: Actor
}): Promise<Collection> {
  const existing = await queryFirst<Row>(db, 'SELECT * FROM collections WHERE organization_id = ? AND id = ?', [input.organizationId, input.collectionId])
  if (!existing) notFound('Collection not found')
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `UPDATE collections SET name = ?, description = ?, sort_order = ?, updated_at = ?, updated_by = ?
            WHERE organization_id = ? AND id = ?`,
    params: [
      input.patch.name === undefined ? String(existing.name) : requireTrimmedProductString(input.patch.name, 'name', PRODUCT_LIMITS.collectionName),
      input.patch.description === undefined ? existing.description : normalizeOptionalProductString(input.patch.description, 'description', PRODUCT_LIMITS.collectionDescription),
      input.patch.sort_order ?? Number(existing.sort_order), now, input.actor.actorId,
      input.organizationId, input.collectionId,
    ],
  }, publicResourceCacheInvalidationQuery(String(existing.organization_id), 'collection_updated')], { operation: 'Update collection' })
  const row = await queryFirst<Row>(db, 'SELECT * FROM collections WHERE organization_id = ? AND id = ?', [input.organizationId, input.collectionId])
  return (await mapCollectionRows(db, input.organizationId, [row!]))[0]!
}

export async function deleteCollection(db: DbClient, input: { organizationId: string; collectionId: string }): Promise<void> {
  const existing = await queryFirst<{ organization_id: string }>(db, 'SELECT organization_id FROM collections WHERE organization_id = ? AND id = ?', [input.organizationId, input.collectionId])
  if (!existing) notFound('Collection not found')
  // Membership cascades; the products themselves are untouched. Deleting a
  // grouping is not deleting what was grouped. Its own picture goes with it.
  await executeBatch(db, [
    buildDeleteOwnerPlacementsQuery({ ownerType: 'collection', ownerId: input.collectionId, organizationId: input.organizationId }),
    { query: 'DELETE FROM collections WHERE organization_id = ? AND id = ?', params: [input.organizationId, input.collectionId] },
    publicResourceCacheInvalidationQuery(existing.organization_id, 'collection_deleted'),
  ], { operation: 'Delete collection' })
}

/**
 * Set a collection's complete membership and order.
 *
 * The caller supplies the whole intended list; a partial list is a different
 * operation and is rejected upstream. Position lives on the membership row, so
 * the same product can sit third here and first somewhere else without being
 * copied.
 */
export async function setCollectionProducts(db: DbClient, input: {
  organizationId: string; collectionId: string; productIds: string[]; actor: Actor
}): Promise<void> {
  if (input.productIds.length > PRODUCT_LIMITS.collectionProducts) {
    invalid(`a collection may hold at most ${PRODUCT_LIMITS.collectionProducts} products`)
  }
  if (new Set(input.productIds).size !== input.productIds.length) invalid('product_ids must be unique')
  const collection = await queryFirst<{ organization_id: string }>(db, 'SELECT organization_id FROM collections WHERE organization_id = ? AND id = ?', [input.organizationId, input.collectionId])
  if (!collection) notFound('Collection not found')
  const products = await queryAll<{ id: string }>(db, 'SELECT id FROM products WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [input.organizationId, JSON.stringify(input.productIds)])
  const existing = new Set(products.map(product => product.id))
  const missing = input.productIds.filter(id => !existing.has(id))
  if (missing.length) throw new HTTPError({ statusCode: 400, message: 'Collection contains products outside this organization or missing products', data: { missing_product_ids: missing } })
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: 'DELETE FROM collection_products WHERE organization_id = ? AND collection_id = ?', params: [input.organizationId, input.collectionId] },
    ...input.productIds.map((productId, index): BatchQuery => ({
      query: `INSERT INTO collection_products (organization_id, collection_id, product_id, sort_order, created_at, updated_at, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.organizationId, input.collectionId, productId, index, now, now, input.actor.actorId, input.actor.actorId],
    })),
    publicResourceCacheInvalidationQuery(collection.organization_id, 'collection_membership_changed'),
  ], { operation: 'Set collection products' })
}

export async function reorderCollections(db: DbClient, input: {
  organizationId: string; locationId?: string | null; collectionIds: string[]; actor: Actor
}): Promise<void> {
  const existing = await listCollections(db, { organizationId: input.organizationId, locationId: input.locationId })
  const intended = new Set(input.collectionIds)
  // A partial order would leave the unnamed collections at whatever position
  // they had, which is not an order anyone chose.
  if (intended.size !== existing.length || existing.some(collection => !intended.has(collection.id))) {
    invalid('collection_ids must list every collection in this scope exactly once')
  }
  const now = new Date().toISOString()
  await executeBatch(db, [
    ...input.collectionIds.map((collectionId, index): BatchQuery => ({
      query: 'UPDATE collections SET sort_order = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?',
      params: [index, now, input.actor.actorId, input.organizationId, collectionId],
    })),
    publicResourceCacheInvalidationQuery(input.organizationId, 'collection_reordered'),
  ], { operation: 'Reorder collections' })
}

/**
 * Idempotent upsert keyed by the caller's own product id.
 *
 * Used by imports and MCP, where the same source runs twice and must converge
 * rather than duplicate. A row with a `product_id` that already exists is
 * replaced with the intended state; one without is created. Products the
 * caller did not mention are left alone unless `deactivateMissing` is set, in
 * which case they are DEACTIVATED — the merchant's sale switch — never
 * deleted, and never marked sold out, which is a stock statement this
 * operation has no basis to make.
 */
/** The products a reconcile names, loaded and hydrated in one pass. */
async function listProductsByIds(db: DbClient, organizationId: string, ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return []
  const rows = await queryAll<Row>(db, `
    SELECT ${PRODUCT_COLUMNS} FROM products p
     WHERE p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))
  `, [organizationId, d1JsonArray(ids)])
  return hydrate(db, organizationId, rows.map(mapProductRow))
}

async function planProductReconciliation(db: DbClient, input: {
  organizationId: string
  products: Array<ReconcileProductInput | (MenuSectionInput['items'][number] & { kind: 'dish' })>
  actor: Actor
  env?: CloudflareEnv
  deactivateMissing?: boolean
}): Promise<{ touched: string[]; perProduct: BatchQuery[][]; now: string; products: PlannedProduct[] }> {
  if (!Array.isArray(input.products)) invalid('products must be an array')
  if (input.products.length > PRODUCT_LIMITS.reconcile) invalid(`products may contain at most ${PRODUCT_LIMITS.reconcile} rows`)
  input.products.forEach((product, index) => {
    if (Object.hasOwn(product, 'product_id') && (typeof product.product_id !== 'string' || product.product_id.trim() === '')) {
      invalid(`products[${index}].product_id must be a non-empty string when provided`)
    }
  })

  // What is the same for every row in one reconcile is asked once: the
  // tenant's attribute vocabulary, the site's currency, the organization's
  // slugs, who owns every id the request supplied, and the products the
  // request names. A hundred rows used to mean a hundred of each — the
  // reconcile spent its time on round trips, not on work.
  const requestedIds = input.products.map(entry => entry.product_id).filter((id): id is string => Boolean(id))
  const [knownSlugs, existingProducts] = await Promise.all([
    loadProductSlugs(db, input.organizationId),
    listProductsByIds(db, input.organizationId, requestedIds),
  ])
  const defaultCurrency = input.organizationId ? await organizationDefaultCurrency(db, input.organizationId) : null
  const idOwners = await loadSuppliedIdOwners(db, {
    product_options: input.products.flatMap(entry => (entry.options ?? []).map(option => option.id).filter((id): id is string => Boolean(id))),
    product_option_values: input.products.flatMap(entry => (entry.options ?? []).flatMap(option => (option.values ?? []).map(value => typeof value === 'string' ? null : value.id)).filter((id): id is string => Boolean(id))),
    product_variants: input.products.flatMap(entry => (entry.variants ?? []).map(variant => variant.id).filter((id): id is string => Boolean(id))),
  })
  const byId = new Map(existingProducts.map(product => [product.id, product]))

  const taken = new Set<string>()
  const now = new Date().toISOString()
  const touched: string[] = []
  // Kept per product, not flattened: rewriting a product deletes its prices and
  // selections before restating them, so a batch boundary in the middle of one
  // leaves that product half-rewritten. Whole products are what a batch is
  // filled with.
  const perProduct: BatchQuery[][] = []
  const plannedProducts: PlannedProduct[] = []
  const removals: Array<{ productId: string; keptVariants: string }> = []

  for (const entry of input.products) {
    const { product_id: productId, ...rest } = entry
    const current = productId ? byId.get(productId) : undefined
    if (current) {
      const planned = await planProductUpdate(db, {
        organizationId: input.organizationId, current, patch: rest, actor: input.actor, now,
        env: input.env,
        defaultCurrency, takenSlugs: taken, idOwners, knownSlugs,
        // One invalidation per site at the end of the batch, not one per product.
        cacheInvalidations: [],
      })
      plannedProducts.push(planned.product)
      perProduct.push(planned.writes)
      removals.push({ productId: current.id, keptVariants: planned.keptVariants })
      touched.push(current.id)
      continue
    }
    const planned = await planProduct(db, input.organizationId, rest as CreateProductInput, {
      organizationId: input.organizationId, existingId: productId, defaultCurrency, takenSlugs: taken, idOwners, knownSlugs,
    })
    assertVariantPricesConsistent(planned)
    plannedProducts.push(planned)
    const creates = productWrites(input.organizationId, planned, input.actor, now, 'insert')
    // The site that reconciles its catalog carries what the reconcile creates,
    // withheld until someone publishes it — the same rule batch creation
    // follows, and what makes "missing from this site's import" answerable.
    if (input.organizationId) {
      creates.push({
        query: `INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
                VALUES (?, ?, 0, ?, ?, ?, ?)
                ON CONFLICT (product_id, organization_id) DO NOTHING`,
        params: [input.organizationId, planned.id, now, now, input.actor.actorId, input.actor.actorId],
      })
    }
    perProduct.push(creates)
    touched.push(planned.id)
  }

  // Nothing is written while a booking points at a variant the reconcile would
  // remove: the caller is told, and its whole reconcile is refused.
  const booked = await bookedRemovals(db, input.organizationId, removals)
  if (booked.length > 0) {
    conflict(`${booked.join(', ')} ${booked.length > 1 ? 'have' : 'has'} bookings, so ${booked.length > 1 ? 'they cannot be removed' : 'it cannot be removed'}. Turn ${booked.length > 1 ? 'them' : 'it'} off instead.`)
  }

  // A product whose rewrite alone exceeds what one batch can carry is refused
  // before anything runs: there is no way to apply it atomically, and applying
  // it in pieces is what leaves a product half-written.
  const oversized = perProduct.findIndex(product => product.length > MAX_D1_BATCH_STATEMENTS)
  if (oversized >= 0) {
    invalid(`products[${oversized}] needs ${perProduct[oversized]!.length} statements to rewrite, more than the ${MAX_D1_BATCH_STATEMENTS} one transaction can carry`)
  }
  // One tenant, so one projection to invalidate: this used to ask which sites
  // carried the named products, a question with only one possible answer now.
  perProduct.push([publicResourceCacheInvalidationQuery(input.organizationId, 'products_reconciled')])

  return { touched, perProduct, now, products: plannedProducts }
}

export async function reconcileProducts(db: DbClient, input: {
  organizationId: string; products: ReconcileProductInput[]; actor: Actor; env: CloudflareEnv; deactivateMissing?: boolean; idempotencyKey?: string
}): Promise<ProductMutation[]> {
  if (!Array.isArray(input.products)) throw new HTTPError({ statusCode: 400, message: 'products must be an array', data: { code: 'INVALID_PRODUCT_FIELD', field: 'products' } })
  input.products.forEach((product, index) => {
    if (typeof product !== 'object' || product === null || Array.isArray(product)) throw new HTTPError({ statusCode: 400, message: `products[${index}] must be an object`, data: { code: 'INVALID_PRODUCT_FIELD', field: `products[${index}]` } })
  })
  const reprice = new Set(input.products.flatMap(product => product.product_id && (product.variants !== undefined || product.stay?.min_nights !== undefined) ? [product.product_id] : []))
  const complete = async (products: Product[]): Promise<ProductMutation[]> => {
    const results: ProductMutation[] = []
    for (const product of products) {
      let channelPush: ChannelPush | null = null
      if (product.kind === 'stay' && reprice.has(product.id)) {
        if (!input.env) throw new HTTPError({ statusCode: 503, message: 'The saved home requires its organization environment to update the channel', data: { code: 'ORGANIZATION_ENVIRONMENT_REQUIRED', field: 'env', committed: true, product_id: product.id, updated_at: product.updated_at } })
        const { pushStayHomeNights } = await import('~/server/domain/stays')
        channelPush = await pushStayHomeNights(db, input.env, { organizationId: input.organizationId, actorId: input.actor.actorId, manage: true }, product)
      }
      results.push({ ...product, channel_push: channelPush })
    }
    await publishStayProducts(input.env, products)
    return results
  }
  const dedupeKey = input.idempotencyKey ? `catalog-reconcile:${input.organizationId}:${input.idempotencyKey}` : null
  const requestHash = dedupeKey ? await creationRequestHash({ products: input.products, deactivateMissing: input.deactivateMissing ?? false }) : null
  const replay = await replayCatalogWrite(db, input.organizationId, dedupeKey, requestHash)
  if (replay) return complete(replay)
  const products = input.products.map(product => ({
    ...product,
    ...(product.variants === undefined ? {} : {
      variants_mode: 'replace' as const,
      variants: product.variants.map(variant => ({ ...variant, ...(variant.prices === undefined ? {} : { prices_mode: 'replace' as const }) })),
    }),
  }))
  const { touched, perProduct, now, products: planned } = await planProductReconciliation(db, { ...input, products })
  for (const product of planned) {
    if (product.kind !== 'stay' || !reprice.has(product.id)) continue
    if (!input.env) throw new HTTPError({ statusCode: 503, message: 'The home change requires the organization environment', data: { code: 'ORGANIZATION_ENVIRONMENT_REQUIRED', field: 'env', product_id: product.id } })
    await requireChannelPush(db, input.env, input.organizationId, product.id)
  }
  const missing = input.deactivateMissing ? await queryAll<{ id: string }>(db, `SELECT id FROM products WHERE organization_id=? AND active=1 AND id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM product_publications pub WHERE pub.product_id=products.id AND pub.organization_id=?)`, [input.organizationId, d1JsonArray(touched), input.organizationId]) : []
  const answered = [...touched, ...missing.map(product => product.id)]
  const writes = perProduct.flat()
  if (missing.length) writes.push({ query: 'UPDATE products SET active=0,updated_at=?,updated_by=? WHERE organization_id=? AND id IN (SELECT value FROM json_each(?))', params: [now, input.actor.actorId, input.organizationId, d1JsonArray(missing.map(product => product.id))] })
  writes.push(organizationEventQuery({ organizationId: input.organizationId, actorId: input.actor.actorId, eventType: 'product.updated', entityType: 'catalog', entityId: input.organizationId, ...(dedupeKey ? { dedupeKey } : {}), metadata: { request_hash: requestHash, product_ids: answered } }))
  if (writes.length > MAX_D1_BATCH_STATEMENTS) invalid('This catalog exceeds one atomic write; submit smaller batches')
  try { await executeBatch(db, writes, { operation: 'Reconcile products' }) } catch (error) {
    const stale = /NOT NULL constraint failed: products\.updated_at/.test(error instanceof Error ? error.message : String(error))
    if (stale || isUniqueDedupeConflict(error)) {
      const concurrent = await replayCatalogWrite(db, input.organizationId, dedupeKey, requestHash)
      if (concurrent) return complete(concurrent)
    }
    if (stale) throw new HTTPError({ statusCode: 409, statusMessage: 'The catalog or its availability changed while you were editing. Nothing was changed; read its current state and retry.', data: { code: 'PRODUCT_UPDATE_CONFLICT' }, cause: error })
    throw error
  }
  return complete(await readProductBatch(db, input.organizationId, answered))
}


export interface MenuSectionInput {
  collection_id?: string
  name: string
  items: Array<Omit<UpdateProductInput, 'kind' | 'variants' | 'variants_mode'> & {
    product_id?: string
    name: string
    variants?: Array<Omit<ProductVariantPatchInput, 'prices_mode'>>
  }>
}

/** Complete the public menu without exposing publication or block setup to its owner. */
export async function updateMenu(db: DbClient, input: {
  organizationId: string; locationId: string; sections: MenuSectionInput[]; idempotencyKey: string; actor: Actor
}): Promise<{ sections: Array<{ collection: Collection; products: Product[] }>; replayed: boolean }> {
  const { organizationId, locationId, actor } = input
  const location = await queryFirst<{ id: string }>(db, "SELECT id FROM business_locations WHERE id = ? AND organization_id = ? AND status = 'active'", [locationId, organizationId])
  if (!location) notFound('Active location not found')
  if (!input.sections.length || input.sections.length > 30 || input.sections.reduce((count, section) => count + section.items.length, 0) > PRODUCT_LIMITS.reconcile) invalid(`A menu update requires 1–30 sections and at most ${PRODUCT_LIMITS.reconcile} items`)
  const names = input.sections.map(section => section.name.trim().toLocaleLowerCase())
  if (names.some(name => !name) || new Set(names).size !== names.length) invalid('Section names must be non-empty and unique')
  const dedupeKey = `menu:${organizationId}:${input.idempotencyKey}`
  const requestHash = await creationRequestHash({ locationId, sections: input.sections })
  const replay = await readCreationRecord(db, dedupeKey)
  if (replay && replay.requestHash !== requestHash) conflict('This idempotency key belongs to a different menu update')
  const read = async (replayed: boolean) => {
    const collections = await listCollections(db, { organizationId, locationId })
    const sections = await Promise.all(collections.map(async collection => ({ collection, products: await listCollectionProducts(db, { organizationId, collectionId: collection.id }) })))
    return { sections, replayed }
  }
  if (replay) return read(true)
  const [collections, existing] = await Promise.all([listCollections(db, { organizationId, locationId }), listLocationProducts(db, { organizationId, locationId })])
  const sections = await Promise.all(input.sections.map(async (section, index) => {
    const collection = section.collection_id ? collections.find(row => row.id === section.collection_id) : collections.find(row => row.name.trim().toLocaleLowerCase() === names[index])
    if (section.collection_id && !collection) notFound('Menu section not found at this location')
    const id = collection?.id ?? `menu-section-${(await creationRequestHash([dedupeKey, index])).slice(0, 32)}`
    const items = await Promise.all(section.items.map(async (item, at) => {
      const matches = item.product_id ? existing.filter(row => row.id === item.product_id) : existing.filter(row => row.kind === 'dish' && row.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase())
      if (matches.length > 1) invalid(`More than one menu item is named ${item.name}; supply product_id`)
      if (item.product_id && !matches.length) notFound(`Menu item ${item.product_id} not found at this location`)
      if (matches[0] && matches[0].kind !== 'dish') invalid('A menu section can contain only dishes')
      return { ...item, kind: 'dish' as const, active: item.active ?? matches[0]?.active ?? true, product_id: matches[0]?.id ?? `menu-item-${(await creationRequestHash([dedupeKey, index, at])).slice(0, 32)}` }
    }))
    return { id, collection, name: section.name.trim(), items }
  }))
  const products = sections.flatMap(section => section.items)
  const ids = products.map(product => product.product_id)
  if (new Set(ids).size !== ids.length) invalid('Each menu item must occur in exactly one supplied section')
  const { perProduct, now, products: plannedProducts } = await planProductReconciliation(db, { organizationId, products, actor })
  const currency = await organizationDefaultCurrency(db, organizationId)
  const unpriced = plannedProducts.filter(product => !currency || !product.variants.some(variant => variant.active && selectPrice(variant.prices, { currency, location_id: locationId })) && !product.details[PRICING_NOTE_HANDLE])
  if (unpriced.length) throw new HTTPError({ statusCode: 400, statusMessage: 'These menu items need their prices before the menu can be published', data: { missing_prices: unpriced.map(product => ({ product_id: product.id, name: product.name })) } })
  const writes: BatchQuery[] = perProduct.flat()
  for (const section of sections) {
    const slug = section.collection?.slug ?? await uniqueCollectionSlug(db, organizationId, locationId, section.name)
    writes.push({ query: `INSERT INTO collections(id, organization_id, location_id, name, slug, description, sort_order, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, NULL, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections WHERE organization_id=? AND location_id IS ?), ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,updated_by=excluded.updated_by`, params: [section.id, organizationId, locationId, section.name, slug, organizationId, locationId, now, now, actor.actorId, actor.actorId] })
    writes.push({ query: `DELETE FROM collection_products WHERE organization_id=? AND product_id IN (SELECT value FROM json_each(?))
      AND collection_id IN (SELECT id FROM collections WHERE organization_id=? AND location_id=? AND id<>?)`,
    params: [organizationId, d1JsonArray(section.items.map(item => item.product_id)), organizationId, locationId, section.id] })
    section.items.forEach(item => writes.push({ query: `INSERT INTO collection_products(organization_id,collection_id,product_id,sort_order,created_at,updated_at,created_by,updated_by)
      VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collection_products WHERE organization_id=? AND collection_id=?),?,?,?,?)
      ON CONFLICT(collection_id,product_id) DO NOTHING`, params: [organizationId, section.id, item.product_id, organizationId, section.id, now, now, actor.actorId, actor.actorId] }))
  }
  writes.push({ query: `INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_at,updated_at,created_by,updated_by)
    SELECT ?,value,?,1,1,?,?,?,? FROM json_each(?) WHERE true ON CONFLICT(product_id,location_id) DO UPDATE SET active=1,published=1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`, params: [organizationId, locationId, now, now, actor.actorId, actor.actorId, d1JsonArray(ids)] },
    { query: `UPDATE product_publications SET published=1,updated_at=?,updated_by=? WHERE organization_id=? AND product_id IN (SELECT value FROM json_each(?))`, params: [now, actor.actorId, organizationId, d1JsonArray(ids)] },
    organizationEventQuery({ organizationId, locationId, actorId: actor.actorId, eventType: 'product.updated', entityType: 'menu', entityId: locationId, dedupeKey, metadata: { request_hash: requestHash, product_count: ids.length, section_count: sections.length } }))
  if (writes.length > MAX_D1_BATCH_STATEMENTS) invalid('This menu exceeds one atomic update; submit its sections in separate updates')
  try { await executeBatch(db, writes, { operation: 'Update public menu' }) } catch (error) {
    if (!isUniqueDedupeConflict(error)) throw error
    const completed = await readCreationRecord(db, dedupeKey)
    if (completed?.requestHash !== requestHash) throw error
    return read(true)
  }
  return read(false)
}
