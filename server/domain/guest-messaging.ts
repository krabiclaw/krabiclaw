import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { assertConversationAccess } from '~/server/domain/conversations'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { BOOKING_RECORDS_SQL, bookedRecordWindow, getGuestRequest, type BookedRecord } from '~/server/domain/requests'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { getStay, readStayHome, stayAccessFor, type StayAccess } from '~/server/domain/stays'
import { isValidInstant, localNow } from '~/utils/timezone'
import { messageListPage, messageText, messagingError, parseGuestMessageSchedule, type GuestMessageSchedule, type MessageListQuery } from './guest-message-schedule'
import { CHECK_IN_MESSAGE_TITLE, planTemplateMessages, publishScheduledGuestMessageChange } from './scheduled-guest-messages'
import type { GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

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
  organization_id: string
  title: string
  body: string
  schedule: GuestMessageSchedule
  version: number
  created_at: string
  updated_at: string
}

function manager(access: StayAccess): void {
  if (!access.manage) messagingError(403, 'MESSAGING_ROLE_REQUIRED', 'Only workspace managers can change automatic messages', 'permissions.operations.update')
}

function expectedTemplateVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    messagingError(422, 'INVALID_MESSAGING_FIELD', 'version must be the current positive integer template version', 'version')
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
  timestamp(row.created_at, 'created_at')
  timestamp(row.updated_at, 'updated_at')
  const { schedule_json: _storedSchedule, schedule_enabled_at: _activation, ...template } = row
  return { ...template, schedule: templateSchedule(row)! }
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

/**
 * What an automatic message can name: every product with booking settings — a
 * home, an experience, a consultation or a restaurant's tables. A home carries
 * its timezone; a session's is its own.
 */
export async function listMessageOfferings(db: DbClient, access: StayAccess) {
  const offerings = await queryAll<{ kind: 'stay' | 'experience' | 'service' | 'table'; id: string; name: string; timezone: string | null }>(db, `
    SELECT p.kind, p.id, COALESCE(home.internal_name, p.name) AS name, l.timezone FROM product_booking_configs c
      JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
      LEFT JOIN product_stay_configs home ON home.organization_id = c.organization_id AND home.product_id = c.product_id
      LEFT JOIN business_locations l ON l.organization_id = home.organization_id AND l.id = home.location_id WHERE c.organization_id = ?
    ORDER BY name, id`, [access.organizationId])
  for (const offering of offerings) {
    if (!offering.name?.trim()) messagingError(500, 'INVALID_MESSAGE_OFFERING', `Offering ${offering.id} has no name`, 'offerings')
    if (!['stay', 'experience', 'service', 'table'].includes(offering.kind)) messagingError(500, 'INVALID_MESSAGE_OFFERING', `Offering ${offering.id} is a ${offering.kind}, which takes no bookings`, 'offerings')
  }
  return { offerings }
}

