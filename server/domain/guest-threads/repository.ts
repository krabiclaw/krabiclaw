import { guestThreadConversationStateSql } from './booking-change-state'
import { REQUEST_CURRENT_BUYER_SQL, STAY_THREAD_ENDS_SQL, STAY_THREAD_STARTS_SQL, stayPreview, parseGuestRequest, participantLabel } from '~/server/domain/requests'
import { BUYER_UNREAD_THREAD_SQL, buyerUnreadThreadParams } from './entries'
import { messagePreview } from './attachments'
import { execute, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { assignedGuestThreadScope, roleAllows, assertRoleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import type {
  ConversationState,
  GuestThreadListItemViewModel,
  GuestThreadRow,
  InboxRow,
  InboxUnreadCounts,
  ListGuestThreadsOptions,
} from './types'
import { calendarDate, clockTime, firstName, initial, listTime, localDateKey, providerInstant, stayWhen } from './presentation'
import { formatCalendarRange } from '~/utils/timezone'
import { formatOperationalStatusLabel, formatThreadWhenLabel } from './status-labels'
import { resolveGuestThreadMailbox, type GuestThreadMailbox } from './mailbox'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { HTTPError } from 'nitro'

const SOURCE_GUEST_NAME_SQL = "json_extract(gt.payload_json, '$.guest.name')"
const REPLY_CHANNEL_SQL = "CASE WHEN EXISTS (SELECT 1 FROM channel_threads ct WHERE ct.request_id = gt.id AND ct.organization_id = gt.organization_id) OR EXISTS (SELECT 1 FROM stays st WHERE st.request_id = gt.id AND st.organization_id = gt.organization_id AND st.owner = 'channel') THEN 'airbnb' ELSE 'email' END"

/** No reply from the business after this guest entry has reached the guest: stored on the web or accepted for delivery. */
function answeredAfterSql(guestEntry: string): string {
  return `EXISTS (
        SELECT 1 FROM activity_entries reply
        WHERE reply.request_id = ${guestEntry}.request_id
          AND reply.kind = 'message' AND reply.actor_kind = 'member'
          AND reply.event_name = 'thread.member_reply' AND reply.sequence > ${guestEntry}.sequence
          AND (reply.channel = 'web' OR EXISTS (
            SELECT 1 FROM guest_thread_deliveries delivery
            WHERE delivery.entry_id = reply.id AND delivery.status IN ('accepted', 'sent', 'delivered', 'read')
          ))
      )`
}

function unansweredGuestMessagesSql(threadId: string, afterCancellation = false): string {
  return `EXISTS (
    SELECT 1 FROM activity_entries guest_message
    WHERE guest_message.request_id = ${threadId}
      AND guest_message.kind = 'message' AND guest_message.actor_kind = 'guest'
      ${afterCancellation ? `AND NOT EXISTS (
        SELECT 1 FROM activity_entries cancelled
        WHERE cancelled.request_id = guest_message.request_id AND cancelled.kind = 'operation'
          AND cancelled.event_name IN ('booking.cancel', 'booking.reject', 'reservation.cancel', 'reservation.reject')
          AND json_extract(cancelled.payload_json, '$.afterStatus') = 'cancelled'
          AND cancelled.sequence >= guest_message.sequence
      )` : ''}
      AND NOT ${answeredAfterSql('guest_message')}
  )`
}

/**
 * When the guest last said something the business has not answered: their
 * latest message, or a contact form they submitted, with no delivered reply
 * after it. A thread absent from the result has nothing unanswered.
 */
export async function latestUnansweredGuestEntryTimes(db: DbClient, organizationId: string, threadIds: readonly string[]): Promise<Map<string, string>> {
  const times = new Map<string, string>()
  for (let index = 0; index < threadIds.length; index += 200) {
    const rows = await queryAll<{ request_id: string; occurred_at: string }>(db, `
      SELECT guest_entry.request_id, MAX(guest_entry.occurred_at) AS occurred_at
        FROM activity_entries guest_entry JOIN requests r ON r.id = guest_entry.request_id AND r.organization_id = ?
       WHERE guest_entry.request_id IN (SELECT value FROM json_each(?)) AND guest_entry.actor_kind = 'guest'
         AND (guest_entry.kind = 'message' OR (guest_entry.kind = 'submission' AND r.kind = 'contact'))
         AND NOT ${answeredAfterSql('guest_entry')}
       GROUP BY guest_entry.request_id`, [organizationId, d1JsonStringSet(threadIds.slice(index, index + 200))])
    for (const row of rows) times.set(row.request_id, row.occurred_at)
  }
  return times
}

// Old guest cancellations left the request open. The cancellation ends that
// review task; only an unanswered message after its ledger fact reopens work.
const CANCELLED_ATTENTION_SQL = `(gt.kind NOT IN ('booking', 'reservation') OR op.status IS NOT 'cancelled' OR ${unansweredGuestMessagesSql('gt.id', true)})`

async function assignedThreadScope(principal?: MemberAccessPrincipal | null) {
  if (!principal || await roleAllows({ ...principal, permissions: { operations: ['read'] } })) return { sql: '', params: [] as string[] }
  await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
  const scope = assignedGuestThreadScope('gt', principal.userId)
  return { sql: ` AND ${scope.sql}`, params: scope.params }
}
/**
 * The operational record a thread refers to.
 *
 * A thread carries no time, party size or status of its own any more, so the
 * inbox reads them from the booking or reservation that links back to it. A
 * thread with no record yields NULLs, and the surface says the thread has no
 * booking rather than printing a fabricated slot.
 */
const OPERATIONAL_RECORDS_SQL = `(
    SELECT b.request_id, b.status, b.party_size, s.starts_at, s.ends_at, s.timezone, NULL AS check_in_date, NULL AS check_out_date, b.assigned_member_id, b.product_id, NULL AS stay_channel
      FROM bookings b JOIN product_sessions s ON s.id = b.product_session_id
     WHERE b.request_id IS NOT NULL
    UNION ALL
    SELECT r.request_id, r.status, r.party_size, r.starts_at, r.ends_at, r.timezone, NULL, NULL, NULL, NULL, NULL
      FROM reservations r WHERE r.request_id IS NOT NULL
    UNION ALL
    SELECT st.request_id, st.status, st.adults + st.children, ${STAY_THREAD_STARTS_SQL('st')}, ${STAY_THREAD_ENDS_SQL('st')}, l.timezone, st.check_in_date, st.check_out_date, c.assigned_member_id, st.product_id, st.channel
      FROM stays st
      JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE st.request_id IS NOT NULL
  )`
const OPERATIONAL_RECORD_SQL = `
  LEFT JOIN ${OPERATIONAL_RECORDS_SQL} op ON op.request_id = gt.id`

/**
 * `resolveGuestThreadMailbox`, said to the database. Current is not archived
 * and not ended; Past is archived or ended. The occurrence's END decides, so a
 * reservation stays Current while it is being served, and a thread with no
 * occurrence is Current until someone archives it. A blocked guest's thread is
 * in Blocked only, and a list with no mailbox leaves it out.
 */
function mailboxWhere(mailbox: GuestThreadMailbox | null, now: string, buyerAudience=false): { sql: string; params: string[] } {
  if (buyerAudience) {
    if (mailbox === null) return { sql: '', params: [] }
    return mailbox === 'current' ? {sql:' AND (op.ends_at IS NULL OR op.ends_at >= ?)',params:[now]} : {sql:' AND op.ends_at < ?',params:[now]}
  }
  if (mailbox === 'blocked') return { sql: ' AND gt.blocked_at IS NOT NULL', params: [] }
  if (mailbox === null) return { sql: ' AND gt.blocked_at IS NULL', params: [] }
  return mailbox === 'current'
    ? { sql: ' AND gt.blocked_at IS NULL AND gt.archived_at IS NULL AND (op.ends_at IS NULL OR op.ends_at >= ?)', params: [now] }
    : { sql: ' AND gt.blocked_at IS NULL AND (gt.archived_at IS NOT NULL OR op.ends_at < ?)', params: [now] }
}

function mailboxFields(row: { archived_at: string | null; blocked_at: string | null; record_ends_at: string | null }, now: string, buyerAudience=false) {
  const state = resolveGuestThreadMailbox(row, row.record_ends_at === null ? null : { ends_at: row.record_ends_at }, now, buyerAudience?'buyer':'member')
  return {
    mailbox: state.mailbox,
    manuallyArchived: state.manuallyArchived,
    canArchive: state.canArchive,
    canUnarchive: state.canUnarchive,
  }
}

// The guest's own words where there are any. The booking line is composed in
// TypeScript instead, because it has to read in the record's timezone and SQL
// can only concatenate the stored UTC instant.
const SOURCE_PREVIEW_SQL = `SUBSTR(CASE WHEN gt.kind = 'contact' THEN json_extract(gt.payload_json, '$.message') ELSE NULLIF(TRIM(json_extract(gt.payload_json, '$.notes')), '') END, 1, 160)`

const SOURCE_PREVIEW_COLUMNS = `op.starts_at AS record_starts_at, op.ends_at AS record_ends_at, op.timezone AS record_timezone, op.party_size AS record_party_size, op.assigned_member_id,
      op.product_id AS record_product_id, op.stay_channel, (SELECT ct.product_id FROM channel_threads ct WHERE ct.organization_id = gt.organization_id AND ct.request_id = gt.id) AS channel_product_id,
      op.check_in_date AS record_check_in_date, op.check_out_date AS record_check_out_date,
      json_extract(gt.payload_json, '$.party_size_is_minimum') AS party_size_is_minimum`

/*
  The picture the row leads with: the place the thread belongs to. A thread at
  a location takes that location's social sharing image — the still that
  stands for the place everywhere it is shared, where its hero may be a video; a thread that came to the business
  itself — a contact form with no location — takes the business's logo, the
  same picture the menu's switcher shows for it. A place with neither has no
  picture, and the row draws its own placeholder rather than borrowing another
  location's.
*/
const PLACE_IMAGE_SQL = `
  LEFT JOIN media_placements mp_hero ON mp_hero.owner_type = 'business_location' AND mp_hero.owner_id = gt.location_id
    AND mp_hero.slot = 'social_card' AND mp_hero.status = 'active'
  LEFT JOIN media_assets ma_hero ON ma_hero.id = mp_hero.asset_id AND ma_hero.status = 'active'
  LEFT JOIN media_placements mp_logo ON gt.location_id IS NULL AND mp_logo.owner_type = 'organization' AND mp_logo.owner_id = gt.organization_id
    AND mp_logo.slot = 'logo' AND mp_logo.status = 'active'
  LEFT JOIN media_assets ma_logo ON ma_logo.id = mp_logo.asset_id AND ma_logo.status = 'active'`

const PLACE_IMAGE_COLUMNS = `COALESCE(ma_hero.kind, ma_logo.kind) AS place_image_kind,
      COALESCE(ma_hero.thumbnail_url, ma_logo.thumbnail_url) AS place_image_thumbnail_url,
      COALESCE(ma_hero.public_url, ma_logo.public_url) AS place_image_public_url,
      ma_hero.id IS NULL AND ma_logo.id IS NOT NULL AND COALESCE(json_extract(mp_logo.presentation_json, '$.shape'), 'original') = 'original' AS place_image_whole`

/** A stay's nights, read from its dates; it has no start time to localize. */
function stayRecordLabel(row: { record_check_in_date: string | null; record_check_out_date: string | null; record_party_size: number | null }): string | null {
  if (!row.record_check_in_date || !row.record_check_out_date || row.record_party_size === null) return null
  return stayPreview({ check_in_date: row.record_check_in_date, check_out_date: row.record_check_out_date, party_size: row.record_party_size })
}

function sourcePreviewText(row: {
  source_preview: string | null
  record_starts_at: string | null
  record_timezone: string | null
  record_party_size: number | null
  record_check_in_date: string | null
  record_check_out_date: string | null
  party_size_is_minimum: unknown
}): string | null {
  if (row.source_preview) return row.source_preview
  if (row.record_check_in_date) return stayRecordLabel(row)
  if (!row.record_starts_at || !row.record_timezone || row.record_party_size === null) return null
  const when = formatThreadWhenLabel(row.record_starts_at, row.record_timezone)
  const size = `${row.record_party_size}${row.party_size_is_minimum ? '+' : ''}`
  return `${when} - ${size} ${size === '1' ? 'guest' : 'guests'}`.slice(0, 160)
}

type GuestThreadListRow = GuestThreadRow & {
  effective_conversation_state: GuestThreadRow['conversation_state']
  assigned_member_id: string | null
  record_product_id: string | null
  channel_product_id: string | null
  stay_channel: GuestThreadListItemViewModel['stayChannel']
  guest_name: string | null
  reply_channel: 'email' | 'airbnb'
  location_title: string | null
  organization_name?: string
  organization_vertical?: string | null
  latest_message_body: string | null
  latest_message_kind: 'message' | null
  latest_message_actor_kind: string | null
  latest_message_photos: number
  source_preview: string | null
  record_starts_at: string | null
  record_ends_at: string | null
  record_timezone: string | null
  record_party_size: number | null
  record_check_in_date: string | null
  record_check_out_date: string | null
  party_size_is_minimum: unknown
  operational_status: string | null
  place_image_kind: string | null
  place_image_thumbnail_url: string | null
  place_image_public_url: string | null
  place_image_whole: number
}

function threadProductId(row: GuestThreadListRow): string | null {
  if (row.record_product_id !== null && row.channel_product_id !== null && row.record_product_id !== row.channel_product_id) {
    throw new HTTPError({ statusCode: 409, message: 'The booking and provider conversation name different offerings', data: { code: 'CHANNEL_THREAD_ASSOCIATION_CONFLICT', field: 'productId' } })
  }
  return row.record_product_id ?? row.channel_product_id
}

/** The inbox filters by what a person sees — kind, unread, search — not by the attention state Today and MCP read. */
type InboxListOptions = Omit<ListGuestThreadsOptions, 'conversationState'> & { conversationState?: never }

const BUYER_VISIBLE_MESSAGE_SQL = "((e.actor_kind='guest' AND e.channel IN ('web','email','whatsapp')) OR (e.actor_kind='member' AND e.event_name='thread.member_reply') OR (e.actor_kind='system' AND e.event_name='thread.scheduled_message'))"

/** An Airbnb Support case, said to the database as `isSupportThread` says it: Airbnb's agents wrote and no guest did. */
const SUPPORT_THREAD_SQL = `(EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = gt.id AND e.kind = 'message' AND e.actor_kind = 'system' AND e.event_name = 'channel.message_mirrored')
  AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = gt.id AND e.kind = 'message' AND e.actor_kind = 'guest'))`

/** A booking lands as a stay, not as a conversation: a stay is in the inbox once someone has written. */
const HAS_CONVERSATION_SQL = "(gt.kind <> 'stay' OR EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = gt.id AND e.kind = 'message'))"

const UNREAD_FOR_MEMBER_SQL = `EXISTS (
        SELECT 1 FROM activity_entries n
        JOIN activity_entries notification_entry ON notification_entry.id = n.parent_id
        LEFT JOIN activity_entries nr ON nr.parent_id = n.id AND nr.actor_user_id = ? AND nr.kind = 'acknowledgement'
        WHERE notification_entry.request_id = gt.id
          AND (n.target_user_id IS NULL OR n.target_user_id = ?)
          AND nr.id IS NULL AND n.kind = 'notification'
      )`

/** The scope every inbox read shares: whose threads, which location, which mailbox, which kind, what was searched. */
async function inboxWhere(organizationId: string | null, opts: InboxListOptions, now: string) {
  if (!organizationId && !opts.buyerAudience) throw new Error('Thread list requires organization scope')
  if (opts.buyerAudience && !opts.userId) throw new Error('Buyer thread list requires authenticated identity')
  const params: Array<string | number> = opts.buyerAudience ? [opts.userId] : [organizationId!]
  let where = opts.buyerAudience ? 'gt.user_id = ?' : 'gt.organization_id = ?'
  if (!opts.buyerAudience) {
    const access = await assignedThreadScope(opts.principal)
    where += access.sql
    params.push(...access.params)
  } else {
    where += ` AND ${REQUEST_CURRENT_BUYER_SQL.replaceAll('r.', 'gt.')}`
    if (organizationId) { where += ' AND gt.organization_id = ?'; params.push(organizationId) }
  }
  if (opts.locationId) { where += ' AND gt.location_id = ?'; params.push(opts.locationId) }
  if (opts.assignedMemberId) { where += ' AND op.assigned_member_id = ?'; params.push(opts.assignedMemberId) }
  if (opts.type) { where += ' AND gt.kind = ?'; params.push(opts.type) }
  if (opts.kind) where += ` AND ${opts.kind === 'support' ? '' : 'NOT '}${SUPPORT_THREAD_SQL}`
  if (opts.q) {
    const like = `%${opts.q.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`
    where += ` AND (LOWER(COALESCE(json_extract(gt.payload_json, '$.guest.name'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(json_extract(gt.payload_json, '$.message'), json_extract(gt.payload_json, '$.notes'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(json_extract(gt.payload_json, '$.participant.title'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(bl.title, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM activity_entries e WHERE e.request_id = gt.id AND e.kind IN ('message', 'submission')
        AND (LOWER(COALESCE(e.body, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(json_extract(e.payload_json, '$.meta.name'), '')) LIKE ? ESCAPE '\\')))`
    params.push(like, like, like, like, like, like)
  }
  where += ` AND ${HAS_CONVERSATION_SQL}`
  const mailbox = mailboxWhere(opts.mailbox ?? null, now, opts.buyerAudience)
  where += mailbox.sql
  params.push(...mailbox.params)
  return { where, params }
}

type InboxListRow = GuestThreadRow & {
  reply_channel: 'email' | 'airbnb'
  support: number
  organization_name: string
  location_title: string | null
  time_zone: string
  airbnb_name: string | null
  record_starts_at: string | null
  record_check_in_date: string | null
  record_check_out_date: string | null
  inquiry_check_in: string | null
  inquiry_check_out: string | null
  latest_message_id: string | null
}

/**
 * The inbox list, as `InboxRow`s (inbox-parity.md, "The list"): the person
 * first, the dates and home, the last message and its time, newest first. A
 * stay nobody has written about is not listed, and Airbnb Support is its own
 * kind. The same rows serve the business's inbox and a guest's own.
 */
export async function listGuestThreads(
  db: DbClient,
  organizationId: string | null,
  opts: InboxListOptions,
  now = new Date(),
): Promise<InboxRow[]> {
  const scope = await inboxWhere(organizationId, opts, now.toISOString())
  const visible = opts.buyerAudience ? ` AND ${BUYER_VISIBLE_MESSAGE_SQL}` : ''
  const unreadFilter = opts.unreadOnly && opts.userId ? ` AND ${opts.buyerAudience ? BUYER_UNREAD_THREAD_SQL : UNREAD_FOR_MEMBER_SQL}` : ''
  const unreadParams = opts.unreadOnly && opts.userId ? (opts.buyerAudience ? buyerUnreadThreadParams(opts.userId) : [opts.userId, opts.userId]) : []
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200))
  const rows = await queryAll<InboxListRow>(db, `
    SELECT gt.*, ${REPLY_CHANNEL_SQL} AS reply_channel, ${SUPPORT_THREAD_SQL} AS support,
      o.name AS organization_name, bl.title AS location_title, COALESCE(bl.timezone, o.timezone) AS time_zone,
      (SELECT json_extract(e.payload_json, '$.meta.name') FROM activity_entries e
        WHERE e.request_id = gt.id AND e.kind = 'message' AND e.actor_kind = 'guest' AND e.event_name = 'channel.message_mirrored'
          AND json_extract(e.payload_json, '$.meta.name') IS NOT NULL ORDER BY e.sequence DESC LIMIT 1) AS airbnb_name,
      op.starts_at AS record_starts_at, op.check_in_date AS record_check_in_date, op.check_out_date AS record_check_out_date,
      (SELECT json_extract(e.payload_json, '$.check_in_date') FROM activity_entries e WHERE e.request_id = gt.id AND e.event_name = 'channel.inquiry_received' ORDER BY e.sequence DESC LIMIT 1) AS inquiry_check_in,
      (SELECT json_extract(e.payload_json, '$.check_out_date') FROM activity_entries e WHERE e.request_id = gt.id AND e.event_name = 'channel.inquiry_received' ORDER BY e.sequence DESC LIMIT 1) AS inquiry_check_out,
      (SELECT e.id FROM activity_entries e WHERE e.request_id = gt.id AND e.kind = 'message'${visible} ORDER BY e.sequence DESC LIMIT 1) AS latest_message_id,
      COALESCE((SELECT substr(COALESCE(json_extract(e.payload_json, '$.provider_inserted_at'), e.occurred_at), 1, 23) FROM activity_entries e
        WHERE e.request_id = gt.id AND e.kind = 'message'${visible} ORDER BY e.sequence DESC LIMIT 1), substr(gt.created_at, 1, 23)) AS latest_at
    FROM requests gt${OPERATIONAL_RECORD_SQL}
    JOIN organization o ON o.id = gt.organization_id
    LEFT JOIN business_locations bl ON bl.id = gt.location_id
    WHERE gt.kind IN ('contact', 'reservation', 'booking', 'stay') AND ${scope.where}${unreadFilter}
    ORDER BY latest_at DESC, gt.id
    LIMIT ? OFFSET ?
  `, [...scope.params, ...unreadParams, limit, opts.offset ?? 0])

  const [unreadIds, latest] = await Promise.all([
    opts.userId ? listUnreadThreadIds(db, rows.map(row => row.id), opts.userId, opts.buyerAudience).then(ids => new Set(ids)) : new Set<string>(),
    latestMessages(db, rows.flatMap(row => row.latest_message_id ? [row.latest_message_id] : [])),
  ])
  return rows.map(row => {
    const request = parseGuestRequest(row as unknown as Record<string, unknown>)
    const support = row.support === 1
    const recordedName = request.payload.guest.name ?? participantLabel(request)
    // Airbnb's first name from the guest's messages, else the booked guest's first name, else what the conversation was recorded as.
    const guestName = support ? 'Airbnb Support' : row.airbnb_name ?? (row.reply_channel === 'airbnb' && request.payload.guest.name ? firstName(request.payload.guest.name) : recordedName)
    const shownName = opts.buyerAudience ? row.organization_name : guestName
    const message = row.latest_message_id ? latest.get(row.latest_message_id) : undefined
    if (row.latest_message_id && !message) throw new Error(`The latest message of conversation ${row.id} could not be read`)
    const opening = request.kind === 'contact' ? request.payload.message : 'notes' in request.payload ? request.payload.notes : null
    const sentAt = message ? message.sentAt : row.created_at
    return {
      id: row.id,
      kind: support ? 'support' : 'guest',
      guestName: shownName,
      avatarInitial: initial(shownName),
      channel: row.reply_channel === 'airbnb' ? 'airbnb' : 'direct',
      home: row.location_title,
      when: support ? null
        : row.record_check_in_date && row.record_check_out_date ? stayWhen(row.record_check_in_date, row.record_check_out_date, now, row.time_zone)
          : row.record_starts_at ? `${calendarDate(localDateKey(row.record_starts_at, row.time_zone))}, ${clockTime(row.record_starts_at, row.time_zone)}`
            : row.inquiry_check_in && row.inquiry_check_out ? formatCalendarRange(row.inquiry_check_in, row.inquiry_check_out, 'en-US') : null,
      preview: message ? messagePreview(message.text, message.photos) : opening?.trim() || 'New conversation',
      previewFrom: message ? previewFrom(message, { guestName: row.reply_channel === 'airbnb' ? guestName : firstName(guestName), viewerId: opts.userId, buyer: Boolean(opts.buyerAudience), business: row.organization_name })
        : opts.buyerAudience ? 'You' : firstName(guestName),
      time: listTime(sentAt, row.time_zone, now),
      unread: unreadIds.has(row.id),
    } satisfies InboxRow
  })
}

