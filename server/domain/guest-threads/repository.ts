import { HTTPError } from 'nitro'
import { sessionPrepTaskQueries } from '~/server/domain/tasks'
import { BOOKING_ENDS_SQL, BOOKING_RECORDS_SQL, bookingDay, parseGuestRequest, stayRequestPayBySql, stayRequestRespondBySql } from '~/server/domain/requests'
import {
  MEMBER_REPLY_EVENT, MIRRORED_EVENT, OPENING_EVENT, SUPPORT_CONVERSATION_SQL,
  archiveQuery, conversationAccessDenied, participantGuard, guestVisibleSql, listUnreadIds, messageHasContentSql, unreadSql, type ConversationGuard, type UnreadCounts,
} from '~/server/domain/conversations'
import { messagePreview } from './attachments'
import { conversationGuestName } from './inbox'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import type { GuestThreadSubmissionType, InboxRow, ListGuestThreadsOptions } from './types'
import { calendarDate, clockTime, firstName, initial, listTime, localDateKey, providerInstant, stayWhen } from './presentation'
import { formatCalendarRange } from '~/utils/timezone'
import { pastByRuleSql, pastSql, type GuestThreadMailbox } from './mailbox'

const REPLY_CHANNEL_SQL = "CASE WHEN EXISTS (SELECT 1 FROM channel_threads ct WHERE ct.conversation_id = gt.id AND ct.organization_id = gt.organization_id) OR EXISTS (SELECT 1 FROM bookings st WHERE st.id = gt.booking_id AND st.organization_id = gt.organization_id AND st.owner = 'channel') THEN 'airbnb' ELSE 'email' END"

/**
 * A business response is visible on the web or evidenced by the guest's real
 * delivery, or is the host's own message on Airbnb. KrabiClaw's replies sent
 * through Airbnb are not mirrored back (channel-messages.ts), so a mirrored
 * host message is one typed on Airbnb.
 */
function successfulBusinessReplySql(reply: string): string {
  return `(${reply}.author_kind = 'member' AND ${messageHasContentSql(reply)} AND (
    (${reply}.event_name = '${MEMBER_REPLY_EVENT}' AND (${reply}.channel = 'web' OR EXISTS (
      SELECT 1 FROM guest_thread_deliveries delivery
      WHERE delivery.message_id = ${reply}.id AND delivery.purpose = 'member_reply'
        AND delivery.provider <> 'log_only' AND NULLIF(TRIM(delivery.provider_message_id), '') IS NOT NULL
        AND delivery.status IN ('accepted', 'sent', 'delivered', 'read')
    ))) OR (${reply}.event_name = '${MIRRORED_EVENT}' AND ${reply}.channel = 'airbnb'
      AND NULLIF(TRIM(json_extract(${reply}.payload_json, '$.provider_message_id')), '') IS NOT NULL)
  ))`
}

/**
 * The booking a conversation is about.
 *
 * A conversation carries no time, party size or status of its own, so lists
 * read them from the booking it names. `ends_at` is the end SQL compares (a
 * nights booking's end stored as a day reads as that day's last moment
 * anywhere); `stored_starts_at`/`stored_ends_at` are as stored, read in
 * `timezone`. A conversation with no booking yields NULLs, and the surface
 * says it has no booking rather than printing a fabricated slot.
 */
/** Built when read: requests.ts reaches this module through payments and notifications (the app badge). */
const operationalRecordSql = () => `
  LEFT JOIN (
    SELECT b.id AS booking_id, b.organization_id, b.status, b.party_size, b.party_size_is_minimum, b.starts_at, ${BOOKING_ENDS_SQL('b')} AS ends_at, b.ends_at AS stored_ends_at, b.timezone,
           CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit, bc.assigned_member_id, b.product_id
      FROM bookings b
      JOIN product_booking_configs bc ON bc.organization_id = b.organization_id AND bc.product_id = b.product_id
  ) op ON op.booking_id = gt.booking_id AND op.organization_id = gt.organization_id`

