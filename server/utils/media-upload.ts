import { HTTPError } from 'nitro'
import { creationRequestHash, readCreationRecord } from '~/server/utils/organization-events'
// Canonical media-asset creation from resolved bytes for MCP and dashboard uploads.
import { errorChainForTelemetry } from "~/shared/error-telemetry";
import type { DbClient } from "~/server/db";
import { uploadImageBuffer, deleteImage } from "~/server/utils/cloudflare-images";
import { uploadToR2, buildR2Key, deleteFromR2 } from "~/server/utils/cloudflare-r2";
import { executeBatch } from "~/server/db";
import { publicResourceCacheInvalidationQuery } from "~/server/utils/public-resource-cache";
import { assertNotPinnedByPublication, createMediaAsset, getMediaAsset, publicationPinGuardQuery, type MediaAsset } from "~/server/utils/media-asset-manager";
import { fastStartMp4, readMp4Metadata } from "~/server/utils/video-metadata";
import { imagePixelSize, R2_IMAGE_MIME_TYPES } from "~/server/utils/media-mime";

interface UploadResolvedMediaInputBase {
  db: DbClient;
  env: Parameters<typeof uploadImageBuffer>[0];
  organizationId: string;
  buffer: ArrayBuffer | Uint8Array<ArrayBuffer>;
  contentType: string;
  filename: string;
  category?: MediaAsset["category"] | null;
  altText?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  generationKey?: string | null;
  idempotencyKey?: string;
  sourceFileId?: string;
  posterSourceFileId?: string;
}

type UploadResolvedMediaActor =
  | { source: 'generated'; userId: string | null }
  | { source: 'uploaded'; userId: string }
  // Media a provider sync imports has no person behind the request.
  | { source: 'external'; userId: string | null }

export type UploadResolvedMediaInput = UploadResolvedMediaInputBase & UploadResolvedMediaActor & (
  | { kind: 'image'; provider?: 'cloudflare_images' | 'cloudflare_r2'; poster?: never }
  | { kind: 'file'; provider?: 'cloudflare_r2'; poster?: never }
  | {
      kind: 'video'
      provider?: 'cloudflare_r2'
      poster: { buffer: ArrayBuffer | Uint8Array<ArrayBuffer>; contentType: string; filename: string }
    }
)

export type UploadResolvedMediaResult = {
  assetId: string;
  publicUrl: string;
} & (
  | { kind: 'image' | 'file'; thumbnailUrl: string | null }
  | { kind: 'video'; thumbnailUrl: string }
)

interface MediaUploadIdentity {
  organizationId: string; idempotencyKey: string; sourceFileId: string; posterSourceFileId?: string; category?: MediaAsset['category'] | null; altText?: string | null
}

async function uploadCreation(identity: MediaUploadIdentity) {
  const key = identity.idempotencyKey.trim()
  if (!key || key.length > 200 || !identity.sourceFileId) throw new HTTPError({ statusCode: 400, statusMessage: 'A media upload needs its source file ID and idempotency key' })
  return { dedupeKey: `media-upload:${identity.organizationId}:${key}`, requestHash: await creationRequestHash({ file_id: identity.sourceFileId, poster_file_id: identity.posterSourceFileId ?? null, category: identity.category ?? null, alt_text: identity.altText ?? null }) }
}

/** A retry can read the saved asset even after the host’s temporary download URL expires. */
export async function getMediaUploadReplay(db: DbClient, identity: MediaUploadIdentity): Promise<UploadResolvedMediaResult | null> {
  const creation = await uploadCreation(identity)
  const record = await readCreationRecord(db, creation.dedupeKey)
  if (!record) return null
  if (record.requestHash !== creation.requestHash) throw new HTTPError({ statusCode: 409, statusMessage: 'This idempotency key belongs to a different media upload' })
  const asset = await getMediaAsset(db, record.entityId, identity.organizationId)
  return savedUploadResult(asset)
}

