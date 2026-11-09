import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { fetchWhatsAppMedia, sendWhatsAppText } from '~/server/utils/whatsapp'
import { attachGuestPhotos, sortGuestFiles, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { advanceDeliveryStatus } from '~/server/domain/guest-threads/deliveries'
import { parseMetaMsisdn } from '~/utils/phone'
import { isLastWhatsAppInbound, recordWhatsAppInbound } from '~/server/utils/mcp-context'
import { execute, queryFirst } from '~/server/db'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import { getGuestRequest, requestSummary } from '~/server/domain/requests'
import { REPLY_BY_QUOTING, replyToAlertEntry } from '~/server/domain/guest-threads/member-reply'
import { appendEntry, findEntryByDedupeKey } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { notifyGuestThreadReply } from '~/server/utils/notifications'
import { findSubmissionByPhone } from '~/server/utils/submission-messages'
import { findVerifiedAuthUserByPhone } from '~/server/utils/auth'

interface WhatsAppMessage {
  id: string
  from: string
  timestamp?: string
  type: 'text' | 'image' | 'document' | string
  text?: { body?: string }
  image?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string }
  // Present when the manager replied by quoting a prior outbound message.
  // The provider id correlates to a guest thread delivery receipt.
  context?: { id?: string; from?: string }
}

interface WhatsAppStatusError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

interface WhatsAppStatus {
  id?: string
  status?: string
  timestamp?: string
  recipient_id?: string
  errors?: WhatsAppStatusError[]
}

interface WhatsAppPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[]
        statuses?: WhatsAppStatus[]
      }
    }>
  }>
}

interface UserRow {
  id: string
  phoneNumber: string
  phoneNumberVerified: boolean
}

