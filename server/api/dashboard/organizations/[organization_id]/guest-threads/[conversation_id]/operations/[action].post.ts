import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { queryFirst } from '~/server/db'

// Conversation operations here; booking status changes use the versioned booking API.
import { jsonResponse } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { roleAllows } from '~/server/utils/member-access'
import { executeGuestThreadOperation, GUEST_THREAD_ACTIONS } from '~/server/domain/guest-threads/operations'
import { assertConversationOperation } from '~/server/domain/send-conversation-message'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { MEMBER_REPLY_EVENT } from '~/server/domain/conversations'

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

  // The change is not done until the open inboxes have been told about it.
  if (outcome.ok || outcome.reason === 'delivery_failed') {
    await publishConversationEvent(env, db, { conversationId: conversation.id, message: outcome.ok ? outcome.message : undefined, type: 'MESSAGE_UPDATE' })
  }

  assertConversationOperation(outcome)
  return jsonResponse({ available_actions: outcome.availableActions, ...outcome.message && { message: outcome.message } }, { status: outcome.status })
})
