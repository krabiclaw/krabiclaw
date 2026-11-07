import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedGuestThreadScope, assignedResponsibilitySql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { discardMessagePhotos, listMessagePhotos, messagePhotoPlacements, uploadMessagePhotos, MessagePhotoRejection, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { firstName } from '~/server/domain/guest-threads/presentation'
import { bookingEditorPath, guestConversationPath } from '~/server/utils/dashboard-links'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { addLocalDays, formatCalendarDate, formatTime, formatTimestamp, isValidInstant, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { STAY_CHANNEL_LABELS, type StayChannel } from '~/shared/bookings'
import type { CloudflareEnv } from '~/server/utils/auth'

/*
  Work someone has to do. A turnover, a guest's unanswered question and a
  failed scheduled message are opened and closed by the batch that changes
  their subject (the builders below); an accepted opportunity by its accept;
  a custom task by a person. People assign, reschedule, complete, skip and
  reopen them here, from the dashboard, MCP and the app alike.
*/

export const TASK_KINDS = ['turnover', 'guest_reply', 'message_delivery', 'booking_review', 'booking_change', 'opportunity', 'custom'] as const
export type TaskKind = typeof TASK_KINDS[number]
export type TaskStatus = 'open' | 'done' | 'skipped' | 'cancelled'

export interface TaskRow {
  id: string; organization_id: string; kind: TaskKind
  subject_type: 'stay' | 'request' | 'scheduled_guest_message' | 'booking' | 'reservation' | 'article' | 'post' | 'product' | null; subject_id: string | null
  product_id: string | null; location_id: string | null; opportunity_id: string | null
  title: string | null; notes: string | null
  assigned_member_id: string | null; assigned_team_id: string | null
  starts_at: string | null; due_at: string | null; timezone: string
  status: TaskStatus; outcome_note: string | null; closed_at: string | null; closed_by_user_id: string | null
  dedupe_key: string; version: number; created_by_user_id: string | null; created_at: string; updated_at: string
}

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, message, data: { code, ...(field ? { field } : {}) } })
}

// ---------------------------------------------------------------------------
// Subject writes. Each returns statements for the batch that changes the
// subject, so the task and its subject commit together.
// ---------------------------------------------------------------------------

/** A stay as one write leaves it: the turnover window is computed for this state. */
export interface StayWindow { id: string; product_id: string; status: 'pending' | 'confirmed' | 'cancelled'; check_in_date: string; check_out_date: string }

interface HomeClock { product_id: string; location_id: string; timezone: string; check_in_time: string | null; check_out_time: string | null; assigned_member_id: string | null; assigned_team_id: string | null }

/** The batch guard: the turnover statements apply only if the stay row is what they were computed for. */
function stayIs(organizationId: string, stay: StayWindow): BatchQuery {
  return { query: `EXISTS (SELECT 1 FROM stays WHERE organization_id = ? AND id = ? AND product_id = ? AND status = ? AND check_in_date = ? AND check_out_date = ?)`,
    params: [organizationId, stay.id, stay.product_id, stay.status, stay.check_in_date, stay.check_out_date] }
}

/**
 * The turnover tasks one stay write changes: the stay's own (opened when it is
 * confirmed and checks out today or later, moved with it, cancelled with it),
 * and the turnover before it at its old and new place, whose window ends at
 * the next arrival. Accepted calendar-gap opportunities the stay fills are done.
 * `before` is the stay as it was, null when the write creates it.
 */
