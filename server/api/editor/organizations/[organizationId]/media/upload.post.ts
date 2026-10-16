import { defineHandler } from 'nitro';
import { getQuery, getRouterParam } from 'nitro/h3';
import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { sanitizeFilename, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { sniffMediaMimeType, VIDEO_MIME_TYPES, MAX_VIDEO_BYTES, POSTER_IMAGE_MIME_TYPES, MAX_POSTER_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, MAX_IMAGE_BYTES } from '~/server/utils/media-mime'

const VALID_CATEGORIES = new Set(['exterior', 'interior', 'food', 'menu', 'team', 'other'])
const MULTIPART_OVERHEAD_BYTES = 64 * 1024
type MediaCategory = 'exterior' | 'interior' | 'food' | 'menu' | 'team' | 'other'

function queryValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export default defineHandler(async (event) => {
  try {
    const organizationId = getRouterParam(event, 'organizationId')
    if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

    const { env, db, session } = await requireOrganizationAccess(event, organizationId)

    const query = getQuery(event)
    const rawCategory = queryValue(query.category)
    let category: MediaCategory | null = null
    if (rawCategory) {
      if (!VALID_CATEGORIES.has(rawCategory)) return jsonResponse({ error: 'Invalid category' }, { status: 400 })
      category = rawCategory as MediaCategory
    }

    const contentLengthHeader = event.req.headers.get('content-length')
    const contentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : contentLengthHeader ? Number.NaN : null
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength <= 0)) {
      return jsonResponse({ error: 'Invalid Content-Length header' }, { status: 400 })
    }
    if (contentLength !== null && contentLength > MAX_VIDEO_BYTES + MAX_POSTER_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return jsonResponse({ error: 'Upload too large (max 60 MB)' }, { status: 413 })
    }

    const formData = await event.req.formData()
    const imagePart = formData.get('image')
    const videoPart = formData.get('video')
    const thumbnailPart = formData.get('thumbnail')

    // An image is one part and arrives active in one request, the same way a
    // video does. It used to take a request-upload / direct-to-Cloudflare /
    // confirm round trip that left a pending row behind whenever a step failed.
    if (imagePart instanceof File) {
      if (imagePart.size > MAX_IMAGE_BYTES) return jsonResponse({ error: 'File too large (max 10 MB)' }, { status: 413 })
      const imageData = new Uint8Array(await imagePart.arrayBuffer())
      const imageContentType = sniffMediaMimeType(imageData)
      if (!RESOLVED_MEDIA_IMAGE_TYPES.has(imageContentType)) return jsonResponse({ error: 'Unsupported image file type' }, { status: 415 })
      const uploaded = await uploadResolvedMediaToAssetStore({
        db, env, organizationId,
        userId: session.user.id,
        buffer: imageData,
        contentType: imageContentType,
        filename: sanitizeFilename(imagePart.name || queryValue(query.filename) || undefined),
        kind: 'image',
        source: 'uploaded',
        category,
        fileSize: imageData.byteLength,
      })
      return jsonResponse({
        asset_id: uploaded.assetId,
        public_url: uploaded.publicUrl,
        thumbnail_url: uploaded.thumbnailUrl,
        kind: 'image',
        status: 'active',
      })
    }

    if (!(videoPart instanceof File) || !(thumbnailPart instanceof File)) {
      return jsonResponse({ error: 'an image field, or video and thumbnail fields, are required' }, { status: 400 })
    }
    if (videoPart.size > MAX_VIDEO_BYTES) return jsonResponse({ error: 'File too large (max 50 MB)' }, { status: 413 })
    if (thumbnailPart.size > MAX_POSTER_BYTES) return jsonResponse({ error: 'Thumbnail too large (max 10 MB)' }, { status: 413 })

    const [videoData, thumbnailData] = await Promise.all([
      videoPart.arrayBuffer().then(buffer => new Uint8Array(buffer)),
      thumbnailPart.arrayBuffer().then(buffer => new Uint8Array(buffer)),
    ])

    const videoContentType = sniffMediaMimeType(videoData)
    if (!VIDEO_MIME_TYPES.has(videoContentType)) return jsonResponse({ error: 'Unsupported video file type' }, { status: 415 })
    const thumbnailContentType = sniffMediaMimeType(thumbnailData)
    if (!POSTER_IMAGE_MIME_TYPES.has(thumbnailContentType)) return jsonResponse({ error: 'Unsupported thumbnail file type' }, { status: 415 })

    const filename = sanitizeFilename(videoPart.name || queryValue(query.filename) || undefined)
    const uploaded = await uploadResolvedMediaToAssetStore({
      db,
      env,
      organizationId,
      userId: session.user.id,
      buffer: videoData,
      contentType: videoContentType,
      filename,
      kind: 'video',
      source: 'uploaded',
      category,
      fileSize: videoData.byteLength,
      poster: {
        buffer: thumbnailData,
        contentType: thumbnailContentType,
        filename: sanitizeFilename(thumbnailPart.name || `${filename}-thumbnail.jpg`),
      },
    })

    return jsonResponse({
      asset_id: uploaded.assetId,
      public_url: uploaded.publicUrl,
      thumbnail_url: uploaded.thumbnailUrl,
      kind: 'video',
      status: 'active',
    })
  } catch (error) {
    rethrowHttpError(error)
    const normalizedError = error instanceof Error ? error : new Error('Unknown media upload error')
    console.error('media_upload_failed', { error: normalizedError.message, stack: normalizedError.stack })
    return jsonResponse({
      error: normalizedError instanceof AggregateError ? normalizedError.message : 'Failed to upload media', message: normalizedError.message, }, { status: 500 })
  }
})
