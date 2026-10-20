import { getSourceLocale } from '~/server/utils/organization-locales'
import { CONTENT_BLOCK_TYPES } from '~/shared/content-registries'
import { pageEditorPath } from '~/server/utils/dashboard-links'
import type { McpToolDefinition } from './shared'
import { contentBlockDataInputSchema, contentBlockMediaInputRef, contentBlockObject, contentBlockTypeBranches, contentBlockUpdatedAtInput, locationReservationConfigObject, locationReservationConfigWriteSchema, pageInfoObject, paginationInputSchema, renderedBookingPolicySummaryObject, organizationTool } from './shared'
import { HTTPError } from 'nitro';
import { CANCELLATION_TIER_IDS, cancellationPatch, cancellationTierOf, type CancellationTierId } from "~/shared/availability-settings";
import type { McpExecutorContext } from './execution'
import {
  DEFAULT_RESERVATION_DURATION_MINUTES,
  requireLocationReservationConfig,
  renderBookingPolicySummary,
  reservationPolicySummarySource,
  upsertLocationReservationConfig,
  validateLocationReservationConfigPatch,
} from '~/server/utils/reservations'
import {
  createTenantPage,
  deleteTenantPage,
  getTenantPageById,
  listTenantPages,
  updateTenantPage,
} from '~/server/utils/content/pages'
import {
  appendContentBlock,
  deleteContentBlock,
  getContentBlock,
  getContentDocumentById,
  getContentOutline,
  replaceContentBlock,
  type ContentBlockMedia,
  type ContentBlockType,
} from '~/server/utils/content/documents'
import { prepareTenantBlogContentBlocks } from '~/server/utils/content/publishing'
import { executeBatch, queryFirst } from '~/server/db'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { refreshSocialCard } from '~/server/utils/social-card'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { NOT_HANDLED, omit, mutationContextPayload, optionalString, requiredString, rethrowAsInvalidParams } from './execution'

// Page writes provide complete required metadata; omitted optional values retain
// their stored values on update.
export const TENANT_PAGE_METADATA_SCHEMA = {
  path: { type: 'string', description: 'The page path to write. Send the current path unless you are moving the page; a different path moves it and creates the locale-scoped redirect.' },
  title: { type: 'string', description: 'The page title to write. Always sent in full — an omitted title is not kept.' },
  summary: { type: ['string', 'null'], description: 'Omit to preserve on update; null clears it.' },
  pageType: { type: 'string', enum: ['custom', 'recipe', 'legal', 'system'], description: "The page's type. Send the page_type from the last read unless you are changing it." },
  recipe: { type: ['string', 'null'], description: 'The template section this page fills, or null for a page that fills none. Send the recipe from the last read unless you are changing it; an omitted recipe is not kept.' },
  sortOrder: { type: 'number', description: "The page's position in the site's page list. Send the sort_order from the last read unless you are reordering." },
}

const TENANT_PAGE_BLOCK_PROPERTIES = {
  id: { type: 'string' },
  type: { type: 'string', enum: [...CONTENT_BLOCK_TYPES] },
  source_block_id: { type: ['string', 'null'] },
  parent_block_id: { type: ['string', 'null'] },
  level: { type: ['integer', 'null'], minimum: 1, maximum: 6 },
  data: contentBlockDataInputSchema,
  media: { type: 'array', items: contentBlockMediaInputRef },
  updated_at: contentBlockUpdatedAtInput,
}

export const TENANT_PAGE_BLOCKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: TENANT_PAGE_BLOCK_PROPERTIES,
    required: ['type', 'data'],
    additionalProperties: false,
    anyOf: contentBlockTypeBranches({ properties: TENANT_PAGE_BLOCK_PROPERTIES, required: ['type', 'data'], additionalProperties: false }),
  },
  description: 'Complete canonical block array. Each existing block must retain its id unless its removal is explicitly confirmed. Block data never contains asset IDs or delivery URLs. Omit media to preserve that block\'s current placements; provide media explicitly to replace them, or call set_media with owner_type "content_block", the block id, and the intended slot.',
}