/** Business inbox labels use the home's private identity; buyer labels keep the location's public title. */
function threadLocationTitleSql(buyerAudience = false): string {
  if (buyerAudience) return 'bl.title'
  return `CASE WHEN op.unit = 'nights' OR EXISTS (SELECT 1 FROM channel_threads channel WHERE channel.organization_id = gt.organization_id AND channel.conversation_id = gt.id AND channel.product_id IS NOT NULL)
    THEN (SELECT home.internal_name FROM product_stay_configs home WHERE home.organization_id = gt.organization_id AND home.product_id = COALESCE(op.product_id,
      (SELECT channel.product_id FROM channel_threads channel WHERE channel.organization_id = gt.organization_id AND channel.conversation_id = gt.id))) ELSE bl.title END`
}

/**
 * The mailbox filter, `resolveGuestThreadMailbox` said to the database
 * (mailbox.ts `pastSql`) for the viewer `me`. A blocked guest's conversation
 * is in Blocked only, and a list with no mailbox leaves it out. A guest's own
 * inbox has no archive and reads the same quiet rule.
 */
function mailboxWhere(mailbox: GuestThreadMailbox | null, now: string, buyerAudience = false): { sql: string; params: string[] } {
  if (buyerAudience) {
    if (mailbox === null) return { sql: '', params: [] }
    const rule = pastByRuleSql(now)
    return { sql: ` AND ${mailbox === 'current' ? 'NOT ' : ''}${rule.sql}`, params: rule.params }
  }
  if (mailbox === 'blocked') return { sql: ' AND gt.blocked_at IS NOT NULL', params: [] }
  if (mailbox === null) return { sql: ' AND gt.blocked_at IS NULL', params: [] }
  const past = pastSql(now)
  return { sql: ` AND gt.blocked_at IS NULL AND ${mailbox === 'current' ? 'NOT ' : ''}${past.sql}`, params: past.params }
}

/** A stay's conversation: its booking is a home's nights, or it is a channel's conversation whose guest has not booked yet (an inquiry). */
const STAY_CONVERSATION_SQL = `(gt.kind = 'booking' AND (op.unit = 'nights' OR (op.unit IS NULL AND EXISTS (SELECT 1 FROM channel_threads stay_channel WHERE stay_channel.conversation_id = gt.id))))`

/**
 * A stay lands as a booking, not as a conversation: a stay is in the inbox once someone has written.
 * A checkout's conversation waits on the guest: it is a conversation once payment has created its booking.
 */
const HAS_CONVERSATION_SQL = `(gt.kind = 'team' OR ((op.unit IS NOT 'nights' OR EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = gt.id AND e.author_kind <> 'krabiclaw' AND ${messageHasContentSql('e')}))
  AND (json_extract(gt.payload_json, '$.provenance.creation_kind') IS NOT 'checkout' OR gt.booking_id IS NOT NULL)))`

/** A conversation's type as the inbox filters it: a contact, a stay's, or any other booking's. */
function threadTypeWhere(type: GuestThreadSubmissionType): string {
  if (type === 'contact') return " AND gt.kind = 'contact'"
  return ` AND gt.kind = 'booking' AND ${type === 'stay' ? '' : 'NOT '}${STAY_CONVERSATION_SQL}`
}

/** The list kinds: a guest's conversation, an Airbnb Support case, or the team's own. */
function kindWhere(kind: NonNullable<ListGuestThreadsOptions['kind']>): string {
  if (kind === 'team') return " AND gt.kind = 'team'"
  return ` AND gt.kind IN ('contact', 'booking') AND ${kind === 'support' ? '' : 'NOT '}${SUPPORT_CONVERSATION_SQL('gt')}`
}

/**
 * The scope every list read shares: whose conversations, which location,
 * which mailbox, which kind, what was searched, joined to the viewer's own
 * participant row `me`. Params run in SQL order: the `me` join, then the WHERE.
 */
