import { contentBlockDataSchema, contentBlockSchemaDefinitions, CONTENT_BLOCK_TYPES, type ContentBlockType } from '~/shared/content-registries'
import { timezoneSchema } from '~/utils/timezone'
import { openingHoursSchema, specialHoursSchema } from '~/shared/reservation-hours'
import type { McpToolRole } from '~/server/utils/mcp-auth'
import { SUPPORTED_CURRENCIES } from '~/shared/currencies'
import { RESERVATION_STATUSES } from '~/shared/bookings'
import { INDEXED_MEDIA_PLACEMENT_SLOTS, MEDIA_PLACEMENT_SLOTS, isEditableMediaPlacement, isSingleMediaPlacement, type EditableMediaPlacementOwnerType } from '~/shared/media-placement-contract'

export interface McpToolDefinition {
  name: string
  title: string
  description: string
  domain: string
  minimumRole: McpToolRole
  annotations: McpToolAnnotations
  securitySchemes: McpToolSecurityScheme[]
  requiredEntitlement?: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  fileParams?: string[]
  uiResourceUri?: string
}

export interface McpToolAnnotations {
  readOnlyHint: boolean
  openWorldHint: boolean
  destructiveHint: boolean
  idempotentHint?: boolean
}

export interface McpToolSecurityScheme {
  type: 'oauth2'
  scopes: string[]
}

export const MCP_TOOL_SECURITY_SCHEMES: McpToolSecurityScheme[] = [
  { type: 'oauth2', scopes: ['tenant'] },
]

export const paginationInputSchema = {
  limit: { type: 'number', minimum: 1, maximum: 100, description: 'Page size. Defaults to 50; maximum 100.' },
  cursor: { type: 'string', description: 'Opaque next_cursor from the previous page.' },
}

export const pageInfoObject = {
  type: 'object',
  properties: {
    has_more: { type: 'boolean' },
    next_cursor: { type: ['string', 'null'] },
  },
  required: ['has_more', 'next_cursor'],
}

export const workspaceContextObject = {
  type: 'object',
  properties: {
    organization_id: { type: ['string', 'null'] },
    organization_name: { type: ['string', 'null'] },
    organization_slug: { type: ['string', 'null'] },
    organization_subdomain: { type: ['string', 'null'] },
    organization_public_url: { type: ['string', 'null'] },
    location_id: { type: ['string', 'null'] },
    location_slug: { type: ['string', 'null'] },
    location_title: { type: ['string', 'null'] },
  },
  required: ['organization_id', 'organization_name', 'organization_slug', 'organization_subdomain', 'organization_public_url', 'location_id', 'location_slug', 'location_title'],
}

// --- reusable schema fragments ---


/** SEO override fields shared across location/Product/experience/site tools. */
export function seoOverrideFieldsSchema() {
  return {
    seo_title: { type: ['string', 'null'], description: 'Optional SEO title override. Falls back to the computed default if unset.' },
    seo_description: { type: ['string', 'null'], description: 'Optional SEO meta description override. Falls back to the computed default if unset.' },
    canonical_url: { type: ['string', 'null'], description: 'Optional canonical URL override. Leave unset for the default self-referencing canonical.' },
  }
}

export const openingHoursInputSchema = { ...openingHoursSchema, description: 'Canonical weekly endpoint periods. Days use Sunday=0. Null means unknown; periods [] means closed. Sunday 00:00 without a close means always open.' }
export const specialHoursInputSchema = { ...specialHoursSchema, description: 'Explicit dated hours or closures. Closure starts_on is required; ends_on is inclusive and null means indefinite. Dated hours replace regular hours; periods [] closes the date.' }

/**
 * A postal address as `google.type.PostalAddress`, which is what the Places API
 * returns and what the column stores. `addressLines` is ordered and unbounded;
 * `sublocality` is a real part of a Thai address.
 */
export const postalAddressSchema = {
  type: ['object', 'null'],
  properties: {
    regionCode: { type: 'string', minLength: 1, pattern: '\\S', description: 'ISO 3166-1 alpha-2 country code, e.g. TH.' },
    addressLines: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, pattern: '\\S' }, description: 'Address lines in order, unbounded.' },
    languageCode: { type: 'string', description: 'BCP-47 tag when the address is written in a specific language.' },
    locality: { type: 'string', description: 'Town or city.' },
    sublocality: { type: 'string', description: 'Neighbourhood or sub-district.' },
    administrativeArea: { type: 'string', description: 'State, province or region.' },
    postalCode: { type: 'string' },
  },
  required: ['regionCode', 'addressLines'],
} as const

