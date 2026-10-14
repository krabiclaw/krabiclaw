import type { McpToolDefinition } from './shared'
import { HTTPError } from 'nitro'
import { pageInfoObject, paginationInputSchema, resolvedMediaAssetObject, organizationTool } from './shared'
import { TENANT_PAGE_BLOCKS_SCHEMA, TENANT_PAGE_METADATA_SCHEMA } from './content'
import { productEditorPath } from '~/server/utils/dashboard-links'
import { queryFirst } from '~/server/db'
import { PRODUCT_LIMITS } from '~/server/utils/product-validation'
import { SUPPORTED_CURRENCIES } from '~/shared/currencies'
import { PRODUCT_KINDS, productDetailsSchema } from '~/shared/product-details'
import { selectPrice, PRICE_RECURRING_INTERVALS, PRICE_TAX_BEHAVIORS, PRICE_TYPES, type PriceBilling } from '~/shared/prices'
import { setProductBookingConfig, deleteProductBookingConfig, replaceWeeklySchedule, type ProductBookingSetupInput } from '~/server/utils/availability'
import type { CreateProductInput, Product, ReconcileProductInput, UpdateProductInput } from '~/server/types/products'
import {
  createCollection,
  createProduct,
  createProductsBatch,
  deleteCollection,
  deleteProduct,
  getProduct,
  requireOrganizationProduct,
  hydrateProductMedia,
  listCollectionProducts,
  listCollections,
  listLocationProducts,
  listOrganizationProducts,
  reconcileProducts,
  removeProductLocation,
  reorderCollections,
  setCollectionProducts,
  setProductLocation,
  setProductPublication,
  updateCollection,
  updateProduct,
  updateMenu,
  productBookingReadiness,
  PUBLIC_PRODUCT_SQL,
  type MenuSectionInput,
  type ProductListResult,
} from '~/server/utils/product-management'
import { assertResourceAccess, assertProductAccess, roleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import { MCP_ERROR, mcpProtocolError } from '~/server/utils/mcp-protocol'
import { listOrganizationsForUser } from '~/server/utils/mcp-workflows'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, objectArray, omit, requiredString, requiredStringArray } from './execution'

/**
 * The catalog tool surface.
 *
 * These schemas are generated from the same registries the runtime validates
 * against, so a tool cannot advertise a value the writer rejects. Every
 * contract here speaks the canonical model: a product belongs to the
 * organization, a variant is what gets bought, a price belongs to a variant,
 * and where it is sold and shown are explicit relationships.
 */

const priceObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    location_id: { type: ['string', 'null'], description: 'The location this offer applies at, or null for a location-neutral offer. Null is a declared scope, not a missing value.' },
    active: { type: 'boolean' },
    currency: { type: 'string' },
    unit_amount: { type: 'integer', description: 'Integer amount in the currency smallest unit.' },
    type: { type: 'string', enum: [...PRICE_TYPES] },
    recurring_interval: { type: ['string', 'null'], enum: [...PRICE_RECURRING_INTERVALS, null] },
    recurring_interval_count: { type: ['integer', 'null'] },
    tax_behavior: { type: 'string', enum: [...PRICE_TAX_BEHAVIORS] },
    compare_at_unit_amount: { type: ['integer', 'null'] },
    valid_from_at: { type: ['string', 'null'] },
    valid_until_at: { type: ['string', 'null'] },
  },
  required: ['id', 'location_id', 'active', 'currency', 'unit_amount', 'type', 'tax_behavior'],
} as const

const priceWrite = {
  type: 'object',
  description: 'A monetary offer on this variant. unit_amount is an integer in the currency smallest unit; 0 is an explicit free offer, and a variant with no price is not purchasable rather than free. Billing recurrence describes when the customer is charged, never when a class runs.',
  properties: {
    id: { type: 'string', description: 'The id of a price this variant already has. Restating it keeps the price row, which payments and checkout holds reference; a price without an id is a new offer.' },
    unit_amount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', enum: [...SUPPORTED_CURRENCIES] },
    location_id: { type: ['string', 'null'], description: 'Scope this offer to one location, or null for every location the product is offered at.' },
    active: { type: 'boolean' },
    type: { type: 'string', enum: [...PRICE_TYPES] },
    recurring_interval: { type: ['string', 'null'], enum: [...PRICE_RECURRING_INTERVALS, null] },
    recurring_interval_count: { type: ['integer', 'null'], minimum: 1 },
    tax_behavior: { type: 'string', enum: [...PRICE_TAX_BEHAVIORS] },
    compare_at_unit_amount: { type: ['integer', 'null'], minimum: 0 },
    valid_from_at: { type: ['string', 'null'], format: 'date-time' },
    valid_until_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['unit_amount'],
  additionalProperties: false,
} as const

const optionValueWrite = {
  type: 'object',
  properties: { id: { type: 'string' }, value: { type: 'string' }, sort_order: { type: 'integer' } },
  required: ['value'],
  additionalProperties: false,
} as const

const optionWrite = {
  type: 'object',
  description: 'A customer choice such as Size, with values such as Small and Large. Variants combine these choices and carry prices. Descriptive facts belong in details.',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, sort_order: { type: 'integer' },
    values: { type: 'array', minItems: 1, maxItems: PRODUCT_LIMITS.optionValues, items: optionValueWrite },
  },
  required: ['name', 'values'],
  additionalProperties: false,
} as const

const variantWrite = {
  type: 'object',
  description: 'One buyable configuration. A product with no options still has exactly one. Keep the id when editing: a variant that keeps its id keeps its bookings.',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, sku: { type: ['string', 'null'] },
    active: { type: 'boolean' }, sort_order: { type: 'integer' },
    option_values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Option id to option value id. Every option must be answered exactly once, and no two variants may answer identically.' },
    prices: { type: 'array', maxItems: 20, items: priceWrite },
  },
  required: ['name'],
  additionalProperties: false,
} as const