async function inboxScope(organizationId: string | null, opts: ListGuestThreadsOptions, now: string): Promise<{ from: string; where: string; params: Array<string | number> }> {
  if (!organizationId && !opts.buyerAudience) throw new Error('Conversation list requires organization scope')
  if (!opts.userId) throw new Error('Conversation list requires the viewer')
  const params: Array<string | number> = [opts.userId]
  const from = `conversations gt${operationalRecordSql()}
    LEFT JOIN conversation_participants me ON me.conversation_id = gt.id AND me.user_id = ?`
  const access = participantGuard('gt', opts.userId, opts.buyerAudience ? 'guest' : 'member')
  let where = access.sql
  params.push(...access.params)
  if (organizationId) { where += ' AND gt.organization_id = ?'; params.push(organizationId) }
  if (opts.conversationIds) {
    where += " AND gt.id IN (SELECT value FROM json_each(?))"
    params.push(d1JsonStringSet(opts.conversationIds))
  }
  if (opts.locationId) { where += ' AND gt.location_id = ?'; params.push(opts.locationId) }
  if (opts.assignedMemberId) { where += ' AND op.assigned_member_id = ?'; params.push(opts.assignedMemberId) }
  if (opts.type) where += threadTypeWhere(opts.type)
  if (opts.kind) where += kindWhere(opts.kind)
  if (opts.q) {
    const visible = opts.buyerAudience ? ` AND ${guestVisibleSql('e', 'gt.user_id = me.user_id')}` : ''
    const like = `%${opts.q.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`
    where += ` AND (LOWER(COALESCE(json_extract(gt.payload_json, '$.guest.name'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(gt.name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(json_extract(gt.payload_json, '$.participant.title'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(${threadLocationTitleSql(opts.buyerAudience)}, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = gt.id${visible}
        AND (LOWER(COALESCE(e.body, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(json_extract(e.payload_json, '$.meta.name'), '')) LIKE ? ESCAPE '\\')))`
    params.push(like, like, like, like, like, like)
  }
  where += ` AND (${HAS_CONVERSATION_SQL}${opts.buyerAudience ? ' OR gt.user_id IS NOT me.user_id' : ''})`
  const mailbox = mailboxWhere(opts.mailbox ?? null, now, opts.buyerAudience)
  where += mailbox.sql
  params.push(...mailbox.params)
  return { from, where, params }
}

type ListRow = {
  id: string
  kind: 'contact' | 'booking' | 'team'
  user_id: string | null
  name: string | null
  created_at: string
  last_message_at: string
  reply_channel: 'email' | 'airbnb'
  support: number
  organization_name: string
  location_title: string | null
  time_zone: string
  record_unit: 'slot' | 'nights' | null
  record_starts_at: string | null
  record_stored_ends_at: string | null
  record_timezone: string | null
  record_title: string | null
  latest_message_id: string | null
  unread: number
}

/**
 * The one list of conversations (inbox-parity.md, "The list"), as `InboxRow`s
 * for the business's inbox (guests, Airbnb Support and the team's own), a
 * guest's own inbox, the iOS Messages tab and MCP: the person first, the dates
 * and home, the last message and its time, newest first. A stay nobody has
 * written about is not listed.
 */
