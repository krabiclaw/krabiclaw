import { HTTPError } from 'nitro'
import { BOOKING_ENDS_SQL, BOOKING_RECORDS_SQL, bookingDay, parseGuestRequest, participantLabel } from '~/server/domain/requests'
import {
  CURRENT_GUEST_SQL, MEMBER_REPLY_EVENT, MIRRORED_EVENT, OPENING_EVENT, SUPPORT_CONVERSATION_SQL,
  archiveQuery, archiveReplyTaskQuery, conversationAccessSql, guestVisibleSql, listUnreadIds, messageHasContentSql, unreadSql, type UnreadCounts,
} from '~/server/domain/conversations'
import { messagePreview } from './attachments'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import type { CloudflareEnv } from '~/server/utils/auth'
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
export function successfulBusinessReplySql(reply: string): string {
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

function providerTimeSql(entry: string): string { return `json_extract(${entry}.payload_json, '$.provider_inserted_at')` }
/** An explicit offset is honored; a zoneless Channex time is UTC (read 2026-11-08: every live mirror lands 2-6 s after its provider time). */
function providerZoneSql(time: string): string {
  return `CASE WHEN substr(${time}, -1) = 'Z' THEN 'Z' WHEN substr(${time}, -6, 1) IN ('+', '-') THEN substr(${time}, -6) ELSE 'Z' END`
}

/** One UTC clock for provider and local times, keeping the provider's microseconds for ordering. */
function providerClockSql(time: string): string {
  const zoneLength = `(CASE WHEN substr(${time}, -1) = 'Z' THEN 1 WHEN substr(${time}, -6, 1) IN ('+', '-') THEN 6 ELSE 0 END)`
  const fraction = `substr((CASE WHEN substr(${time}, 20, 1) = '.' THEN substr(${time}, 21, length(${time}) - 20 - ${zoneLength}) ELSE '' END) || '000000000', 1, 9)`
  return `(strftime('%Y-%m-%dT%H:%M:%S', substr(${time}, 1, 19) || ${providerZoneSql(time)}) || '.' || ${fraction})`
}

/** The resource's original time decides whether a late-imported reply follows the guest, not its local append sequence. */
function mirroredAfterSql(reply: string, guestEntry: string): string {
  const guestTime = `(CASE WHEN ${guestEntry}.event_name = '${MIRRORED_EVENT}' AND ${guestEntry}.channel = 'airbnb' THEN ${providerTimeSql(guestEntry)} ELSE ${guestEntry}.occurred_at END)`
  return `${providerClockSql(providerTimeSql(reply))} > ${providerClockSql(guestTime)}`
}

/** A specific business response follows this message by causal local order or original provider chronology. */
export function businessReplyFollowsSql(reply: string, guestEntry: string): string {
  return `((${reply}.event_name = '${MEMBER_REPLY_EVENT}' AND ${reply}.sequence > ${guestEntry}.sequence)
    OR (${reply}.event_name = '${MIRRORED_EVENT}' AND ${mirroredAfterSql(reply, guestEntry)}))`
}

/** When the guest asked: the provider's own instant for a mirrored message, otherwise when it was recorded. */
export function guestEntryAskedAtSql(entry: string): string {
  const time = providerTimeSql(entry)
  return `CASE WHEN ${entry}.event_name = '${MIRRORED_EVENT}' AND ${time} IS NOT NULL
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(${time}, 1, 19) || ${providerZoneSql(time)}) ELSE ${entry}.occurred_at END`
}

/** Whether a later successful business response to this guest message has been recorded. */
export function businessReplyAfterSql(guestEntry: string): string {
  return `EXISTS (
        SELECT 1 FROM messages reply
        WHERE reply.conversation_id = ${guestEntry}.conversation_id
          AND ${successfulBusinessReplySql('reply')}
          AND ${businessReplyFollowsSql('reply', guestEntry)}
      )`
}

/** The conversation has an open reply task (server/domain/tasks.ts). */
export const OPEN_REPLY_TASK_SQL = `EXISTS (SELECT 1 FROM tasks reply_task WHERE reply_task.kind = 'guest_reply' AND reply_task.subject_type = 'conversation' AND reply_task.subject_id = gt.id AND reply_task.status = 'open')`

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
  let where: string
  if (opts.buyerAudience) {
    where = `gt.user_id = ? AND ${CURRENT_GUEST_SQL('gt')}`
    params.push(opts.userId)
    if (organizationId) { where += ' AND gt.organization_id = ?'; params.push(organizationId) }
  } else {
    where = 'gt.organization_id = ?'
    params.push(organizationId!)
    // Without a resolved principal (a server read on the viewer's behalf), every guest conversation and the viewer's team ones.
    const access = opts.principal ? await conversationAccessSql('gt', opts.principal)
      : { sql: "(gt.kind IN ('contact', 'booking') OR me.user_id IS NOT NULL AND gt.kind = 'team')", params: [] }
    where += ` AND ${access.sql}`
    params.push(...access.params)
  }
  if (opts.locationId) { where += ' AND gt.location_id = ?'; params.push(opts.locationId) }
  if (opts.assignedMemberId) { where += ' AND op.assigned_member_id = ?'; params.push(opts.assignedMemberId) }
  if (opts.type) where += threadTypeWhere(opts.type)
  if (opts.needsReply) where += ` AND ${OPEN_REPLY_TASK_SQL}`
  if (opts.kind) where += kindWhere(opts.kind)
  if (opts.q) {
    const like = `%${opts.q.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`
    where += ` AND (LOWER(COALESCE(json_extract(gt.payload_json, '$.guest.name'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(gt.name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(json_extract(gt.payload_json, '$.participant.title'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(${threadLocationTitleSql(opts.buyerAudience)}, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM messages e WHERE e.conversation_id = gt.id
        AND (LOWER(COALESCE(e.body, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(json_extract(e.payload_json, '$.meta.name'), '')) LIKE ? ESCAPE '\\')))`
    params.push(like, like, like, like, like, like)
  }
  where += ` AND ${HAS_CONVERSATION_SQL}`
  const mailbox = mailboxWhere(opts.mailbox ?? null, now, opts.buyerAudience)
  where += mailbox.sql
  params.push(...mailbox.params)
  return { from, where, params }
}

