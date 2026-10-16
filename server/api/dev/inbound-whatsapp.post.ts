import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { assertDevRouteAllowed } from '~/server/utils/dev-route-auth'
import { findSubmissionByPhone } from '~/server/utils/submission-messages'
import { parsePhoneOrThrow } from '~/utils/phone'
import { getGuestRequest, requestSummary } from '~/server/domain/requests'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import { appendEntry } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { notifyGuestThreadReply } from '~/server/utils/notifications'

export default defineHandler(async (event) => {
  assertDevRouteAllowed(event)
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const body = await readBody(event) as {
    from?: string
    body?: string
    messageId?: string
    organizationId?: string
  }

  const from = body.from?.trim()
  const text = body.body?.trim()
  if (!from || !text) {
    return jsonResponse({ error: 'from and body are required' }, { status: 400 })
  }

  const match = await findSubmissionByPhone(
    db, parsePhoneOrThrow(from), body.organizationId?.trim() || undefined, )
  if (!match) {
    return jsonResponse({ error: 'Submission not found for phone' }, { status: 404 })
  }

  const messageId = body.messageId?.trim() || crypto.randomUUID()
  const thread = await getGuestRequest(db, match.submissionId, undefined, match.submissionType)
  if (!thread) throw new Error('Submission not found')
  const entry = await appendEntry(db, {
    threadId: thread.id, kind: 'message', actorKind: 'guest', channel: 'whatsapp', body: text, dedupeKey: `whatsapp:${messageId}`, })
  await updateThreadProjectionIfLatestEntry(db, thread.id, entry.id, { conversationState: 'needs_attention' })
  await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'entry.appended' })

  const summary = await requestSummary(db, thread)
  await notifyGuestThreadReply(env, db, {
    organizationId: match.organizationId, locationId: summary.locationId, threadId: thread.id, sourceEntryId: entry.id, submissionType: match.submissionType, submissionId: match.submissionId, participantLabel: summary.participantLabel, guestEmail: summary.guestEmail, guestPhone: summary.guestPhone, inboundChannel: 'whatsapp', messagePreview: text, })

  return jsonResponse({ received: true, match, messageId })
})
