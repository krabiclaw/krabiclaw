import { HTTPError } from 'nitro'
import type { McpToolDefinition } from './shared'
import { chatgptFileInput, mediaAssetObject, mediaPlacementSlotInputSchema, pageInfoObject, paginationInputSchema, resolvedMediaAssetObject, organizationTool } from './shared'
import { EDITABLE_MEDIA_PLACEMENT_OWNERS, WRITABLE_MEDIA_CATEGORIES,
  attachMediaPlacement,
  parseMediaPlacementKey,
  parseMediaPlacementMoves,
  removeMediaPlacement,
  reorderMediaPlacements,
  setSingleMediaPlacement } from '~/server/utils/media-placement'
import { LOGO_SHAPES, parseLogoPresentation } from '~/shared/media-placement-contract'
import { isSingleMediaPlacement, deleteMediaAsset, listMediaAssets, updateMediaAssetMetadata  } from '~/server/utils/media-asset-manager'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import type { McpExecutorContext } from './execution'
import { assertCloudflareImagesConfigured } from '~/server/utils/cloudflare-images'
import { MAX_POSTER_BYTES } from '~/server/utils/media-mime'
import { getMediaUploadReplay, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { MCP_ERROR, mcpProtocolError } from '~/server/utils/mcp-protocol'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { mcpPageInfo, mcpPageWindow } from '~/server/utils/mcp-pagination'
import {
  NOT_HANDLED,
  mutationContextPayload,
  optionalString,
  requiredString,
  resolveUserUploadedMediaFile,
  toolFileReference,
} from './execution'

function mediaPlacementInputSchema(single?: boolean) {
  return {
    type: 'object',
    oneOf: EDITABLE_MEDIA_PLACEMENT_OWNERS.flatMap(ownerType => {
      const slot = mediaPlacementSlotInputSchema(ownerType, { single, excludedFixedSlots: single === true && ownerType === 'organization' ? ['favicon'] : [] })
      return slot ? [{
        type: 'object',
        additionalProperties: false,
        properties: {
          owner_type: { type: 'string', enum: [ownerType] },
          owner_id: { type: 'string' },
          slot,
        },
        required: ['owner_type', 'owner_id', 'slot'],
      }] : []
    }),
  }
}

const mediaPlacementObject = mediaPlacementInputSchema()
const singleMediaPlacementObject = mediaPlacementInputSchema(true)
const orderedMediaPlacementObject = mediaPlacementInputSchema(false)

const mediaMutationOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    entity: { type: 'string' },
    id: { type: 'string' },
    placement: mediaPlacementObject,
    asset_ids: { type: 'array', items: { type: 'string' } },
    media: { type: 'array', items: resolvedMediaAssetObject },
    cleared: { type: 'boolean' },
    context: { type: 'object' },
  },
  required: ['ok', 'entity', 'id', 'placement', 'asset_ids', 'media', 'cleared'],
} as const

