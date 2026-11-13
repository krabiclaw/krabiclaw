import { d1JsonStringSet, execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { WebhookEventPayload } from 'resend'
import type { ReplyEmailEnv } from '~/server/utils/submission-messages'
import { buildReplyToAddress } from '~/server/utils/reply-address'
import { emailSender, getEmailDeliveryMode, isEmailMessageId, sendEmail, type EmailInput } from '~/server/utils/email-delivery'
import { isRecord } from '~/server/utils/type-guards'
import { publishConversationEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import type {
  GuestThreadDeliveryChannel,
  GuestThreadDeliveryPurpose,
  GuestThreadDeliveryProvider,
  GuestThreadDeliveryRow,
  GuestThreadDeliveryStatus,
} from './types'

/** The provider took it: its answer carried the message's id. */
export function isDeliverySent(delivery: Pick<GuestThreadDeliveryRow, 'status'>): boolean {
  return delivery.status === 'accepted' || delivery.status === 'sent' || delivery.status === 'delivered' || delivery.status === 'read'
}

interface EmailSnapshot {
  preparedAt: string
  sender: string | null
  message: Omit<EmailInput, 'idempotencyKey'>
}

function readEmailSnapshot(json: string): EmailSnapshot {
  const snapshot: unknown = JSON.parse(json)
  if (!isRecord(snapshot) || typeof snapshot.preparedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.preparedAt))
    || !(snapshot.sender === null || typeof snapshot.sender === 'string') || !isRecord(snapshot.message)) {
    throw new Error('Email delivery has an invalid recorded request')
  }
  const message = snapshot.message
  if (!['to', 'subject', 'html', 'text', 'emailPurpose'].every(key => typeof message[key] === 'string')) {
    throw new Error('Email delivery is missing its recorded request fields')
  }
  return snapshot as unknown as EmailSnapshot
}

/** Only this conversation and this recipient can contribute email ancestry. */
async function conversationEmailParent(db: DbClient, delivery: GuestThreadDeliveryRow, conversationId: string, sequence: number, recipient: string) {
  const candidates = await queryAll<{
    id: string; sequence: number; created_at: string; payload_json: string | null
    email_json: string | null; email_message_id: string | null; provider: string | null
  }>(db, `
    SELECT m.id, m.sequence, m.created_at, m.payload_json, NULL AS email_json, NULL AS email_message_id, NULL AS provider
    FROM messages m
    WHERE m.conversation_id = ? AND m.sequence < ? AND m.author_kind = 'guest' AND m.channel = 'email'
    UNION ALL
    SELECT d.id, m.sequence, d.created_at, NULL, d.email_json, d.email_message_id, d.provider
    FROM guest_thread_deliveries d JOIN messages m ON m.id = d.message_id
    WHERE m.conversation_id = ? AND m.sequence <= ? AND d.id <> ?
      AND d.channel = 'email' AND d.purpose <> 'owner_alert'
      AND d.status IN ('accepted', 'sent', 'delivered', 'read')
    ORDER BY sequence DESC, created_at DESC, id DESC
  `, [conversationId, sequence, conversationId, sequence, delivery.id])
  let parent: { subject: string | null; messageId: string } | null = null
  let knownSubject: string | null = null
  const references: string[] = []
  for (const candidate of candidates) {
    if (candidate.payload_json !== null) {
      const payload: unknown = JSON.parse(candidate.payload_json)
      const email = isRecord(payload) && isRecord(payload.email) ? payload.email : null
      if (!email || typeof email.from !== 'string' || email.from.trim().toLowerCase() !== recipient) continue
      if (email.messageId === null || email.messageId === undefined) continue // A missing RFC ID is not the content hash used for deduplication.
      if (!isEmailMessageId(email.messageId) || !(email.subject === null || email.subject === undefined || typeof email.subject === 'string')) throw new Error('Received conversation email has invalid threading metadata')
      if (typeof email.subject === 'string') knownSubject ??= email.subject
      parent ??= { subject: email.subject ?? null, messageId: email.messageId }
      references.push(email.messageId)
      continue
    }
    const snapshot = candidate.email_json === null ? null : readEmailSnapshot(candidate.email_json)
    if (snapshot && snapshot.message.to.trim().toLowerCase() !== recipient) continue
    if (snapshot) knownSubject ??= snapshot.message.subject
    if (candidate.provider === 'log_only') continue // No email, and therefore no provider-assigned RFC ID, exists in this mode.
    const messageId = candidate.email_message_id
    // Historical provider email expires. Only retained recipient identity and
    // genuine RFC metadata can supply ancestry; neither is required to reply.
    if (!snapshot || messageId === null) continue
    const subject = snapshot.message.subject
    if (!isEmailMessageId(messageId)) throw new Error('Prior conversation email has an invalid RFC Message-ID')
    knownSubject ??= subject
    parent ??= { subject, messageId }
    references.push(messageId)
  }
  // No earlier email to answer: the email starts the conversation's thread with its own subject.
  if (!parent) return {}
  const subject = parent.subject ?? knownSubject
  return {
    ...(subject === null ? {} : { subject: `Re: ${subject.replace(/^(?:re:\s*)+/iu, '').replace(/[\r\n]+/gu, ' ').trim()}`.trim() }),
    inReplyTo: parent.messageId, references: [...new Set(references.reverse())],
  }
}

