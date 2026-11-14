import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { queryFirst } from '~/server/db'

// Conversation operations here; booking status changes use the versioned booking API.
import { jsonResponse } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { moderateGuestThread, operationDedupeKey, sendGuestThreadReply } from '~/server/domain/guest-threads/operations'
import { assertConversationOperation } from '~/server/domain/send-conversation-message'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { MEMBER_REPLY_EVENT } from '~/server/domain/conversations'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const threadId = getRouterParam(event, 'conversation_id')
  const action = getRouterParam(event, 'action')
  if (!organizationId || !threadId || !action) return jsonResponse({ error: 'Missing params', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })
  if (action !== 'retry' && action !== 'report' && action !== 'block' && action !== 'unblock') {
    return jsonResponse({ error: `Unknown action "${action}"`, code: 'UNKNOWN_ACTION', field: 'action' }, { status: 400 })
  }

  const { env, db, principal, conversation } = await memberConversation(event, organizationId, threadId, true)

  const body = await readBody<unknown>(event)
  const field = (name: string) => {
    const value = body && typeof body === 'object' && name in body ? Reflect.get(body, name) : undefined
    return typeof value === 'string' ? value : undefined
  }
  const headerKey = (event.req.headers.get('idempotency-key')) || (event.req.headers.get('x-idempotency-key'))
  const idempotencyKey = field('idempotency_key') || headerKey || undefined

  if (!idempotencyKey) {
    return jsonResponse({ error: 'Idempotency key is required', code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotency_key' }, { status: 400 })
  }

  // "Try again" on a reply that did not reach the guest is that same reply sent
  // again under its own idempotency key, so a send that did land is not repeated.
  if (action === 'retry') {
    const messageId = field('message_id')
    const entry = messageId ? await queryFirst<{ id: string; body: string | null; dedupe_key: string; photos: number }>(db, `SELECT e.id, e.body, e.dedupe_key,
        (SELECT COUNT(*) FROM media_placements mp WHERE mp.owner_type = 'message' AND mp.owner_id = e.id AND mp.slot = 'attachments' AND mp.status = 'active') AS photos
      FROM messages e WHERE e.id = ? AND e.conversation_id = ? AND e.event_name = '${MEMBER_REPLY_EVENT}'`, [messageId, conversation.id]) : null
    const prefix = operationDedupeKey({ threadId, idempotencyKey: '' })
    if (!entry || !entry.dedupe_key.startsWith(prefix)) return jsonResponse({ error: 'That reply is not in this conversation', code: 'MESSAGE_NOT_FOUND', field: 'message_id' }, { status: 404 })
    if (entry.photos || !entry.body?.trim()) return jsonResponse({ error: 'Send the photo again from the composer', code: 'RETRY_TEXT_ONLY', field: 'message_id' }, { status: 409 })
    const outcome = await sendGuestThreadReply(db, {
      threadId, organizationId, actorUserId: principal.userId, conversation, body: entry.body,
      retryMessageId: entry.id, idempotencyKey: entry.dedupe_key.slice(prefix.length), env,
    })
    const message = outcome.ok ? { id: outcome.message.id, sequence: outcome.message.sequence } : undefined
    if (outcome.ok || outcome.reason === 'delivery_failed') {
      await publishConversationEvent(env, db, { conversationId: threadId, message, type: 'MESSAGE_UPDATE' })
    }
    assertConversationOperation(outcome)
    return jsonResponse({ message })
  }

  // The change is not done until the open inboxes have been told about it.
  const outcome = await moderateGuestThread(db, { conversation, action, actorUserId: principal.userId, idempotencyKey, reason: field('reason'), env })
  assertConversationOperation(outcome)
  await publishConversationEvent(env, db, { conversationId: threadId, type: 'MESSAGE_UPDATE' })
  return jsonResponse({})
})