export async function listConversations(
  db: DbClient,
  organizationId: string | null,
  opts: ListGuestThreadsOptions,
  now = new Date(),
): Promise<InboxRow[]> {
  const scope = await inboxScope(organizationId, opts, now.toISOString())
  const visible = opts.buyerAudience ? ` AND ${guestVisibleSql('e', 'gt.user_id = me.user_id')}` : ''
  const unread = unreadSql('gt', opts.userId)
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200))
  const rows = await queryAll<ListRow & Record<string, unknown>>(db, `
    SELECT gt.*, ${REPLY_CHANNEL_SQL} AS reply_channel, ${SUPPORT_CONVERSATION_SQL('gt')} AS support,
      o.name AS organization_name, ${threadLocationTitleSql(opts.buyerAudience)} AS location_title, COALESCE(bl.timezone, o.timezone) AS time_zone,
      op.unit AS record_unit, op.starts_at AS record_starts_at, op.stored_ends_at AS record_stored_ends_at, op.timezone AS record_timezone,
      (SELECT COALESCE(sc.internal_name, p.name) FROM products p LEFT JOIN product_stay_configs sc ON sc.organization_id = p.organization_id AND sc.product_id = p.id
        WHERE p.organization_id = gt.organization_id AND p.id = op.product_id) AS record_title,
      (SELECT e.id FROM messages e WHERE e.conversation_id = gt.id${visible} AND ${messageHasContentSql('e')} ORDER BY e.sequence DESC LIMIT 1) AS latest_message_id,
      ${unread.sql} AS unread
    FROM ${scope.from}
    JOIN organization o ON o.id = gt.organization_id
    LEFT JOIN business_locations bl ON bl.id = gt.location_id
    WHERE ${scope.where}${opts.unreadOnly ? ` AND ${unread.sql}` : ''}
    ORDER BY gt.last_message_at DESC, gt.id
    LIMIT ? OFFSET ?
  `, [...unread.params, ...scope.params, ...(opts.unreadOnly ? unread.params : []), limit, opts.offset ?? 0])

  const teamIds = rows.filter(row => row.kind === 'team').map(row => row.id)
  const [latest, people] = await Promise.all([
    latestMessages(db, rows.flatMap(row => row.latest_message_id ? [row.latest_message_id] : [])),
    teamIds.length ? queryAll<{ conversation_id: string; user_id: string; name: string }>(db, `SELECT p.conversation_id, p.user_id, u.name FROM conversation_participants p
      JOIN member m ON m.organizationId = p.organization_id AND m.userId = p.user_id
      JOIN user u ON u.id = p.user_id WHERE p.role = 'member' AND p.conversation_id IN (SELECT value FROM json_each(?)) ORDER BY p.created_at, p.user_id`, [d1JsonStringSet(teamIds)]) : [],
  ])
  return rows.map(row => {
    const message = row.latest_message_id ? latest.get(row.latest_message_id) : undefined
    if (row.latest_message_id && !message) throw new Error(`The latest message of conversation ${row.id} could not be read`)
    const when = row.record_unit === 'nights' && row.record_starts_at && row.record_stored_ends_at && row.record_timezone
      ? stayWhen(bookingDay(row.record_starts_at, row.record_timezone), bookingDay(row.record_stored_ends_at, row.record_timezone), now, row.time_zone)
      : row.record_starts_at ? `${calendarDate(localDateKey(row.record_starts_at, row.time_zone))}, ${clockTime(row.record_starts_at, row.time_zone)}` : null
    const time = listTime(message ? message.sentAt : row.created_at, row.time_zone, now)
    if (row.kind === 'team') {
      const others = people.filter(person => person.conversation_id === row.id && person.user_id !== opts.userId).map(person => person.name)
      const title = row.name ?? row.record_title ?? (others.length ? others.join(', ') : 'You')
      return {
        id: row.id, ...opts.includeSortKey && { last_message_at: row.last_message_at }, kind: 'team', title, avatar_initial: initial(title), channel: 'direct',
        home: row.record_unit === 'nights' ? row.record_title : row.location_title, when,
        preview: message ? messagePreview(message.text, message.photos) : '',
        preview_from: message ? message.actorUserId === opts.userId ? 'You' : message.actorName ? firstName(message.actorName) : 'KrabiClaw' : null,
        time, unread: row.unread === 1,
      } satisfies InboxRow
    }
    const request = parseGuestRequest(row)
    const support = row.support === 1
    const guestName = conversationGuestName(request, support, row.reply_channel === 'airbnb')
    const shownName = opts.buyerAudience ? row.organization_name : guestName
    const traveler = opts.buyerAudience && row.user_id !== opts.userId
    const inquiry = request.kind === 'booking' ? request.payload.inquiry : undefined
    return {
      id: row.id,
      ...opts.includeSortKey && { last_message_at: row.last_message_at },
      kind: support ? 'support' : 'guest',
      title: shownName,
      avatar_initial: initial(shownName),
      channel: row.reply_channel === 'airbnb' ? 'airbnb' : 'direct',
      home: row.location_title,
      when: support || traveler ? null : when ?? (inquiry ? formatCalendarRange(inquiry.check_in_date, inquiry.check_out_date, 'en-US') : null),
      preview: message ? messagePreview(message.text, message.photos) : '',
      preview_from: message ? previewFrom(message, { guestName: row.reply_channel === 'airbnb' ? guestName : firstName(guestName), viewerId: opts.userId, primaryGuestId: row.user_id, buyer: Boolean(opts.buyerAudience), business: row.organization_name }) : null,
      time,
      unread: row.unread === 1,
    } satisfies InboxRow
  })
}

