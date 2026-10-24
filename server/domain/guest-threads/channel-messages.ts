import { HTTPError } from 'nitro'
import { execute, executeBatch, queryFirst, type DbClient } from '~/server/db'
import { publishGuestInboxThreadEvent, publishStayInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { ChannexError, type ChannexEnv } from '~/server/integrations/channex/client'
import { getChannexThread, listChannexMessages, listChannexThreads, sendChannexMessage, type ChannexMessage, type ChannexMessageThread } from '~/server/integrations/channex/messages'
import { appendEntry, findEntryByDedupeKey, parseEntryPayload, GuestThreadEntryDedupeConflictError } from './entries'
import { getDeliveryById, getDeliveryByProviderMessageId, isDeliverySent, recordDeliveryOutcome } from './deliveries'
import { updateThreadProjectionIfLatestEntry } from './repository'
import { assertMessagePhotos, discardMessagePhotos, isMessagePhoto, messagePhotoPlacements, uploadMessagePhotos, type MessagePhoto } from './attachments'
import type { UploadResolvedMediaInput } from '~/server/utils/media-upload'
import { getMediaAsset, readMediaPlacements } from '~/server/utils/media-asset-manager'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { downloadImageBuffer } from '~/server/utils/cloudflare-images'
import { stayThreadQueries } from '~/server/domain/requests'
import { planStayMessages } from '~/server/domain/scheduled-guest-messages'
import type { GuestThreadEntryRow } from './types'

type ChannelEnv = ChannexEnv & GuestInboxPublicationEnv
interface HomeMapping { organization_id: string; product_id: string; property_id: string; channel_id: string; location_id: string; enabled: number }
export interface ChannelThreadMapping { organization_id: string; product_id: string; request_id: string; external_thread_id: string; external_booking_id: string | null }

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, message, data: { code, field } })
}

export async function getChannelThreadMapping(db: DbClient, requestId: string, organizationId: string): Promise<ChannelThreadMapping | null> {
  return queryFirst<ChannelThreadMapping>(db, "SELECT * FROM channel_threads WHERE provider = 'channex' AND request_id = ? AND organization_id = ?", [requestId, organizationId])
}

async function homeMapping(db: DbClient, propertyId: string): Promise<HomeMapping | null> {
  return queryFirst<HomeMapping>(db, `SELECT m.organization_id, m.product_id, m.property_id, m.channel_id, m.enabled, c.location_id
    FROM product_channel_mappings m JOIN product_stay_configs c ON c.organization_id = m.organization_id AND c.product_id = m.product_id
    WHERE m.provider = 'channex' AND m.property_id = ?`, [propertyId])
}