function platformLoginUrl(env: ApiRecord): string {
  const raw = String(env.NUXT_PUBLIC_PLATFORM_DOMAIN || '').trim()
  if (!raw) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  const origin = /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`
  return `${origin}/login`
}

function inboundMessages(payload: WhatsAppPayload): WhatsAppMessage[] {
  return (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.messages ?? [])
    .filter((message) => Boolean(message.id && message.from))
}

function inboundStatuses(payload: WhatsAppPayload): WhatsAppStatus[] {
  return (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.statuses ?? [])
    .filter((status) => Boolean(status.id && status.status))
}

function messageText(message: WhatsAppMessage): string {
  if (message.type === 'text') return message.text?.body?.trim() ?? ''
  if (message.type === 'image') return message.image?.caption?.trim() ?? ''
  if (message.type === 'document') return message.document?.caption?.trim() ?? ''
  return ''
}

/** The file a guest's WhatsApp message carries, downloaded from Meta. */
async function messageFiles(env: ApiRecord, message: WhatsAppMessage): Promise<MessagePhoto[]> {
  const media = message.type === 'image' ? message.image : message.type === 'document' ? message.document : undefined
  if (!media?.id) return []
  const downloaded = await fetchWhatsAppMedia(env, media.id)
  const filename = message.document?.filename || `whatsapp-${media.id}`
  return [{ bytes: new Uint8Array(downloaded.bytes), filename }]
}

async function reply(env: ApiRecord, toPhone: string, text: string) {
  return await sendWhatsAppText(env, toPhone, text)
}

async function resolveUser(env: ApiRecord, from: string): Promise<UserRow | null> {
  const normalized = parseMetaMsisdn(from)
  return await findVerifiedAuthUserByPhone(env as CloudflareEnv, normalized)
}

/**
 * A member's own WhatsApp message. Quoting their alert about a guest's or
 * teammate's message answers that conversation: it is the dashboard's own send,
 * as the member the phone was verified for, and the member is told the outcome. Anything else gets one line
 * saying how to answer. The reply's key is the WhatsApp message's id, so Meta
 * redelivering it sends nothing twice.
 */
async function answerMember(db: D1Database, env: ApiRecord, message: WhatsAppMessage, toPhone: string, userId: string, report: (error: unknown) => Promise<void>): Promise<void> {
  const quoted = message.context?.id
    ? await queryFirst<{ entry_id: string }>(db, `
        SELECT d.entry_id FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
         WHERE d.provider = 'meta' AND d.channel = 'whatsapp' AND d.purpose = 'owner_alert' AND d.provider_message_id = ?
           AND (e.request_id IS NOT NULL OR e.dedupe_key LIKE 'team-message:%')
         LIMIT 1`, [message.context.id])
    : null
  if (!quoted) {
    const sent = await sendWhatsAppText(env, toPhone, REPLY_BY_QUOTING)
    if (!sent.success) throw new Error(sent.error || 'Failed to send the WhatsApp reply hint')
    return
  }
  const outcome = await replyToAlertEntry(env as CloudflareEnv, {
    entryId: quoted.entry_id, userId, body: messageText(message), files: await messageFiles(env, message), idempotencyKey: `whatsapp:${message.id}`,
  })
  // The outcome is the member's to read whatever else failed; a notice Meta refuses is reported beside it.
  const told = await sendWhatsAppText(env, toPhone, outcome.notice).then(
    result => result.success ? null : new Error(result.error || 'Failed to send the WhatsApp reply outcome'), (error: unknown) => error)
  if (outcome.report !== null && told) await report(new AggregateError([outcome.report, told], 'The reply failed and the member could not be told', { cause: outcome.report }))
  else if (outcome.report !== null) await report(outcome.report)
  else if (told) await report(told)
}

function metaMessageTime(message: WhatsAppMessage): string {
  const seconds = Number(message.timestamp)
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`Meta sent WhatsApp message ${message.id} without its timestamp`)
  return new Date(seconds * 1000).toISOString()
}

async function handleMessage(db: D1Database, env: ApiRecord, message: WhatsAppMessage, event: H3Event): Promise<void> {

  const toPhone = parseMetaMsisdn(message.from)
  const user = await resolveUser(env, message.from)
  if (!user) {
    // Not a verified owner/staff account — check whether this is a customer replying to an
    // open reservation/experience-booking thread rather than trying to talk to ChowBot.
    const existingEntry = await findEntryByDedupeKey(db, `whatsapp:${message.id}`)
    const existingThread = existingEntry
      ? await getGuestRequest(db, existingEntry.request_id)
      : null
    const match = existingThread
      ? {
          submissionType: existingThread.kind,
          submissionId: existingThread.id,
          organizationId: existingThread.organization_id,
        }
      : await findSubmissionByPhone(db, toPhone)
    if (match) {
      const text = messageText(message)
      const { photos, unshown } = sortGuestFiles(await messageFiles(env, message))
      if (text || photos.length || unshown.length) {
        const thread = await getGuestRequest(db, match.submissionId, undefined, match.submissionType)
        if (!thread) throw new Error(`WhatsApp guest reply matched conversation ${match.submissionId}, which no longer exists`)
        const entry = await appendEntry(db, {
          threadId: thread.id,
          kind: 'message',
          actorKind: 'guest',
          body: text || null,
          payloadJson: unshown.length ? { unshownFiles: unshown } : null,
          dedupeKey: `whatsapp:${message.id}`,
        })
        await attachGuestPhotos(db, env, match.organizationId, entry.id, photos)
        await updateThreadProjectionIfLatestEntry(db, thread.id, entry.id)
        // The guest's message is in the thread before the owner is alerted, so an alert that fails cannot hide it.
        await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'entry.appended' })

        const summary = await requestSummary(db, thread)
        await notifyGuestThreadReply(env, db, {
          organizationId: match.organizationId,
          locationId: summary.locationId,
          threadId: thread.id,
          sourceEntryId: entry.id,
          submissionType: match.submissionType,
          submissionId: match.submissionId,
          participantLabel: summary.participantLabel,
          guestEmail: summary.guestEmail,
          guestPhone: summary.guestPhone,
          inboundChannel: 'whatsapp',
        })
      }
      return
    }
    await reply(env, toPhone, `To continue, open KrabiClaw: ${platformLoginUrl(env)}`)
    return
  }

  // Meta redelivering a message already answered runs nothing again.
  if (await isLastWhatsAppInbound(db, user.id, message.id)) return
  const sentAt = metaMessageTime(message)
  await answerMember(db, env, message, toPhone, user.id,
    // Through the same error hook a thrown error reaches (server/plugins/error-logger.ts).
    async (error) => { await useNitroHooks().callHook('error', error instanceof Error ? error : new Error(String(error), { cause: error }), { event, tags: ['whatsapp'] }) })
  // Meta's own time for the message opens the member's service window.
  await recordWhatsAppInbound(db, { userId: user.id, messageId: message.id, sentAt })
}

function formatStatusError(errors: WhatsAppStatusError[] | undefined): string | null {
  if (!errors?.length) return null
  try {
    return JSON.stringify(errors)
  } catch {
    return null
  }
}

async function handleStatus(db: D1Database, env: ApiRecord, status: WhatsAppStatus): Promise<void> {
  const providerMessageId = status.id
  const incomingStatus = status.status
  if (!providerMessageId || !incomingStatus) return
  if (incomingStatus !== 'sent' && incomingStatus !== 'delivered' && incomingStatus !== 'read' && incomingStatus !== 'failed') return

  const delivery = await queryFirst<{ id: string; request_id: string; status: string }>(db, `
    SELECT d.id, e.request_id, d.status
    FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    WHERE d.provider = 'meta' AND d.provider_message_id = ?
    LIMIT 1
  `, [providerMessageId])
  if (!delivery) return

  const errorText = formatStatusError(status.errors)
  const advanced = await advanceDeliveryStatus(db, delivery, incomingStatus, errorText)

  // A `failed` event arrived after a later success stage was already
  // recorded (or a same/earlier-stage replay) — never regress
  // delivery status, but still persist the raw provider error so a
  // failure is never silently lost.
  if (!advanced && errorText) {
    await execute(db, `
      UPDATE guest_thread_deliveries
      SET error = ?, updated_at = ?
      WHERE id = ?
    `, [errorText, new Date().toISOString(), delivery.id])
  }

  await publishGuestInboxThreadEvent(env, db, {
    threadId: delivery.request_id,
    type: 'delivery.changed',
  })
}

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const rawBody = await readRawBody(event) ?? ''
  const appSecret = typeof env.WHATSAPP_APP_SECRET === 'string' ? env.WHATSAPP_APP_SECRET : ''
  // The signature is the only thing that makes this a message from Meta. Without
  // the secret nothing can be verified, so nothing is accepted.
  if (!appSecret) return jsonResponse({ error: 'Missing WHATSAPP_APP_SECRET configuration' }, { status: 500 })
  const signature = (event.req.headers.get('x-hub-signature-256')) ?? ''
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'], )
  const incomingHex = signature.startsWith('sha256=') ? signature.slice(7) : ''
  const pairs = incomingHex.match(/.{2}/g)
  const parsedPairs = pairs && pairs.length === 32 ? pairs.map((b) => parseInt(b, 16)) : null
  const incomingBytes = parsedPairs && parsedPairs.every((n) => !Number.isNaN(n))
    ? new Uint8Array(parsedPairs)
    : new Uint8Array(0)
  const isValid = incomingBytes.length === 32 && await crypto.subtle.verify(
    { name: 'HMAC', hash: 'SHA-256' }, key, incomingBytes, new TextEncoder().encode(rawBody), )
  if (!isValid) {
    return jsonResponse({ error: 'Invalid signature' }, { status: 403 })
  }

  let payload: WhatsAppPayload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return jsonResponse({ error: 'Malformed JSON payload' }, { status: 400 })
  }
  const messages = inboundMessages(payload)
  const statuses = inboundStatuses(payload)

  for (const message of messages) {
    await handleMessage(db, env, message, event)
  }
  for (const status of statuses) {
    await handleStatus(db, env, status)
  }

  return jsonResponse({ success: true })
})
import { defineHandler } from 'nitro';
import { useNitroHooks } from 'nitro/app'
import type { H3Event } from 'nitro/h3'
import {  readRawBody  } from 'nitro/h3';