/**
 * A member's alerts about one conversation, guest or team, are one email
 * thread: each keeps the subject of the first alert sent to that recipient and
 * answers the alert before it, so every mail client threads them, not only
 * Gmail by subject. Alerts to other recipients, and the guest's own emails, are
 * never its ancestry. An alert about no message (a payout, a task) starts no thread.
 */
async function alertEmailParent(db: DbClient, delivery: GuestThreadDeliveryRow, recipient: string) {
  if (!delivery.message_id) return {}
  const earlier = await queryAll<{ email_json: string; email_message_id: string | null; provider: string }>(db, `
    SELECT d.email_json, d.email_message_id, d.provider FROM messages anchor
    JOIN messages m ON m.conversation_id = anchor.conversation_id
    JOIN guest_thread_deliveries d ON d.message_id = m.id
    WHERE anchor.id = ? AND d.id <> ? AND d.channel = 'email' AND d.purpose = 'owner_alert'
      AND d.email_json IS NOT NULL AND d.status IN ('accepted', 'sent', 'delivered', 'read')
    ORDER BY d.created_at, d.id`, [delivery.message_id, delivery.id])
  const alerts = earlier.map(row => ({ ...row, snapshot: readEmailSnapshot(row.email_json) }))
    .filter(row => row.snapshot.message.to.trim().toLowerCase() === recipient)
  // The first alert to this recipient starts the thread with its own subject.
  if (!alerts.length) return {}
  // A log-only alert was never mailed, so it has no RFC identity to answer.
  const references = alerts.flatMap(row => row.provider === 'resend' && row.email_message_id !== null ? [row.email_message_id] : [])
  if (!references.every(isEmailMessageId)) throw new Error('Prior alert email has an invalid RFC Message-ID')
  return {
    subject: alerts[0]!.snapshot.message.subject,
    ...(references.length ? { inReplyTo: references.at(-1)!, references } : {}),
  }
}

