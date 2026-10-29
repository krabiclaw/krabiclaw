import { HTTPError } from 'nitro'
import { execute, queryAll, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { assertAssignedBookingAccess, memberAccessPrincipal, resolveMembership, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { getGuestRequest } from '~/server/domain/requests'
import { isValidInstant } from '~/utils/timezone'
import { messageText, messagingError } from './guest-message-schedule'
import { sendScheduledGuestReply, type ReplyOutcome } from './guest-threads/operations'
import { publishGuestInboxThreadEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { ChannexError } from '~/server/integrations/channex/client'
import type { CloudflareEnv } from '~/server/utils/auth'

export interface SendLaterMessageRow {
  id: string
  organization_id: string
  request_id: string
  user_id: string
  body: string
  due_at: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'needs_review' | 'cancelled'
  reason: string | null
  error_code: string | null
  error_field: string | null
  entry_id: string | null
  version: number
  started_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export function sendLaterMessage(row: SendLaterMessageRow) {
  return {
    id: row.id, organizationId: row.organization_id, threadId: row.request_id, body: row.body, sendAt: row.due_at,
    status: row.status, reason: row.reason, errorCode: row.error_code, errorField: row.error_field, entryId: row.entry_id,
    version: row.version, sentAt: row.sent_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

/** A send time is a future instant, at most a year ahead. */
function sendAt(value: unknown, now: string): string {
  if (typeof value !== 'string' || !isValidInstant(value)) messagingError(422, 'INVALID_MESSAGING_FIELD', 'sendAt must be an ISO 8601 instant', 'sendAt')
  const instant = new Date(value).toISOString()
  if (instant <= now) messagingError(422, 'SEND_LATER_IN_PAST', 'Choose a time in the future', 'sendAt')
  if (Date.parse(instant) - Date.parse(now) > 366 * 86_400_000) messagingError(422, 'SEND_LATER_TOO_FAR', 'Choose a time within the next year', 'sendAt')
  return instant
}

/** The author's own pending message; anyone else's is not found. */
async function ownMessage(db: DbClient, principal: MemberAccessPrincipal, messageId: string): Promise<SendLaterMessageRow> {
  const row = await queryFirst<SendLaterMessageRow>(db, 'SELECT * FROM send_later_messages WHERE organization_id = ? AND id = ? AND user_id = ?',
    [principal.organizationId, messageId, principal.userId])
  if (!row) messagingError(404, 'SEND_LATER_NOT_FOUND', 'This scheduled message does not exist or is not yours', 'messageId')
  return row
}

export async function createSendLaterMessage(db: DbClient, principal: MemberAccessPrincipal, threadId: string, value: { body: unknown; sendAt: unknown }, now = new Date().toISOString()) {
  const body = messageText(value.body, 'body', 5000)
  const due = sendAt(value.sendAt, now)
  const thread = await getGuestRequest(db, threadId, principal.organizationId)
  if (!thread) messagingError(404, 'THREAD_NOT_FOUND', 'Thread not found', 'threadId')
  await assertAssignedBookingAccess(db, { ...principal, requestId: thread.id })
  const id = crypto.randomUUID()
  await execute(db, `INSERT INTO send_later_messages (id, organization_id, request_id, user_id, body, due_at, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`, [id, principal.organizationId, thread.id, principal.userId, body, due, now, now])
  return sendLaterMessage(await ownMessage(db, principal, id))
}

/** The author's messages, pending first, optionally for one conversation. */
export async function listSendLaterMessages(db: DbClient, principal: MemberAccessPrincipal, threadId: string | null) {
  const rows = await queryAll<SendLaterMessageRow>(db, `SELECT * FROM send_later_messages WHERE organization_id = ? AND user_id = ?
    AND (? IS NULL OR request_id = ?) AND status IN ('pending', 'sending', 'failed', 'needs_review')
    ORDER BY due_at, id LIMIT 200`, [principal.organizationId, principal.userId, threadId, threadId])
  return rows.map(sendLaterMessage)
}

export async function updateSendLaterMessage(db: DbClient, principal: MemberAccessPrincipal, messageId: string, value: { body: unknown; sendAt: unknown; expectedVersion: unknown }, now = new Date().toISOString()) {
  const current = await ownMessage(db, principal, messageId)
  if (value.expectedVersion !== current.version) messagingError(409, 'SEND_LATER_VERSION_CONFLICT', 'This scheduled message changed; reload it before editing', 'expectedVersion')
  if (current.status !== 'pending') messagingError(409, 'SEND_LATER_NOT_PENDING', 'Only a message that has not started sending can be edited', 'status')
  const body = messageText(value.body, 'body', 5000)
  const due = sendAt(value.sendAt, now)
  const result = await execute(db, `UPDATE send_later_messages SET body = ?, due_at = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'pending' AND version = ?`, [body, due, now, current.id, principal.userId, current.version])
  if (result.meta.changes !== 1) messagingError(409, 'SEND_LATER_VERSION_CONFLICT', 'This scheduled message changed; reload it before editing', 'expectedVersion')
  return sendLaterMessage(await ownMessage(db, principal, current.id))
}

export async function cancelSendLaterMessage(db: DbClient, principal: MemberAccessPrincipal, messageId: string, now = new Date().toISOString()) {
  const current = await ownMessage(db, principal, messageId)
  const result = await execute(db, `UPDATE send_later_messages SET status = 'cancelled', reason = 'Cancelled by its author.', version = version + 1, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'pending'`, [now, current.id, principal.userId])
  if (result.meta.changes !== 1) messagingError(409, 'SEND_LATER_NOT_PENDING', 'This message has already started sending and can no longer be cancelled', 'status')
  return sendLaterMessage(await ownMessage(db, principal, current.id))
}

type SendEnv = CloudflareEnv & Parameters<typeof sendScheduledGuestReply>[1]['env'] & GuestInboxPublicationEnv
type Outcome = { status: 'failed' | 'needs_review'; reason: string; error_code: string; error_field: string }

function failure(outcome: Exclude<ReplyOutcome, { ok: true }>): Outcome {
  switch (outcome.reason) {
    case 'thread_not_found': return { status: 'failed', reason: 'The conversation no longer exists.', error_code: 'THREAD_NOT_FOUND', error_field: 'threadId' }
    case 'source_not_found': return { status: 'failed', reason: 'The conversation’s booking no longer exists.', error_code: 'SOURCE_NOT_FOUND', error_field: 'threadId' }
    case 'guest_invite_required': return { status: 'failed', reason: 'The guest has no email and has not joined the conversation through an invite.', error_code: outcome.code, error_field: outcome.field }
    case 'empty_body': return { status: 'failed', reason: 'The message has no text.', error_code: 'EMPTY_MESSAGE', error_field: 'body' }
    case 'missing_idempotency_key': return { status: 'failed', reason: 'The send had no idempotency key.', error_code: 'MISSING_IDEMPOTENCY_KEY', error_field: 'idempotencyKey' }
    case 'invalid_photo': return { status: 'failed', reason: outcome.message, error_code: 'INVALID_PHOTO', error_field: 'photos' }
    case 'invalid_transition': return { status: 'needs_review', reason: outcome.message, error_code: 'IDEMPOTENCY_CONFLICT', error_field: 'idempotencyKey' }
    case 'delivery_failed': return {
      // Only a refused delivery is a definite failure; an uncertain attempt is never resent.
      status: outcome.code === 'DELIVERY_FAILED' || outcome.code === 'CHANNEL_REPLY_FAILED' ? 'failed' : 'needs_review',
      reason: outcome.message, error_code: outcome.code, error_field: outcome.field,
    }
  }
}

async function finish(db: DbClient, id: string, values: { status: 'sent' | 'failed' | 'needs_review'; reason: string | null; error_code: string | null; error_field: string | null; entry_id: string | null; sent_at: string | null }): Promise<void> {
  const result = await execute(db, `UPDATE send_later_messages SET status = ?, reason = ?, error_code = ?, error_field = ?, entry_id = ?, sent_at = ?, updated_at = ?
    WHERE id = ? AND status = 'sending'`, [values.status, values.reason, values.error_code, values.error_field, values.entry_id, values.sent_at, new Date().toISOString(), id])
  if (result.meta.changes !== 1) messagingError(409, 'SEND_LATER_NOT_SENDING', 'The scheduled message outcome could not be recorded because it is no longer sending', 'status')
}

/**
 * Send one due message as its author's own reply. The author must still be a
 * member who can reach the conversation; otherwise it fails visibly. An error
 * with no typed facts leaves the row sending and fails the run: whether the
 * provider accepted it is unknown, so it is never resent automatically.
 */
async function sendOne(db: DbClient, env: SendEnv, row: SendLaterMessageRow, now: string): Promise<'sent' | 'failed' | 'needs_review' | 'not_due'> {
  const claim = await execute(db, `UPDATE send_later_messages SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ? AND due_at <= ?`,
    [now, now, row.id, row.version, now])
  if (claim.meta.changes !== 1) return 'not_due'
  const membership = await resolveMembership(env, { organizationId: row.organization_id, userId: row.user_id })
  try {
    if (!membership) messagingError(403, 'SEND_LATER_AUTHOR_NOT_MEMBER', 'Its author is no longer a member of this workspace', 'userId')
    await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(membership, { env }), requestId: row.request_id })
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error
    await finish(db, row.id, { status: 'failed', reason: error.message, error_code: 'SEND_LATER_ACCESS_REVOKED', error_field: 'userId', entry_id: null, sent_at: null })
    return 'failed'
  }
  let sent: Awaited<ReturnType<typeof sendScheduledGuestReply>>
  try {
    sent = await sendScheduledGuestReply(db, { threadId: row.request_id, organizationId: row.organization_id, body: row.body, idempotencyKey: `send-later:${row.id}`, actorUserId: row.user_id, env })
  } catch (error) {
    const data = error instanceof HTTPError || error instanceof ChannexError ? error.data : null
    if (!data || typeof data !== 'object' || !('code' in data) || typeof data.code !== 'string' || !('field' in data) || typeof data.field !== 'string') throw error
    await finish(db, row.id, { status: 'failed', reason: (error as Error).message, error_code: data.code, error_field: data.field, entry_id: null, sent_at: null })
    return 'failed'
  }
  if (sent.outcome.ok) {
    if (sent.entryId === null) messagingError(500, 'SEND_LATER_ENTRY_REQUIRED', 'The message was sent but its conversation entry could not be read', 'entryId')
    await finish(db, row.id, { status: 'sent', reason: null, error_code: null, error_field: null, entry_id: sent.entryId, sent_at: new Date().toISOString() })
    await publishGuestInboxThreadEvent(env, db, { threadId: row.request_id, type: 'entry.appended' })
    return 'sent'
  }
  const outcome = failure(sent.outcome)
  await finish(db, row.id, { ...outcome, entry_id: sent.entryId, sent_at: null })
  if (sent.entryId !== null) await publishGuestInboxThreadEvent(env, db, { threadId: row.request_id, type: 'entry.appended' })
  return outcome.status
}

/** The production cron: send every due message, each on its own. */
export async function sendDueSendLaterMessages(db: DbClient, env: SendEnv, now = new Date().toISOString()): Promise<{ sent: number; failed: number; needs_review: number }> {
  const due = await queryAllPages<SendLaterMessageRow>(db, "SELECT * FROM send_later_messages WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id", [now])
  const counts = { sent: 0, failed: 0, needs_review: 0 }
  const failures: Error[] = []
  for (const row of due) {
    try {
      const result = await sendOne(db, env, row, now)
      if (result !== 'not_due') counts[result] += 1
    } catch (error) {
      failures.push(new Error(`Send-later message ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} send-later messages failed (sent ${counts.sent}, failed ${counts.failed}, needs review ${counts.needs_review}): ${failures.map(error => error.message).join('; ')}`)
  return counts
}