/** A full write names the message's text and its schedule; every automatic message has one. */
export async function saveMessageTemplate(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, templateId: string | null, value: unknown, now = new Date().toISOString()): Promise<MessageTemplate> {
  manager(access)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['title', 'body', 'schedule', 'version'].includes(key))) {
    messagingError(422, 'INVALID_MESSAGING_FIELD', 'Provide title, body, schedule and the current version when editing an automatic message', 'template')
  }
  const input = value as Record<string, unknown>
  const title = messageText(input.title, 'title', 100), body = messageText(input.body, 'body', 5000)
  if (title.trim() === CHECK_IN_MESSAGE_TITLE) messagingError(422, 'MESSAGE_TITLE_RESERVED', `“${CHECK_IN_MESSAGE_TITLE}” is the built-in message every stay is sent; choose another name`, 'title')
  const schedule = parseGuestMessageSchedule(input.schedule)!
  const current = templateId === null ? null : await getMessageTemplate(db, access.organizationId, templateId)
  if (current === null ? 'version' in input : expectedTemplateVersion(input.version) !== current.version) {
    messagingError(current === null ? 422 : 409, current === null ? 'INVALID_MESSAGING_FIELD' : 'MESSAGE_TEMPLATE_VERSION_CONFLICT', current === null ? 'A new automatic message has no version' : 'This automatic message changed; reload it before editing', 'version')
  }
  // Every named offering is bookable in this workspace (listMessageOfferings):
  // a product with booking settings. The write repeats the check.
  const offerings = `? = (SELECT count(*) FROM json_each(?) named WHERE EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.organization_id = ? AND c.product_id = named.value))`
  const offeringGuard = [schedule.product_ids.length, JSON.stringify(schedule.product_ids), access.organizationId]
  if (!await queryFirst(db, `SELECT 1 WHERE ${offerings}`, offeringGuard)) {
    messagingError(404, 'MESSAGE_OFFERING_NOT_FOUND', 'Every scheduled home, experience, consultation or table must be bookable in this workspace', 'schedule.product_ids')
  }
  const previous = current === null ? null : templateSchedule(current)
  const sameReceivedScope = schedule.trigger === 'booking_received' && previous?.trigger === 'booking_received'
    && [...schedule.product_ids].sort().join('\n') === [...previous.product_ids].sort().join('\n')
  const enabledAt = sameReceivedScope && current !== null ? current.schedule_enabled_at : now
  const id = current === null ? crypto.randomUUID() : current.id
  const write = current === null ? {
    query: `INSERT INTO message_templates (id, organization_id, title, body, schedule_json, schedule_enabled_at, version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${offerings} RETURNING *`,
    params: [id, access.organizationId, title, body, JSON.stringify(schedule), enabledAt, now, now, ...offeringGuard],
  } : {
    query: `UPDATE message_templates SET title = ?, body = ?, schedule_json = ?, schedule_enabled_at = ?, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND ${offerings} RETURNING *`,
    params: [title, body, JSON.stringify(schedule), enabledAt, now, access.organizationId, id, current.version, ...offeringGuard],
  }
  const results = await executeBatch(db, [write, organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId,
    eventType: current === null ? 'message_template.created' : 'message_template.updated', entityType: 'message_template', entityId: id, onlyIfPreviousChangedOneRow: true })], { operation: 'Save message template' })
  if (results[0]?.meta.changes !== 1) messagingError(409, 'MESSAGE_TEMPLATE_WRITE_CONFLICT', 'This automatic message or one of its offerings changed before saving; reload before editing', 'template')
  const saved = results[0]?.results[0] as MessageTemplateRow | undefined
  if (!saved || saved.id !== id || saved.organization_id !== access.organizationId || saved.version !== (current === null ? 1 : current.version + 1)) {
    messagingError(500, 'MESSAGE_TEMPLATE_READBACK_FAILED', 'The automatic message was saved but its value was not returned; reload before saving again', 'template')
  }
  await planTemplateMessages(db, saved, now)
  const messages = await queryAllPages<ScheduledGuestMessageRow>(db, `${SCHEDULED_MESSAGE_VIEW_SQL} WHERE m.organization_id = ? AND m.template_id = ? ORDER BY m.id`, [access.organizationId, saved.id])
  try {
    for (const message of messages) await publishScheduledGuestMessageChange(db, env, message.conversation_id)
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The automatic message was saved, but open apps could not be updated. Reload before editing it again.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, template_id: saved.id, version: saved.version }, cause })
  }
  return messageTemplate(saved)
}

export async function deleteMessageTemplate(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, templateId: string, suppliedVersion: unknown, now = new Date().toISOString()): Promise<void> {
  manager(access)
  const version = expectedTemplateVersion(suppliedVersion)
  const current = await getMessageTemplate(db, access.organizationId, templateId)
  if (version !== current.version) messagingError(409, 'MESSAGE_TEMPLATE_VERSION_CONFLICT', 'This automatic message changed; reload it before deleting', 'version')
  const results = await executeBatch(db, [{
    query: `UPDATE scheduled_guest_messages SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
      reason = CASE WHEN status = 'pending' THEN 'The automatic message was deleted.' ELSE reason END,
      template_id = NULL, updated_at = ? WHERE organization_id = ? AND template_id = ?
      AND EXISTS (SELECT 1 FROM message_templates WHERE id = ? AND organization_id = ? AND version = ?) RETURNING id`,
    params: [now, access.organizationId, templateId, templateId, access.organizationId, current.version],
  }, {
    query: 'DELETE FROM message_templates WHERE organization_id = ? AND id = ? AND version = ?', params: [access.organizationId, templateId, current.version],
  }, organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'message_template.deleted', entityType: 'message_template', entityId: templateId, onlyIfPreviousChangedOneRow: true })], { operation: 'Delete message template' })
  if (results[1]?.meta.changes !== 1) messagingError(409, 'MESSAGE_TEMPLATE_VERSION_CONFLICT', 'This automatic message changed; reload it before deleting', 'version')
  const messages = results[0]?.results as Array<Pick<ScheduledGuestMessageRow, 'id'>>
  try {
    for (const { id } of messages) {
      const message = await queryFirst<ScheduledGuestMessageRow>(db, `${SCHEDULED_MESSAGE_VIEW_SQL} WHERE m.organization_id = ? AND m.id = ?`, [access.organizationId, id])
      if (!message) messagingError(500, 'SCHEDULED_MESSAGE_NOT_FOUND', 'The saved scheduled message could not be read', 'scheduled_message_id')
      await publishScheduledGuestMessageChange(db, env, message.conversation_id)
    }
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The automatic message was deleted, but open apps could not be updated. Reload to see its saved status.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, template_id: templateId }, cause })
  }
}

