import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { fetchWhatsAppMedia, sendWhatsAppText } from '~/server/utils/whatsapp'
import type { MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { advanceDeliveryStatus } from '~/server/domain/guest-threads/deliveries'
import { parseMetaMsisdn } from '~/utils/phone'
import { isLastWhatsAppInbound, recordWhatsAppInbound } from '~/server/utils/mcp-context'
import { execute, queryFirst } from '~/server/db'
import { REPLY_BY_QUOTING, replyToAlertEntry } from '~/server/domain/guest-threads/member-reply'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { receiveGuestWhatsApp } from '~/server/domain/guest-threads/inbound-email'
import { findVerifiedAuthUserByPhone, type CloudflareEnv } from '~/server/utils/auth'

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
async function answerMember(db: D1Database, env: ApiRecord, message: WhatsAppMessage, toPhone: string, userId: string): Promise<void> {
  const quoted = message.context?.id
    ? await queryFirst<{ message_id: string }>(db, `
        SELECT d.message_id FROM guest_thread_deliveries d
         WHERE d.provider = 'meta' AND d.channel = 'whatsapp' AND d.purpose = 'owner_alert' AND d.provider_message_id = ? AND d.message_id IS NOT NULL
         LIMIT 1`, [message.context.id])
    : null
  if (!quoted) {
    const sent = await sendWhatsAppText(env, toPhone, REPLY_BY_QUOTING)
    if (!sent.success) throw new Error(sent.error || 'Failed to send the WhatsApp reply hint')
    return
  }
  const outcome = await replyToAlertEntry(env as CloudflareEnv, {
    entryId: quoted.message_id, userId, body: messageText(message), files: await messageFiles(env, message), idempotencyKey: `whatsapp:${message.id}`,
  })
  // The member reads the outcome first. A failed reply, or an outcome Meta would not carry, then fails
  // this message, so Meta delivers it again; the replay under the same key sends nothing twice.
  const told = await sendWhatsAppText(env, toPhone, outcome.notice)
  if (outcome.report !== null) throw outcome.report instanceof Error ? outcome.report : new Error(String(outcome.report), { cause: outcome.report })
  if (!told.success) throw new Error(told.error || 'Failed to send the WhatsApp reply outcome')
}

function metaMessageTime(message: WhatsAppMessage): string {
  const seconds = Number(message.timestamp)
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`Meta sent WhatsApp message ${message.id} without its timestamp`)
  return new Date(seconds * 1000).toISOString()
}

async function handleMessage(db: D1Database, env: ApiRecord, message: WhatsAppMessage): Promise<void> {

  const toPhone = parseMetaMsisdn(message.from)
  const user = await resolveUser(env, message.from)
  if (!user) {
    // Not a verified owner/staff account: a guest answering their booking conversation, or someone to point at the app.
    const received = await receiveGuestWhatsApp(env as CloudflareEnv, { phone: toPhone, messageId: message.id, body: messageText(message), files: await messageFiles(env, message) })
    if (!received) await reply(env, toPhone, `To continue, open KrabiClaw: ${platformLoginUrl(env)}`)
    return
  }

  // Meta redelivering a message already answered runs nothing again.
  if (await isLastWhatsAppInbound(db, user.id, message.id)) return
  const sentAt = metaMessageTime(message)
  await answerMember(db, env, message, toPhone, user.id)
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

  const delivery = await queryFirst<{ id: string; conversation_id: string | null; status: string }>(db, `
    SELECT d.id, m.conversation_id, d.status
    FROM guest_thread_deliveries d
    LEFT JOIN messages m ON m.id = d.message_id
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

  if (delivery.conversation_id) await publishConversationEvent(env, db, { conversationId: delivery.conversation_id, type: 'MESSAGE_UPDATE' })
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
    await handleMessage(db, env, message)
  }
  for (const status of statuses) {
    await handleStatus(db, env, status)
  }

  return jsonResponse({ success: true })
})
import { defineHandler } from 'nitro';
import {  readRawBody  } from 'nitro/h3';
