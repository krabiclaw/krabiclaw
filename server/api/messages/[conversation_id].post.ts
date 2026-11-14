import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { conversationRequest } from '~/server/utils/conversation-request'
import { MAX_MESSAGE_PHOTOS } from '~/server/domain/guest-threads/attachments'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { sendConversationMessage } from '~/server/domain/send-conversation-message'
import { parseSuggestionUse, recordSuggestionAccepted, suggestedDraft } from '~/server/domain/suggested-reply'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { env, db, user, conversation, role } = await conversationRequest(event)
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  const declared = Number(event.req.headers.get('content-length') ?? '0')
  if (multipart && (!Number.isFinite(declared) || declared > MAX_MESSAGE_PHOTOS * MAX_IMAGE_BYTES + 64 * 1024)) {
    throw new HTTPError({ statusCode: 413, message: 'Message photos are too large', data: { code: 'INVALID_PHOTO', field: 'photos' } })
  }
  const form = multipart ? await event.req.formData() : null
  const json = form ? null : await readStrictBody<{ body?: string; idempotency_key?: string; suggestion?: unknown }>(event, { body: 'string', idempotency_key: 'string', suggestion: 'unknown' })
  const text = (key: 'body' | 'idempotency_key') => {
    const value = form ? form.get(key) : json?.[key]
    if (value == null) return ''
    if (typeof value === 'string') return value
    throw new HTTPError({ statusCode: 400, message: 'Expected text', data: { code: 'INVALID_BODY_FIELD', field: key } })
  }
  const parts = form?.getAll('photos') ?? []
  const files = parts.filter((part): part is File => part instanceof File && part.size <= MAX_IMAGE_BYTES)
  if (parts.length > MAX_MESSAGE_PHOTOS || files.length !== parts.length) {
    throw new HTTPError({ statusCode: 400, message: 'Each photo must be a file of 10 MB or less', data: { code: 'INVALID_PHOTO', field: 'photos' } })
  }
  const photos = await Promise.all(files.map(async photo => ({ bytes: new Uint8Array(await photo.arrayBuffer()), filename: photo.name || 'photo' })))
  const body = text('body')
  const idempotencyKey = text('idempotency_key')
  const suggestion = role === 'member' && conversation.kind !== 'team' ? parseSuggestionUse(form ? form.get('suggestion') : json?.suggestion) : null
  const draft = suggestion ? await suggestedDraft(db, { organizationId: conversation.organization_id, threadId: conversation.id, suggestion }) : null
  const message = await sendConversationMessage(env, { conversation, role, userId: user.id, senderName: user.name, body, photos, idempotencyKey })
  if (draft) await recordSuggestionAccepted(db, { organizationId: conversation.organization_id, threadId: conversation.id, userId: user.id, body, draft })
  return jsonResponse(finalizeRequestMetrics(event, 'messages-send', { message }))
})
