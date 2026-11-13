import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { assignedGuestThreadScope, assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'

/**
 * Conversations, as Slack and Discord have them (docs/domain-model.md): a
 * guest's with the business (`contact`, `booking`) or the team's own (`team`),
 * each person's read position and archive (`conversation_participants`), and
 * the messages, written by people or by KrabiClaw (`messages`).
 *
 * This module is the one writer of a message (`messageQueries`,
 * `appendMessage`), the one statement of unread (`unreadSql`), the one place
 * a read position or an archive moves, and the one statement of who sees a
 * conversation (`conversationAccessSql`).
 */

export type ConversationKind = 'contact' | 'booking' | 'team'
export type MessageAuthorKind = 'guest' | 'member' | 'krabiclaw'
export type MessageChannel = 'web' | 'email' | 'whatsapp' | 'airbnb'

export interface MessageRow {
  id: string
  organization_id: string
  conversation_id: string
  sequence: number
  author_kind: MessageAuthorKind
  author_user_id: string | null
  channel: MessageChannel | null
  body: string | null
  event_name: string | null
  payload_json: string
  dedupe_key: string
  occurred_at: string
  created_at: string
}

export class MessageDedupeConflictError extends Error {}
export class MessageOwnershipError extends Error {}
export class MessageStateConflictError extends Error {}

/** A message with words, a photo or a file; Airbnb records some host actions as messages with none. */
export function messageHasContentSql(message: string): string {
  return `(NULLIF(TRIM(${message}.body), '') IS NOT NULL OR COALESCE(json_array_length(${message}.payload_json, '$.attachments'), 0) > 0 OR EXISTS (SELECT 1 FROM media_placements mp WHERE mp.owner_type = 'message' AND mp.owner_id = ${message}.id AND mp.slot = 'attachments' AND mp.status = 'active'))`
}

/** KrabiClaw's events a guest sees in their own conversation. Staff diagnostics and disputes are the business's. */
export const GUEST_VISIBLE_EVENTS = [
  'booking.confirm', 'booking.reject', 'booking.cancel',
  'booking_change.requested', 'booking_change.accepted', 'booking_change.declined', 'booking_change.withdrawn', 'booking_change.moved',
  'payment.payment_captured', 'payment.payment_failed', 'payment.refund_pending', 'payment.refund_succeeded', 'payment.refund_failed', 'payment.refund_canceled',
] as const
export const OPENING_EVENT = 'thread.opening'
export const SCHEDULED_MESSAGE_EVENT = 'thread.scheduled_message'
export const MEMBER_REPLY_EVENT = 'thread.member_reply'
export const MIRRORED_EVENT = 'channel.message_mirrored'
/** A contact form's own words: the guest's first message. */
export const SUBMISSION_EVENT = 'thread.submission'
/** A booking guest's note, written with the booking as their own message. */
export const GUEST_NOTE_EVENT = 'thread.guest_note'
/** KrabiClaw's messages that are words to read, not events about the booking. */
const KRABICLAW_WORDS = new Set<string | null>([OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, MIRRORED_EVENT])

/** An event KrabiClaw recorded (a cancellation, a change, a payment), as opposed to words someone wrote. */
export function isEventMessage(message: Pick<MessageRow, 'author_kind' | 'event_name'>): boolean {
  return message.author_kind === 'krabiclaw' && !KRABICLAW_WORDS.has(message.event_name)
}

/**
 * The part a message's person plays in its conversation: its guest, the team,
 * or KrabiClaw alone. An event names the person who caused it, so its role is
 * read from who that is.
 */
export function messageRole(message: Pick<MessageRow, 'author_kind' | 'author_user_id' | 'event_name'>, guestUserId: string | null): MessageAuthorKind {
  if (!isEventMessage(message)) return message.author_kind
  if (message.author_user_id === null) return 'krabiclaw'
  return message.author_user_id === guestUserId ? 'guest' : 'member'
}

/**
 * What a conversation's guest sees of it, the one statement: their own words
 * on the web, by email or WhatsApp, the business's replies, KrabiClaw's opening
 * and automatic messages, and the booking and payment events above. An
 * Airbnb guest reads Airbnb, not KrabiClaw.
 */
export function guestVisibleSql(message: string): string {
  return `((${message}.author_kind = 'guest' AND ${message}.channel IN ('web', 'email', 'whatsapp'))
    OR (${message}.author_kind = 'member' AND ${message}.event_name = '${MEMBER_REPLY_EVENT}')
    OR (${message}.author_kind = 'krabiclaw' AND (${message}.event_name IN ('${SCHEDULED_MESSAGE_EVENT}', '${OPENING_EVENT}', ${GUEST_VISIBLE_EVENTS.map(event => `'${event}'`).join(', ')}))))`
}

/**
 * Unread, the one statement: the conversation `conversation` has a message
 * from someone other than the viewer that is newer than the viewer's read
 * position. KrabiClaw's automatic messages have no actor and count for everyone who can
 * see them. A guest counts only what they can see. Every list row, the Unread filter, the
 * filter counts, the nav count, the app badge and MCP read this.
 */
export function unreadSql(conversation: string, viewer: string): { sql: string; params: string[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM messages unread_message
      WHERE unread_message.conversation_id = ${conversation}.id
        AND unread_message.author_user_id IS NOT ?
        AND (${conversation}.user_id IS NOT ? OR ${guestVisibleSql('unread_message')})
        AND unread_message.sequence > COALESCE((SELECT read_message.sequence FROM conversation_participants reader
          JOIN messages read_message ON read_message.id = reader.last_read_message_id
          WHERE reader.conversation_id = ${conversation}.id AND reader.user_id = ?), 0))`,
    params: [viewer, viewer, viewer],
  }
}

/** The newest message from someone else the viewer can see, and the one before it, for marking unread. */
async function newestFromSomeoneElse(db: DbClient, conversationId: string, userId: string): Promise<{ id: string; previous_id: string | null } | null> {
  return await queryFirst<{ id: string; previous_id: string | null }>(db, `
    SELECT m.id, (SELECT before.id FROM messages before WHERE before.conversation_id = m.conversation_id AND before.sequence < m.sequence ORDER BY before.sequence DESC LIMIT 1) AS previous_id
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = ? AND m.author_user_id IS NOT ? AND (c.user_id IS NOT ? OR ${guestVisibleSql('m')})
     ORDER BY m.sequence DESC LIMIT 1`, [conversationId, userId, userId])
}

export interface ConversationRow {
  id: string
  organization_id: string
  kind: ConversationKind
  location_id: string | null
  booking_id: string | null
  user_id: string | null
  name: string | null
  is_group: number
  participants_key: string | null
  created_by_user_id: string | null
  blocked_at: string | null
  payload_json: string
  last_message_at: string
  created_at: string
}

export async function readConversation(db: DbClient, organizationId: string, conversationId: string): Promise<ConversationRow | null> {
  return await queryFirst<ConversationRow>(db, 'SELECT * FROM conversations WHERE organization_id = ? AND id = ?', [organizationId, conversationId]) ?? null
}

/** A person's read position and archive in one conversation. */
function participantUpsert(input: { conversationId: string; organizationId: string; userId: string; set: 'last_read_message_id' | 'archived_at'; valueSql: string; params: unknown[]; where?: string; whereParams?: unknown[]; now: string }): BatchQuery {
  return {
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, ${input.set}, created_at)
      SELECT c.id, c.organization_id, ?, ${input.valueSql}, ? FROM conversations c WHERE c.id = ? AND c.organization_id = ?${input.where ? ` AND ${input.where}` : ''}
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET ${input.set} = excluded.${input.set}`,
    params: [input.userId, ...input.params, input.now, input.conversationId, input.organizationId, ...(input.whereParams ?? [])],
  }
}

