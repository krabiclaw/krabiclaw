import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { WebhookEventPayload } from 'resend'
import { notifyBuyerThread } from '~/server/utils/notification-center'
import { buildReplyToAddress, type ReplyEmailEnv } from '~/server/utils/submission-messages'
import { emailSender, getEmailDeliveryMode, isEmailMessageId, sendEmail, type EmailInput } from '~/server/utils/email-delivery'
import { getResendClient, resendData } from '~/server/utils/resend'
import { isRecord } from '~/server/utils/type-guards'
import { publishGuestInboxThreadEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import type {
  GuestThreadDeliveryChannel,
  GuestThreadDeliveryPurpose,
  GuestThreadDeliveryProvider,
  GuestThreadDeliveryRow,
  GuestThreadDeliveryStatus,
  GuestThreadSubmissionType,
} from './types'

/** Email delivery also retains the provider's RFC ID before a later reply can depend on it. */
export function isDeliverySent(delivery: GuestThreadDeliveryRow): boolean {
  const sent = delivery.status === 'accepted' || delivery.status === 'sent' || delivery.status === 'delivered' || delivery.status === 'read'
  return sent && (delivery.channel !== 'email' || delivery.provider !== 'resend' || delivery.purpose === 'owner_alert' || isEmailMessageId(delivery.email_message_id))
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

async function readProviderEmail(db: DbClient, env: ReplyEmailEnv, delivery: GuestThreadDeliveryRow) {
  if (delivery.provider !== 'resend' || !delivery.provider_message_id) throw new Error('Email delivery has no Resend identity')
  const client = getResendClient(env)
  const deadline = Date.now() + 20_000
  let email = await resendData('conversation email readback', () => client.emails.get(delivery.provider_message_id!))
  // Accepted email is initially queued with message_id=null. Wait for the
  // provider to assign it; the saved API UUID remains the recovery identity.
  while (!isEmailMessageId(email.message_id)) {
    if (email.id !== delivery.provider_message_id || email.message_id || !['queued', 'sent'].includes(email.last_event) || Date.now() >= deadline) {
      throw new Error(`Resend email has no usable RFC Message-ID (${email.last_event}); its recorded provider identity can resume readback`)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    email = await resendData('conversation email readback', () => client.emails.get(delivery.provider_message_id!))
  }
  if (email.id !== delivery.provider_message_id) throw new Error('Resend returned a different email identity')
  if (delivery.email_message_id && delivery.email_message_id !== email.message_id) throw new Error('Resend email Message-ID differs from its recorded delivery')
  if (delivery.email_json) {
    const snapshot = readEmailSnapshot(delivery.email_json)
    if (email.to.length !== 1 || email.to[0]!.trim().toLowerCase() !== snapshot.message.to.trim().toLowerCase() || email.subject !== snapshot.message.subject) {
      throw new Error('Resend email does not match its recorded recipient and subject')
    }
  }
  const updated = await execute(db, 'UPDATE guest_thread_deliveries SET email_message_id = ? WHERE id = ? AND (email_message_id IS NULL OR email_message_id = ?)', [email.message_id, delivery.id, email.message_id])
  if (!updated.meta.changes) throw new Error('Email delivery RFC identity changed during provider readback')
  return email
}

/** Only this request and this recipient can contribute email ancestry. */
async function conversationEmailParent(db: DbClient, env: ReplyEmailEnv, delivery: GuestThreadDeliveryRow, threadId: string, sequence: number, recipient: string) {
  const candidates = await queryAll<{
    id: string; sequence: number; created_at: string; payload_json: string | null
    email_json: string | null; email_message_id: string | null; provider: string | null; provider_message_id: string | null
  }>(db, `
    SELECT e.id, e.sequence, e.created_at, e.payload_json, NULL AS email_json, NULL AS email_message_id, NULL AS provider, NULL AS provider_message_id
    FROM activity_entries e
    WHERE e.request_id = ? AND e.sequence < ? AND e.actor_kind = 'guest' AND e.channel = 'email'
    UNION ALL
    SELECT d.id, e.sequence, d.created_at, NULL, d.email_json, d.email_message_id, d.provider, d.provider_message_id
    FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
    WHERE e.request_id = ? AND e.sequence <= ? AND d.id <> ?
      AND d.channel = 'email' AND d.purpose <> 'owner_alert'
      AND d.status IN ('accepted', 'sent', 'delivered', 'read')
    ORDER BY sequence DESC, created_at DESC, id DESC
  `, [threadId, sequence, threadId, sequence, delivery.id])
  let parent: { subject: string | null; messageId: string } | null = null
  let knownSubject: string | null = null
  const references: string[] = []
  for (const candidate of candidates) {
    if (candidate.payload_json !== null) {
      const payload: unknown = JSON.parse(candidate.payload_json)
      const email = isRecord(payload) && isRecord(payload.email) ? payload.email : null
      if (!email || typeof email.from !== 'string' || email.from.trim().toLowerCase() !== recipient) continue
      if (email.messageId === null) continue // A missing RFC ID is not the content hash used for deduplication.
      if (!isEmailMessageId(email.messageId) || !(email.subject === null || typeof email.subject === 'string')) throw new Error('Received conversation email has invalid threading metadata')
      if (typeof email.subject === 'string') knownSubject ??= email.subject
      parent ??= { subject: email.subject, messageId: email.messageId }
      references.push(email.messageId)
      continue
    }
    const snapshot = candidate.email_json === null ? null : readEmailSnapshot(candidate.email_json)
    if (snapshot && snapshot.message.to.trim().toLowerCase() !== recipient) continue
    if (snapshot) knownSubject ??= snapshot.message.subject
    if (candidate.provider === 'log_only') continue // No email, and therefore no provider-assigned RFC ID, exists in this mode.
    let messageId = candidate.email_message_id
    let subject = snapshot?.message.subject
    if (!messageId || subject === undefined) {
      // Older delivery records get their missing metadata from Resend, never
      // from a guessed confirmation title or a fabricated Message-ID.
      if (parent) continue
      const recorded = await getDeliveryById(db, candidate.id)
      if (!recorded) throw new Error('Prior conversation email delivery disappeared')
      const email = await readProviderEmail(db, env, recorded)
      if (!email.to.some(to => to.trim().toLowerCase() === recipient)) continue
      messageId = email.message_id
      subject = email.subject
    }
    if (!isEmailMessageId(messageId)) throw new Error('Prior conversation email has an invalid RFC Message-ID')
    knownSubject ??= subject
    parent ??= { subject, messageId }
    references.push(messageId)
  }
  return parent ? { subject: `Re: ${(parent.subject ?? knownSubject ?? '').replace(/^(?:re:\s*)+/iu, '').replace(/[\r\n]+/gu, ' ').trim()}`.trim(), inReplyTo: parent.messageId, references: [...new Set(references.reverse())] } : null
}

/** The one receipt-backed email dispatcher, shared by notifications and replies. */
export async function deliverReceiptEmail(db: DbClient, input: {
  env: ReplyEmailEnv; delivery: GuestThreadDeliveryRow; threadId: string | null; email: EmailInput
}): Promise<GuestThreadDeliveryRow> {
  let delivery = await getDeliveryById(db, input.delivery.id)
  if (!delivery || delivery.entry_id !== input.delivery.entry_id || delivery.channel !== 'email') throw new Error('Email delivery does not match its ledger entry')
  if (delivery.provider !== (getEmailDeliveryMode(input.env) === 'provider' ? 'resend' : 'log_only')) throw new Error('Email delivery mode differs from its recorded provider')
  const entry = await queryFirst<{ request_id: string | null; sequence: number | null }>(db, 'SELECT request_id, sequence FROM activity_entries WHERE id = ?', [delivery.entry_id])
  if (!entry || entry.request_id !== input.threadId) throw new Error('Email delivery does not belong to the targeted conversation')
  const threaded = input.threadId !== null && delivery.purpose !== 'owner_alert'
  if (threaded && entry.sequence === null) throw new Error('Conversation email delivery has no ledger sequence')
  try {
    if (!isDeliverySent(delivery) && !delivery.provider_message_id) {
      if (delivery.email_json === null) {
        if (delivery.provider === 'resend' && Date.now() - Date.parse(delivery.created_at) >= 24 * 60 * 60 * 1000) {
          throw new Error('This email has no recorded provider identity and is past Resend\'s 24-hour idempotency window. Review its provider delivery before sending again.')
        }
        const parent = threaded ? await conversationEmailParent(db, input.env, delivery, input.threadId!, entry.sequence!, input.email.to.trim().toLowerCase()) : null
        const snapshot: EmailSnapshot = {
          preparedAt: new Date().toISOString(),
          sender: delivery.provider === 'resend' || input.env.EMAIL_FROM?.trim() ? emailSender(input.env, input.email.fromName) : null,
          message: { ...input.email, ...(parent ?? {}) },
        }
        // The first contender freezes the complete request. A retry never
        // changes ancestry, subject, recipient, sender, body or attachments.
        await execute(db, 'UPDATE guest_thread_deliveries SET email_json = ? WHERE id = ? AND email_json IS NULL', [JSON.stringify(snapshot), delivery.id])
        delivery = (await getDeliveryById(db, delivery.id))!
      }
      const snapshot = readEmailSnapshot(delivery.email_json!)
      if (snapshot.message.to.trim().toLowerCase() !== input.email.to.trim().toLowerCase()) throw new Error('Email recipient differs from its recorded delivery')
      if (delivery.provider === 'resend' && Date.now() - Date.parse(snapshot.preparedAt) >= 24 * 60 * 60 * 1000) {
        throw new Error('This email has no recorded provider identity and is past Resend\'s 24-hour idempotency window. Review its provider delivery before sending again.')
      }
      // A provider ID is persisted before readback. If readback fails, retrying
      // resumes it instead of sending the message a second time.
      if (!delivery.provider_message_id) {
        const result = await sendEmail({ ...input.env, ...(snapshot.sender ? { EMAIL_FROM: snapshot.sender } : {}) }, { ...snapshot.message, idempotencyKey: delivery.id })
        delivery = await recordDeliveryOutcome(db, {
          deliveryId: delivery.id, status: result.status,
          providerMessageId: result.status === 'sent' ? result.messageId : null,
          error: result.status === 'failed' ? result.error : null,
        })
        if (result.status === 'failed') return delivery
      }
    }
    if (delivery.provider === 'resend' && delivery.purpose !== 'owner_alert' && delivery.provider_message_id && delivery.email_message_id === null) await readProviderEmail(db, input.env, delivery)
    await execute(db, "UPDATE guest_thread_deliveries SET error = NULL WHERE id = ? AND status IN ('accepted','sent','delivered','read')", [delivery.id])
    const completed = await getDeliveryById(db, delivery.id)
    if (!completed) throw new Error('Email delivery disappeared after dispatch')
    return completed
  } catch (error) {
    await execute(db, 'UPDATE guest_thread_deliveries SET error = ? WHERE id = ?', [error instanceof Error ? error.message : String(error), delivery.id])
    throw error
  }
}

export async function createDeliveryReceipt(
  db: DbClient,
  input: {
    entryId: string
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
        (id, entry_id, channel, provider, purpose, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `, [
      id,
      input.entryId,
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
export async function advanceDeliveryStatus(
  db: DbClient,
  delivery: { id: string; status: string },
  incoming: GuestThreadDeliveryStatus,
  error: string | null,
): Promise<boolean> {
  let observed = delivery.status
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!compareDeliveryStatus(observed, incoming)) return false
    const result = await execute(db, `
      UPDATE guest_thread_deliveries
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `, [incoming, error, new Date().toISOString(), delivery.id, observed])
    if (result.meta.changes > 0) return true
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
  const entry = await queryFirst<{ request_id: string | null }>(db, 'SELECT request_id FROM activity_entries WHERE id = ?', [delivery.entry_id])
  if (!entry) throw new Error(`Activity entry ${delivery.entry_id} for delivery ${delivery.id} not found`)
  if (entry.request_id) await publishGuestInboxThreadEvent(env, db, { threadId: entry.request_id, type: 'delivery.changed' })
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
    nonDeliveryConfirmed?: boolean
  },
): Promise<GuestThreadDeliveryRow> {
  await execute(db, `
    UPDATE guest_thread_deliveries
    SET status = ?, provider_message_id = COALESCE(?, provider_message_id), error = ?, non_delivery_confirmed = ?, updated_at = ?
    WHERE id = ? AND status NOT IN ('accepted', 'sent', 'delivered', 'read')
  `, [input.status, input.providerMessageId ?? null, input.error ?? null, input.nonDeliveryConfirmed === undefined ? null : input.nonDeliveryConfirmed ? 1 : 0, new Date().toISOString(), input.deliveryId])
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
    submissionType: GuestThreadSubmissionType
    submissionId: string
  },
): Promise<GuestThreadDeliveryRow> {
  if (input.delivery.channel !== 'email') throw new Error('Delivery channel is not email')
  await notifyBuyerThread(db, {
    threadId: input.submissionId, entryId: input.delivery.entry_id,
    title: input.subject, message: input.fromName,
    conversation: input.delivery.purpose === 'member_reply' || input.delivery.purpose === 'scheduled_message',
  })
  if (isDeliverySent(input.delivery)) return input.delivery
  return deliverReceiptEmail(db, {
    delivery: input.delivery, env: input.env, threadId: input.submissionId,
    email: {
      to: input.to, fromName: input.fromName, subject: input.subject,
      ...input.email, emailPurpose: 'transactional',
      replyTo: await buildReplyToAddress(input.env, input.submissionType, input.submissionId),
    },
  })
}

/**
 * Every delivery this thread produced, newest first. The thread is the only
 * place that knows a message went out over WhatsApp rather than email, so the
 * detail view reads all of them from here and decides what to show; a query
 * that returned failures alone is why a successful send had no channel on it.
 */
export async function listThreadDeliveries(db: DbClient, threadId: string): Promise<GuestThreadDeliveryRow[]> {
  return queryAll<GuestThreadDeliveryRow>(db, `
    SELECT d.* FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    WHERE e.request_id = ?
    ORDER BY d.created_at DESC
  `, [threadId])
}

/** A failure worth showing in the thread. */
export function isVisibleDeliveryFailure(delivery: GuestThreadDeliveryRow): boolean {
  return delivery.status === 'failed' || delivery.status === 'uncertain'
    || (delivery.channel === 'email' && delivery.status !== 'skipped' && Boolean(delivery.error))
}