// One block, addressed by id, on any content document: a blog article, a tenant
// page variant, a doc. Where it sits is a relationship to a neighbour, so an
// insert names the block it follows and nothing states a position. The whole
// document write (update_blog_post, update_site_page) is for rewriting an
// article; these are for changing one thing in it.
const CONTENT_BLOCK_WRITE_SCHEMA = {
  type: { type: 'string', enum: [...CONTENT_BLOCK_TYPES] },
  data: contentBlockDataInputSchema,
  media: { type: 'array', items: contentBlockMediaInputRef, description: 'Required on image blocks: one item, the picture. Send a block\'s media as a read returned it.' },
  level: { type: ['integer', 'null'], minimum: 1, maximum: 6, description: 'Heading blocks only.' },
}

const APPEND_CONTENT_BLOCK_PROPERTIES = {
  document_id: { type: 'string', description: 'The blog post id or site page variant id.' },
  after_block_id: { type: ['string', 'null'], description: 'The block this one follows. Omit to append at the end.' },
  ...CONTENT_BLOCK_WRITE_SCHEMA,
}
const APPEND_CONTENT_BLOCK_REQUIRED = ['document_id', 'type', 'data']

const CONTENT_BLOCKS_OUTPUT = {
  type: 'object',
  properties: {
    document_id: { type: 'string' },
    updated_at: { type: 'string', description: 'The document\'s new concurrency token.' },
    blocks: { type: 'array', items: contentBlockObject, description: 'Changed blocks with IDs and timestamps; empty after deletion.' },
  },
  required: ['document_id', 'updated_at', 'blocks'],
  additionalProperties: false,
}

const TENANT_PAGE_LIFECYCLE_OUTPUT = {
  type: 'object',
  properties: {
    page: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        page_id: { type: 'string', minLength: 1 },
        organization_id: { type: 'string', minLength: 1 },
        product_id: { type: ['string', 'null'] },
        locale: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        title: { type: 'string' },
        summary: { type: ['string', 'null'] },
        page_type: { type: 'string', enum: ['custom', 'recipe', 'legal', 'system'] },
        recipe: { type: ['string', 'null'] },
        sort_order: { type: 'number' },
        updated_at: { type: 'string', minLength: 1 },
        blocks: { type: 'array', items: contentBlockObject },
        document: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, updated_at: { type: 'string', minLength: 1 } }, required: ['id', 'updated_at'] },
        admin_edit_url: { type: ['string', 'null'] },
      },
      required: ['id', 'page_id', 'organization_id', 'product_id', 'locale', 'path', 'title', 'summary', 'page_type', 'recipe', 'sort_order', 'updated_at', 'blocks', 'document', 'admin_edit_url'],
    },
  },
  required: ['page'],
}