type LatestMessage = { actorKind: string; actorUserId: string | null; actorName: string | null; eventName: string | null; text: string | null; photos: number; sentAt: string }

/** The last message of each listed conversation: who sent it, its words (Airbnb's translation where there is one) and when. */
async function latestMessages(db: DbClient, ids: string[]): Promise<Map<string, LatestMessage>> {
  if (!ids.length) return new Map()
  const rows = await queryAll<{ id: string; actor_kind: string; actor_user_id: string | null; actor_name: string | null; event_name: string | null; body: string | null; translated: string | null; provider_inserted_at: string | null; occurred_at: string; photos: number; attachments: number }>(db, `
    SELECT e.id, e.actor_kind, e.actor_user_id, u.name AS actor_name, e.event_name, e.body,
      json_extract(e.payload_json, '$.meta.translated_message') AS translated,
      json_extract(e.payload_json, '$.provider_inserted_at') AS provider_inserted_at, e.occurred_at,
      (SELECT COUNT(*) FROM media_placements mp WHERE mp.owner_type = 'activity_entry' AND mp.owner_id = e.id AND mp.slot = 'attachments' AND mp.status = 'active') AS photos,
      COALESCE(json_array_length(e.payload_json, '$.attachments'), 0) AS attachments
    FROM activity_entries e LEFT JOIN user u ON u.id = e.actor_user_id
    WHERE e.id IN (SELECT value FROM json_each(?))`, [d1JsonStringSet(ids)])
  return new Map(rows.map(row => [row.id, {
    actorKind: row.actor_kind, actorUserId: row.actor_user_id, actorName: row.actor_name, eventName: row.event_name,
    text: row.actor_kind === 'guest' && row.translated?.trim() ? row.translated : row.body,
    photos: Math.max(row.photos, row.attachments),
    sentAt: row.provider_inserted_at ? providerInstant(row.provider_inserted_at) : row.occurred_at,
  }]))
}

