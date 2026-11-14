import { HTTPError } from 'nitro'
import { MessageDedupeConflictError, MessageStateConflictError, appendChatMessage, conversationAccessDenied, type ConversationRow, type MessageRow, type ParticipantRole } from './conversations'
import { deliverGuestReply, type OperationFailure } from './guest-threads/operations'
import { MAX_MESSAGE_PHOTOS, MessagePhotoRejection, messagePhotoCount, messagePhotoHashes, type MessagePhotoInput } from './guest-threads/attachments'
import type { InboundGuestEmail } from './guest-threads/inbound-email'
import { notifyTeamParticipants, teamMessageKey } from './team-messages'
import { projectSentConversationMessage } from './conversation-history'
import { participantLabel, validateGuestRequest, type GuestRequest } from './requests'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { creationRequestHash } from '~/server/utils/organization-events'
import { notifyGuestThreadReply } from '~/server/utils/notifications'
import type { ConversationMessage } from '~/shared/messages-contract'
import type { CloudflareEnv } from '~/server/utils/auth'

export function assertConversationOperation<T extends { ok: true } | OperationFailure>(outcome: T): asserts outcome is Extract<T, { ok: true }> {
  if (outcome.ok) return
  if ('code' in outcome) throw new HTTPError({ statusCode: outcome.status, message: outcome.message, data: { ...outcome } })
  const failures = {
    thread_not_found: ['THREAD_NOT_FOUND', 'Conversation not found', 'conversation_id'],
    source_not_found: ['THREAD_NOT_FOUND', 'Conversation not found', 'conversation_id'],
    invalid_transition: ['INVALID_TRANSITION', 'message' in outcome ? outcome.message : 'The conversation changed', 'action'],
    empty_body: ['EMPTY_MESSAGE', 'Write a message or add a photo', 'body'],
    missing_idempotency_key: ['MISSING_IDEMPOTENCY_KEY', 'An idempotency key is required', 'idempotency_key'],
    invalid_photo: ['INVALID_PHOTO', 'message' in outcome ? outcome.message : 'Invalid photo', 'photos'],
  } as const
  const [code, message, field] = failures[outcome.reason]
  throw new HTTPError({ statusCode: outcome.status, message, data: { code, field } })
}

type MessageSend = {
  conversation: ConversationRow
  role: ParticipantRole
  userId: string
  senderName: string
  body: string
  photos: MessagePhotoInput
  idempotencyKey: string
}

type ProviderReply = MessageSend & { role: 'member'; providerReply: true }

type GuestMessage = { conversation: GuestRequest; body: string; photos: MessagePhotoInput; dedupeKey: string } & (
  | { channel: 'web'; userId: string }
  | { channel: 'email'; unshown: string[]; headers: InboundGuestEmail['headers'] }
  | { channel: 'whatsapp'; unshown: string[] }
)
type LocalMessage = GuestMessage | { channel: null; conversation: ConversationRow; userId: string; senderName: string; body: string; photos: MessagePhotoInput; dedupeKey: string }

async function publishChatMessage(env: CloudflareEnv, conversation: Pick<ConversationRow, 'id' | 'organization_id' | 'location_id' | 'kind'>, type: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE', message?: MessageRow) {
  try {
    await publishConversationEvent(env, env.DB, { conversationId: conversation.id, conversation, type, message: message && { id: message.id, sequence: message.sequence } })
  } catch (cause) {
    throw new HTTPError({
      statusCode: 503, message: 'The message was saved, but live updates failed. Retry with the same message key.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, conversation_id: conversation.id, ...(message && { message_id: message.id }) }, cause,
    })
  }
}

async function deliverLocalMessage(env: CloudflareEnv, input: LocalMessage, append: typeof appendChatMessage): Promise<MessageRow> {
  const { conversation, body, photos, channel, dedupeKey } = input
  const userId = 'userId' in input ? input.userId : null
  const hashes = Array.isArray(photos) ? await messagePhotoHashes(photos) : []
  const payload = channel === null ? {
    request_hash: await creationRequestHash({ body, photos: Array.isArray(photos) ? hashes : { sourceIds: photos.sourceIds } }),
  } : {
    ...('unshown' in input && input.unshown.length ? { unshownFiles: input.unshown } : {}),
    ...(channel === 'web' || hashes.length ? { photos: Array.isArray(photos)
      ? photos.map((photo, index) => ({ filename: photo.filename, sha256: hashes[index] }))
      : { sourceIds: photos.sourceIds } } : {}),
    ...(channel === 'email' ? { email: input.headers } : {}),
  }
  const role = channel === null ? 'member' : 'guest'
  const message = await append(env.DB, {
    conversation, role, authorKind: role, authorUserId: userId ?? conversation.user_id,
    channel, body: channel === null ? body : body || null, dedupeKey, payload,
  }, { env, photos, uploaderUserId: userId })
  if (input.channel === null) {
    await notifyTeamParticipants(env, env.DB, message, input.senderName, messagePhotoCount(photos))
  } else {
    const guest = input.conversation
    await notifyGuestThreadReply(env, env.DB, {
      organizationId: guest.organization_id, locationId: guest.location_id, threadId: guest.id, messageId: message.id, entry: message,
      submissionType: guest.kind, submissionId: guest.id, participantLabel: participantLabel(guest),
      guestEmail: guest.payload.guest.email, guestPhone: guest.payload.guest.phone, inboundChannel: input.channel,
    })
  }
  return message
}