export interface MessageInput {
  /** Kept when a message moves; a new one is random. */
  id?: string
  conversationId: string
  authorKind: MessageAuthorKind
  /** The person who wrote it, or who caused KrabiClaw's event; null for KrabiClaw alone. */
  authorUserId: string | null
  channel?: MessageChannel | null
  body?: string | null
  eventName?: string | null
  payload?: Record<string, unknown>
  /** The same key is the same message; a replay returns it. */
  dedupeKey?: string
  occurredAt?: string
  /** A predicate on the conversation `c`, checked in the statement that writes the message. */
  guard?: { sql: string; params: unknown[] }
}

/** The instant a message sorts its conversation by: the channel's own time when it gave one. */
function messageTime(input: MessageInput, occurredAt: string): string {
  const provider = input.payload?.provider_inserted_at
  if (typeof provider !== 'string' || !provider) return occurredAt
  const instant = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(provider) ? provider : `${provider}Z`)
  if (!Number.isFinite(instant)) throw new HTTPError({ statusCode: 422, message: 'The channel gave a message time that is not a time', data: { code: 'INVALID_PROVIDER_TIME', field: 'provider_inserted_at' } })
  return new Date(instant).toISOString()
}

/**
 * The one writer of a message, as batch statements for the caller's batch:
 * the message, at the next sequence, where the conversation is and `guard`
 * holds; the conversation's last activity; the people who archived it see it
 * again; and its author has read it. Each statement after the first runs
 * only where this batch wrote the message, so a replay of its dedupe key moves
 * nothing.
 */