export const CONTENT_TOOLS: McpToolDefinition[] = [
  organizationTool({
      name: 'append_content_block',
      description: 'Add a block to an existing article or site page, returning the changed block and document timestamp. An image in the first article block becomes its cover.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: APPEND_CONTENT_BLOCK_PROPERTIES,
      required: APPEND_CONTENT_BLOCK_REQUIRED,
      outputSchema: CONTENT_BLOCKS_OUTPUT,
    }),
  organizationTool({
      name: 'replace_content_block',
      description: 'Replace one block’s complete data, keeping its ID and position; published content changes immediately. Read it first and preserve content outside the requested change; returns the changed block and document timestamp.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        block_id: { type: 'string' },
        expected_updated_at: { type: 'string', description: 'The block\'s updated_at from the last read.' },
        data: { ...CONTENT_BLOCK_WRITE_SCHEMA.data, description: 'Complete replacement data; omitted fields are removed.' },
        media: { ...CONTENT_BLOCK_WRITE_SCHEMA.media, description: 'Omit to retain existing placements; supply the complete array to replace them.' },
      },
      required: ['block_id', 'expected_updated_at', 'data'],
      outputSchema: CONTENT_BLOCKS_OUTPUT,
    }),
  organizationTool({
      name: 'delete_content_block',
      description: 'Permanently delete one block and its descendants from an article or site page; published content changes immediately. Returns the document timestamp and no blocks.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        block_id: { type: 'string' },
        expected_updated_at: { type: 'string', description: 'The block\'s updated_at from the last read.' },
      },
      required: ['block_id', 'expected_updated_at'],
      outputSchema: CONTENT_BLOCKS_OUTPUT,
    }),
  organizationTool({
      name: 'list_site_pages',
      description: "List authored pages and built-in public routes. Catalog routes display published products; they do not require custom page creation.",
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: { locale: { type: ['string', 'null'] }, ...paginationInputSchema },
      outputSchema: {
        type: 'object',
        properties: {
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 }, page_id: { type: 'string', minLength: 1 },
                locale: { type: 'string', minLength: 1 }, path: { type: 'string' }, title: { type: 'string' },
                page_type: { type: 'string', enum: ['custom', 'recipe', 'legal', 'system'] },
                recipe: { type: ['string', 'null'] }, sort_order: { type: 'number' },
                updated_at: { type: 'string', minLength: 1 }, product_id: { type: ['string', 'null'] },
                removable: { type: 'boolean' }, admin_edit_url: { type: ['string', 'null'] },
              },
              required: ['id', 'page_id', 'locale', 'path', 'title', 'page_type', 'recipe', 'sort_order', 'updated_at', 'product_id', 'removable', 'admin_edit_url'],
              additionalProperties: false,
            },
          },
          built_in_pages: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, recipe: { type: ['string', 'null'] }, public_url: { type: ['string', 'null'] } }, required: ['path', 'recipe', 'public_url'] } },
          page_info: pageInfoObject,
        },
        required: ['pages', 'built_in_pages', 'page_info'],
      },
    }),
  organizationTool({
      name: 'get_site_page',
      description: "Read one site-page language variant, including its path, title, ordered blocks and current timestamp. Use its returned IDs and concurrency information for edits.",
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: { variant_id: { type: 'string' } },
      required: ['variant_id'],
      outputSchema: TENANT_PAGE_LIFECYCLE_OUTPUT,
    }),
  organizationTool({
      name: 'create_site_page',
      description: "Create an authored site page in the named language, returning its document, blocks and editor information. A secondary language must name an existing source page. Supply the actual content for that language; no translation is generated. Pages on a live site can become public immediately; blog articles and short announcements use their own tools.",
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        page_id: { type: ['string', 'null'] },
        variant_id: { type: ['string', 'null'] },
        locale: { type: ['string', 'null'] },
        ...TENANT_PAGE_METADATA_SCHEMA,
        blocks: TENANT_PAGE_BLOCKS_SCHEMA,
      },
      required: ['path', 'title', 'blocks'],
      outputSchema: TENANT_PAGE_LIFECYCLE_OUTPUT,
    }),
  organizationTool({
      name: 'update_site_page',
      description: 'Replace a page’s metadata and complete ordered blocks using its current timestamp. Omitted summary and product binding retain their values; removing blocks requires their exact IDs.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        variant_id: { type: 'string' },
        product_id: { type: ['string', 'null'], description: 'Explicit canonical Product binding on the source page only. Omit to retain; null unbinds. Translations inherit the source binding; slugs never imply a relationship.' },
        expected_updated_at: { type: 'string' },
        ...TENANT_PAGE_METADATA_SCHEMA,
        blocks: TENANT_PAGE_BLOCKS_SCHEMA,
        removed_block_ids: { type: 'array', items: { type: 'string' }, description: 'Exact existing block IDs omitted from the replacement; omit when none are removed.' },
      },
      required: ['variant_id', 'expected_updated_at', 'path', 'title', 'pageType', 'recipe', 'sortOrder', 'blocks'],
      outputSchema: TENANT_PAGE_LIFECYCLE_OUTPUT,
    }),
  organizationTool({
      name: 'delete_site_page',
      description: 'Delete the selected site page or translation. Deleting a translation removes that translation; deleting the source locale removes the page and every translation with it, and the response names the locales that went. A page the site template renders cannot be deleted, because its route would then have nothing to show.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        variant_id: { type: 'string' },
        expected_updated_at: { type: 'string', description: 'The document timestamp from the last read, so a page edited since is refused rather than silently removed.' },
      },
      required: ['variant_id', 'expected_updated_at'],
      outputSchema: {
        type: 'object',
        properties: {
          deleted: {
            type: 'object',
            properties: {
              id: { type: 'string' }, path: { type: 'string' }, locale: { type: 'string' },
              removed_locales: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'path', 'locale', 'removed_locales'],
          },
        },
        required: ['deleted'],
      },
    }),
  organizationTool({
      name: 'get_reservation_policy',
      description: 'Read one location’s table reservation settings and guest-facing policy summary. Product session bookings use get_product for their separate configuration.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        location_id: { type: 'string' },
        locale: { type: 'string' },
      },
      required: ['location_id'],
      outputSchema: {
        type: 'object',
        properties: {
          policy: locationReservationConfigObject,
          cancellation_policy: { type: ['string', 'null'], enum: [...CANCELLATION_TIER_IDS, null], description: 'The named cancellation policy the dashboard shows, or null when the stored cutoffs match none of them.' },
          summary: renderedBookingPolicySummaryObject,
        },
        required: ['policy', 'cancellation_policy', 'summary'],
      },
    }),
  organizationTool({
      name: 'update_reservation_policy',
      description: 'Enable or update table reservations using the location’s saved hours. New setup defaults to two hours, unlimited capacity, no advance notice and no deposit. Use the current updated_at when amending it; omitted fields keep their value. Deposits need an amount, currency, tax treatment and ready Payments.',
      domain: 'content',
      minimumRole: 'admin',
      inputSchema: {
        expected_updated_at: { type: ["string", "null"], description: "Current policy updated_at; null when creating." },
        location_id: { type: 'string' },
        locale: { type: 'string' },
        ...locationReservationConfigWriteSchema,
        duration_minutes: { ...locationReservationConfigWriteSchema.duration_minutes, default: DEFAULT_RESERVATION_DURATION_MINUTES, description: 'Minutes per reservation. Defaults to 120 on setup; null restores that default. Omit to keep the current duration.' },
        slot_capacity: { ...locationReservationConfigWriteSchema.slot_capacity, description: 'Guests per start time. Defaults to unlimited on setup; null removes the limit.' },
        advance_notice_minutes: { ...locationReservationConfigWriteSchema.advance_notice_minutes, description: 'Required notice before the start. Defaults to zero on setup; null removes the rule.' },
        deposit_required: { ...locationReservationConfigWriteSchema.deposit_required, description: 'Defaults to false on setup. Omit to keep the current requirement.' },
        cancellation_policy: { type: 'string', enum: CANCELLATION_TIER_IDS, description: 'Flexible: 2 hours. Moderate: 1 day. Firm: 2 days. Sets the deposit-refund and reschedule cutoffs together; do not also pass those fields.' },
      },
      required: ['location_id', 'expected_updated_at'],
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          entity: { type: 'string', enum: ['reservation_policy'] },
          location_id: { type: 'string' },
          changed_fields: { type: 'array', items: { type: 'string' } },
          updated_at: { type: 'string' },
          context: { type: 'object' },
          summary: renderedBookingPolicySummaryObject,
        },
        required: ['ok', 'entity', 'location_id'],
      },
    }),
]