export async function turnoverTaskQueries(db: DbClient, input: { organizationId: string; after: StayWindow; before: Pick<StayWindow, 'product_id' | 'check_in_date'> | null; now: string }): Promise<BatchQuery[]> {
  const { organizationId, after, before, now } = input
  const guard = stayIs(organizationId, after)
  const homes = [...new Set([after.product_id, ...(before ? [before.product_id] : [])])]
  const clocks = await queryAll<HomeClock>(db, `SELECT c.product_id, c.location_id, l.timezone, c.check_in_time, c.check_out_time, c.assigned_member_id, c.assigned_team_id
    FROM product_stay_configs c JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
    WHERE c.organization_id = ? AND c.product_id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(homes)])
  const queries: BatchQuery[] = []
  const windows = new Map<string, { stay: StayWindow; home: HomeClock; next: string | null }>()
  for (const productId of homes) {
    const home = clocks.find(clock => clock.product_id === productId)
    if (!home) throw new Error(`Home ${productId} has no stay settings`)
    const anchors = [after.product_id === productId ? after.check_in_date : null, before?.product_id === productId ? before.check_in_date : null].filter((value): value is string => value !== null)
    const earliest = anchors.reduce((min, value) => value < min ? value : min, anchors[0]!)
    const others = await queryAll<StayWindow>(db, `SELECT id, product_id, status, check_in_date, check_out_date FROM stays
      WHERE organization_id = ? AND product_id = ? AND status = 'confirmed' AND id <> ? AND check_out_date >= date(?, '-400 days')`, [organizationId, productId, after.id, earliest])
    const confirmed = [...others, ...(after.product_id === productId && after.status === 'confirmed' ? [after] : [])]
    const nextArrival = (stay: StayWindow) => confirmed.filter(other => other.id !== stay.id && other.check_in_date >= stay.check_out_date)
      .reduce<string | null>((min, other) => min === null || other.check_in_date < min ? other.check_in_date : min, null)
    const previousStay = (date: string) => confirmed.filter(other => other.id !== after.id && other.check_out_date <= date)
      .reduce<StayWindow | null>((latest, other) => latest === null || other.check_out_date > latest.check_out_date ? other : latest, null)
    if (after.product_id === productId && after.status === 'confirmed') windows.set(after.id, { stay: after, home, next: nextArrival(after) })
    for (const anchor of anchors) {
      const previous = previousStay(anchor)
      if (previous) windows.set(previous.id, { stay: previous, home, next: nextArrival(previous) })
    }
  }
  for (const { stay, home, next } of windows.values()) {
    const startsAt = home.check_out_time === null ? null : localDateTimeToInstant(stay.check_out_date, home.check_out_time, home.timezone, 'compatible').toISOString()
    const arrival = next === null || home.check_in_time === null ? null : localDateTimeToInstant(next, home.check_in_time, home.timezone, 'compatible').toISOString()
    const dueAt = arrival !== null && startsAt !== null && arrival < startsAt ? startsAt : arrival
    const key = `turnover:${stay.id}`
    queries.push({
      query: `UPDATE tasks SET product_id = ?, location_id = ?, timezone = ?, starts_at = ?, due_at = ?,
          assigned_member_id = CASE WHEN product_id IS ? THEN assigned_member_id ELSE ? END,
          assigned_team_id = CASE WHEN product_id IS ? THEN assigned_team_id ELSE ? END,
          version = version + 1, updated_at = ?
        WHERE dedupe_key = ? AND status = 'open' AND (${guard.query})
          AND (product_id IS NOT ? OR starts_at IS NOT ? OR due_at IS NOT ?)`,
      params: [home.product_id, home.location_id, home.timezone, startsAt, dueAt, home.product_id, home.assigned_member_id, home.product_id, home.assigned_team_id, now, key, ...guard.params!, home.product_id, startsAt, dueAt],
    })
    // A stay that checked out before today at its home is history, not work.
    if (stay.check_out_date >= localDateAt(new Date(now), home.timezone)) {
      queries.push({
        query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, assigned_team_id,
            starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
          SELECT ?, ?, 'turnover', 'stay', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ? WHERE (${guard.query})
          ON CONFLICT (dedupe_key) DO NOTHING`,
        params: [crypto.randomUUID(), organizationId, stay.id, home.product_id, home.location_id, home.assigned_member_id, home.assigned_team_id,
          startsAt, dueAt, home.timezone, key, now, now, ...guard.params!],
      })
    }
  }
  if (after.status !== 'confirmed') {
    queries.push({
      query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
        WHERE dedupe_key = ? AND status = 'open' AND (${guard.query})`,
      params: [now, now, `turnover:${after.id}`, ...guard.params!],
    })
  } else {
    // A stay on the nights of an accepted calendar gap fills it.
    queries.push({
      query: `UPDATE tasks SET status = 'done', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
        WHERE organization_id = ? AND kind = 'opportunity' AND status = 'open' AND (${guard.query}) AND opportunity_id IN (
          SELECT id FROM opportunities WHERE organization_id = ? AND operation = 'stay.gap'
            AND json_extract(subject_id, '$[0]') = ? AND json_extract(subject_id, '$[1]') < ? AND json_extract(subject_id, '$[2]') > ?)`,
      params: [now, now, organizationId, ...guard.params!, organizationId, after.product_id, after.check_out_date, after.check_in_date],
    })
  }
  return queries
}

/** A scheduled message that failed or needs review is someone's work until it is sent, cancelled or skipped. */
export function messageDeliveryTaskQueries(messageId: string, now: string): BatchQuery[] {
  return [{
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, m.organization_id, 'message_delivery', 'scheduled_guest_message', m.id, m.product_id, c.location_id, m.timezone, 'open', 'message_delivery:' || m.id, 1, ?, ?
        FROM scheduled_guest_messages m JOIN product_stay_configs c ON c.organization_id = m.organization_id AND c.product_id = m.product_id
       WHERE m.id = ? AND m.status IN ('failed', 'needs_review')
      ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [crypto.randomUUID(), now, now, messageId],
  }, {
    query: `UPDATE tasks SET status = CASE WHEN (SELECT status FROM scheduled_guest_messages WHERE id = tasks.subject_id) = 'sent' THEN 'done' ELSE 'cancelled' END,
        closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE dedupe_key = 'message_delivery:' || ? AND status = 'open'
        AND (SELECT status FROM scheduled_guest_messages WHERE id = ?) IN ('sent', 'cancelled', 'skipped')`,
    params: [now, now, messageId, messageId],
  }]
}

/** The operation an accepted opportunity asked for is recorded: its task is done. */
export function opportunityDoneQuery(organizationId: string, operations: readonly string[], subjectId: string, now: string): BatchQuery {
  return {
    query: `UPDATE tasks SET status = 'done', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND kind = 'opportunity' AND status = 'open' AND opportunity_id IN (
        SELECT id FROM opportunities WHERE organization_id = ? AND subject_id = ? AND operation IN (SELECT value FROM json_each(?)))`,
    params: [now, now, organizationId, organizationId, subjectId, d1JsonStringSet(operations)],
  }
}

// ---------------------------------------------------------------------------
// Who may see and act on a task.
// ---------------------------------------------------------------------------

export interface TaskViewer { principal: MemberAccessPrincipal; manage: boolean; memberId: string }

export async function taskViewer(db: DbClient, principal: MemberAccessPrincipal): Promise<TaskViewer> {
  await assertRoleAllows({ ...principal, permissions: { task: ['read'] } })
  const member = await queryFirst<{ id: string }>(db, 'SELECT id FROM member WHERE organizationId = ? AND userId = ?', [principal.organizationId, principal.userId])
  if (!member) fail(404, 'MEMBER_NOT_FOUND', 'You are not a member of this organization')
  return { principal, manage: await roleAllows({ ...principal, permissions: { task: ['assign'] } }), memberId: member.id }
}

/** A member reads the tasks given to them or their team, the home work at homes they look after, and the replies in conversations they handle. */
function scopeSql(viewer: TaskViewer, alias = 't'): { sql: string; params: unknown[] } {
  if (viewer.manage) return { sql: '1 = 1', params: [] }
  const conversation = assignedGuestThreadScope('r', viewer.principal.userId)
  return {
    sql: `(${alias}.assigned_member_id = ?
      OR EXISTS (SELECT 1 FROM team tt JOIN teamMember tm ON tm.teamId = tt.id WHERE tt.id = ${alias}.assigned_team_id AND tt.organizationId = ${alias}.organization_id AND tm.userId = ?)
      OR (${alias}.kind IN ('turnover', 'custom', 'opportunity') AND EXISTS (SELECT 1 FROM product_stay_configs c WHERE c.organization_id = ${alias}.organization_id AND c.product_id = ${alias}.product_id AND ${assignedResponsibilitySql('c')}))
      OR (${alias}.kind = 'guest_reply' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = ${alias}.subject_id AND r.organization_id = ${alias}.organization_id AND ${conversation.sql})))`,
    params: [viewer.memberId, viewer.principal.userId, viewer.principal.userId, viewer.principal.userId, ...conversation.params],
  }
}

async function readTaskRow(db: DbClient, viewer: TaskViewer, taskId: string): Promise<TaskRow> {
  const scope = scopeSql(viewer)
  const row = await queryFirst<TaskRow>(db, `SELECT t.* FROM tasks t WHERE t.organization_id = ? AND t.id = ? AND ${scope.sql}`, [viewer.principal.organizationId, taskId, ...scope.params])
  if (!row) fail(404, 'TASK_NOT_FOUND', 'Task not found')
  return row
}

// ---------------------------------------------------------------------------
// The view model every client renders as is.
// ---------------------------------------------------------------------------

export interface TaskPerson { type: 'member' | 'team'; id: string; name: string; initial: string; you: boolean }
export interface TaskPhoto { id: string; url: string; thumbnailUrl: string; width: number | null; height: number | null }
/** One side of a turnover: when, and who. */
export interface TaskSheetSide { label: 'Checkout' | 'Check-in'; time: string; guest: string | null }
/**
 * A task as the one `.tc` card draws it, every string formatted here so web
 * and the app compose nothing. `face` picks the card: a photo card (a turnover
 * or a task at a home, ending in Done) or a compact card (a reply, a failed
 * message or a task without a home).
 */
export interface TaskView {
  id: string
  kind: TaskKind
  status: TaskStatus
  version: number
  face: 'photo' | 'compact'
  /** The label on a photo card's picture: "Turnover". */
  tag: string | null
  /** The home's picture: a photo card's media, a compact card's square avatar. */
  imageUrl: string | null
  /** A compact card's round avatar when there is a person rather than a home. */
  avatar: { initial: string; tone: 'warm' | 'cool' } | null
  /** The linked reservation on an open guest reply, when the viewer can read it. */
  reservation?: {
    dateLabel: string
    groupHeadline: string
    homeName: string
    statusLabel: string
    guestImageUrl: string | null
    conversation: { label: string; description: string | null; to: string } | null
  }
  /** The grey line above the title: "Arriving tomorrow · 45B", "Asked 2h ago · Penthouse", "Done at 11:48 AM · 1 photo". Never repeats the section's day. */
  statusLine: string | null
  /** The place, person or task, at 18 semibold, wrapping. */
  title: string
  /** A photo card's time, right of the title: "11:00 AM – 3:00 PM", "From 11:00 AM". */
  when: string | null
  /** One line of context: "Alberto out · Derek in", the guest's question. */
  detail: string | null
  /** What our record says went wrong, in red: "Check-in instructions didn’t send". */
  error: string | null
  /** What the person who closed it found, already quoted. */
  note: string | null
  /** Who the footer shows: the assignee while open, the person who closed it after. */
  person: TaskPerson | null
  assignee: TaskPerson | null
  /** Done (black, the only black), a grey pill that opens the subject, or the filled check that undoes Done. */
  action: { type: 'complete'; label: 'Done' } | { type: 'open'; label: string; path: string } | { type: 'reopen'; label: 'Undo Done' } | null
  /** The task sheet. A turnover has its Checkout | Check-in split. */
  sheet: { heading: string; title: string; date: string | null; checkout: TaskSheetSide | null; checkin: TaskSheetSide | null }
  startsAt: string | null
  dueAt: string | null
  timezone: string
  /** The owner's instructions. */
  notes: string | null
  outcome: { note: string | null; photos: TaskPhoto[]; closedAt: string; closedBy: string | null } | null
  /** The dashboard page of the task's subject, when it has one. */
  path: string | null
  productId: string | null
  locationId: string | null
  stayId: string | null
  requestId: string | null
  can: { complete: boolean; skip: boolean; reopen: boolean; assign: boolean; edit: boolean }
}

/** A run of cards: Today's open work has no header; "Done"; Upcoming's "Tomorrow" with "Sat, Nov 7" in grey. */
export interface TaskSection { id: string; title: string | null; subtitle: string | null; tasks: TaskView[] }

interface StayFacts { id: string; product_id: string; guest_name: string | null; adults: number; children: number; check_in_date: string; check_out_date: string; request_id: string | null }
interface StayContextFacts extends StayFacts {
  guest_surname: string | null
  guest_image_url: string | null
  home_timezone: string | null
  arrival_time: string | null
  check_in_time: string | null
  check_out_time: string | null
  status: StayWindow['status']
  no_show_at: string | null
  channel: StayChannel
  overbooked: number
  same_day_arrival: number
}
interface Context {
  slug: string
  people: Map<string, { name: string; userId: string }>
  teams: Map<string, string>
  users: Map<string, string>
  products: Map<string, { name: string; imageUrl: string | null }>
  locations: Map<string, string>
  stays: Map<string, StayFacts>
  replyStays: Map<string, StayContextFacts>
  arrivals: Map<string, StayFacts | null>
  requests: Map<string, { guest_name: string | null; participant: string | null; preview: string | null; asked_at: string | null }>
  messages: Map<string, { title: string; status: string; request_id: string | null; stay_id: string }>
  /** A booking's or reservation's conversation and when it is. */
  records: Map<string, { request_id: string | null; starts_at: string }>
  /** The entry a change task is about. */
  entries: Map<string, { event_name: string; actor_kind: string; body: string | null }>
  photos: Map<string, TaskPhoto[]>
}

async function loadContext(db: DbClient, viewer: TaskViewer, rows: TaskRow[]): Promise<Context> {
  const organizationId = viewer.principal.organizationId
  const ids = (pick: (row: TaskRow) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const recordIds = ids(row => row.subject_type === 'booking' || row.subject_type === 'reservation' ? row.subject_id : null)
  const records = await queryAll<{ id: string; request_id: string | null; starts_at: string }>(db, `
    SELECT b.id, b.request_id, ps.starts_at FROM bookings b JOIN product_sessions ps ON ps.id = b.product_session_id AND ps.organization_id = b.organization_id
     WHERE b.organization_id = ? AND b.id IN (SELECT value FROM json_each(?))
    UNION ALL SELECT v.id, v.request_id, v.starts_at FROM reservations v WHERE v.organization_id = ? AND v.id IN (SELECT value FROM json_each(?))`,
  [organizationId, d1JsonStringSet(recordIds), organizationId, d1JsonStringSet(recordIds)])
  const changeStays = rows.filter(row => row.kind === 'booking_change' && row.subject_type === 'stay').map(row => row.subject_id!)
  const changeStayRequests = changeStays.length ? await queryAll<{ request_id: string | null }>(db, 'SELECT request_id FROM stays WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(changeStays)]) : []
  const entryIds = rows.filter(row => row.kind === 'booking_change').map(row => row.dedupe_key.slice('booking_change:'.length))
  const entries = entryIds.length ? await queryAll<{ id: string; event_name: string; actor_kind: string; body: string | null }>(db, 'SELECT id, event_name, actor_kind, body FROM activity_entries WHERE id IN (SELECT value FROM json_each(?))', [d1JsonStringSet(entryIds)]) : []
  const requestIds = [...new Set([...ids(row => row.subject_type === 'request' ? row.subject_id : null),
    ...records.flatMap(record => record.request_id ? [record.request_id] : []), ...changeStayRequests.flatMap(stay => stay.request_id ? [stay.request_id] : [])])]
  const messageIds = ids(row => row.subject_type === 'scheduled_guest_message' ? row.subject_id : null)
  // Stay writers load this module; the conversation repository is loaded when a view is drawn.
  const { guestEntryAskedAtSql } = await import('~/server/domain/guest-threads/repository')
  const [organization, members, teams, locations, requests, messages, photos] = await Promise.all([
    queryFirst<{ slug: string }>(db, 'SELECT slug FROM organization WHERE id = ?', [organizationId]),
    queryAll<{ id: string; userId: string; name: string }>(db, 'SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?', [organizationId]),
    queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM team WHERE organizationId = ?', [organizationId]),
    queryAll<{ id: string; title: string }>(db, 'SELECT id, title FROM business_locations WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(ids(row => row.location_id))]),
    queryAll<{ id: string; guest_name: string | null; participant: string | null; preview: string | null; asked_at: string | null }>(db, `
      SELECT r.id, json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.participant.title') AS participant,
        (SELECT CASE WHEN e.kind = 'submission' THEN json_extract(r.payload_json, '$.message') ELSE e.body END FROM activity_entries e JOIN tasks t ON t.subject_id = r.id AND t.kind = 'guest_reply'
          WHERE e.id = substr(t.dedupe_key, length('guest_reply:' || r.id || ':') + 1) ORDER BY t.created_at DESC LIMIT 1) AS preview,
        (SELECT ${guestEntryAskedAtSql('e')} FROM activity_entries e JOIN tasks t ON t.subject_id = r.id AND t.kind = 'guest_reply'
          WHERE e.id = substr(t.dedupe_key, length('guest_reply:' || r.id || ':') + 1) ORDER BY t.created_at DESC LIMIT 1) AS asked_at
      FROM requests r WHERE r.organization_id = ? AND r.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(requestIds)]),
    queryAll<{ id: string; template_title: string; status: string; request_id: string | null; stay_id: string }>(db,
      'SELECT id, template_title, status, request_id, stay_id FROM scheduled_guest_messages WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(messageIds)]),
    listMessagePhotos(db, 'task', rows.map(row => row.id)),
  ])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const stayIds = [...new Set([...ids(row => row.subject_type === 'stay' ? row.subject_id : null), ...messages.map(message => message.stay_id)])]
  const openReplies = ids(row => row.kind === 'guest_reply' && row.status === 'open' ? row.subject_id : null)
  const replyRequests = openReplies.length && await roleAllows({ ...viewer.principal, permissions: { operations: ['update'] } }) ? openReplies : []
  const stays = await queryAll<StayContextFacts>(db, `
    SELECT s.id, s.product_id, s.guest_name, s.guest_surname, s.adults, s.children, s.check_in_date, s.check_out_date,
      s.request_id, s.status, s.no_show_at, s.channel, s.overbooked, u.image AS guest_image_url, l.timezone AS home_timezone,
      s.arrival_time, c.check_in_time, c.check_out_time, EXISTS (
        SELECT 1 FROM stays next WHERE next.organization_id = s.organization_id AND next.product_id = s.product_id
          AND next.status = 'confirmed' AND next.id <> s.id AND next.check_in_date = s.check_out_date
      ) AS same_day_arrival
    FROM stays s
    LEFT JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
    LEFT JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
    LEFT JOIN user u ON u.id = s.user_id
    WHERE s.organization_id = ? AND (s.id IN (SELECT value FROM json_each(?)) OR s.request_id IN (SELECT value FROM json_each(?)))`,
  [organizationId, d1JsonStringSet(stayIds), d1JsonStringSet(replyRequests)])
  const productIds = [...new Set([...ids(row => row.product_id), ...stays.map(stay => stay.product_id)])]
  const [products, pictures] = await Promise.all([
    queryAll<{ id: string; name: string | null }>(db, `
      SELECT p.id, CASE WHEN p.kind = 'stay' THEN c.internal_name ELSE p.name END AS name
      FROM products p LEFT JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
      WHERE p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(productIds)]),
    loadOwnerPictures(db, organizationId, 'product', productIds, { organizationFallback: false }),
  ])
  // The next guests at the home, for the turnovers shown.
  const arrivals = new Map<string, StayFacts | null>()
  for (const row of rows.filter(row => row.kind === 'turnover' && row.product_id !== null)) {
    const stay = stays.find(item => item.id === row.subject_id)
    if (!stay) continue
    arrivals.set(row.id, await queryFirst<StayFacts>(db, `SELECT id, product_id, guest_name, adults, children, check_in_date, check_out_date, request_id FROM stays WHERE organization_id = ? AND product_id = ? AND status = 'confirmed'
      AND id <> ? AND check_in_date >= ? ORDER BY check_in_date, id LIMIT 1`, [organizationId, row.product_id, stay.id, stay.check_out_date]) ?? null)
  }
  return {
    slug: organization.slug,
    people: new Map(members.map(member => [member.id, { name: member.name, userId: member.userId }])),
    teams: new Map(teams.map(team => [team.id, team.name])),
    users: new Map(members.map(member => [member.userId, member.name])),
    products: new Map(products.map(product => {
      if (!product.name?.trim()) throw new Error(`Product ${product.id} has no name for this task`)
      return [product.id, { name: product.name, imageUrl: pictures.get(product.id)?.imageUrl ?? null }]
    })),
    locations: new Map(locations.map(location => [location.id, location.title])),
    stays: new Map(stays.map(stay => [stay.id, stay])),
    replyStays: new Map(stays.flatMap(stay => stay.request_id && replyRequests.includes(stay.request_id) ? [[stay.request_id, stay]] : [])),
    arrivals,
    requests: new Map(requests.map(request => [request.id, request])),
    messages: new Map(messages.map(message => [message.id, { title: message.template_title, status: message.status, request_id: message.request_id, stay_id: message.stay_id }])),
    records: new Map(records.map(record => [record.id, { request_id: record.request_id, starts_at: record.starts_at }])),
    entries: new Map(entries.map(entry => [entry.id, { event_name: entry.event_name, actor_kind: entry.actor_kind, body: entry.body }])),
    photos: new Map([...photos].map(([id, list]) => [id, list.map(photo => ({ id: photo.id, url: photo.url, thumbnailUrl: photo.thumbnailUrl, width: photo.width, height: photo.height }))])),
  }
}

const guests = (party: { adults: number; children: number }) => {
  const count = party.adults + party.children
  return `${count} ${count === 1 ? 'guest' : 'guests'}`
}

function relative(from: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

const initialOf = (name: string) => name.trim().charAt(0).toUpperCase()

function present(row: TaskRow, viewer: TaskViewer, context: Context, now: Date): TaskView {
  const zone = row.timezone
  const today = localDateAt(now, zone)
  const time = (instant: string) => formatTimestamp(instant, 'en', zone, { hour: 'numeric', minute: '2-digit' })
  const day = (instant: string) => formatTimestamp(instant, 'en', zone, { weekday: 'short', month: 'short', day: 'numeric' })
  const calendarDay = (date: string) => formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
  const sameDay = (a: string, b: string) => localDateAt(new Date(a), zone) === localDateAt(new Date(b), zone)
  const product = row.product_id ? context.products.get(row.product_id) ?? null : null
  const place = product?.name ?? (row.location_id ? context.locations.get(row.location_id) ?? null : null)
  const personOf = (memberId: string | null, teamId: string | null): TaskPerson | null => {
    const member = memberId ? context.people.get(memberId) : null
    if (memberId && member) return { type: 'member', id: memberId, name: member.userId === viewer.principal.userId ? 'You' : member.name, initial: initialOf(member.name), you: member.userId === viewer.principal.userId }
    const team = teamId ? context.teams.get(teamId) : null
    return teamId && team ? { type: 'team', id: teamId, name: team, initial: initialOf(team), you: false } : null
  }
  const assignee = personOf(row.assigned_member_id, row.assigned_team_id)
  const closerName = row.closed_by_user_id === null ? null : row.closed_by_user_id === viewer.principal.userId ? 'You' : context.users.get(row.closed_by_user_id) ?? 'A former member'
  const closer: TaskPerson | null = closerName === null ? null : { type: 'member', id: row.closed_by_user_id!, name: closerName, initial: initialOf(closerName === 'You' ? context.users.get(row.closed_by_user_id!) ?? 'Y' : closerName), you: closerName === 'You' }
  const conversation = (requestId: string | null) => requestId ? guestConversationPath(context.slug, requestId) : null
  const stayPath = (stayId: string) => `/dashboard/${encodeURIComponent(context.slug)}/bookings/stay/${encodeURIComponent(stayId)}`
  const who = (name: string | null) => name ? firstName(name) : 'Guest'
  let face: TaskView['face'] = product ? 'photo' : 'compact', tag: string | null = null, avatar: TaskView['avatar'] = null
  let statusLine: string | null = null, title = '', when: string | null = null, detail: string | null = null, error: string | null = null, path: string | null = null
  let stayId: string | null = null, requestId: string | null = null
  let reservation: TaskView['reservation']
  let action: TaskView['action'] = { type: 'complete', label: 'Done' }
  let sheet: TaskView['sheet'] = { heading: 'Task', title: '', date: null, checkout: null, checkin: null }
  switch (row.kind) {
    case 'turnover': {
      const stay = context.stays.get(row.subject_id!)
      if (!stay || !product) throw new Error(`Turnover ${row.id} has no stay or home`)
      stayId = stay.id
      face = 'photo'
      tag = 'Turnover'
      title = product.name
      const next = context.arrivals.get(row.id) ?? null
      const sameDayArrival = next !== null && (row.starts_at !== null && row.due_at !== null
        ? sameDay(row.starts_at, row.due_at)
        : stay.check_out_date === next.check_in_date)
      const checkoutTime = row.starts_at === null ? 'Time not set' : time(row.starts_at)
      const checkinTime = row.due_at === null ? 'Time not set' : time(row.due_at)
      when = sameDayArrival && row.due_at !== null ? `${checkoutTime} – ${checkinTime}` : row.starts_at === null ? 'Time not set' : `From ${checkoutTime}`
      detail = [`${who(stay.guest_name)} out`, next === null ? null : sameDayArrival ? `${who(next.guest_name)} in` : `Next guest ${calendarDay(next.check_in_date)}`].filter(Boolean).join(' · ')
      path = viewer.manage ? stayPath(stay.id) : null
      sheet = { heading: 'Turnover', title: product.name, date: row.starts_at === null ? calendarDay(stay.check_out_date) : day(row.starts_at),
        checkout: { label: 'Checkout', time: checkoutTime, guest: who(stay.guest_name) },
        checkin: next === null ? null : { label: 'Check-in', time: sameDayArrival ? checkinTime : `${calendarDay(next.check_in_date)}, ${checkinTime}`, guest: `${who(next.guest_name)} · ${guests(next)}` } }
      break
    }
    case 'guest_reply': {
      const request = context.requests.get(row.subject_id!)
      if (!request) throw new Error(`Reply task ${row.id} has no conversation`)
      requestId = row.subject_id
      face = 'compact'
      // A guest by their first name; a channel conversation with no guest identity by the channel's own title.
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      avatar = { initial: initialOf(title), tone: 'warm' }
      statusLine = [`Asked ${relative(request.asked_at ?? row.created_at, now)}`, place].filter(Boolean).join(' · ')
      detail = request.preview?.trim() || null
      path = conversation(row.subject_id)
      action = { type: 'open', label: 'Reply', path: path! }
      sheet = { heading: 'Reply', title, date: null, checkout: null, checkin: null }
      const stay = row.status === 'open' ? context.replyStays.get(row.subject_id!) : undefined
      if (stay) {
        const home = context.products.get(stay.product_id)
        if (!home || !stay.home_timezone) throw new Error(`Stay ${stay.id} has no home or timezone`)
        stayId = stay.id
        const localDay = localDateAt(now, stay.home_timezone)
        let statusLabel: string
        if (stay.status === 'cancelled') statusLabel = 'Cancelled'
        else if (stay.no_show_at !== null) statusLabel = 'No-show recorded'
        else if (stay.status === 'pending') statusLabel = 'Pending confirmation'
        else if (localDay > stay.check_out_date) statusLabel = 'Stay ended'
        else if (localDay <= stay.check_in_date) {
          const clock = stay.arrival_time ?? stay.check_in_time
          statusLabel = `Checking in · ${clock === null ? 'Time not set' : formatTime(clock, 'en')}`
        } else if (localDay === stay.check_out_date) {
          const clock = stay.check_out_time === null ? 'Time not set' : formatTime(stay.check_out_time, 'en')
          statusLabel = stay.same_day_arrival ? `Checking out · Next guests arrive the same day · ${clock}` : `Checking out · ${clock}`
        } else statusLabel = 'Currently hosting'
        const guest = [stay.guest_name, stay.guest_surname].filter(Boolean).join(' ')
        const partySize = stay.adults + stay.children
        reservation = {
          dateLabel: `${formatCalendarDate(stay.check_in_date, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(stay.check_out_date, 'en', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          groupHeadline: stay.guest_name && partySize > 1 ? `${firstName(stay.guest_name)}’s group of ${partySize}` : guest || `Name not provided by ${STAY_CHANNEL_LABELS[stay.channel]}`,
          homeName: home.name,
          statusLabel: stay.overbooked ? `Overbooked · ${statusLabel}` : statusLabel,
          guestImageUrl: stay.guest_image_url,
          conversation: { label: action.label, description: detail, to: action.path },
        }
      }
      break
    }
    case 'message_delivery': {
      const message = context.messages.get(row.subject_id!)
      const stay = message ? context.stays.get(message.stay_id) : undefined
      if (!message || !stay) throw new Error(`Delivery task ${row.id} has no scheduled message or stay`)
      requestId = message.request_id
      stayId = message.stay_id
      face = 'compact'
      avatar = { initial: initialOf(who(stay.guest_name)), tone: 'cool' }
      const home = context.products.get(stay.product_id)?.name ?? null
      const arrival = stay.check_in_date > today
        ? stay.check_in_date === addLocalDays(today, 1) ? 'Arriving tomorrow' : `Arriving ${calendarDay(stay.check_in_date)}`
        : stay.check_in_date === today ? 'Arriving today' : stay.check_out_date > today ? 'Staying now' : `Checked out ${calendarDay(stay.check_out_date)}`
      statusLine = [arrival, home].filter(Boolean).join(' · ')
      title = who(stay.guest_name)
      // Only what our own record knows: the message, and whether its sending was refused or is unconfirmed.
      error = `${message.title} didn’t send`
      detail = message.status === 'needs_review' ? 'We could not confirm it was delivered. Check the conversation before sending it again.' : 'You can send it yourself from the conversation.'
      path = conversation(message.request_id) ?? stayPath(message.stay_id)
      action = { type: 'open', label: message.request_id ? 'Open conversation' : 'Open stay', path }
      sheet = { heading: 'Message', title, date: null, checkout: null, checkin: null }
      break
    }
    case 'booking_review': {
      const record = context.records.get(row.subject_id!)
      const request = record?.request_id ? context.requests.get(record.request_id) : undefined
      if (!record?.request_id || !request) throw new Error(`Review task ${row.id} has no booking conversation`)
      requestId = record.request_id
      face = 'compact'
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      avatar = { initial: initialOf(title), tone: 'warm' }
      statusLine = ['Waiting for your approval', place].filter(Boolean).join(' · ')
      detail = `${day(record.starts_at)}, ${time(record.starts_at)}`
      path = bookingEditorPath(context.slug, 'booking', record.request_id)
      action = { type: 'open', label: 'Review', path }
      sheet = { heading: 'Booking request', title, date: day(record.starts_at), checkout: null, checkin: null }
      break
    }
    case 'booking_change': {
      const entry = context.entries.get(row.dedupe_key.slice('booking_change:'.length))
      const stay = row.subject_type === 'stay' ? context.stays.get(row.subject_id!) : undefined
      const record = row.subject_type === 'stay' ? null : context.records.get(row.subject_id!)
      requestId = stay?.request_id ?? record?.request_id ?? null
      const request = requestId ? context.requests.get(requestId) : undefined
      if (!entry || !requestId || !request) throw new Error(`Change task ${row.id} has no change or conversation`)
      stayId = stay?.id ?? null
      face = 'compact'
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      avatar = { initial: initialOf(title), tone: 'cool' }
      const refused = entry.event_name === 'calendar_sync.move_refused'
      const waiting = !refused && entry.actor_kind !== 'guest' && row.starts_at !== null && row.starts_at > now.toISOString()
      statusLine = [refused ? 'Google Calendar move refused' : entry.actor_kind === 'guest' ? 'Change requested' : waiting ? 'Change proposal waiting on the guest' : 'Change proposal expired', place].filter(Boolean).join(' · ')
      detail = refused ? entry.body : record ? `${day(record.starts_at)}, ${time(record.starts_at)}` : null
      path = conversation(requestId)
      // A refused move needs only acknowledgement; a change closes when it is answered or proposed again.
      action = refused ? { type: 'complete', label: 'Done' } : { type: 'open', label: 'Review', path: path! }
      sheet = { heading: 'Change', title, date: null, checkout: null, checkin: null }
      break
    }
    case 'opportunity':
      face = 'compact'
      statusLine = ['Accepted opportunity', place].filter(Boolean).join(' · ')
      title = row.title!
      detail = row.notes
      sheet = { heading: 'Task', title, date: row.due_at ? day(row.due_at) : null, checkout: null, checkin: null }
      break
    case 'custom':
      face = 'compact'
      statusLine = ['Task', place].filter(Boolean).join(' · ')
      title = row.title!
      detail = row.notes
      sheet = { heading: 'Task', title, date: row.due_at ? day(row.due_at) : null, checkout: null, checkin: null }
      break
  }
  const photos = context.photos.get(row.id) ?? []
  if (row.status !== 'open') {
    // A finished card is compact, with the home as its avatar and what was found.
    face = 'compact'
    tag = null
    when = null
    error = null
    const at = sameDay(row.closed_at!, now.toISOString()) ? time(row.closed_at!) : day(row.closed_at!)
    statusLine = [`${row.status === 'done' ? 'Done' : row.status === 'skipped' ? 'Skipped' : 'Cancelled'} at ${at}`, photos.length ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}` : null].filter(Boolean).join(' · ')
    detail = null
  }
  const mine = assignee?.you ?? false
  const reachable = viewer.manage || mine || row.assigned_team_id !== null || row.kind === 'turnover' || row.kind === 'custom' || row.kind === 'opportunity' || row.kind === 'booking_change'
  const personClosed = (row.status === 'done' || row.status === 'skipped') && row.closed_by_user_id !== null
  const can = {
    complete: row.status === 'open' && action?.type === 'complete' && reachable,
    skip: row.status === 'open' && reachable,
    reopen: personClosed && (viewer.manage || row.closed_by_user_id === viewer.principal.userId),
    assign: viewer.manage && row.status === 'open',
    edit: viewer.manage && row.status === 'open',
  }
  if (row.status !== 'open') action = can.reopen ? { type: 'reopen', label: 'Undo Done' } : null
  else if (action.type === 'complete' && !can.complete) action = null
  return {
    id: row.id, kind: row.kind, status: row.status, version: row.version,
    face, tag, imageUrl: product?.imageUrl ?? null, avatar, statusLine, title, when, detail, error,
    ...(reservation ? { reservation } : {}),
    note: row.outcome_note ? `“${row.outcome_note}”` : null,
    person: row.status === 'open' ? assignee : closer, assignee, action, sheet,
    startsAt: row.starts_at, dueAt: row.due_at, timezone: zone, notes: row.notes,
    outcome: row.status === 'open' ? null : { note: row.outcome_note, photos, closedAt: row.closed_at!, closedBy: closerName },
    path, productId: row.product_id, locationId: row.location_id, stayId, requestId, can,
  }
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export interface TaskListQuery { range: 'today' | 'upcoming'; assignee: 'me' | 'all' | string; locationId?: string; status?: TaskStatus; kind?: TaskKind }

const STATUSES: readonly TaskStatus[] = ['open', 'done', 'skipped', 'cancelled']

export function parseTaskListQuery(query: Record<string, unknown>, defaults: Partial<TaskListQuery> = {}): TaskListQuery {
  const read = (key: string) => typeof query[key] === 'string' && query[key] !== '' ? String(query[key]) : undefined
  const range = read('range') ?? defaults.range ?? 'today'
  if (range !== 'today' && range !== 'upcoming') fail(400, 'INVALID_TASK_QUERY', 'range must be today or upcoming', 'range')
  const status = read('status')
  if (status !== undefined && !STATUSES.includes(status as TaskStatus)) fail(400, 'INVALID_TASK_QUERY', 'status must be open, done, skipped or cancelled', 'status')
  const kind = read('kind')
  if (kind !== undefined && !TASK_KINDS.includes(kind as TaskKind)) fail(400, 'INVALID_TASK_QUERY', `kind must be one of ${TASK_KINDS.join(', ')}`, 'kind')
  return { range, assignee: read('assignee') ?? defaults.assignee ?? 'all', locationId: read('locationId'), status: status as TaskStatus | undefined, kind: kind as TaskKind | undefined }
}

/** Today's open work in the owner's order: failed deliveries, turnovers, replies, then everything else. */
const TODAY_ORDER: Record<TaskKind, number> = { message_delivery: 0, turnover: 1, guest_reply: 2, booking_review: 2, booking_change: 2, custom: 3, opportunity: 3 }

/** Today: open work due or starting today or earlier, or with no date; then what was closed today. Upcoming: open work later than today, by day. */
export async function listTasks(db: DbClient, viewer: TaskViewer, query: TaskListQuery, now = new Date()): Promise<{ sections: TaskSection[]; resolvedAt: string }> {
  const organizationId = viewer.principal.organizationId
  const scope = scopeSql(viewer)
  const filters: string[] = []
  const params: unknown[] = []
  if (query.assignee === 'me') {
    filters.push(`(t.assigned_member_id = ? OR EXISTS (SELECT 1 FROM team tt JOIN teamMember tm ON tm.teamId = tt.id WHERE tt.id = t.assigned_team_id AND tt.organizationId = t.organization_id AND tm.userId = ?))`)
    params.push(viewer.memberId, viewer.principal.userId)
  } else if (query.assignee !== 'all') {
    if (!viewer.manage && query.assignee !== viewer.memberId) fail(403, 'TASK_SCOPE_DENIED', 'You can list your own tasks only', 'assignee')
    filters.push('t.assigned_member_id = ?')
    params.push(query.assignee)
  }
  if (query.locationId) { filters.push('t.location_id = ?'); params.push(query.locationId) }
  if (query.kind) { filters.push('t.kind = ?'); params.push(query.kind) }
  // Closed work is shown on the day it was closed; two days covers every zone's today.
  const closedSince = new Date(now.getTime() - 2 * 86_400_000).toISOString()
  const statusSql = query.status ? 't.status = ?' : `(t.status = 'open' OR (? = 'today' AND t.status IN ('done', 'skipped') AND t.closed_at >= ?))`
  const statusParams = query.status ? [query.status] : [query.range, closedSince]
  const rows = await queryAll<TaskRow & { checkout_date: string | null }>(db, `SELECT t.*, s.check_out_date AS checkout_date FROM tasks t
    LEFT JOIN stays s ON t.kind = 'turnover' AND t.starts_at IS NULL AND s.organization_id = t.organization_id AND s.id = t.subject_id
    WHERE t.organization_id = ? AND ${scope.sql} AND ${statusSql}${filters.map(sql => ` AND ${sql}`).join('')}
    ORDER BY COALESCE(t.starts_at, t.due_at, t.created_at), t.id`, [organizationId, ...scope.params, ...statusParams, ...params])
  const today = (row: TaskRow) => localDateAt(now, row.timezone)
  const dayOf = (instant: string | null, row: TaskRow) => instant === null ? null : localDateAt(new Date(instant), row.timezone)
  const startsOn = (row: typeof rows[number]) => {
    if (row.starts_at !== null || row.kind !== 'turnover') return dayOf(row.starts_at, row)
    if (row.checkout_date === null) throw new Error(`Turnover ${row.id} has no stay`)
    return row.checkout_date
  }
  const isToday = (row: typeof rows[number]) => {
    if (row.status !== 'open') return dayOf(row.closed_at, row) === today(row)
    const start = startsOn(row), due = dayOf(row.due_at, row)
    if (start === null && due === null) return true
    return (start !== null && start <= today(row)) || (due !== null && due <= today(row))
  }
  const shown = rows.filter(row => query.range === 'today' ? isToday(row) : row.status === 'open' && !isToday(row))
  const context = await loadContext(db, viewer, shown)
  const views = shown.map(row => ({ row, view: present(row, viewer, context, now) }))
  const resolvedAt = now.toISOString()
  if (query.range === 'today') {
    const open = views.filter(item => item.row.status === 'open').sort((a, b) => TODAY_ORDER[a.row.kind] - TODAY_ORDER[b.row.kind]).map(item => item.view)
    const closed = views.filter(item => item.row.status !== 'open').sort((a, b) => b.row.closed_at!.localeCompare(a.row.closed_at!)).map(item => item.view)
    return { resolvedAt, sections: [
      ...(open.length ? [{ id: 'open', title: null, subtitle: null, tasks: open }] : []),
      ...(closed.length ? [{ id: 'done', title: 'Done', subtitle: null, tasks: closed }] : []),
    ] }
  }
  const byDay = new Map<string, TaskSection>()
  for (const { row, view } of views) {
    const date = startsOn(row) ?? dayOf(row.due_at, row)!
    const tomorrow = date === addLocalDays(today(row), 1)
    const section = byDay.get(date) ?? {
      id: date,
      title: tomorrow ? 'Tomorrow' : formatCalendarDate(date, 'en', { weekday: 'long' }),
      subtitle: formatCalendarDate(date, 'en', tomorrow ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' }),
      tasks: [],
    }
    section.tasks.push(view)
    byDay.set(date, section)
  }
  return { resolvedAt, sections: [...byDay.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

/** The people and teams a manager can give work to; empty for anyone who cannot assign. */
export async function listTaskAssignees(db: DbClient, viewer: TaskViewer): Promise<TaskPerson[]> {
  if (!viewer.manage) return []
  const organizationId = viewer.principal.organizationId
  const [members, teams] = await Promise.all([
    queryAll<{ id: string; userId: string; name: string }>(db, 'SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY u.name, m.id', [organizationId]),
    queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM team WHERE organizationId = ? ORDER BY name, id', [organizationId]),
  ])
  return [
    ...members.map(member => ({ type: 'member' as const, id: member.id, name: member.userId === viewer.principal.userId ? 'You' : member.name, initial: member.name.trim().charAt(0).toUpperCase(), you: member.userId === viewer.principal.userId })),
    ...teams.map(team => ({ type: 'team' as const, id: team.id, name: team.name, initial: team.name.trim().charAt(0).toUpperCase(), you: false })),
  ]
}

/** A task as an alert to one of its people tells it: the member projection, with no guest's full name or contact. */
export async function describeTaskForAlert(db: DbClient, organizationId: string, taskId: string, recipientUserId: string): Promise<{ eyebrow: string; title: string; detail: string | null; locationId: string | null }> {
  const row = await queryFirst<TaskRow>(db, 'SELECT * FROM tasks WHERE organization_id = ? AND id = ?', [organizationId, taskId])
  if (!row) throw new Error(`Task ${taskId} is not in organization ${organizationId}`)
  const viewer = { principal: { organizationId, userId: recipientUserId } as MemberAccessPrincipal, manage: false, memberId: '' }
  const view = present(row, viewer, await loadContext(db, viewer, [row]), new Date())
  return { eyebrow: [view.tag ?? view.statusLine, view.when].filter(Boolean).join(' · '), title: view.title, detail: view.detail, locationId: row.location_id }
}

export async function getTask(db: DbClient, viewer: TaskViewer, taskId: string, now = new Date()): Promise<TaskView> {
  const row = await readTaskRow(db, viewer, taskId)
  return present(row, viewer, await loadContext(db, viewer, [row]), now)
}

// ---------------------------------------------------------------------------
// What people do to tasks.
// ---------------------------------------------------------------------------

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim() && !required)) {
    if (required) fail(422, 'INVALID_TASK_FIELD', `${field} is required`, field)
    return null
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(422, 'INVALID_TASK_FIELD', `${field} must be 1 to ${max} characters`, field)
  return value.trim()
}

function instant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (!isValidInstant(value)) fail(422, 'INVALID_TASK_FIELD', `${field} must be an instant with a timezone offset`, field)
  return new Date(value as string).toISOString()
}

export async function readTaskAssignee(db: DbClient, organizationId: string, input: { assignedMemberId?: unknown; assignedTeamId?: unknown }): Promise<{ member: string | null; team: string | null }> {
  const member = input.assignedMemberId ?? null, team = input.assignedTeamId ?? null
  if (member !== null && team !== null) fail(422, 'RESPONSIBILITY_TARGET_CONFLICT', 'Choose one member or one team', 'assignedTeamId')
  if (member !== null && (typeof member !== 'string' || !await queryFirst(db, 'SELECT id FROM member WHERE organizationId = ? AND id = ?', [organizationId, member]))) {
    fail(422, 'INVALID_RESPONSIBILITY', 'The member must belong to this organization', 'assignedMemberId')
  }
  if (team !== null && (typeof team !== 'string' || !await queryFirst(db, 'SELECT id FROM team WHERE organizationId = ? AND id = ?', [organizationId, team]))) {
    fail(422, 'INVALID_RESPONSIBILITY', 'The team must belong to this organization', 'assignedTeamId')
  }
  return { member: member as string | null, team: team as string | null }
}

function taskEventQuery(viewer: TaskViewer, row: Pick<TaskRow, 'id' | 'kind' | 'location_id'>, eventType: 'task.created' | 'task.assigned' | 'task.updated' | 'task.completed' | 'task.skipped' | 'task.reopened', state: { before?: unknown; after?: unknown }, guarded = true): BatchQuery {
  return organizationEventQuery({ organizationId: viewer.principal.organizationId, locationId: row.location_id, actorId: viewer.principal.userId, eventType,
    entityType: 'task', entityId: row.id, metadata: { kind: row.kind }, beforeState: state.before, afterState: state.after, onlyIfPreviousChangedOneRow: guarded })
}

/** The assignee who should hear about a change: a member, or every member of a team. */
async function assigneeUsers(db: DbClient, organizationId: string, target: { member: string | null; team: string | null }): Promise<string[]> {
  if (target.member) return (await queryAll<{ userId: string }>(db, 'SELECT userId FROM member WHERE organizationId = ? AND id = ?', [organizationId, target.member])).map(row => row.userId)
  if (target.team) return (await queryAll<{ userId: string }>(db, 'SELECT tm.userId FROM teamMember tm JOIN team t ON t.id = tm.teamId WHERE t.organizationId = ? AND t.id = ?', [organizationId, target.team])).map(row => row.userId)
  return []
}

async function afterWrite(db: DbClient, viewer: TaskViewer, taskId: string, assigned?: { member: string | null; team: string | null }): Promise<TaskView> {
  const env = viewer.principal.env as CloudflareEnv
  if (assigned) {
    const recipients = (await assigneeUsers(db, viewer.principal.organizationId, assigned)).filter(userId => userId !== viewer.principal.userId)
    if (recipients.length) {
      const { notifyTaskAssigned } = await import('~/server/utils/notifications')
      await notifyTaskAssigned(env, db, { organizationId: viewer.principal.organizationId, taskId, actorUserId: viewer.principal.userId, recipientUserIds: recipients })
    }
  }
  await publishBusinessInvalidation(env, viewer.principal.organizationId)
  return getTask(db, viewer, taskId)
}

export async function createTask(db: DbClient, viewer: TaskViewer, body: Record<string, unknown>): Promise<{ task: TaskView; created: boolean }> {
  await assertRoleAllows({ ...viewer.principal, permissions: { task: ['create'] } })
  const organizationId = viewer.principal.organizationId
  const key = text(body.idempotencyKey, 'idempotencyKey', 200, true)!
  const title = text(body.title, 'title', 200, true)!
  const notes = text(body.notes, 'notes', 5000)
  const startsAt = instant(body.startsAt, 'startsAt'), dueAt = instant(body.dueAt, 'dueAt')
  if (startsAt && dueAt && startsAt > dueAt) fail(422, 'INVALID_TASK_FIELD', 'startsAt must not be after dueAt', 'startsAt')
  const assigned = await readTaskAssignee(db, organizationId, body)
  const productId = body.productId ?? null, locationId = body.locationId ?? null
  const place = productId !== null
    ? await queryFirst<{ location_id: string; timezone: string }>(db, `SELECT pl.location_id, l.timezone FROM products p JOIN product_locations pl ON pl.organization_id = p.organization_id AND pl.product_id = p.id
        JOIN business_locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id WHERE p.organization_id = ? AND p.id = ? ${locationId !== null ? 'AND pl.location_id = ?' : ''} ORDER BY pl.location_id LIMIT 1`,
      [organizationId, productId, ...(locationId !== null ? [locationId] : [])])
    : locationId !== null ? await queryFirst<{ location_id: string; timezone: string }>(db, 'SELECT id AS location_id, timezone FROM business_locations WHERE organization_id = ? AND id = ?', [organizationId, locationId]) : null
  if ((productId !== null || locationId !== null) && !place) fail(422, 'INVALID_TASK_FIELD', productId !== null ? 'The offering is not at that location in this organization' : 'The location is not in this organization', productId !== null ? 'productId' : 'locationId')
  const organization = await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [organizationId])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const dedupeKey = `custom:${organizationId}:${key}`
  const existing = await queryFirst<TaskRow>(db, 'SELECT * FROM tasks WHERE dedupe_key = ?', [dedupeKey])
  if (existing) {
    if (existing.title !== title || existing.notes !== notes || existing.starts_at !== startsAt || existing.due_at !== dueAt || existing.product_id !== productId || existing.created_by_user_id !== viewer.principal.userId) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different task', 'idempotencyKey')
    }
    return { task: await getTask(db, viewer, existing.id), created: false }
  }
  const id = crypto.randomUUID(), now = new Date().toISOString()
  const row = { id, kind: 'custom' as const, location_id: place?.location_id ?? null }
  await executeBatch(db, [{
    query: `INSERT INTO tasks (id, organization_id, kind, product_id, location_id, title, notes, assigned_member_id, assigned_team_id, starts_at, due_at, timezone, status, dedupe_key, version, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [id, organizationId, productId, row.location_id, title, notes, assigned.member, assigned.team, startsAt, dueAt, place?.timezone ?? organization.timezone, dedupeKey, viewer.principal.userId, now, now],
  }, taskEventQuery(viewer, row, 'task.created', { after: { title, assigned_member_id: assigned.member, assigned_team_id: assigned.team, starts_at: startsAt, due_at: dueAt } })], { operation: 'Create task' })
  const saved = await queryFirst<{ id: string }>(db, 'SELECT id FROM tasks WHERE dedupe_key = ?', [dedupeKey])
  if (saved?.id !== id) return createTask(db, viewer, body)
  return { task: await afterWrite(db, viewer, id, assigned.member || assigned.team ? assigned : undefined), created: true }
}