/** "You", or the sender's first name, before the preview. */
function previewFrom(message: LatestMessage, context: { guestName: string; viewerId: string; buyer: boolean; business: string }): string {
  if (message.actorKind === 'guest') return context.buyer ? 'You' : context.guestName
  if (message.actorKind === 'system' && message.eventName === 'channel.message_mirrored') return 'Airbnb Support'
  if (context.buyer) return context.business
  if (message.actorKind === 'member' && message.actorUserId && message.actorUserId !== context.viewerId) {
    if (!message.actorName) throw new Error('A team reply has no author name')
    return firstName(message.actorName)
  }
  return 'You'
}

/**
 * Unread conversations per kind in the current mailbox, for the filter menu:
 * All, Guests and Airbnb Support. Team conversations are counted by their own
 * inbox.
 */
export async function countUnreadInboxThreads(db: DbClient, organizationId: string, opts: InboxListOptions): Promise<Omit<InboxUnreadCounts, 'team'>> {
  const scope = await inboxWhere(organizationId, { ...opts, kind: null, q: null, mailbox: 'current' }, new Date().toISOString())
  const rows = await queryAll<{ support: number; count: number }>(db, `
    SELECT ${SUPPORT_THREAD_SQL} AS support, COUNT(*) AS count
      FROM requests gt${OPERATIONAL_RECORD_SQL} LEFT JOIN business_locations bl ON bl.id = gt.location_id
     WHERE gt.kind IN ('contact', 'reservation', 'booking', 'stay') AND ${scope.where} AND ${UNREAD_FOR_MEMBER_SQL}
     GROUP BY 1`, [...scope.params, opts.userId, opts.userId])
  const support = rows.find(row => row.support === 1)?.count ?? 0
  const guests = rows.find(row => row.support !== 1)?.count ?? 0
  return { all: guests + support, guests, support }
}

