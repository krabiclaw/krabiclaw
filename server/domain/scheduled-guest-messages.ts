import { HTTPError } from 'nitro'
import { execute, executeBatch, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { messageDeliveryTaskQueries } from './tasks'
import { isValidInstant } from '~/utils/timezone'
import { guestMessageDueAt, messageText, messagingError, type ScheduleAnchor } from './guest-message-schedule'
import { scheduledGuestMessage, SCHEDULED_MESSAGE_VIEW_SQL, templateSchedule, type MessageTemplateRow, type ScheduledGuestMessageRow } from './guest-messaging'
import { guestReplyDestination, operationDedupeKey, sendScheduledGuestReply, type OperationOutcome } from './guest-threads/operations'
import { assertConversationAccess, findMessageByDedupeKey } from './conversations'
import { publishConversationEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { ChannexError } from '~/server/integrations/channex/client'
import { BOOKING_RECORDS_SQL, bookedRecordGuard, bookedRecordWindow, getGuestRequest, readBookedRecord, stayRequestConfirmationKey, type BookedRecord } from './requests'
import { memberAccessPrincipal, resolveMembership, type MemberAccessPrincipal } from '~/server/utils/member-access'
import type { CloudflareEnv } from '~/server/utils/auth'

type Plan = Pick<ScheduledGuestMessageRow, 'due_at' | 'status' | 'reason' | 'error_code' | 'error_field'>

/** The day and instant a schedule counts from at the record's start and end. */
function anchors(record: BookedRecord): { check_in: ScheduleAnchor; check_out: ScheduleAnchor } {
  const window = bookedRecordWindow(record)
  return { check_in: window.start, check_out: window.end }
}

/** A scheduled message belongs to its conversation: a send-later reply's own, or its booking's; every booking has one. */
export async function publishScheduledGuestMessageChange(
  db: DbClient,
  env: GuestInboxPublicationEnv,
  conversationId: string | null,
  type: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE' = 'MESSAGE_UPDATE',
): Promise<void> {
  if (conversationId === null) messagingError(500, 'INVALID_MESSAGE_BOOKING', 'The scheduled message has no conversation; open apps could not be updated', 'conversationId')
  await publishConversationEvent(env, db, { conversationId, type })
}

function validTimestamp(value: string, field: string): void {
  if (!isValidInstant(value) || new Date(value).toISOString() !== value) messagingError(500, 'INVALID_MESSAGING_DATA', `The stored ${field} timestamp is invalid`, field)
}

/** Only pending plans change. A completed or attempted send can never be recreated. */
async function plan(db: DbClient, template: MessageTemplateRow, source: BookedRecord, now: string): Promise<void> {
  // A review-mode lodging request becomes a reservation when its payment confirms it.
  if (source.status === 'pending' && source.respond_by !== null) return
  const existing = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE template_id = ? AND booking_id = ?', [template.id, source.id])
  if (existing && existing.status !== 'pending') return
  const schedule = templateSchedule(template)
  const covered = schedule !== null && schedule.product_ids.includes(source.offering_id)
  const guard = bookedRecordGuard(source)
  if (!covered || source.status === 'cancelled') {
    if (existing) await execute(db, `UPDATE scheduled_guest_messages SET status = 'cancelled', reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND updated_at = ?
        AND EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?) AND ${guard.query}`,
    [source.status === 'cancelled' ? `The ${bookingNoun(source)} was cancelled.` : 'The automatic message no longer includes this offering.', now, existing.id, existing.updated_at,
      template.id, template.organization_id, template.version, ...guard.params])
    return
  }
  let values: Plan
  try {
    let due: string
    if (schedule.trigger === 'booking_received') {
      const receivedAt = source.respond_by === null ? source.received_at : await queryFirst<{ occurred_at: string }>(db,
        'SELECT occurred_at FROM activity_entries WHERE organization_id = ? AND dedupe_key = ?',
        [source.organization_id, stayRequestConfirmationKey(source.id)]).then(confirmation => {
          if (!confirmation) messagingError(500, 'INVALID_MESSAGE_SOURCE', 'The confirmed stay has no confirmation event.', 'source')
          return confirmation.occurred_at
        })
      if (receivedAt === null) {
        values = { due_at: null, status: 'skipped', reason: 'This stay was imported or was already known before new-reservation scheduling. No new-reservation message will be sent.', error_code: null, error_field: null }
        await savePlan(db, template, source, existing, values, now)
        return
      }
      validTimestamp(receivedAt, 'receivedAt')
      if (template.schedule_enabled_at === null) messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The schedule has no activation timestamp', 'scheduleEnabledAt')
      if (receivedAt <= template.schedule_enabled_at) {
        values = { due_at: null, status: 'skipped', reason: `The ${bookingNoun(source)} was received before this schedule was activated. No new-${bookingNoun(source)} message will be sent.`, error_code: null, error_field: null }
        await savePlan(db, template, source, existing, values, now)
        return
      }
      due = new Date(Date.parse(receivedAt) + schedule.delay_minutes * 60000).toISOString()
    } else due = guestMessageDueAt(schedule, anchors(source), source.timezone)
    validTimestamp(template.updated_at, 'template.updated_at')
    validTimestamp(source.updated_at, 'source.updatedAt')
    const changedAt = [template.updated_at, source.updated_at].sort().at(-1)!
    const past = due <= changedAt && (existing === undefined || existing.due_at !== due)
    values = { due_at: due, status: past ? 'skipped' : 'pending', reason: past ? `This event was already in the past when the schedule or ${bookingNoun(source)} changed.` : null, error_code: null, error_field: null }
  } catch (error) {
    if (!(error instanceof HTTPError) || !error.data || typeof error.data !== 'object'
      || !('code' in error.data) || typeof error.data.code !== 'string' || !('field' in error.data) || typeof error.data.field !== 'string') throw error
    values = { due_at: null, status: 'failed', reason: error.message, error_code: error.data.code, error_field: error.data.field }
  }
  // An unchanged plan is not rewritten.
  if (existing && existing.template_version === template.version && existing.template_title === template.title && existing.body === template.body && existing.product_id === source.product_id && existing.timezone === source.timezone
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
    query: `UPDATE scheduled_guest_messages SET product_id = ?, template_title = ?, template_version = ?, body = ?, due_at = ?, timezone = ?, status = ?, reason = ?, error_code = ?, error_field = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND updated_at = ? AND ${scope}`,
    params: [source.product_id, template.title, template.version, template.body, values.due_at, source.timezone, values.status, values.reason, values.error_code, values.error_field, now, existing.id, existing.updated_at, ...guards],
  } : {
    query: `INSERT INTO scheduled_guest_messages (id, organization_id, product_id, booking_id, template_id, template_title, template_version,
      body, due_at, timezone, status, reason, error_code, error_field, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${scope}
      ON CONFLICT(template_id, booking_id) DO NOTHING`,
    params: [id, source.organization_id, source.product_id, source.id, template.id, template.title, template.version,
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

/** What a booking is called in a planner's reasons. */
function bookingNoun(record: Pick<BookedRecord, 'unit'>): string {
  return record.unit === 'nights' ? 'stay' : 'booking'
}

/** A nights booking and its home's check-in instructions. */
type CheckInStay = BookedRecord & { check_in_instructions: string | null }
const CHECK_IN_STAYS_SQL = `SELECT br.*, c.check_in_instructions FROM ${BOOKING_RECORDS_SQL} br
  JOIN product_stay_configs c ON c.organization_id = br.organization_id AND c.product_id = br.product_id WHERE br.unit = 'nights'`

/**
 * Every confirmed stay is sent its home's check-in instructions at 10:00 the day
 * before arrival in the home's timezone, or at once when it was booked after
 * that. Airbnb guests never see KrabiClaw's instructions otherwise. The body is
 * refreshed from the home until it is sent; a home without instructions, or a
 * stay with no guest conversation, sends nothing.
 */
async function planCheckInMessage(db: DbClient, stay: CheckInStay, now: string): Promise<void> {
  const existing = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE booking_id = ? AND template_id IS NULL AND template_title = ?',
    [stay.id, CHECK_IN_MESSAGE_TITLE])
  const plannerCancelled = existing?.status === 'cancelled' && [CHECK_IN_NOT_CONFIRMED, CHECK_IN_NO_INSTRUCTIONS, CHECK_IN_NO_CONVERSATION].includes(existing.reason ?? '')
  if (existing && existing.status !== 'pending' && !plannerCancelled) return
  const instructions = stay.check_in_instructions?.trim() ? stay.check_in_instructions : null
  const guard = bookedRecordGuard(stay)
  const scope = `${guard.query} AND EXISTS (SELECT 1 FROM product_stay_configs c WHERE c.organization_id = ? AND c.product_id = ? AND c.check_in_instructions IS ?)`
  const guards = [...guard.params, stay.organization_id, stay.product_id, stay.check_in_instructions]
  const arrival = bookedRecordWindow(stay).start
  const arrived = arrival.instant === null ? arrival.date < new Intl.DateTimeFormat('en-CA', { timeZone: stay.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)) : arrival.instant <= now
  if (stay.status !== 'confirmed' || instructions === null || stay.conversation_id === null || arrived) {
    if (existing?.status === 'pending') await execute(db, `UPDATE scheduled_guest_messages SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND updated_at = ?`,
      [arrived && stay.status === 'confirmed' && instructions !== null && stay.conversation_id !== null ? 'skipped' : 'cancelled',
        stay.status !== 'confirmed' ? CHECK_IN_NOT_CONFIRMED : instructions === null ? CHECK_IN_NO_INSTRUCTIONS
          : stay.conversation_id === null ? CHECK_IN_NO_CONVERSATION : 'Check-in had already passed.',
        now, existing.id, existing.updated_at])
    return
  }
  const planned = guestMessageDueAt({ trigger: 'check_in', offset_days: -1, local_time: '10:00', product_ids: [] }, anchors(stay), stay.timezone)
  const due = planned > now ? planned : existing?.status === 'pending' && existing.due_at && existing.due_at <= now ? existing.due_at : now
  if (existing?.status === 'pending' && existing.body === instructions && existing.due_at === due
    && existing.timezone === stay.timezone) return
  if (existing) {
    await execute(db, `UPDATE scheduled_guest_messages SET body = ?, due_at = ?, timezone = ?, status = 'pending', reason = NULL, updated_at = ?
      WHERE id = ? AND status = ? AND updated_at = ? AND ${scope}`,
    [instructions, due, stay.timezone, now, existing.id, existing.status, existing.updated_at, ...guards])
  } else {
    await execute(db, `INSERT INTO scheduled_guest_messages (id, organization_id, product_id, booking_id, template_id, template_title, template_version,
      body, due_at, timezone, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, 'pending', ?, ? WHERE ${scope}
      ON CONFLICT(booking_id) WHERE template_id IS NULL AND template_title = 'Check-in instructions' DO NOTHING`,
    [crypto.randomUUID(), stay.organization_id, stay.product_id, stay.id, CHECK_IN_MESSAGE_TITLE,
      instructions, due, stay.timezone, now, now, ...guards])
  }
}

/**
 * Plan every automatic message for one booking, after anything about it
 * changed: created, confirmed, cancelled, moved, or linked to its conversation.
 * A stay is also planned its home's check-in instructions.
 */
export async function planSourceMessages(db: DbClient, organizationId: string, bookingId: string, now = new Date().toISOString()): Promise<void> {
  const row = await readBookedRecord(db, organizationId, bookingId)
  if (!row) messagingError(500, 'INVALID_MESSAGE_SOURCE', 'The booking or its offering is missing; its messages could not be planned', 'source')
  if (row.unit === 'nights') {
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
  const rows = await queryAllPages<BookedRecord>(db, `SELECT br.* FROM ${BOOKING_RECORDS_SQL} br WHERE br.organization_id = ?
    AND ((br.offering_id IN (SELECT value FROM json_each(?)) AND br.ends_at >= strftime('%Y-%m-%d', ?, '-10 days'))
      OR EXISTS (SELECT 1 FROM scheduled_guest_messages m WHERE m.template_id = ? AND m.status = 'pending' AND m.booking_id = br.id))
    ORDER BY br.id`,
  [template.organization_id, JSON.stringify(schedule?.product_ids ?? []), now, template.id])
  for (const row of rows) await plan(db, template, row, now)
}

export async function planHomeMessages(db: DbClient, organizationId: string, locationId: string, now = new Date().toISOString()): Promise<void> {
  const rows = await queryAllPages<{ id: string }>(db, `SELECT br.id FROM ${BOOKING_RECORDS_SQL} br
    WHERE br.organization_id = ? AND br.unit = 'nights' AND br.location_id = ? AND br.status <> 'cancelled' ORDER BY br.id`, [organizationId, locationId])
  for (const row of rows) await planSourceMessages(db, organizationId, row.id, now)
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
  const arriving = await queryAllPages<CheckInStay>(db, `${CHECK_IN_STAYS_SQL} AND br.status = 'confirmed' AND br.starts_at >= date(?, '-2 day') ORDER BY br.id`, [now])
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

/** A send time is a future instant, at most a year ahead. */
function validateDueAt(value: unknown, now: string): string {
  if (typeof value !== 'string' || !isValidInstant(value)) messagingError(422, 'INVALID_MESSAGING_FIELD', 'due_at must be an ISO 8601 instant', 'due_at')
  const instant = new Date(value).toISOString()
  if (instant <= now) messagingError(422, 'SEND_LATER_IN_PAST', 'Choose a time in the future', 'due_at')
  if (Date.parse(instant) - Date.parse(now) > 366 * 86_400_000) messagingError(422, 'SEND_LATER_TOO_FAR', 'Choose a time within the next year', 'due_at')
  return instant
}

/**
 * A member's own reply, put in the outbox to go out at due_at as their reply.
 * Nothing is scheduled to a guest the reply could not reach.
 */
export async function scheduleGuestReply(db: DbClient, principal: MemberAccessPrincipal, conversation_id: string, value: { body: unknown; due_at: unknown }, now = new Date().toISOString()) {
  const body = messageText(value.body, 'body', 5000)
  const due = validateDueAt(value.due_at, now)
  const thread = await getGuestRequest(db, conversation_id, principal.organizationId)
  if (!thread) messagingError(404, 'THREAD_NOT_FOUND', 'Thread not found', 'conversation_id')
  await assertConversationAccess(db, principal, thread.id)
  const destination = await guestReplyDestination(db, thread)
  if (destination.channel === null) messagingError(409, 'GUEST_UNREACHABLE', destination.reason, 'conversation_id')
  const id = crypto.randomUUID()
  await execute(db, `INSERT INTO scheduled_guest_messages (id, organization_id, conversation_id, author_user_id, body, due_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [id, principal.organizationId, thread.id, principal.userId, body, due, now, now])
  const saved = await queryFirst<ScheduledGuestMessageRow>(db, `${SCHEDULED_MESSAGE_VIEW_SQL} WHERE m.organization_id = ? AND m.id = ?`, [principal.organizationId, id])
  if (!saved) messagingError(500, 'SCHEDULED_MESSAGE_NOT_SAVED', 'The scheduled reply could not be read back', 'scheduled_message_id')
  try {
    await publishScheduledGuestMessageChange(db, principal.env, saved.conversation_id)
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'Your reply was scheduled, but open apps could not be updated. Reload before scheduling it again.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, scheduled_message_id: saved.id }, cause })
  }
  return scheduledGuestMessage(saved)
}

type SendEnv = CloudflareEnv & Parameters<typeof sendScheduledGuestReply>[1]['env'] & GuestInboxPublicationEnv
type SendFailure = { status: 'failed' | 'needs_review'; reason: string; error_code: string; error_field: string }

/** Every non-sent reply outcome carries its own typed facts; none is generalized here. */
function sendFailure(outcome: Exclude<OperationOutcome, { ok: true }>): SendFailure {
  switch (outcome.reason) {
    case 'thread_not_found': return { status: 'failed', reason: 'The guest conversation no longer exists.', error_code: 'THREAD_NOT_FOUND', error_field: 'conversation_id' }
    case 'source_not_found': return { status: 'failed', reason: 'The conversation’s booking no longer exists.', error_code: 'SOURCE_NOT_FOUND', error_field: 'source' }
    case 'guest_unreachable': return { status: 'failed', reason: outcome.message, error_code: outcome.code, error_field: outcome.field }
    case 'empty_body': return { status: 'failed', reason: 'The scheduled message has no text.', error_code: 'EMPTY_MESSAGE', error_field: 'body' }
    case 'missing_idempotency_key': return { status: 'failed', reason: 'The scheduled send had no idempotency key.', error_code: 'MISSING_IDEMPOTENCY_KEY', error_field: 'idempotencyKey' }
    case 'invalid_photo': return { status: 'failed', reason: outcome.message, error_code: 'INVALID_PHOTO', error_field: 'photos' }
    case 'invalid_transition': return { status: 'needs_review', reason: outcome.message, error_code: 'IDEMPOTENCY_CONFLICT', error_field: 'idempotencyKey' }
    case 'delivery_failed': return { status: 'failed', reason: outcome.message, error_code: outcome.code, error_field: outcome.field }
  }
}

async function finishSend(db: DbClient, env: SendEnv, row: ScheduledGuestMessageRow, values: { status: 'sent' | 'failed' | 'needs_review'; reason: string | null; error_code: string | null; error_field: string | null; message_id: string | null; sent_at: string | null }): Promise<void> {
  const now = new Date().toISOString()
  const [result] = await executeBatch(db, [{
    query: `UPDATE scheduled_guest_messages SET status = ?, reason = ?, error_code = ?, error_field = ?, message_id = ?, sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`,
    params: [values.status, values.reason, values.error_code, values.error_field, values.message_id, values.sent_at, now, row.id],
  }, ...messageDeliveryTaskQueries(row.id, now)], { operation: 'Record scheduled message outcome' })
  if (result?.meta.changes !== 1) messagingError(409, 'SCHEDULED_MESSAGE_NOT_SENDING', 'The scheduled message outcome could not be recorded because it is no longer sending', 'status')
  if (row.conversation_id !== null) await publishScheduledGuestMessageChange(db, env, row.conversation_id, values.message_id === null ? 'MESSAGE_UPDATE' : 'MESSAGE_CREATE')
}

/** The idempotency key a row is sent under: a reply's is its author's own, which Inbox Retry reuses. */
function sendKey(row: Pick<ScheduledGuestMessageRow, 'id' | 'author_user_id'>): string {
  return row.author_user_id === null ? `scheduled-guest-message:${row.id}` : `send-later:${row.id}`
}

/**
 * Send one due message. An automatic message's plan is refreshed first so a
 * booking or template change since planning wins; a send-later reply is sent
 * as its author's own reply only while they can still reach the conversation.
 * A claimed row records its outcome. A send that threw did not finish: it
 * fails with its cause and its entry, and is never resent automatically,
 * because whether the provider accepted it is unknown.
 */
async function sendScheduledGuestMessage(db: DbClient, env: SendEnv, row: Pick<ScheduledGuestMessageRow, 'id' | 'organization_id' | 'booking_id' | 'author_user_id'>, now: string): Promise<'sent' | 'failed' | 'needs_review' | 'not_due'> {
  if (row.author_user_id === null) {
    if (row.booking_id === null) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The automatic message has no booking', 'bookingId')
    await planSourceMessages(db, row.organization_id, row.booking_id, now)
  }
  const current = await queryFirst<ScheduledGuestMessageRow>(db, `${SCHEDULED_MESSAGE_VIEW_SQL} WHERE m.organization_id = ? AND m.id = ?`, [row.organization_id, row.id])
  if (!current || current.status !== 'pending' || current.due_at === null || current.due_at > now) return 'not_due'
  const claim = await execute(db, `UPDATE scheduled_guest_messages SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND updated_at = ?`,
    [now, now, current.id, current.updated_at])
  if (claim.meta.changes !== 1) return 'not_due'
  const sending = { ...current, status: 'sending' as const, started_at: now, updated_at: now }
  const conversationId = sending.conversation_id
  if (conversationId === null) {
    await finishSend(db, env, sending, { status: 'failed', reason: 'There is no guest conversation to send through.', error_code: 'CONVERSATION_REQUIRED', error_field: 'conversation_id', message_id: null, sent_at: null })
    return 'failed'
  }
  if (sending.author_user_id !== null) {
    try {
      const membership = await resolveMembership(env, { organizationId: sending.organization_id, userId: sending.author_user_id })
      if (!membership) messagingError(403, 'SEND_LATER_AUTHOR_NOT_MEMBER', 'Its author is no longer a member of this workspace', 'authorUserId')
      await assertConversationAccess(db, memberAccessPrincipal(membership, { env }), conversationId)
    } catch (error) {
      if (!(error instanceof HTTPError)) {
        // Nothing was sent: the message goes back to pending for the next run, and this run fails.
        await execute(db, `UPDATE scheduled_guest_messages SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ? AND status = 'sending'`, [new Date().toISOString(), sending.id])
        throw error
      }
      await finishSend(db, env, sending, { status: 'failed', reason: error.message, error_code: 'SEND_LATER_ACCESS_REVOKED', error_field: 'author_user_id', message_id: null, sent_at: null })
      return 'failed'
    }
  }
  const idempotencyKey = sendKey(sending)
  let sent: Awaited<ReturnType<typeof sendScheduledGuestReply>>
  try {
    sent = await sendScheduledGuestReply(db, { threadId: conversationId, organizationId: sending.organization_id, body: sending.body, idempotencyKey,
      ...(sending.author_user_id === null ? {} : { actorUserId: sending.author_user_id }), env })
  } catch (error) {
    const data = error instanceof HTTPError || error instanceof ChannexError ? error.data : null
    const typed = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' && 'field' in data && typeof data.field === 'string' ? { code: data.code, field: data.field } : null
    const entry = await findMessageByDedupeKey(db, operationDedupeKey({ threadId: conversationId, idempotencyKey }))
    // A send may already have committed before its publication failed. Keep
    // the sent outcome; the thrown error still fails the run for the caller.
    const latest = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE id = ?', [sending.id])
    if (latest?.status === 'sent' && latest.message_id === entry?.id) throw error
    await finishSend(db, env, sending, { status: 'failed', reason: error instanceof Error ? error.message : String(error), error_code: typed?.code ?? 'SCHEDULED_MESSAGE_DELIVERY_FAILED', error_field: typed?.field ?? 'delivery', message_id: entry?.id ?? null, sent_at: null })
    if (!typed) throw error
    return 'failed'
  }
  if (sent.outcome.ok) {
    if (sent.messageId === null) messagingError(500, 'SCHEDULED_MESSAGE_ENTRY_REQUIRED', 'The scheduled message was sent but its conversation message could not be read', 'messageId')
    // A member's reply operation records its own sent outcome, as it does for Inbox Retry.
    if (sending.author_user_id === null) await finishSend(db, env, sending, { status: 'sent', reason: null, error_code: null, error_field: null, message_id: sent.messageId, sent_at: new Date().toISOString() })
    return 'sent'
  }
  const failure = sendFailure(sent.outcome)
  await finishSend(db, env, sending, { ...failure, message_id: sent.messageId, sent_at: null })
  return failure.status
}

/** The production cron: recover automatic plans from persisted sources, then send everything due, each on its own. */
export async function sendDueScheduledGuestMessages(db: DbClient, env: SendEnv, now = new Date().toISOString()): Promise<{ sent: number; failed: number; needs_review: number }> {
  const failures = await reconcileScheduledGuestMessagePlans(db, now)
  const due = await queryAllPages<Pick<ScheduledGuestMessageRow, 'id' | 'organization_id' | 'booking_id' | 'author_user_id'>>(db,
    "SELECT id, organization_id, booking_id, author_user_id FROM scheduled_guest_messages WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id", [now])
  const counts = { sent: 0, failed: 0, needs_review: 0 }
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