const variantObject = {
  type: 'object',
  properties: {
    id: { type: 'string' }, product_id: { type: 'string' }, name: { type: 'string' },
    sku: { type: ['string', 'null'] }, active: { type: 'boolean' }, sort_order: { type: 'integer' },
    option_values: { type: 'object', additionalProperties: { type: 'string' } },
    prices: { type: 'array', items: priceObject },
  },
  required: ['id', 'product_id', 'name', 'sku', 'active', 'sort_order', 'option_values', 'prices'],
} as const

const optionObject = {
  type: 'object',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, sort_order: { type: 'integer' },
    values: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' }, sort_order: { type: 'integer' } }, required: ['id', 'value', 'sort_order'] } },
  },
  required: ['id', 'name', 'sort_order', 'values'],
} as const

const publicationObject = {
  type: 'object',
  properties: { organization_id: { type: 'string' }, published: { type: 'boolean' } },
  required: ['organization_id', 'published'],
} as const

const productLocationObject = {
  type: 'object',
  properties: { location_id: { type: 'string' }, active: { type: 'boolean' }, published: { type: 'boolean' } },
  required: ['location_id', 'active', 'published'],
} as const

const collectionMembershipObject = {
  type: 'object',
  properties: { collection_id: { type: 'string' }, sort_order: { type: 'integer' } },
  required: ['collection_id', 'sort_order'],
} as const

const collectionObject = {
  type: 'object',
  properties: {
    id: { type: 'string' }, organization_id: { type: 'string' }, location_id: { type: ['string', 'null'] },
    name: { type: 'string' }, slug: { type: 'string' }, description: { type: ['string', 'null'] },
    sort_order: { type: 'integer' },
  },
  required: ['id', 'organization_id', 'location_id', 'name', 'slug', 'description', 'sort_order'],
} as const

const bookingPolicyFields = {
  scheduling_mode: { type: 'string', enum: ['legacy', 'provider'] },
  assigned_member_id: { type: ['string', 'null'], description: 'One organization member for provider scheduling. Clear assigned_team_id when choosing a member.' },
  assigned_team_id: { type: ['string', 'null'], description: 'Better Auth team whose available members can host bookings. Clear assigned_member_id when choosing a team.' },
  confirmation_mode: { type: 'string', enum: ['instant', 'review'], default: 'instant', description: 'instant confirms immediately (default); review waits for staff approval.' },
  online_payment_required: { type: 'boolean', default: false, description: 'True requires online payment when booking; false is the default and does not collect online.' },
  held_online: { type: 'boolean', description: 'True holds the offering online: its times are its provider\'s working hours, in the provider\'s timezone. Requires scheduling_mode provider with an assigned member or team.' },
} as const
// Setup states online-ness through location_id null, never a second flag beside it.
const { held_online: _heldOnline, ...onlineSetupPolicyFields } = bookingPolicyFields
const bookingConfigObject = {
  type: ['object', 'null'],
  properties: { product_id: { type: 'string' }, organization_id: { type: 'string' }, duration_minutes: { type: ['integer', 'null'], minimum: 1 }, default_capacity: { type: ['integer', 'null'], minimum: 0 }, ...bookingPolicyFields },
  required: ['duration_minutes', 'default_capacity', 'confirmation_mode', 'online_payment_required', 'held_online'],
} as const

const weeklySlot = { type: 'object', properties: { weekday: { type: 'integer', minimum: 0, maximum: 6 }, start_time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Local HH:mm start time; visit duration is configured separately.' } }, required: ['weekday', 'start_time'], additionalProperties: false }
const bookingSetup = {
  type: 'object',
  description: 'Complete booking setup for a published offering. At a location, provide weekly_slots or dated sessions; an update can retain its saved weekly times. location_id null holds it online: it needs scheduling_mode provider with an assigned member or team, takes no weekly_slots or sessions, and is booked in that provider\'s working hours. Runtime validation requires actual future availability before publication.',
  properties: { ...onlineSetupPolicyFields, location_id: { type: ['string', 'null'] }, duration_minutes: { type: 'integer', minimum: 1, description: 'Minutes each visit occupies its booking slot or seats, independent of the interval between start times.' }, default_capacity: { type: ['integer', 'null'], minimum: 1, description: 'Places per session; null means unlimited.' },
    weekly_slots: { type: 'array', minItems: 1, maxItems: 100, items: weeklySlot },
    sessions: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, capacity: { type: ['integer', 'null'], minimum: 1 } }, required: ['starts_at', 'ends_at'], additionalProperties: false } },
  },
  required: ['location_id', 'duration_minutes', 'default_capacity'],
  additionalProperties: false,
}

const detailObject = productDetailsSchema()

const productObject = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...PRODUCT_KINDS] }, id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' },
    active: { type: 'boolean', description: 'The merchant sale switch. Not visibility and not stock: a disabled product is not sold out.' },
    order_url: { type: ['string', 'null'] }, unit_label: { type: ['string', 'null'] },
    marketing_features: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object', additionalProperties: { type: 'string' } },
    booking: bookingConfigObject,
    booking_readiness: { type: ['object', 'null'], properties: { ready: { type: 'boolean' }, missing: { type: 'array', items: { type: 'string' } } }, required: ['ready', 'missing'] },
    public_url: { type: ['string', 'null'] },
    page: { type: ['object', 'null'], description: "The source page this product owns, or null. Edit its content with the site-page tools; its binding is the page's product_id.", properties: { id: { type: 'string' }, path: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'path', 'title'] },
    admin_edit_url: { type: ['string', 'null'], description: 'The dashboard editor for this product, on the platform host.' },
    tax_code: { type: ['string', 'null'] },
    options: { type: 'array', items: optionObject },
    variants: { type: 'array', items: variantObject },
    details: detailObject,
    publications: { type: 'array', items: publicationObject },
    locations: { type: 'array', items: productLocationObject },
    collections: { type: 'array', items: collectionMembershipObject },
    image: { ...resolvedMediaAssetObject, type: ['object', 'null'] },
    gallery: { type: 'array', items: resolvedMediaAssetObject },
    source: { type: 'string', enum: ['manual', 'template', 'ai', 'import', 'copy'] },
    created_at: { type: 'string' }, updated_at: { type: 'string' },
  },
  required: ['id', 'kind', 'name', 'slug', 'description', 'active', 'options', 'variants', 'details', 'publications', 'locations', 'collections', 'source', 'created_at', 'updated_at'],
} as const

