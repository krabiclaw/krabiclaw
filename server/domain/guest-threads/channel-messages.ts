import { initialConversationParticipants, initialListingParticipants, reconcileGuestListingParticipants } from '~/server/domain/conversation-participants'
import { HTTPError } from 'nitro'
import { execute, executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { publishConversationEvent, publishStayInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { ChannexError, type ChannexEnv } from '~/server/integrations/channex/client'
import { landBookingRevision, pendingBookingRevisions } from '~/server/integrations/channex/booking-revisions'
import { getChannexThread, listChannexMessages, listChannexThreads, sendChannexMessage, type ChannexMessage, type ChannexMessageThread } from '~/server/integrations/channex/messages'
import { MIRRORED_EVENT, MessageDedupeConflictError, SCHEDULED_MESSAGE_EVENT, appendMessage, assertMessageWriteAccess, findMessageByDedupeKey, getMessage, parseMessagePayload, type ConversationGuard, type MessageRow } from '~/server/domain/conversations'
import { getDeliveryById, getDeliveryByProviderMessageId, isDeliverySent, recordDeliveryOutcome } from './deliveries'
import { conversationTaskQueries, reconcileConversationTasks } from './repository'
import { assertMessagePhotos, attachGuestPhotos, isMessagePhoto, listMessagePhotos, sortGuestFiles, type MessagePhoto } from './attachments'
import type { UploadResolvedMediaInput } from '~/server/utils/media-upload'
import { getMediaAsset, readMediaPlacements } from '~/server/utils/media-asset-manager'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { downloadImageBuffer } from '~/server/utils/cloudflare-images'
import { getGuestRequest, requestSummary } from '~/server/domain/requests'
import { isAirbnbSupportMessage, notifyGuestThreadReply, notifyAirbnbInquiry } from '~/server/utils/notifications'
import { readAirbnbInquiry } from '~/server/integrations/channex/live-feed'
import type { CloudflareEnv } from '~/server/utils/auth'
import { planSourceMessages } from '~/server/domain/scheduled-guest-messages'
import type { GuestThreadDeliveryRow } from './types'
import type { StayChannel } from '~/shared/bookings'

type ChannelEnv = ChannexEnv & GuestInboxPublicationEnv & CloudflareEnv & UploadResolvedMediaInput['env']
interface HomeMapping { organization_id: string; product_id: string; property_id: string; channel_id: string; location_id: string; enabled: number }
export interface ChannelThreadMapping { organization_id: string; product_id: string; conversation_id: string; external_thread_id: string; external_booking_id: string | null; moved_from_thread_id: string | null }

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, message, data: { code, field } })
}

/** Channel routing and the home used to present this conversation come from the same join. */
export async function guestThreadChannel(db: DbClient, conversationId: string, organizationId: string) {
  const row = await queryFirst<Omit<ChannelThreadMapping, 'product_id' | 'external_thread_id'> & {
    product_id: string | null
    mapped_product_id: string | null
    external_thread_id: string | null
    connected: number
    booking_channel: StayChannel | null
    booking_owner: 'app' | 'channel' | null
  }>(db, `
    SELECT c.organization_id, c.id AS conversation_id, ct.external_thread_id, ct.external_booking_id, ct.moved_from_thread_id,
      ct.product_id AS mapped_product_id, COALESCE(ct.product_id, CASE WHEN b.owner = 'channel' THEN b.product_id END) AS product_id,
      EXISTS (SELECT 1 FROM product_channel_mappings pcm
        WHERE pcm.provider = ct.provider AND pcm.organization_id = ct.organization_id AND pcm.product_id = ct.product_id AND pcm.enabled = 1) AS connected,
      b.channel AS booking_channel, b.owner AS booking_owner
    FROM conversations c
    LEFT JOIN channel_threads ct ON ct.organization_id = c.organization_id AND ct.conversation_id = c.id
    LEFT JOIN bookings b ON b.organization_id = c.organization_id AND b.id = c.booking_id AND c.kind = 'booking'
    WHERE c.id = ? AND c.organization_id = ?`, [conversationId, organizationId])
  if (!row) return null
  const { product_id, mapped_product_id, connected, booking_channel, booking_owner, ...mapping } = row
  return {
    productId: product_id,
    mapping: mapped_product_id !== null && mapping.external_thread_id !== null
      ? { ...mapping, product_id: mapped_product_id, external_thread_id: mapping.external_thread_id }
      : null,
    connected: connected === 1,
    booking: booking_channel !== null && booking_owner !== null ? { channel: booking_channel, owner: booking_owner } : null,
  }
}