export async function updateTask(db: DbClient, viewer: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskView> {
  const current = await readTaskRow(db, viewer, taskId)
  const touchesAssignee = body.assignedMemberId !== undefined || body.assignedTeamId !== undefined
  await assertRoleAllows({ ...viewer.principal, permissions: { task: touchesAssignee ? ['assign'] : ['update'] } })
  if (body.expectedVersion !== current.version) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'expectedVersion')
  if (current.status !== 'open') fail(409, 'TASK_CLOSED', 'Reopen the task before changing it', 'status')
  const assigned = touchesAssignee ? await readTaskAssignee(db, viewer.principal.organizationId, body) : { member: current.assigned_member_id, team: current.assigned_team_id }
  const startsAt = body.startsAt === undefined ? current.starts_at : instant(body.startsAt, 'startsAt')
  const dueAt = body.dueAt === undefined ? current.due_at : instant(body.dueAt, 'dueAt')
  if (startsAt && dueAt && startsAt > dueAt) fail(422, 'INVALID_TASK_FIELD', 'startsAt must not be after dueAt', 'startsAt')
  const notes = body.notes === undefined ? current.notes : text(body.notes, 'notes', 5000)
  const title = body.title === undefined ? current.title : current.kind === 'custom' || current.kind === 'opportunity' ? text(body.title, 'title', 200, true) : fail(422, 'INVALID_TASK_FIELD', 'This task takes its title from what it is about', 'title')
  const after = { assigned_member_id: assigned.member, assigned_team_id: assigned.team, starts_at: startsAt, due_at: dueAt, notes, title }
  const before = { assigned_member_id: current.assigned_member_id, assigned_team_id: current.assigned_team_id, starts_at: current.starts_at, due_at: current.due_at, notes: current.notes, title: current.title }
  if (JSON.stringify(after) === JSON.stringify(before)) fail(422, 'INVALID_TASK_FIELD', 'Provide at least one change', 'task')
  const reassigned = after.assigned_member_id !== before.assigned_member_id || after.assigned_team_id !== before.assigned_team_id
  const results = await executeBatch(db, [{
    query: `UPDATE tasks SET assigned_member_id = ?, assigned_team_id = ?, starts_at = ?, due_at = ?, notes = ?, title = ?, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND status = 'open'`,
    params: [after.assigned_member_id, after.assigned_team_id, startsAt, dueAt, notes, title, new Date().toISOString(), viewer.principal.organizationId, taskId, current.version],
  }, taskEventQuery(viewer, current, reassigned ? 'task.assigned' : 'task.updated', { before, after })], { operation: 'Update task' })
  if (results[0]?.meta.changes !== 1) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'expectedVersion')
  return afterWrite(db, viewer, taskId, reassigned && (assigned.member || assigned.team) ? assigned : undefined)
}

