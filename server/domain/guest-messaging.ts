import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { assertAssignedBookingAccess, assignedResponsibilitySql, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { getGuestRequest } from '~/server/domain/requests'
import { getStay, readStayHome, stayAccessFor, type StayAccess } from '~/server/domain/stays'
import { isValidInstant } from '~/utils/timezone'
import { messageListPage, messageText, messagingError, parseGuestMessageSchedule, type GuestMessageSchedule, type MessageListQuery } from './guest-message-schedule'
import { CHECK_IN_MESSAGE_TITLE, planTemplateMessages } from './scheduled-guest-messages'

export interface MessageTemplateRow {
  id: string
  organization_id: string
  title: string
  body: string
  schedule_json: string | null
  schedule_enabled_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface MessageTemplate {
  id: string
  organizationId: string
  title: string
  body: string
  schedule: GuestMessageSchedule
  version: number
  createdAt: string
  updatedAt: string
}

function manager(access: StayAccess): void {
  if (!access.manage) messagingError(403, 'MESSAGING_ROLE_REQUIRED', 'Only workspace managers can change automatic messages', 'permissions.operations.update')
}

function expectedTemplateVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    messagingError(422, 'INVALID_MESSAGING_FIELD', 'expectedVersion must be the current positive integer template version', 'expectedVersion')
  }
  return value
}

function timestamp(value: unknown, field: string): asserts value is string {
  if (!isValidInstant(value) || new Date(value).toISOString() !== value) messagingError(500, 'INVALID_MESSAGING_DATA', `The stored ${field} timestamp is invalid`, field)
}

export function templateSchedule(row: MessageTemplateRow): GuestMessageSchedule | null {
  let value: unknown = null
  if (row.schedule_json !== null) {
    try { value = JSON.parse(row.schedule_json) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The automatic message schedule is not valid JSON', 'schedule')
    }
  }
  const schedule = parseGuestMessageSchedule(value, true)
  if ((schedule === null) !== (row.schedule_enabled_at === null)) messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The saved schedule has no matching activation timestamp', 'scheduleEnabledAt')
  if (row.schedule_enabled_at !== null) timestamp(row.schedule_enabled_at, 'scheduleEnabledAt')
  return schedule
}