type ListRow = {
  id: string
  kind: 'contact' | 'booking' | 'team'
  name: string | null
  created_at: string
  reply_channel: 'email' | 'airbnb'
  support: number
  organization_name: string
  location_title: string | null
  time_zone: string
  airbnb_name: string | null
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
  const visible = opts.buyerAudience ? ` AND ${guestVisibleSql('e')}` : ''
  const unread = unreadSql('gt', opts.userId)
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200))
  const rows = await queryAll<ListRow & Record<string, unknown>>(db, `
    SELECT gt.*, ${REPLY_CHANNEL_SQL} AS reply_channel, ${SUPPORT_CONVERSATION_SQL('gt')} AS support,
      o.name AS organization_name, ${threadLocationTitleSql(opts.buyerAudience)} AS location_title, COALESCE(bl.timezone, o.timezone) AS time_zone,
      (SELECT json_extract(e.payload_json, '$.meta.name') FROM messages e
        WHERE e.conversation_id = gt.id AND e.author_kind = 'guest' AND e.event_name = '${MIRRORED_EVENT}'
          AND json_extract(e.payload_json, '$.meta.name') IS NOT NULL ORDER BY e.sequence DESC LIMIT 1) AS airbnb_name,
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
      JOIN user u ON u.id = p.user_id WHERE p.conversation_id IN (SELECT value FROM json_each(?)) ORDER BY p.created_at, p.user_id`, [d1JsonStringSet(teamIds)]) : [],
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
        id: row.id, kind: 'team', guestName: title, avatarInitial: initial(title), channel: 'direct',
        home: row.record_unit === 'nights' ? row.record_title : row.location_title, when,
        preview: message ? messagePreview(message.text, message.photos) : '',
        previewFrom: message ? message.actorUserId === opts.userId ? 'You' : message.actorName ? firstName(message.actorName) : 'KrabiClaw' : null,
        time, unread: row.unread === 1,
      } satisfies InboxRow
    }
    const request = parseGuestRequest(row)
    const support = row.support === 1
    const recordedName = request.payload.guest.name ?? participantLabel(request)
    // Airbnb's first name from the guest's messages, else the booked guest's first name, else what the conversation was recorded as.
    const guestName = support ? 'Airbnb Support' : row.airbnb_name ?? (row.reply_channel === 'airbnb' && request.payload.guest.name ? firstName(request.payload.guest.name) : recordedName)
    const shownName = opts.buyerAudience ? row.organization_name : guestName
    const inquiry = request.kind === 'booking' ? request.payload.inquiry : undefined
    return {
      id: row.id,
      kind: support ? 'support' : 'guest',
      guestName: shownName,
      avatarInitial: initial(shownName),
      channel: row.reply_channel === 'airbnb' ? 'airbnb' : 'direct',
      home: row.location_title,
      when: support ? null : when ?? (inquiry ? formatCalendarRange(inquiry.check_in_date, inquiry.check_out_date, 'en-US') : null),
      preview: message ? messagePreview(message.text, message.photos) : '',
      previewFrom: message ? previewFrom(message, { guestName: row.reply_channel === 'airbnb' ? guestName : firstName(guestName), viewerId: opts.userId, buyer: Boolean(opts.buyerAudience), business: row.organization_name }) : null,
      time,
      unread: row.unread === 1,
    } satisfies InboxRow
  })
}