type LatestMessage = { authorKind: string; actorUserId: string | null; actorName: string | null; eventName: string | null; text: string | null; photos: number; sentAt: string }

/** The last message of each listed conversation: who sent it, its words and when. */
async function latestMessages(db: DbClient, ids: string[]): Promise<Map<string, LatestMessage>> {
  if (!ids.length) return new Map()
  const rows = await queryAll<{ id: string; author_kind: string; author_user_id: string | null; actor_name: string | null; event_name: string | null; body: string | null; provider_inserted_at: string | null; occurred_at: string; photos: number }>(db, `
    SELECT e.id, e.author_kind, e.author_user_id, u.name AS actor_name, e.event_name, e.body,
      json_extract(e.payload_json, '$.provider_inserted_at') AS provider_inserted_at, e.occurred_at,
      (SELECT COUNT(*) FROM media_placements mp WHERE mp.owner_type = 'message' AND mp.owner_id = e.id AND mp.slot = 'attachments' AND mp.status = 'active') AS photos
    FROM messages e LEFT JOIN user u ON u.id = e.author_user_id
    WHERE e.id IN (SELECT value FROM json_each(?))`, [d1JsonStringSet(ids)])
  return new Map(rows.map(row => [row.id, {
    authorKind: row.author_kind, actorUserId: row.author_user_id, actorName: row.actor_name, eventName: row.event_name,
    text: row.body,
    photos: row.photos,
    sentAt: row.provider_inserted_at ? providerInstant(row.provider_inserted_at) : row.occurred_at,
  }]))
}

/** "You", or the sender's first name, before the preview. */
function previewFrom(message: LatestMessage, context: { guestName: string; viewerId: string; primaryGuestId: string | null; buyer: boolean; business: string }): string {
  // The booking's own opening message is the guest's, as the conversation draws it.
  if (message.authorKind === 'guest' || message.eventName === OPENING_EVENT) {
    if (message.actorUserId === context.viewerId || (context.buyer && context.primaryGuestId === context.viewerId && message.actorUserId === null)) return 'You'
    if (message.actorUserId && message.actorUserId !== context.primaryGuestId && message.actorName) return firstName(message.actorName)
    return context.guestName
  }
  if (message.authorKind === 'krabiclaw' && message.eventName === MIRRORED_EVENT) return 'Airbnb Support'
  if (context.buyer) return context.business
  if (message.authorKind === 'member' && message.actorUserId && message.actorUserId !== context.viewerId) {
    if (!message.actorName) throw new Error('A team reply has no author name')
    return firstName(message.actorName)
  }
  return message.authorKind === 'krabiclaw' ? 'KrabiClaw' : 'You'
}

/**
 * Unread conversations in the Current mailbox per list kind, for the filter
 * menu (All, Guests, Airbnb Support, Team) and the nav count: the list's own
 * scope and the one unread statement, so a count never disagrees with a row.
 */
export async function countUnreadConversations(db: DbClient, organizationId: string, opts: ListGuestThreadsOptions): Promise<UnreadCounts> {
  const scope = await inboxScope(organizationId, { ...opts, conversationIds: undefined, kind: null, q: null, mailbox: 'current', unreadOnly: false }, new Date().toISOString())
  const unread = unreadSql('gt', opts.userId)
  const rows = await queryAll<{ list_kind: 'guests' | 'support' | 'team'; count: number }>(db, `
    SELECT CASE WHEN gt.kind = 'team' THEN 'team' WHEN ${SUPPORT_CONVERSATION_SQL('gt')} THEN 'support' ELSE 'guests' END AS list_kind, COUNT(*) AS count
      FROM ${scope.from}
     WHERE ${scope.where} AND ${unread.sql}
     GROUP BY 1`, [...scope.params, ...unread.params])
  const count = (kind: 'guests' | 'support' | 'team') => Number(rows.find(row => row.list_kind === kind)?.count ?? 0)
  return { all: count('guests') + count('support') + count('team'), guests: count('guests'), support: count('support'), team: count('team') }
}