/** The one receipt-backed email dispatcher, shared by notifications and replies. */
export async function deliverReceiptEmail(db: DbClient, input: {
  env: ReplyEmailEnv; delivery: GuestThreadDeliveryRow; threadId: string | null; email: EmailInput
}): Promise<GuestThreadDeliveryRow> {
  let delivery = await getDeliveryById(db, input.delivery.id)
  if (!delivery || delivery.message_id !== input.delivery.message_id || delivery.activity_entry_id !== input.delivery.activity_entry_id
    || delivery.task_id !== input.delivery.task_id || delivery.channel !== 'email') throw new Error('Email delivery does not match what it sends')
  if (delivery.provider !== (getEmailDeliveryMode(input.env) === 'provider' ? 'resend' : 'log_only')) throw new Error('Email delivery mode differs from its recorded provider')
  // A guest's email is about one message of one conversation; an alert may be about a message, an audited event or a task.
  const message = delivery.message_id ? await queryFirst<{ conversation_id: string; sequence: number }>(db, 'SELECT conversation_id, sequence FROM messages WHERE id = ?', [delivery.message_id]) : null
  if (delivery.message_id && !message) throw new Error(`Email delivery ${delivery.id} names message ${delivery.message_id}, which does not exist`)
  if (input.threadId !== null && message?.conversation_id !== input.threadId) throw new Error('Email delivery does not belong to the targeted conversation')
  const threaded = input.threadId !== null
  try {
    if (!isDeliverySent(delivery) && !delivery.provider_message_id) {
      if (delivery.email_json === null) {
        const recipient = input.email.to.trim().toLowerCase()
        const ancestry = delivery.purpose === 'owner_alert' ? await alertEmailParent(db, delivery, recipient)
          : threaded ? await conversationEmailParent(db, delivery, input.threadId!, message!.sequence, recipient) : {}
        const snapshot: EmailSnapshot = {
          preparedAt: new Date().toISOString(),
          sender: delivery.provider === 'resend' || input.env.EMAIL_FROM?.trim() ? emailSender(input.env, input.email.fromName) : null,
          message: { ...input.email, ...ancestry },
        }
        // The first contender freezes the complete request. A retry never
        // changes ancestry, subject, recipient, sender, body or attachments.
        await execute(db, 'UPDATE guest_thread_deliveries SET email_json = ? WHERE id = ? AND email_json IS NULL', [JSON.stringify(snapshot), delivery.id])
        delivery = (await getDeliveryById(db, delivery.id))!
      }
      const snapshot = readEmailSnapshot(delivery.email_json!)
      if (snapshot.message.to.trim().toLowerCase() !== input.email.to.trim().toLowerCase()) throw new Error('Email recipient differs from its recorded delivery')
      // The receipt's id is Resend's idempotency key, so sending it again sends nothing twice.
      // The email's RFC Message-ID arrives with Resend's delivered webhook.
      const result = await sendEmail({ ...input.env, ...(snapshot.sender ? { EMAIL_FROM: snapshot.sender } : {}) }, { ...snapshot.message, idempotencyKey: delivery.id })
      delivery = await recordDeliveryOutcome(db, {
        deliveryId: delivery.id, status: result.status,
        providerMessageId: result.status === 'sent' ? result.messageId : null,
        error: result.status === 'failed' ? result.error : null,
      })
      if (result.status === 'failed') return delivery
    }
    await execute(db, "UPDATE guest_thread_deliveries SET error = NULL WHERE id = ? AND status IN ('accepted','sent','delivered','read')", [delivery.id])
    const completed = await getDeliveryById(db, delivery.id)
    if (!completed) throw new Error('Email delivery disappeared after dispatch')
    return completed
  } catch (error) {
    // A send that threw did not send: it is failed with its error, and sending it again reuses
    // the receipt's id as Resend's idempotency key.
    await recordDeliveryOutcome(db, { deliveryId: delivery.id, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** What one send is of: a message, an audited event, or a task. */
export type DeliverySubject = { messageId: string } | { activityEntryId: string } | { taskId: string }

export async function createDeliveryReceipt(
  db: DbClient,
  input: {
    subject: DeliverySubject
    channel: GuestThreadDeliveryChannel
    provider: GuestThreadDeliveryProvider
    purpose: GuestThreadDeliveryPurpose
    idempotencyKey: string
  },
): Promise<GuestThreadDeliveryRow> {
  const id = input.idempotencyKey
  const now = new Date().toISOString()
  await execute(db, `
      INSERT INTO guest_thread_deliveries
        (id, message_id, activity_entry_id, task_id, channel, provider, purpose, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `, [
      id,
      'messageId' in input.subject ? input.subject.messageId : null,
      'activityEntryId' in input.subject ? input.subject.activityEntryId : null,
      'taskId' in input.subject ? input.subject.taskId : null,
      input.channel,
      input.provider,
      input.purpose,
      now,
      now,
    ])

  const created = await getDeliveryById(db, id)
  if (!created) throw new Error('Failed to load created guest thread delivery')
  return created
}

export async function getDeliveryById(db: DbClient, id: string): Promise<GuestThreadDeliveryRow | null> {
  return await queryFirst<GuestThreadDeliveryRow>(db, `
    SELECT * FROM guest_thread_deliveries WHERE id = ? LIMIT 1
  `, [id])
}

export async function getDeliveryByProviderMessageId(
  db: DbClient,
  provider: Exclude<GuestThreadDeliveryProvider, 'log_only'>,
  providerMessageId: string,
): Promise<GuestThreadDeliveryRow | null> {
  return await queryFirst<GuestThreadDeliveryRow>(db, `
    SELECT * FROM guest_thread_deliveries
    WHERE provider = ? AND provider_message_id = ?
    LIMIT 1
  `, [provider, providerMessageId])
}

/**
 * Provider delivery stages in the order they can only move forward. Meta sends
 * accepted/sent/delivered/read; Resend events project onto sent/delivered.
 * Webhooks are not ordered, so a later call for the same provider message must
 * never regress a stage already observed.
 */
const DELIVERY_STATUS_RANK: Partial<Record<GuestThreadDeliveryStatus, number>> = {
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
}

/**
 * Whether a provider-reported status moves a delivery forward.
 *
 * `failed` is terminal: once recorded nothing overwrites it, and it never
 * clobbers an already-recorded `delivered`/`read` — a late failure report for
 * a message that arrived is not the message's state. A repeat of the current
 * status is not a change.
 */
export function compareDeliveryStatus(current: string | null, incoming: GuestThreadDeliveryStatus): boolean {
  if (!current) return true
  if (current === 'failed') return false
  if (incoming === 'failed') return current !== 'delivered' && current !== 'read'
  const currentRank = DELIVERY_STATUS_RANK[current as GuestThreadDeliveryStatus] ?? 0
  const incomingRank = DELIVERY_STATUS_RANK[incoming] ?? 0
  return incomingRank > currentRank
}

/**
 * Applies a provider-reported status to one delivery, forward only.
 *
 * Compare-and-set on the observed status, so two webhooks racing on one
 * delivery cannot both write and a regression cannot land between the read
 * and the write. Returns whether the stored status changed.
 */
/** Whether a reply reached the guest decides whether the business still owes one: the reply tasks change with the receipt. */
async function deliveryTaskQueries(db: DbClient, deliveryId: string): Promise<BatchQuery[]> {
  const message = await queryFirst<{ conversation_id: string; kind: string }>(db, `SELECT m.conversation_id, c.kind FROM guest_thread_deliveries d
    JOIN messages m ON m.id = d.message_id JOIN conversations c ON c.id = m.conversation_id WHERE d.id = ?`, [deliveryId])
  if (!message || message.kind === 'team') return []
  // The conversation repository reads receipts through this module; it is loaded when used, not at import.
  const { conversationTaskQueries } = await import('./repository')
  return conversationTaskQueries(message.conversation_id, new Date().toISOString())
}

export async function advanceDeliveryStatus(
  db: DbClient,
  delivery: { id: string; status: string },
  incoming: GuestThreadDeliveryStatus,
  error: string | null,
): Promise<boolean> {
  let observed = delivery.status
  const tasks = await deliveryTaskQueries(db, delivery.id)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!compareDeliveryStatus(observed, incoming)) return false
    const [result] = await executeBatch(db, [{
      query: `UPDATE guest_thread_deliveries SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = ?`,
      params: [incoming, error, new Date().toISOString(), delivery.id, observed],
    }, ...tasks], { operation: 'Advance delivery status' })
    if ((result?.meta.changes ?? 0) > 0) return true
    const current = await getDeliveryById(db, delivery.id)
    if (!current) throw new Error(`Guest thread delivery ${delivery.id} disappeared while its status was advanced`)
    observed = current.status
  }
  throw new Error(`Guest thread delivery ${delivery.id} kept changing while ${incoming} was applied`)
}

/**
 * The KrabiClaw delivery status a Resend email event means, or null for an
 * event that says nothing about whether the message arrived. A complaint is
 * a delivered message; the complaint itself is Resend's to keep.
 */
function resendProjectedStatus(event: WebhookEventPayload): GuestThreadDeliveryStatus | null {
  switch (event.type) {
    case 'email.sent': return 'sent'
    case 'email.delivered': return 'delivered'
    case 'email.complained': return 'delivered'
    case 'email.failed':
    case 'email.bounced':
    case 'email.suppressed': return 'failed'
    default: return null
  }
}

function resendFailureReason(event: WebhookEventPayload): string | null {
  switch (event.type) {
    case 'email.failed': return `Resend failed: ${event.data.failed.reason}`
    case 'email.bounced': return `Resend bounced (${event.data.bounce.type}): ${event.data.bounce.message}`
    case 'email.suppressed': return `Resend suppressed (${event.data.suppressed.type}): ${event.data.suppressed.message}`
    default: return null
  }
}

/**
 * Projects one verified Resend email event onto the guest-thread delivery it
 * belongs to. Events for mail that is not a guest-thread delivery — every
 * Broadcast recipient among them — match nothing and change nothing: their
 * analytics, bounces, complaints and suppressions are Resend's. A delivery
 * that moves forward republishes its thread to open inboxes.
 */
export async function applyResendEmailEvent(
  db: DbClient,
  env: GuestInboxPublicationEnv,
  event: WebhookEventPayload,
): Promise<'ignored' | 'no_delivery' | 'advanced' | 'unchanged'> {
  const status = resendProjectedStatus(event)
  if (!status || !('email_id' in event.data)) return 'ignored'
  const delivery = await getDeliveryByProviderMessageId(db, 'resend', event.data.email_id)
  if (!delivery) return 'no_delivery'
  if (!isEmailMessageId(event.data.message_id)) throw new Error('Resend webhook has no valid RFC Message-ID')
  if (delivery.email_message_id && delivery.email_message_id !== event.data.message_id) throw new Error('Resend webhook Message-ID differs from its delivery')
  const identity = await execute(db, `UPDATE guest_thread_deliveries SET email_message_id = ?,
    error = CASE WHEN status IN ('accepted','sent','delivered','read') THEN NULL ELSE error END
    WHERE id = ? AND (email_message_id IS NULL OR email_message_id = ?)`, [event.data.message_id, delivery.id, event.data.message_id])
  if (!identity.meta.changes) throw new Error('Email delivery RFC identity changed during webhook processing')
  const changed = await advanceDeliveryStatus(db, delivery, status, status === 'failed' ? resendFailureReason(event) : null)
  if (!changed) return 'unchanged'
  if (delivery.message_id) {
    const message = await queryFirst<{ conversation_id: string; sequence: number }>(db, 'SELECT conversation_id, sequence FROM messages WHERE id = ?', [delivery.message_id])
    if (!message) throw new Error(`Message ${delivery.message_id} for delivery ${delivery.id} not found`)
    await publishConversationEvent(env, db, { conversationId: message.conversation_id, type: 'MESSAGE_UPDATE', message: { id: delivery.message_id, sequence: message.sequence } })
  }
  return 'advanced'
}

/**
 * Writes a send's outcome onto its receipt. A receipt that already reached the
 * provider keeps its state: a duplicate send Resend refused is not this email's
 * outcome, and a webhook may already have moved it on.
 */
export async function recordDeliveryOutcome(
  db: DbClient,
  input: {
    deliveryId: string
    status: Exclude<GuestThreadDeliveryStatus, 'pending'>
    providerMessageId?: string | null
    error?: string | null
  },
  more: BatchQuery[] = [],
): Promise<GuestThreadDeliveryRow> {
  await executeBatch(db, [{
    query: `UPDATE guest_thread_deliveries
      SET status = ?, provider_message_id = COALESCE(?, provider_message_id), error = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('accepted', 'sent', 'delivered', 'read')`,
    params: [input.status, input.providerMessageId ?? null, input.error ?? null, new Date().toISOString(), input.deliveryId],
  }, ...await deliveryTaskQueries(db, input.deliveryId), ...more], { operation: 'Record delivery outcome' })
  const updated = await getDeliveryById(db, input.deliveryId)
  if (!updated) throw new Error('Guest thread delivery not found')
  return updated
}

/**
 * Sends a guest-thread email once. A receipt that already reached Resend is
 * returned as it is; anything else is sent under the receipt's id, which is
 * the Resend idempotency key, so a repeated request cannot send it twice.
 */
export async function deliverGuestThreadEmail(
  db: DbClient,
  input: {
    delivery: GuestThreadDeliveryRow
    env: ReplyEmailEnv
    to: string
    fromName: string
    subject: string
    email: { html: string; text: string }
    conversationId: string
  },
): Promise<GuestThreadDeliveryRow> {
  if (input.delivery.channel !== 'email') throw new Error('Delivery channel is not email')
  if (!input.delivery.message_id) throw new Error('A guest email is about a message')
  if (isDeliverySent(input.delivery) && !input.delivery.error) return input.delivery
  return deliverReceiptEmail(db, {
    delivery: input.delivery, env: input.env, threadId: input.conversationId,
    email: {
      to: input.to, fromName: input.fromName, subject: input.subject,
      ...input.email, emailPurpose: 'transactional',
      replyTo: await buildReplyToAddress(input.env, input.delivery.message_id, { kind: 'guest' }),
    },
  })
}

/**
 * Every delivery this thread produced, newest first. The thread is the only
 * place that knows a message went out over WhatsApp rather than email, so the
 * detail view reads all of them from here and decides what to show; a query
 * that returned failures alone is why a successful send had no channel on it.
 */
export function threadDeliveriesQuery(threadId: string, messageIds?: string[]): BatchQuery {
  return { query: `
    SELECT d.* FROM guest_thread_deliveries d
    JOIN messages m ON m.id = d.message_id
    WHERE m.conversation_id = ? ${messageIds ? 'AND m.id IN (SELECT value FROM json_each(?))' : ''}
    ORDER BY d.created_at DESC
  `, params: [threadId, ...(messageIds ? [d1JsonStringSet(messageIds)] : [])] }
}

export async function listThreadDeliveries(db: DbClient, threadId: string): Promise<GuestThreadDeliveryRow[]> {
  const { query, params } = threadDeliveriesQuery(threadId)
  return queryAll<GuestThreadDeliveryRow>(db, query, params)
}

/** A failure worth showing in the thread. */
export function isVisibleDeliveryFailure(delivery: GuestThreadDeliveryRow): boolean {
  return delivery.status === 'failed'
    || (delivery.channel === 'email' && delivery.status !== 'skipped' && Boolean(delivery.error))
}