const productListItemObject = {
  type: 'object',
  properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: [...PRODUCT_KINDS] }, name: { type: 'string' }, slug: { type: 'string' },
    active: { type: 'boolean' }, featured: { type: 'boolean' }, variant_count: { type: 'integer' },
    collections: { type: 'array', items: collectionMembershipObject },
    publications: { type: 'array', items: publicationObject },
    locations: { type: 'array', items: productLocationObject },
    prices: { type: 'array', items: { type: 'object', properties: {
      variant_id: { type: 'string' }, location_id: { type: ['string', 'null'] },
      currency: { type: 'string', enum: SUPPORTED_CURRENCIES }, unit_amount: { type: 'integer', minimum: 0 },
      type: { type: 'string', enum: [...PRICE_TYPES] },
      recurring_interval: { type: 'string', enum: [...PRICE_RECURRING_INTERVALS] }, recurring_interval_count: { type: 'integer', minimum: 1 },
    }, required: ['variant_id', 'location_id', 'currency', 'unit_amount', 'type'] } },
    pricing_note: { type: 'string' },
  },
  required: ['id', 'kind', 'name', 'slug', 'active', 'featured', 'variant_count', 'collections', 'publications', 'locations', 'prices'],
} as const

const productListResultObject = {
  type: 'object',
  properties: {
    scope: { type: 'object', properties: {
      view: { const: 'catalog' }, organization_id: { type: 'string' }, location_id: { type: 'string' },
      kind: { type: 'string', enum: [...PRODUCT_KINDS, 'all'] }, featured: { type: 'boolean' }, published_only: { type: 'boolean' },
    }, required: ['view', 'organization_id', 'kind', 'published_only'], additionalProperties: false },
    counts: { type: 'object', properties: {
      total: { type: 'integer', minimum: 0 },
      by_kind: { type: 'object', properties: Object.fromEntries(PRODUCT_KINDS.map(kind => [kind, { type: 'integer', minimum: 0 }])), required: [...PRODUCT_KINDS], additionalProperties: false },
    }, required: ['total', 'by_kind'], additionalProperties: false },
    page_info: pageInfoObject,
    products: { type: 'array', items: productListItemObject },
  },
  required: ['scope', 'counts', 'products', 'page_info'],
  additionalProperties: false,
} as const



const productWrite = {
  kind: { type: 'string', enum: [...PRODUCT_KINDS], description: 'The customer-facing kind: dish, experience, service or item. Determines the allowed descriptive fields; booking and stock remain separate capabilities.' },
  name: { type: 'string' },
  description: { type: 'string' },
  active: { type: 'boolean', description: 'Enable or disable sale of this product. Independent of site and location publication.' },
  order_url: { type: ['string', 'null'], description: 'External ordering or booking destination, such as Uber Eats, an experience checkout, or Clio Grow. When set, public actions use this URL instead of native booking. Null restores the configured native flow.' },
  unit_label: { type: ['string', 'null'], description: 'A unit noun such as "person" or "night". Never pricing prose.' },
  marketing_features: { type: 'array', maxItems: PRODUCT_LIMITS.marketingFeatures, items: { type: 'string' }, description: 'Generic selling bullets. Inclusions, preparation instructions and policies are separate details.' },
  metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Opaque string annotations for integrations. No pricing, scheduling, stock or filtering behavior may read these.' },
  tax_code: { type: ['string', 'null'] },
  options: { type: 'array', maxItems: PRODUCT_LIMITS.options, items: optionWrite },
  variants: { type: 'array', minItems: 1, maxItems: PRODUCT_LIMITS.variants, items: variantWrite, description: 'Omit to create a single default variant. Required once the product has options.' },
  details: { ...detailObject, description: 'Named customer-facing facts for the product kind. This is a complete replacement map; preserve fields to retain. pricing_note contains explicitly stated price wording and requires empty numeric prices.' },
} as const

const productResult = { type: 'object', properties: { product: productObject }, required: ['product'] } as const

// An edit names what changes. A variant or price restated with its id keeps
// every field it does not restate, so a price change is the id and the amount.
const pricePatch = { ...priceWrite, required: [] } as const
const variantPatch = {
  ...variantWrite,
  description: 'A partial update to an existing variant by id, or a new variant. Existing variants retain omitted fields and option selections. New variants require a name and complete option selections.',
  properties: {
    ...variantWrite.properties,
    prices: { ...variantWrite.properties.prices, items: pricePatch, description: 'Partial existing prices by id or new offers. Omitted prices remain unless prices_mode is replace. A new offer requires unit_amount.' },
    prices_mode: { type: 'string', enum: ['merge', 'replace'], default: 'merge', description: 'merge keeps prices omitted from the supplied list. replace explicitly removes omitted prices; an empty list clears them. Applies only with prices.' },
  },
  required: [],
} as const
const productPatch = {
  ...productWrite,
  variants: { ...productWrite.variants, items: variantPatch, description: 'Partial existing variants by id or new variants. Omitted variants and their prices/options remain unless variants_mode is replace. Existing variant and price IDs retain their identities.' },
  variants_mode: { type: 'string', enum: ['merge', 'replace'], default: 'merge', description: 'merge preserves variants omitted from the supplied list. replace explicitly removes omitted variants and their owned records; removal is refused once a variant has booking history. Applies only with variants.' },
  options: { ...productWrite.options, description: 'Complete option list when supplied; omitted options are removed. Omit to preserve existing options and selections.' },
} as const