/** One write callback records the saved message, and one command publishes its send outcome. */
async function commitChatMessage(env: CloudflareEnv, conversation: Pick<ConversationRow, 'id' | 'organization_id' | 'location_id' | 'kind'>,
  deliver: (append: typeof appendChatMessage) => Promise<MessageRow>) {
  const id = crypto.randomUUID()
  let committed: MessageRow | undefined
  const append: typeof appendChatMessage = async (db, input, send) => {
    const message = await appendChatMessage(db, { ...input, id }, send)
    committed = message
    if (input.role === 'guest') await publishChatMessage(env, conversation, 'MESSAGE_CREATE', message)
    return message
  }
  let message: MessageRow
  try {
    message = await deliver(append)
  } catch (error) {
    if (committed?.author_kind === 'member' && conversation.kind !== 'team') {
      try {
        await publishChatMessage(env, conversation, 'MESSAGE_UPDATE', committed)
      } catch (publicationError) {
        throw new AggregateError([error, publicationError], 'The reply and its live update both failed', { cause: publicationError })
      }
    }
    throw error
  }
  if (message.author_kind !== 'guest') {
    // A replay normally returns the same result without new work. The create
    // invalidation lets the sender settle its echo by ID and repairs a lost
    // publication; provider receipt changes have their own update events.
    await publishChatMessage(env, conversation, 'MESSAGE_CREATE', message)
  }
  return message
}

/** Verified provider entry points supply their own IDs, mail ancestry and media policy. */
export async function sendGuestProviderMessage(env: CloudflareEnv, input: Exclude<GuestMessage, { channel: 'web' }>): Promise<void> {
  await commitChatMessage(env, input.conversation, append => deliverLocalMessage(env, input, append))
}

/** The caller speaks on an authorized seat. The conversation determines its delivery. */
export function sendConversationMessage(env: CloudflareEnv, input: ProviderReply): Promise<void>
export function sendConversationMessage(env: CloudflareEnv, input: MessageSend): Promise<ConversationMessage>
export async function sendConversationMessage(env: CloudflareEnv, input: MessageSend | ProviderReply): Promise<ConversationMessage | void> {
  const { conversation, role, userId, senderName, photos, idempotencyKey } = input
  const body = input.body.trim()
  const count = messagePhotoCount(photos)
  const providerReply = 'providerReply' in input
  const validKey = providerReply && conversation.kind !== 'team'
    ? /^(?:email|whatsapp):[^\r\n]{1,1015}$/u.test(idempotencyKey)
    : /^[a-zA-Z0-9_-]{8,128}$/u.test(idempotencyKey)
  if (!validKey) {
    throw new HTTPError({ statusCode: 400, message: 'A valid idempotency key is required', data: { code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotency_key' } })
  }
  if (count > MAX_MESSAGE_PHOTOS) throw new HTTPError({ statusCode: 400, message: `A message can carry at most ${MAX_MESSAGE_PHOTOS} photos`, data: { code: 'INVALID_PHOTO', field: 'photos' } })
  if (!body && !count) throw new HTTPError({ statusCode: 400, message: 'Write a message or add a photo', data: { code: 'EMPTY_MESSAGE', field: 'body' } })
  if ((!providerReply || conversation.kind === 'team') && body.length > 5000) throw new HTTPError({ statusCode: 422, message: 'A message can be at most 5000 characters', data: { code: 'MESSAGE_TOO_LONG', field: 'body' } })
  const threadId = conversation.id
  const db = env.DB
  let message: MessageRow
  try {
    message = await commitChatMessage(env, conversation, async append => {
      if (conversation.kind === 'team') {
        if (role !== 'member') conversationAccessDenied()
        return deliverLocalMessage(env, { conversation, userId, senderName, body, photos, channel: null, dedupeKey: teamMessageKey(threadId, idempotencyKey) }, append)
      }
      if (role === 'guest') {
        return deliverLocalMessage(env, { conversation: await validateGuestRequest(db, conversation), userId, body, photos, channel: 'web', dedupeKey: `guest-web-reply:${threadId}:${idempotencyKey}` }, append)
      }
      const outcome = await deliverGuestReply(db, { conversation, threadId, organizationId: conversation.organization_id,
        actorUserId: userId, body, photos, idempotencyKey, env }, append)
      assertConversationOperation(outcome)
      return outcome.message
    })
  } catch (error) {
    if (error instanceof MessagePhotoRejection) throw new HTTPError({ statusCode: 400, message: error.message, data: { code: 'INVALID_PHOTO', field: 'photos' } })
    if (error instanceof MessageDedupeConflictError) throw new HTTPError({ statusCode: 409, message: error.message, data: { code: 'IDEMPOTENCY_KEY_REUSED', field: 'idempotency_key' } })
    if (error instanceof MessageStateConflictError) conversationAccessDenied()
    throw error
  }
  if (!providerReply) return projectSentConversationMessage(db, { message, userId, role, conversation }, senderName)
}
