import { REQUEST_CURRENT_BUYER_SQL, STAY_THREAD_ENDS_SQL, STAY_THREAD_STARTS_SQL, stayPreview } from '~/server/domain/requests'
import { BUYER_UNREAD_THREAD_SQL, buyerUnreadThreadParams } from './entries'
import { messagePreview } from './attachments'
import { execute, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { assignedBookingSql, assignedHomeSql, roleAllows, assertRoleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import type {
  ConversationState,
  GuestThreadListItemViewModel,
  GuestThreadRow,
  ListGuestThreadsOptions,
} from './types'
import { formatOperationalStatusLabel, formatThreadWhenLabel } from './status-labels'
import { resolveGuestThreadMailbox, type GuestThreadMailbox } from './mailbox'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const SOURCE_GUEST_NAME_SQL = "json_extract(gt.payload_json, '$.guest.name')"

async function assignedThreadScope(principal?: MemberAccessPrincipal | null) {
  if (!principal || await roleAllows({ ...principal, permissions: { operations: ['read'] } })) return { sql: '', params: [] as string[] }
  await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
  // Bookings assigned to them, and the stays at homes they look after.
  return {
    sql: ` AND (EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = gt.id AND b.organization_id = gt.organization_id AND (${assignedBookingSql('b')}))
      OR EXISTS (SELECT 1 FROM stays st JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
        WHERE st.request_id = gt.id AND st.organization_id = gt.organization_id AND ${assignedHomeSql('c')}))`,
    params: [principal.userId, principal.userId, principal.userId],
  }
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
    SELECT b.request_id, b.status, b.party_size, s.starts_at, s.ends_at, s.timezone, NULL AS check_in_date, NULL AS check_out_date, b.assigned_member_id
      FROM bookings b JOIN product_sessions s ON s.id = b.product_session_id
     WHERE b.request_id IS NOT NULL
    UNION ALL
    SELECT r.request_id, r.status, r.party_size, r.starts_at, r.ends_at, r.timezone, NULL, NULL, NULL
      FROM reservations r WHERE r.request_id IS NOT NULL
    UNION ALL
    SELECT st.request_id, st.status, st.adults + st.children, ${STAY_THREAD_STARTS_SQL('st')}, ${STAY_THREAD_ENDS_SQL('st')}, l.timezone, st.check_in_date, st.check_out_date, c.assigned_member_id
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
 * occurrence is Current until someone archives it.
 */
function mailboxWhere(mailbox: GuestThreadMailbox, now: string, buyerAudience=false): { sql: string; params: string[] } {
  if (buyerAudience) return mailbox === 'current' ? {sql:' AND (op.ends_at IS NULL OR op.ends_at >= ?)',params:[now]} : {sql:' AND op.ends_at < ?',params:[now]}
  return mailbox === 'current'
    ? { sql: ' AND gt.archived_at IS NULL AND (op.ends_at IS NULL OR op.ends_at >= ?)', params: [now] }
    : { sql: ' AND (gt.archived_at IS NOT NULL OR op.ends_at < ?)', params: [now] }
}

function mailboxFields(row: { archived_at: string | null; record_ends_at: string | null }, now: string, buyerAudience=false) {
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
      COALESCE(ma_hero.public_url, ma_logo.public_url) AS place_image_public_url`

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

export interface OperationSummary {
  openThreads: number
  unreadThreads: number
  reservations: number
  experienceBookings: number
}

export async function getGuestThreadOperationSummary(
  db: DbClient,
  organizationId: string | null,
  opts: ListGuestThreadsOptions,
): Promise<OperationSummary> {
  const params: Array<string | number> = []
  let where: string

  if (organizationId) {
    params.push(organizationId)
    where = 'gt.organization_id = ?'
  } else if (opts.organizationId) {
    params.push(opts.organizationId)
    where = 'gt.organization_id = ?'
  } else {
    return { openThreads: 0, unreadThreads: 0, reservations: 0, experienceBookings: 0 }
  }
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
  // The counts beside a mailbox are that mailbox's counts.
  if (opts.mailbox) {
    const mailbox = mailboxWhere(opts.mailbox, new Date().toISOString())
    where += mailbox.sql
    params.push(...mailbox.params)
  }

  const counts = await queryFirst<OperationSummary>(db, `
    SELECT
      SUM(CASE WHEN gt.conversation_state != 'resolved' THEN 1 ELSE 0 END) AS openThreads,
      0 AS unreadThreads,
      SUM(CASE WHEN gt.conversation_state != 'resolved' AND gt.kind = 'reservation' THEN 1 ELSE 0 END) AS reservations,
      SUM(CASE WHEN gt.conversation_state != 'resolved' AND gt.kind = 'booking' THEN 1 ELSE 0 END) AS experienceBookings
    FROM requests gt${OPERATIONAL_RECORD_SQL}
    WHERE gt.kind IN ('contact', 'reservation', 'booking', 'stay') AND ${where}
  `, params)

  const unreadThreads = opts.userId
    ? await countUnreadThreadIds(db, where, params, opts.userId)
    : 0

  return {
    openThreads: counts?.openThreads ?? 0,
    unreadThreads,
    reservations: counts?.reservations ?? 0,
    experienceBookings: counts?.experienceBookings ?? 0,
  }
}

async function countUnreadThreadIds(
  db: DbClient,
  where: string,
  params: Array<string | number>,
  userId: string,
): Promise<number> {
  const rows = await queryAll<{ id: string }>(db, `
    SELECT gt.id
    FROM requests gt${OPERATIONAL_RECORD_SQL}
    WHERE gt.kind IN ('contact', 'reservation', 'booking', 'stay') AND ${where}
      AND EXISTS (
        SELECT 1 FROM activity_entries n
        JOIN activity_entries notification_entry ON notification_entry.id = n.parent_id
        LEFT JOIN activity_entries nr ON nr.parent_id = n.id AND nr.actor_user_id = ? AND nr.kind = 'acknowledgement'
        WHERE notification_entry.request_id = gt.id
          AND (n.target_user_id IS NULL OR n.target_user_id = ?)
          AND nr.id IS NULL AND n.kind = 'notification'
      )
  `, [...params, userId, userId])
  return rows.length
}

type GuestThreadListRow = GuestThreadRow & {
  assigned_member_id: string | null
  guest_name: string
  location_title: string | null
  organization_name?: string | null
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
}

/** Returns list view models with member-specific unread and one canonical `preview` field. */
export async function listGuestThreads(
  db: DbClient,
  organizationId: string | null,
  opts: ListGuestThreadsOptions,
): Promise<GuestThreadListItemViewModel[]> {
  if (!organizationId && !opts.buyerAudience) throw new Error('Thread list requires organization scope')
  if (opts.buyerAudience && !opts.userId) throw new Error('Buyer thread list requires authenticated identity')
  const params: Array<string | number> = opts.buyerAudience ? [opts.userId] : [organizationId!]
  let where = opts.buyerAudience ? 'gt.user_id = ?' : 'gt.organization_id = ?'
  if (!opts.buyerAudience) {
    const access = await assignedThreadScope(opts.principal)
    where += access.sql
    params.push(...access.params)
  }
  if (opts.buyerAudience) {
    where += ` AND ${REQUEST_CURRENT_BUYER_SQL.replaceAll('r.','gt.')}`
    if (organizationId) { where += ' AND gt.organization_id = ?'; params.push(organizationId) }
  }

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
    where += ' AND gt.conversation_state = ?'
    params.push(opts.conversationState)
  }
  // One instant for the filter and for each row's mailbox, so a row cannot be
  // listed as Current and labelled Past.
  const now = new Date().toISOString()
  if (opts.mailbox) {
    const mailbox = mailboxWhere(opts.mailbox, now, opts.buyerAudience)
    where += mailbox.sql
    params.push(...mailbox.params)
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200))

  const unreadFilter = opts.unreadOnly && opts.userId
    ? opts.buyerAudience ? ` AND ${BUYER_UNREAD_THREAD_SQL}` : `
      AND EXISTS (
        SELECT 1 FROM activity_entries n
        JOIN activity_entries notification_entry ON notification_entry.id = n.parent_id
        LEFT JOIN activity_entries nr ON nr.parent_id = n.id AND nr.actor_user_id = ? AND nr.kind = 'acknowledgement'
        WHERE notification_entry.request_id = gt.id
          AND ${opts.buyerAudience ? 'n.target_user_id = ?' : '(n.target_user_id IS NULL OR n.target_user_id = ?)'}
          AND nr.id IS NULL AND n.kind = 'notification'
      )
    `
    : ''

  const rows = await queryAll<GuestThreadListRow>(db, `
    SELECT
      gt.*,
      ${SOURCE_GUEST_NAME_SQL} AS guest_name, o.name AS organization_name, o.vertical AS organization_vertical,
      bl.title AS location_title,
      (
        SELECT body FROM activity_entries
        WHERE request_id = gt.id AND kind = 'message' ${opts.buyerAudience ? "AND ((actor_kind='guest' AND channel IN ('web','email','whatsapp')) OR (actor_kind='member' AND event_name='thread.member_reply'))" : ''}
        ORDER BY sequence DESC LIMIT 1
      ) AS latest_message_body,
      (
        SELECT kind FROM activity_entries
        WHERE request_id = gt.id AND kind = 'message' ${opts.buyerAudience ? "AND ((actor_kind='guest' AND channel IN ('web','email','whatsapp')) OR (actor_kind='member' AND event_name='thread.member_reply'))" : ''}
        ORDER BY sequence DESC LIMIT 1
      ) AS latest_message_kind,
      (SELECT actor_kind FROM activity_entries WHERE request_id = gt.id AND kind = 'message' ORDER BY sequence DESC LIMIT 1) AS latest_message_actor_kind,
      (
        SELECT COUNT(*) FROM media_placements mp
        WHERE mp.owner_type = 'activity_entry' AND mp.slot = 'attachments' AND mp.status = 'active'
          AND mp.owner_id = (SELECT id FROM activity_entries WHERE request_id = gt.id AND kind = 'message' ${opts.buyerAudience ? "AND ((actor_kind='guest' AND channel IN ('web','email','whatsapp')) OR (actor_kind='member' AND event_name='thread.member_reply'))" : ''} ORDER BY sequence DESC LIMIT 1)
      ) AS latest_message_photos,
      ${SOURCE_PREVIEW_SQL} AS source_preview,
      ${SOURCE_PREVIEW_COLUMNS},
      ${PLACE_IMAGE_COLUMNS},
      op.status AS operational_status
    FROM requests gt${OPERATIONAL_RECORD_SQL}
    JOIN organization o ON o.id=gt.organization_id
    LEFT JOIN business_locations bl ON bl.id = gt.location_id${PLACE_IMAGE_SQL}
    WHERE gt.kind IN ('contact', 'reservation', 'booking', 'stay') AND ${where}
    ${unreadFilter}
    ORDER BY gt.updated_at DESC
    LIMIT ?
  `, opts.unreadOnly && opts.userId ? [...params, ...(opts.buyerAudience?buyerUnreadThreadParams(opts.userId):[opts.userId,opts.userId]), limit] : [...params, limit])

  const unreadIds = opts.userId
    ? new Set(await listUnreadThreadIds(db, rows.map(row => row.id), opts.userId, opts.buyerAudience))
    : new Set<string>()
  const items: GuestThreadListItemViewModel[] = []
  for (const row of rows ?? []) {
    const unread = unreadIds.has(row.id)
    const preview = sourcePreviewText(row)
    items.push({
      id: row.id,
      organizationId: row.organization_id,
      organizationName: row.organization_name ?? null,
      organizationVertical: row.organization_vertical ?? null,
      guestName: row.guest_name,
      submissionType: row.kind,
      contextLabel: preview ?? '',
      locationLabel: row.location_title,
      locationId: row.location_id,
      assignedMemberId: row.assigned_member_id,
      occurrenceAt: row.record_starts_at,
      timeZone: row.record_timezone,
      latestMessageFromGuest: row.latest_message_actor_kind === 'guest',
      conversationState: opts.buyerAudience ? null : row.conversation_state,
      operationalStatus: row.operational_status,
      operationalStatusLabel: row.operational_status ? formatOperationalStatusLabel(row.kind, row.operational_status) : null,
      unread,
      unreadCount: unread ? 1 : 0,
      preview: row.latest_message_kind === 'message'
        ? { kind: 'message', text: messagePreview(row.latest_message_body, row.latest_message_photos) }
        : (preview ? { kind: 'submission', text: preview } : null),
      lastActivityAt: row.updated_at,
      needsAttention: opts.buyerAudience ? unread : row.conversation_state === 'needs_attention',
      // Two renditions of one asset, not two sources: a row 60px wide takes the
      // thumbnail, and an asset with no rendition yet is served at full size.
      imageUrl: mediaStillUrl({ kind: row.place_image_kind, public_url: row.place_image_public_url, thumbnail_url: row.place_image_thumbnail_url }),
      whenLabel: row.record_check_in_date ? stayRecordLabel(row)
        : row.record_starts_at && row.record_timezone ? formatThreadWhenLabel(row.record_starts_at, row.record_timezone)
          : null,
      ...mailboxFields(row, now, opts.buyerAudience),
      ...(opts.buyerAudience ? {canArchive:false,canUnarchive:false} : {}),
    })
  }
  return items
}

export async function listOrganizationGuestThreads(
  db: DbClient,
  opts: Omit<ListGuestThreadsOptions, 'principal'> & {
    organizationId: string
    principal: MemberAccessPrincipal
  },
): Promise<GuestThreadListItemViewModel[]> {
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
    where += ' AND gt.conversation_state = ?'
    params.push(opts.conversationState)
  }
  // One instant for the filter and for each row's mailbox, so a row cannot be
  // listed as Current and labelled Past.
  const now = new Date().toISOString()
  if (opts.mailbox) {
    const mailbox = mailboxWhere(opts.mailbox, now)
    where += mailbox.sql
    params.push(...mailbox.params)
  }

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
      gt.*,
      ${SOURCE_GUEST_NAME_SQL} AS guest_name,
      bl.title AS location_title,
      s.name AS organization_name,
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
    LEFT JOIN business_locations bl ON bl.id = gt.location_id
    LEFT JOIN organization s ON s.id = gt.organization_id${PLACE_IMAGE_SQL}
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
    const contextLabel = row.organization_name && row.location_title
      ? `${row.organization_name} · ${row.location_title}`
      : row.organization_name || row.location_title || ''
    const preview = sourcePreviewText(row)
    items.push({
      id: row.id,
      organizationId: row.organization_id,
      guestName: row.guest_name,
      submissionType: row.kind,
      contextLabel,
      locationLabel: row.location_title,
      locationId: row.location_id,
      assignedMemberId: row.assigned_member_id,
      occurrenceAt: row.record_starts_at,
      timeZone: row.record_timezone,
      latestMessageFromGuest: row.latest_message_actor_kind === 'guest',
      conversationState: row.conversation_state,
      operationalStatus: row.operational_status,
      operationalStatusLabel: row.operational_status ? formatOperationalStatusLabel(row.kind, row.operational_status) : null,
      unread,
      unreadCount: unread ? 1 : 0,
      preview: row.latest_message_kind === 'message'
        ? { kind: 'message', text: messagePreview(row.latest_message_body, row.latest_message_photos) }
        : (preview ? { kind: 'submission', text: preview } : null),
      lastActivityAt: row.updated_at,
      needsAttention: row.conversation_state === 'needs_attention',
      // Two renditions of one asset, not two sources: a row 60px wide takes the
      // thumbnail, and an asset with no rendition yet is served at full size.
      imageUrl: mediaStillUrl({ kind: row.place_image_kind, public_url: row.place_image_public_url, thumbnail_url: row.place_image_thumbnail_url }),
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
      AND (? = 0 OR NOT EXISTS (
        SELECT 1 FROM activity_entries guest_message
        WHERE guest_message.request_id = requests.id
          AND guest_message.kind = 'message' AND guest_message.actor_kind = 'guest'
          AND NOT EXISTS (
            SELECT 1 FROM activity_entries reply
            JOIN guest_thread_deliveries delivery ON delivery.entry_id = reply.id
            WHERE reply.request_id = guest_message.request_id
              AND reply.kind = 'message' AND reply.actor_kind = 'member'
              AND reply.event_name = 'thread.member_reply'
              AND reply.sequence > guest_message.sequence
              AND delivery.status IN ('accepted', 'sent', 'delivered', 'read')
          )
      ))
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