/** An automatic message always has a schedule; a stored one without is invalid. */
export function messageTemplate(row: MessageTemplateRow): MessageTemplate {
  if (row.schedule_json === null) messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The automatic message has no schedule', 'schedule')
  if (!row.title.trim() || row.title.length > 100 || !row.body.trim() || row.body.length > 5000 || !Number.isSafeInteger(row.version) || row.version < 1) {
    messagingError(500, 'INVALID_MESSAGE_TEMPLATE', 'The automatic message has invalid text or version', 'template')
  }
  timestamp(row.created_at, 'createdAt')
  timestamp(row.updated_at, 'updatedAt')
  return { id: row.id, organizationId: row.organization_id, title: row.title, body: row.body, schedule: templateSchedule(row)!, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function listMessageTemplates(db: DbClient, access: StayAccess, query: MessageListQuery) {
  const rows = await queryAll<MessageTemplateRow>(db, 'SELECT * FROM message_templates WHERE organization_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
    [access.organizationId, query.limit + 1, query.offset])
  const page = messageListPage(rows.map(messageTemplate), query)
  return { templates: page.items, pagination: page.pagination }
}

export async function getMessageTemplate(db: DbClient, organizationId: string, templateId: string): Promise<MessageTemplateRow> {
  const row = await queryFirst<MessageTemplateRow>(db, 'SELECT * FROM message_templates WHERE organization_id = ? AND id = ?', [organizationId, templateId])
  if (!row) messagingError(404, 'MESSAGE_TEMPLATE_NOT_FOUND', 'This automatic message does not exist in the workspace', 'templateId')
  return row
}

/** A full write names the message's text and its schedule; every automatic message has one. */
export async function saveMessageTemplate(db: DbClient, access: StayAccess, templateId: string | null, value: unknown, now = new Date().toISOString()): Promise<MessageTemplate> {
  manager(access)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['title', 'body', 'schedule', 'expectedVersion'].includes(key))) {
    messagingError(422, 'INVALID_MESSAGING_FIELD', 'Provide title, body, schedule and the current expectedVersion when editing an automatic message', 'template')
  }
  const input = value as Record<string, unknown>
  const title = messageText(input.title, 'title', 100), body = messageText(input.body, 'body', 5000)
  if (title.trim() === CHECK_IN_MESSAGE_TITLE) messagingError(422, 'MESSAGE_TITLE_RESERVED', `“${CHECK_IN_MESSAGE_TITLE}” is the built-in message every stay is sent; choose another name`, 'title')
  const schedule = parseGuestMessageSchedule(input.schedule)!
  const current = templateId === null ? null : await getMessageTemplate(db, access.organizationId, templateId)
  if (current === null ? 'expectedVersion' in input : expectedTemplateVersion(input.expectedVersion) !== current.version) {
    messagingError(current === null ? 422 : 409, current === null ? 'INVALID_MESSAGING_FIELD' : 'MESSAGE_TEMPLATE_VERSION_CONFLICT', current === null ? 'A new automatic message has no expectedVersion' : 'This automatic message changed; reload it before editing', 'expectedVersion')
  }
  const homes = await queryAll<{ product_id: string }>(db, 'SELECT product_id FROM product_stay_configs WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))', [access.organizationId, JSON.stringify(schedule.productIds)])
  if (homes.length !== schedule.productIds.length) messagingError(404, 'MESSAGE_HOME_NOT_FOUND', 'Every scheduled home must belong to this workspace', 'schedule.productIds')
  const previous = current === null ? null : templateSchedule(current)
  const sameReceivedScope = schedule.trigger === 'booking_received' && previous?.trigger === 'booking_received'
    && [...schedule.productIds].sort().join('\n') === [...previous.productIds].sort().join('\n')
  const enabledAt = sameReceivedScope && current !== null ? current.schedule_enabled_at : now
  const id = current === null ? crypto.randomUUID() : current.id
  const homeIds = schedule.productIds
  const homesCurrent = '? = (SELECT count(*) FROM product_stay_configs WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?)))'
  const homeGuard = [homeIds.length, access.organizationId, JSON.stringify(homeIds)]
  const write = current === null ? {
    query: `INSERT INTO message_templates (id, organization_id, title, body, schedule_json, schedule_enabled_at, version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${homesCurrent} RETURNING *`,
    params: [id, access.organizationId, title, body, JSON.stringify(schedule), enabledAt, now, now, ...homeGuard],
  } : {
    query: `UPDATE message_templates SET title = ?, body = ?, schedule_json = ?, schedule_enabled_at = ?, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND ${homesCurrent} RETURNING *`,
    params: [title, body, JSON.stringify(schedule), enabledAt, now, access.organizationId, id, current.version, ...homeGuard],
  }
  const results = await executeBatch(db, [write, organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId,
    eventType: current === null ? 'message_template.created' : 'message_template.updated', entityType: 'message_template', entityId: id, onlyIfPreviousChangedOneRow: true })], { operation: 'Save message template' })
  if (results[0]?.meta.changes !== 1) messagingError(409, 'MESSAGE_TEMPLATE_WRITE_CONFLICT', 'This automatic message or one of its homes changed before saving; reload before editing', 'template')
  const saved = results[0]?.results[0] as MessageTemplateRow | undefined
  if (!saved || saved.id !== id || saved.organization_id !== access.organizationId || saved.version !== (current === null ? 1 : current.version + 1)) {
    messagingError(500, 'MESSAGE_TEMPLATE_READBACK_FAILED', 'The automatic message was saved but its value was not returned; reload before saving again', 'template')
  }
  await planTemplateMessages(db, saved, now)
  return messageTemplate(saved)
}

export async function deleteMessageTemplate(db: DbClient, access: StayAccess, templateId: string, expectedVersion: unknown, now = new Date().toISOString()): Promise<void> {
  manager(access)
  const version = expectedTemplateVersion(expectedVersion)
  const current = await getMessageTemplate(db, access.organizationId, templateId)
  if (version !== current.version) messagingError(409, 'MESSAGE_TEMPLATE_VERSION_CONFLICT', 'This automatic message changed; reload it before deleting', 'expectedVersion')
  const results = await executeBatch(db, [{
    query: `UPDATE scheduled_guest_messages SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
      reason = CASE WHEN status = 'pending' THEN 'The automatic message was deleted.' ELSE reason END,
      template_id = NULL, updated_at = ? WHERE organization_id = ? AND template_id = ?
      AND EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?)`,
    params: [now, access.organizationId, templateId, templateId, access.organizationId, current.version],
  }, {
    query: 'DELETE FROM message_templates WHERE organization_id = ? AND id = ? AND version = ?', params: [access.organizationId, templateId, current.version],
  }, organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'message_template.deleted', entityType: 'message_template', entityId: templateId, onlyIfPreviousChangedOneRow: true })], { operation: 'Delete message template' })
  if (results[1]?.meta.changes !== 1) messagingError(409, 'MESSAGE_TEMPLATE_VERSION_CONFLICT', 'This automatic message changed; reload it before deleting', 'expectedVersion')
}