export const PRODUCTS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'update_menu', domain: 'products', minimumRole: 'admin', description: 'Update and publish supplied menu dishes, prices and sections at the selected location. Omitted items, variants, prices and order remain; new items and sections append in supplied order.',
    inputSchema: { location_id: { type: 'string' }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 }, sections: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: { collection_id: { type: 'string' }, name: { type: 'string', minLength: 1 }, items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { ...productWrite, variants: { ...productWrite.variants, description: 'Partial existing variants by id or new variants. Omitted variants and prices remain; use update_product for intentional removal.', items: { ...variantPatch, properties: { ...variantWrite.properties, prices: { ...variantWrite.properties.prices, items: pricePatch, description: 'Partial existing prices by id or new offers. Omitted prices remain. A new offer requires unit_amount.' } } } }, product_id: { type: 'string' }, kind: { const: 'dish' } }, required: ['name'], additionalProperties: false } } }, required: ['name', 'items'], additionalProperties: false } } }, required: ['location_id', 'idempotency_key', 'sections'],
    outputSchema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'object', properties: { collection: collectionObject, products: { type: 'array', items: productObject } }, required: ['collection', 'products'] } }, replayed: { type: 'boolean' }, public_url: { type: ['string', 'null'] } }, required: ['sections', 'replayed', 'public_url'] },
  }),
  organizationTool({ name: 'set_product_booking_config', description: 'Configure booking duration, capacity and scheduling. New settings default to instant confirmation and no online collection. Omitted fields retain saved settings; existing sessions keep their times and capacity. Read settings with get_product.', domain: 'products', minimumRole: 'member', inputSchema: { product_id: { type: 'string' }, duration_minutes: { type: ['integer', 'null'], minimum: 1, description: 'Minutes each visit occupies its booking slot or seats, independent of the interval between start times. Null clears an existing duration.' }, default_capacity: { type: ['integer', 'null'], minimum: 0, description: 'Places per session; null means unlimited, zero closes seats.' }, ...bookingPolicyFields }, required: ['product_id'], outputSchema: { type: 'object', properties: { config: bookingConfigObject }, required: ['config'] } }),
  organizationTool({ name: 'delete_product_booking_config', description: 'Delete the selected product’s booking configuration to disable its session booking. Returns deleted status. Refused if any booking history exists, including cancelled bookings; the catalog product itself remains.', domain: 'products', minimumRole: 'admin', inputSchema: { product_id: { type: 'string' } }, required: ['product_id'], outputSchema: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] } }),
  organizationTool({ name: 'replace_product_weekly_schedule', description: 'Replace a product’s weekly time slots at one location when the user wants to change its recurring schedule. Times are in that location’s timezone and use the product duration/capacity. An online offering has no weekly slots: it is booked in its provider’s working hours (set_member_scheduling). An empty slots array clears that schedule. Sessions with any booking history are preserved; removed future sessions without bookings are cancelled, and re-added unbooked slots can reopen with current defaults.', domain: 'products', minimumRole: 'member', inputSchema: { product_id: { type: 'string' }, location_id: { type: 'string', description: 'A saved location ID.' }, slots: { type: 'array', items: { type: 'object', properties: { weekday: { type: 'integer', minimum: 0, maximum: 6 }, start_time: { type: 'string', description: 'Local HH:mm time.' } }, required: ['weekday', 'start_time'], additionalProperties: false } } }, required: ['product_id', 'location_id', 'slots'], outputSchema: { type: 'object', properties: { rules: { type: 'array', items: { type: 'object' } }, sessions: { type: 'object', properties: { created: { type: 'integer' }, existing: { type: 'integer' }, skipped: { type: 'array', items: { type: 'object' } } }, required: ['created', 'existing', 'skipped'] }, cancelled: { type: 'integer' } }, required: ['rules', 'sessions', 'cancelled'] } }),
  organizationTool({ name: 'list_products', description: "List products carried by the selected site, published or withheld. Results include products across the site; list_location_products narrows to one location.", domain: 'products', minimumRole: 'member', inputSchema: { kind: { type: 'string', enum: [...PRODUCT_KINDS] }, featured: { type: 'boolean' }, published_only: { type: 'boolean' }, ...paginationInputSchema }, required: [], outputSchema: productListResultObject }),
  organizationTool({ name: 'list_location_products', description: 'List product identities offered at one selected location. Results are paginated; published_only narrows to published offerings. Use list_products for the whole site.', domain: 'products', minimumRole: 'admin', inputSchema: { location_id: { type: 'string' }, kind: { type: 'string', enum: [...PRODUCT_KINDS] }, featured: { type: 'boolean' }, published_only: { type: 'boolean' }, ...paginationInputSchema }, required: ['location_id'], outputSchema: productListResultObject }),
  organizationTool({ name: 'get_product', description: "Read one site product before reviewing or editing its options, variants, prices, media, publication, locations, collections, named product facts or booking defaults. Prices belong to variants; booking defaults apply to new sessions.", domain: 'products', minimumRole: 'member', inputSchema: { product_id: { type: 'string' } }, required: ['product_id'], outputSchema: productResult }),
  organizationTool({ name: 'create_product', description: 'Add a catalog item, experience or service. Experiences need booking duration, capacity, location and actual times, or an external booking URL. Supplying booking creates its configuration, offering, schedule and public page together, using instant confirmation and no online collection by default. Repeat the same idempotency key on retry.' , domain: 'products', minimumRole: 'admin', inputSchema: { ...productWrite, booking: bookingSetup, page: { type: 'object', description: 'A source page created with this product and bound to it, in the same write. Omit for a product without a page of its own.', properties: { ...TENANT_PAGE_METADATA_SCHEMA, path: { type: 'string', description: "The page's public path. A service may omit it to get the first free /services/<slug>." }, blocks: TENANT_PAGE_BLOCKS_SCHEMA }, required: ['title', 'blocks'], additionalProperties: false }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'Repeat the same key with the same request to get the product it created instead of a second one.' } }, required: ['name', 'kind', 'idempotency_key'], outputSchema: productResult }),
  organizationTool({ name: 'update_product', description: 'Edit a product and return its updated record. For a price change, supply the variant ID, price ID and unit_amount. Variants and prices merge by ID; omitted entries stay. Supplied options and text details replace their current values. Booking setup also creates sessions and publishes the offering.', domain: 'products', minimumRole: 'member', inputSchema: { product_id: { type: 'string' }, ...productPatch, booking: bookingSetup, idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'Required with booking setup. Repeat the same key with the same request for an identical retry.' } }, required: ['product_id'], outputSchema: productResult }),
  organizationTool({ name: 'delete_product', description: 'Delete a product and its public page. Booking history prevents deletion; pause bookings or withhold publication to retain it.', domain: 'products', minimumRole: 'admin', inputSchema: { product_id: { type: 'string' } }, required: ['product_id'], outputSchema: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] } }),
  organizationTool({ name: 'set_product_publication', description: "Publish or withhold a product when the user wants to change its visibility on the selected site. This setting is independent of whether the product is available for sale and of visibility at individual locations.", domain: 'products', minimumRole: 'admin', inputSchema: { product_id: { type: 'string' }, published: { type: 'boolean' } }, required: ['product_id', 'published'], outputSchema: productResult }),
  organizationTool({ name: 'set_product_location', description: "Set whether the selected location offers a product and whether it appears on that location’s website surfaces. Existing product prices do not establish a location offering.", domain: 'products', minimumRole: 'admin', inputSchema: { product_id: { type: 'string' }, location_id: { type: 'string' }, active: { type: 'boolean' }, published: { type: 'boolean' } }, required: ['product_id', 'location_id'], outputSchema: productResult }),
  organizationTool({ name: 'remove_product_location', description: 'Remove the selected product’s offering at one explicit location and return the updated product. This removes that location relationship; the catalog product, prices and other location offerings remain.', domain: 'products', minimumRole: 'admin', inputSchema: { product_id: { type: 'string' }, location_id: { type: 'string' } }, required: ['product_id', 'location_id'], outputSchema: productResult }),
  organizationTool({ name: 'batch_create_products', description: "Create several products in the selected site’s catalog when the user supplies a new catalog batch. Validates every entry before writing; any invalid entry rejects the complete request. Publication and location offerings are assigned separately.", domain: 'products', minimumRole: 'admin', inputSchema: { idempotency_key: { type: 'string', minLength: 1, maxLength: 200 }, products: { type: 'array', minItems: 1, maxItems: PRODUCT_LIMITS.batchCreate, items: { type: 'object', properties: productWrite, required: ['name', 'kind'], additionalProperties: false } } }, required: ['products', 'idempotency_key'], outputSchema: { type: 'object', properties: { products: { type: 'array', items: productObject } }, required: ['products'] } }),
  organizationTool({ name: 'reconcile_products', description: 'Synchronize complete catalog entries in one atomic write. Existing product IDs preserve identity; supplied variants, prices and options replace their lists. Omitted products stay unchanged unless deactivate_missing disables them. Repeat the same idempotency key for an identical retry. Use update_menu for a restaurant menu and update_product for a partial edit.', domain: 'products', minimumRole: 'admin', inputSchema: { idempotency_key: { type: 'string', minLength: 1, maxLength: 200 }, products: { type: 'array', maxItems: PRODUCT_LIMITS.reconcile, items: { type: 'object', properties: { product_id: { type: 'string', minLength: 1 }, ...productWrite }, required: ['name', 'kind'], additionalProperties: false } }, deactivate_missing: { type: 'boolean' } }, required: ['products', 'idempotency_key'], outputSchema: { type: 'object', properties: { products: { type: 'array', items: productObject } }, required: ['products'] } }),

  organizationTool({ name: 'list_collections', description: "List the selected site’s product collections when the user wants to find menu sections or other product groups. Returns their public display order. Supply location_id to narrow the list to one location.", domain: 'products', minimumRole: 'admin', inputSchema: { location_id: { type: ['string', 'null'] } }, required: [], outputSchema: { type: 'object', properties: { collections: { type: 'array', items: collectionObject } }, required: ['collections'] } }),
  organizationTool({ name: 'create_collection', description: 'Create an empty product collection, such as a menu section, site-wide or at the named location. Returns the saved collection and its ID. Add products separately with set_collection_products; existing products and collections stay unchanged.', domain: 'products', minimumRole: 'admin', inputSchema: { name: { type: 'string' }, description: { type: ['string', 'null'] }, location_id: { type: ['string', 'null'], description: 'Narrow this collection to one location, or omit for site-wide.' }, sort_order: { type: 'integer' } }, required: ['name'], outputSchema: { type: 'object', properties: { collection: collectionObject }, required: ['collection'] } }),
  organizationTool({ name: 'update_collection', description: 'Change the selected product collection’s name, description or display position and return the saved collection. Only supplied fields change; membership uses set_collection_products and ordering several collections uses reorder_collections.', domain: 'products', minimumRole: 'admin', inputSchema: { collection_id: { type: 'string' }, name: { type: 'string' }, description: { type: ['string', 'null'] }, sort_order: { type: 'integer' } }, required: ['collection_id'], outputSchema: { type: 'object', properties: { collection: collectionObject }, required: ['collection'] } }),
  organizationTool({ name: 'delete_collection', description: 'Permanently delete the selected product collection and its memberships when the user asks to remove that group. Returns deleted status; its products remain in the catalog and other collections.', domain: 'products', minimumRole: 'admin', inputSchema: { collection_id: { type: 'string' } }, required: ['collection_id'], outputSchema: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] } }),
  organizationTool({ name: 'set_collection_products', description: "Replace a product collection’s membership and display order when the user wants to change which items it contains. Supply every product ID to retain, in the intended order. Omitted products are removed from this collection but remain in the catalog.", domain: 'products', minimumRole: 'admin', inputSchema: { collection_id: { type: 'string' }, product_ids: { type: 'array', items: { type: 'string' }, maxItems: PRODUCT_LIMITS.collectionProducts } }, required: ['collection_id', 'product_ids'], outputSchema: { type: 'object', properties: { products: { type: 'array', items: productListItemObject } }, required: ['products'] } }),
  organizationTool({ name: 'reorder_collections', description: 'Set the display order of product collections for the whole site or one explicit location. Supply every collection ID in that scope exactly once; a partial list is rejected. Returns the ordered collections without changing their products.', domain: 'products', minimumRole: 'admin', inputSchema: { collection_ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, location_id: { type: ['string', 'null'] } }, required: ['collection_ids'], outputSchema: { type: 'object', properties: { collections: { type: 'array', items: collectionObject } }, required: ['collections'] } }),

]