async function homeMapping(db: DbClient, propertyId: string): Promise<HomeMapping | null> {
  return queryFirst<HomeMapping>(db, `SELECT m.organization_id, m.product_id, m.property_id, m.channel_id, m.enabled, c.location_id
    FROM product_channel_mappings m JOIN product_stay_configs c ON c.organization_id = m.organization_id AND c.product_id = m.product_id
    WHERE m.provider = 'channex' AND m.property_id = ?`, [propertyId])
}

type ThreadStay = { id: string; conversation_id: string; organization_id: string; product_id: string }

/**
 * The stay of the booking a conversation names. A booking whose revision
 * Channex still holds unacknowledged (the conversation arrived first, or the
 * same reservation re-imported through a new Channex account) is landed from
 * the revision feed here, so the conversation joins the stay it belongs to;
 * the booking itself is never read by id. A booking Channex never sent (one
 * before the import's reservations) has no stay.
 */
async function threadStay(db: DbClient, env: ChannelEnv, home: HomeMapping, bookingId: string): Promise<ThreadStay | null> {
  const stay = () => queryFirst<ThreadStay>(db, `SELECT b.id, c.id AS conversation_id, b.organization_id, b.product_id FROM bookings b
    JOIN conversations c ON c.booking_id = b.id AND c.organization_id = b.organization_id AND c.kind = 'booking'
    WHERE b.provider = 'channex' AND b.external_booking_id = ?`, [bookingId])
  const landed = await stay()
  if (landed) return landed
  for (const revision of await pendingBookingRevisions(env, home.property_id, bookingId)) await landBookingRevision(db, env, revision)
  return stay()
}

/**
 * A channel's reservation opens its own conversation when it lands; when the
 * guest had already written before booking, that inquiry's conversation is
 * the stay's. The reservation's own conversation joins it: every message and
 * everything that names it moves to the inquiry's, after its messages, and the
 * guest it recorded becomes the inquiry's guest. Nothing is discarded.
 */