/** Done or skipped, with what the person found and their photos. */
export async function closeTask(db: DbClient, viewer: TaskViewer, taskId: string, input: { status: 'done' | 'skipped'; note: unknown; photos: MessagePhoto[]; env: CloudflareEnv }): Promise<TaskView> {
  await assertRoleAllows({ ...viewer.principal, permissions: { task: ['complete'] } })
  const current = await readTaskRow(db, viewer, taskId)
  const context = await loadContext(db, viewer, [current])
  const view = present(current, viewer, context, new Date())
  if (current.status !== 'open') fail(409, 'TASK_CLOSED', `This task is already ${current.status}`, 'status')
  if (input.status === 'done' && !view.can.complete) fail(409, 'TASK_CLOSES_WITH_SUBJECT', 'This task is done when its subject is: open it instead', 'status')
  if (input.status === 'skipped' && !view.can.skip) fail(403, 'TASK_SCOPE_DENIED', 'You cannot skip this task', 'status')
  const note = text(input.note, 'note', 5000, input.status === 'skipped')
  const now = new Date().toISOString()
  const assetIds = input.photos.length ? await uploadMessagePhotos(db, input.env, viewer.principal.organizationId, input.photos, { source: 'uploaded', userId: viewer.principal.userId })
    .catch((error: unknown) => error instanceof MessagePhotoRejection ? fail(422, 'INVALID_PHOTO', error.message, 'photos') : Promise.reject(error)) : []
  let results: Awaited<ReturnType<typeof executeBatch>>
  try {
    results = await executeBatch(db, [{
      query: `UPDATE tasks SET status = ?, outcome_note = ?, closed_at = ?, closed_by_user_id = ?, version = version + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND version = ? AND status = 'open'`,
      params: [input.status, note, now, viewer.principal.userId, now, viewer.principal.organizationId, taskId, current.version],
    }, taskEventQuery(viewer, current, input.status === 'done' ? 'task.completed' : 'task.skipped', { after: { status: input.status, outcome_note: note, photos: assetIds.length } }),
    ...messagePhotoPlacements(viewer.principal.organizationId, 'task', taskId, assetIds, now)], { operation: input.status === 'done' ? 'Complete task' : 'Skip task' })
  } catch (error) {
    await discardMessagePhotos(db, input.env, viewer.principal.organizationId, assetIds, viewer.principal.userId, error)
    throw error
  }
  if (results[0]?.meta.changes !== 1) {
    await discardMessagePhotos(db, input.env, viewer.principal.organizationId, assetIds, viewer.principal.userId, new Error('The task changed before it was closed'))
    fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'task')
  }
  return afterWrite(db, viewer, taskId)
}