/**
 * Writing to a product is an organization-wide act, and a location-scoped
 * editor must not get there by naming a location. This authorizes the
 * location for the rows that ARE location-scoped — offering, withdrawing, and
 * per-location pricing.
 */
async function authorizeLocation(ctx: McpExecutorContext, locationId: string) {
  await assertResourceAccess(ctx.organization.db, {
    ...memberAccessPrincipal(ctx.organization.membership, { env: ctx.organization.env }),
    resourceLocationId: locationId,
  })
}

function mcpProduct(product: Product) {
  const { created_by, updated_by, ...value } = product
  return { ...value, variants: value.variants.map(variant => ({
    ...variant,
    prices: variant.prices.map(price => {
      const { created_by, updated_by, ...offer } = price
      return offer
    }),
  })) }
}

/** Every full MCP product response includes this site's canonical media. */
async function productResponse(ctx: McpExecutorContext, product: Product) {
  const [hydrated] = await hydrateProductMedia(ctx.organization.db, ctx.organization.organizationId, [product])
  const slug = ctx.organization.organizationSlug
  const value = hydrated!
  const path = value.kind === 'experience' ? `/experiences/${encodeURIComponent(value.slug)}` : value.page?.path ?? null
  const readiness = value.kind === 'experience' || value.booking ? await productBookingReadiness(ctx.organization.db, ctx.organization.organizationId, value, { env: ctx.organization.env }) : null
  const published = path && await queryFirst(ctx.organization.db, `SELECT p.id FROM products p
    JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
    WHERE p.organization_id = ? AND p.id = ? AND ${PUBLIC_PRODUCT_SQL}`, [ctx.organization.organizationId, value.id])
  const publicUrl = path && published && (!readiness || readiness.ready) && ctx.organization.publicUrl
    ? new URL(path, ctx.organization.publicUrl).toString() : null
  return { product: { ...mcpProduct(value), booking_readiness: readiness ? {ready:readiness.ready,missing:readiness.missing} : null, public_url: publicUrl, admin_edit_url: slug ? productEditorPath(slug, value.id) : null } }
}