/** Unread conversations a guest has with every business, in their own inbox's Current mailbox. */
export async function countUnreadAsGuest(db: DbClient, userId: string): Promise<number> {
  const scope = await inboxScope(null, { userId, buyerAudience: true, mailbox: 'current' }, new Date().toISOString())
  const unread = unreadSql('gt', userId)
  const row = await queryFirst<{ count: number }>(db, `SELECT COUNT(*) AS count FROM ${scope.from} WHERE ${scope.where} AND ${unread.sql}`, [...scope.params, ...unread.params])
  if (!row) throw new Error('Unread conversations as a guest could not be counted')
  return Number(row.count)
}

/**
 * The app icon's number: the unread conversations a person sees in every
 * organization they belong to, and their own as a guest. Each is the same
 * count the inbox's filter menu shows.
 */
export async function unreadBadge(db: DbClient, userId: string): Promise<number> {
  const guest = await inboxScope(null, { userId, buyerAudience: true, mailbox: 'current' }, new Date().toISOString())
  const current = mailboxWhere('current', new Date().toISOString())
  const memberAccess = participantGuard('gt', userId, 'member')
  const unread = unreadSql('gt', userId)
  const row = await queryFirst<{ count: number }>(db, `
    SELECT (SELECT COUNT(*) FROM ${guest.from} WHERE ${guest.where} AND ${unread.sql})
      + (SELECT COUNT(*) FROM ${guest.from}
        WHERE ${memberAccess.sql} AND ${HAS_CONVERSATION_SQL}${current.sql} AND ${unread.sql}) AS count`,
    [...guest.params, ...unread.params, userId, ...memberAccess.params, ...current.params, ...unread.params])
  if (!row) throw new Error('Unread conversations for the app badge could not be counted')
  return Number(row.count)
}

/** Which of these conversations the viewer has unread, by the one statement. */
export { listUnreadIds }

// The follow-up belongs to the guest's booking and moves with it.
function bookingFollowUpQueries(conversationId: string, now: string): BatchQuery[] {
  const dueAt = "strftime('%Y-%m-%dT%H:%M:%fZ', br.ends_at, '+1 day')"
  return [{
    query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = tasks.version + 1, updated_at = ?
      FROM ${BOOKING_RECORDS_SQL} br WHERE br.conversation_id = ? AND br.unit = 'slot' AND (br.status <> 'confirmed' OR br.assigned_member_id IS NULL) AND tasks.status = 'open'
        AND tasks.subject_type = 'booking' AND tasks.subject_id = br.id AND tasks.kind = 'consultation_follow_up'`,
    params: [now, now, conversationId],
  }, {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, br.organization_id, 'consultation_follow_up', 'booking', br.id, br.product_id, br.location_id, br.assigned_member_id, ${dueAt}, ${dueAt}, br.timezone, 'open', 'consultation_follow_up:' || br.id, 1, ?, ?
        FROM ${BOOKING_RECORDS_SQL} br
       WHERE br.conversation_id = ? AND br.unit = 'slot' AND br.status = 'confirmed' AND br.assigned_member_id IS NOT NULL AND ${dueAt} > ?
      ON CONFLICT (dedupe_key) DO UPDATE SET status = CASE WHEN tasks.status = 'cancelled' THEN 'open' ELSE tasks.status END, closed_at = CASE WHEN tasks.status = 'cancelled' THEN NULL ELSE tasks.closed_at END,
        product_id = excluded.product_id, location_id = excluded.location_id, timezone = excluded.timezone,
        starts_at = excluded.starts_at, due_at = excluded.due_at, assigned_member_id = excluded.assigned_member_id, version = tasks.version + 1, updated_at = excluded.updated_at
        WHERE tasks.status = 'cancelled' OR (tasks.status = 'open' AND (tasks.starts_at IS NOT excluded.starts_at
          OR tasks.assigned_member_id IS NOT excluded.assigned_member_id OR tasks.product_id IS NOT excluded.product_id
          OR tasks.location_id IS NOT excluded.location_id OR tasks.timezone IS NOT excluded.timezone))`,
    params: [crypto.randomUUID(), now, now, conversationId, now],
  }]
}

