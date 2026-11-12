// POST /api/user/avatar — replace the signed-in account's profile picture.
//
// The image goes to Cloudflare Images and its URL onto the Better Auth user
// record, which is where identity lives. It deliberately does NOT become a
// media_assets row: that table is tenant media, scoped to an organization and
// a site, and a person's avatar is neither — filing it there would put it in
// the tenant's media picker and delete it with their organization.

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth, getAuthSession } from '~/server/utils/auth'
import { assertCloudflareImagesConfigured, deleteImage, deleteImageOwnedBy, uploadImageBuffer } from '~/server/utils/cloudflare-images'
import { sniffMediaMimeType, POSTER_IMAGE_MIME_TYPES } from '~/server/utils/media-mime'

const MAX_AVATAR_BYTES = 5 * 1024 * 1024

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })
  assertCloudflareImagesConfigured(env)

  const form = await readFormData(event)
  const file = form.get('file')
  if (!(file instanceof File)) return jsonResponse({ error: 'An image file is required' }, { status: 400 })
  if (file.size > MAX_AVATAR_BYTES) return jsonResponse({ error: 'Images must be 5MB or smaller' }, { status: 413 })

  // Sniffed from the bytes, never from the client's Content-Type.
  const buffer = new Uint8Array(await file.arrayBuffer())
  const mimeType = sniffMediaMimeType(buffer)
  if (!POSTER_IMAGE_MIME_TYPES.has(mimeType)) {
    return jsonResponse({ error: 'Upload a JPEG, PNG, WebP, AVIF or GIF image' }, { status: 415 })
  }

  // The filename is this account's id, so ownership can be checked against
  // Cloudflare later rather than guessed from a URL a client can set.
  const avatarFilename = `avatar-${session.user.id}`
  const uploaded = await uploadImageBuffer(env, buffer, avatarFilename, mimeType)

  const previous = typeof session.user.image === 'string' ? session.user.image : null
  try {
    await createAuth(env).api.updateUser({
      headers: event.req.headers,
      body: { image: uploaded.publicUrl },
    })
  } catch (cause) {
    // The image exists before the account points at it, so a failed update
    // would otherwise leave it orphaned in Cloudflare Images forever.
    try {
      await deleteImage(env, uploaded.imageId)
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], 'Avatar update and cleanup failed', { cause: cleanupError })
    }
    throw cause
  }

  // Replacing an avatar we hosted removes the old image; one hosted elsewhere,
  // or one belonging to somebody else, is left alone. `previous` comes from
  // `user.image`, which an authenticated client can set to any string through
  // Better Auth — so it names a candidate, and Cloudflare's own record of the
  // filename decides whether it is ours to delete.
  // The new avatar is already saved, so a failed delete of the old one is not a
  // failed upload: the response says the avatar changed and names what was left.
  const previousImageId = previous?.split('/').at(-2)
  if (previousImageId && previousImageId !== uploaded.imageId) {
    try {
      await deleteImageOwnedBy(env, previousImageId, avatarFilename)
    } catch (cause) {
      return jsonResponse({
        image: uploaded.publicUrl,
        previous_image_cleanup_error: `The previous avatar image ${previousImageId} was not deleted: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
  }

  return jsonResponse({ image: uploaded.publicUrl })
})
import { defineHandler } from 'nitro';
import { readFormData } from 'nitro/h3';
