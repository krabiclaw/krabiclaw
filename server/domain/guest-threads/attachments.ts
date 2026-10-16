import { d1JsonStringSet, executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { buildMediaPlacementInsertQuery, deleteMediaAsset } from '~/server/utils/media-asset-manager'
import { MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, sniffMediaMimeType } from '~/server/utils/media-mime'
import { uploadResolvedMediaToAssetStore, type UploadResolvedMediaInput } from '~/server/utils/media-upload'
import type { GuestThreadEntryAttachmentViewModel } from './types'

/*
  The photos a message carries. Each is an ordinary media asset, placed on the
  message it was sent with (`activity_entry` or `team_message` / `attachments`), so it has the
  same storage, deletion and tenant scope as every other picture — and the media
  library leaves it out, because it is the conversation's, not the website's.
*/

export const MAX_MESSAGE_PHOTOS = 10

/** A guest-thread message (an activity entry) or a team-conversation message. */
export type MessageOwnerType = 'activity_entry' | 'team_message'

/** The rules every message photo meets, however it arrived: count, size and real image type. */
export function assertMessagePhotos(photos: MessagePhoto[]): Array<MessagePhoto & { contentType: string }> {
  if (photos.length > MAX_MESSAGE_PHOTOS) throw new MessagePhotoRejection(`A message can carry at most ${MAX_MESSAGE_PHOTOS} photos.`)
  return photos.map((photo) => {
    if (photo.bytes.byteLength > MAX_IMAGE_BYTES) throw new MessagePhotoRejection(`${photo.filename} is larger than 10 MB.`)
    const contentType = sniffMediaMimeType(photo.bytes)
    if (!MESSAGE_PHOTO_TYPES.has(contentType)) throw new MessagePhotoRejection(`${photo.filename} is not a JPEG, PNG, WebP, GIF or AVIF photo.`)
    return { ...photo, contentType }
  })
}
// Photos, not drawings: an SVG is a document, and nobody sends one as a photo.
const MESSAGE_PHOTO_TYPES = new Set([...RESOLVED_MEDIA_IMAGE_TYPES].filter(type => type !== 'image/svg+xml'))

/** A photo a message cannot carry. The message is the one the sender reads. */
export class MessagePhotoRejection extends Error {}

export interface MessagePhoto {
  bytes: Uint8Array<ArrayBuffer>
  filename: string
}

type Uploader = { source: 'uploaded'; userId: string } | { source: 'external'; userId: null }

/** What a message says in a preview line: its words, or what it sent when it has none. */
export function messagePreview(body: string | null | undefined, photoCount: number): string {
  if (body?.trim()) return body
  if (photoCount === 1) return 'Sent a photo'
  if (photoCount > 1) return `Sent ${photoCount} photos`
  return 'Sent a file'
}

/** Whether a file a guest sent can be kept as one of a message's photos. */
export function isMessagePhoto(bytes: Uint8Array): boolean {
  return bytes.byteLength <= MAX_IMAGE_BYTES && MESSAGE_PHOTO_TYPES.has(sniffMediaMimeType(bytes))
}

/**
 * What a guest sent, split into the photos the message keeps and the names of
 * the files it cannot show, which the message records so nothing goes missing
 * without a word.
 */
export function sortGuestFiles(files: MessagePhoto[]): { photos: MessagePhoto[]; unshown: string[] } {
  const photos: MessagePhoto[] = []
  const unshown: string[] = []
  for (const file of files) {
    if (photos.length < MAX_MESSAGE_PHOTOS && isMessagePhoto(file.bytes)) photos.push(file)
    else unshown.push(file.filename)
  }
  return { photos, unshown }
}

/**
 * Puts a guest's photos on the message they arrived with. A redelivered
 * message that already has them stores nothing a second time.
 */
export async function attachGuestPhotos(
  db: DbClient,
  env: UploadResolvedMediaInput['env'],
  organizationId: string,
  entryId: string,
  photos: MessagePhoto[],
  uploader: Uploader = { source: 'external', userId: null },
): Promise<void> {
  if (!photos.length) return
  if ((await listMessagePhotos(db, 'activity_entry', [entryId])).has(entryId)) return
  const assetIds = await uploadMessagePhotos(db, env, organizationId, photos, uploader)
  try {
    await executeBatch(db, messagePhotoPlacements(organizationId, 'activity_entry', entryId, assetIds, new Date().toISOString()), { operation: 'guest message photos' })
  } catch (error) {
    let saved: {asset_id:string}[]
    try {
      saved = await queryAll<{asset_id:string}>(db, "SELECT asset_id FROM media_placements WHERE organization_id=? AND owner_type='activity_entry' AND owner_id=? AND slot='attachments'", [organizationId, entryId])
    } catch (readError) {
      throw new AggregateError([error, readError], 'The attachment commit could not be read; its photos have been retained', { cause: readError })
    }
    const retained = new Set(saved.map(photo => photo.asset_id))
    await discardMessagePhotos(db, env, organizationId, assetIds.filter(id => !retained.has(id)), uploader.userId, error)
    if (assetIds.every(id => retained.has(id))) return
    throw error
  }
}

/**
 * Stores the photos and returns their asset ids, in order. Nothing places them:
 * the caller links them to the message in the same batch that writes it, and
 * hands them to `discardMessagePhotos` if that batch fails.
 */
export async function uploadMessagePhotos(
  db: DbClient,
  env: UploadResolvedMediaInput['env'],
  organizationId: string,
  photos: MessagePhoto[],
  uploader: Uploader,
): Promise<string[]> {
  const checked = assertMessagePhotos(photos)

  const assetIds: string[] = []
  try {
    for (const photo of checked) {
      const uploaded = await uploadResolvedMediaToAssetStore({
        db, env, organizationId,
        ...uploader,
        buffer: photo.bytes,
        contentType: photo.contentType,
        filename: photo.filename,
        kind: 'image',
        fileSize: photo.bytes.byteLength,
      })
      assetIds.push(uploaded.assetId)
    }
  } catch (error) {
    await discardMessagePhotos(db, env, organizationId, assetIds, uploader.userId, error)
    throw error
  }
  return assetIds
}

/** The placements that put the photos on their message, for the batch that writes it. */
export function messagePhotoPlacements(organizationId: string, ownerType: MessageOwnerType, messageId: string, assetIds: string[], createdAt: string): BatchQuery[] {
  return assetIds.map((assetId, sortOrder) => buildMediaPlacementInsertQuery({
    organizationId,
    ownerType,
    ownerId: messageId,
    slot: 'attachments',
    assetId,
    sortOrder,
    createdAt,
  }))
}

/**
 * Removes photos whose message was never written. `cause` is why: it is what
 * the caller rethrows, and a cleanup that also fails is reported beside it.
 */
export async function discardMessagePhotos(
  db: DbClient,
  env: UploadResolvedMediaInput['env'],
  organizationId: string,
  assetIds: string[],
  userId: string | null,
  cause: unknown,
): Promise<void> {
  const failures: unknown[] = []
  for (const assetId of assetIds) {
    try {
      await deleteMediaAsset(db, env, assetId, organizationId, userId)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError([cause, ...failures], 'Message photos could not be cleaned up after the message failed')
}

/** Each message's photos, in the order they were sent. */
export async function listMessagePhotos(db: DbClient, ownerType: MessageOwnerType, messageIds: string[]): Promise<Map<string, GuestThreadEntryAttachmentViewModel[]>> {
  const photos = new Map<string, GuestThreadEntryAttachmentViewModel[]>()
  if (!messageIds.length) return photos
  const rows = await queryAll<{ owner_id: string; id: string; public_url: string; alt_text: string | null; width: number | null; height: number | null }>(db, `
    SELECT mp.owner_id, ma.id, ma.public_url, ma.alt_text, ma.width, ma.height
      FROM media_placements mp
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id
     WHERE mp.owner_type = ? AND mp.slot = 'attachments' AND mp.status = 'active'
       AND ma.status = 'active' AND ma.public_url IS NOT NULL
       AND mp.owner_id IN (SELECT value FROM json_each(?))
     ORDER BY mp.owner_id, mp.sort_order
  `, [ownerType, d1JsonStringSet(messageIds)])
  for (const row of rows) {
    const list = photos.get(row.owner_id) ?? []
    list.push({ id: row.id, url: row.public_url, alt: row.alt_text, width: row.width, height: row.height })
    photos.set(row.owner_id, list)
  }
  return photos
}