export const MEDIA_TOOLS: McpToolDefinition[] = [
  organizationTool({
      name: 'set_media',
      description: 'Assign an asset to one cover, hero, logo or menu section photo; null clears it. Use attach_media for galleries and presentation for logo cropping.',
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: {
        placement: singleMediaPlacementObject,
        asset_id: { type: ['string', 'null'], description: 'One asset id, or null to clear this single-valued placement.' },
        presentation: {
          type: 'object',
          description: 'Organization logo and logo_dark only. Omitted means original.',
          properties: {
            shape: { type: 'string', enum: [...LOGO_SHAPES] },
            focus: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false },
          },
          required: ['shape', 'focus'],
          additionalProperties: false,
        },
      },
      required: ['placement', 'asset_id'],
      outputSchema: mediaMutationOutputSchema,
    }),
  organizationTool({
      name: 'attach_media',
      description: 'Attach one existing media asset to an ordered collection placement (a gallery or a compliance document list), appending it after the current last item. An existing attachment stays in place; a full collection rejects a new attachment. For a single-valued placement (a cover, hero, or logo) use set_media instead.',
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: {
        placement: orderedMediaPlacementObject,
        asset_id: { type: 'string', description: 'The single media asset id to attach.' },
      },
      required: ['placement', 'asset_id'],
      outputSchema: mediaMutationOutputSchema,
    }),
  organizationTool({
      name: 'remove_media',
      description: 'Detach one media asset from an ordered collection placement (a gallery or a compliance document list). Removing an asset that is not attached changes nothing; other attached assets keep their order.',
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: {
        placement: orderedMediaPlacementObject,
        asset_id: { type: 'string', description: 'The single media asset id to detach.' },
      },
      required: ['placement', 'asset_id'],
      outputSchema: mediaMutationOutputSchema,
    }),
  organizationTool({
      name: 'reorder_media',
      description: 'Move attached gallery or compliance assets before or after an attached neighbor. Omitted anchors move the asset to the end; invalid assets or anchors reject the call.',
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: {
        placement: orderedMediaPlacementObject,
        moves: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              asset_id: { type: 'string' },
              before_asset_id: { type: 'string' },
              after_asset_id: { type: 'string' },
            },
            required: ['asset_id'],
          },
          description: 'Ordered list of moves to apply sequentially.',
        },
      },
      required: ['placement', 'moves'],
      outputSchema: mediaMutationOutputSchema,
    }),
  organizationTool({
      name: 'get_organization_media_assets',
      description: 'List the images, videos and Markdown files in the selected site’s media library, with the asset IDs set_media and attach_media take. A file still in the conversation is saved with save_media_attachment.',
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: { kind: { type: 'string', enum: ['image', 'video', 'file'], description: 'Filter by asset type.' }, ...paginationInputSchema },
      outputSchema: {
        type: 'object',
        properties: { assets: { type: 'array', items: mediaAssetObject }, page_info: pageInfoObject },
        required: ['assets', 'page_info'],
      },
    }),
  organizationTool({
      name: 'save_media_attachment',
      description: 'Save an attached image, video with poster, or Markdown file. Uses the host’s file reference. An optional placement puts it on the requested website owner in this operation. Repeat the same idempotency key for a retry.',
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: {
        file: chatgptFileInput,
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
        placement: mediaPlacementObject,
        poster_file: { ...chatgptFileInput, description: 'Required poster/thumbnail image for video uploads. Invalid for non-video uploads.' },
        category: { type: 'string', enum: [...WRITABLE_MEDIA_CATEGORIES], description: 'Optional visual subject used to organize the media library. It never assigns the asset to content.' },
        description: { type: 'string', description: 'Description of the media (stored as alt text).' },
      },
      required: ['file', 'idempotency_key'],
      fileParams: ['file', 'poster_file'],
      outputSchema: {
        type: 'object',
        properties: {
          asset_id: { type: 'string' },
          public_url: { type: 'string' },
          status: { type: 'string', enum: ['active'] },
          thumbnail_url: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['image', 'video', 'file'] },
          placement: { anyOf: [mediaPlacementObject, { type: 'null' }] },
        },
        required: ['asset_id', 'status', 'public_url', 'kind'],
      },
    }),
  organizationTool({
      name: 'update_media_asset',
      description: "Change the selected asset’s alt text or library category. At least one field is required. Category organizes the library and does not assign media to a page.",
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: {
        asset_id: { type: 'string' },
        alt_text: { type: ['string', 'null'], description: 'Omit to retain; null clears the alt text.' },
        category: { type: 'string', enum: [...WRITABLE_MEDIA_CATEGORIES] },
      },
      required: ['asset_id'],
      outputSchema: {
        type: 'object',
        properties: { updated: { type: 'boolean' } },
        required: ['updated'],
      },
    }),
  organizationTool({
      name: 'delete_media_asset',
      description: "Delete the selected site media asset and remove its website placements. Deletes stored media when no other asset references it. Refused while a social publication pins the asset; published provider posts are not deleted.",
      domain: 'media',
      minimumRole: 'admin',
      inputSchema: { asset_id: { type: 'string' } },
      required: ['asset_id'],
      outputSchema: {
        type: 'object',
        properties: { deleted: { type: 'boolean' } },
        required: ['deleted'],
      },
    }),
]

function parsePresentationArg(value: unknown) {
  try {
    return parseLogoPresentation(value)
  } catch (error) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, (error as Error).message)
  }
}