export const locationObject = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    website_url: { type: ['string', 'null'] },
    maps_url: { type: ['string', 'null'] },
    address: postalAddressSchema,
    opening_hours: openingHoursSchema,
    special_hours: specialHoursSchema,
    rating: { type: ['number', 'null'] },
    review_count: { type: ['number', 'null'] },
    description: { type: ['string', 'null'] },
    short_description: { type: ['string', 'null'] },
    status: { type: 'string' },
    timezone: timezoneSchema,
    max_capacity: { type: ['number', 'null'], description: 'Stored location capacity metadata; does not limit reservations. Reservation capacity uses location_reservation_configs.slot_capacity.' },
    seo_title: { type: ['string', 'null'] },
    seo_description: { type: ['string', 'null'] },
    canonical_url: { type: ['string', 'null'] },
    media: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          asset_id: { type: 'string' },
          kind: { type: 'string', enum: ['image', 'video'] },
          public_url: { type: 'string' },
          thumbnail_url: { type: ['string', 'null'] },
          alt_text: { type: ['string', 'null'] },
          sort_order: { type: 'number' },
        },
        required: ['asset_id', 'kind', 'public_url', 'sort_order'],
      },
    },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['id', 'slug', 'title', 'status', 'timezone', 'created_at', 'updated_at', 'media'],
}

export const locationMutationResultObject = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    location: locationObject,
  },
  required: ['success', 'location'],
}

export const locationMutationSummaryObject = {
  type: 'object',
  properties: {
    ok: { const: true },
    entity: { type: 'string', enum: ['location'] },
    id: { type: 'string' },
    slug: { type: 'string' },
    changed_fields: { type: 'array', items: { type: 'string' } },
    updated_at: { type: 'string' },
    context: workspaceContextObject,
  },
  required: ['ok', 'entity', 'id', 'slug', 'changed_fields', 'updated_at', 'context'],
}

/** Each branch repeats the complete object contract so connector projections retain common fields. */
export function contentBlockTypeBranches(schema: {
  properties: Record<string, unknown>
  required: readonly string[]
  additionalProperties?: boolean
}, types: readonly ContentBlockType[] = CONTENT_BLOCK_TYPES) {
  return types.map(type => ({
    type: 'object',
    ...schema,
    title: type,
    properties: {
      ...schema.properties,
      type: { type: 'string', const: type },
      data: contentBlockDataSchema(type),
    },
    required: [...schema.required],
  }))
}

const blogComponentProperties = {
  type: { type: 'string', enum: ['faq', 'how_to', 'ai_assistance'] },
  label: { type: ['string', 'null'] },
  status: { type: ['string', 'null'], enum: ['active', 'inactive', null] },
  render_enabled: { type: ['boolean', 'null'] },
  schema_enabled: { type: ['boolean', 'null'] },
  position: { type: ['number', 'null'] },
  data: { anyOf: (['faq', 'how_to', 'ai_assistance'] as const).map(type => ({ ...contentBlockDataSchema(type), title: type })) },
}

export const blogComponentInputSchema = {
  type: 'object',
  properties: blogComponentProperties,
  required: ['type', 'data'],
  anyOf: contentBlockTypeBranches({ properties: blogComponentProperties, required: ['type', 'data'] }, ['faq', 'how_to', 'ai_assistance']),
}

/** Fixed names, indexed patterns and cardinality come from the placement writer's registry. */
export function mediaPlacementSlotInputSchema(ownerType: EditableMediaPlacementOwnerType, options: { single?: boolean; excludedFixedSlots?: readonly string[] } = {}) {
  const slots = MEDIA_PLACEMENT_SLOTS[ownerType].filter(slot => isEditableMediaPlacement({ owner_type: ownerType, slot })
    && (options.single === undefined || isSingleMediaPlacement({ owner_type: ownerType, slot }) === options.single)
    && !options.excludedFixedSlots?.includes(slot))
  const indexedSlots = INDEXED_MEDIA_PLACEMENT_SLOTS.filter(entry => entry.ownerType === ownerType)
    .map(entry => ({ type: 'string', pattern: entry.runtime.source, examples: [entry.sqlGlob.replace('[0-9]*', '0')] }))
    .filter(entry => options.single === undefined || isSingleMediaPlacement({ owner_type: ownerType, slot: entry.examples[0]! }) === options.single)
  if (!slots.length && !indexedSlots.length) return null
  const fixedSlots = { type: 'string', enum: slots }
  return indexedSlots.length ? { anyOf: [...(slots.length ? [fixedSlots] : []), ...indexedSlots] } : fixedSlots
}

/**
 * A block's media as a writer sends it. The same object a read returns, so a
 * block read from get_blog_post or get_site_page can be sent back verbatim:
 * only asset_id and slot are taken, the delivery fields are ignored. The input
 * used to accept the two fields alone, and a block echoed with its public_url
 * was refused as an unknown argument — which is how images went missing.
 */
export const contentBlockMediaInputObject = {
  type: 'object',
  properties: {
    asset_id: { type: 'string' },
    slot: mediaPlacementSlotInputSchema('content_block')!,
    sort_order: { type: ['number', 'null'] },
    public_url: { type: ['string', 'null'] },
    thumbnail_url: { type: ['string', 'null'] },
    kind: { type: ['string', 'null'] },
    alt_text: { type: ['string', 'null'] },
    file_name: { type: ['string', 'null'] },
    width: { type: ['number', 'null'] },
    height: { type: ['number', 'null'] },
  },
  required: ['asset_id', 'slot'],
  additionalProperties: false,
}