/** No provider ID, location guess, or historical guest contact substitutes for a home. */
export async function guestThreadMessagingContext(db: DbClient, principal: MemberAccessPrincipal, conversationId: string) {
  const thread = await getGuestRequest(db, conversationId, principal.organizationId)
  if (!thread) messagingError(404, 'THREAD_NOT_FOUND', 'This conversation is not in the workspace', 'conversation_id')
  await assertConversationAccess(db, principal, conversationId)
  const access = await stayAccessFor(principal)
  const [stay, channel] = await Promise.all([
    queryFirst<{ id: string; product_id: string }>(db, 'SELECT b.id, b.product_id FROM conversations c JOIN bookings b ON b.organization_id = c.organization_id AND b.id = c.booking_id WHERE c.organization_id = ? AND c.id = ? AND b.product_session_id IS NULL', [principal.organizationId, conversationId]),
    queryFirst<{ product_id: string }>(db, 'SELECT product_id FROM channel_threads WHERE organization_id = ? AND conversation_id = ?', [principal.organizationId, conversationId]),
  ])
  if (stay && channel && stay.product_id !== channel.product_id) messagingError(409, 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', 'The stay and provider conversation name different homes', 'productId')
  const productId = stay ? stay.product_id : channel ? channel.product_id : null
  return { conversation_id: conversationId, home: productId === null ? null : await readStayHome(db, access, productId), stay: stay ? await getStay(db, access, stay.id) : null,
    record: await conversationRecord(db, principal.organizationId, conversationId) }
}

/**
 * The stay or booking (a table, class or consultation) a conversation is about, as its guest
 * would read it: what and where, for how many, and its start and end on its
 * own clock. Null for a conversation with no booked record (an inquiry).
 */
async function conversationRecord(db: DbClient, organizationId: string, conversationId: string) {
  const record = await queryFirst<BookedRecord & { location: string | null; address: string | null; phone: string | null }>(db, `
    SELECT br.*, l.title AS location, l.address, l.phone FROM ${BOOKING_RECORDS_SQL} br
      LEFT JOIN business_locations l ON l.organization_id = br.organization_id AND l.id = br.location_id
     WHERE br.organization_id = ? AND br.conversation_id = ?`, [organizationId, conversationId])
  if (!record) return null
  const window = bookedRecordWindow(record)
  const local = (at: { date: string; instant: string | null }) => at.instant === null ? at.date : (({ date, time }) => `${date} ${time}`)(localNow(record.timezone, new Date(at.instant)))
  return { unit: record.unit, status: record.status, name: record.product_name, location: record.location, address: record.address ? formatPostalAddress(parsePostalAddress(record.address)) : null,
    phone: record.phone, party_size: record.party_size, timezone: record.timezone, starts: local(window.start), ends: local(window.end), no_show_at: record.no_show_at }
}

/**
 * One outbox row. author_user_id NULL is an automatic message about its booking
 * (product, booking, title, version and timezone are set); author_user_id set is
 * a member's own send-later reply in its conversation (they are all null).
 */
export interface ScheduledGuestMessageRow {
  id: string
  organization_id: string
  product_id: string | null
  booking_id: string | null
  conversation_id: string | null
  author_user_id: string | null
  template_id: string | null
  template_title: string | null
  template_version: number | null
  body: string
  due_at: string | null
  timezone: string | null
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'needs_review' | 'cancelled' | 'skipped'
  reason: string | null
  error_code: string | null
  error_field: string | null
  message_id: string | null
  started_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

// Automatic messages inherit their booking's guest conversation. Replies are
// addressed to a conversation directly, including inquiries without a booking.
export const SCHEDULED_MESSAGE_CONVERSATION_SQL = "COALESCE(m.conversation_id, (SELECT c.id FROM conversations c WHERE c.organization_id = m.organization_id AND c.booking_id = m.booking_id AND c.kind = 'booking'))"
export const SCHEDULED_MESSAGE_VIEW_SQL = `SELECT m.id, m.organization_id, m.product_id, m.booking_id, ${SCHEDULED_MESSAGE_CONVERSATION_SQL} AS conversation_id,
    m.author_user_id, m.template_id, m.template_title, m.template_version, m.body, m.due_at, m.timezone, m.status,
    m.reason, m.error_code, m.error_field, m.message_id, m.started_at, m.sent_at, m.created_at, m.updated_at
    FROM scheduled_guest_messages m`

export function scheduledGuestMessage(row: ScheduledGuestMessageRow) {
  if (!row.body.trim()) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The scheduled message has no text', 'body')
  if (row.author_user_id === null && (!row.template_title?.trim() || row.booking_id === null || row.timezone === null)) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The automatic message has no template_title, booking or timezone', 'template_title')
  if (row.author_user_id !== null && row.conversation_id === null) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The scheduled reply has no conversation', 'conversation_id')
  timestamp(row.created_at, 'created_at')
  timestamp(row.updated_at, 'updated_at')
  for (const [field, value] of [['due_at', row.due_at], ['started_at', row.started_at], ['sent_at', row.sent_at]] as const) if (value !== null) timestamp(value, field)
  if (row.due_at === null && row.status !== 'failed' && row.status !== 'skipped') messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The scheduled message has no due time', 'due_at')
  if ((row.status === 'failed' || row.status === 'needs_review') && (!row.reason?.trim() || !row.error_code?.trim() || !row.error_field?.trim())) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The failed message has incomplete error context', 'error_code')
  if (row.status === 'sent' && (row.sent_at === null || row.message_id === null)) messagingError(500, 'INVALID_SCHEDULED_MESSAGE', 'The sent message has no message or send time', 'message_id')
  return row
}

/** The outbox rows a member may see: automatic messages for managers, and their own send-later replies. */
export function visibleScheduledMessagesSql(alias: string, access: StayAccess): { query: string; params: [number, string] } {
  return { query: `((${alias}.author_user_id IS NULL AND ? = 1) OR ${alias}.author_user_id = ?)`, params: [access.manage ? 1 : 0, access.actorId] }
}

/** The outbox, newest first: every automatic message for managers, and each member's own send-later replies. */
export async function listScheduledGuestMessages(db: DbClient, access: StayAccess, query: MessageListQuery, conversationId: string | null) {
  if (conversationId !== null && !await getGuestRequest(db, conversationId, access.organizationId)) {
    messagingError(404, 'THREAD_NOT_FOUND', 'This conversation is not in the workspace', 'conversation_id')
  }
  const visible = visibleScheduledMessagesSql('m', access)
  const rows = await queryAll<ScheduledGuestMessageRow>(db, `${SCHEDULED_MESSAGE_VIEW_SQL}
    WHERE m.organization_id = ? AND ${visible.query} ${conversationId === null ? '' : `AND ${SCHEDULED_MESSAGE_CONVERSATION_SQL} = ?`}
    ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
  [access.organizationId, ...visible.params, ...(conversationId === null ? [] : [conversationId]), query.limit + 1, query.offset])
  const page = messageListPage(rows.map(scheduledGuestMessage), query)
  return { messages: page.items, pagination: page.pagination }
}

/** Cancel one pending outbox message: an automatic one by a manager, a send-later reply by its author only. */
export async function cancelScheduledGuestMessage(db: DbClient, env: GuestInboxPublicationEnv, access: StayAccess, messageId: string, now = new Date().toISOString()) {
  const found = await queryFirst<Pick<ScheduledGuestMessageRow, 'author_user_id'>>(db, 'SELECT author_user_id FROM scheduled_guest_messages WHERE organization_id = ? AND id = ?', [access.organizationId, messageId])
  // Another member's reply is not theirs to see: it is not found, as an absent one is.
  if (!found || (found.author_user_id !== null && found.author_user_id !== access.actorId)) messagingError(404, 'SCHEDULED_MESSAGE_NOT_FOUND', 'This scheduled message does not exist or is not yours', 'scheduled_message_id')
  if (found.author_user_id === null) manager(access)
  const reason = found.author_user_id === null ? 'Cancelled by a workspace manager.' : 'Cancelled by its author.'
  const results = await executeBatch(db, [{ query: `UPDATE scheduled_guest_messages SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND author_user_id IS ? AND status = 'pending'`, params: [reason, now, messageId, access.organizationId, found.author_user_id] },
    organizationEventQuery({ organizationId: access.organizationId, actorId: access.actorId, eventType: 'scheduled_message.cancelled', entityType: 'scheduled_guest_message', entityId: messageId, onlyIfPreviousChangedOneRow: true })], { operation: 'Cancel scheduled message' })
  const current = await queryFirst<ScheduledGuestMessageRow>(db, `${SCHEDULED_MESSAGE_VIEW_SQL} WHERE m.organization_id = ? AND m.id = ?`, [access.organizationId, messageId])
  if (!current) messagingError(404, 'SCHEDULED_MESSAGE_NOT_FOUND', 'This scheduled message is not in the workspace', 'scheduled_message_id')
  if (results[0]?.meta.changes !== 1) messagingError(409, 'SCHEDULED_MESSAGE_NOT_PENDING', `The message is ${current.status}; only a pending message can be cancelled`, 'status')
  try {
    await publishScheduledGuestMessageChange(db, env, current.conversation_id)
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The scheduled message was cancelled, but open apps could not be updated. Reload to see its saved status.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, scheduled_message_id: current.id }, cause })
  }
  return scheduledGuestMessage(current)
}