function nullableStringArg(args: Record<string, unknown>, key: string, fallback: string | null): string | null {
  if (!Object.prototype.hasOwnProperty.call(args, key)) return fallback
  const value = args[key]
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${key} must be a string or null`)
  return value.trim()
}

// Required, but legitimately null: a page that fills no template section has no
// recipe. The caller must say which, rather than omitting the key and having the
// stored row read back in.
function requiredNullableString(args: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`${key} is required, and may be null`)
  const value = args[key]
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${key} must be a string or null`)
  return value.trim()
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

/** A block as MCP reads it: where it sits is its index in the array, so no position. */
function withoutPosition<T extends { position?: number }>(block: T): Omit<T, 'position'> {
  const { position: _position, ...rest } = block
  return rest
}

/** The dashboard editor for a page: a page a Product owns opens as that Product's Page content. */
function pageEditUrl(organizationSlug: string | undefined, page: { id: string; product_id?: string | null }): string | null {
  return organizationSlug ? pageEditorPath(organizationSlug, { id: page.id }) : null
}

function tenantPageLifecycleResponse(action: string, result: unknown, organizationSlug?: string) {
  const page = result && typeof result === 'object' && 'page' in result && result.page && typeof result.page === 'object' && Array.isArray((result.page as { blocks?: unknown }).blocks)
    ? { ...result, page: { ...(result.page as object), admin_edit_url: pageEditUrl(organizationSlug, result.page as { id: string; product_id?: string | null }), blocks: ((result.page as { blocks: Array<{ position?: number }> }).blocks).map(withoutPosition) } }
    : result && typeof result === 'object' && Array.isArray((result as { blocks?: unknown }).blocks)
      ? { ...result, blocks: ((result as { blocks: Array<{ position?: number }> }).blocks).map(withoutPosition) }
      : result
  return renderStructuredResponse(page, `${action} tenant page.`, { tenant_page: page })
}