export const contentBlockMediaInputRef = { $ref: '#/$defs/content_block_media' }
const contentBlockKnownDefinitions = { content_block_media: contentBlockMediaInputObject }

/** A block's own timestamp as a read returns it. Accepted on a whole-document write so a read can be sent back verbatim; the document's expected_updated_at is the concurrency token there. */
export const contentBlockUpdatedAtInput = { type: ['string', 'null'], description: 'As read. Ignored on a whole-document write.' }

export const contentBlockDataInputSchema = {
  anyOf: CONTENT_BLOCK_TYPES.map(type => ({ ...contentBlockDataSchema(type), title: type })),
}

/** The article's leading image block, or null when it opens with text. */
const blogCoverObject = {
  type: ['object', 'null'],
  properties: {
    asset_id: { type: 'string' },
    public_url: { type: ['string', 'null'] },
    thumbnail_url: { type: ['string', 'null'] },
    kind: { type: ['string', 'null'] },
    alt_text: { type: ['string', 'null'] },
    width: { type: ['number', 'null'] },
    height: { type: ['number', 'null'] },
  },
  required: ['asset_id', 'public_url', 'thumbnail_url', 'kind', 'alt_text', 'width', 'height'],
  additionalProperties: false,
}

const contentBlockProperties = {
  id: { type: 'string' },
  parent_block_id: { type: ['string', 'null'] },
  type: { type: 'string', enum: [...CONTENT_BLOCK_TYPES] },
  source_block_id: { type: ['string', 'null'] },
  position: { type: 'integer' },
  level: { type: ['number', 'null'] },
  data: { type: 'object' },
  media: { type: 'array', items: contentBlockMediaInputRef },
  updated_at: { type: 'string', description: 'The block\'s own concurrency token, for replace_content_block and delete_content_block.' },
}
const contentBlockRequired = ['id', 'parent_block_id', 'type', 'level', 'data', 'media', 'updated_at']

export const contentBlockObject = {
  type: 'object',
  properties: contentBlockProperties,
  required: contentBlockRequired,
  additionalProperties: false,
  anyOf: contentBlockTypeBranches({ properties: contentBlockProperties, required: contentBlockRequired, additionalProperties: false }),
}

/** An article's category as posts carry it. */
export const articleCategoryRefObject = {
  type: ['object', 'null'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' } },
  required: ['id', 'name', 'slug'],
  additionalProperties: false,
} as const

/** One of a collection's categories, as the category tools return it. */
export const articleCategoryObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    collection: { type: 'string', enum: ['blog', 'docs'] },
    name: { type: 'string' },
    slug: { type: 'string', description: "The category page's address: /blog/category/{slug} or /docs/category/{slug}. It does not change when the category is renamed." },
    description: { type: ['string', 'null'] },
    parent_id: { type: ['string', 'null'], description: 'The category it sits under; null at the top level.' },
    sort_order: { type: 'integer', description: 'Its place among its siblings.' },
    article_count: { type: 'integer', description: 'Articles in the category itself, drafts included.' },
    child_count: { type: 'integer', description: 'Subcategories directly under it.' },
  },
  required: ['id', 'collection', 'name', 'slug', 'description', 'parent_id', 'sort_order', 'article_count', 'child_count'],
  additionalProperties: false,
} as const

export const blogPostObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    slug: { type: 'string' },
    excerpt: { type: ['string', 'null'] },
    collection: { type: 'string', enum: ['blog', 'docs'] },
    category: articleCategoryRefObject,
    sort_order: { type: 'integer' },
    seo_keywords: { type: ['string', 'null'] },
    published: { type: 'boolean' },
    published_at: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['draft', 'published'] },
    visibility: { type: 'string', enum: ['listed', 'unlisted'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    cover: blogCoverObject,
    admin_edit_url: { type: ['string', 'null'] },
    edit_url: { type: ['string', 'null'] },
    public_path: { type: ['string', 'null'] },
    public_url: { type: ['string', 'null'] },
    preview_url: { type: ['string', 'null'] },
    view_url: { type: ['string', 'null'] },
    content_blocks: { type: 'array', items: contentBlockObject },
  },
  required: [
    'id', 'title', 'slug', 'excerpt', 'collection', 'category', 'sort_order',
    'seo_keywords',
    'published', 'published_at', 'status', 'visibility',
    'created_at', 'updated_at', 'cover', 'admin_edit_url', 'edit_url',
    'public_path', 'public_url', 'preview_url', 'view_url',
    'content_blocks',
  ],
  additionalProperties: false,
}