function savedUploadResult(asset: MediaAsset | null): UploadResolvedMediaResult {
  if (!asset || asset.status !== 'active' || !asset.public_url) throw new HTTPError({ statusCode: 410, statusMessage: 'The saved asset is no longer available' })
  if (asset.kind === 'video') {
    if (!asset.thumbnail_url) throw new Error('The saved video has no poster image')
    return { assetId: asset.id, publicUrl: asset.public_url, thumbnailUrl: asset.thumbnail_url, kind: 'video' }
  }
  return { assetId: asset.id, publicUrl: asset.public_url, thumbnailUrl: asset.thumbnail_url, kind: asset.kind }
}

/** An uploaded file's name as stored: printable ASCII, no path, at most 120 characters. */
export function sanitizeFilename(raw: string | undefined): string {
  const sanitized = (raw ?? '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^\x20-\x7E]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120)
  return sanitized || 'upload'
}

function uploadFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function uploadResolvedMediaToAssetStore(
  input: UploadResolvedMediaInput,
): Promise<UploadResolvedMediaResult> {
  const identity = input.idempotencyKey ? { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey, sourceFileId: input.sourceFileId ?? '', posterSourceFileId: input.posterSourceFileId, category: input.category, altText: input.altText } : null
  const creation = identity ? await uploadCreation(identity) : undefined
  const earlier = identity ? await getMediaUploadReplay(input.db, identity) : null
  if (earlier) return earlier
  const assetId = creation ? await creationRequestHash({ organization_id: input.organizationId, dedupe_key: creation.dedupeKey, request_hash: creation.requestHash }) : crypto.randomUUID();
  const provider = input.provider ?? (input.kind === "image" && !R2_IMAGE_MIME_TYPES.has(input.contentType) ? "cloudflare_images" : "cloudflare_r2");
  // An MP4 is stored with its header first so a player has its length and size
  // from the first bytes; both are read from that header before anything is
  // stored, so an unreadable file is refused rather than saved without them.
  const mp4 = input.kind === "video" && input.contentType === "video/mp4" ? fastStartMp4(input.buffer) : null;
  const video = mp4 ? readMp4Metadata(mp4) : null;
  const imageSize = input.kind === 'image' ? imagePixelSize(input.buffer instanceof Uint8Array ? input.buffer : new Uint8Array(input.buffer)) : null;

  const r2Key = provider === "cloudflare_r2" ? buildR2Key(input.organizationId, assetId, input.filename) : null;
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  let stage = input.kind === 'video' ? 'poster_upload' : provider === 'cloudflare_images' ? 'image_upload' : 'r2_put';
  let stageStartedAt = startedAt;
  let publicUrl: string;
  let thumbnailUrl: string | null = null;
  let imageId: string | null = null;

  try {
    if (input.kind === 'image' && provider === 'cloudflare_images') {
      const uploaded = await uploadImageBuffer(input.env, input.buffer, input.filename, input.contentType, `media-${assetId}`);
      imageId = uploaded.imageId;
      publicUrl = uploaded.publicUrl;
      thumbnailUrl = uploaded.thumbnailUrl;
      timings[stage] = Date.now() - stageStartedAt;
    } else {
      if (input.kind === 'video') {
        const poster = await uploadImageBuffer(input.env, input.poster.buffer, input.poster.filename, input.poster.contentType, `media-${assetId}-poster`);
        imageId = poster.imageId;
        thumbnailUrl = poster.publicUrl;
        timings[stage] = Date.now() - stageStartedAt;
      }
      stage = 'r2_put';
      stageStartedAt = Date.now();
      publicUrl = await uploadToR2(input.env, r2Key!, mp4 ?? input.buffer, input.contentType);
      timings[stage] = Date.now() - stageStartedAt;
    }

    stage = 'asset_persist';
    stageStartedAt = Date.now();
    await createMediaAsset(input.db, {
      id: assetId,
      organization_id: input.organizationId,
      kind: input.kind,
      provider,
      source: input.source,
      generation_key: input.generationKey ?? null,
      cloudflare_image_id: imageId,
      r2_key: r2Key,
      public_url: publicUrl,
      thumbnail_url: thumbnailUrl,
      mime_type: input.contentType,
      file_name: input.filename,
      file_size: input.fileSize ?? input.buffer.byteLength,
      width: video?.width ?? imageSize?.width ?? input.width ?? null,
      height: video?.height ?? imageSize?.height ?? input.height ?? null,
      duration: video?.duration ?? null,
      alt_text: input.altText ?? null,
      category: input.category ?? null,
      status: "active",
      created_by_user_id: input.userId ?? null,
    }, creation);
    timings[stage] = Date.now() - stageStartedAt;
  } catch (persistError) {
    timings[stage] = Date.now() - stageStartedAt;
    console.error({ event: 'media_upload_failed', asset_id: assetId, organization_id: input.organizationId,
      provider, kind: input.kind, stage, bytes: input.buffer.byteLength,
      duration_ms: Date.now() - startedAt, timings_ms: timings, errors: errorChainForTelemetry(persistError) });
    let concurrentAsset: MediaAsset | null = null;
    let replayError: HTTPError | null = null;
    let safeToCleanup = !creation;
    if (stage === 'asset_persist') {
      let saved: MediaAsset | null;
      let record: Awaited<ReturnType<typeof readCreationRecord>> = null;
      try {
        saved = await getMediaAsset(input.db, assetId, input.organizationId);
        if (!saved && creation) {
          record = await readCreationRecord(input.db, creation.dedupeKey);
          if (record && record.requestHash === creation.requestHash) {
            concurrentAsset = await getMediaAsset(input.db, record.entityId, input.organizationId);
          }
        }
      } catch (readError) {
        // A lost database response does not prove rollback. Keep the provider
        // objects until their ownership can be established from the saved row.
        console.error({ event: 'media_upload_commit_unknown', asset_id: assetId,
          organization_id: input.organizationId, errors: errorChainForTelemetry(readError) });
        throw new AggregateError([uploadFailure(persistError), uploadFailure(readError)],
          `The result of saving media asset ${assetId} could not be read`, { cause: readError });
      }
      if (saved) {
        console.info({ event: 'media_upload_commit_confirmed', asset_id: assetId, organization_id: input.organizationId });
        return savedUploadResult(saved);
      }
      safeToCleanup = !creation || Boolean(record);
      if (record && record.requestHash !== creation!.requestHash) {
        replayError = new HTTPError({ statusCode: 409, statusMessage: 'This idempotency key belongs to a different media upload' });
      } else if (record && !concurrentAsset) {
        replayError = new HTTPError({ statusCode: 410, statusMessage: 'The saved asset is no longer available' });
      }
    }
    if (!safeToCleanup) {
      console.warn({event:'media_upload_pending_retry',asset_id:assetId,organization_id:input.organizationId,stage});
      throw uploadFailure(persistError);
    }
    const cleanupStartedAt = Date.now();
    const cleanupErrors: Error[] = [];
    if (r2Key) {
      try {
        await deleteFromR2(input.env, r2Key);
      } catch (cleanupError) {
        cleanupErrors.push(uploadFailure(cleanupError));
        console.error({ event: 'media_cleanup_failed', asset_id: assetId, stage: 'r2_delete', errors: errorChainForTelemetry(cleanupError) });
      }
    }
    if (imageId) {
      try {
        await deleteImage(input.env, imageId);
      } catch (cleanupError) {
        cleanupErrors.push(uploadFailure(cleanupError));
        console.error({ event: 'media_cleanup_failed', asset_id: assetId, stage: 'image_delete', errors: errorChainForTelemetry(cleanupError) });
      }
    }
    console.info({ event: 'media_cleanup_completed', asset_id: assetId,
      status: cleanupErrors.length ? 'error' : 'success', duration_ms: Date.now() - cleanupStartedAt });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [uploadFailure(persistError), ...cleanupErrors],
        `Media asset ${assetId} could not be stored or cleaned up`, { cause: persistError },
      );
    }
    if (replayError) throw replayError;
    if (concurrentAsset) return savedUploadResult(concurrentAsset);
    throw persistError;
  }
  console.info({ event: 'media_upload_completed', asset_id: assetId, organization_id: input.organizationId,
    provider, kind: input.kind, bytes: input.buffer.byteLength,
    duration_ms: Date.now() - startedAt, timings_ms: timings });

  if (input.kind === 'video') {
    if (!thumbnailUrl) throw new Error(`Video asset ${assetId} did not produce a thumbnail URL`)
    return { assetId, publicUrl, thumbnailUrl, kind: 'video' }
  }
  return { assetId, publicUrl, thumbnailUrl, kind: input.kind };
}