/** An inquiry and a stay share one immutable timeline; conflicting existing timelines are never discarded. */
async function adoptThread(db: DbClient, home: HomeMapping, thread: ChannexMessageThread): Promise<ChannelThreadMapping> {
  const mapped = await queryFirst<ChannelThreadMapping>(db, "SELECT * FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ?", [thread.id])
  if (mapped && (mapped.organization_id !== home.organization_id || mapped.product_id !== home.product_id)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider conversation belongs to another home', 'relationships.property')
  if (mapped?.external_booking_id && mapped.external_booking_id !== thread.bookingId) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The provider changed an existing conversation booking association; review its timeline', 'relationships.booking')
  if (thread.bookingId && await queryFirst(db, "SELECT request_id FROM channel_threads WHERE provider = 'channex' AND external_booking_id = ? AND external_thread_id <> ?", [thread.bookingId, thread.id])) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The booking is already associated with another provider conversation', 'relationships.booking')
  const stay = thread.bookingId ? await queryFirst<{ id: string; request_id: string | null; organization_id: string; product_id: string }>(db,
    "SELECT id, request_id, organization_id, product_id FROM stays WHERE provider = 'channex' AND external_booking_id = ?", [thread.bookingId]) : null
  if (stay && (stay.organization_id !== home.organization_id || stay.product_id !== home.product_id)) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The provider booking belongs to another home', 'relationships.booking')
  if (mapped && stay?.request_id && mapped.request_id !== stay.request_id) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The inquiry and stay already have separate conversations; reconcile them without discarding either timeline', 'request_id')
  const requestId = mapped?.request_id ?? stay?.request_id ?? crypto.randomUUID()
  if (await queryFirst(db, "SELECT request_id FROM channel_threads WHERE request_id = ? AND external_thread_id <> ?", [requestId, thread.id])) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The stay conversation already has another provider address', 'request_id')
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, conversation_state, resolved_at, payload_json, created_at, updated_at)
      SELECT ?, 'stay', ?, ?, NULL, NULL, 'needs_attention', NULL, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM requests WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ?)`,
    params: [requestId, home.organization_id, home.location_id, JSON.stringify({ participant: { kind: 'channel', title: thread.title }, guest: { name: null, email: null, phone: null } }), now, now, requestId, thread.id],
  }, {
    query: `INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, request_id, external_booking_id, provider_updated_at, created_at, updated_at)
      SELECT 'channex', ?, ?, ?, r.id, ?, ?, ?, ? FROM requests r WHERE r.id = ? AND r.organization_id = ? AND r.kind = 'stay' AND r.location_id = ?
      ON CONFLICT (provider, external_thread_id) DO UPDATE SET external_booking_id = excluded.external_booking_id,
        provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at
      WHERE channel_threads.organization_id = excluded.organization_id AND channel_threads.product_id = excluded.product_id
        AND channel_threads.request_id = excluded.request_id`,
    params: [thread.id, home.organization_id, home.product_id, thread.bookingId, thread.updatedAt, now, now, requestId, home.organization_id, home.location_id],
  }, {
    query: `UPDATE requests SET payload_json = json_set(payload_json, '$.participant.title', ?)
      WHERE id = ? AND organization_id = ? AND json_extract(payload_json, '$.participant.kind') = 'channel'
        AND EXISTS (SELECT 1 FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ? AND request_id = requests.id)`,
    params: [thread.title, requestId, home.organization_id, thread.id],
  }, {
    query: `UPDATE stays SET request_id = ? WHERE provider = 'channex' AND external_booking_id = ? AND organization_id = ? AND product_id = ?
      AND (request_id IS NULL OR request_id = ?) AND EXISTS (SELECT 1 FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ? AND request_id = ?)`,
    params: [requestId, thread.bookingId, home.organization_id, home.product_id, requestId, thread.id, requestId],
  }, ...(stay ? stayThreadQueries({ organizationId: home.organization_id, stayId: stay.id, now, openedBy: 'channel' }) : [])], { operation: 'Adopt channel guest conversation' })
  const saved = await queryFirst<ChannelThreadMapping>(db, "SELECT * FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ?", [thread.id])
  if (!saved || saved.organization_id !== home.organization_id || saved.product_id !== home.product_id) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The channel conversation could not be associated atomically', 'request_id')
  if (stay) {
    const linked = await queryFirst<{ request_id: string | null }>(db, 'SELECT request_id FROM stays WHERE id = ?', [stay.id])
    if (linked?.request_id !== saved.request_id) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The stay conversation changed during association', 'request_id')
  }
  return saved
}

async function mirrorMessage(db: DbClient, mapping: ChannelThreadMapping, message: ChannexMessage): Promise<void> {
  if (message.threadId !== mapping.external_thread_id) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The message belongs to another conversation', 'relationships.message_thread')
  const delivery = await getDeliveryByProviderMessageId(db, 'channex', message.id)
  if (delivery) {
    const owner = await queryFirst<{ request_id: string | null }>(db, 'SELECT request_id FROM activity_entries WHERE id = ?', [delivery.entry_id])
    if (owner?.request_id !== mapping.request_id) fail(409, 'CHANNEL_MESSAGE_ID_CONFLICT', 'The provider message is recorded in another conversation', 'message.id')
    if (message.sender !== 'property') fail(409, 'CHANNEL_MESSAGE_ID_CONFLICT', 'The provider assigned an outbound reply ID to a different sender', 'message.sender')
  }
  const entry = await appendEntry(db, {
    threadId: mapping.request_id, kind: 'message', actorKind: message.sender === 'guest' ? 'guest' : message.sender === 'property' ? 'member' : 'system',
    channel: 'airbnb', body: message.text, eventName: 'channel.message_mirrored', dedupeKey: `channex-message:${message.id}`,
    // This occurrence is the local mirroring operation. Provider timestamps are
    // retained exactly: a naive provider date is not an established UTC instant.
    payloadJson: { provider_message_id: message.id, provider_inserted_at: message.insertedAt, provider_updated_at: message.updatedAt,
      attachments: message.attachments, ...(message.meta === undefined ? {} : { meta: message.meta }) },
  }).catch((error: unknown) => {
    if (error instanceof GuestThreadEntryDedupeConflictError) fail(409, 'CHANNEL_MESSAGE_ID_CONFLICT', 'The provider message ID differs from its immutable recorded fact; review the conversation', 'message.id')
    throw error
  })
  await updateThreadProjectionIfLatestEntry(db, mapping.request_id, entry.id, { conversationState: message.sender === 'property' ? 'waiting_on_guest' : 'needs_attention' })
}

export async function mirrorChannexThread(db: DbClient, env: ChannelEnv, threadId: string, expectedPropertyId: string, assignedBookingId?: string, expectedMessageId?: string): Promise<{ status: 'mirrored'; request_id: string; messages: number } | { status: 'ignored_disconnected' }> {
  const home = await homeMapping(db, expectedPropertyId)
  if (!home || home.enabled !== 1) return { status: 'ignored_disconnected' }
  const thread = await getChannexThread(env, threadId)
  if (thread.propertyId !== expectedPropertyId || (thread.channelId !== null && thread.channelId !== home.channel_id)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider conversation is outside its local property mapping', 'relationships.property')
  if (assignedBookingId !== undefined && thread.bookingId !== assignedBookingId) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The assignment event does not match the provider conversation', 'payload.booking_id')
  const messages = await listChannexMessages(env, threadId)
  if (expectedMessageId !== undefined && !messages.some(message => message.id === expectedMessageId)) fail(409, 'CHANNEL_MESSAGE_NOT_READY', 'The provider conversation does not yet contain the webhook message', 'payload.id')
  const mapping = await adoptThread(db, home, thread)
  // The provider query explicitly asks for ascending order. Keep its order; do not invent an absolute
  // ordering by converting offset-free timestamps through the server's timezone.
  for (const message of messages) await mirrorMessage(db, mapping, message)
  await publishGuestInboxThreadEvent(env, db, { threadId: mapping.request_id, type: 'thread.changed' })
  // A booked conversation is the stay's conversation: its scheduled messages
  // follow the adopted request, and an open stay screen learns of the link.
  const stay = mapping.external_booking_id === null ? null : await queryFirst<{ id: string; version: number }>(db,
    "SELECT id, version FROM stays WHERE provider = 'channex' AND external_booking_id = ? AND organization_id = ? AND product_id = ? AND request_id = ?",
    [mapping.external_booking_id, mapping.organization_id, mapping.product_id, mapping.request_id])
  if (stay) {
    await planStayMessages(db, mapping.organization_id, stay.id)
    await publishStayInvalidation(env, { type: 'stay.changed', organizationId: mapping.organization_id, locationId: home.location_id, productId: mapping.product_id, stayId: stay.id }, { version: stay.version })
  }
  return { status: 'mirrored', request_id: mapping.request_id, messages: messages.length }
}

/** Webhooks are pull triggers; guest data in their payload is never an authority. */
export async function mirrorChannexMessageEvent(db: DbClient, env: ChannelEnv, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_WEBHOOK', 'The webhook body must be an object', 'body')
  const body = value as Record<string, unknown>
  if (body.event !== 'message' && body.event !== 'message_thread_booking_assigned' && body.event !== 'inquiry') fail(400, 'INVALID_WEBHOOK', 'The webhook is not a messaging event', 'event')
  const required = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) fail(400, 'INVALID_WEBHOOK', `The webhook needs ${field}`, field)
    return value
  }
  const propertyId = required(body.property_id, 'property_id')
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) fail(400, 'INVALID_WEBHOOK', 'The webhook needs a payload object', 'payload')
  const payload = body.payload as Record<string, unknown>
  const threadId = required(payload.message_thread_id, 'payload.message_thread_id')
  if (body.event !== 'message_thread_booking_assigned' && required(payload.property_id, 'payload.property_id') !== propertyId) fail(400, 'INVALID_WEBHOOK', 'Webhook property IDs disagree', 'payload.property_id')
  return mirrorChannexThread(db, env, threadId, propertyId,
    body.event === 'message_thread_booking_assigned' ? required(payload.booking_id, 'payload.booking_id') : undefined,
    body.event === 'message' ? required(payload.id, 'payload.id') : undefined)
}

export async function backfillChannexMessages(db: DbClient, env: ChannelEnv, propertyId: string, organizationId: string): Promise<{ threads: number }> {
  const home = await homeMapping(db, propertyId)
  if (!home || home.organization_id !== organizationId || home.enabled !== 1) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'Connect this home before importing conversations', 'property_id')
  const threads = await listChannexThreads(env, propertyId)
  for (const thread of threads) await mirrorChannexThread(db, env, thread.id, propertyId)
  return { threads: threads.length }
}

/** Channel replies use the same canonical ledger, photo owner and delivery receipts as every inbox reply. */
export type ChannelReplyOutcome = { ok: true } | {
  ok: false; status: 409 | 502; code: 'CHANNEL_REPLY_REVIEW_REQUIRED' | 'CHANNEL_REPLY_UNCERTAIN' | 'CHANNEL_REPLY_FAILED'; field: 'delivery.status'; message: string
  mutation_applied: true; operation_completed: false; request_id: string; retry_with_same_idempotency_key: boolean
  provider_error?: ChannexError['data']
}

function assertReplyIntent(entry: GuestThreadEntryRow, body: string, requestHash: string, eventName: string): void {
  if (entry.event_name !== eventName) fail(409, 'IDEMPOTENCY_CONFLICT', 'The reply key was already used for a different message', 'idempotencyKey')
  const payload = parseEntryPayload(entry)
  if (typeof payload?.request_hash !== 'string') fail(500, 'CHANNEL_REPLY_INTENT_INVALID', 'The channel reply intent has no recorded request hash', 'payload.request_hash')
  if (entry.body !== body || payload.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'The reply key was already used for different content', 'idempotencyKey')
}

export async function replyThroughChannex(db: DbClient, env: ChannexEnv & UploadResolvedMediaInput['env'] & { MEDIA_BUCKET?: R2Bucket }, input: {
  mapping: ChannelThreadMapping; body: string; actorUserId: string | null; idempotencyKey: string; requestHash: string
  photoCount: number; resolvePhotos: () => Promise<MessagePhoto[]>
}): Promise<ChannelReplyOutcome> {
  const eventName = input.actorUserId === null ? 'thread.scheduled_message' : 'thread.member_reply'
  const purpose = input.actorUserId === null ? 'scheduled_message' : 'member_reply'
  if (!input.body.trim() && !input.photoCount) fail(400, 'EMPTY_MESSAGE', 'Write a message or choose a photo before sending it', 'body')
  if (input.photoCount > 1 || (input.photoCount && input.body.trim())) fail(400, 'CHANNEL_PHOTO_MESSAGE_INVALID', 'Send one Airbnb photo at a time, separately from text', 'photos')
  const key = `guest-thread-operation:${input.mapping.request_id}:${input.idempotencyKey}`
  const deliveryId = `guest-thread-channex:${input.mapping.request_id}:${input.idempotencyKey}`
  const requestHash = input.requestHash
  const reviewRequired = (): ChannelReplyOutcome => ({ ok: false, status: 409, code: 'CHANNEL_REPLY_REVIEW_REQUIRED', field: 'delivery.status',
    message: 'This reply was already attempted and has no successful recorded receipt. Review its provider conversation before sending again',
    mutation_applied: true, operation_completed: false, request_id: input.mapping.request_id, retry_with_same_idempotency_key: false })
  let entry = await findEntryByDedupeKey(db, key)
  if (entry) {
    assertReplyIntent(entry, input.body, requestHash, eventName)
    const receipt = await getDeliveryById(db, deliveryId)
    if (!receipt || receipt.entry_id !== entry.id) fail(500, 'CHANNEL_RECEIPT_INVALID', 'The reply has no matching delivery receipt', 'delivery')
    if (isDeliverySent(receipt)) {
      if (!receipt.provider_message_id?.trim()) fail(500, 'CHANNEL_RECEIPT_INVALID', 'A successful channel reply has no provider message ID', 'delivery.provider_message_id')
      await updateThreadProjectionIfLatestEntry(db, input.mapping.request_id, entry.id, { conversationState: 'waiting_on_guest' })
      return { ok: true }
    }
    if (receipt.status !== 'pending' && !(receipt.status === 'failed' && receipt.non_delivery_confirmed === 1)) return reviewRequired()
  }
  // A failed preflight records no reply that was never attempted. Proven
  // accepted replays above remain safe even after the home is disconnected.
  const home = await queryFirst<HomeMapping>(db, `SELECT m.*, c.location_id FROM product_channel_mappings m
    JOIN product_stay_configs c ON c.product_id = m.product_id AND c.organization_id = m.organization_id
    WHERE m.provider = 'channex' AND m.organization_id = ? AND m.product_id = ?`, [input.mapping.organization_id, input.mapping.product_id])
  if (!home || home.enabled !== 1) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'This home is disconnected from guest messaging', 'product_id')
  const current = await getChannexThread(env, input.mapping.external_thread_id)
  if (current.propertyId !== home.property_id || (current.channelId !== null && current.channelId !== home.channel_id)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider conversation is outside its local property mapping', 'relationships.property')
  if (!entry) {
    const photos = await input.resolvePhotos()
    if (photos.length !== input.photoCount) throw new Error('Resolved reply photos do not match their declared sources')
    const id = crypto.randomUUID(), now = new Date().toISOString()
    const assetIds = input.actorUserId === null ? [] : await uploadMessagePhotos(db, env, input.mapping.organization_id, photos, { source: 'uploaded', userId: input.actorUserId })
    try {
      await executeBatch(db, [{
        query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
          SELECT ?, id, 'message', 'request', ?, ?, 'airbnb', ?, ?, ?, ?,
            COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = requests.id), 0) + 1, ?, ?
          FROM requests WHERE id = ? AND organization_id = ? ON CONFLICT(dedupe_key) DO NOTHING`,
        params: [id, input.actorUserId === null ? 'system' : 'member', input.actorUserId, input.body, eventName, JSON.stringify({ request_hash: requestHash }), key, now, now, input.mapping.request_id, input.mapping.organization_id],
      }, {
        query: `INSERT INTO guest_thread_deliveries (id, entry_id, channel, provider, purpose, status, created_at, updated_at)
          SELECT ?, id, 'airbnb', 'channex', ?, 'pending', ?, ? FROM activity_entries WHERE dedupe_key = ? AND request_id = ?
          ON CONFLICT(id) DO NOTHING`,
        params: [deliveryId, purpose, now, now, key, input.mapping.request_id],
      }, ...messagePhotoPlacements(input.mapping.organization_id, 'activity_entry', id, assetIds, now)], { operation: 'Record channel reply intent' })
    } catch (error) {
      let concurrent: GuestThreadEntryRow | null
      try {
        concurrent = await findEntryByDedupeKey(db, key)
      } catch (readError) {
        throw new AggregateError([error, readError], 'The channel reply commit could not be read; its photos have been retained', { cause: readError })
      }
      if (concurrent?.id !== id) await discardMessagePhotos(db, env, input.mapping.organization_id, assetIds.splice(0), input.actorUserId, error)
      if (!concurrent) throw error
      assertReplyIntent(concurrent, input.body, requestHash, eventName)
    }
    entry = await findEntryByDedupeKey(db, key)
    // Concurrent identical keys share one entry; only its photo placements survive.
    if (entry && entry.id !== id) await discardMessagePhotos(db, env, input.mapping.organization_id, assetIds, input.actorUserId, new Error('Concurrent channel reply retained the existing photo'))
  }
  if (!entry) fail(500, 'CHANNEL_REPLY_INTENT_INVALID', 'The reply intent was not recorded', 'entry')
  assertReplyIntent(entry, input.body, requestHash, eventName)
  const receipt = await getDeliveryById(db, deliveryId)
  if (!receipt || receipt.entry_id !== entry.id) fail(500, 'CHANNEL_RECEIPT_INVALID', 'The reply has no matching delivery receipt', 'delivery')
  if (isDeliverySent(receipt)) {
    if (!receipt.provider_message_id?.trim()) fail(500, 'CHANNEL_RECEIPT_INVALID', 'A successful channel reply has no provider message ID', 'delivery.provider_message_id')
    await updateThreadProjectionIfLatestEntry(db, input.mapping.request_id, entry.id, { conversationState: 'waiting_on_guest' })
    return { ok: true }
  }
  if (receipt.status !== 'pending' && !(receipt.status === 'failed' && receipt.non_delivery_confirmed === 1)) return reviewRequired()
  let photo: ReturnType<typeof assertMessagePhotos>[number] | undefined
  if (input.photoCount) {
    const placed = (await readMediaPlacements(db, { organizationId: input.mapping.organization_id, ownerType: 'activity_entry', ownerIds: [entry.id], slot: 'attachments' })).get(entry.id) ?? []
    if (placed.length !== 1) fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply needs its original active photo before it can be sent', 'photos')
    const asset = await getMediaAsset(db, placed[0]!.asset_id, input.mapping.organization_id)
    if (!asset || asset.status !== 'active' || asset.kind !== 'image' || !asset.file_name) {
      fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply photo has no readable original file', 'photos')
    }
    let bytes: Uint8Array<ArrayBuffer>
    if (asset.provider === 'cloudflare_r2' && asset.r2_key) {
      if (!env.MEDIA_BUCKET) throw new Error('MEDIA_BUCKET binding not available')
      const stored = await env.MEDIA_BUCKET.get(asset.r2_key)
      if (!stored || stored.size !== asset.file_size || stored.size > MAX_IMAGE_BYTES) fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply photo file is missing or invalid', 'photos')
      bytes = new Uint8Array(await stored.arrayBuffer())
    } else if (asset.provider === 'cloudflare_images' && asset.cloudflare_image_id) {
      const stored = await downloadImageBuffer(env, asset.cloudflare_image_id)
      if (!stored) fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply photo file is missing or invalid', 'photos')
      bytes = stored
    } else fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply photo has no readable stored file', 'photos')
    if (!isMessagePhoto(bytes)) fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply file is not a valid message photo', 'photos')
    photo = assertMessagePhotos([{ filename: asset.file_name, bytes }])[0]!
    if (asset.provider === 'cloudflare_r2' && photo.contentType !== asset.mime_type) fail(409, 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', 'The saved reply photo type differs from its recorded file', 'photos')
  }
  // Only a definite non-delivery may be explicitly retried under its same intent.
  // A concurrent accepted, sending or uncertain result cannot enter this claim.
  const claim = await execute(db, "UPDATE guest_thread_deliveries SET status = 'sending', error = NULL, non_delivery_confirmed = NULL, updated_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'failed' AND non_delivery_confirmed = 1))", [new Date().toISOString(), deliveryId])
  if (claim.meta.changes !== 1) return reviewRequired()
  try {
    const message = await sendChannexMessage(env, input.mapping.external_thread_id, input.body, photo)
    await recordDeliveryOutcome(db, { deliveryId, status: 'accepted', providerMessageId: message.id, nonDeliveryConfirmed: false })
  } catch (error) {
    const nonDeliveryConfirmed = error instanceof ChannexError && !error.uncertain && error.writeRefused
    const uncertain = !nonDeliveryConfirmed
    await recordDeliveryOutcome(db, { deliveryId, status: uncertain ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : String(error), nonDeliveryConfirmed })
    return { ok: false, status: 502, code: uncertain ? 'CHANNEL_REPLY_UNCERTAIN' : 'CHANNEL_REPLY_FAILED', field: 'delivery.status',
      message: uncertain ? 'Channex may have accepted the reply. Review the conversation before sending again' : 'This reply was not sent. You can retry the same reply.',
      mutation_applied: true, operation_completed: false, request_id: input.mapping.request_id, retry_with_same_idempotency_key: !uncertain,
      ...(error instanceof ChannexError ? { provider_error: error.data } : {}) }
  }
  await updateThreadProjectionIfLatestEntry(db, input.mapping.request_id, entry.id, { conversationState: 'waiting_on_guest' })
  return { ok: true }
}