export const blogPostSummaryObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    slug: { type: 'string' },
    excerpt: { type: ['string', 'null'] },
    collection: { type: 'string', enum: ['blog', 'docs'] },
    category: articleCategoryRefObject,
    sort_order: { type: 'integer' },
    seo_keywords: { type: ['string', 'null'] },
    published: { type: 'boolean' },
    published_at: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['draft', 'published'] },
    visibility: { type: 'string', enum: ['listed', 'unlisted'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    cover: blogCoverObject,
    admin_edit_url: { type: ['string', 'null'] },
    edit_url: { type: ['string', 'null'] },
    public_path: { type: ['string', 'null'] },
    public_url: { type: ['string', 'null'] },
    preview_url: { type: ['string', 'null'] },
    view_url: { type: ['string', 'null'] },
  },
  required: [
    'id', 'title', 'slug', 'excerpt', 'collection', 'category', 'sort_order',
    'seo_keywords',
    'published', 'published_at', 'status', 'visibility',
    'created_at', 'updated_at', 'cover', 'admin_edit_url', 'edit_url',
    'public_path', 'public_url', 'preview_url', 'view_url',
  ],
  additionalProperties: false,
}

export const blogPostMutationResultObject = {
  type: 'object',
  properties: {
    post: blogPostObject,
  },
  required: ['post'],
  additionalProperties: false,
}

const postPublicationObject = {
  type: 'object',
  description: 'One external publication of this post. Private to the organization.',
  properties: {
    id: { type: 'string', description: 'The publication_id reconcile_post_publication takes.' },
    channel: { type: 'string', enum: ['facebook', 'instagram', 'discord'] },
    target_id: { type: 'string' },
    state: { type: 'string', enum: ['preparing', 'publishing', 'published', 'failed', 'unknown', 'removed'] },
    provider_post_id: { type: ['string', 'null'] },
    public_url: { type: ['string', 'null'], description: 'The provider\'s own permalink, when it returned one. A Discord message link opens only for members of that channel.' },
    code: { type: ['string', 'null'] },
    message: { type: ['string', 'null'] },
    published_at: { type: ['string', 'null'] },
    local_content_changed: { type: 'boolean', description: 'The website copy changed after this was sent. The external post was not edited.' },
  },
  required: ['id', 'channel', 'target_id', 'state', 'provider_post_id', 'public_url', 'code', 'message', 'published_at', 'local_content_changed'],
  additionalProperties: false,
}

export const postObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    organization_id: { type: 'string' },
    location_id: { type: ['string', 'null'] },
    slug: { type: 'string' },
    title: { type: ['string', 'null'] },
    body: { type: ['string', 'null'] },
    call_to_action: { anyOf: [{ type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'], additionalProperties: false }, { type: 'null' }] },
    status: { type: 'string', enum: ['draft', 'published'] },
    visibility: { type: 'string', enum: ['listed', 'unlisted'] },
    source: { type: 'string', enum: ['manual', 'template'], description: 'The organization authored this website post or created it from a template.' },
    published_at: { type: ['string', 'null'] },
    public_path: { type: 'string' },
    canonical_url: { type: ['string', 'null'] },
    preview_url: { type: ['string', 'null'], description: 'A signed link to the draft as visitors will see it.' },
    public_url: { type: ['string', 'null'] },
    view_url: { type: ['string', 'null'] },
    media: {
      type: 'array',
      description: 'Cover, then gallery, in order.',
      items: {
        type: 'object',
        properties: {
          asset_id: { type: 'string' },
          public_url: { type: 'string' },
          thumbnail_url: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['image', 'video'] },
          slot: { type: 'string', enum: ['cover', 'gallery'] },
          sort_order: { type: 'number' },
          alt_text: { type: ['string', 'null'] },
          width: { type: ['number', 'null'] },
          height: { type: ['number', 'null'] },
          mime_type: { type: ['string', 'null'] },
          duration: { type: ['number', 'null'] },
          updated_at: { type: 'string' },
        },
        required: ['asset_id', 'public_url', 'kind', 'slot', 'sort_order'],
      },
    },
    publications: { type: 'array', items: postPublicationObject },
    created_at: { type: 'string' },
    updated_at: { type: 'string', description: 'The expected_updated_at update_post and publish_post take.' },
  },
  required: ['id', 'slug', 'status', 'visibility', 'media', 'publications', 'updated_at'],
}

export const postMutationResultObject = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    post: postObject,
    replayed: { type: 'boolean', description: 'True when this idempotency_key had already created the post.' },
    context: { type: 'object' },
  },
  required: ['ok', 'post'],
}

const publishOutcomeObject = {
  type: 'object',
  properties: {
    channel: { type: 'string', enum: ['organization', 'facebook', 'instagram', 'discord'] },
    target_id: { type: 'string' },
    status: { type: 'string', enum: ['published', 'already_published', 'processing', 'failed', 'unknown', 'skipped'] },
    publication_id: { type: 'string' },
    public_url: { type: ['string', 'null'] },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['channel', 'target_id', 'status'],
  additionalProperties: false,
}

export const postPublishResultObject = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'True only when every requested target is published or already published.' },
    post_id: { type: 'string' },
    updated_at: { type: 'string' },
    outcomes: { type: 'array', items: publishOutcomeObject },
  },
  required: ['ok', 'post_id', 'updated_at', 'outcomes'],
  additionalProperties: false,
}