/**
 * Put new bytes behind an existing R2 image asset, keeping the asset itself:
 * its id, so every placement, room, caption and accessibility answer that
 * names it stays as it is. The new file gets its own key and URL (no cached
 * copy of the old one is served for it), the row is switched only while it
 * still names the old file, and the old file is deleted after. A failure
 * before the switch removes the new file; one after it reports the old file
 * left behind.
 */
export async function replaceR2ImageFile(input: {
  db: DbClient
  env: Parameters<typeof uploadToR2>[0]
  organizationId: string
  assetId: string
  buffer: Uint8Array<ArrayBuffer>
  contentType: string
  filename: string
  width: number
  height: number
  /** Called once the asset names the new file, before the old file is deleted, so a caller can act on a switch whose cleanup then fails. */
  onSwitched?: () => void
}): Promise<void> {
  const asset = await getMediaAsset(input.db, input.assetId, input.organizationId)
  if (!asset || asset.status !== 'active' || asset.kind !== 'image' || asset.provider !== 'cloudflare_r2' || !asset.r2_key) {
    throw new HTTPError({ statusCode: 409, statusMessage: `Media asset ${input.assetId} is not an active R2 image`, data: { code: 'MEDIA_NOT_REPLACEABLE', field: 'asset_id' } })
  }
  // A published post shows this exact file; it is not changed under it.
  await assertNotPinnedByPublication(input.db, input.organizationId, input.assetId)
  const key = buildR2Key(input.organizationId, `${input.assetId}-${crypto.randomUUID()}`, input.filename)
  const publicUrl = await uploadToR2(input.env, key, input.buffer, input.contentType)
  let switched: boolean
  try {
    const [, result] = await executeBatch(input.db, [publicationPinGuardQuery(input.organizationId, input.assetId), {
      query: `UPDATE media_assets SET r2_key = ?, public_url = ?, mime_type = ?, file_name = ?, file_size = ?, width = ?, height = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND r2_key = ? AND status = 'active'`,
      params: [key, publicUrl, input.contentType, input.filename, input.buffer.byteLength, input.width, input.height, new Date().toISOString(), input.assetId, input.organizationId, asset.r2_key],
    }, publicResourceCacheInvalidationQuery(input.organizationId, 'media-file-replace')], { operation: 'Replace media file' })
    switched = Number(result?.meta?.changes ?? 0) === 1
  } catch (error) {
    try {
      await deleteFromR2(input.env, key)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Media asset ${input.assetId} kept its file; the new file ${key} could not be deleted`, { cause: cleanupError })
    }
    throw error
  }
  if (!switched) {
    await deleteFromR2(input.env, key)
    throw new HTTPError({ statusCode: 409, statusMessage: `Media asset ${input.assetId} changed while its file was replaced`, data: { code: 'MEDIA_CHANGED', field: 'asset_id' } })
  }
  input.onSwitched?.()
  try {
    await deleteFromR2(input.env, asset.r2_key)
  } catch (error) {
    throw new Error(`Media asset ${input.assetId} now uses ${key}; its previous file ${asset.r2_key} could not be deleted`, { cause: error })
  }
}