/** No provider ID, location guess, or historical guest contact substitutes for a home. */
export async function guestThreadMessagingContext(db: DbClient, principal: MemberAccessPrincipal, requestId: string) {
  const thread = await getGuestRequest(db, requestId, principal.organizationId)
  if (!thread) messagingError(404, 'THREAD_NOT_FOUND', 'This conversation is not in the workspace', 'requestId')
  await assertAssignedBookingAccess(db, { ...principal, requestId })
  const access = await stayAccessFor(principal)
  const [stay, channel] = await Promise.all([
    queryFirst<{ id: string; product_id: string }>(db, 'SELECT id, product_id FROM stays WHERE organization_id = ? AND request_id = ?', [principal.organizationId, requestId]),
    queryFirst<{ product_id: string }>(db, 'SELECT product_id FROM channel_threads WHERE organization_id = ? AND request_id = ?', [principal.organizationId, requestId]),
  ])
  if (stay && channel && stay.product_id !== channel.product_id) messagingError(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The stay and provider conversation name different homes', 'productId')
  const productId = stay ? stay.product_id : channel ? channel.product_id : null
  return { requestId, home: productId === null ? null : await readStayHome(db, access, productId), stay: stay ? await getStay(db, access, stay.id) : null }
}

export interface ScheduledGuestMessageRow {
  id: string
  organization_id: string
  product_id: string
  stay_id: string
  request_id: string | null
  template_id: string | null
  template_title: string
  template_version: number
  stay_version: number
  body: string
  due_at: string | null
  timezone: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'needs_review' | 'cancelled' | 'skipped'
  reason: string | null
  error_code: string | null
  error_field: string | null
  entry_id: string | null
  started_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export function scheduledGuestMessage(row: ScheduledGuestMessageRow) {
  if (!row.template_title.trim() || !row.body.trim()) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The scheduled message has no title or text', 'body')
  timestamp(row.created_at, 'createdAt'); timestamp(row.updated_at, 'updatedAt')
  for (const [field, value] of [['dueAt', row.due_at], ['startedAt', row.started_at], ['sentAt', row.sent_at]] as const) if (value !== null) timestamp(value, field)
  if (row.due_at === null && row.status !== 'failed' && row.status !== 'skipped') messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The scheduled message has no due time', 'dueAt')
  if ((row.status === 'failed' || row.status === 'needs_review') && (!row.reason?.trim() || !row.error_code?.trim() || !row.error_field?.trim())) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The failed message has incomplete error context', 'errorCode')
  if (row.status === 'sent' && (row.sent_at === null || row.entry_id === null)) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The sent message has no activity entry or send time', 'entryId')
  return { id: row.id, organizationId: row.organization_id, productId: row.product_id, stayId: row.stay_id, requestId: row.request_id,
    templateId: row.template_id, title: row.template_title, templateVersion: row.template_version, body: row.body, dueAt: row.due_at,
    timezone: row.timezone, status: row.status, reason: row.reason, errorCode: row.error_code, errorField: row.error_field,
    entryId: row.entry_id, startedAt: row.started_at, sentAt: row.sent_at, createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function listScheduledGuestMessages(db: DbClient, access: StayAccess, query: MessageListQuery, requestId: string | null) {
  if (requestId !== null && !await getGuestRequest(db, requestId, access.organizationId)) {
    messagingError(404, 'THREAD_NOT_FOUND', 'This conversation is not in the workspace', 'requestId')
  }
  const rows = await queryAll<ScheduledGuestMessageRow>(db, `SELECT m.* FROM scheduled_guest_messages m
    JOIN product_stay_configs c ON c.organization_id = m.organization_id AND c.product_id = m.product_id
    WHERE m.organization_id = ? ${requestId === null ? '' : 'AND m.request_id = ?'} ${access.manage ? '' : `AND ${assignedResponsibilitySql('c')}`}
    ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
  [access.organizationId, ...(requestId === null ? [] : [requestId]), ...(access.manage ? [] : [access.userId, access.userId]), query.limit + 1, query.offset])
  const page = messageListPage(rows.map(scheduledGuestMessage), query)
  return { messages: page.items, pagination: page.pagination }
}

export async function cancelScheduledGuestMessage(db: DbClient, access: StayAccess, messageId: string, now = new Date().toISOString()) {
  manager(access)
  const results = await executeBatch(db, [{ query: "UPDATE scheduled_guest_messages SET status = 'cancelled', reason = 'Cancelled by a workspace manager.', updated_at = ? WHERE id = ? AND organization_id = ? AND status = 'pending'", params: [now, messageId, access.organizationId] },
    organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'scheduled_message.cancelled', entityType: 'scheduled_guest_message', entityId: messageId, onlyIfPreviousChangedOneRow: true })], { operation: 'Cancel scheduled message' })
  const current = await queryFirst<ScheduledGuestMessageRow>(db, 'SELECT * FROM scheduled_guest_messages WHERE organization_id = ? AND id = ?', [access.organizationId, messageId])
  if (!current) messagingError(404, 'SCHEDULED_MESSAGE_NOT_FOUND', 'This scheduled message is not in the workspace', 'messageId')
  if (results[0]?.meta.changes !== 1) messagingError(409, 'SCHEDULED_MESSAGE_NOT_PENDING', `The message is ${current.status}; only a pending message can be cancelled`, 'status')
  return scheduledGuestMessage(current)
}