export const mediaAssetObject = {
  type: 'object',
  properties: {
    asset_id: { type: 'string' },
    kind: { type: 'string', enum: ['image', 'video', 'file'] },
    provider: { type: 'string' },
    source: { type: 'string' },
    public_url: { type: ['string', 'null'] },
    thumbnail_url: { type: ['string', 'null'] },
    alt_text: { type: ['string', 'null'] },
    category: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['pending', 'active', 'deleted', 'failed'] },
    file_name: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
  required: ['asset_id', 'kind', 'provider', 'source', 'status'],
}

export const currentUserObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    isPlatformAdmin: { type: 'boolean' },
  },
  required: ['id', 'isPlatformAdmin'],
}

export const fileReferenceObject = {
  type: 'object',
  properties: {
    download_url: { type: 'string' },
    file_id: { type: 'string' },
    mime_type: { type: 'string' },
    file_name: { type: 'string' },
  },
  required: ['download_url', 'file_id'],
}

export const chatgptFileInput = {
  ...fileReferenceObject,
  description: 'Authorized file reference supplied by ChatGPT after rewriting the declared top-level file argument, including a temporary download_url and file_id.',
}

export const resolvedMediaAssetObject = {
  type: 'object',
  properties: {
    asset_id: { type: 'string' },
    kind: { type: 'string', enum: ['image', 'video', 'file'] },
    public_url: { type: 'string' },
    thumbnail_url: { type: ['string', 'null'] },
    mime_type: { type: ['string', 'null'] },
    width: { type: ['number', 'null'] },
    height: { type: ['number', 'null'] },
    duration: { type: ['number', 'null'] },
    alt_text: { type: ['string', 'null'] },
    provider: { type: 'string' },
    status: { type: 'string', enum: ['active'] },
  },
  required: ['asset_id', 'kind', 'public_url', 'status'],
}

export const renderedBookingPolicySummaryObject = {
  type: 'object',
  properties: {
    heading: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
      },
    },
    additional_notes_html: { type: ['string', 'null'] },
  },
  required: ['heading', 'items', 'additional_notes_html'],
}

/**
 * One location's reservation policy.
 *
 * No scope_type and no policy_type: a reservation policy belongs to a
 * location and nothing else, so there is no scope to choose and no cascade to
 * explain. Product booking terms are typed details on the product.
 */
export const locationReservationConfigObject = {
  type: 'object',
  properties: {
    location_id: { type: 'string' },
    duration_minutes: { type: 'integer', minimum: 1 },
    slot_capacity: { type: ['number', 'null'], description: 'Guests seatable at one start time. Null means unlimited.' },
    advance_notice_minutes: { type: ['number', 'null'] },
    free_cancellation_until_minutes: { type: ['number', 'null'] },
    reschedule_allowed: { type: 'boolean' },
    reschedule_cutoff_minutes: { type: ['number', 'null'] },
    deposit_required: { type: 'boolean' },
    deposit_amount: { type: ['integer', 'null'], minimum: 1, description: 'Total deposit per reservation, in deposit_currency minor units.' },
    deposit_currency: { type: ['string', 'null'], enum: [...SUPPORTED_CURRENCIES, null] },
    deposit_tax_behavior: { type: ['string', 'null'], enum: ['inclusive', 'exclusive', null] },
    deposit_trigger_party_size: { type: ['number', 'null'] },
    minimum_guest_age: { type: ['number', 'null'] },
    accessibility_contact_required: { type: 'boolean' },
    additional_notes_html: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['location_id', 'duration_minutes', 'reschedule_allowed', 'deposit_required', 'accessibility_contact_required', 'created_at', 'updated_at'],
} as const

export const locationReservationConfigWriteSchema = {
  duration_minutes: { type: ['integer', 'null'], minimum: 1 },
  slot_capacity: { type: ['number', 'null'], minimum: 0 },
  advance_notice_minutes: { type: ['number', 'null'], minimum: 0 },
  free_cancellation_until_minutes: { type: ['number', 'null'], minimum: 0 },
  reschedule_allowed: { type: 'boolean' },
  reschedule_cutoff_minutes: { type: ['number', 'null'], minimum: 0 },
  deposit_required: { type: 'boolean' },
  deposit_amount: { type: ['integer', 'null'], minimum: 1, description: 'Total deposit per reservation, in deposit_currency minor units.' },
    deposit_currency: { type: ['string', 'null'], enum: [...SUPPORTED_CURRENCIES, null] },
  deposit_tax_behavior: { type: ['string', 'null'], enum: ['inclusive', 'exclusive', null] },
  deposit_trigger_party_size: { type: ['number', 'null'], minimum: 1 },
  minimum_guest_age: { type: ['number', 'null'], minimum: 0 },
  accessibility_contact_required: { type: 'boolean' },
  additional_notes_html: { type: ['string', 'null'], description: 'Guest-facing notes. Sanitized on the way in; only basic formatting and links survive.' },
} as const

export const qaItemObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    question: { type: 'string' },
    answer: { type: ['string', 'null'] },
    sort_order: { type: 'number' },
    location_id: { type: ['string', 'null'] },
    source: { type: 'string' },
    status: { type: 'string', enum: ['published', 'hidden'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['id', 'question', 'answer', 'sort_order', 'location_id', 'source', 'status', 'created_at', 'updated_at'],
}

export const reviewObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    author_name: { type: ['string', 'null'] },
    rating: { type: 'number' },
    title: { type: ['string', 'null'] },
    content: { type: ['string', 'null'] },
    owner_reply: { type: ['string', 'null'] },
    source: { type: 'string' },
    status: { type: 'string' },
    created_at: { type: ['string', 'null'] },
    updated_at: { type: 'string' },
    location_id: { type: ['string', 'null'] },
    collection_method: { type: ['string', 'null'] },
    original_review_date: { type: ['string', 'null'] },
    original_reference: { type: ['string', 'null'] },
    publication_authorized: { type: 'boolean' },
    verified: { type: 'boolean' },
  },
  required: ['id', 'rating', 'source', 'status', 'created_at', 'updated_at', 'publication_authorized', 'verified'],
}