export async function joinBookingConversationQueries(db: DbClient, input: { organizationId: string; bookingId: string; from: string; into: string; now: string }): Promise<BatchQuery[]> {
  const last = await queryFirst<{ sequence: number }>(db, 'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE conversation_id = ?', [input.into])
  if (!last) throw new Error(`Conversation ${input.into} has no messages to read`)
  const owned = "EXISTS (SELECT 1 FROM conversations owner WHERE owner.id = ? AND owner.organization_id = ? AND owner.booking_id = ? AND owner.kind = 'booking')"
  const ownedParams = [input.from, input.organizationId, input.bookingId]
  return [
    // The inquiry's messages are as read, and it has no booking of its own, or the batch fails here.
    { query: `SELECT CASE WHEN (SELECT COALESCE(MAX(sequence), 0) FROM messages WHERE conversation_id = ?) = ? AND (SELECT booking_id FROM conversations WHERE id = ?) IS NULL THEN NULL ELSE json('CHANNEL_CONVERSATION_CHANGED') END`, params: [input.into, last.sequence, input.into] },
    { query: `DELETE FROM conversation_participants WHERE conversation_id = ? AND role = 'guest'
        AND user_id = (SELECT c.user_id FROM conversations c WHERE c.id = conversation_participants.conversation_id)
        AND user_id IS NOT (SELECT c.user_id FROM conversations c WHERE c.id = ?) AND ${owned}`,
      params: [input.into, input.from, ...ownedParams] },
    { query: `UPDATE conversations SET user_id = (SELECT user_id FROM conversations WHERE id = ?),
        location_id = (SELECT location_id FROM conversations WHERE id = ?),
        last_message_at = max(last_message_at, (SELECT last_message_at FROM conversations WHERE id = ?)),
        payload_json = json_set(payload_json, '$.guest', json((SELECT json_extract(payload_json, '$.guest') FROM conversations WHERE id = ?)))
        WHERE id = ? AND organization_id = ? AND ${owned}`, params: [input.from, input.from, input.from, input.from, input.into, input.organizationId, ...ownedParams] },
    { query: `UPDATE messages SET conversation_id = ?, sequence = sequence + ? WHERE conversation_id = ? AND ${owned}`, params: [input.into, last.sequence, input.from, ...ownedParams] },
    { query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, host_listing_id, last_read_message_id, archived_at, created_at)
        SELECT ?, organization_id, user_id, role, host_listing_id, last_read_message_id, archived_at, created_at
        FROM conversation_participants WHERE conversation_id = ? AND ${owned}
        ON CONFLICT(conversation_id,user_id) DO UPDATE SET role=excluded.role, host_listing_id=excluded.host_listing_id,
          last_read_message_id=excluded.last_read_message_id, archived_at=excluded.archived_at
        WHERE (excluded.role IS NOT NULL AND conversation_participants.role IS NULL)
          OR (excluded.role='guest' AND conversation_participants.role='member')`, params: [input.into, input.from, ...ownedParams] },
    { query: `DELETE FROM conversation_participants WHERE conversation_id = ? AND ${owned}`, params: [input.from, ...ownedParams] },
    ...['scheduled_guest_messages', 'content_reports', 'payment_checkout_holds', 'conversation_guest_invites'].map(table => ({
      query: `UPDATE ${table} SET conversation_id = ? WHERE conversation_id = ? AND ${owned}`, params: [input.into, input.from, ...ownedParams],
    })),
    { query: `UPDATE google_calendar_event_links SET request_id = ? WHERE request_id = ? AND ${owned}`, params: [input.into, input.from, ...ownedParams] },
    { query: `UPDATE tasks SET subject_id = ?, dedupe_key = 'guest_reply:' || ? || substr(dedupe_key, length('guest_reply:' || ?) + 1)
        WHERE kind = 'guest_reply' AND subject_type = 'conversation' AND subject_id = ? AND ${owned}`, params: [input.into, input.into, input.from, input.from, ...ownedParams] },
    // The booking is the inquiry's conversation's: unlinked from its own, then linked, then its own is gone.
    { query: "UPDATE conversations SET booking_id = NULL WHERE id = ? AND organization_id = ? AND booking_id = ? AND kind = 'booking'", params: [input.from, input.organizationId, input.bookingId] },
    { query: 'UPDATE conversations SET booking_id = ? WHERE id = ? AND organization_id = ? AND booking_id IS NULL AND changes() = 1', params: [input.bookingId, input.into, input.organizationId] },
    ...reconcileGuestListingParticipants(input.organizationId, { query: 'c.id = ? AND c.booking_id = ?', params: [input.into, input.bookingId] }),
    { query: 'DELETE FROM conversations WHERE id = ? AND organization_id = ? AND booking_id IS NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ?)', params: [input.from, input.organizationId, input.from] },
  ]
}

/**
 * An inquiry and a stay share one immutable timeline; conflicting existing timelines are never discarded.
 * A stay's conversation whose provider address belongs to its reservation's
 * earlier booking id (a retired Channex account) moves to the new thread.
 */
async function adoptThread(db: DbClient, env: ChannelEnv, home: HomeMapping, thread: ChannexMessageThread): Promise<ChannelThreadMapping> {

  const mapped = await queryFirst<ChannelThreadMapping>(db, "SELECT * FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ?", [thread.id])
  if (mapped && (mapped.organization_id !== home.organization_id || mapped.product_id !== home.product_id)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider conversation belongs to another home', 'relationships.property')
  if (mapped?.external_booking_id && mapped.external_booking_id !== thread.bookingId) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The provider changed an existing conversation booking association; review its timeline', 'relationships.booking')
  if (thread.bookingId && await queryFirst(db, "SELECT conversation_id FROM channel_threads WHERE provider = 'channex' AND external_booking_id = ? AND external_thread_id <> ?", [thread.bookingId, thread.id])) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The booking is already associated with another provider conversation', 'relationships.booking')
  const stay = thread.bookingId === null ? null : await threadStay(db, env, home, thread.bookingId)
  if (stay && (stay.organization_id !== home.organization_id || stay.product_id !== home.product_id)) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The provider booking belongs to another home', 'relationships.booking')
  // The conversation the reservation opened when it landed joins the inquiry's, while nobody has written in it.
  // Any other timeline of the stay is its own, and two are reconciled by a person, never merged here.
  const joining = mapped && stay && mapped.conversation_id !== stay.conversation_id ? stay : null
  // Nobody has written in it: no one's words, only what KrabiClaw recorded about the booking.
  if (joining && !await queryFirst(db, `SELECT 1 FROM conversations opened WHERE opened.id = ? AND opened.booking_id = ?
      AND NOT EXISTS (SELECT 1 FROM messages written WHERE written.conversation_id = opened.id AND (written.author_kind <> 'krabiclaw' OR written.event_name IN ('${MIRRORED_EVENT}', '${SCHEDULED_MESSAGE_EVENT}')))
      AND NOT EXISTS (SELECT 1 FROM channel_threads WHERE conversation_id = opened.id)`, [joining.conversation_id, joining.id])) {
    fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The inquiry and stay already have separate conversations; reconcile them without discarding either timeline', 'conversation_id')
  }
  const requestId = mapped?.conversation_id ?? stay?.conversation_id ?? crypto.randomUUID()
  const addressed = await queryFirst<ChannelThreadMapping>(db, "SELECT * FROM channel_threads WHERE conversation_id = ? AND external_thread_id <> ?", [requestId, thread.id])
  const retired = !mapped && stay?.conversation_id === requestId && addressed?.external_booking_id != null && addressed.external_booking_id !== thread.bookingId ? addressed : null
  if (addressed && !retired) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The stay conversation already has another provider address', 'conversation_id')
  const now = new Date().toISOString()
  const joined = joining ? await joinBookingConversationQueries(db, { organizationId: home.organization_id, bookingId: joining.id, from: joining.conversation_id, into: requestId, now }) : []
  await executeBatch(db, [...joined, ...(retired ? [{
    query: `UPDATE channel_threads SET external_thread_id = ?, external_booking_id = ?, moved_from_thread_id = external_thread_id, provider_updated_at = ?, updated_at = ?
      WHERE provider = 'channex' AND external_thread_id = ? AND conversation_id = ? AND organization_id = ? AND product_id = ?`,
    params: [thread.id, thread.bookingId, thread.updatedAt, now, retired.external_thread_id, requestId, home.organization_id, home.product_id],
  }] : []), {
    // A guest who has not booked yet is known only by the channel's title; their account comes with the booking.
    query: `INSERT INTO conversations (id, kind, organization_id, location_id, user_id, payload_json, last_message_at, created_at)
      SELECT ?, 'booking', ?, ?, NULL, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ?)`,
    params: [requestId, home.organization_id, home.location_id, JSON.stringify({ participant: { kind: 'channel', title: thread.title }, guest: { name: null, email: null, phone: null }, ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }), now, now, requestId, thread.id],
  }, initialConversationParticipants(requestId, home.organization_id), {
    query: `INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, conversation_id, external_booking_id, provider_updated_at, created_at, updated_at)
      SELECT 'channex', ?, ?, ?, r.id, ?, ?, ?, ? FROM conversations r WHERE r.id = ? AND r.organization_id = ? AND r.kind = 'booking'
        AND (CASE WHEN r.booking_id IS NULL THEN r.location_id = ?
          ELSE EXISTS (SELECT 1 FROM bookings b WHERE b.id = r.booking_id AND b.organization_id = r.organization_id AND coalesce(b.booked_product_id, b.product_id) = ?) END)
      ON CONFLICT (provider, external_thread_id) DO UPDATE SET external_booking_id = excluded.external_booking_id,
        provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at
      WHERE channel_threads.organization_id = excluded.organization_id AND channel_threads.product_id = excluded.product_id
        AND channel_threads.conversation_id = excluded.conversation_id`,
    params: [thread.id, home.organization_id, home.product_id, thread.bookingId, thread.updatedAt, now, now, requestId, home.organization_id, home.location_id, home.product_id],
  }, {
    // The channel's title is its conversation's participant, added to the stay's own conversation as it is adopted.
    query: `UPDATE conversations SET payload_json = json_set(payload_json, '$.participant', json_object('kind', 'channel', 'title', ?))
      WHERE id = ? AND organization_id = ? AND (json_type(payload_json, '$.participant') IS NULL OR json_extract(payload_json, '$.participant.kind') = 'channel')
        AND EXISTS (SELECT 1 FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ? AND conversation_id = conversations.id)`,
    params: [thread.title, requestId, home.organization_id, thread.id],
  }, initialListingParticipants(home.organization_id, requestId)], { operation: 'Adopt channel guest conversation' })
  const saved = await queryFirst<ChannelThreadMapping>(db, "SELECT * FROM channel_threads WHERE provider = 'channex' AND external_thread_id = ?", [thread.id])
  if (!saved || saved.organization_id !== home.organization_id || saved.product_id !== home.product_id) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The channel conversation could not be associated atomically', 'conversation_id')
  if (stay) {
    const linked = await queryFirst<{ id: string }>(db, "SELECT id FROM conversations WHERE booking_id = ? AND kind = 'booking'", [stay.id])
    if (linked?.id !== saved.conversation_id) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The stay conversation changed during association', 'conversation_id')
  }
  return saved
}

async function mirrorMessage(db: DbClient, env: ChannelEnv, mapping: ChannelThreadMapping, message: ChannexMessage): Promise<void> {
  if (message.threadId !== mapping.external_thread_id) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The message belongs to another conversation', 'relationships.message_thread')
  const alreadySent = async () => {
    const delivery = await getDeliveryByProviderMessageId(db, 'channex', message.id)
    if (!delivery) return false
    const owner = delivery.message_id ? await getMessage(db, delivery.message_id) : null
    if (owner?.conversation_id !== mapping.conversation_id) fail(409, 'CHANNEL_MESSAGE_ID_CONFLICT', 'The provider message is recorded in another conversation', 'message.id')
    if (message.sender !== 'property') fail(409, 'CHANNEL_MESSAGE_ID_CONFLICT', 'The provider assigned an outbound reply ID to a different sender', 'message.sender')
    return true
  }
  if (await alreadySent()) return
  const authorKind = message.sender === 'guest' ? 'guest' : message.sender === 'property' ? 'member' : 'krabiclaw'
  // A moved conversation's new account delivers its Airbnb history again under
  // new ids: the same sender, Airbnb timestamp, text and attachment count is a
  // message the conversation already has.
  if (mapping.moved_from_thread_id !== null && !await findMessageByDedupeKey(db, `channex-message:${message.id}`)
    && await queryFirst(db, `SELECT id FROM messages WHERE conversation_id = ? AND event_name = '${MIRRORED_EVENT}' AND author_kind = ? AND body IS ?
      AND json_extract(payload_json, '$.provider_inserted_at') = ? AND json_array_length(payload_json, '$.attachments') = ?`,
    [mapping.conversation_id, authorKind, message.text, message.insertedAt, message.attachments.length])) return
  const entry = await appendMessage(db, {
    // A channel's guest and host write on Airbnb, not as a KrabiClaw account; Airbnb Support is relayed by KrabiClaw.
    conversationId: mapping.conversation_id, authorKind, authorUserId: null,
    channel: 'airbnb', body: message.text, eventName: MIRRORED_EVENT, dedupeKey: `channex-message:${message.id}`,
    guard: { sql: "c.organization_id = ? AND NOT EXISTS (SELECT 1 FROM guest_thread_deliveries WHERE provider = 'channex' AND provider_message_id = ?)",
      params: [mapping.organization_id, message.id] },
    // This occurrence is the local mirroring operation. Provider timestamps are
    // retained exactly as Channex sent them: zoneless UTC.
    payload: { provider_message_id: message.id, provider_inserted_at: message.insertedAt, provider_updated_at: message.updatedAt,
      attachments: message.attachments, ...(message.meta === undefined ? {} : { meta: message.meta }) },
  }, conversationTaskQueries(mapping.conversation_id, new Date().toISOString())).catch(async (error: unknown) => {
    if (error instanceof MessageDedupeConflictError) fail(409, 'CHANNEL_MESSAGE_ID_CONFLICT', 'The provider message ID differs from its immutable recorded fact; review the conversation', 'message.id')
    if (await alreadySent()) return null
    throw error
  })
  if (entry) await mirrorMessagePhotos(db, env, mapping.organization_id, entry.id, message.attachments).catch(async (error: unknown) => {
    if (!await alreadySent()) throw error
  })
}

/**
 * Airbnb's photos, kept as our own media on the message they arrived with, so
 * the conversation draws them inline and its gallery reads them. A Channex
 * attachment link answers with a redirect to a signed download; the file is
 * read once, when the message lands, and a message mirrored again finds its
 * photos already placed. A file that is not a photo is not kept.
 */
async function mirrorMessagePhotos(db: DbClient, env: ChannelEnv, organizationId: string, entryId: string, links: string[]): Promise<void> {
  if (!links.length || (await listMessagePhotos(db, 'message', [entryId])).has(entryId)) return
  const files: MessagePhoto[] = []
  for (const link of links) {
    const response = await fetch(link)
    if (!response.ok) fail(502, 'CHANNEL_ATTACHMENT_UNAVAILABLE', `Channex answered ${response.status} for a message attachment`, 'attachments')
    // A file larger than a message photo is not kept, so it is never read past that size.
    const bytes = await boundedBody(response, MAX_IMAGE_BYTES)
    if (bytes) files.push({ filename: new URL(link).pathname.split('/').pop()!, bytes })
  }
  await attachGuestPhotos(db, env, organizationId, entryId, sortGuestFiles(files).photos)
}

/** The response's body, or null once it is larger than `limit`, read no further than that. */
async function boundedBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  for (let chunk = reader ? await reader.read() : { done: true as const, value: undefined }; !chunk.done; chunk = await reader!.read()) {
    total += chunk.value.byteLength
    if (total > limit) {
      await reader!.cancel()
      return null
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function mirrorChannexThread(db: DbClient, env: ChannelEnv, threadId: string, expectedPropertyId: string, assignedBookingId?: string, expectedMessageId?: string): Promise<{ status: 'mirrored'; conversation_id: string; messages: number } | { status: 'ignored_disconnected' }> {
  const home = await homeMapping(db, expectedPropertyId)
  if (!home || home.enabled !== 1) return { status: 'ignored_disconnected' }
  const thread = await getChannexThread(env, threadId)
  if (thread.propertyId !== expectedPropertyId || (thread.channelId !== null && thread.channelId !== home.channel_id)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider conversation is outside its local property mapping', 'relationships.property')
  if (assignedBookingId !== undefined && thread.bookingId !== assignedBookingId) fail(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The assignment event does not match the provider conversation', 'payload.booking_id')
  const messages = await listChannexMessages(env, threadId)
  if (expectedMessageId !== undefined && !messages.some(message => message.id === expectedMessageId)) fail(409, 'CHANNEL_MESSAGE_NOT_READY', 'The provider conversation does not yet contain the webhook message', 'payload.id')
  const mapping = await adoptThread(db, env, home, thread)
  // The provider query explicitly asks for ascending order. Keep its order; do not invent an absolute
  // ordering by converting offset-free timestamps through the server's timezone.
  for (const message of messages) await mirrorMessage(db, env, mapping, message)
  await publishConversationEvent(env, db, { conversationId: mapping.conversation_id, type: 'MESSAGE_CREATE' })
  // A booked conversation is the stay's conversation: its scheduled messages
  // follow the adopted conversation, and an open stay screen learns of the link.
  const stay = mapping.external_booking_id === null ? null : await queryFirst<{ id: string; version: number }>(db,
    `SELECT b.id, b.version FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.organization_id = b.organization_id
      WHERE b.provider = 'channex' AND b.external_booking_id = ? AND b.organization_id = ? AND b.product_id = ? AND c.id = ?`,
    [mapping.external_booking_id, mapping.organization_id, mapping.product_id, mapping.conversation_id])
  if (stay) {
    await planSourceMessages(db, mapping.organization_id, stay.id)
    await publishStayInvalidation(env, { type: 'stay.changed', organization_id: mapping.organization_id, location_id: home.location_id, product_id: mapping.product_id, booking_id: stay.id }, { version: stay.version })
  }
  return { status: 'mirrored', conversation_id: mapping.conversation_id, messages: messages.length }
}

/**
 * Webhooks are pull triggers; guest data in their payload is never an authority.
 *
 * A `message` event is Channex telling us a guest wrote ("triggered when new
 * chat message from a guest is registered at Channex"), so the message it
 * names is the one the owners are told about, once its mirrored entry says a
 * guest sent it. An `inquiry` event is a guest asking about dates before
 * booking: the owners are told the dates and Airbnb's reply deadline, read from
 * the live feed event it names, beside the alert for its first message. A
 * backfill and a booking assignment alert nothing; a conversation's history
 * arrives through them. A redelivered event finds the same entry, whose alert
 * receipts send nothing twice.
 */
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
  const messageId = body.event === 'message' ? required(payload.id, 'payload.id') : undefined
  const inquiryId = body.event === 'inquiry' ? required(payload.live_feed_event_id, 'payload.live_feed_event_id') : undefined
  const mirrored = await mirrorChannexThread(db, env, threadId, propertyId,
    body.event === 'message_thread_booking_assigned' ? required(payload.booking_id, 'payload.booking_id') : undefined, messageId)
  if (mirrored.status !== 'mirrored') return mirrored
  if (inquiryId !== undefined) {
    // The inquiry's own facts come from the event Channex holds, not the webhook body.
    const inquiry = await readAirbnbInquiry(env, inquiryId)
    if (inquiry.propertyId !== propertyId || inquiry.messageThreadId !== threadId) fail(409, 'CHANNEL_INQUIRY_MISMATCH', 'The inquiry belongs to another conversation', 'payload.live_feed_event_id')
    // Channex raises a new inquiry event each time the conversation moves (the
    // host's reply raised Derek's a second time), so an inquiry is one per
    // conversation and dates: a later event for the same dates is the same
    // inquiry, recorded on the conversation and alerted once. It is what the
    // guest asked for, not a message.
    const asked = await queryFirst<{ inquiry: string | null }>(db, "SELECT json_extract(payload_json, '$.inquiry') AS inquiry FROM conversations WHERE id = ?", [mirrored.conversation_id])
    if (!asked) fail(500, 'CHANNEL_THREAD_MISSING', 'The mirrored conversation could not be read', 'conversation_id')
    const recorded = asked.inquiry ? JSON.parse(asked.inquiry) as { live_feed_event_id: string; check_in_date: string; check_out_date: string } : null
    const sameDates = recorded?.check_in_date === inquiry.checkInDate && recorded.check_out_date === inquiry.checkOutDate
    // The same event redelivered finds its own record and its alert, whose receipts send nothing twice.
    if (sameDates && recorded.live_feed_event_id !== inquiry.id) return mirrored
    if (!sameDates) {
      await executeBatch(db, [{
        query: "UPDATE conversations SET payload_json = json_set(payload_json, '$.inquiry', json(?)) WHERE id = ? AND kind = 'booking'",
        params: [JSON.stringify({ live_feed_event_id: inquiry.id, check_in_date: inquiry.checkInDate, check_out_date: inquiry.checkOutDate, nights: inquiry.nights,
          adults: inquiry.adults, children: inquiry.children, infants: inquiry.infants, pets: inquiry.pets, respond_by: inquiry.respondBy }), mirrored.conversation_id],
      }], { operation: 'Record channel inquiry' })
    }
    // The alert is the guest's message the inquiry came with: its receipts are that message's.
    const message = await queryFirst<{ id: string }>(db, "SELECT id FROM messages WHERE conversation_id = ? AND author_kind = 'guest' ORDER BY sequence DESC LIMIT 1", [mirrored.conversation_id])
    if (!message) fail(409, 'CHANNEL_MESSAGE_NOT_READY', 'The inquiry has no guest message yet', 'payload.live_feed_event_id')
    await notifyAirbnbInquiry(env, db, { threadId: mirrored.conversation_id, messageId: message.id, inquiry })
    return mirrored
  }
  if (messageId === undefined) return mirrored
  // A moved conversation's history redelivered under new ids records no entry: there is nothing new to tell.
  const entry = await findMessageByDedupeKey(db, `channex-message:${messageId}`)
  // The guest's and Airbnb Support's messages alert the owners; the host's own Airbnb messages do not.
  if (!entry || (entry.author_kind !== 'guest' && !isAirbnbSupportMessage(entry)) || entry.conversation_id !== mirrored.conversation_id) return mirrored
  // An inquiry opens with the guest's message, and Channex raises the inquiry
  // event just after it (every unbooked conversation with a guest message in
  // production has one, recorded after that message). The inquiry's alert
  // carries the message, so its opening message is told once, there.
  // A message of photos alone is not carried by the inquiry's alert, so it keeps its own.
  if (entry.author_kind === 'guest' && entry.body?.trim() && await queryFirst(db, `SELECT 1 FROM channel_threads ct WHERE ct.conversation_id = ? AND ct.external_booking_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = ct.conversation_id AND e.author_kind = 'guest' AND e.sequence < ?)`,
    [entry.conversation_id, entry.sequence])) return mirrored
  const request = await getGuestRequest(db, mirrored.conversation_id)
  if (!request) fail(500, 'CHANNEL_THREAD_MISSING', 'The mirrored conversation could not be read', 'conversation_id')
  const summary = await requestSummary(db, request)
  const attachments = (parseMessagePayload(entry).attachments as unknown[] | undefined)?.length ?? 0
  // A message with neither words nor a file says nothing to alert about.
  if (!entry.body?.trim() && !attachments) return mirrored
  await notifyGuestThreadReply(env, db, {
    organizationId: request.organization_id, locationId: request.location_id,
    threadId: request.id, messageId: entry.id, submissionType: 'stay', submissionId: request.id,
    participantLabel: summary.participantLabel, guestEmail: summary.guestEmail, guestPhone: summary.guestPhone,
    inboundChannel: 'airbnb',
  })
  return mirrored
}

export async function backfillChannexMessages(db: DbClient, env: ChannelEnv, propertyId: string, organizationId: string): Promise<{ threads: number }> {
  const home = await homeMapping(db, propertyId)
  if (!home || home.organization_id !== organizationId || home.enabled !== 1) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'Connect this home before importing conversations', 'property_id')
  const threads = await listChannexThreads(env, propertyId)
  for (const thread of threads) await mirrorChannexThread(db, env, thread.id, propertyId)
  return { threads: threads.length }
}

/** Channel replies use the same canonical ledger, photo owner and delivery receipts as every inbox reply. */
export type ChannelReplyOutcome = { ok: true; message: MessageRow } | {
  ok: false; status: 409 | 502; code: 'CHANNEL_REPLY_FAILED'; field: 'delivery.status'; message: string
  mutation_applied: true; operation_completed: false; request_id: string; retry_with_same_idempotency_key: true
  provider_error?: ChannexError['data']
}

export async function replyThroughChannex(db: DbClient, env: ChannexEnv & UploadResolvedMediaInput['env'] & { MEDIA_BUCKET?: R2Bucket }, input: {
  mapping: ChannelThreadMapping; body: string; guard: ConversationGuard
  /** Register a new send only after Channex validates the conversation mapping. */
  commit: () => Promise<MessageRow>
  receipt: GuestThreadDeliveryRow | null
  deliveryId: string
  photoCount: number
}): Promise<ChannelReplyOutcome> {
  const { deliveryId } = input
  if (input.receipt && isDeliverySent(input.receipt)) {
    const entry = await input.commit()
    if (!input.receipt.provider_message_id?.trim()) fail(500, 'CHANNEL_RECEIPT_INVALID', 'A successful channel reply has no provider message ID', 'delivery.provider_message_id')
    await reconcileConversationTasks(db, input.mapping.conversation_id)
    return { ok: true, message: entry }
  }
  // Whether the home may still be written to is the caller's (guestReplyDestination);
  // proven accepted replays above remain safe even after it is disconnected.
  const home = await queryFirst<HomeMapping>(db, `SELECT m.*, c.location_id FROM product_channel_mappings m
    JOIN product_stay_configs c ON c.product_id = m.product_id AND c.organization_id = m.organization_id
    WHERE m.provider = 'channex' AND m.organization_id = ? AND m.product_id = ?`, [input.mapping.organization_id, input.mapping.product_id])
  if (!home) throw new Error(`Channel thread ${input.mapping.conversation_id} names a home with no Channex mapping`)
  const current = await getChannexThread(env, input.mapping.external_thread_id)
  if (current.propertyId !== home.property_id || (current.channelId !== null && current.channelId !== home.channel_id)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider conversation is outside its local property mapping', 'relationships.property')
  const entry = await input.commit()
  const receipt = input.receipt ?? await getDeliveryById(db, deliveryId)
  if (!receipt || receipt.message_id !== entry.id) fail(500, 'CHANNEL_RECEIPT_INVALID', 'The reply has no matching delivery receipt', 'delivery')
  if (isDeliverySent(receipt)) {
    if (!receipt.provider_message_id?.trim()) fail(500, 'CHANNEL_RECEIPT_INVALID', 'A successful channel reply has no provider message ID', 'delivery.provider_message_id')
    await reconcileConversationTasks(db, input.mapping.conversation_id)
    return { ok: true, message: entry }
  }
  let photo: ReturnType<typeof assertMessagePhotos>[number] | undefined
  if (input.photoCount) {
    const placed = (await readMediaPlacements(db, { organizationId: input.mapping.organization_id, ownerType: 'message', ownerIds: [entry.id], slot: 'attachments' })).get(entry.id) ?? []
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
  // One send at a time per reply: a pending or failed reply is claimed; one already being sent is not.
  const claim = await execute(db, `UPDATE guest_thread_deliveries SET status = 'sending', error = NULL, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'failed')
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = ? AND (${input.guard.sql}))`,
  [new Date().toISOString(), deliveryId, input.mapping.conversation_id, ...input.guard.params])
  if (claim.meta.changes !== 1) {
    await assertMessageWriteAccess(db, input.mapping.conversation_id, input.guard)
    return { ok: false, status: 409, code: 'CHANNEL_REPLY_FAILED', field: 'delivery.status', message: 'This reply is already being sent.',
      mutation_applied: true, operation_completed: false, request_id: input.mapping.conversation_id, retry_with_same_idempotency_key: true }
  }
  // Store acceptance and remove any copy that arrived before the provider replied
  // in one batch. Future webhooks see the same receipt at their write boundary.
  let message: ChannexMessage
  try {
    message = await sendChannexMessage(env, input.mapping.external_thread_id, input.body, photo)
  } catch (error) {
    await recordDeliveryOutcome(db, { deliveryId, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    return { ok: false, status: 502, code: 'CHANNEL_REPLY_FAILED', field: 'delivery.status', message: 'This reply was not sent. You can retry the same reply.',
      mutation_applied: true, operation_completed: false, request_id: input.mapping.conversation_id, retry_with_same_idempotency_key: true,
      ...(error instanceof ChannexError ? { provider_error: error.data } : {}) }
  }
  const echo = `channex-message:${message.id}`
  const echoed = "SELECT id FROM messages WHERE dedupe_key = ? AND conversation_id = ? AND author_kind = 'member' AND event_name = ?"
  const echoParams = [echo, input.mapping.conversation_id, MIRRORED_EVENT]
  await recordDeliveryOutcome(db, { deliveryId, status: 'accepted', providerMessageId: message.id }, [
    { query: `UPDATE conversation_participants SET last_read_message_id = ? WHERE conversation_id = ? AND last_read_message_id IN (${echoed})`,
      params: [entry.id, input.mapping.conversation_id, ...echoParams] },
    { query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'message' AND owner_id IN (${echoed})`,
      params: [input.mapping.organization_id, ...echoParams] },
    { query: `DELETE FROM messages WHERE id IN (${echoed})`, params: echoParams },
  ])
  await reconcileConversationTasks(db, input.mapping.conversation_id)
  return { ok: true, message: entry }
}
