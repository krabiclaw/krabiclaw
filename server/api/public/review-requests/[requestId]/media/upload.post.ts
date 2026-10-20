import { REVIEW_VIDEO_MAX_BYTES, REVIEW_VIDEO_MAX_LABEL } from '~/config/media-limits'
import { cleanString, cloudflareEnv, jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { executeBatch, queryFirst } from '~/server/db'
import { buildMediaPlacementInsertQuery, deleteMediaAsset } from '~/server/utils/media-asset-manager'
import { uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { sniffMediaMimeType, VIDEO_MIME_TYPES, POSTER_IMAGE_MIME_TYPES, MAX_POSTER_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { getReviewRequestByToken } from '~/server/utils/review-requests'

const MULTIPART_OVERHEAD_BYTES = 64 * 1024

function sanitizeFilename(raw: string): string {
  const sanitized = raw
    .replace(/[\\/]+/g, '-')
    .replace(/[^\x20-\x7E]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120)
  return sanitized || 'review-media'
}

export default defineHandler(async (event) => {
  try {
    const requestId = getRouterParam(event, 'requestId')
    if (!requestId) return jsonResponse({ error: 'requestId required' }, { status: 400 })

    const env = cloudflareEnv(event)
    const db = env.DB
    if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

    const token = cleanString(event.req.headers.get('x-review-token'), 300)
    if (!token) return jsonResponse({ error: 'Token required' }, { status: 400 })

    const result = await getReviewRequestByToken(db, token)
    if (!result || result.request.id !== requestId) return jsonResponse({ error: 'Review request not found or expired' }, { status: 404 })
    // The token was minted for the booking's user; the upload is theirs.
    const uploaderUserId = result.request.user_id
    if (!uploaderUserId) return jsonResponse({ error: 'This review request is not linked to a guest' }, { status: 409 })

    const existingMedia = await queryFirst<{ images: number; videos: number; next_sort_order: number }>(db, `
      SELECT
        COUNT(CASE WHEN ma.kind = 'image' AND mp.status != 'rejected' THEN 1 END) AS images,
        COUNT(CASE WHEN ma.kind = 'video' AND mp.status != 'rejected' THEN 1 END) AS videos,
        COALESCE(MAX(mp.sort_order) + 1, 0) AS next_sort_order
      FROM media_placements mp
      JOIN media_assets ma ON ma.id = mp.asset_id
      WHERE mp.owner_type = 'review_request' AND mp.owner_id = ?
    `, [requestId])

    const contentLengthHeader = event.req.headers.get('content-length')
    const contentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : contentLengthHeader ? Number.NaN : null
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength <= 0)) {
      return jsonResponse({ error: 'Invalid Content-Length header' }, { status: 400 })
    }
    if (contentLength !== null && contentLength > REVIEW_VIDEO_MAX_BYTES + MAX_POSTER_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return jsonResponse({ error: `Videos must be ${REVIEW_VIDEO_MAX_LABEL} or smaller.` }, { status: 413 })
    }

    // A photo is one `image` part; a video is `video` plus the `thumbnail` the
    // page renders from it. Both go through the one canonical asset store and
    // arrive active in this request.
    const formData = await event.req.formData()
    const imagePart = formData.get('image')
    const videoPart = formData.get('video')
    const thumbnailPart = formData.get('thumbnail')

    let uploaded: Awaited<ReturnType<typeof uploadResolvedMediaToAssetStore>>
    if (imagePart instanceof File) {
      if (Number(existingMedia?.images ?? 0) >= 5) return jsonResponse({ error: 'You can upload up to 5 photos.' }, { status: 400 })
      if (imagePart.size > MAX_IMAGE_BYTES) return jsonResponse({ error: 'Photos must be 10 MB or smaller.' }, { status: 413 })
      const imageData = new Uint8Array(await imagePart.arrayBuffer())
      const imageContentType = sniffMediaMimeType(imageData)
      if (!RESOLVED_MEDIA_IMAGE_TYPES.has(imageContentType)) return jsonResponse({ error: 'Unsupported photo file type' }, { status: 415 })
      uploaded = await uploadResolvedMediaToAssetStore({
        db,
        env,
        organizationId: result.context.organization_id,
        userId: uploaderUserId,
        buffer: imageData,
        contentType: imageContentType,
        filename: sanitizeFilename(imagePart.name || 'review-photo'),
        kind: 'image',
        source: 'uploaded',
        category: 'other',
        fileSize: imageData.byteLength,
      })
    } else {
      if (!(videoPart instanceof File) || !(thumbnailPart instanceof File)) return jsonResponse({ error: 'an image field, or video and thumbnail fields, are required' }, { status: 400 })
      if (Number(existingMedia?.videos ?? 0) >= 2) return jsonResponse({ error: 'You can upload up to 2 videos.' }, { status: 400 })
      if (videoPart.size > REVIEW_VIDEO_MAX_BYTES) {
        return jsonResponse({ error: `Videos must be ${REVIEW_VIDEO_MAX_LABEL} or smaller.` }, { status: 413 })
      }
      if (thumbnailPart.size > MAX_POSTER_BYTES) return jsonResponse({ error: 'Thumbnail image too large (max 10 MB)' }, { status: 413 })

      const [videoData, thumbnailData] = await Promise.all([
        videoPart.arrayBuffer().then(buffer => new Uint8Array(buffer)),
        thumbnailPart.arrayBuffer().then(buffer => new Uint8Array(buffer)),
      ])
      const videoContentType = sniffMediaMimeType(videoData)
      if (!VIDEO_MIME_TYPES.has(videoContentType)) {
        return jsonResponse({ error: 'Accepted video formats are MP4 and WebM. .mov files are not supported.' }, { status: 415 })
      }
      const thumbnailContentType = sniffMediaMimeType(thumbnailData)
      if (!POSTER_IMAGE_MIME_TYPES.has(thumbnailContentType)) return jsonResponse({ error: 'Unsupported thumbnail image type' }, { status: 415 })
      const filename = sanitizeFilename(videoPart.name || 'review-video')

      uploaded = await uploadResolvedMediaToAssetStore({
        db,
        env,
        organizationId: result.context.organization_id,
        userId: uploaderUserId,
        buffer: videoData,
        contentType: videoContentType,
        filename,
        kind: 'video',
        source: 'uploaded',
        category: 'other',
        fileSize: videoData.byteLength,
        poster: {
          buffer: thumbnailData,
          contentType: thumbnailContentType,
          filename: sanitizeFilename(thumbnailPart.name || `${filename}-thumbnail.jpg`),
        },
      })
    }

    const mediaLinkId = crypto.randomUUID()
    try {
      const now = new Date().toISOString()
      await executeBatch(db, [
        buildMediaPlacementInsertQuery({
          id: mediaLinkId,
          organizationId: result.context.organization_id,
          ownerType: 'review_request',
          ownerId: requestId,
          slot: 'gallery',
          assetId: uploaded.assetId,
          sortOrder: Number(existingMedia?.next_sort_order ?? 0),
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        }), ])
    } catch (linkError) {
      try {
        await deleteMediaAsset(db, env, uploaded.assetId, result.context.organization_id, uploaderUserId)
      } catch (cleanupError) {
        throw new AggregateError([linkError, cleanupError], 'Review media could not be linked or cleaned up')
      }
      throw linkError
    }

    return jsonResponse({
      asset_id: uploaded.assetId,
      public_url: uploaded.publicUrl,
      thumbnail_url: uploaded.thumbnailUrl,
      kind: uploaded.kind,
      status: 'active',
    }, { status: 201 })
  } catch (error) {
    rethrowHttpError(error)
    const normalizedError = error instanceof Error ? error : new Error('Unknown review media upload error')
    console.error('review_media_upload_failed', { error: normalizedError.message, stack: normalizedError.stack })
    return jsonResponse({
      error: normalizedError instanceof AggregateError ? normalizedError.message : 'Failed to upload review media', message: normalizedError.message, }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