export const submissionObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    message: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
}

export const reservationSubmissionObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Inbox request ID.' },
    request_id: { type: 'string' },
    operational_reservation_id: { type: 'string', description: 'Use this ID to manage the reservation.' },
    updated_at: { type: 'string' },
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    guests: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    time: { type: ['string', 'null'] },
    requests: { type: ['string', 'null'] },
    status: { type: 'string', enum: [...RESERVATION_STATUSES] },
    created_at: { type: 'string' },
    location_id: { type: ['string', 'null'] },
    location_title: { type: ['string', 'null'] },
  },
  required: ['id', 'request_id', 'operational_reservation_id', 'updated_at', 'status', 'created_at', 'guests', 'date', 'time', 'location_id'],
}

export const organizationSummaryItem = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string', description: 'Business name, or the subdomain slug when it has none.' },
    subdomain: { type: ['string', 'null'] },
    orgSlug: { type: ['string', 'null'], description: 'Organization slug — combine with locationSlug from list_locations to build the dashboard URL: https://krabiclaw.com/dashboard/{orgSlug}/locations/{locationSlug}' },
    publicUrl: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
    active: { type: 'boolean', description: 'True when this is the currently active MCP organization context.' },
  },
  required: ['id', 'name', 'status', 'active'],
}

export const locationListItemObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
    place_name: { type: ['string', 'null'], description: 'The neighbourhood this location\'s address names, or its town. Derived from the address; call get_location for the address itself.' },
    status: { type: 'string' },
    active: { type: 'boolean', description: 'True when this is the currently active MCP location context.' },
  },
  required: ['id', 'slug', 'title', 'status', 'active'],
}

export const organizationListItemObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: ['string', 'null'] },
    slug: { type: ['string', 'null'] },
    active: { type: 'boolean', description: 'True when this is the currently active MCP organization context.' },
  },
  required: ['id', 'active'],
}

// ---

export const organizationIdSchema = {
  organization_id: { type: 'string', description: 'Internal KrabiClaw organization ID from get_workspace_context or list_organizations, e.g. org-pottery-house. Do not pass a public URL, hostname, subdomain, custom domain, slug, or business name here.' },
}

export function organizationTool(definition: Omit<RawMcpToolDefinition, 'inputSchema' | 'outputSchema'> & {
  inputSchema?: Record<string, unknown>
  required?: string[]
  outputSchema: Record<string, unknown>
}): McpToolDefinition {
  const { oneOf, anyOf, allOf, $defs, ...propertyDefs } = definition.inputSchema ?? {}
  const properties = {
    ...organizationIdSchema,
    ...propertyDefs,
  }
  const required = [...(definition.required ?? [])]
  const combinators: Record<string, unknown> = {}
  if (oneOf !== undefined) combinators.oneOf = oneOf
  if (anyOf !== undefined) combinators.anyOf = anyOf
  if (allOf !== undefined) combinators.allOf = allOf
  const definitions = { ...contentBlockSchemaDefinitions(definition.inputSchema, contentBlockKnownDefinitions), ...($defs as Record<string, unknown> | undefined) }
  return withToolAnnotations({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    domain: definition.domain,
    minimumRole: definition.minimumRole,
    requiredEntitlement: definition.requiredEntitlement,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
      ...combinators,
      ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
    },
    outputSchema: { ...definition.outputSchema, $defs: { ...contentBlockSchemaDefinitions(definition.outputSchema, contentBlockKnownDefinitions), ...(definition.outputSchema.$defs as Record<string, unknown> | undefined) } },
    fileParams: definition.fileParams,
    uiResourceUri: definition.uiResourceUri,
  })
}

export function globalTool(definition: RawMcpToolDefinition | McpToolDefinition): McpToolDefinition {
  if ('annotations' in definition && 'securitySchemes' in definition) {
    // Validate that both fields exist AND are properly structured
    const hasValidAnnotations = definition.annotations && typeof definition.annotations === 'object'
    const hasValidSecuritySchemes = definition.securitySchemes && Array.isArray(definition.securitySchemes) && definition.securitySchemes.length > 0
    if (hasValidAnnotations && hasValidSecuritySchemes) {
      // Re-validate even on this pre-built-definition path — a caller could
      // hand in annotations that never passed through withToolAnnotations.
      validateToolAnnotations(definition.name, definition.annotations)
      return { ...definition, inputSchema: { ...definition.inputSchema, additionalProperties: false } }
    }
  }

  return withToolAnnotations(definition)
}

