import { HTTPError } from 'nitro'
import { execute, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { isValidInstant } from '~/utils/timezone'
import { guestMessageDueAt, messagingError } from './guest-message-schedule'
import { templateSchedule, type MessageTemplateRow, type ScheduledGuestMessageRow } from './guest-messaging'
import { sendScheduledGuestReply, type ReplyOutcome } from './guest-threads/operations'
import { publishGuestInboxThreadEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { ChannexError } from '~/server/integrations/channex/client'

interface PlanningStay {
  id: string
  organization_id: string
  product_id: string
  request_id: string | null
  status: 'pending' | 'confirmed' | 'cancelled'
  check_in_date: string
  check_out_date: string
  booking_received_at: string | null
  version: number
  updated_at: string
  timezone: string
  timezone_updated_at: string | null
}

type Plan = Pick<ScheduledGuestMessageRow, 'due_at' | 'status' | 'reason' | 'error_code' | 'error_field'>

const PLANNING_STAY = `SELECT s.id, s.organization_id, s.product_id, s.request_id, s.status, s.check_in_date, s.check_out_date,
  s.booking_received_at, s.version, s.updated_at, l.timezone, l.updated_at AS timezone_updated_at
  FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
  JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id`

function validTimestamp(value: string, field: string): void {
  if (!isValidInstant(value) || new Date(value).toISOString() !== value) messagingError(500, 'INVALID_MESSAGING_DATA', `The stored ${field} timestamp is invalid`, field)
}

/** Only pending plans change. A completed or uncertain send can never be recreated. */
async function plan(db: DbClient, template: MessageTemplateRow, stay: PlanningStay, now: string): Promise<void> {
  const existing = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE template_id = ? AND stay_id = ?', [template.id, stay.id])
  if (existing && existing.status !== 'pending') return
  if (existing && existing.template_version === template.version && existing.stay_version === stay.version
    && existing.timezone === stay.timezone && existing.request_id === stay.request_id) return
  const schedule = templateSchedule(template)
  if (schedule === null || !schedule.productIds.includes(stay.product_id) || stay.status === 'cancelled') {
    if (existing) await execute(db, `UPDATE scheduled_guest_messages SET request_id = ?, status = 'cancelled', reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND updated_at = ?
        AND EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?)
        AND EXISTS (SELECT 1 FROM stays WHERE id = ? AND organization_id = ? AND version = ? AND request_id IS ?)`,
    [stay.request_id, stay.status === 'cancelled' ? 'The stay was cancelled.' : 'The saved reply no longer schedules this home.', now, existing.id, existing.updated_at,
      template.id, template.organization_id, template.version, stay.id, stay.organization_id, stay.version, stay.request_id])
    return
  }
  let values: Plan
  try {
    let due: string
    if (schedule.trigger === 'booking_received') {
      if (stay.booking_received_at === null) {
        values = { due_at: null, status: 'skipped', reason: 'This stay was imported or was already known before new-reservation scheduling. No new-reservation message will be sent.', error_code: null, error_field: null }
        await savePlan(db, template, stay, existing, values, now)
        return
      }
      validTimestamp(stay.booking_received_at, 'stay.bookingReceivedAt')
      if (template.schedule_enabled_at === null) messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The schedule has no activation timestamp', 'scheduleEnabledAt')
      if (stay.booking_received_at <= template.schedule_enabled_at) {
        values = { due_at: null, status: 'skipped', reason: 'The stay was received before this schedule was activated. No new-reservation message will be sent.', error_code: null, error_field: null }
        await savePlan(db, template, stay, existing, values, now)
        return
      }
      due = new Date(Date.parse(stay.booking_received_at) + schedule.delayMinutes * 60000).toISOString()
    } else due = guestMessageDueAt(schedule, stay, stay.timezone)
    validTimestamp(template.updated_at, 'template.updatedAt')
    validTimestamp(stay.updated_at, 'stay.updatedAt')
    if (stay.timezone_updated_at !== null) validTimestamp(stay.timezone_updated_at, 'home.timezoneUpdatedAt')
    const changedAt = [template.updated_at, stay.updated_at, ...(stay.timezone_updated_at === null ? [] : [stay.timezone_updated_at])].sort().at(-1)!
    const past = due <= changedAt && (existing === undefined || existing.due_at !== due)
    values = { due_at: due, status: past ? 'skipped' : 'pending', reason: past ? 'This event was already in the past when the schedule or stay changed.' : null, error_code: null, error_field: null }
  } catch (error) {
    if (!(error instanceof HTTPError) || !error.data || typeof error.data !== 'object'
      || !('code' in error.data) || typeof error.data.code !== 'string' || !('field' in error.data) || typeof error.data.field !== 'string') throw error
    values = { due_at: null, status: 'failed', reason: error.message, error_code: error.data.code, error_field: error.data.field }
  }
  await savePlan(db, template, stay, existing, values, now)
}

async function savePlan(db: DbClient, template: MessageTemplateRow, stay: PlanningStay, existing: ScheduledGuestMessageRow | undefined, values: Plan, now: string): Promise<void> {
  // Both observed source versions are part of the write. A stale planner can
  // neither overwrite a newer snapshot nor insert one after a concurrent edit.
  const scope = `EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?)
    AND EXISTS (SELECT 1 FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
      WHERE s.id = ? AND s.organization_id = ? AND s.version = ? AND s.request_id IS ? AND l.timezone = ?)`
  const guards = [template.id, template.organization_id, template.version, stay.id, stay.organization_id, stay.version, stay.request_id, stay.timezone]
  if (existing) {
    await execute(db, `UPDATE scheduled_guest_messages SET request_id = ?, template_title = ?, template_version = ?, stay_version = ?, body = ?, due_at = ?, timezone = ?, status = ?, reason = ?, error_code = ?, error_field = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND updated_at = ? AND ${scope}`,
    [stay.request_id, template.title, template.version, stay.version, template.body, values.due_at, stay.timezone, values.status, values.reason, values.error_code, values.error_field, now, existing.id, existing.updated_at, ...guards])
  } else {
    await execute(db, `INSERT INTO scheduled_guest_messages (id, organization_id, product_id, stay_id, request_id, template_id, template_title, template_version, stay_version,
      body, due_at, timezone, status, reason, error_code, error_field, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${scope}
      ON CONFLICT(template_id, stay_id) DO NOTHING`,
    [crypto.randomUUID(), stay.organization_id, stay.product_id, stay.id, stay.request_id, template.id, template.title, template.version, stay.version,
      template.body, values.due_at, stay.timezone, values.status, values.reason, values.error_code, values.error_field, now, now, ...guards])
  }
}

export async function planStayMessages(db: DbClient, organizationId: string, stayId: string, now = new Date().toISOString()): Promise<void> {
  const stay = await queryFirst<PlanningStay>(db, `${PLANNING_STAY} WHERE s.organization_id = ? AND s.id = ?`, [organizationId, stayId])
  if (!stay) messagingError(500, 'INVALID_MESSAGE_STAY', 'The stay’s home or timezone is missing; its messages could not be planned', 'stayId')
  const templates = await queryAllPages<MessageTemplateRow>(db, 'SELECT * FROM message_templates WHERE organization_id = ? ORDER BY id', [organizationId])
  for (const template of templates) await plan(db, template, stay, now)
}

export async function planTemplateMessages(db: DbClient, template: MessageTemplateRow, now = new Date().toISOString()): Promise<void> {
  const schedule = templateSchedule(template)
  const stays = await queryAllPages<PlanningStay>(db, `${PLANNING_STAY} WHERE s.organization_id = ? AND (s.product_id IN (SELECT value FROM json_each(?))
    OR s.id IN (SELECT stay_id FROM scheduled_guest_messages WHERE template_id = ? AND status = 'pending')) ORDER BY s.id`,
  [template.organization_id, JSON.stringify(schedule === null ? [] : schedule.productIds), template.id])
  for (const stay of stays) await plan(db, template, stay, now)
}

export async function planHomeMessages(db: DbClient, organizationId: string, locationId: string, now = new Date().toISOString()): Promise<void> {
  const rows = await queryAllPages<{ id: string }>(db, `SELECT s.id FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
    WHERE s.organization_id = ? AND c.location_id = ? AND s.status <> 'cancelled' ORDER BY s.id`, [organizationId, locationId])
  for (const row of rows) await planStayMessages(db, organizationId, row.id, now)
}

/**
 * Cron recovery reads the same persisted source versions as foreground writes.
 * One template's failure does not stop the others; every failure is returned
 * for the run to report.
 */
async function reconcileScheduledGuestMessagePlans(db: DbClient, now: string): Promise<Error[]> {
  const templates = await queryAllPages<MessageTemplateRow>(db, 'SELECT * FROM message_templates WHERE schedule_json IS NOT NULL ORDER BY id', [])
  const failures: Error[] = []
  for (const template of templates) {
    try {
      await planTemplateMessages(db, template, now)
    } catch (error) {
      failures.push(new Error(`Planning template ${template.id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  return failures
}

type SendEnv = Parameters<typeof sendScheduledGuestReply>[1]['env'] & GuestInboxPublicationEnv
type SendFailure = { status: 'failed' | 'needs_review'; reason: string; error_code: string; error_field: string }

/** Every non-sent reply outcome carries its own typed facts; none is generalized here. */
function sendFailure(outcome: Exclude<ReplyOutcome, { ok: true }>): SendFailure {
  switch (outcome.reason) {
    case 'thread_not_found': return { status: 'failed', reason: 'The stay’s guest conversation no longer exists.', error_code: 'THREAD_NOT_FOUND', error_field: 'requestId' }
    case 'source_not_found': return { status: 'failed', reason: 'The conversation’s stay no longer exists.', error_code: 'SOURCE_NOT_FOUND', error_field: 'stayId' }
    case 'guest_invite_required': return { status: 'failed', reason: 'The stay has no guest email and its guest has not joined the conversation through an invite.', error_code: outcome.code, error_field: outcome.field }
    case 'empty_body': return { status: 'failed', reason: 'The scheduled message has no text.', error_code: 'EMPTY_MESSAGE', error_field: 'body' }
    case 'missing_idempotency_key': return { status: 'failed', reason: 'The scheduled send had no idempotency key.', error_code: 'MISSING_IDEMPOTENCY_KEY', error_field: 'idempotencyKey' }
    case 'invalid_photo': return { status: 'failed', reason: outcome.message, error_code: 'INVALID_PHOTO', error_field: 'photos' }
    case 'invalid_transition': return { status: 'needs_review', reason: outcome.message, error_code: 'IDEMPOTENCY_CONFLICT', error_field: 'idempotencyKey' }
    case 'delivery_failed': return {
      // Only a refused delivery is a definite failure; an uncertain or
      // unreviewed attempt is never resent automatically.
      status: outcome.code === 'DELIVERY_FAILED' || outcome.code === 'CHANNEL_REPLY_FAILED' ? 'failed' : 'needs_review',
      reason: outcome.message, error_code: outcome.code, error_field: outcome.field,
    }
  }
}

async function finishSend(db: DbClient, id: string, values: { status: 'sent' | 'failed' | 'needs_review'; reason: string | null; error_code: string | null; error_field: string | null; entry_id: string | null; sent_at: string | null }): Promise<void> {
  const now = new Date().toISOString()
  const result = await execute(db, `UPDATE scheduled_guest_messages SET status = ?, reason = ?, error_code = ?, error_field = ?, entry_id = ?, sent_at = ?, updated_at = ?
    WHERE id = ? AND status = 'sending'`, [values.status, values.reason, values.error_code, values.error_field, values.entry_id, values.sent_at, now, id])
  if (result.meta.changes !== 1) messagingError(409, 'SCHEDULED_MESSAGE_NOT_SENDING', 'The scheduled message outcome could not be recorded because it is no longer sending', 'status')
}

/**
 * Send one due message. Its plan is refreshed first so a stay or template
 * change since planning wins; a claimed row records its outcome. An error with
 * no typed facts leaves the row visibly sending and fails the run: whether the
 * provider accepted it is unknown, so it is never resent automatically.
 */
async function sendScheduledGuestMessage(db: DbClient, env: SendEnv, row: Pick<ScheduledGuestMessageRow, 'id' | 'organization_id' | 'stay_id'>, now: string): Promise<'sent' | 'failed' | 'needs_review' | 'not_due'> {
  await planStayMessages(db, row.organization_id, row.stay_id, now)
  const current = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE id = ?', [row.id])
  if (!current || current.status !== 'pending' || current.due_at === null || current.due_at > now) return 'not_due'
  const claim = await execute(db, `UPDATE scheduled_guest_messages SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND updated_at = ?`,
    [now, now, current.id, current.updated_at])
  if (claim.meta.changes !== 1) return 'not_due'
  if (current.request_id === null) {
    await finishSend(db, current.id, { status: 'failed', reason: 'The stay has no guest conversation to send through.', error_code: 'STAY_CONVERSATION_REQUIRED', error_field: 'requestId', entry_id: null, sent_at: null })
    return 'failed'
  }
  let sent: Awaited<ReturnType<typeof sendScheduledGuestReply>>
  try {
    sent = await sendScheduledGuestReply(db, { threadId: current.request_id, organizationId: current.organization_id, body: current.body, idempotencyKey: `scheduled-guest-message:${current.id}`, env })
  } catch (error) {
    // The Channex send itself records its own outcome on the reply receipt, so a
    // ChannexError here came from a read before anything was sent.
    const data = error instanceof HTTPError || error instanceof ChannexError ? error.data : null
    if (!data || typeof data !== 'object' || !('code' in data) || typeof data.code !== 'string' || !('field' in data) || typeof data.field !== 'string') throw error
    await finishSend(db, current.id, { status: 'failed', reason: (error as Error).message, error_code: data.code, error_field: data.field, entry_id: null, sent_at: null })
    return 'failed'
  }
  if (sent.outcome.ok) {
    if (sent.entryId === null) messagingError(500, 'SCHEDULED_MESSAGE_ENTRY_REQUIRED', 'The scheduled message was sent but its conversation entry could not be read', 'entryId')
    await finishSend(db, current.id, { status: 'sent', reason: null, error_code: null, error_field: null, entry_id: sent.entryId, sent_at: new Date().toISOString() })
    await publishGuestInboxThreadEvent(env, db, { threadId: current.request_id, type: 'entry.appended' })
    return 'sent'
  }
  const failure = sendFailure(sent.outcome)
  await finishSend(db, current.id, { ...failure, entry_id: sent.entryId, sent_at: null })
  if (sent.entryId !== null) await publishGuestInboxThreadEvent(env, db, { threadId: current.request_id, type: 'entry.appended' })
  return failure.status
}

/** The production cron: recover plans from persisted sources, then send what is due. */
export async function sendDueScheduledGuestMessages(db: DbClient, env: SendEnv, now = new Date().toISOString()): Promise<{ sent: number; failed: number; needs_review: number }> {
  const failures = await reconcileScheduledGuestMessagePlans(db, now)
  const due = await queryAllPages<Pick<ScheduledGuestMessageRow, 'id' | 'organization_id' | 'stay_id'>>(db,
    "SELECT id, organization_id, stay_id FROM scheduled_guest_messages WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id", [now])
  const counts = { sent: 0, failed: 0, needs_review: 0 }
  // Each message is sent on its own; an untyped failure leaves its row
  // visibly sending and fails the run after every other due message is tried.
  for (const row of due) {
    try {
      const result = await sendScheduledGuestMessage(db, env, row, now)
      if (result !== 'not_due') counts[result] += 1
    } catch (error) {
      failures.push(new Error(`Scheduled message ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} scheduled guest message operations failed (sent ${counts.sent}, failed ${counts.failed}, needs review ${counts.needs_review}): ${failures.map(error => error.message).join('; ')}`)
  return counts
}