export function messageQueries(input: MessageInput): { id: string; dedupeKey: string; queries: BatchQuery[] } {
  const id = input.id ?? crypto.randomUUID()
  const dedupeKey = input.dedupeKey ?? `message:${id}`
  const occurredAt = input.occurredAt ?? new Date().toISOString()
  const createdAt = new Date().toISOString()
  const written = 'EXISTS (SELECT 1 FROM messages written WHERE written.id = ?)'
  const queries: BatchQuery[] = [{
    query: `INSERT INTO messages (id, organization_id, conversation_id, sequence, author_kind, author_user_id, channel, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
      SELECT ?, c.organization_id, c.id, COALESCE((SELECT MAX(prior.sequence) FROM messages prior WHERE prior.conversation_id = c.id), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM conversations c WHERE c.id = ?${input.guard ? ` AND (${input.guard.sql})` : ''}
      ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [id, input.authorKind, input.authorUserId, input.channel ?? null, input.body ?? null, input.eventName ?? null,
      JSON.stringify(input.payload ?? {}), dedupeKey, occurredAt, createdAt, input.conversationId, ...(input.guard?.params ?? [])],
  }, {
    query: `UPDATE conversations SET last_message_at = max(last_message_at, ?) WHERE id = ? AND ${written}`,
    params: [messageTime(input, occurredAt), input.conversationId, id],
  }, {
    query: `UPDATE conversation_participants SET archived_at = NULL WHERE conversation_id = ? AND archived_at IS NOT NULL AND user_id IS NOT ? AND ${written}`,
    params: [input.conversationId, input.authorUserId, id],
  }]
  if (input.authorUserId && input.authorKind !== 'krabiclaw') {
    queries.push({
      query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, last_read_message_id, created_at)
        SELECT conversation_id, organization_id, ?, id, ? FROM messages WHERE id = ?
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
      params: [input.authorUserId, createdAt, id],
    })
  }
  return { id, dedupeKey, queries }
}

export async function findMessageByDedupeKey(db: DbClient, dedupeKey: string): Promise<MessageRow | null> {
  return await queryFirst<MessageRow>(db, 'SELECT * FROM messages WHERE dedupe_key = ?', [dedupeKey]) ?? null
}

export async function getMessage(db: DbClient, id: string): Promise<MessageRow | null> {
  return await queryFirst<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', [id]) ?? null
}

/** A conversation's messages in order. */
export function conversationMessagesQuery(conversationId: string, guestAudience: boolean): BatchQuery {
  return { query: `SELECT m.* FROM messages m WHERE m.conversation_id = ? ${guestAudience ? `AND ${guestVisibleSql('m')}` : ''} ORDER BY m.sequence`, params: [conversationId] }
}

export async function listConversationMessages(db: DbClient, conversationId: string, guestAudience: boolean): Promise<MessageRow[]> {
  const { query, params } = conversationMessagesQuery(conversationId, guestAudience)
  return queryAll<MessageRow>(db, query, params)
}

/** A message already under this key is this message, or the key was given to a different one. */
function sameMessage(existing: MessageRow, input: MessageInput): MessageRow {
  const matches = existing.conversation_id === input.conversationId
    && existing.author_kind === input.authorKind
    && existing.author_user_id === (input.authorUserId ?? null)
    && existing.channel === (input.channel ?? null)
    && existing.body === (input.body ?? null)
    && existing.event_name === (input.eventName ?? null)
    && existing.payload_json === JSON.stringify(input.payload ?? {})
  if (!matches) throw new MessageDedupeConflictError('This message key belongs to a different message')
  return existing
}

/** The guard that the conversation belongs to this guest. */
export function guestOwnsGuard(guestUserId: string): { sql: string; params: unknown[] } {
  return { sql: `c.user_id = ? AND ${CURRENT_GUEST_SQL('c')}`, params: [guestUserId] }
}

/** A guest conversation is its guest's while every booking it is about is theirs too. */
export const CURRENT_GUEST_SQL = (conversation: string) => `${conversation}.user_id IS NOT NULL AND ${conversation}.kind IN ('contact', 'booking')
  AND NOT EXISTS (SELECT 1 FROM bookings guest_booking WHERE guest_booking.id = ${conversation}.booking_id AND guest_booking.organization_id = ${conversation}.organization_id
    AND (guest_booking.user_id IS NULL OR guest_booking.user_id <> ${conversation}.user_id))`

/**
 * Write one message and read it back. A replay of its dedupe key returns the
 * message already written; a different message under the key is refused, and
 * a guard that no longer holds is a state conflict.
 */
export async function appendMessage(db: DbClient, input: MessageInput, more: BatchQuery[] = []): Promise<MessageRow> {
  if (input.dedupeKey) {
    const existing = await findMessageByDedupeKey(db, input.dedupeKey)
    if (existing) return sameMessage(existing, input)
  }
  const write = messageQueries(input)
  const [inserted] = await executeBatch(db, [...write.queries, ...more], { operation: 'Write message' })
  if (Number(inserted?.meta?.changes ?? 0) === 0) {
    const replay = await findMessageByDedupeKey(db, write.dedupeKey)
    if (replay) return sameMessage(replay, input)
    if (!await queryFirst(db, 'SELECT 1 FROM conversations WHERE id = ?', [input.conversationId])) throw new HTTPError({ statusCode: 404, message: 'Conversation not found', data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
    throw new MessageStateConflictError('The conversation changed before the message could be written')
  }
  const created = await getMessage(db, write.id)
  if (!created) throw new Error(`Message ${write.id} was written and could not be read back`)
  return created
}

export function parseMessagePayload(message: Pick<MessageRow, 'payload_json'>): Record<string, unknown> {
  return JSON.parse(message.payload_json) as Record<string, unknown>
}

/** Read through to `messageId` (the newest message shown), never back past where the reader already is. */
export function readThroughQuery(input: { conversationId: string; organizationId: string; userId: string; messageId: string; now: string }): BatchQuery {
  return {
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, last_read_message_id, created_at)
      SELECT m.conversation_id, m.organization_id, ?, m.id, ? FROM messages m WHERE m.id = ? AND m.conversation_id = ? AND m.organization_id = ?
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id
        WHERE conversation_participants.last_read_message_id IS NULL
          OR (SELECT sequence FROM messages WHERE id = excluded.last_read_message_id) > (SELECT sequence FROM messages WHERE id = conversation_participants.last_read_message_id)`,
    params: [input.userId, input.now, input.messageId, input.conversationId, input.organizationId],
  }
}

function nothingToMark(): never {
  throw new HTTPError({ statusCode: 409, message: 'The conversation has no message from someone else to mark', data: { code: 'NOTHING_TO_MARK', field: 'conversation_id' } })
}

/**
 * Opening a conversation reads it through to the newest message shown
 * (`throughMessageId`), whatever it holds; Mark as read reads it through to its
 * newest, and needs a message from someone else, as Mark as unread does.
 */
export async function markConversationRead(db: DbClient, input: { organizationId: string; conversationId: string; userId: string; throughMessageId?: string | null }): Promise<{ read: true; last_read_message_id: string }> {
  if (!input.throughMessageId && !await newestFromSomeoneElse(db, input.conversationId, input.userId)) nothingToMark()
  const through = input.throughMessageId ?? (await queryFirst<{ id: string }>(db, 'SELECT id FROM messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1', [input.conversationId]))!.id
  const [written] = await executeBatch(db, [readThroughQuery({ ...input, messageId: through, now: new Date().toISOString() })], { operation: 'Read conversation' })
  if (input.throughMessageId && Number(written?.meta?.changes ?? 0) === 0
    && !await queryFirst(db, 'SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?', [through, input.conversationId])) {
    throw new HTTPError({ statusCode: 422, message: 'That message is not in this conversation', data: { code: 'INVALID_MESSAGE', field: 'messageId' } })
  }
  return { read: true, last_read_message_id: through }
}

/** Mark as unread: the newest message from someone else is unread again, whoever wrote what after it. */
export async function markConversationUnread(db: DbClient, input: { organizationId: string; conversationId: string; userId: string }): Promise<{ read: false; last_read_message_id: string | null }> {
  const newest = await newestFromSomeoneElse(db, input.conversationId, input.userId)
  if (!newest) nothingToMark()
  await executeBatch(db, [participantUpsert({ conversationId: input.conversationId, organizationId: input.organizationId, userId: input.userId,
    set: 'last_read_message_id', valueSql: '?', params: [newest.previous_id], now: new Date().toISOString() })], { operation: 'Mark conversation unread' })
  return { read: false, last_read_message_id: newest.previous_id }
}

/** Archive or unarchive, for this person alone (D2). */
export function archiveQuery(input: { organizationId: string; conversationId: string; userId: string; archived: boolean; now: string }): BatchQuery {
  return participantUpsert({ conversationId: input.conversationId, organizationId: input.organizationId, userId: input.userId,
    set: 'archived_at', valueSql: '?', params: [input.archived ? input.now : null], now: input.now })
}

/** Archiving a guest conversation also dismisses its open reply task, as Dismiss does: what the guest said next is work again. */
export function archiveReplyTaskQuery(input: { conversationId: string; userId: string; now: string }): BatchQuery {
  return {
    query: `UPDATE tasks SET status = 'skipped', closed_at = ?, closed_by_user_id = ?, version = version + 1, updated_at = ?
      WHERE kind = 'guest_reply' AND subject_type = 'conversation' AND subject_id = ? AND status = 'open'`,
    params: [input.now, input.userId, input.now, input.conversationId],
  }
}

/**
 * Who sees a conversation, the one statement, for `principal` on the
 * conversation `alias`: a guest conversation by role (operations:read) or by
 * handling its booking's product or its location (operations:assigned); a
 * team conversation by being in it (team_messages:read).
 */
export async function conversationAccessSql(alias: string, principal: Pick<MemberAccessPrincipal, 'organizationId' | 'role' | 'userId'>): Promise<{ sql: string; params: string[] }> {
  const [allGuests, assignedGuests, team] = await Promise.all([
    roleAllows({ ...principal, permissions: { operations: ['read'] } }),
    roleAllows({ ...principal, permissions: { operations: ['assigned'] } }),
    roleAllows({ ...principal, permissions: { team_messages: ['read'] } }),
  ])
  const parts: Array<{ sql: string; params: string[] }> = []
  if (allGuests) parts.push({ sql: `${alias}.kind IN ('contact', 'booking')`, params: [] })
  else if (assignedGuests) {
    const scope = assignedGuestThreadScope(alias, principal.userId)
    parts.push({ sql: `(${alias}.kind IN ('contact', 'booking') AND ${scope.sql})`, params: scope.params })
  }
  if (team) parts.push({ sql: `(${alias}.kind = 'team' AND EXISTS (SELECT 1 FROM conversation_participants seat WHERE seat.conversation_id = ${alias}.id AND seat.user_id = ?))`, params: [principal.userId] })
  if (!parts.length) return { sql: '0', params: [] }
  return { sql: `(${parts.map(part => part.sql).join(' OR ')})`, params: parts.flatMap(part => part.params) }
}

/** The conversation is the principal's to read, or 404. */
export async function assertConversationAccess(db: DbClient, principal: MemberAccessPrincipal, conversationId: string): Promise<ConversationRow> {
  const access = await conversationAccessSql('c', principal)
  const row = await queryFirst<ConversationRow>(db, `SELECT c.* FROM conversations c WHERE c.organization_id = ? AND c.id = ? AND ${access.sql}`, [principal.organizationId, conversationId, ...access.params])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Conversation not found or access denied', data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
  return row
}

/** A guest conversation's operations need a guest role; a team conversation's, being in it. */
export async function assertGuestOperations(principal: MemberAccessPrincipal): Promise<void> {
  if (!await roleAllows({ ...principal, permissions: { operations: ['read'] } })) await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
}

/** The unread conversations a person sees, per list kind: the filter counts, the nav count and the badge. */
export interface UnreadCounts { all: number; guests: number; support: number; team: number }

/** An Airbnb Support case: Airbnb's agents wrote and no guest did. */
export const SUPPORT_CONVERSATION_SQL = (alias: string) => `(${alias}.kind = 'booking' AND EXISTS (SELECT 1 FROM messages support_message WHERE support_message.conversation_id = ${alias}.id AND support_message.author_kind = 'krabiclaw' AND support_message.event_name = '${MIRRORED_EVENT}')
  AND NOT EXISTS (SELECT 1 FROM messages guest_message WHERE guest_message.conversation_id = ${alias}.id AND guest_message.author_kind = 'guest'))`

export async function listUnreadIds(db: DbClient, conversationIds: string[], userId: string): Promise<Set<string>> {
  if (!conversationIds.length) return new Set()
  const unread = unreadSql('c', userId)
  const rows = await queryAll<{ id: string }>(db, `SELECT c.id FROM conversations c WHERE c.id IN (SELECT value FROM json_each(?)) AND ${unread.sql}`, [d1JsonStringSet(conversationIds), ...unread.params])
  return new Set(rows.map(row => row.id))
}

/**
 * A person who left the organization keeps none of its conversations: their
 * seats in team conversations and their read positions in guest ones go,
 * while what they wrote stays. A guest's own place in their conversation is
 * not a membership and stays.
 */
export function departedParticipantsQuery(organizationId: string): BatchQuery {
  return {
    query: `DELETE FROM conversation_participants WHERE organization_id = ?
      AND NOT EXISTS (SELECT 1 FROM member m WHERE m.organizationId = conversation_participants.organization_id AND m.userId = conversation_participants.user_id)
      AND user_id IS NOT (SELECT c.user_id FROM conversations c WHERE c.id = conversation_participants.conversation_id)`,
    params: [organizationId],
  }
}