export type RawMcpToolDefinition = Omit<McpToolDefinition, 'annotations' | 'securitySchemes' | 'title'> & { title?: string }

// Classify the complete supported contract, including optional branches.
// MCP calls an update destructive when it can overwrite or remove existing
// state. W is reserved for additive writes; D includes ordinary property edits.
// Hosting alone is not open-world. Private account and draft operations stay
// bounded; publishing or changing public website content, guest messages,
// public social audiences and host file downloads cross that scope.
const R: McpToolAnnotations = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
})
const W: McpToolAnnotations = Object.freeze({ readOnlyHint: false, openWorldHint: false, destructiveHint: false })
const D: McpToolAnnotations = Object.freeze({ readOnlyHint: false, openWorldHint: false, destructiveHint: true })

/** Submission-review contract. Every real public tool is listed explicitly. */
export const EXPECTED_TOOL_ANNOTATIONS = {
  get_website_draft: R,
  save_website_draft: { ...D, idempotentHint: true },
  publish_website: { ...D, openWorldHint: true, idempotentHint: true },
  create_qa: { ...W, openWorldHint: true },
  update_qa: { ...D, openWorldHint: true },
  delete_qa: { ...D, openWorldHint: true },
  reorder_qa: { ...D, openWorldHint: true },
  get_member_scheduling: R,
  set_member_scheduling: { ...D, openWorldHint: true },
  set_member_busy_calendars: D,
  reassign_product_booking: { ...D, openWorldHint: true, idempotentHint: true },
  get_payment_summary: R,
  list_payments: R,
  get_payment: R,
  get_payment_payouts: R,
  get_payments_usage: R,
  get_payments_dashboard_link: R,
  set_product_booking_config: { ...D, openWorldHint: true },
  delete_product_booking_config: { ...D, openWorldHint: true },
  replace_product_weekly_schedule: { ...D, openWorldHint: true },
  create_product_session: { ...D, openWorldHint: true, idempotentHint: true },
  create_table_reservation: { ...D, openWorldHint: true, idempotentHint: true },
  update_product_session: { ...D, openWorldHint: true },
  create_product_booking: { ...D, openWorldHint: true, idempotentHint: true },
  get_product_booking: R,
  list_product_bookings: R,
  list_product_booking_sessions: R,
  confirm_product_booking: { ...D, openWorldHint: true, idempotentHint: true },
  reject_product_booking: { ...D, openWorldHint: true, idempotentHint: true },
  cancel_product_booking: { ...D, openWorldHint: true, idempotentHint: true },
  request_product_booking_change: { ...D, openWorldHint: true, idempotentHint: true },
  cancel_table_reservation: { ...D, openWorldHint: true, idempotentHint: true },
  request_table_reservation_change: { ...D, openWorldHint: true, idempotentHint: true },
  // Stays are the organization's private records: no guest is emailed and no channel is written.
  list_stays: R,
  get_stay: R,
  get_stay_calendar: R,
  create_stay: { ...W, idempotentHint: true },
  update_stay: D,
  cancel_stay: D,
  record_stay_payment: W,
  delete_stay_payment: D,
  set_stay_nights: { ...D, idempotentHint: true },
  append_content_block: { ...W, openWorldHint: true },
  attach_media: { ...W, openWorldHint: true, idempotentHint: true },
  update_menu: { ...D, openWorldHint: true, idempotentHint: true },
  batch_create_products: { ...W, idempotentHint: true },
  create_blog_post: W,
  create_location: { ...W, openWorldHint: true, idempotentHint: true },
  create_post: W,
  create_product: { ...W, openWorldHint: true, idempotentHint: true },
  create_site_page: { ...W, openWorldHint: true },
  delete_blog_post: { ...D, openWorldHint: true },
  delete_content_block: { ...D, openWorldHint: true },
  delete_media_asset: { ...D, openWorldHint: true },
  delete_post: { ...D, openWorldHint: true },
  delete_product: { ...D, openWorldHint: true },
  delete_resource_localization: { ...D, openWorldHint: true },
  get_blog_post: R,
  list_guest_conversations: R,
  get_guest_conversation: R,
  reply_to_guest: { ...D, openWorldHint: true, idempotentHint: true },
  set_guest_conversation_archived: { ...D, idempotentHint: true },
  get_location: R,
  get_post: R,
  get_product: R,
  list_reservation_inquiries: R,
  get_resource_localization: R,
  get_organization: R,
  get_organization_analytics: R,
  query_organization_analytics: R,
  get_organization_media_assets: R,
  get_organization_settings: R,
  get_site_page: R,
  get_workspace_context: R,
  list_blog_posts: R,
  list_location_products: R,
  list_location_qa: R,
  list_location_reviews: R,
  list_locations: R,
  list_posts: R,
  // Asks Meta whether each saved connection's access still works.
  get_social_connections: R,
  // Reads Meta, and records what the read proves about one publication.
  reconcile_post_publication: D,
  list_channel_posts: R,
  get_channel_post: R,
  delete_channel_post: { ...D, openWorldHint: true },
  list_organization_locales: R,
  list_organization_members: R,
  invite_organization_member: { ...D, openWorldHint: true },
  list_teams: R,
  create_team: W,
  update_team: D,
  set_team_member: D,
  delete_team: D,
  update_organization_member_role: D,
  remove_organization_member: D,
  cancel_organization_invitation: D,
  set_organization_language: { ...D, openWorldHint: true, idempotentHint: true },
  delete_organization_language: { ...D, idempotentHint: true },
  list_organization_qa: R,
  list_organization_reviews: R,
  list_organizations: R,
  list_site_pages: R,
  publish_blog_post: { ...D, openWorldHint: true },
  publish_post: { ...D, openWorldHint: true },
  put_resource_localization: { ...D, openWorldHint: true },
  remove_media: { ...D, openWorldHint: true },
  reorder_media: { ...D, openWorldHint: true },
  replace_content_block: { ...D, openWorldHint: true },
  set_consultation_mode: { ...D, openWorldHint: true },
  set_media: { ...D, openWorldHint: true },
  set_workspace_context: D,
  reconcile_products: { ...D, openWorldHint: true, idempotentHint: true },
  update_blog_post: { ...D, openWorldHint: true },
  update_location: { ...D, openWorldHint: true },
  get_calendar: R,
  block_dates: { ...D, openWorldHint: true },
  open_dates: { ...D, openWorldHint: true },
  update_media_asset: { ...D, openWorldHint: true },
  update_post: { ...D, openWorldHint: true },
  update_product: { ...D, openWorldHint: true },
  update_organization_settings: { ...D, openWorldHint: true },
  update_site_page: { ...D, openWorldHint: true },
  delete_site_page: { ...D, openWorldHint: true },
  save_media_attachment: { ...D, openWorldHint: true, idempotentHint: true },
  list_products: R,
  set_product_publication: { ...D, openWorldHint: true },
  set_product_location: { ...D, openWorldHint: true },
  remove_product_location: { ...D, openWorldHint: true },
  list_collections: R,
  create_collection: { ...W, openWorldHint: true },
  update_collection: { ...D, openWorldHint: true },
  delete_collection: { ...D, openWorldHint: true },
  // Replaces the whole membership list: products left out lose their place in
  // the collection, which is a removal the caller must mean.
  set_collection_products: { ...D, openWorldHint: true },
  reorder_collections: { ...D, openWorldHint: true },
  reorder_blog_posts: { ...D, openWorldHint: true },
  list_article_categories: R,
  create_article_category: W,
  update_article_category: { ...D, openWorldHint: true },
  delete_article_category: D,
  reorder_article_categories: { ...D, openWorldHint: true },
  get_product_catalog_localization: R,
  replace_resource_localizations: { ...D, openWorldHint: true },
  get_reservation_policy: R,
  update_reservation_policy: { ...D, openWorldHint: true },
} as const satisfies Record<string, McpToolAnnotations>