function assertTenantPageRemovedBlockIds(
  page: Awaited<ReturnType<typeof getTenantPageById>>,
  args: Record<string, unknown>,
) {
  if (!Array.isArray(args.blocks)) throw new Error('blocks must be the complete canonical block array')
  const incomingBlockIds = new Set(
    args.blocks
      .map(block => block && typeof block === 'object' && 'id' in block && typeof (block as { id?: unknown }).id === 'string'
        ? (block as { id: string }).id
        : null)
      .filter((id): id is string => Boolean(id)),
  )
  const removedBlockIds = page.blocks.map(block => block.id).filter(id => !incomingBlockIds.has(id)).sort()
  const requestedRemovedIds = Array.isArray(args.removed_block_ids)
    ? args.removed_block_ids.filter((id): id is string => typeof id === 'string').sort()
    : []
  if (requestedRemovedIds.length !== removedBlockIds.length || requestedRemovedIds.some((id, index) => id !== removedBlockIds[index])) {
    throw new HTTPError({
      statusCode: 409,
      statusMessage: 'removed_block_ids must exactly match the blocks removed from the page',
      data: { removed_block_ids: removedBlockIds },
    })
  }
}

/**
 * The document a block operation addresses, and only if it is this site's. A
 * block id from another site is not found here rather than forbidden: the
 * caller learns nothing about what exists elsewhere.
 */
async function requireOrganizationDocument(ctx: McpExecutorContext, documentId: string) {
  const document = await getContentDocumentById(ctx.organization.db, documentId)
  if (!document || document.organization_id !== ctx.organization.organizationId) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Content document not found' })
  }
  return document
}

/**
 * After a block changed: the public copy is stale, an article's social card may
 * be, and the receipt contains only the changed block and document timestamp.
 */
async function contentBlocksChanged(ctx: McpExecutorContext, document: { id: string; kind: string }, changedBlockId: string | null, message: string) {
  const { organization } = ctx
  await executeBatch(organization.db, [publicResourceCacheInvalidationQuery(organization.organizationId, `${document.kind}-block-write`)])
  if (document.kind === 'article' && organization.env) {
    await refreshSocialCard({ db: organization.db, env: organization.env, owner: { owner_type: 'content_document', owner_id: document.id } })
  }
  const current = await getContentDocumentById(organization.db, document.id)
  if (!current) throw new HTTPError({ statusCode: 500, statusMessage: 'Content document disappeared after write' })
  const blocks = changedBlockId
    ? (await getContentOutline(organization.db, document.id)).filter(block => block.id === changedBlockId).map(withoutPosition)
    : []
  if (changedBlockId && blocks.length !== 1) throw new HTTPError({ statusCode: 500, statusMessage: 'Changed content block is missing after write' })
  return renderStructuredResponse(
    { document_id: document.id, updated_at: current.updated_at, blocks },
    message,
  )
}

