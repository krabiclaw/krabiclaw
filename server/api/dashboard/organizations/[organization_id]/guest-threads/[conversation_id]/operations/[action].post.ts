import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { parseSuggestionUse, recordSuggestionAccepted, suggestedDraft } from '~/server/domain/suggested-reply'

// Conversation operations here; booking status changes use the versioned booking API.
import { jsonResponse } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { roleAllows } from '~/server/utils/member-access'
import { getInboxThread } from '~/server/domain/guest-threads/inbox'
import { executeGuestThreadOperation, GUEST_THREAD_ACTIONS } from '~/server/domain/guest-threads/operations'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { MEMBER_REPLY_EVENT, assertConversationAccess } from '~/server/domain/conversations'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const threadId = getRouterParam(event, 'conversation_id')
  const action = getRouterParam(event, 'action')
  if (!organizationId || !threadId || !action) return jsonResponse({ error: 'Missing params', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })
  if (!GUEST_THREAD_ACTIONS.has(action)) return jsonResponse({ error: `Unknown action "${action}"`, code: 'UNKNOWN_ACTION', field: 'action' }, { status: 400 })

  const { env, db, principal, conversation } = await memberConversation(event, organizationId, threadId, true)

  // A reply with photos arrives as a form, its photos as `photos` parts in the
  // order they were chosen; every other operation is JSON.
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  const form = multipart ? await event.req.formData() : null
  const body = form ? null : await readBody<unknown>(event)
  const field = (name: string) => {
    const value = form ? form.get(name) : body && typeof body === 'object' && name in body ? Reflect.get(body, name) : undefined
    return typeof value === 'string' ? value : undefined
  }
  const photos = form
    ? await Promise.all(form.getAll('photos').filter((part): part is File => part instanceof File)
        .map(async part => ({ bytes: new Uint8Array(await part.arrayBuffer()), filename: part.name || 'photo' })))
    : []
  const headerKey = (event.req.headers.get('idempotency-key')) || (event.req.headers.get('x-idempotency-key'))
  const idempotencyKey = field('idempotency_key') || headerKey || undefined

  if (!idempotencyKey) {
    return jsonResponse({ error: 'Idempotency key is required', code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotency_key' }, { status: 400 })
  }

  // "Try again" on a reply that did not reach the guest is that same reply sent
  // again under its own idempotency key, so a send that did land is not repeated.
  let retried: { body: string; idempotencyKey: string } | null = null
  if (action === 'retry') {
    const messageId = field('message_id')
    const entry = messageId ? await queryFirst<{ body: string | null; dedupe_key: string; photos: number }>(db, `SELECT e.body, e.dedupe_key,
        (SELECT COUNT(*) FROM media_placements mp WHERE mp.owner_type = 'message' AND mp.owner_id = e.id AND mp.slot = 'attachments' AND mp.status = 'active') AS photos
      FROM messages e WHERE e.id = ? AND e.conversation_id = ? AND e.event_name = '${MEMBER_REPLY_EVENT}'`, [messageId, conversation.id]) : null
    const prefix = `guest-thread-operation:${conversation.id}:`
    if (!entry || !entry.dedupe_key.startsWith(prefix)) return jsonResponse({ error: 'That reply is not in this conversation', code: 'MESSAGE_NOT_FOUND', field: 'message_id' }, { status: 404 })
    if (entry.photos || !entry.body?.trim()) return jsonResponse({ error: 'Send the photo again from the composer', code: 'RETRY_TEXT_ONLY', field: 'message_id' }, { status: 409 })
    retried = { body: entry.body, idempotencyKey: entry.dedupe_key.slice(prefix.length) }
  }

  // A reply that started from a suggested draft says which; it is checked before anything is sent and metered once it is.
  const suggestionUse = action === 'reply' ? parseSuggestionUse(form ? form.get('suggestion') : body && typeof body === 'object' ? Reflect.get(body, 'suggestion') : undefined) : null
  const draft = suggestionUse ? await suggestedDraft(db, { organizationId, threadId: conversation.id, suggestion: suggestionUse }) : null

  const outcome = await executeGuestThreadOperation(db, {
    threadId,
    organizationId,
    action: retried ? 'reply' : action,
    actorUserId: principal.userId,
    conversation,
    principal,
    financialWritesAllowed: await roleAllows({ ...principal, permissions: { payments: ['refund'] } }),
    body: retried ? retried.body : field('body'),
    reason: field('reason'),
    requestId: field('message_id'),
    // Who may change a stay (stayAccessFor): the role that updates operations.
    stayManager: await roleAllows({ ...principal, permissions: { operations: ['update'] } }),
    photos,
    idempotencyKey: retried ? retried.idempotencyKey : idempotencyKey,
    env,
  })

  if (outcome.ok && draft) await recordSuggestionAccepted(db, { organizationId, threadId: conversation.id, userId: principal.userId, body: field('body') ?? '', draft })

  // The change is not done until the open inboxes have been told about it.
  if (outcome.ok || outcome.reason === 'delivery_failed') {
    await publishConversationEvent(env, db, { conversationId: conversation.id, message: outcome.ok ? outcome.message : undefined, type: ['reply', 'confirm', 'reject', 'cancel', 'no_show', 'retry'].includes(action) ? 'MESSAGE_CREATE' : 'MESSAGE_UPDATE' })
  }

  if (outcome.ok === false) {
    if (outcome.reason === 'thread_not_found' || outcome.reason === 'source_not_found') {
      return jsonResponse({ error: 'Thread not found', code: 'THREAD_NOT_FOUND', field: 'conversation_id' }, { status: 404 })
    }
    if (outcome.reason === 'invalid_transition') {
      return jsonResponse({ error: outcome.message, code: 'INVALID_TRANSITION', field: 'action' }, { status: 409 })
    }
    if (outcome.reason === 'guest_unreachable') {
      return jsonResponse({ error: outcome.message, code: outcome.code, field: outcome.field }, { status: outcome.status })
    }
    if (outcome.reason === 'empty_body') {
      return jsonResponse({ error: 'Write a message or add a photo', code: 'EMPTY_MESSAGE', field: 'body' }, { status: 400 })
    }
    if (outcome.reason === 'invalid_photo') {
      return jsonResponse({ error: outcome.message, code: 'INVALID_PHOTO', field: 'photos' }, { status: 400 })
    }
    if (outcome.reason === 'missing_idempotency_key') {
      return jsonResponse({ error: 'Idempotency key is required', code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotency_key' }, { status: 400 })
    }
    if (outcome.reason === 'delivery_failed') {
      return jsonResponse({ ...outcome, error: outcome.message }, { status: outcome.status })
    }
    throw new HTTPError({ statusCode: 500, message: 'Guest-thread operation returned an unhandled outcome', data: { code: 'INVALID_OPERATION_OUTCOME', field: 'outcome.reason' } })
  }

  const paged = event.url.searchParams.get('transcript') === 'latest'
  const detail = await getInboxThread(db, threadId, organizationId, { audience: 'member', userId: principal.userId, principal, conversation: action === 'reply' || action === 'retry' ? conversation : await assertConversationAccess(db, principal, conversation.id, true) }, new Date(), paged ? { before: null, limit: 40 } : undefined)
  return jsonResponse({ thread: detail, available_actions: outcome.availableActions, ...outcome.message && { message: outcome.message } }, { status: outcome.status })
})