export async function listOrganizationGuestThreads(
  db: DbClient,
  opts: Omit<ListGuestThreadsOptions, 'principal'> & {
    organizationId: string
    principal: MemberAccessPrincipal
  },
): Promise<GuestThreadListItemViewModel[]> {
  const now = new Date().toISOString()
  const stateSql = guestThreadConversationStateSql('gt', now)
  const params: Array<string | number> = [opts.organizationId]
  let where = 'gt.organization_id = ?'

  const access = await assignedThreadScope(opts.principal)
  where += access.sql
  params.push(...access.params)

  if (opts.locationId) {
    where += ' AND gt.location_id = ?'
    params.push(opts.locationId)
  }
  if (opts.assignedMemberId) {
    where += ' AND op.assigned_member_id = ?'
    params.push(opts.assignedMemberId)
  }
  if (opts.type) {
    where += ' AND gt.kind = ?'
    params.push(opts.type)
  }
  if (opts.conversationState) {
    where += ` AND ${stateSql} = ?`
    params.push(opts.conversationState)
    if (opts.conversationState === 'needs_attention') where += ` AND ${CANCELLED_ATTENTION_SQL}`
  }
  // One instant for the filter and for each row's mailbox, so a row cannot be
  // listed as Current and labelled Past.
  const mailbox = mailboxWhere(opts.mailbox ?? null, now)
  where += mailbox.sql
  params.push(...mailbox.params)

  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200))

  const unreadFilter = opts.unreadOnly && opts.userId
    ? `
      AND EXISTS (
        SELECT 1 FROM activity_entries n
        JOIN activity_entries notification_entry ON notification_entry.id = n.parent_id
        LEFT JOIN activity_entries nr ON nr.parent_id = n.id AND nr.actor_user_id = ? AND nr.kind = 'acknowledgement'
        WHERE notification_entry.request_id = gt.id
          AND (n.target_user_id IS NULL OR n.target_user_id = ?)
          AND nr.id IS NULL AND n.kind = 'notification'
      )
    `
    : ''

  const rows = await queryAll<GuestThreadListRow>(db, `
    SELECT
      gt.*, ${stateSql} AS effective_conversation_state,
      ${SOURCE_GUEST_NAME_SQL} AS guest_name, ${REPLY_CHANNEL_SQL} AS reply_channel,
      bl.title AS location_title,
      (
        SELECT body FROM activity_entries
        WHERE request_id = gt.id AND kind = 'message'
        ORDER BY sequence DESC LIMIT 1
      ) AS latest_message_body,
      (
        SELECT kind FROM activity_entries
        WHERE request_id = gt.id AND kind = 'message'
        ORDER BY sequence DESC LIMIT 1
      ) AS latest_message_kind,
      (SELECT actor_kind FROM activity_entries WHERE request_id = gt.id AND kind = 'message' ORDER BY sequence DESC LIMIT 1) AS latest_message_actor_kind,
      (
        SELECT COUNT(*) FROM media_placements mp
        WHERE mp.owner_type = 'activity_entry' AND mp.slot = 'attachments' AND mp.status = 'active'
          AND mp.owner_id = (SELECT id FROM activity_entries WHERE request_id = gt.id AND kind = 'message' ORDER BY sequence DESC LIMIT 1)
      ) AS latest_message_photos,
      ${SOURCE_PREVIEW_SQL} AS source_preview,
      ${SOURCE_PREVIEW_COLUMNS},
      ${PLACE_IMAGE_COLUMNS},
      op.status AS operational_status
    FROM requests gt${OPERATIONAL_RECORD_SQL}
    LEFT JOIN business_locations bl ON bl.id = gt.location_id${PLACE_IMAGE_SQL}
    WHERE gt.kind IN ('contact', 'reservation', 'booking', 'stay') AND ${where}
    ${unreadFilter}
    ORDER BY gt.updated_at DESC, gt.id
    LIMIT ? OFFSET ?
  `, opts.unreadOnly && opts.userId ? [...params, ...(opts.buyerAudience?buyerUnreadThreadParams(opts.userId):[opts.userId,opts.userId]), limit, opts.offset ?? 0] : [...params, limit, opts.offset ?? 0])

  const unreadIds = opts.userId
    ? new Set(await listUnreadThreadIds(db, rows.map(row => row.id), opts.userId))
    : new Set<string>()
  const items: GuestThreadListItemViewModel[] = []
  for (const row of rows ?? []) {
    const unread = unreadIds.has(row.id)
    const preview = sourcePreviewText(row)
    items.push({
      id: row.id,
      organizationId: row.organization_id,
      guestName: row.guest_name,
      participantLabel: participantLabel(parseGuestRequest(row as unknown as Record<string, unknown>)),
      replyChannel: row.reply_channel,
      submissionType: row.kind,
      locationLabel: row.location_title,
      locationId: row.location_id,
      assignedMemberId: row.assigned_member_id,
      productId: threadProductId(row),
      stayChannel: row.stay_channel,
      occurrenceAt: row.record_starts_at,
      timeZone: row.record_timezone,
      latestMessageFromGuest: row.latest_message_actor_kind === 'guest',
      conversationState: row.effective_conversation_state,
      operationalStatus: row.operational_status,
      operationalStatusLabel: row.operational_status ? formatOperationalStatusLabel(row.kind, row.operational_status) : null,
      unread,
      unreadCount: unread ? 1 : 0,
      preview: row.latest_message_kind === 'message'
        ? { kind: 'message', text: messagePreview(row.latest_message_body, row.latest_message_photos) }
        : (preview ? { kind: 'submission', text: preview } : null),
      lastActivityAt: row.updated_at,
      needsAttention: row.effective_conversation_state === 'needs_attention',
      // Two renditions of one asset, not two sources: a row 60px wide takes the
      // thumbnail, and an asset with no rendition yet is served at full size.
      imageUrl: mediaStillUrl({ kind: row.place_image_kind, public_url: row.place_image_public_url, thumbnail_url: row.place_image_thumbnail_url }),
      imageFit: row.place_image_whole ? 'contain' : 'cover',
      whenLabel: row.record_check_in_date ? stayRecordLabel(row)
        : row.record_starts_at && row.record_timezone ? formatThreadWhenLabel(row.record_starts_at, row.record_timezone)
          : null,
      ...mailboxFields(row, now),
    })
  }
  return items
}