export async function handleContentTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case "list_site_pages":
      try {
        const pages = await listTenantPages(organization.db, organization.organizationId, { locale: optionalString(args, "locale") });
        const page = paginateMcpCollection(pages, args, { resource: `tenant-pages:${organization.organizationId}:${optionalString(args, 'locale') ?? ''}` });
        const site = await queryFirst<{ vertical: string; theme_id: string }>(organization.db, 'SELECT vertical, theme_id FROM organization WHERE id = ?', [organization.organizationId]);
        if (!site) throw new HTTPError({ statusCode: 404, message: 'Organization not found' });
        const template = resolvePublicTemplate({ vertical: site.vertical, themeId: site.theme_id });
        const paths = new Set([...template.sitemap.exactPaths, ...Object.values(template.pageDocuments.recipes)]);
        const built_in_pages = [...paths].map(path => ({ path, recipe: Object.entries(template.pageDocuments.recipes).find(([, value]) => value === path)?.[0] ?? null, public_url: organization.publicUrl ? new URL(path, organization.publicUrl).toString() : null }));
        return { built_in_pages, pages: page.items.map(row => ({ ...row, admin_edit_url: pageEditUrl(organization.organizationSlug, row) })), page_info: page.page_info };
      } catch (error) {
        return rethrowAsInvalidParams(error);
      }
    case "get_site_page":
      try {
        const page = await getTenantPageById(organization.db, requiredString(args, "variant_id"), {
          organizationId: organization.organizationId,
        })
        return tenantPageLifecycleResponse("Read", {
          page,
        }, organization.organizationSlug);
      } catch (error) {
        return rethrowAsInvalidParams(error);
      }
    case "create_site_page":
      try {
        const created = await createTenantPage(organization.db, {
          organizationId: organization.organizationId,
          userId: organization.userId,
          data: {
            id: optionalString(args, "variant_id") ?? undefined,
            pageId: optionalString(args, "page_id") ?? undefined,
            locale: optionalString(args, "locale") ?? undefined,
            path: requiredString(args, "path"),
            title: requiredString(args, "title"),
            summary: nullableStringArg(args, "summary", null),
            // Omitted is omitted: a translation takes its identity from the
            // source page, and a null here would be read as stating a
            // different one.
            pageType: (optionalString(args, "pageType") ?? undefined) as "custom" | "recipe" | "legal" | "system" | undefined,
            recipe: nullableStringArg(args, "recipe", null),
            sortOrder: typeof args.sortOrder === 'number' ? args.sortOrder : null,
            blocks: args.blocks,
          },
          env: organization.env,
        });
        return tenantPageLifecycleResponse("Created", created, organization.organizationSlug);
      } catch (error) {
        return rethrowAsInvalidParams(error);
      }
    case "update_site_page":
      try {
        const variantId = requiredString(args, "variant_id");
        const page = await getTenantPageById(organization.db, variantId, {
          organizationId: organization.organizationId,
        });
        assertTenantPageRemovedBlockIds(page, args)
        const updated = await updateTenantPage(organization.db, variantId, {
          userId: organization.userId,
          scope: { organizationId: organization.organizationId},
          data: {
            productId: args.product_id === undefined ? undefined : requiredNullableString(args, "product_id"),
            path: requiredString(args, "path"),
            title: requiredString(args, "title"),
            summary: args.summary === undefined ? page.summary : nullableStringArg(args, "summary", null),
            pageType: requiredString(args, "pageType") as "custom" | "recipe" | "legal" | "system",
            recipe: requiredNullableString(args, "recipe"),
            sortOrder: requiredNumber(args, "sortOrder"),
            blocks: args.blocks,
            expectedUpdatedAt: requiredString(args, "expected_updated_at"),
          },
          env: organization.env,
        });
        return tenantPageLifecycleResponse("Updated", updated, organization.organizationSlug);
      } catch (error) {
        return rethrowAsInvalidParams(error);
      }
    case "delete_site_page":
      try {
        const deleted = await deleteTenantPage(organization.db, requiredString(args, "variant_id"), {
          scope: { organizationId: organization.organizationId},
          expectedUpdatedAt: requiredString(args, "expected_updated_at"),
          env: organization.env,
        });
        return tenantPageLifecycleResponse("Deleted", deleted, organization.organizationSlug);
      } catch (error) {
        return rethrowAsInvalidParams(error);
      }
    case "get_reservation_policy": {
      const locationId = requiredString(args, "location_id");
      const locale = optionalString(args, "locale") ?? await getSourceLocale(organization.db, organization.organizationId);
      const config = await requireLocationReservationConfig(organization.db, {
        organizationId: organization.organizationId,
        locationId,
      });
      return {
        policy: config,
        cancellation_policy: cancellationTierOf(config),
        summary: renderBookingPolicySummary(reservationPolicySummarySource(config), locale),
      };
    }
    case "update_reservation_policy": {
      const locationId = requiredString(args, "location_id");
      const locale = optionalString(args, "locale") ?? await getSourceLocale(organization.db, organization.organizationId);
      // A named policy is its two cutoffs, written as the dashboard writes them.
      const tier = args.cancellation_policy;
      if (tier !== undefined && !CANCELLATION_TIER_IDS.includes(tier as CancellationTierId)) {
        throw new Error(`cancellation_policy must be one of ${CANCELLATION_TIER_IDS.join(", ")}`);
      }
      if (tier !== undefined && ["free_cancellation_until_minutes", "reschedule_allowed", "reschedule_cutoff_minutes"].some((field) => field in args)) {
        throw new Error("Pass cancellation_policy or the cancellation cutoffs, not both");
      }
      const patch = await validateLocationReservationConfigPatch({
        ...omit(args as Record<string, unknown>, ["location_id", "locale", "cancellation_policy", "expected_updated_at"]),
        ...(tier === undefined ? {} : cancellationPatch(tier as CancellationTierId)),
      });
      const config = await upsertLocationReservationConfig(organization.db, {
        organizationId: organization.organizationId,
        locationId,
        patch,
        actorId: organization.userId, env: organization.env, expectedUpdatedAt: optionalString(args, "expected_updated_at"),
      });
      const policyContext = await mutationContextPayload(organization, { locationId });
      return renderStructuredResponse(
        {
          ok: true,
          entity: "reservation_policy",
          location_id: locationId,
          changed_fields: Object.keys(patch),
          updated_at: config.updated_at,
          context: policyContext,
          summary: renderBookingPolicySummary(reservationPolicySummarySource(config), locale),
        },
        "Updated the reservation policy.",
        { policy: config },
      );
    }
    case "append_content_block": {
      const document = await requireOrganizationDocument(ctx, requiredString(args, "document_id"))
      const afterBlockId = optionalString(args, "after_block_id")
      const id = crypto.randomUUID()
      // The same normalisation every whole-document write goes through: the
      // asset must be this site's, an image block must carry its picture.
      const { blocks, placementQueries } = await prepareTenantBlogContentBlocks(
        organization.db, [{ id, type: args.type as ContentBlockType, data: args.data as Record<string, unknown>, media: args.media as ContentBlockMedia[] | undefined, level: typeof args.level === 'number' ? args.level : null }],
        organization.organizationId,
      )
      const block = blocks[0]!
      // One batch: the block and its media land together or not at all.
      await appendContentBlock(organization.db, document.id, { id, type: block.type, data: block.data, level: block.level ?? null, after_block_id: afterBlockId ?? null }, { additionalQueriesAfter: placementQueries })
      return await contentBlocksChanged(ctx, document, id, `Added a ${block.type} block.`)
    }
    case "replace_content_block": {
      const blockId = requiredString(args, "block_id")
      const existing = await getContentBlock(organization.db, blockId)
      const document = await requireOrganizationDocument(ctx, existing.document_id)
      const { blocks, placementQueries } = await prepareTenantBlogContentBlocks(
        organization.db, [{ id: blockId, type: existing.type, data: args.data as Record<string, unknown>, media: (args.media ?? existing.media) as ContentBlockMedia[], level: existing.level }],
        organization.organizationId,
      )
      await replaceContentBlock(organization.db, blockId, { data: blocks[0]!.data, expected_updated_at: requiredString(args, "expected_updated_at") }, { additionalQueriesAfter: placementQueries })
      return await contentBlocksChanged(ctx, document, blockId, `Replaced the ${existing.type} block.`)
    }
    case "delete_content_block": {
      const blockId = requiredString(args, "block_id")
      const existing = await getContentBlock(organization.db, blockId)
      const document = await requireOrganizationDocument(ctx, existing.document_id)
      await deleteContentBlock(organization.db, blockId, { expected_updated_at: requiredString(args, "expected_updated_at") })
      return await contentBlocksChanged(ctx, document, null, `Deleted the ${existing.type} block.`)
    }
    default:
      return NOT_HANDLED
  }
}
