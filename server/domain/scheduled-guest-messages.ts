import { HTTPError } from 'nitro'
import { execute, executeBatch, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { messageDeliveryTaskQueries } from './tasks'
import { isValidInstant, isValidTimezone, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { guestMessageDueAt, messagingError, type ScheduleAnchor } from './guest-message-schedule'
import { templateSchedule, type MessageTemplateRow, type ScheduledGuestMessageRow } from './guest-messaging'
import { sendScheduledGuestReply, type OperationOutcome } from './guest-threads/operations'
import { publishGuestInboxThreadEvent, publishStayInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { ChannexError } from '~/server/integrations/channex/client'
import { BOOKED_RECORDS_SQL, bookedRecordGuard, bookedRecordWindow, readBookedRecord, type BookedKind, type BookedRecord } from './requests'

type Plan = Pick<ScheduledGuestMessageRow, 'due_at' | 'status' | 'reason' | 'error_code' | 'error_field'>

/** The record a scheduled message is about, as tasks name it. */
export function messageSubject(row: Pick<ScheduledGuestMessageRow, 'subject_type' | 'subject_id'>): { kind: BookedKind; id: string } {
  return { kind: row.subject_type, id: row.subject_id }
}

/** The day and instant a schedule counts from at the record's start and end. */
function anchors(record: BookedRecord): { check_in: ScheduleAnchor; check_out: ScheduleAnchor } {
  const window = bookedRecordWindow(record)
  return { check_in: window.start, check_out: window.end }
}

/** A scheduled message belongs to its conversation, or its actual stay when no conversation exists. */
export async function publishScheduledGuestMessageChange(
  db: DbClient,
  env: GuestInboxPublicationEnv,
  row: Pick<ScheduledGuestMessageRow, 'organization_id' | 'product_id' | 'subject_type' | 'subject_id' | 'request_id' | 'updated_at'>,
  type: 'thread.changed' | 'entry.appended' = 'thread.changed',
): Promise<void> {
  if (row.request_id !== null) {
    await publishGuestInboxThreadEvent(env, db, { threadId: row.request_id, type })
    return
  }
  // A booking or reservation without a conversation has no open view of its messages beyond the scheduled list, which reads them fresh.
  if (row.subject_type !== 'stay' || row.product_id === null) return
  const stay = await readBookedRecord(db, row.organization_id, messageSubject(row))
  if (!stay?.location_id) messagingError(500, 'INVALID_MESSAGE_STAY', 'The scheduled message’s stay or home is missing; open apps could not be updated', 'subjectId')
  await publishStayInvalidation(env, { type: 'stay.changed', organizationId: row.organization_id, productId: row.product_id, locationId: stay.location_id, stayId: stay.id }, { updated_at: row.updated_at })
}

function validTimestamp(value: string, field: string): void {
  if (!isValidInstant(value) || new Date(value).toISOString() !== value) messagingError(500, 'INVALID_MESSAGING_DATA', `The stored ${field} timestamp is invalid`, field)
}

/** Only pending plans change. A completed or attempted send can never be recreated. */
async function plan(db: DbClient, template: MessageTemplateRow, source: BookedRecord, now: string): Promise<void> {
  const existing = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE template_id = ? AND subject_type = ? AND subject_id = ?', [template.id, source.kind, source.id])
  if (existing && existing.status !== 'pending') return
  const schedule = templateSchedule(template)
  const covered = schedule !== null && schedule.productIds.includes(source.offering_id)
  const guard = bookedRecordGuard(source)
  if (!covered || source.status === 'cancelled') {
    if (existing) await execute(db, `UPDATE scheduled_guest_messages SET request_id = ?, status = 'cancelled', reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND updated_at = ?
        AND EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?) AND ${guard.query}`,
    [source.request_id, source.status === 'cancelled' ? `The ${source.kind} was cancelled.` : 'The automatic message no longer includes this offering.', now, existing.id, existing.updated_at,
      template.id, template.organization_id, template.version, ...guard.params])
    return
  }
  let values: Plan
  try {
    let due: string
    if (schedule.trigger === 'booking_received') {
      if (source.received_at === null) {
        values = { due_at: null, status: 'skipped', reason: 'This stay was imported or was already known before new-reservation scheduling. No new-reservation message will be sent.', error_code: null, error_field: null }
        await savePlan(db, template, source, existing, values, now)
        return
      }
      validTimestamp(source.received_at, 'receivedAt')
      if (template.schedule_enabled_at === null) messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The schedule has no activation timestamp', 'scheduleEnabledAt')
      if (source.received_at <= template.schedule_enabled_at) {
        values = { due_at: null, status: 'skipped', reason: `The ${source.kind} was received before this schedule was activated. No new-${source.kind} message will be sent.`, error_code: null, error_field: null }
        await savePlan(db, template, source, existing, values, now)
        return
      }
      due = new Date(Date.parse(source.received_at) + schedule.delayMinutes * 60000).toISOString()
    } else due = guestMessageDueAt(schedule, anchors(source), source.timezone)
    validTimestamp(template.updated_at, 'template.updatedAt')
    validTimestamp(source.updated_at, 'source.updatedAt')
    if (source.location_updated_at !== null) validTimestamp(source.location_updated_at, 'home.timezoneUpdatedAt')
    const changedAt = [template.updated_at, source.updated_at, ...(source.location_updated_at === null ? [] : [source.location_updated_at])].sort().at(-1)!
    const past = due <= changedAt && (existing === undefined || existing.due_at !== due)
    values = { due_at: due, status: past ? 'skipped' : 'pending', reason: past ? `This event was already in the past when the schedule or ${source.kind} changed.` : null, error_code: null, error_field: null }
  } catch (error) {
    if (!(error instanceof HTTPError) || !error.data || typeof error.data !== 'object'
      || !('code' in error.data) || typeof error.data.code !== 'string' || !('field' in error.data) || typeof error.data.field !== 'string') throw error
    values = { due_at: null, status: 'failed', reason: error.message, error_code: error.data.code, error_field: error.data.field }
  }
  // An unchanged plan is not rewritten.
  if (existing && existing.template_version === template.version && existing.template_title === template.title && existing.body === template.body
    && existing.request_id === source.request_id && existing.product_id === source.product_id && existing.timezone === source.timezone
    && (Object.keys(values) as (keyof Plan)[]).every(key => existing[key] === values[key])) return
  await savePlan(db, template, source, existing, values, now)
}

async function savePlan(db: DbClient, template: MessageTemplateRow, source: BookedRecord, existing: ScheduledGuestMessageRow | undefined, values: Plan, now: string): Promise<void> {
  // Both observed sources are part of the write. A stale planner can neither
  // overwrite a newer snapshot nor insert one after a concurrent edit.
  const guard = bookedRecordGuard(source)
  const scope = `EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?) AND ${guard.query}`
  const guards = [template.id, template.organization_id, template.version, ...guard.params]
  // A plan that fails is someone's work: its task is written with it.
  const id = existing?.id ?? crypto.randomUUID()
  await executeBatch(db, [existing ? {
    query: `UPDATE scheduled_guest_messages SET request_id = ?, product_id = ?, template_title = ?, template_version = ?, body = ?, due_at = ?, timezone = ?, status = ?, reason = ?, error_code = ?, error_field = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND updated_at = ? AND ${scope}`,
    params: [source.request_id, source.product_id, template.title, template.version, template.body, values.due_at, source.timezone, values.status, values.reason, values.error_code, values.error_field, now, existing.id, existing.updated_at, ...guards],
  } : {
    query: `INSERT INTO scheduled_guest_messages (id, organization_id, product_id, subject_type, subject_id, request_id, template_id, template_title, template_version,
      body, due_at, timezone, status, reason, error_code, error_field, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${scope}
      ON CONFLICT(template_id, subject_type, subject_id) DO NOTHING`,
    params: [id, source.organization_id, source.product_id, source.kind, source.id, source.request_id, template.id, template.title, template.version,
      template.body, values.due_at, source.timezone, values.status, values.reason, values.error_code, values.error_field, now, now, ...guards],
  }, ...messageDeliveryTaskQueries(id, now)], { operation: 'Plan scheduled guest message' })
}

export const CHECK_IN_MESSAGE_TITLE = 'Check-in instructions'
// The reasons the planner itself cancels a check-in message. Only these come
// back when the stay or instructions become eligible again; a manager's
// cancellation stays cancelled.
const CHECK_IN_NOT_CONFIRMED = 'The stay is not confirmed.'
const CHECK_IN_NO_INSTRUCTIONS = 'The home has no check-in instructions.'
const CHECK_IN_NO_CONVERSATION = 'The stay has no guest conversation to send through.'

/** A stay and its home's check-in instructions. */
type CheckInStay = BookedRecord & { check_in_date: string; check_in_instructions: string | null }
const CHECK_IN_STAYS_SQL = `SELECT br.*, c.check_in_instructions FROM ${BOOKED_RECORDS_SQL} br
  JOIN product_stay_configs c ON c.organization_id = br.organization_id AND c.product_id = br.product_id WHERE br.kind = 'stay'`

/**
 * Every confirmed stay is sent its home's check-in instructions at 10:00 the day
 * before arrival in the home's timezone, or at once when it was booked after
 * that. Airbnb guests never see KrabiClaw's instructions otherwise. The body is
 * refreshed from the home until it is sent; a home without instructions, or a
 * stay with no guest conversation, sends nothing.
 */
async function planCheckInMessage(db: DbClient, stay: CheckInStay, now: string): Promise<void> {
  const existing = await queryFirst<ScheduledGuestMessageRow>(db, "SELECT * FROM scheduled_guest_messages WHERE subject_type = 'stay' AND subject_id = ? AND template_id IS NULL AND template_title = ?",
    [stay.id, CHECK_IN_MESSAGE_TITLE])
  const plannerCancelled = existing?.status === 'cancelled' && [CHECK_IN_NOT_CONFIRMED, CHECK_IN_NO_INSTRUCTIONS, CHECK_IN_NO_CONVERSATION].includes(existing.reason ?? '')
  if (existing && existing.status !== 'pending' && !plannerCancelled) return
  const instructions = stay.check_in_instructions?.trim() ? stay.check_in_instructions : null
  const guard = bookedRecordGuard(stay)
  const scope = `${guard.query} AND EXISTS (SELECT 1 FROM product_stay_configs c WHERE c.organization_id = ? AND c.product_id = ? AND c.check_in_instructions IS ?)`
  const guards = [...guard.params, stay.organization_id, stay.product_id, stay.check_in_instructions]
  const arrived = stay.check_in_time === null ? stay.check_in_date < localDateAt(new Date(now), stay.timezone) : localDateTimeToInstant(stay.check_in_date, stay.check_in_time, stay.timezone, 'earlier').toISOString() <= now
  if (stay.status !== 'confirmed' || instructions === null || stay.request_id === null || arrived) {
    if (existing?.status === 'pending') await execute(db, `UPDATE scheduled_guest_messages SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND updated_at = ?`,
      [arrived && stay.status === 'confirmed' && instructions !== null && stay.request_id !== null ? 'skipped' : 'cancelled',
        stay.status !== 'confirmed' ? CHECK_IN_NOT_CONFIRMED : instructions === null ? CHECK_IN_NO_INSTRUCTIONS
          : stay.request_id === null ? CHECK_IN_NO_CONVERSATION : 'Check-in had already passed.',
        now, existing.id, existing.updated_at])
    return
  }
  const planned = guestMessageDueAt({ trigger: 'check_in', offsetDays: -1, localTime: '10:00', productIds: [] }, anchors(stay), stay.timezone)
  const due = planned > now ? planned : existing?.status === 'pending' && existing.due_at && existing.due_at <= now ? existing.due_at : now
  if (existing?.status === 'pending' && existing.body === instructions && existing.due_at === due
    && existing.timezone === stay.timezone && existing.request_id === stay.request_id) return
  if (existing) {
    await execute(db, `UPDATE scheduled_guest_messages SET request_id = ?, body = ?, due_at = ?, timezone = ?, status = 'pending', reason = NULL, updated_at = ?
      WHERE id = ? AND status = ? AND updated_at = ? AND ${scope}`,
    [stay.request_id, instructions, due, stay.timezone, now, existing.id, existing.status, existing.updated_at, ...guards])
  } else {
    await execute(db, `INSERT INTO scheduled_guest_messages (id, organization_id, product_id, subject_type, subject_id, request_id, template_id, template_title, template_version,
      body, due_at, timezone, status, created_at, updated_at)
      SELECT ?, ?, ?, 'stay', ?, ?, NULL, ?, 1, ?, ?, ?, 'pending', ?, ? WHERE ${scope}
      ON CONFLICT(subject_type, subject_id) WHERE template_id IS NULL AND template_title = 'Check-in instructions' DO NOTHING`,
    [crypto.randomUUID(), stay.organization_id, stay.product_id, stay.id, stay.request_id, CHECK_IN_MESSAGE_TITLE,
      instructions, due, stay.timezone, now, now, ...guards])
  }
}

/**
 * Plan every automatic message for one booked record, after anything about it
 * changed: created, confirmed, cancelled, moved, or linked to its conversation.
 * A stay is also planned its home's check-in instructions.
 */
export async function planSourceMessages(db: DbClient, organizationId: string, source: { kind: BookedKind; id: string }, now = new Date().toISOString()): Promise<void> {
  const row = await readBookedRecord(db, organizationId, source)
  if (!row) messagingError(500, 'INVALID_MESSAGE_SOURCE', `The ${source.kind} or its offering, place or timezone is missing; its messages could not be planned`, 'source')
  if (row.kind === 'stay') {
    const stay = await queryFirst<CheckInStay>(db, `${CHECK_IN_STAYS_SQL} AND br.organization_id = ? AND br.id = ?`, [organizationId, row.id])
    if (!stay) messagingError(500, 'INVALID_MESSAGE_SOURCE', 'The stay’s home is missing; its messages could not be planned', 'source')
    await planCheckInMessage(db, stay, now)
  }
  const templates = await queryAllPages<MessageTemplateRow>(db, 'SELECT * FROM message_templates WHERE organization_id = ? ORDER BY id', [organizationId])
  for (const template of templates) await plan(db, template, row, now)
}

/** Every record the template names that can still be due (ended at most nine days ago), and every one it has pending. */
export async function planTemplateMessages(db: DbClient, template: MessageTemplateRow, now = new Date().toISOString()): Promise<void> {
  const schedule = templateSchedule(template)
  const rows = await queryAllPages<BookedRecord>(db, `SELECT br.* FROM ${BOOKED_RECORDS_SQL} br WHERE br.organization_id = ?
    AND ((br.offering_id IN (SELECT value FROM json_each(?)) AND COALESCE(br.check_out_date, br.ends_at) >= strftime('%Y-%m-%d', ?, '-10 days'))
      OR EXISTS (SELECT 1 FROM scheduled_guest_messages m WHERE m.template_id = ? AND m.status = 'pending' AND m.subject_type = br.kind AND m.subject_id = br.id))
    ORDER BY br.kind, br.id`,
  [template.organization_id, JSON.stringify(schedule?.productIds ?? []), now, template.id])
  for (const row of rows) await plan(db, template, row, now)
}

export async function planHomeMessages(db: DbClient, organizationId: string, locationId: string, now = new Date().toISOString()): Promise<void> {
  const rows = await queryAllPages<{ id: string }>(db, `SELECT br.id FROM ${BOOKED_RECORDS_SQL} br
    WHERE br.organization_id = ? AND br.kind = 'stay' AND br.location_id = ? AND br.status <> 'cancelled' ORDER BY br.id`, [organizationId, locationId])
  for (const row of rows) await planSourceMessages(db, organizationId, { kind: 'stay', id: row.id }, now)
}

/**
 * Cron recovery reads the same persisted source versions as foreground writes.
 * One template's failure does not stop the others; every failure is returned
 * for the run to report.
 */
async function reconcileScheduledGuestMessagePlans(db: DbClient, now: string): Promise<Error[]> {
  const templates = await queryAllPages<MessageTemplateRow>(db, 'SELECT * FROM message_templates WHERE schedule_json IS NOT NULL ORDER BY id', [])
  const failures: Error[] = []
  // Check-in messages for stays not yet arrived; an edited home's instructions reach them here.
  const arriving = await queryAllPages<CheckInStay>(db, `${CHECK_IN_STAYS_SQL} AND br.status = 'confirmed' AND br.check_in_date >= date(?, '-1 day') ORDER BY br.id`, [now])
  for (const stay of arriving) {
    try {
      await planCheckInMessage(db, stay, now)
    } catch (error) {
      failures.push(new Error(`Planning the check-in message for stay ${stay.id} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
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
function sendFailure(outcome: Exclude<OperationOutcome, { ok: true }>): SendFailure {
  switch (outcome.reason) {
    case 'thread_not_found': return { status: 'failed', reason: 'The guest conversation no longer exists.', error_code: 'THREAD_NOT_FOUND', error_field: 'requestId' }
    case 'source_not_found': return { status: 'failed', reason: 'The conversation’s booking no longer exists.', error_code: 'SOURCE_NOT_FOUND', error_field: 'source' }
    case 'guest_unreachable': return { status: 'failed', reason: outcome.message, error_code: outcome.code, error_field: outcome.field }
    case 'empty_body': return { status: 'failed', reason: 'The scheduled message has no text.', error_code: 'EMPTY_MESSAGE', error_field: 'body' }
    case 'missing_idempotency_key': return { status: 'failed', reason: 'The scheduled send had no idempotency key.', error_code: 'MISSING_IDEMPOTENCY_KEY', error_field: 'idempotencyKey' }
    case 'invalid_photo': return { status: 'failed', reason: outcome.message, error_code: 'INVALID_PHOTO', error_field: 'photos' }
    case 'invalid_transition': return { status: 'needs_review', reason: outcome.message, error_code: 'IDEMPOTENCY_CONFLICT', error_field: 'idempotencyKey' }
    case 'delivery_failed': return { status: 'failed', reason: outcome.message, error_code: outcome.code, error_field: outcome.field }
  }
}

async function finishSend(db: DbClient, env: SendEnv, row: ScheduledGuestMessageRow, values: { status: 'sent' | 'failed' | 'needs_review'; reason: string | null; error_code: string | null; error_field: string | null; entry_id: string | null; sent_at: string | null }): Promise<void> {
  const now = new Date().toISOString()
  const [result] = await executeBatch(db, [{
    query: `UPDATE scheduled_guest_messages SET status = ?, reason = ?, error_code = ?, error_field = ?, entry_id = ?, sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`,
    params: [values.status, values.reason, values.error_code, values.error_field, values.entry_id, values.sent_at, now, row.id],
  }, ...messageDeliveryTaskQueries(row.id, now)], { operation: 'Record scheduled message outcome' })
  if (result?.meta.changes !== 1) messagingError(409, 'SCHEDULED_MESSAGE_NOT_SENDING', 'The scheduled message outcome could not be recorded because it is no longer sending', 'status')
  await publishScheduledGuestMessageChange(db, env, { ...row, updated_at: now }, values.entry_id === null ? 'thread.changed' : 'entry.appended')
}

/**
 * Send one due message. Its plan is refreshed first so a stay or template
 * change since planning wins; a claimed row records its outcome. An error with
 * no typed facts leaves the row visibly sending and fails the run: whether the
 * provider accepted it is unknown, so it is never resent automatically.
 */
async function sendScheduledGuestMessage(db: DbClient, env: SendEnv, row: Pick<ScheduledGuestMessageRow, 'id' | 'organization_id' | 'subject_type' | 'subject_id'>, now: string): Promise<'sent' | 'failed' | 'needs_review' | 'not_due'> {
  await planSourceMessages(db, row.organization_id, messageSubject(row), now)
  const current = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE id = ?', [row.id])
  if (!current || current.status !== 'pending' || current.due_at === null || current.due_at > now) return 'not_due'
  const claim = await execute(db, `UPDATE scheduled_guest_messages SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND updated_at = ?`,
    [now, now, current.id, current.updated_at])
  if (claim.meta.changes !== 1) return 'not_due'
  if (current.request_id === null) {
    await finishSend(db, env, current, { status: 'failed', reason: 'There is no guest conversation to send through.', error_code: 'CONVERSATION_REQUIRED', error_field: 'requestId', entry_id: null, sent_at: null })
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
    await finishSend(db, env, current, { status: 'failed', reason: (error as Error).message, error_code: data.code, error_field: data.field, entry_id: null, sent_at: null })
    return 'failed'
  }
  if (sent.outcome.ok) {
    if (sent.entryId === null) messagingError(500, 'SCHEDULED_MESSAGE_ENTRY_REQUIRED', 'The scheduled message was sent but its conversation entry could not be read', 'entryId')
    await finishSend(db, env, current, { status: 'sent', reason: null, error_code: null, error_field: null, entry_id: sent.entryId, sent_at: new Date().toISOString() })
    return 'sent'
  }
  const failure = sendFailure(sent.outcome)
  await finishSend(db, env, current, { ...failure, entry_id: sent.entryId, sent_at: null })
  return failure.status
}

/** The production cron: recover plans from persisted sources, then send what is due. */
export async function sendDueScheduledGuestMessages(db: DbClient, env: SendEnv, now = new Date().toISOString()): Promise<{ sent: number; failed: number; needs_review: number }> {
  const failures = await reconcileScheduledGuestMessagePlans(db, now)
  const due = await queryAllPages<Pick<ScheduledGuestMessageRow, 'id' | 'organization_id' | 'subject_type' | 'subject_id'>>(db,
    "SELECT id, organization_id, subject_type, subject_id FROM scheduled_guest_messages WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id", [now])
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