export async function handleMediaTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case "set_media": {
      const placement = parseMediaPlacementKey(args.placement);
      // The favicon is set once, in the dashboard under Brand.
      if (placement.owner_type === 'organization' && placement.slot === 'favicon') {
        throw mcpProtocolError(MCP_ERROR.invalidParams, "The favicon is set in the dashboard under Brand › Favicon, not through MCP.");
      }
      if (args.asset_id !== null && (typeof args.asset_id !== 'string' || !args.asset_id.trim())) {
        throw mcpProtocolError(MCP_ERROR.invalidParams, "asset_id must be a non-empty string or null.");
      }
      const result = await setSingleMediaPlacement(organization.db, {
        env: organization.env,
        organizationId: organization.organizationId,
        principal: memberAccessPrincipal(organization.membership, { env: organization.env }),
        placement,
        assetId: typeof args.asset_id === 'string' ? args.asset_id.trim() : null,
        presentation: args.presentation === undefined ? undefined : parsePresentationArg(args.presentation),
      });
      return renderStructuredResponse(
        {
          ok: true,
          ...result,
          context: await mutationContextPayload(organization),
        },
        result.cleared ? "Cleared media placement." : "Updated media placement.",
      );
    }
    case "attach_media": {
      const placement = parseMediaPlacementKey(args.placement);
      const assetId = requiredString(args, "asset_id");
      const result = await attachMediaPlacement(organization.db, {
        env: organization.env,
        organizationId: organization.organizationId,
        principal: memberAccessPrincipal(organization.membership, { env: organization.env }),
        placement,
        assetId,
      });
      return renderStructuredResponse(
        { ok: true, ...result, context: await mutationContextPayload(organization) },
        "Attached media.",
      );
    }
    case "remove_media": {
      const placement = parseMediaPlacementKey(args.placement);
      const assetId = requiredString(args, "asset_id");
      const result = await removeMediaPlacement(organization.db, {
        env: organization.env,
        organizationId: organization.organizationId,
        principal: memberAccessPrincipal(organization.membership, { env: organization.env }),
        placement,
        assetId,
      });
      return renderStructuredResponse(
        { ok: true, ...result, context: await mutationContextPayload(organization) },
        "Removed media.",
      );
    }
    case "reorder_media": {
      const placement = parseMediaPlacementKey(args.placement);
      const moves = parseMediaPlacementMoves(args.moves);
      const result = await reorderMediaPlacements(organization.db, {
        env: organization.env,
        organizationId: organization.organizationId,
        principal: memberAccessPrincipal(organization.membership, { env: organization.env }),
        placement,
        moves,
      });
      return renderStructuredResponse(
        { ok: true, ...result, context: await mutationContextPayload(organization) },
        "Reordered media.",
      );
    }
    case "get_organization_media_assets": {
      const kind = optionalString(args, "kind") ?? undefined;
      const resource = { resource: `media-assets:${organization.organizationId}:${kind ?? ''}` };
      const window = mcpPageWindow(args, resource);
      const assets = await listMediaAssets(organization.db, organization.organizationId, {
          kind,
          limit: window.limit + 1,
          offset: window.offset,
        });
      const page = assets.slice(0, window.limit);
      return {
        assets: page.map(({ id, ...asset }) => ({ asset_id: id, ...asset })),
        page_info: mcpPageInfo(window, page.length, assets.length > window.limit, resource),
      };
    }
    case "save_media_attachment": {
      const description = optionalString(args, "description") ?? null;
      const category = optionalString(args, "category") ?? null;
      const fileReferenceValue = args.file;
      const fileReference = toolFileReference(fileReferenceValue, "file");
      const posterReference = args.poster_file !== undefined
        ? toolFileReference(args.poster_file, "poster_file")
        : null;

      const identity = { organizationId: organization.organizationId, idempotencyKey: requiredString(args, 'idempotency_key'), sourceFileId: fileReference.file_id, posterSourceFileId: posterReference?.file_id, category: category as import('~/server/utils/media-asset-manager').MediaAsset['category'] | null, altText: description ?? fileReference.file_name ?? fileReference.file_id }
      const saved = await getMediaUploadReplay(organization.db, identity)
      const place = async (uploaded: import('~/server/utils/media-upload').UploadResolvedMediaResult) => {
        const placement = args.placement === undefined ? null : parseMediaPlacementKey(args.placement)
        if (placement) {
          const input = { env: organization.env, organizationId: organization.organizationId, principal: memberAccessPrincipal(organization.membership, { env: organization.env }), placement, assetId: uploaded.assetId }
          if (isSingleMediaPlacement(placement)) await setSingleMediaPlacement(organization.db, input)
          else await attachMediaPlacement(organization.db, input)
        }
        return { asset_id: uploaded.assetId, status: 'active', public_url: uploaded.publicUrl, thumbnail_url: uploaded.thumbnailUrl, kind: uploaded.kind, placement, context: await mutationContextPayload(organization) }
      }
      if (saved) return place(saved)
      const resolved = await resolveUserUploadedMediaFile(fileReference);
      if (posterReference && resolved.kind !== "video") {
        throw mcpProtocolError(
          MCP_ERROR.invalidParams,
          "poster_file is only valid when file is a video.",
        );
      }
      if (resolved.kind === "video" && !posterReference) {
        throw mcpProtocolError(
          MCP_ERROR.invalidParams,
          "Video uploads require poster_file so every video has a thumbnail.",
        );
      }

      let poster: { buffer: Uint8Array<ArrayBuffer>; contentType: string; filename: string } | undefined;
      if (resolved.kind === "video" && posterReference) {
        assertCloudflareImagesConfigured(organization.env)
        const posterResolved = await resolveUserUploadedMediaFile(posterReference, MAX_POSTER_BYTES);
        if (posterResolved.kind !== "image") {
          throw mcpProtocolError(
            MCP_ERROR.invalidParams,
            "Poster must be an image.",
          );
        }
        poster = posterResolved;
      }

      const uploadInput = {
        ...identity,
        db: organization.db,
        env: organization.env as never,
        organizationId: organization.organizationId,
        userId: organization.userId,
        buffer: resolved.buffer,
        contentType: resolved.contentType,
        filename: resolved.filename,
        source: "uploaded",
        category: (category as never) ?? null,
        altText: description ?? fileReference.file_name ?? fileReference.file_id,
      } as const
      let uploaded
      if (resolved.kind === 'video') {
        if (!poster) throw new Error('Resolved video upload did not include its required thumbnail')
        uploaded = await uploadResolvedMediaToAssetStore({
          ...uploadInput,
          kind: 'video',
          provider: 'cloudflare_r2',
          poster,
        })
      } else if (resolved.kind === 'image') {
        uploaded = await uploadResolvedMediaToAssetStore({
          ...uploadInput,
          kind: 'image',
        })
      } else {
        uploaded = await uploadResolvedMediaToAssetStore({
          ...uploadInput,
          kind: 'file',
          provider: 'cloudflare_r2',
        })
      }

      return place(uploaded)
    }
    case "update_media_asset": {
      if (!Object.hasOwn(args, 'alt_text') && !Object.hasOwn(args, 'category')) {
        throw new HTTPError({ statusCode: 400, statusMessage: 'Provide alt_text or category' });
      }
      const updated = await updateMediaAssetMetadata(
        organization.db,
        requiredString(args, "asset_id"),
        organization.organizationId,
        {
          ...(Object.hasOwn(args, 'alt_text') ? { alt_text: args.alt_text as string | null } : {}),
          ...(Object.hasOwn(args, 'category') ? { category: args.category as typeof WRITABLE_MEDIA_CATEGORIES[number] } : {}),
        },
      );
      if (!updated) {
        throw new HTTPError({ statusCode: 404, statusMessage: 'Media asset not found' });
      }
      return {
        updated,
        context: await mutationContextPayload(organization),
      };
    }
    case "delete_media_asset": {
      const context = await mutationContextPayload(organization);
      await deleteMediaAsset(
        organization.db,
        organization.env,
        requiredString(args, "asset_id"),
        organization.organizationId,
        organization.userId,
      );
      return { deleted: true, context };
    }
    default:
      return NOT_HANDLED
  }
}
