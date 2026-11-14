import { HTTPError } from 'nitro'
import { MessageDedupeConflictError, MessageStateConflictError, appendMessage, conversationAccessDenied, conversationMessageGuard, type ConversationRow, type MessageRow, type ParticipantRole } from './conversations'
import { receiveGuestWebReply } from './guest-threads/inbound-email'
import { sendGuestThreadReply, type OperationFailure } from './guest-threads/operations'
import { MAX_MESSAGE_PHOTOS, MessagePhotoRejection, messagePhotoCount, messagePhotoHashes, type MessagePhotoInput } from './guest-threads/attachments'
import { deliverTeamMessage, teamMessageKey } from './team-messages'
import { projectSentConversationMessage } from './conversation-history'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { creationRequestHash } from '~/server/utils/organization-events'
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
    if (conversation.kind === 'team') {
      if (role !== 'member') conversationAccessDenied()
      const id = crypto.randomUUID()
      const requestHash = await creationRequestHash({
        body, photos: Array.isArray(photos) ? await messagePhotoHashes(photos) : { sourceIds: photos.sourceIds },
      })
      message = await appendMessage(db, {
        id, conversationId: threadId, authorKind: 'member', authorUserId: userId, body,
        dedupeKey: teamMessageKey(threadId, idempotencyKey), payload: { request_hash: requestHash },
        guard: conversationMessageGuard(conversation, userId, role),
      }, { organizationId: conversation.organization_id, env, photos, uploaderUserId: userId })
      await deliverTeamMessage(env, db, message, senderName, count, message.id === id)
    } else if (role === 'guest') {
      message = await receiveGuestWebReply(env, { conversation, userId, body, photos, idempotencyKey })
    } else {
      const outcome = await sendGuestThreadReply(db, {
        conversation, threadId, organizationId: conversation.organization_id,
        actorUserId: userId, body, photos, idempotencyKey, env,
      })
      if (outcome.ok || outcome.reason === 'delivery_failed') {
        try {
          await publishConversationEvent(env, db, {
            conversationId: threadId, type: outcome.ok ? 'MESSAGE_CREATE' : 'MESSAGE_UPDATE',
            message: outcome.ok ? { id: outcome.message.id, sequence: outcome.message.sequence } : undefined,
          })
        } catch (cause) {
          throw new HTTPError({
            statusCode: 503, message: 'The reply was saved, but live updates failed. Retry with the same message key.',
            data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, conversation_id: threadId }, cause,
          })
        }
      }
      assertConversationOperation(outcome)
      message = outcome.message
    }
  } catch (error) {
    if (error instanceof MessagePhotoRejection) throw new HTTPError({ statusCode: 400, message: error.message, data: { code: 'INVALID_PHOTO', field: 'photos' } })
    if (error instanceof MessageDedupeConflictError) throw new HTTPError({ statusCode: 409, message: error.message, data: { code: 'IDEMPOTENCY_KEY_REUSED', field: 'idempotency_key' } })
    if (error instanceof MessageStateConflictError) conversationAccessDenied()
    throw error
  }
  if (!providerReply) return projectSentConversationMessage(db, { message, userId, role, conversation }, senderName)
}