export async function reopenTask(db: DbClient, viewer: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskView> {
  const current = await readTaskRow(db, viewer, taskId)
  const view = present(current, viewer, await loadContext(db, viewer, [current]), new Date())
  if (!view.can.reopen) fail(409, 'TASK_NOT_REOPENABLE', 'Only a task a person closed can be reopened, by them or a manager', 'status')
  if (body.expectedVersion !== current.version) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'expectedVersion')
  const now = new Date().toISOString()
  const results = await executeBatch(db, [{
    query: `UPDATE tasks SET status = 'open', outcome_note = NULL, closed_at = NULL, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND status IN ('done', 'skipped')`,
    params: [now, viewer.principal.organizationId, taskId, current.version],
  }, taskEventQuery(viewer, current, 'task.reopened', { before: { status: current.status, outcome_note: current.outcome_note } }),
  { query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'task' AND owner_id = ? AND changes() = 1`, params: [viewer.principal.organizationId, taskId] }], { operation: 'Reopen task' })
  if (results[0]?.meta.changes !== 1) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'expectedVersion')
  return afterWrite(db, viewer, taskId)
}

/** The accepted opportunity's task, written in the accept's own batch. */
export function opportunityTaskInsert(input: { organizationId: string; opportunityId: string; title: string; subject: { type: TaskRow['subject_type']; id: string } | null; productId: string | null; locationId: string | null; assigned: { member: string | null; team: string | null }; dueAt: string | null; timezone: string; userId: string; now: string; taskId: string }): BatchQuery {
  return {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, opportunity_id, title, assigned_member_id, assigned_team_id, due_at, timezone, status, dedupe_key, version, created_by_user_id, created_at, updated_at)
      SELECT ?, ?, 'opportunity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ? WHERE changes() = 1`,
    params: [input.taskId, input.organizationId, input.subject?.type ?? null, input.subject?.id ?? null, input.productId, input.locationId, input.opportunityId, input.title,
      input.assigned.member, input.assigned.team, input.dueAt, input.timezone, `opportunity:${input.opportunityId}`, input.userId, input.now, input.now],
  }
}