/** A successful manual reply can resolve a failed scheduled delivery for the same booking. */
export function resolveScheduledDeliveryFailure(message: BatchQuery, now: string): BatchQuery {
  return {
    query: `UPDATE tasks SET status = 'done', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE kind = 'message_delivery' AND status = 'open' AND subject_type = 'scheduled_guest_message' AND subject_id IN (
        SELECT m.id FROM messages reply JOIN conversations c ON c.id = reply.conversation_id AND c.kind = 'booking'
        JOIN scheduled_guest_messages m ON m.booking_id = c.booking_id AND m.organization_id = c.organization_id
        WHERE reply.id = (${message.query}) AND ${successfulBusinessReplySql('reply')} AND reply.occurred_at > m.updated_at)`,
    params: [now, now, ...(message.params ?? [])],
  }
}

/** Booking mutations also reconcile approval, follow-ups, session prep and change requests. */
export function conversationTaskQueries(conversationId: string, now: string, previousSessionId: string | null = null): BatchQuery[] {
  return [{
    // A booking waiting for the business's approval is work until it is approved, declined or cancelled.
    query: `UPDATE tasks SET status = CASE WHEN b.status = 'cancelled' THEN 'cancelled' ELSE 'done' END, closed_at = ?, version = tasks.version + 1, updated_at = ?,
        closed_by_user_id = (SELECT e.author_user_id FROM messages e WHERE e.conversation_id = c.id AND e.event_name IN ('booking.confirm', 'booking.reject', 'booking.cancel') ORDER BY e.sequence DESC LIMIT 1)
      FROM conversations c JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
      WHERE c.id = ? AND tasks.dedupe_key = 'booking_review:' || b.id AND tasks.status = 'open'
        AND (b.status <> 'pending' OR ${stayRequestPayBySql('c.id')} IS NOT NULL)`,
    params: [now, now, conversationId],
  }, {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, b.organization_id, 'booking_review', 'booking', b.id, b.product_id, b.location_id,
        CASE WHEN b.product_session_id IS NULL THEN NULL ELSE bc.assigned_member_id END,
        CASE WHEN ${stayRequestRespondBySql('b')} IS NOT NULL THEN b.created_at ELSE b.starts_at END,
        b.timezone, 'open', 'booking_review:' || b.id, 1, ?, ?
        FROM conversations c
        JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
        JOIN product_booking_configs bc ON bc.organization_id = b.organization_id AND bc.product_id = b.product_id
       WHERE c.id = ? AND c.kind = 'booking' AND b.status = 'pending' AND ${stayRequestPayBySql('c.id')} IS NULL
      ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [crypto.randomUUID(), now, now, conversationId],
  }, ...bookingFollowUpQueries(conversationId, now), ...sessionPrepTaskQueries({
    query: `SELECT b.product_session_id FROM conversations c
      JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id WHERE c.id = ? AND c.kind = 'booking'
      UNION SELECT s.id FROM product_sessions s JOIN conversations c ON c.organization_id = s.organization_id WHERE c.id = ? AND s.id = ?`,
    params: [conversationId, conversationId, previousSessionId],
  }, now), {
    // A change is answered, or replaced by a newer proposal or a move: its task is done, by whoever answered or replaced it.
    query: `UPDATE tasks SET status = 'done', closed_at = ?, version = tasks.version + 1, updated_at = ?,
        closed_by_user_id = (SELECT answer.author_user_id FROM messages answer WHERE answer.conversation_id = p.conversation_id
          AND (answer.dedupe_key = 'booking-change-decision:' || p.id OR (answer.event_name IN ('booking_change.requested', 'booking_change.moved') AND answer.sequence > p.sequence))
          ORDER BY answer.sequence LIMIT 1)
      FROM messages p
      WHERE tasks.kind = 'booking_change' AND tasks.status = 'open' AND tasks.dedupe_key = 'booking_change:' || p.id
        AND p.conversation_id = ? AND p.event_name = 'booking_change.requested' AND ${CHANGE_ANSWERED_SQL}`,
    params: [now, now, conversationId],
  }, {
    // A change that needs the business: one the guest asked for (now), or a business proposal on a booking
    // (from when it expires unanswered).
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, starts_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), r.organization_id, 'booking_change', 'booking', record.id, record.product_id, r.location_id,
          CASE WHEN p.event_name = 'booking_change.requested' AND NOT (${GUEST_CAUSED_SQL('p', 'r')})
            THEN min(strftime('%Y-%m-%dT%H:%M:%fZ', p.occurred_at, '+7 days'), ${BOOKING_ENDS_SQL('record')}) END,
          record.timezone, 'open', 'booking_change:' || p.id, 1, ?, ?
        FROM conversations r
        JOIN bookings record ON record.id = r.booking_id AND record.organization_id = r.organization_id
        JOIN messages p ON p.conversation_id = r.id
       WHERE r.id = ? AND p.event_name = 'booking_change.requested' AND NOT ${CHANGE_ANSWERED_SQL}
           -- A stay's change proposed by the business waits on the guest's channel, not on the business.
           AND (${GUEST_CAUSED_SQL('p', 'r')} OR record.product_session_id IS NOT NULL)
      ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [now, now, conversationId],
  }]
}