type LatestMessage = { authorKind: string; actorUserId: string | null; actorName: string | null; eventName: string | null; text: string | null; photos: number; sentAt: string }

/** The last message of each listed conversation: who sent it, its words (Airbnb's translation where there is one) and when. */
async function latestMessages(db: DbClient, ids: string[]): Promise<Map<string, LatestMessage>> {
  if (!ids.length) return new Map()
  const rows = await queryAll<{ id: string; author_kind: string; author_user_id: string | null; actor_name: string | null; event_name: string | null; body: string | null; translated: string | null; provider_inserted_at: string | null; occurred_at: string; photos: number }>(db, `
    SELECT e.id, e.author_kind, e.author_user_id, u.name AS actor_name, e.event_name, e.body,
      json_extract(e.payload_json, '$.meta.translated_message') AS translated,
      json_extract(e.payload_json, '$.provider_inserted_at') AS provider_inserted_at, e.occurred_at,
      (SELECT COUNT(*) FROM media_placements mp WHERE mp.owner_type = 'message' AND mp.owner_id = e.id AND mp.slot = 'attachments' AND mp.status = 'active') AS photos
    FROM messages e LEFT JOIN user u ON u.id = e.author_user_id
    WHERE e.id IN (SELECT value FROM json_each(?))`, [d1JsonStringSet(ids)])
  return new Map(rows.map(row => [row.id, {
    authorKind: row.author_kind, actorUserId: row.author_user_id, actorName: row.actor_name, eventName: row.event_name,
    text: row.author_kind === 'guest' && row.translated?.trim() ? row.translated : row.body,
    photos: row.photos,
    sentAt: row.provider_inserted_at ? providerInstant(row.provider_inserted_at) : row.occurred_at,
  }]))
}