async function listUnreadThreadIds(db: DbClient, threadIds: string[], userId: string, buyerAudience=false): Promise<string[]> {
  if (threadIds.length === 0) return []
  if(buyerAudience){
    const rows=await queryAll<{request_id:string}>(db,`SELECT gt.id request_id FROM requests gt WHERE gt.user_id=? AND gt.id IN (SELECT value FROM json_each(?)) AND ${BUYER_UNREAD_THREAD_SQL}`,[userId,d1JsonStringSet(threadIds),...buyerUnreadThreadParams(userId)])
    return rows.map(row=>row.request_id)
  }
  const rows = await queryAll<{ request_id: string }>(db, `
    SELECT gt.id AS request_id
    FROM requests gt${OPERATIONAL_RECORD_SQL}
    WHERE gt.id IN (SELECT value FROM json_each(?))
      AND EXISTS (
        SELECT 1 FROM activity_entries n
        JOIN activity_entries notification_entry ON notification_entry.id = n.parent_id
        LEFT JOIN activity_entries nr ON nr.parent_id = n.id AND nr.actor_user_id = ? AND nr.kind = 'acknowledgement'
        WHERE notification_entry.request_id = gt.id
          AND ${buyerAudience ? 'n.target_user_id = ?' : '(n.target_user_id IS NULL OR n.target_user_id = ?)'}
          AND nr.id IS NULL AND n.kind = 'notification'
      )
  `, [d1JsonStringSet(threadIds), userId, userId])
  return (rows ?? []).map(row => row.request_id)
}