/** One page of products, with the extra row the query asked for removed. */
function productPage(result: ProductListResult, window: { limit: number; offset: number }, pageScope: { resource: string; revision: string }, scope: { organization_id: string; location_id?: string; kind: Product['kind'] | 'all'; featured?: boolean; published_only: boolean }) {
  const { products, counts } = result
  const page = products.slice(0, window.limit)
  const at = new Date().toISOString()
  return {
    scope: { view: 'catalog', ...scope },
    counts,
    page_info: mcpPageInfo(window, page.length, products.length > window.limit, pageScope),
    products: page.map(product => productListItem(product, scope.location_id, at)),
  }
}

function productListItem(product: Product, locationId?: string, at = new Date().toISOString()) {
  const locations = locationId === undefined ? [null, ...product.locations.map(location => location.location_id)] : [locationId]
  const prices = product.variants.filter(variant => variant.active).flatMap(variant => {
    const terms = new Map(variant.prices.map(price => {
      const billing: PriceBilling = price.type === 'recurring'
        ? { type: 'recurring', interval: price.recurring_interval!, interval_count: price.recurring_interval_count! }
        : { type: 'one_time' }
      return [JSON.stringify([price.currency, billing]), { currency: price.currency, billing }] as const
    }))
    const current = new Map(locations.flatMap(location_id => [...terms.values()].flatMap(term => {
      const price = selectPrice(variant.prices, { ...term, location_id, at })
      return price ? [price] : []
    })).map(price => [price.id, price]))
    return [...current.values()].map(price => ({
      variant_id: variant.id, location_id: price.location_id,
      currency: price.currency, unit_amount: price.unit_amount, type: price.type,
      ...(price.type === 'recurring' ? { recurring_interval: price.recurring_interval!, recurring_interval_count: price.recurring_interval_count! } : {}),
    }))
  })
  return {
    id: product.id,
    kind: product.kind,
    name: product.name,
    slug: product.slug,
    active: product.active,
    featured: product.details.featured === true,
    variant_count: product.variants.length,
    collections: product.collections,
    publications: product.publications,
    locations: product.locations,
    prices,
    ...(typeof product.details.pricing_note === 'string' ? { pricing_note: product.details.pricing_note } : {}),
  }
}