/** "You", or the sender's first name, before the preview. */
function previewFrom(message: LatestMessage, context: { guestName: string; viewerId: string; buyer: boolean; business: string }): string {
  // The booking's own opening message is the guest's, as the conversation draws it.
  if (message.authorKind === 'guest' || message.eventName === OPENING_EVENT) return context.buyer ? 'You' : context.guestName
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
  const scope = await inboxScope(organizationId, { ...opts, kind: null, q: null, mailbox: 'current', unreadOnly: false }, new Date().toISOString())
  const unread = unreadSql('gt', opts.userId)
  const rows = await queryAll<{ list_kind: 'guests' | 'support' | 'team'; count: number }>(db, `
    SELECT CASE WHEN gt.kind = 'team' THEN 'team' WHEN ${SUPPORT_CONVERSATION_SQL('gt')} THEN 'support' ELSE 'guests' END AS list_kind, COUNT(*) AS count
      FROM ${scope.from} LEFT JOIN business_locations bl ON bl.id = gt.location_id
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
export async function unreadBadge(env: CloudflareEnv, db: DbClient, userId: string): Promise<number> {
  const memberships = await queryAll<{ organizationId: string; role: string }>(db, 'SELECT organizationId, role FROM member WHERE userId = ?', [userId])
  const counts = await Promise.all([
    ...memberships.map(membership => countUnreadConversations(db, membership.organizationId, {
      userId, principal: { organizationId: membership.organizationId, role: membership.role, userId },
    }).then(count => count.all)),
    countUnreadAsGuest(db, userId),
  ])
  return counts.reduce((sum, count) => sum + count, 0)
}

/** Which of these conversations the viewer has unread, by the one statement. */
export { listUnreadIds }

/** The guest message a reply task is about: a message the guest wrote. */
export const GUEST_QUESTION_SQL = `guest_entry.author_kind = 'guest'`
/** A cancelled booking answers what the guest asked before it, by when the guest asked it. */
export const CANCELLED_AFTER_SQL = `EXISTS (SELECT 1 FROM conversations asked_in JOIN bookings record ON record.id = asked_in.booking_id AND record.organization_id = asked_in.organization_id
  WHERE asked_in.id = guest_entry.conversation_id AND record.status = 'cancelled' AND record.cancelled_at >= ${guestEntryAskedAtSql('guest_entry')})`

/** Time passing changes no conversation, so a daily run closes what has aged out and opens any newer question behind it. */
export async function expireReplyTasks(db: DbClient, now: string): Promise<{ conversations: number }> {
  const rows = await queryAll<{ subject_id: string }>(db, `SELECT DISTINCT t.subject_id FROM tasks t
    JOIN messages guest_entry ON guest_entry.id = substr(t.dedupe_key, length('guest_reply:' || t.subject_id || ':') + 1)
    WHERE t.kind = 'guest_reply' AND t.subject_type = 'conversation' AND t.status = 'open' AND ${guestEntryAskedAtSql('guest_entry')} < ?`, [replyTaskCutoff(now)])
  // One conversation at a time; one that fails does not stop the rest, and every failure is reported.
  const failures: unknown[] = []
  for (const row of rows) {
    try {
      await executeBatch(db, conversationTaskQueries(row.subject_id, now), { operation: 'Expire reply tasks' })
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length) {
    const reasons = failures.map(cause => cause instanceof Error ? cause.message : String(cause)).join('; ')
    throw new AggregateError(failures, `${failures.length} of ${rows.length} conversations' reply tasks could not be expired: ${reasons}`)
  }
  return { conversations: rows.length }
}

/** A question nobody answered for this long is no longer anyone's work. */
const REPLY_TASK_EXPIRY_DAYS = 30
const replyTaskCutoff = (now: string) => new Date(Date.parse(now) - REPLY_TASK_EXPIRY_DAYS * 86_400_000).toISOString()

/**
 * A person's work around a visit they hold: preparing for its start and
 * following up the day after it ends, for any booked record with an assigned
 * member (an attorney's consultation, a guide's class). A visit nobody holds is
 * a Calendar commitment, not a task; a stay's work is its turnover. Both jobs
 * follow the record: they move with it, follow its member, and close if it is
 * cancelled or loses its member. The kind names are the shipped API's.
 */
const VISIT_JOBS = [
  { kind: 'consultation_prep', at: 'br.starts_at' },
  { kind: 'consultation_follow_up', at: "strftime('%Y-%m-%dT%H:%M:%fZ', br.ends_at, '+1 day')" },
] as const

function visitJobQueries(conversationId: string, now: string): BatchQuery[] {
  return [{
    query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = tasks.version + 1, updated_at = ?
      FROM ${BOOKING_RECORDS_SQL} br WHERE br.conversation_id = ? AND br.unit = 'slot' AND (br.status <> 'confirmed' OR br.assigned_member_id IS NULL) AND tasks.status = 'open'
        AND tasks.subject_type = 'booking' AND tasks.subject_id = br.id AND tasks.kind IN ('consultation_prep', 'consultation_follow_up')`,
    params: [now, now, conversationId],
  }, ...VISIT_JOBS.map(job => ({
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, br.organization_id, '${job.kind}', 'booking', br.id, br.product_id, br.location_id, br.assigned_member_id, ${job.at}, ${job.at}, br.timezone, 'open', '${job.kind}:' || br.id, 1, ?, ?
        FROM ${BOOKING_RECORDS_SQL} br
       WHERE br.conversation_id = ? AND br.unit = 'slot' AND br.status = 'confirmed' AND br.assigned_member_id IS NOT NULL AND ${job.at} > ?
      ON CONFLICT (dedupe_key) DO UPDATE SET status = CASE WHEN tasks.status = 'cancelled' THEN 'open' ELSE tasks.status END, closed_at = CASE WHEN tasks.status = 'cancelled' THEN NULL ELSE tasks.closed_at END,
        product_id = excluded.product_id, location_id = excluded.location_id, timezone = excluded.timezone,
        starts_at = excluded.starts_at, due_at = excluded.due_at, assigned_member_id = excluded.assigned_member_id, version = tasks.version + 1, updated_at = excluded.updated_at
        WHERE tasks.status = 'cancelled' OR (tasks.status = 'open' AND (tasks.starts_at IS NOT excluded.starts_at
          OR tasks.assigned_member_id IS NOT excluded.assigned_member_id OR tasks.product_id IS NOT excluded.product_id
          OR tasks.location_id IS NOT excluded.location_id OR tasks.timezone IS NOT excluded.timezone))`,
    params: [crypto.randomUUID(), now, now, conversationId, now],
  }))]
}