export async function updateThreadProjection(
  db: DbClient,
  threadId: string,
  update: { conversationState: ConversationState },
): Promise<void> {
  const now = new Date().toISOString()
  await execute(db, `
    UPDATE requests
    SET conversation_state = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `, [update.conversationState, update.conversationState === 'resolved' ? now : null, now, threadId])
}

export async function updateThreadProjectionIfLatestEntry(
  db: DbClient,
  threadId: string,
  entryId: string,
  update: { conversationState: ConversationState; preserveUnansweredGuestMessages?: boolean },
): Promise<void> {
  await execute(db, `
    UPDATE requests
    SET conversation_state = ?, resolved_at = CASE WHEN ? = 'resolved' THEN (SELECT occurred_at FROM activity_entries WHERE id=?) ELSE NULL END, updated_at = (SELECT occurred_at FROM activity_entries WHERE id=?)
    WHERE id = ?
      AND EXISTS (
        SELECT 1
        FROM activity_entries projected
        WHERE projected.id = ?
          AND projected.request_id = requests.id
          AND NOT EXISTS (
            SELECT 1
            FROM activity_entries later
            WHERE later.request_id = projected.request_id
              AND later.sequence > projected.sequence
          )
      )
      AND (? = 0 OR NOT ${unansweredGuestMessagesSql('requests.id')})
  `, [update.conversationState, update.conversationState, entryId, entryId, threadId, entryId, update.preserveUnansweredGuestMessages ? 1 : 0])
}