export async function handleProductsTools(ctx: McpExecutorContext) {
  const { toolName, args, organization } = ctx
  const actor = { actorId: organization.userId }
  const scope = { organizationId: organization.organizationId}

  const principal = memberAccessPrincipal(organization.membership, { env: organization.env })
  const managesCatalog = await roleAllows({ ...principal, permissions: { products: ['update'] } })
  if (['get_product', 'update_product', 'set_product_booking_config', 'replace_product_weekly_schedule'].includes(toolName)) {
    await assertProductAccess(organization.db, { ...principal, productId: requiredString(args, 'product_id'), patch: toolName === 'get_product' ? undefined : args })
  }

  switch (toolName) {
    case 'update_menu': {
      const locationId = requiredString(args, 'location_id')
      await authorizeLocation(ctx, locationId)
      if (!organization.publicUrl) throw new HTTPError({ statusCode: 409, statusMessage: 'The site is not public', data: { code: 'SITE_NOT_PUBLIC' } })
      const result = await updateMenu(organization.db, { ...scope, locationId, sections: args.sections as MenuSectionInput[], idempotencyKey: requiredString(args, 'idempotency_key'), actor })
      return { ...result, sections: result.sections.map(section => ({ ...section, products: section.products.map(mcpProduct) })), public_url: new URL('/menu', organization.publicUrl).toString() }
    }

    case 'set_product_booking_config': {
      const config = await setProductBookingConfig(organization.db, {
        ...scope, productId: requiredString(args, 'product_id'), actorId: organization.userId, env: organization.env,
        patch: { duration_minutes: args.duration_minutes, default_capacity: args.default_capacity, confirmation_mode: args.confirmation_mode, online_payment_required: args.online_payment_required, held_online: args.held_online, scheduling_mode: args.scheduling_mode, assigned_member_id: args.assigned_member_id, assigned_team_id: args.assigned_team_id },
      })
      return { config }
    }
    case 'delete_product_booking_config':
      await deleteProductBookingConfig(organization.db, { ...scope, productId: requiredString(args, 'product_id') })
      return { deleted: true }
    case 'replace_product_weekly_schedule': {
      const locationId = requiredString(args, 'location_id')
      if (managesCatalog) await authorizeLocation(ctx, locationId)
      return await replaceWeeklySchedule(organization.db, {
        ...scope, productId: requiredString(args, 'product_id'), locationId,
        slots: args.slots, actorId: organization.userId,
      })
    }
    // Editor lists page in SQL; public experience eligibility precedes paging.
    case 'list_products': {
      const kind = args.kind as Product['kind'] | undefined
      const featured = args.featured as boolean | undefined
      const publishedOnly = args.published_only === true
      const pageScope = { resource: 'products', revision: JSON.stringify([organization.organizationId, kind ?? null, featured ?? null, publishedOnly, managesCatalog ? null : organization.userId]) }
      const window = mcpPageWindow(args, pageScope)
      const products = await listOrganizationProducts(organization.db, { ...scope, kind, featured, publishedOnly, window, withCounts: true, env: organization.env, assignedUserId: managesCatalog ? undefined : organization.userId })
      return productPage(products, window, pageScope, { organization_id: organization.organizationId, kind: kind ?? 'all', ...(featured === undefined ? {} : { featured }), published_only: publishedOnly })
    }
    case 'list_location_products': {
      const locationId = requiredString(args, 'location_id')
      await authorizeLocation(ctx, locationId)
      const kind = args.kind as Product['kind'] | undefined
      const featured = args.featured as boolean | undefined
      const publishedOnly = args.published_only === true
      const pageScope = { resource: 'products', revision: JSON.stringify([organization.organizationId, locationId, kind ?? null, featured ?? null, publishedOnly]) }
      const window = mcpPageWindow(args, pageScope)
      const products = await listLocationProducts(organization.db, {
        organizationId: organization.organizationId, locationId, window,
        kind, featured, publishedOnly, withCounts: true, env: organization.env,
      })
      return productPage(products, window, pageScope, { organization_id: organization.organizationId, location_id: locationId, kind: kind ?? 'all', ...(featured === undefined ? {} : { featured }), published_only: publishedOnly })
    }
    case 'get_product': {
      return await productResponse(ctx, await requireOrganizationProduct(organization.db, { ...scope, productId: requiredString(args, 'product_id') }))
    }

    case 'create_product': {
      // Experience creation requests publication so the canonical writer
      // requires its booking setup or external destination before committing.
      // A supplied page is created and bound in that same batch.
      const page = args.page === undefined ? undefined : args.page as { title: string; path?: string; summary?: string | null; pageType?: 'custom' | 'recipe' | 'legal' | 'system'; recipe?: string | null; sortOrder?: number; blocks: unknown }
      const idempotencyKey = requiredString(args, 'idempotency_key')
      const booking = args.booking as ProductBookingSetupInput | undefined
      if (booking?.location_id) await authorizeLocation(ctx, booking.location_id)
      const product = await createProduct(organization.db, {
        organizationId: organization.organizationId,
        env: organization.env,
        product: omit(args, ['page', 'booking', 'idempotency_key']) as unknown as CreateProductInput, actor,
        publication: { published: Boolean(booking || args.kind === 'experience') },
        ...(booking ? { booking: { data: booking, env: organization.env } } : {}),
        ...(page ? { page: { data: page, env: organization.env } } : {}),
        idempotencyKey,
      })
      return await productResponse(ctx, product)
    }
    case 'update_product': {
      const productId = requiredString(args, 'product_id')
      await requireOrganizationProduct(organization.db, { ...scope, productId })
      const booking = args.booking as ProductBookingSetupInput | undefined
      if (booking?.location_id) await authorizeLocation(ctx, booking.location_id)
      return await productResponse(ctx, await updateProduct(organization.db, {
        ...scope, productId, patch: omit(args, ['product_id', 'booking', 'idempotency_key']) as unknown as UpdateProductInput, actor,
        env: organization.env,
        ...(booking ? { booking: { data: booking, env: organization.env } } : {}),
        ...(args.idempotency_key ? { idempotencyKey: requiredString(args, 'idempotency_key') } : {}),
      }))
    }
    case 'delete_product': {
      const productId = requiredString(args, 'product_id')
      await requireOrganizationProduct(organization.db, { ...scope, productId })
      await deleteProduct(organization.db, { organizationId: organization.organizationId, productId })
      return { deleted: true }
    }
    case 'set_product_publication': {
      const productId = requiredString(args, 'product_id')
      const target = await getProduct(organization.db, organization.organizationId, productId)
      // Attaching a product to this site is not a way in to a product the
      // caller could not already reach. One carried by a site outside their
      // access stays outside it — otherwise publishing it here would be the
      // permission to edit it everywhere.
      if (target.publications.length > 0) {
        const visible = new Set((await listOrganizationsForUser(organization.db, organization.env, organization.userId)).map(row => String(row.id)))
        if (target.publications.some(entry => !visible.has(entry.organization_id))) {
          throw mcpProtocolError(MCP_ERROR.invalidParams, 'That product is carried by a site you do not have access to')
        }
      }
      if (typeof args.published !== 'boolean') throw mcpProtocolError(MCP_ERROR.invalidParams, 'published must be a boolean')
      await setProductPublication(organization.db, { ...scope, productId, published: args.published, actor, env: organization.env })
      return await productResponse(ctx, await getProduct(organization.db, organization.organizationId, productId))
    }
    case 'set_product_location': {
      const productId = requiredString(args, 'product_id')
      const locationId = requiredString(args, 'location_id')
      // Both halves are checked: the location the caller may reach, and the
      // product this site actually carries. Authorizing one says nothing
      // about the other.
      await requireOrganizationProduct(organization.db, { ...scope, productId })
      await authorizeLocation(ctx, locationId)
      await setProductLocation(organization.db, {
        organizationId: organization.organizationId, productId, locationId,
        active: typeof args.active === 'boolean' ? args.active : undefined,
        published: typeof args.published === 'boolean' ? args.published : undefined,
        actor, env: organization.env,
      })
      return await productResponse(ctx, await getProduct(organization.db, organization.organizationId, productId))
    }
    case 'remove_product_location': {
      const productId = requiredString(args, 'product_id')
      const locationId = requiredString(args, 'location_id')
      await requireOrganizationProduct(organization.db, { ...scope, productId })
      await authorizeLocation(ctx, locationId)
      await removeProductLocation(organization.db, { organizationId: organization.organizationId, productId, locationId })
      return await productResponse(ctx, await getProduct(organization.db, organization.organizationId, productId))
    }
    case 'batch_create_products': {
      // The site carries what it created, withheld until someone publishes it
      // — written in the same batch as the products themselves.
      const products = await createProductsBatch(organization.db, {
        ...scope, products: objectArray(args.products, 'products') as unknown as CreateProductInput[], actor, env: organization.env,
        publication: { published: false },
        idempotencyKey: requiredString(args, 'idempotency_key'),
      })
      return { products: products.map(mcpProduct) }
    }
    case 'reconcile_products':
      return {
        products: (await hydrateProductMedia(organization.db, organization.organizationId, await reconcileProducts(organization.db, {
          ...scope,
          env: organization.env,
          products: objectArray(args.products, 'products') as unknown as ReconcileProductInput[],
          actor,
          deactivateMissing: args.deactivate_missing === true,
          idempotencyKey: requiredString(args, 'idempotency_key'),
        }))).map(mcpProduct),
      }

    case 'list_collections': {
      const locationId = args.location_id === undefined ? undefined : (args.location_id === null ? null : requiredString(args, 'location_id'))
      return { collections: await listCollections(organization.db, { ...scope, locationId }) }
    }
    case 'create_collection': {
      const locationId = typeof args.location_id === 'string' ? args.location_id : null
      if (locationId) await authorizeLocation(ctx, locationId)
      return {
        collection: await createCollection(organization.db, {
          organizationId: organization.organizationId,
          collection: {
            location_id: locationId,
            name: requiredString(args, 'name'),
            description: typeof args.description === 'string' ? args.description : null,
            sort_order: typeof args.sort_order === 'number' ? args.sort_order : undefined,
          },
          actor,
        }),
      }
    }
    case 'update_collection':
      return {
        collection: await updateCollection(organization.db, {
          organizationId: organization.organizationId,
          collectionId: requiredString(args, 'collection_id'),
          patch: omit(args, ['collection_id']),
          actor,
        }),
      }
    case 'delete_collection':
      await deleteCollection(organization.db, {
        organizationId: organization.organizationId, collectionId: requiredString(args, 'collection_id'),
      })
      return { deleted: true }
    case 'set_collection_products': {
      const collectionId = requiredString(args, 'collection_id')
      await setCollectionProducts(organization.db, {
        organizationId: organization.organizationId, collectionId,
        productIds: requiredStringArray(args.product_ids, 'product_ids'), actor,
      })
      const products = await listCollectionProducts(organization.db, { organizationId: organization.organizationId, collectionId })
      return { products: products.map(product => productListItem(product)) }
    }
    case 'reorder_collections': {
      const locationId = args.location_id === undefined || args.location_id === null ? null : requiredString(args, 'location_id')
      await reorderCollections(organization.db, {
        ...scope, locationId, collectionIds: requiredStringArray(args.collection_ids, 'collection_ids'), actor,
      })
      return { collections: await listCollections(organization.db, { ...scope, locationId }) }
    }


  }
  return NOT_HANDLED
}