/** KrabiClaw's event `message` was caused by the conversation `conversation`'s guest: their account, or their channel (a channel guest's event names the guest's account too). */
const GUEST_CAUSED_SQL = (message: string, conversation: string) => `${message}.author_user_id IS ${conversation}.user_id AND ${conversation}.user_id IS NOT NULL`

/** A change proposal (message `p`) has its answer, or a newer proposal or a move replaced it. */
const CHANGE_ANSWERED_SQL = `(EXISTS (SELECT 1 FROM messages answer WHERE answer.conversation_id = p.conversation_id AND answer.dedupe_key = 'booking-change-decision:' || p.id)
  OR EXISTS (SELECT 1 FROM messages later WHERE later.conversation_id = p.conversation_id AND later.event_name IN ('booking_change.requested', 'booking_change.moved') AND later.sequence > p.sequence))`

/** The conversation's tasks follow its messages, after a message lands outside a batch that already carried them. */
export async function reconcileConversationTasks(db: DbClient, conversationId: string): Promise<void> {
  await executeBatch(db, conversationTaskQueries(conversationId, new Date().toISOString()), { operation: 'Reconcile conversation tasks' })
}

/**
 * Archive or unarchive a conversation for one person (D2): it leaves their
 * Current list for Past, and a new message from someone else brings it back.
 * A conversation the quiet rule keeps in Past cannot be brought back by
 * unarchiving, and a blocked one is in Blocked, not in either.
 */
export async function archiveConversation(db: DbClient, input: { organizationId: string; conversationId: string; userId: string; archived: boolean; guard?: ConversationGuard }): Promise<{ archived: boolean }> {
  const now = new Date().toISOString()
  const rule = pastByRuleSql(now)
  const row = await queryFirst<{ blocked_at: string | null; past_by_rule: number }>(db, `
    SELECT gt.blocked_at, ${rule.sql} AS past_by_rule FROM conversations gt${operationalRecordSql()}
     WHERE gt.organization_id = ? AND gt.id = ?`, [...rule.params, input.organizationId, input.conversationId])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Conversation not found', data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
  if (row.blocked_at !== null) throw new HTTPError({ statusCode: 409, message: 'A blocked guest’s conversation is in Blocked; unblock it first', data: { code: 'INVALID_TRANSITION', field: 'archived' } })
  if (!input.archived && row.past_by_rule === 1) throw new HTTPError({ statusCode: 409, message: 'This conversation is past because it has been quiet for 30 days', data: { code: 'INVALID_TRANSITION', field: 'archived' } })
  const [written] = await executeBatch(db, [archiveQuery({ ...input, now })], { operation: input.archived ? 'Archive conversation' : 'Unarchive conversation' })
  if (!written?.meta?.changes) conversationAccessDenied()
  return { archived: input.archived }
}