/**
 * Archive or unarchive a thread, and the one operation entry that records it,
 * as one batch.
 *
 * The entry is written only while the thread is still in the state the
 * transition leaves — archived_at unset for Archive, set for Unarchive — and
 * its occurrence has not ended, which is `resolveGuestThreadMailbox`'s
 * canArchive/canUnarchive said to the database. The update then lands only
 * where that entry did, so a thread that changed between the caller's read and
 * this write gets neither. A retried key hits the entry's dedupe key and writes
 * nothing.
 *
 * `updated_at` is deliberately untouched: it orders the inbox by conversation
 * activity, and filing a conversation away is not the guest saying anything.
 */
export function mailboxTransitionQueries(input: {
  transition: 'archive' | 'unarchive'
  threadId: string
  organizationId: string
  actorUserId: string
  entryId: string
  dedupeKey: string
  now: string
}): [entry: BatchQuery, update: BatchQuery] {
  const archive = input.transition === 'archive'
  const guard = (alias: string) => `${alias}.id = ? AND ${alias}.organization_id = ?
        AND ${alias}.archived_at IS ${archive ? 'NULL' : 'NOT NULL'}
        AND NOT EXISTS (SELECT 1 FROM ${OPERATIONAL_RECORDS_SQL} op WHERE op.request_id = ${alias}.id AND op.ends_at < ?)`
  const guardParams = [input.threadId, input.organizationId, input.now]
  return [{
    query: `
      INSERT INTO activity_entries
        (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, gt.id, 'operation', 'request', 'member', ?, NULL, NULL, ?, ?, ?,
             COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = gt.id), 0) + 1,
             ?, ?
      FROM requests gt
      WHERE ${guard('gt')}
      ON CONFLICT(dedupe_key) DO NOTHING
    `,
    params: [
      input.entryId, input.actorUserId, archive ? 'thread.archived' : 'thread.unarchived',
      JSON.stringify({ action: input.transition }), input.dedupeKey, input.now, input.now,
      ...guardParams,
    ],
  }, {
    query: `
      UPDATE requests SET archived_at = ?, archived_by_user_id = ?
      WHERE ${guard('requests')}
        AND EXISTS (SELECT 1 FROM activity_entries WHERE id = ? AND request_id = requests.id)
    `,
    params: [archive ? input.now : null, archive ? input.actorUserId : null, ...guardParams, input.entryId],
  }]
}
