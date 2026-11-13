import { HTTPError } from 'nitro'
import { conversationAccessDenied, getMessage, participantGuard, type ConversationRow, type ParticipantRole } from './conversations'
import { receiveGuestWebReply } from './guest-threads/inbound-email'
import { executeGuestThreadOperation, type OperationOutcome } from './guest-threads/operations'
import { MessagePhotoRejection, type MessagePhotoInput } from './guest-threads/attachments'
import { sendTeamMessage } from './team-messages'
import { projectSentConversationMessage, projectTeamConversationMessage } from './conversation-history'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { memberAccessPrincipal, resolveMembership, type MemberAccessPrincipal } from '~/server/utils/member-access'
import type { ConversationMessage } from '~/shared/messages-contract'
import type { CloudflareEnv } from '~/server/utils/auth'

export function assertConversationOperation(outcome: OperationOutcome): asserts outcome is Extract<OperationOutcome, { ok: true }> {
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
  principal?: MemberAccessPrincipal
}

type ProviderReply = MessageSend & { role: 'member'; providerReply: true }

/** The caller speaks on an authorized seat. The conversation determines its delivery. */
export function sendConversationMessage(env: CloudflareEnv, input: ProviderReply): Promise<void>
export function sendConversationMessage(env: CloudflareEnv, input: MessageSend): Promise<ConversationMessage>
export async function sendConversationMessage(env: CloudflareEnv, input: MessageSend | ProviderReply): Promise<ConversationMessage | void> {
  const { conversation, role, userId, senderName, photos, idempotencyKey } = input
  const body = input.body.trim()
  const count = Array.isArray(photos) ? photos.length : photos.sourceIds.length
  const providerReply = 'providerReply' in input
  const validKey = providerReply && conversation.kind !== 'team'
    ? /^(?:email|whatsapp):[^\r\n]{1,1015}$/u.test(idempotencyKey)
    : /^[a-zA-Z0-9_-]{8,128}$/u.test(idempotencyKey)
  if (!validKey) {
    throw new HTTPError({ statusCode: 400, message: 'A valid idempotency key is required', data: { code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotency_key' } })
  }
  if (!body && !count) throw new HTTPError({ statusCode: 400, message: 'Write a message or add a photo', data: { code: 'EMPTY_MESSAGE', field: 'body' } })
  if (!providerReply && body.length > 5000) throw new HTTPError({ statusCode: 422, message: 'A message can be at most 5000 characters', data: { code: 'MESSAGE_TOO_LONG', field: 'body' } })
  const threadId = conversation.id
  const db = env.DB
  if (role === 'guest') {
    try {
      const message = await receiveGuestWebReply(env, { conversation, userId, body, photos: Array.isArray(photos) ? photos : await photos.resolve(), idempotencyKey })
      return await projectSentConversationMessage(db, { message, userId, role, conversation }, senderName)
    } catch (error) {
      if (error instanceof MessagePhotoRejection) throw new HTTPError({ statusCode: 400, message: error.message, data: { code: 'INVALID_PHOTO', field: 'photos' } })
      throw error
    }
  }
  if (conversation.kind === 'team') {
    const membership = input.principal ?? await resolveMembership(env, { organizationId: conversation.organization_id, userId })
    if (!membership) conversationAccessDenied()
    const principal = input.principal ?? memberAccessPrincipal(membership, { env })
    const { message } = await sendTeamMessage(env, db, principal, threadId, { body, photos, idempotency_key: idempotencyKey, senderName })
    if (!providerReply) return projectTeamConversationMessage(message, 'You')
    return
  }

  const outcome = await executeGuestThreadOperation(db, {
    conversation, threadId, organizationId: conversation.organization_id, action: 'reply',
    actorUserId: userId, messageGuard: participantGuard('c', userId, role), body, photos, idempotencyKey, env,
    financialWritesAllowed: false,
  })
  if (outcome.ok || outcome.reason === 'delivery_failed') {
    try {
      await publishConversationEvent(env, db, { conversationId: threadId, type: outcome.ok ? 'MESSAGE_CREATE' : 'MESSAGE_UPDATE', message: outcome.ok ? outcome.message : undefined })
    } catch (cause) {
      throw new HTTPError({
        statusCode: 503, message: 'The reply was saved, but live updates failed. Retry with the same message key.',
        data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, conversation_id: threadId }, cause,
      })
    }
  }
  assertConversationOperation(outcome)
  if (providerReply) return
  if (!outcome.message) throw new Error('Sending did not return the committed message')
  const message = await getMessage(db, outcome.message.id)
  if (!message) throw new Error('The sent message could not be read')
  return projectSentConversationMessage(db, { message, userId, role, conversation }, senderName)
}