/**
 * The tasks (server/domain/tasks.ts) one guest conversation's messages make,
 * for the batch that changes it: the task for an answered question closes
 * (done, by whoever replied), a blocked conversation's closes (cancelled), a
 * question left unanswered for REPLY_TASK_EXPIRY_DAYS closes (cancelled), and
 * the first question still unanswered opens one — or reopens its task when a
 * reply turned out not to be delivered. A person's Dismiss (and an archive,
 * which dismisses) covers everything the guest had said by then; the guest's
 * next message opens a new task. A failed scheduled message the business has
 * since answered in person is done too. Bookings awaiting approval, changes
 * that need the business and a visit's prep and follow-up follow the booking.
 */
export function conversationTaskQueries(conversationId: string, now: string): BatchQuery[] {
  const entryOf = `substr(tasks.dedupe_key, length('guest_reply:' || tasks.subject_id || ':') + 1)`
  const unanswered = `guest_entry.id = ${entryOf} AND NOT ${businessReplyAfterSql('guest_entry')} AND NOT ${CANCELLED_AFTER_SQL}`
  return [{
    query: `UPDATE tasks SET status = CASE WHEN r.blocked_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM messages guest_entry WHERE ${unanswered}) THEN 'cancelled' ELSE 'done' END,
        closed_at = ?, version = tasks.version + 1, updated_at = ?,
        closed_by_user_id = CASE WHEN r.blocked_at IS NOT NULL THEN NULL ELSE (
          SELECT reply.author_user_id FROM messages reply JOIN messages guest_entry ON guest_entry.id = ${entryOf}
          WHERE reply.conversation_id = r.id AND ${successfulBusinessReplySql('reply')} AND reply.sequence > guest_entry.sequence ORDER BY reply.sequence LIMIT 1) END
      FROM conversations r
      WHERE tasks.kind = 'guest_reply' AND tasks.subject_type = 'conversation' AND tasks.subject_id = ? AND tasks.status = 'open' AND r.id = tasks.subject_id
        AND (r.blocked_at IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM messages guest_entry WHERE ${unanswered} AND ${guestEntryAskedAtSql('guest_entry')} >= ?))`,
    params: [now, now, conversationId, replyTaskCutoff(now)],
  }, {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, r.organization_id, 'guest_reply', 'conversation', r.id, (SELECT s.product_id FROM bookings s WHERE s.id = r.booking_id AND s.organization_id = r.organization_id AND s.product_session_id IS NULL),
        r.location_id, COALESCE(l.timezone, o.timezone), 'open', 'guest_reply:' || r.id || ':' || guest_entry.id, 1, ?, ?
        FROM conversations r JOIN organization o ON o.id = r.organization_id
        LEFT JOIN business_locations l ON l.organization_id = r.organization_id AND l.id = r.location_id
        JOIN messages guest_entry ON guest_entry.conversation_id = r.id
       WHERE r.id = ? AND r.kind IN ('contact', 'booking') AND r.blocked_at IS NULL AND ${GUEST_QUESTION_SQL}
         AND NOT ${businessReplyAfterSql('guest_entry')} AND NOT ${CANCELLED_AFTER_SQL}
         AND ${guestEntryAskedAtSql('guest_entry')} >= ?
         -- A person's Dismiss covers everything said by then; what the guest says next is work.
         AND NOT EXISTS (SELECT 1 FROM tasks skipped WHERE skipped.kind = 'guest_reply' AND skipped.subject_type = 'conversation' AND skipped.subject_id = r.id AND skipped.status = 'skipped'
           AND (skipped.closed_at > guest_entry.occurred_at OR skipped.dedupe_key = 'guest_reply:' || r.id || ':' || guest_entry.id))
         AND NOT EXISTS (SELECT 1 FROM tasks open_reply WHERE open_reply.kind = 'guest_reply' AND open_reply.subject_type = 'conversation' AND open_reply.subject_id = r.id AND open_reply.status = 'open')
       ORDER BY guest_entry.sequence LIMIT 1
      ON CONFLICT (dedupe_key) DO UPDATE SET status = 'open', closed_at = NULL, closed_by_user_id = NULL, version = tasks.version + 1, updated_at = excluded.updated_at
        WHERE tasks.status IN ('done', 'cancelled')`,
    params: [crypto.randomUUID(), now, now, conversationId, replyTaskCutoff(now)],
  }, {
    query: `UPDATE tasks SET status = 'done', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE kind = 'message_delivery' AND status = 'open' AND subject_type = 'scheduled_guest_message' AND subject_id IN (
        SELECT m.id FROM scheduled_guest_messages m JOIN conversations c ON c.booking_id = m.booking_id AND c.kind = 'booking'
         WHERE c.id = ? AND EXISTS (
          SELECT 1 FROM messages reply WHERE reply.conversation_id = c.id AND ${successfulBusinessReplySql('reply')} AND reply.occurred_at > m.updated_at))`,
    params: [now, now, conversationId],
  }, {
    // A booking waiting for the business's approval is work until it is approved, declined or cancelled.
    query: `UPDATE tasks SET status = CASE WHEN b.status = 'confirmed' THEN 'done' ELSE 'cancelled' END, closed_at = ?, version = tasks.version + 1, updated_at = ?,
        closed_by_user_id = (SELECT e.author_user_id FROM messages e WHERE e.conversation_id = c.id AND e.event_name IN ('booking.confirm', 'booking.reject', 'booking.cancel') ORDER BY e.sequence DESC LIMIT 1)
      FROM conversations c JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
      WHERE c.id = ? AND tasks.dedupe_key = 'booking_review:' || b.id AND tasks.status = 'open' AND b.status <> 'pending'`,
    params: [now, now, conversationId],
  }, {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, b.organization_id, 'booking_review', 'booking', b.id, b.product_id, b.location_id, bc.assigned_member_id, b.starts_at, b.timezone, 'open', 'booking_review:' || b.id, 1, ?, ?
        FROM conversations c
        JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
        JOIN product_booking_configs bc ON bc.organization_id = b.organization_id AND bc.product_id = b.product_id
       WHERE c.id = ? AND c.kind = 'booking' AND b.status = 'pending'
      ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [crypto.randomUUID(), now, now, conversationId],
  }, ...visitJobQueries(conversationId, now), {
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
 * Archiving a guest conversation also dismisses its open reply task. A
 * conversation the quiet rule keeps in Past cannot be brought back by
 * unarchiving, and a blocked one is in Blocked, not in either.
 */
export async function archiveConversation(db: DbClient, input: { organizationId: string; conversationId: string; userId: string; archived: boolean }): Promise<{ archived: boolean }> {
  const now = new Date().toISOString()
  const rule = pastByRuleSql(now)
  const row = await queryFirst<{ kind: string; blocked_at: string | null; past_by_rule: number }>(db, `
    SELECT gt.kind, gt.blocked_at, ${rule.sql} AS past_by_rule FROM conversations gt${operationalRecordSql()}
     WHERE gt.organization_id = ? AND gt.id = ?`, [...rule.params, input.organizationId, input.conversationId])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Conversation not found', data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
  if (row.blocked_at !== null) throw new HTTPError({ statusCode: 409, message: 'A blocked guest’s conversation is in Blocked; unblock it first', data: { code: 'INVALID_TRANSITION', field: 'archived' } })
  if (!input.archived && row.past_by_rule === 1) throw new HTTPError({ statusCode: 409, message: 'This conversation is past because it has been quiet for 30 days', data: { code: 'INVALID_TRANSITION', field: 'archived' } })
  await executeBatch(db, [
    archiveQuery({ ...input, now }),
    ...(input.archived && row.kind !== 'team' ? [archiveReplyTaskQuery({ conversationId: input.conversationId, userId: input.userId, now })] : []),
  ], { operation: input.archived ? 'Archive conversation' : 'Unarchive conversation' })
  return { archived: input.archived }
}