export function buildToolAnnotationsByName() {
  return new Map<string, McpToolAnnotations>(Object.entries(EXPECTED_TOOL_ANNOTATIONS))
}

export const TOOL_ANNOTATIONS_BY_NAME = buildToolAnnotationsByName()

export function validateToolAnnotations(name: string, annotations: McpToolAnnotations): void {
  // ChatGPT Apps submission review requires every tool to declare all three
  // hints explicitly. A future classification that forgets openWorldHint or
  // destructiveHint must fail at module load.
  if (typeof annotations.readOnlyHint !== 'boolean' || typeof annotations.openWorldHint !== 'boolean' || typeof annotations.destructiveHint !== 'boolean') {
    throw new Error(`Tool "${name}" must declare readOnlyHint, openWorldHint and destructiveHint explicitly.`)
  }

  if (annotations.readOnlyHint === true) {
    // openWorldHint is independent of readOnlyHint — a read-only tool (e.g. a
    // web search) can legitimately be open-world. destructiveHint is the one
    // that's genuinely incompatible with read-only: a tool that only reads
    // cannot also delete, overwrite, or otherwise mutate state.
    if (annotations.destructiveHint) {
      throw new Error(`Read-only tool "${name}" cannot declare destructiveHint as true.`)
    }
  }
}

export function withToolAnnotations(definition: RawMcpToolDefinition): McpToolDefinition {
  const annotations = TOOL_ANNOTATIONS_BY_NAME.get(definition.name)
  if (!annotations) {
    throw new Error(`Missing MCP tool annotation classification for "${definition.name}".`)
  }

  validateToolAnnotations(definition.name, annotations)
  const action = definition.name.replaceAll('_', ' ')

  return {
    ...definition,
    title: definition.title?.trim() || action.charAt(0).toUpperCase() + action.slice(1),
    inputSchema: { ...definition.inputSchema, additionalProperties: false },
    securitySchemes: MCP_TOOL_SECURITY_SCHEMES,
    annotations,
  }
}


export { SUPPORTED_CURRENCIES }
