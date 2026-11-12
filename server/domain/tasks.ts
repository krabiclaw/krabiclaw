import { HTTPError } from 'nitro'
import type { ProductKind } from '~/shared/product-details'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedGuestThreadScope, assignedMemberSql, isOrganizationWideRole, locationMemberSql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationDedupeKey, creationRequestHash, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { publishBusinessInvalidation, publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { messageQueries } from '~/server/domain/conversations'
import { discardMessagePhotos, listMessagePhotos, messagePhotoPlacements, uploadMessagePhotos, MessagePhotoRejection, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { firstName } from '~/server/domain/guest-threads/presentation'
import { bookingEditorPath, guestConversationPath, productPaymentPath } from '~/server/utils/dashboard-links'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { addLocalDays, formatCalendarDate, formatTimestamp, isValidInstant, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { STAY_CHANNEL_LABELS, type StayChannel } from '~/shared/bookings'
import type { CloudflareEnv } from '~/server/utils/auth'
import { BOOKING_RECORDS_SQL, bookingDay, isBookingDay } from '~/server/domain/requests'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { getVerticalCopy } from '~/utils/vertical-copy'

/*
  Work someone has to do. A turnover, a guest's unanswered question and a
  failed scheduled message are opened and closed by the batch that changes
  their subject (the builders below); an accepted opportunity by its accept;
  a custom task by a person. People assign, reschedule, complete, skip and
  reopen them here, from the dashboard, MCP and the app alike.
*/

export const TASK_KINDS = ['turnover', 'guest_reply', 'message_delivery', 'booking_review', 'booking_change', 'opportunity', 'custom', 'stay_ready', 'consultation_prep', 'consultation_follow_up'] as const
export type TaskKind = typeof TASK_KINDS[number]
export type TaskStatus = 'open' | 'done' | 'skipped' | 'cancelled'

export interface TaskRow {
  id: string; organization_id: string; kind: TaskKind
  subject_type: 'conversation' | 'scheduled_guest_message' | 'booking' | 'product_session' | 'article' | 'post' | 'product' | null; subject_id: string | null
  product_id: string | null; location_id: string | null; opportunity_id: string | null
  title: string | null; notes: string | null
  assigned_member_id: string | null
  starts_at: string | null; due_at: string | null; timezone: string
  status: TaskStatus; outcome_note: string | null; closed_at: string | null; closed_by_user_id: string | null
  dedupe_key: string; version: number; created_by_user_id: string | null; created_at: string; updated_at: string
}

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, message, data: { code, ...(field ? { field } : {}) } })
}

// ---------------------------------------------------------------------------
// Cleaning jobs: a turnover, or the job to get a home ready for a guest who
// was moved there. A job given to a member is talked about in the
// stay's team conversation (server/domain/cleaner-jobs.ts): the job, its
// reminders and its changes are automatic messages there, and the person
// closes it with their own message. A job an owner or admin gives themselves
// keeps the task alert instead.
// ---------------------------------------------------------------------------

export const JOB_TASK_SQL = (alias: string) => `${alias}.kind IN ('turnover', 'stay_ready', 'consultation_follow_up')`

export function isJobTask(row: Pick<TaskRow, 'kind'>): boolean {
  return row.kind === 'turnover' || row.kind === 'stay_ready' || row.kind === 'consultation_follow_up'
}

// A private legal appointment's prep can be discussed in the one client's
// booking conversation. A group session has no booking that represents it.
const consultationBookingSql = (sessionId: string, organizationId: string) => `(
  SELECT COALESCE(
    CASE WHEN count(*) FILTER (WHERE b.status = 'confirmed') = 1 THEN max(b.id) FILTER (WHERE b.status = 'confirmed') END,
    CASE WHEN count(*) = 1 THEN min(b.id) END
  ) FROM product_sessions s JOIN products p ON p.organization_id = s.organization_id AND p.id = s.product_id
    JOIN bookings b ON b.organization_id = s.organization_id AND b.product_session_id = s.id
  WHERE s.id = ${sessionId} AND s.organization_id = ${organizationId} AND s.capacity = 1 AND p.kind = 'service'
)`

export const jobBookingIdSql = (alias: string) => `CASE
  WHEN ${alias}.subject_type = 'booking' THEN ${alias}.subject_id
  WHEN ${alias}.subject_type = 'product_session' AND ${alias}.kind = 'consultation_prep'
    THEN ${consultationBookingSql(`${alias}.subject_id`, `${alias}.organization_id`)}
END`

/** The booking a job is about, and what it holds: a home's nights (a turnover or a make-ready job) or a session's seats (a visit follow-up). */
export type JobSubject = { id: string; unit: 'slot' | 'nights' }

/** The booking a job is about, which its conversation is tied to. */
export function jobSubject(row: Pick<TaskRow, 'dedupe_key' | 'kind' | 'subject_type' | 'subject_id'>): JobSubject {
  if (!row.subject_id || row.subject_type !== 'booking') throw new Error(`Job task ${row.dedupe_key} names no booking`)
  return { id: row.subject_id, unit: row.kind === 'turnover' || row.kind === 'stay_ready' ? 'nights' : 'slot' }
}

/** The key of a job's post in its team conversation (messages.payload_json $.key): the one place it is built. */
export const jobKey = (task: Pick<TaskRow, 'id' | 'product_id'>, after?: string) => `job:${task.id}:${task.product_id}${after ? `:after:${after}` : ''}`
const JOB_END_STATES = ['released', 'cancelled', 'closed'] as const
export const jobEndKeys = (taskId: string) => JOB_END_STATES.map(state => `${state}:${taskId}`)

/** Whether a job's member hears about it in a team conversation: a member who is not an owner or admin. */
export async function jobHasConversation(db: DbClient, organizationId: string, memberId: string | null): Promise<boolean> {
  if (!memberId) return false
  const member = await queryFirst<{ role: string }>(db, 'SELECT role FROM member WHERE organizationId = ? AND id = ?', [organizationId, memberId])
  return member !== null && !isOrganizationWideRole(member.role)
}

// ---------------------------------------------------------------------------
// Subject writes. Each returns statements for the batch that changes the
// subject, so the task and its subject commit together.
// ---------------------------------------------------------------------------

/** A stay as one write leaves it: the turnover window is computed for this state. */
export interface StayWindow { id: string; product_id: string; status: 'pending' | 'confirmed' | 'cancelled'; check_in_date: string; check_out_date: string }

interface HomeClock { product_id: string; location_id: string; timezone: string; check_in_time: string | null; check_out_time: string | null; assigned_member_id: string | null }

/** A nights booking's stored ends read as the home's days. */
type StoredStay = { id: string; product_id: string; status: StayWindow['status']; starts_at: string; ends_at: string; timezone: string }
const stayWindowOf = (row: StoredStay): StayWindow => ({ id: row.id, product_id: row.product_id, status: row.status, check_in_date: bookingDay(row.starts_at, row.timezone), check_out_date: bookingDay(row.ends_at, row.timezone) })

/** A stored end on this local day: the day alone, or an instant within it. */
function storedOn(column: string, date: string, timezone: string): BatchQuery {
  return { query: `(${column} = ? OR (length(${column}) > 10 AND ${column} >= ? AND ${column} < ?))`,
    params: [date, localDateTimeToInstant(date, '00:00', timezone, 'earlier').toISOString(), localDateTimeToInstant(addLocalDays(date, 1), '00:00', timezone, 'earlier').toISOString()] }
}

/** The batch guard: the turnover statements apply only if the booking is what they were computed for, its ends on these days in its home's clock. */
function stayIs(organizationId: string, stay: StayWindow, timezone: string): BatchQuery {
  const starts = storedOn('starts_at', stay.check_in_date, timezone), ends = storedOn('ends_at', stay.check_out_date, timezone)
  return { query: `EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND product_id = ? AND status = ? AND product_session_id IS NULL AND ${starts.query} AND ${ends.query})`,
    params: [organizationId, stay.id, stay.product_id, stay.status, ...starts.params!, ...ends.params!] }
}

/** The confirmed stays at one home other than this one, checking out on or after a day (read wide, kept by their own days). */
async function confirmedStaysAt(db: DbClient, organizationId: string, productId: string, exceptId: string, checkOutOnOrAfter: string): Promise<StayWindow[]> {
  const rows = await queryAll<StoredStay>(db, `SELECT id, product_id, status, starts_at, ends_at, timezone FROM bookings
    WHERE organization_id = ? AND product_id = ? AND product_session_id IS NULL AND status = 'confirmed' AND id <> ? AND ends_at >= ?`, [organizationId, productId, exceptId, addLocalDays(checkOutOnOrAfter, -1)])
  return rows.map(stayWindowOf).filter(stay => stay.check_out_date >= checkOutOnOrAfter)
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
  const homes = [...new Set([after.product_id, ...(before ? [before.product_id] : [])])]
  const clocks = await queryAll<HomeClock>(db, `SELECT c.product_id, c.location_id, l.timezone, b.check_in_time, b.check_out_time, b.assigned_member_id
    FROM product_stay_configs c JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
    JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
    WHERE c.organization_id = ? AND c.product_id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(homes)])
  const afterHome = clocks.find(clock => clock.product_id === after.product_id)
  if (!afterHome) throw new Error(`Home ${after.product_id} has no stay settings`)
  const guard = stayIs(organizationId, after, afterHome.timezone)
  const queries: BatchQuery[] = []
  const windows = new Map<string, { stay: StayWindow; home: HomeClock; next: string | null }>()
  for (const productId of homes) {
    const home = clocks.find(clock => clock.product_id === productId)
    if (!home) throw new Error(`Home ${productId} has no stay settings`)
    const anchors = [after.product_id === productId ? after.check_in_date : null, before?.product_id === productId ? before.check_in_date : null].filter((value): value is string => value !== null)
    const earliest = anchors.reduce((min, value) => value < min ? value : min, anchors[0]!)
    const others = await confirmedStaysAt(db, organizationId, productId, after.id, addLocalDays(earliest, -400))
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
          version = version + 1, updated_at = ?
        WHERE dedupe_key = ? AND status = 'open' AND (${guard.query})
          AND (product_id IS NOT ? OR starts_at IS NOT ? OR due_at IS NOT ?)`,
      params: [home.product_id, home.location_id, home.timezone, startsAt, dueAt, home.product_id, home.assigned_member_id, now, key, ...guard.params!, home.product_id, startsAt, dueAt],
    })
    // A stay that checked out before today at its home is history, not work.
    if (stay.check_out_date >= localDateAt(new Date(now), home.timezone)) {
      queries.push({
        query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id,
            starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
          SELECT ?, ?, 'turnover', 'booking', ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ? WHERE (${guard.query})
          ON CONFLICT (dedupe_key) DO NOTHING`,
        params: [crypto.randomUUID(), organizationId, stay.id, home.product_id, home.location_id, home.assigned_member_id,
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

/**
 * An automatic message that failed or needs review is someone's work until it is sent, cancelled or skipped.
 * A member's own send-later reply that failed is shown to its author in its conversation instead.
 */
export function messageDeliveryTaskQueries(messageId: string, now: string): BatchQuery[] {
  return [{
    // The place is the booked record's (none for an online consultation).
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, m.organization_id, 'message_delivery', 'scheduled_guest_message', m.id, m.product_id,
          (SELECT b.location_id FROM bookings b WHERE b.organization_id = m.organization_id AND b.id = m.booking_id),
          m.timezone, 'open', 'message_delivery:' || m.id, 1, ?, ?
        FROM scheduled_guest_messages m
       WHERE m.id = ? AND m.status IN ('failed', 'needs_review') AND m.author_user_id IS NULL
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

/** Close matching tasks only when the preceding write or its guarded audit row committed. */
export function opportunityDoneQuery(organizationId: string, operations: readonly string[], subjectId: string, now: string): BatchQuery {
  return {
    query: `UPDATE tasks SET status = 'done', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE changes() = 1 AND organization_id = ? AND kind = 'opportunity' AND status = 'open' AND opportunity_id IN (
        SELECT id FROM opportunities WHERE organization_id = ? AND subject_id = ? AND operation IN (SELECT value FROM json_each(?)))`,
    params: [now, now, organizationId, organizationId, subjectId, d1JsonStringSet(operations)],
  }
}

// ---------------------------------------------------------------------------
// Who may see and act on a task.
// ---------------------------------------------------------------------------

/**
 * One prep task for the session's assigned member while any confirmed booking
 * still holds it. The caller supplies the affected session IDs in its write batch.
 */
export function sessionPrepTaskQueries(sessions: BatchQuery, now: string): BatchQuery[] {
  const confirmed = `EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = s.organization_id
    AND b.product_session_id = s.id AND b.status = 'confirmed' AND b.no_show_at IS NULL)`
  return [{
    query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = tasks.version + 1, updated_at = ?
      FROM product_sessions s JOIN product_booking_configs cfg ON cfg.organization_id = s.organization_id AND cfg.product_id = s.product_id
      WHERE tasks.kind = 'consultation_prep' AND tasks.subject_type = 'product_session' AND tasks.subject_id = s.id
        AND tasks.organization_id = s.organization_id AND tasks.status = 'open' AND s.id IN (${sessions.query})
        AND (s.status <> 'scheduled' OR cfg.assigned_member_id IS NULL OR NOT ${confirmed})`,
    params: [now, now, ...(sessions.params ?? [])],
  }, {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT 'session-prep:' || s.id, s.organization_id, 'consultation_prep', 'product_session', s.id, s.product_id, s.location_id,
        cfg.assigned_member_id, s.starts_at, s.starts_at, s.timezone, 'open', 'consultation_prep:session:' || s.id, 1, ?, ?
      FROM product_sessions s JOIN product_booking_configs cfg ON cfg.organization_id = s.organization_id AND cfg.product_id = s.product_id
      WHERE s.id IN (${sessions.query}) AND s.status = 'scheduled' AND s.starts_at > ? AND cfg.assigned_member_id IS NOT NULL AND ${confirmed}
      ON CONFLICT (dedupe_key) DO UPDATE SET status = 'open', closed_at = NULL, closed_by_user_id = NULL,
        assigned_member_id = excluded.assigned_member_id, starts_at = excluded.starts_at, due_at = excluded.due_at, timezone = excluded.timezone,
        version = tasks.version + 1, updated_at = excluded.updated_at
      WHERE tasks.status = 'cancelled' OR (tasks.status = 'open' AND (tasks.assigned_member_id IS NOT excluded.assigned_member_id
        OR tasks.starts_at IS NOT excluded.starts_at OR tasks.timezone IS NOT excluded.timezone))`,
    params: [now, now, ...(sessions.params ?? []), now],
  }]
}

export interface TaskViewer { principal: MemberAccessPrincipal; manage: boolean; memberId: string }

export async function taskViewer(db: DbClient, principal: MemberAccessPrincipal): Promise<TaskViewer> {
  await assertRoleAllows({ ...principal, permissions: { task: ['read'] } })
  const member = await queryFirst<{ id: string }>(db, 'SELECT id FROM member WHERE organizationId = ? AND userId = ?', [principal.organizationId, principal.userId])
  if (!member) fail(404, 'MEMBER_NOT_FOUND', 'You are not a member of this organization')
  return { principal, manage: await roleAllows({ ...principal, permissions: { task: ['assign'] } }), memberId: member.id }
}

/** A member reads the tasks given to them, every task at an offering or location they are responsible for, and the replies in conversations they handle. */
function scopeSql(viewer: TaskViewer, alias = 't'): { sql: string; params: unknown[] } {
  if (viewer.manage) return { sql: '1 = 1', params: [] }
  const conversation = assignedGuestThreadScope('r', viewer.principal.userId)
  return {
    sql: `(${alias}.assigned_member_id = ?
      OR EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.organization_id = ${alias}.organization_id AND c.product_id = ${alias}.product_id AND ${assignedMemberSql('c')})
      OR (${alias}.product_id IS NULL AND ${alias}.location_id IS NOT NULL AND ${locationMemberSql(`${alias}.organization_id`, `${alias}.location_id`)})
      OR (${alias}.kind = 'guest_reply' AND EXISTS (SELECT 1 FROM conversations r WHERE r.id = ${alias}.subject_id AND r.organization_id = ${alias}.organization_id AND ${conversation.sql})))`,
    params: [viewer.memberId, ...Array(2).fill(viewer.principal.userId), ...conversation.params],
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

export interface TaskPerson { type: 'member'; id: string; name: string; initial: string; you: boolean }
export interface TaskPhoto { id: string; url: string; thumbnail_url: string; width: number | null; height: number | null }
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
  image_url: string | null
  /** A compact card's round avatar when there is a person rather than a home. */
  avatar: { initial: string; tone: 'warm' | 'cool' } | null
  /** The linked reservation on an open guest reply, when the viewer can read it. */
  reservation?: {
    date_label: string
    headline: string
    name: string
    status_label: string
    guest_image_url: string | null
    conversation: { label: string; description: string | null; to: string } | null
  }
  /** The grey line above the title: "Arriving tomorrow · 45B", "Asked 2h ago · Penthouse", "Done at 11:48 AM · 1 photo". Never repeats the section's day. */
  status_line: string | null
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
  /** Done, a pill that opens the subject, or the filled check that undoes a close. */
  action: { type: 'complete'; label: 'Done' } | { type: 'open'; label: string; path: string } | { type: 'reopen'; label: 'Undo Done' | 'Undo' } | null
  /** The task sheet. A turnover has its Checkout | Check-in split. */
  sheet: { heading: string; title: string; date: string | null; checkout: TaskSheetSide | null; checkin: TaskSheetSide | null }
  starts_at: string | null
  due_at: string | null
  timezone: string
  /** The owner's instructions. */
  notes: string | null
  outcome: { note: string | null; photos: TaskPhoto[]; closed_at: string; closed_by: string | null } | null
  /** The dashboard page of the task's subject, when it has one. */
  path: string | null
  product_id: string | null
  location_id: string | null
  booking_id: string | null
  product_session_id?: string
  conversation_id: string | null
  can: { complete: boolean; skip: boolean; reopen: boolean; assign: boolean; edit: boolean }
  /** How an open task is set aside, and whether its card offers it as well as its sheet. Null when it cannot be. */
  dismiss: { label: 'Skip' | 'Dismiss'; card: boolean } | null
}

/** A run of cards: Today's open work has no header; "Done"; Upcoming's "Tomorrow" with "Sat, Nov 7" in grey. */
export interface TaskSection { id: string; title: string | null; subtitle: string | null; tasks: TaskView[] }

interface StayFacts { id: string; product_id: string; guest_name: string | null; adults: number; children: number; starts_at: string; ends_at: string; timezone: string; check_in_date: string; check_out_date: string; conversation_id: string }
interface StayContextFacts extends StayFacts {
  guest_image_url: string | null
  status: StayWindow['status']
  no_show_at: string | null
  channel: StayChannel
  overbooked: number
}

/** A nights booking with its guest as their conversation names them; `s` is the booking, `r` its guest conversation. */
const STAY_FACTS = `s.id, s.product_id, json_extract(r.payload_json, '$.guest.name') AS guest_name, s.adults, s.children, s.starts_at, s.ends_at, s.timezone, r.id AS conversation_id`
const STAY_FACTS_FROM = "bookings s JOIN conversations r ON r.organization_id = s.organization_id AND r.booking_id = s.id AND r.kind = 'booking'"
function stayFacts<T extends Omit<StayFacts, 'check_in_date' | 'check_out_date'>>(row: T): T & Pick<StayFacts, 'check_in_date' | 'check_out_date'> {
  if (row.adults === null || row.children === null) throw new Error(`Stay ${row.id} has no party breakdown`)
  return { ...row, check_in_date: bookingDay(row.starts_at, row.timezone), check_out_date: bookingDay(row.ends_at, row.timezone) }
}

/** The home's next guests after a stay: the confirmed stay arriving first on or after its checkout day. */
async function nextArrival(db: DbClient, organizationId: string, stay: Pick<StayFacts, 'id' | 'product_id' | 'check_out_date'>): Promise<StayFacts | null> {
  const rows = (await queryAll<Omit<StayFacts, 'check_in_date' | 'check_out_date'>>(db, `SELECT ${STAY_FACTS} FROM ${STAY_FACTS_FROM}
    WHERE s.organization_id = ? AND s.product_id = ? AND s.product_session_id IS NULL AND s.status = 'confirmed' AND s.id <> ? AND s.starts_at >= ?`,
  [organizationId, stay.product_id, stay.id, addLocalDays(stay.check_out_date, -1)])).map(stayFacts)
  return rows.filter(row => row.check_in_date >= stay.check_out_date).sort((a, b) => a.check_in_date.localeCompare(b.check_in_date) || a.id.localeCompare(b.id))[0] ?? null
}
interface Context {
  slug: string
  vertical: string
  consultations: Map<string, string>
  paymentOpportunities: Set<string>
  people: Map<string, { name: string; userId: string }>
  users: Map<string, string>
  products: Map<string, { name: string; kind: ProductKind; imageUrl: string | null }>
  locations: Map<string, string>
  stays: Map<string, StayFacts>
  replyStays: Map<string, StayContextFacts & { same_day_arrival: boolean }>
  arrivals: Map<string, StayFacts | null>
  requests: Map<string, { guest_name: string | null; participant: string | null; preview: string | null; asked_at: string | null }>
  messages: Map<string, { title: string; status: string; conversation_id: string | null; booking_id: string }>
  /** A booking's conversation, when it is and what was booked. */
  records: Map<string, { conversation_id: string | null; starts_at: string; product_kind: ProductKind }>
  /** The message a change task is about. */
  entries: Map<string, { event_name: string; author_kind: string; body: string | null }>
  photos: Map<string, TaskPhoto[]>
}

async function loadContext(db: DbClient, viewer: TaskViewer, rows: TaskRow[]): Promise<Context> {
  const organizationId = viewer.principal.organizationId
  const ids = (pick: (row: TaskRow) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const messageIds = ids(row => row.subject_type === 'scheduled_guest_message' ? row.subject_id : null)
  const messages = messageIds.length ? await queryAll<{ id: string; template_title: string; status: string; conversation_id: string | null; booking_id: string }>(db,
    `SELECT m.id, m.template_title, m.status, (SELECT c.id FROM conversations c WHERE c.organization_id = m.organization_id AND c.booking_id = m.booking_id AND c.kind = 'booking') AS conversation_id, m.booking_id
      FROM scheduled_guest_messages m WHERE m.organization_id = ? AND m.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(messageIds)]) : []
  const sessions = ids(row => row.subject_type === 'product_session' ? row.subject_id : null)
  const privateConsultations = sessions.length ? await queryAll<{ id: string; booking_id: string | null }>(db,
    `SELECT candidate.id, ${consultationBookingSql('candidate.id', 'candidate.organization_id')} AS booking_id FROM product_sessions candidate
      WHERE candidate.organization_id = ? AND candidate.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(sessions)]) : []
  const consultations = new Map(privateConsultations.flatMap(row => row.booking_id ? [[row.id, row.booking_id] as const] : []))
  const bookingIds = [...new Set([...ids(row => row.subject_type === 'booking' ? row.subject_id : null), ...messages.map(message => message.booking_id), ...consultations.values()])]
  const booked = bookingIds.length ? await queryAll<{ id: string; conversation_id: string | null; starts_at: string; product_kind: ProductKind; unit: 'slot' | 'nights' }>(db, `SELECT br.id, br.starts_at, br.product_kind, br.unit,
       (SELECT c.id FROM conversations c WHERE c.organization_id = br.organization_id AND c.booking_id = br.id AND c.kind = 'booking') AS conversation_id FROM ${BOOKING_RECORDS_SQL} br
     WHERE br.organization_id = ? AND br.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(bookingIds)]) : []
  const records = booked.filter(record => record.unit === 'slot')
  const changeStayRequests = booked.filter(record => record.unit === 'nights' && rows.some(row => row.kind === 'booking_change' && row.subject_id === record.id))
  const entryIds = rows.filter(row => row.kind === 'booking_change').map(row => row.dedupe_key.slice('booking_change:'.length))
  const entries = entryIds.length ? await queryAll<{ id: string; event_name: string; author_kind: string; body: string | null }>(db, 'SELECT id, event_name, author_kind, body FROM messages WHERE id IN (SELECT value FROM json_each(?))', [d1JsonStringSet(entryIds)]) : []
  const requestIds = [...new Set([...ids(row => row.subject_type === 'conversation' ? row.subject_id : null),
    ...records.flatMap(record => record.conversation_id ? [record.conversation_id] : []), ...changeStayRequests.flatMap(stay => stay.conversation_id ? [stay.conversation_id] : [])])]
  // Stay writers load this module; the conversation repository is loaded when a view is drawn.
  const { guestEntryAskedAtSql } = await import('~/server/domain/guest-threads/repository')
  const [organization, members, locations, requests, photos, paymentOpportunities] = await Promise.all([
    queryFirst<{ slug: string; vertical: string }>(db, 'SELECT slug, vertical FROM organization WHERE id = ?', [organizationId]),
    queryAll<{ id: string; userId: string; name: string }>(db, 'SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?', [organizationId]),
    queryAll<{ id: string; title: string }>(db, 'SELECT id, title FROM business_locations WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(ids(row => row.location_id))]),
    queryAll<{ id: string; guest_name: string | null; participant: string | null; preview: string | null; asked_at: string | null }>(db, `
      SELECT r.id, json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.participant.title') AS participant,
        (SELECT e.body FROM messages e JOIN tasks t ON t.subject_id = r.id AND t.kind = 'guest_reply'
          WHERE e.id = substr(t.dedupe_key, length('guest_reply:' || r.id || ':') + 1) ORDER BY t.created_at DESC LIMIT 1) AS preview,
        (SELECT ${guestEntryAskedAtSql('e')} FROM messages e JOIN tasks t ON t.subject_id = r.id AND t.kind = 'guest_reply'
          WHERE e.id = substr(t.dedupe_key, length('guest_reply:' || r.id || ':') + 1) ORDER BY t.created_at DESC LIMIT 1) AS asked_at
      FROM conversations r WHERE r.organization_id = ? AND r.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(requestIds)]),
    listMessagePhotos(db, 'task', rows.map(row => row.id)),
    queryAll<{ id: string }>(db, "SELECT id FROM opportunities WHERE organization_id = ? AND operation = 'product.payment' AND id IN (SELECT value FROM json_each(?))",
      [organizationId, d1JsonStringSet(ids(row => row.status === 'open' ? row.opportunity_id : null))]),
  ])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const stayIds = booked.filter(record => record.unit === 'nights').map(record => record.id)
  const openReplies = ids(row => row.kind === 'guest_reply' && row.status === 'open' ? row.subject_id : null)
  const replyRequests = openReplies.length && viewer.principal.role && await roleAllows({ ...viewer.principal, permissions: { operations: ['update'] } }) ? openReplies : []
  const stays = (await queryAll<Omit<StayContextFacts, 'check_in_date' | 'check_out_date' | 'same_day_arrival'>>(db, `
    SELECT ${STAY_FACTS}, s.status, s.no_show_at, s.channel, s.overbooked, u.image AS guest_image_url
    FROM ${STAY_FACTS_FROM}
    LEFT JOIN user u ON u.id = s.user_id
    WHERE s.organization_id = ? AND s.product_session_id IS NULL AND (s.id IN (SELECT value FROM json_each(?)) OR r.id IN (SELECT value FROM json_each(?)))`,
  [organizationId, d1JsonStringSet(stayIds), d1JsonStringSet(replyRequests)])).map(stayFacts)
  // Whether the home's next guests arrive the day the guest of a conversation being answered leaves.
  const sameDay = new Set<string>()
  for (const stay of stays.filter(item => item.conversation_id && replyRequests.includes(item.conversation_id))) {
    if ((await nextArrival(db, organizationId, stay))?.check_in_date === stay.check_out_date) sameDay.add(stay.id)
  }
  const productIds = [...new Set([...ids(row => row.product_id), ...stays.map(stay => stay.product_id)])]
  const [products, pictures] = await Promise.all([
    queryAll<{ id: string; name: string | null; kind: ProductKind }>(db, `
      SELECT p.id, p.kind, CASE WHEN p.kind = 'stay' THEN c.internal_name ELSE p.name END AS name
      FROM products p LEFT JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
      WHERE p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(productIds)]),
    loadOwnerPictures(db, organizationId, 'product', productIds, { organizationFallback: false }),
  ])
  // The next guests at the home, for the turnovers shown.
  const arrivals = new Map<string, StayFacts | null>()
  for (const row of rows.filter(row => row.kind === 'turnover' && row.product_id !== null)) {
    const stay = stays.find(item => item.id === row.subject_id)
    if (!stay) continue
    arrivals.set(row.id, await nextArrival(db, organizationId, { ...stay, product_id: row.product_id! }))
  }
  return {
    slug: organization.slug,
    vertical: organization.vertical,
    consultations,
    paymentOpportunities: new Set(paymentOpportunities.map(row => row.id)),
    people: new Map(members.map(member => [member.id, { name: member.name, userId: member.userId }])),
    users: new Map(members.map(member => [member.userId, member.name])),
    products: new Map(products.map(product => {
      if (!product.name?.trim()) throw new Error(`Product ${product.id} has no name for this task`)
      return [product.id, { name: product.name, kind: product.kind, imageUrl: pictures.get(product.id)?.imageUrl ?? null }]
    })),
    locations: new Map(locations.map(location => [location.id, location.title])),
    stays: new Map(stays.map(stay => [stay.id, stay])),
    replyStays: new Map(stays.flatMap(stay => stay.conversation_id && replyRequests.includes(stay.conversation_id) ? [[stay.conversation_id, { ...stay, same_day_arrival: sameDay.has(stay.id) }]] : [])),
    arrivals,
    requests: new Map(requests.map(request => [request.id, request])),
    messages: new Map(messages.map(message => [message.id, { title: message.template_title, status: message.status, conversation_id: message.conversation_id, booking_id: message.booking_id }])),
    records: new Map(records.map(record => [record.id, { conversation_id: record.conversation_id, starts_at: record.starts_at, product_kind: record.product_kind }])),
    entries: new Map(entries.map(entry => [entry.id, { event_name: entry.event_name, author_kind: entry.author_kind, body: entry.body }])),
    photos: new Map([...photos].map(([id, list]) => [id, list.map(photo => ({ id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl, width: photo.width, height: photo.height }))])),
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
  const member = row.assigned_member_id ? context.people.get(row.assigned_member_id) : null
  const assignee: TaskPerson | null = row.assigned_member_id && member ? { type: 'member', id: row.assigned_member_id, name: member.userId === viewer.principal.userId ? 'You' : member.name, initial: initialOf(member.name), you: member.userId === viewer.principal.userId } : null
  const closerName = row.closed_by_user_id === null ? null : row.closed_by_user_id === viewer.principal.userId ? 'You' : context.users.get(row.closed_by_user_id) ?? 'A former member'
  const closer: TaskPerson | null = closerName === null ? null : { type: 'member', id: row.closed_by_user_id!, name: closerName, initial: initialOf(closerName === 'You' ? context.users.get(row.closed_by_user_id!) ?? 'Y' : closerName), you: closerName === 'You' }
  const conversation = (conversation_id: string | null) => conversation_id ? guestConversationPath(context.slug, conversation_id) : null
  const stayPath = (booking_id: string) => `/dashboard/${encodeURIComponent(context.slug)}/bookings/stay/${encodeURIComponent(booking_id)}`
  const who = (name: string | null) => name ? firstName(name) : 'Guest'
  let face: TaskView['face'] = product ? 'photo' : 'compact', tag: string | null = null, avatar: TaskView['avatar'] = null
  let status_line: string | null = null, title = '', when: string | null = null, detail: string | null = null, error: string | null = null, path: string | null = null
  let booking_id = row.subject_type === 'booking' ? row.subject_id : null
  const product_session_id = row.subject_type === 'product_session' ? row.subject_id : null
  let conversation_id: string | null = null
  let reservation: TaskView['reservation']
  let action: TaskView['action'] = { type: 'complete', label: 'Done' }
  let sheet: TaskView['sheet'] = { heading: 'Task', title: '', date: null, checkout: null, checkin: null }
  switch (row.kind) {
    case 'turnover': {
      const stay = context.stays.get(row.subject_id!)
      if (!stay || !product) throw new Error(`Turnover ${row.id} has no stay or home`)
      booking_id = stay.id
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
      conversation_id = row.subject_id
      face = 'compact'
      // A guest by their first name; a channel conversation with no guest identity by the channel's own title.
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      avatar = { initial: initialOf(title), tone: 'warm' }
      status_line = [`Asked ${relative(request.asked_at ?? row.created_at, now)}`, place].filter(Boolean).join(' · ')
      detail = request.preview?.trim() || null
      path = conversation(row.subject_id)
      action = { type: 'open', label: 'Reply', path: path! }
      sheet = { heading: 'Reply', title, date: null, checkout: null, checkin: null }
      const stay = row.status === 'open' ? context.replyStays.get(row.subject_id!) : undefined
      if (stay) {
        const home = context.products.get(stay.product_id)
        if (!home) throw new Error(`Stay ${stay.id} has no home`)
        booking_id = stay.id
        const localDay = localDateAt(now, stay.timezone)
        const clockAt = (value: string) => isBookingDay(value) ? 'Time not set' : formatTimestamp(value, 'en', stay.timezone, { hour: 'numeric', minute: '2-digit' })
        let status_label: string
        if (stay.status === 'cancelled') status_label = 'Cancelled'
        else if (stay.no_show_at !== null) status_label = 'No-show recorded'
        else if (stay.status === 'pending') status_label = 'Pending confirmation'
        else if (localDay > stay.check_out_date) status_label = 'Stay ended'
        else if (localDay <= stay.check_in_date) {
          status_label = `Checking in · ${clockAt(stay.starts_at)}`
        } else if (localDay === stay.check_out_date) {
          const clock = clockAt(stay.ends_at)
          status_label = stay.same_day_arrival ? `Checking out · Next guests arrive the same day · ${clock}` : `Checking out · ${clock}`
        } else status_label = 'Currently hosting'
        const guest = stay.guest_name ?? ''
        const partySize = stay.adults + stay.children
        reservation = {
          date_label: `${formatCalendarDate(stay.check_in_date, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(stay.check_out_date, 'en', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          headline: stay.guest_name && partySize > 1 ? `${firstName(stay.guest_name)}’s group of ${partySize}` : guest || `Name not provided by ${STAY_CHANNEL_LABELS[stay.channel]}`,
          name: home.name,
          status_label: stay.overbooked ? `Overbooked · ${status_label}` : status_label,
          guest_image_url: stay.guest_image_url,
          conversation: { label: action.label, description: detail, to: action.path },
        }
      }
      break
    }
    case 'message_delivery': {
      const message = context.messages.get(row.subject_id!)
      if (!message) throw new Error(`Delivery task ${row.id} has no scheduled message`)
      conversation_id = message.conversation_id
      booking_id = message.booking_id
      face = 'compact'
      // Only what our own record knows: the message, and that it did not send.
      error = `${message.title} didn’t send`
      detail = message.status === 'needs_review' ? 'Its send was already used for a different message. Check the conversation before sending it again.' : 'You can send it yourself from the conversation.'
      const stay = context.stays.get(message.booking_id)
      if (stay) {
        avatar = { initial: initialOf(who(stay.guest_name)), tone: 'cool' }
        const home = context.products.get(stay.product_id)?.name ?? null
        const arrival = stay.check_in_date > today
          ? stay.check_in_date === addLocalDays(today, 1) ? 'Arriving tomorrow' : `Arriving ${calendarDay(stay.check_in_date)}`
          : stay.check_in_date === today ? 'Arriving today' : stay.check_out_date > today ? 'Staying now' : `Checked out ${calendarDay(stay.check_out_date)}`
        status_line = [arrival, home].filter(Boolean).join(' · ')
        title = who(stay.guest_name)
        path = conversation(message.conversation_id) ?? stayPath(message.booking_id)
        action = { type: 'open', label: message.conversation_id ? 'Open conversation' : 'Open stay', path }
      } else {
        // A consultation, class or table: its time and place, and its conversation when it has one.
        const record = context.records.get(message.booking_id)
        if (!record) throw new Error(`Delivery task ${row.id} has no booking`)
        const request = record.conversation_id ? context.requests.get(record.conversation_id) : undefined
        title = request?.guest_name ? firstName(request.guest_name) : request?.participant ?? 'Guest'
        avatar = { initial: initialOf(title), tone: 'cool' }
        status_line = [`${day(record.starts_at)}, ${time(record.starts_at)}`, place].filter(Boolean).join(' · ')
        path = conversation(message.conversation_id)
        action = path ? { type: 'open', label: 'Open conversation', path } : { type: 'complete', label: 'Done' }
      }
      sheet = { heading: 'Message', title, date: null, checkout: null, checkin: null }
      break
    }
    case 'booking_review': {
      const record = context.records.get(row.subject_id!)
      const request = record?.conversation_id ? context.requests.get(record.conversation_id) : undefined
      if (!record?.conversation_id || !request) throw new Error(`Review task ${row.id} has no booking conversation`)
      conversation_id = record.conversation_id
      face = 'compact'
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      avatar = { initial: initialOf(title), tone: 'warm' }
      status_line = ['Waiting for your approval', place].filter(Boolean).join(' · ')
      detail = `${day(record.starts_at)}, ${time(record.starts_at)}`
      path = bookingEditorPath(context.slug, 'booking', record.conversation_id)
      action = { type: 'open', label: 'Review', path }
      sheet = { heading: 'Booking request', title, date: day(record.starts_at), checkout: null, checkin: null }
      break
    }
    case 'consultation_prep': {
      const consultation = product_session_id ? context.consultations.get(product_session_id) : booking_id
      const record = consultation ? context.records.get(consultation) : undefined
      const request = record?.conversation_id ? context.requests.get(record.conversation_id) : undefined
      if (record?.product_kind === 'service' && record.conversation_id && request) {
        const heading = 'Prepare for consultation'
        conversation_id = record.conversation_id
        booking_id = consultation ?? null
        face = 'compact'
        title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Client'
        avatar = { initial: initialOf(title), tone: 'warm' }
        status_line = [heading, place].filter(Boolean).join(' · ')
        detail = `${day(record.starts_at)}, ${time(record.starts_at)}`
        path = bookingEditorPath(context.slug, 'booking', record.conversation_id)
        sheet = { heading, title, date: null, checkout: null, checkin: null }
        break
      }
      if (!product || !row.starts_at) throw new Error(`Prep task ${row.id} has no offering or start time`)
      const heading = `Prepare for ${getVerticalCopy(context.vertical, 'en').reservationWord}`
      title = product.name
      status_line = [heading, row.location_id ? context.locations.get(row.location_id) : null].filter(Boolean).join(' · ')
      detail = `${day(row.starts_at)}, ${time(row.starts_at)}`
      if (product_session_id) {
        const query = new URLSearchParams({ date: localDateAt(new Date(row.starts_at), zone) })
        if (row.location_id) query.set('location_id', row.location_id)
        const calendar = `/dashboard/${encodeURIComponent(context.slug)}/calendar`
        if (product.kind === 'table') path = `${calendar}?${query}`
        else {
          query.set('product_id', row.product_id!)
          path = `${calendar}/sessions/${encodeURIComponent(product_session_id)}?${query}`
        }
      }
      sheet = { heading, title, date: day(row.starts_at), checkout: null, checkin: null }
      break
    }
    case 'consultation_follow_up': {
      const record = context.records.get(row.subject_id!)
      const request = record?.conversation_id ? context.requests.get(record.conversation_id) : undefined
      if (!record?.conversation_id || !request) throw new Error(`Visit job ${row.id} has no booking conversation`)
      // In the business's own words: "Prepare for consultation", a client; "Prepare for reservation", a guest.
      const presentation = resolveBookingPresentation(record.product_kind, context.vertical)
      const heading = 'Follow up'
      conversation_id = record.conversation_id
      face = 'compact'
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? `${presentation.counterpartyNoun.charAt(0).toUpperCase()}${presentation.counterpartyNoun.slice(1)}`
      avatar = { initial: initialOf(title), tone: 'warm' }
      status_line = [heading, place].filter(Boolean).join(' · ')
      detail = `${day(record.starts_at)}, ${time(record.starts_at)}`
      path = bookingEditorPath(context.slug, 'booking', record.conversation_id)
      sheet = { heading, title, date: null, checkout: null, checkin: null }
      break
    }
    case 'booking_change': {
      const entry = context.entries.get(row.dedupe_key.slice('booking_change:'.length))
      const stay = context.stays.get(row.subject_id!)
      const record = stay ? null : context.records.get(row.subject_id!)
      conversation_id = stay?.conversation_id ?? record?.conversation_id ?? null
      const request = conversation_id ? context.requests.get(conversation_id) : undefined
      if (!entry || !conversation_id || !request) throw new Error(`Change task ${row.id} has no change or conversation`)
      booking_id = stay?.id ?? (record ? row.subject_id : null)
      face = 'compact'
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      avatar = { initial: initialOf(title), tone: 'cool' }
      const waiting = entry.author_kind !== 'guest' && row.starts_at !== null && row.starts_at > now.toISOString()
      status_line = [entry.author_kind === 'guest' ? 'Change requested' : waiting ? 'Change proposal waiting on the guest' : 'Change proposal expired', place].filter(Boolean).join(' · ')
      detail = record ? `${day(record.starts_at)}, ${time(record.starts_at)}` : null
      path = conversation(conversation_id)
      // A change closes when it is answered or proposed again.
      action = { type: 'open', label: 'Review', path: path! }
      sheet = { heading: 'Change', title, date: null, checkout: null, checkin: null }
      break
    }
    case 'opportunity':
      if (row.opportunity_id && context.paymentOpportunities.has(row.opportunity_id)) {
        if (!row.subject_id || row.subject_type !== 'product') throw new Error(`Payment task ${row.id} has no offering`)
        if (viewer.manage) {
          path = productPaymentPath(context.slug, row.subject_id)
          action = { type: 'open', label: 'Open payment settings', path }
        } else action = null
      }
      face = 'compact'
      status_line = ['Accepted opportunity', place].filter(Boolean).join(' · ')
      title = row.title!
      detail = row.notes
      sheet = { heading: 'Task', title, date: row.due_at ? day(row.due_at) : null, checkout: null, checkin: null }
      break
    case 'custom':
    case 'stay_ready':
      face = 'compact'
      status_line = ['Task', place].filter(Boolean).join(' · ')
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
    status_line = [`${row.status === 'done' ? 'Done' : row.status === 'skipped' ? PERSON_WORK.has(row.kind) ? 'Skipped' : 'Dismissed' : 'Cancelled'} at ${at}`, photos.length ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}` : null].filter(Boolean).join(' · ')
    detail = null
  }
  const mine = assignee?.you ?? false
  const reachable = viewer.manage || mine || PERSON_WORK.has(row.kind) || row.kind === 'booking_change'
  const personClosed = (row.status === 'done' || row.status === 'skipped') && row.closed_by_user_id !== null
  const can = {
    complete: row.status === 'open' && action?.type === 'complete' && reachable,
    skip: row.status === 'open' && reachable,
    reopen: personClosed && (viewer.manage || row.closed_by_user_id === viewer.principal.userId),
    // Prep follows the offering's host; follow-up follows its booking.
    assign: viewer.manage && row.status === 'open' && row.kind !== 'consultation_prep' && row.kind !== 'consultation_follow_up',
    edit: viewer.manage && row.status === 'open',
  }
  if (row.status !== 'open') action = can.reopen ? { type: 'reopen', label: row.status === 'done' ? 'Undo Done' : 'Undo' } : null
  else if (action?.type === 'complete' && !can.complete) action = null
  return {
    id: row.id, kind: row.kind, status: row.status, version: row.version,
    face, tag, image_url: product?.imageUrl ?? null, avatar, status_line, title, when, detail, error,
    ...(reservation ? { reservation } : {}),
    note: row.outcome_note ? `“${row.outcome_note}”` : null,
    person: row.status === 'open' ? assignee : closer, assignee, action, sheet,
    starts_at: row.starts_at, due_at: row.due_at, timezone: zone, notes: row.notes,
    outcome: row.status === 'open' ? null : { note: row.outcome_note, photos, closed_at: row.closed_at!, closed_by: closerName },
    path, product_id: row.product_id, location_id: row.location_id, booking_id, ...(product_session_id ? { product_session_id } : {}), conversation_id, can,
    dismiss: can.skip ? { label: PERSON_WORK.has(row.kind) ? 'Skip' : 'Dismiss', card: row.kind === 'guest_reply' } : null,
  }
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export interface TaskListQuery { range: 'today' | 'upcoming'; assignee: 'me' | 'all' | string; location_id?: string; status?: TaskStatus; kind?: TaskKind }

const STATUSES: readonly TaskStatus[] = ['open', 'done', 'skipped', 'cancelled']

export function parseTaskListQuery(query: Record<string, unknown>, defaults: Partial<TaskListQuery> = {}): TaskListQuery {
  const read = (key: string) => typeof query[key] === 'string' && query[key] !== '' ? String(query[key]) : undefined
  const range = read('range') ?? defaults.range ?? 'today'
  if (range !== 'today' && range !== 'upcoming') fail(400, 'INVALID_TASK_QUERY', 'range must be today or upcoming', 'range')
  const status = read('status')
  if (status !== undefined && !STATUSES.includes(status as TaskStatus)) fail(400, 'INVALID_TASK_QUERY', 'status must be open, done, skipped or cancelled', 'status')
  const kind = read('kind')
  if (kind !== undefined && !TASK_KINDS.includes(kind as TaskKind)) fail(400, 'INVALID_TASK_QUERY', `kind must be one of ${TASK_KINDS.join(', ')}`, 'kind')
  return { range, assignee: read('assignee') ?? defaults.assignee ?? 'all', location_id: read('location_id'), status: status as TaskStatus | undefined, kind: kind as TaskKind | undefined }
}

/** Today's open work in the owner's order: failed deliveries, turnovers, replies, then everything else. */
/** Work a person does and closes themselves: they Skip it, and say what they found when they finish. Everything else is Dismissed. */
const PERSON_WORK: ReadonlySet<TaskKind> = new Set(['turnover', 'custom', 'stay_ready', 'opportunity', 'consultation_prep', 'consultation_follow_up'])
const TODAY_ORDER: Record<TaskKind, number> = { message_delivery: 0, turnover: 1, guest_reply: 2, booking_review: 2, booking_change: 2, consultation_prep: 2, custom: 3, stay_ready: 1, consultation_follow_up: 3, opportunity: 3 }

/** Today: open work due or starting today or earlier, or with no date; then what was closed today. Upcoming: open work later than today, by day. */
export async function listTasks(db: DbClient, viewer: TaskViewer, query: TaskListQuery, now = new Date()): Promise<{ sections: TaskSection[]; resolved_at: string }> {
  const organizationId = viewer.principal.organizationId
  const scope = scopeSql(viewer)
  const filters: string[] = []
  const params: unknown[] = []
  if (query.assignee === 'me') {
    filters.push('t.assigned_member_id = ?')
    params.push(viewer.memberId)
  } else if (query.assignee !== 'all') {
    if (!viewer.manage && query.assignee !== viewer.memberId) fail(403, 'TASK_SCOPE_DENIED', 'You can list your own tasks only', 'assignee')
    filters.push('t.assigned_member_id = ?')
    params.push(query.assignee)
  }
  if (query.location_id) { filters.push('t.location_id = ?'); params.push(query.location_id) }
  if (query.kind) { filters.push('t.kind = ?'); params.push(query.kind) }
  // Closed work is shown on the day it was closed; two days covers every zone's today.
  const closedSince = new Date(now.getTime() - 2 * 86_400_000).toISOString()
  const statusSql = query.status ? 't.status = ?' : `(t.status = 'open' OR (? = 'today' AND t.status IN ('done', 'skipped') AND t.closed_at >= ?))`
  const statusParams = query.status ? [query.status] : [query.range, closedSince]
  const rows = await queryAll<TaskRow & { checkout_at: string | null; checkout_timezone: string | null }>(db, `SELECT t.*, s.ends_at AS checkout_at, s.timezone AS checkout_timezone FROM tasks t
    LEFT JOIN bookings s ON t.kind = 'turnover' AND t.starts_at IS NULL AND s.organization_id = t.organization_id AND s.id = t.subject_id
    WHERE t.organization_id = ? AND ${scope.sql} AND ${statusSql}${filters.map(sql => ` AND ${sql}`).join('')}
    ORDER BY COALESCE(t.starts_at, t.due_at, t.created_at), t.id`, [organizationId, ...scope.params, ...statusParams, ...params])
  const today = (row: TaskRow) => localDateAt(now, row.timezone)
  const dayOf = (instant: string | null, row: TaskRow) => instant === null ? null : localDateAt(new Date(instant), row.timezone)
  const startsOn = (row: typeof rows[number]) => {
    if (row.starts_at !== null || row.kind !== 'turnover') return dayOf(row.starts_at, row)
    if (row.checkout_at === null || row.checkout_timezone === null) throw new Error(`Turnover ${row.id} has no stay`)
    return bookingDay(row.checkout_at, row.checkout_timezone)
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
  const resolved_at = now.toISOString()
  if (query.range === 'today') {
    const open = views.filter(item => item.row.status === 'open').sort((a, b) => TODAY_ORDER[a.row.kind] - TODAY_ORDER[b.row.kind]).map(item => item.view)
    const closed = views.filter(item => item.row.status !== 'open').sort((a, b) => b.row.closed_at!.localeCompare(a.row.closed_at!)).map(item => item.view)
    return { resolved_at, sections: [
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
  return { resolved_at, sections: [...byDay.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

/** The members a manager can give work to; empty for anyone who cannot assign. */
export async function listTaskAssignees(db: DbClient, viewer: TaskViewer): Promise<TaskPerson[]> {
  if (!viewer.manage) return []
  const organizationId = viewer.principal.organizationId
  const members = await queryAll<{ id: string; userId: string; name: string }>(db, 'SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY u.name, m.id', [organizationId])
  return members.map(member => ({ type: 'member' as const, id: member.id, name: member.userId === viewer.principal.userId ? 'You' : member.name, initial: member.name.trim().charAt(0).toUpperCase(), you: member.userId === viewer.principal.userId }))
}

/** A task as an alert to one of its people tells it: the member projection, with no guest's full name or contact. */
export async function describeTaskForAlert(db: DbClient, organizationId: string, taskId: string, recipientUserId: string): Promise<{ eyebrow: string; title: string; detail: string | null; locationId: string | null }> {
  const view = await taskViewForUser(db, organizationId, taskId, recipientUserId)
  return { eyebrow: [view.tag ?? view.status_line, view.when].filter(Boolean).join(' · '), title: view.title, detail: view.detail, locationId: view.location_id }
}

/** A task as one member sees it, from a server path with no caller: the member projection, with no guest's full name or contact. */
export async function taskViewForUser(db: DbClient, organizationId: string, taskId: string, userId: string | null, now = new Date()): Promise<TaskView> {
  const row = await queryFirst<TaskRow>(db, 'SELECT * FROM tasks WHERE organization_id = ? AND id = ?', [organizationId, taskId])
  if (!row) throw new Error(`Task ${taskId} is not in organization ${organizationId}`)
  // The recipient's own membership answers what they may read; a view for nobody (a job with no people yet) reads as a member with no role.
  const member = userId === null ? null : await queryFirst<{ id: string; role: string }>(db, 'SELECT id, role FROM member WHERE organizationId = ? AND userId = ?', [organizationId, userId])
  if (userId !== null && !member) throw new Error(`User ${userId} is not a member of organization ${organizationId}`)
  const viewer = { principal: { organizationId, userId: userId ?? '', role: member?.role ?? '' } as MemberAccessPrincipal, manage: false, memberId: member?.id ?? '' }
  return present(row, viewer, await loadContext(db, viewer, [row]), now)
}

export async function getTask(db: DbClient, viewer: TaskViewer, taskId: string, now = new Date()): Promise<TaskView> {
  const row = await readTaskRow(db, viewer, taskId)
  return present(row, viewer, await loadContext(db, viewer, [row]), now)
}

/**
 * The job of each stay the viewer may see, for the strip at the top of a stay's
 * team conversation: the open one first (the home must be ready before the
 * guest arrives, then turned over after), otherwise the one closed last.
 */
export async function subjectJobViews(db: DbClient, viewer: TaskViewer, subjectIds: readonly string[], now = new Date()): Promise<Map<string, TaskView>> {
  if (!subjectIds.length) return new Map()
  const scope = scopeSql(viewer)
  const rows = await queryAll<TaskRow & { job_booking_id: string }>(db, `SELECT t.*, ${jobBookingIdSql('t')} AS job_booking_id FROM tasks t
    WHERE t.organization_id = ? AND (${JOB_TASK_SQL('t')} OR t.kind = 'consultation_prep') AND ${scope.sql}
      AND job_booking_id IN (SELECT value FROM json_each(?))
    ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, CASE WHEN t.status = 'open' THEN COALESCE(t.due_at, t.starts_at, t.created_at) END, t.closed_at DESC, t.updated_at DESC`,
  [viewer.principal.organizationId, ...scope.params, d1JsonStringSet(subjectIds)])
  const chosen = new Map<string, TaskRow>()
  for (const row of rows) {
    if (!chosen.has(row.job_booking_id)) chosen.set(row.job_booking_id, row)
  }
  const context = await loadContext(db, viewer, [...chosen.values()])
  return new Map([...chosen].map(([subjectId, row]) => [subjectId, present(row, viewer, context, now)]))
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

export async function readTaskAssignee(db: DbClient, organizationId: string, input: { assigned_member_id?: unknown }): Promise<string | null> {
  const member = input.assigned_member_id ?? null
  if (member !== null && (typeof member !== 'string' || !await queryFirst(db, 'SELECT id FROM member WHERE organizationId = ? AND id = ?', [organizationId, member]))) {
    fail(422, 'INVALID_RESPONSIBILITY', 'The member must belong to this organization', 'assigned_member_id')
  }
  return member as string | null
}

function taskEventQuery(viewer: TaskViewer, row: Pick<TaskRow, 'id' | 'kind' | 'location_id'>, eventType: 'task.assigned' | 'task.updated' | 'task.completed' | 'task.skipped' | 'task.reopened', state: { before?: unknown; after?: unknown }, guarded = true): BatchQuery {
  return organizationEventQuery({ organizationId: viewer.principal.organizationId, locationId: row.location_id, actorId: viewer.principal.userId, eventType,
    entityType: 'task', entityId: row.id, metadata: { kind: row.kind }, beforeState: state.before, afterState: state.after, onlyIfPreviousChangedOneRow: guarded })
}

/** The assigned member's user, who should hear about a change. */
async function assigneeUsers(db: DbClient, organizationId: string, memberId: string): Promise<string[]> {
  return (await queryAll<{ userId: string }>(db, 'SELECT userId FROM member WHERE organizationId = ? AND id = ?', [organizationId, memberId])).map(row => row.userId)
}

/** A job a guest's move creates: the home they moved to may have no earlier stay to clean after. */
const stayReadyKey = (stayId: string, productId: string) => `stay-ready:${stayId}:${productId}`

export function stayReadyTaskQueries(input: {
  organizationId: string; stayId: string; now: string; previousProductId: string; guard: BatchQuery; guestName: string | null; checkInDate: string
  /** The home to make ready; null when the guest moved back to the listing they booked. */
  home: { product_id: string; location_id: string; timezone: string; check_in_time: string | null; internal_name: string; assigned_member_id: string | null } | null
}): BatchQuery[] {
  const { organizationId, stayId, now, previousProductId, guard, home } = input
  const queries: BatchQuery[] = [{
    query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ? WHERE dedupe_key = ? AND status = 'open' AND ${guard.query}`,
    params: [now, now, stayReadyKey(stayId, previousProductId), ...guard.params!],
  }]
  if (!home) return queries
  const dueAt = home.check_in_time === null ? null : localDateTimeToInstant(input.checkInDate, home.check_in_time, home.timezone, 'compatible').toISOString()
  queries.push({
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, title, notes, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT ?, ?, 'stay_ready', 'booking', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ? WHERE ${guard.query}
      ON CONFLICT (dedupe_key) DO UPDATE SET status = 'open', closed_at = NULL, closed_by_user_id = NULL, outcome_note = NULL, due_at = excluded.due_at, title = excluded.title, notes = excluded.notes,
        assigned_member_id = excluded.assigned_member_id, version = tasks.version + 1, updated_at = excluded.updated_at`,
    params: [crypto.randomUUID(), organizationId, stayId, home.product_id, home.location_id, home.assigned_member_id, `Get ${home.internal_name} ready`.slice(0, 200),
      `${input.guestName ?? 'A guest'} was moved here and arrives ${formatCalendarDate(input.checkInDate, 'en', { weekday: 'short', month: 'short', day: 'numeric' })}.`,
      dueAt, home.timezone, stayReadyKey(stayId, home.product_id), now, now, ...guard.params!],
  })
  return queries
}

/** A stay's revision reaches its open make-ready job: a cancellation calls it off, new dates move its due time and note. */
export function stayReadyRevisionQueries(input: { organizationId: string; stayId: string; now: string; guard: BatchQuery; cancelled: boolean; dueAt?: string | null; checkInDate?: string; guestName?: string | null }): BatchQuery[] {
  const { organizationId, stayId, now, guard } = input
  if (input.cancelled) return [{
    query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND kind = 'stay_ready' AND subject_type = 'booking' AND subject_id = ? AND status = 'open' AND ${guard.query}`,
    params: [now, now, organizationId, stayId, ...guard.params!],
  }]
  if (input.dueAt === undefined || !input.checkInDate) return []
  return [{
    query: `UPDATE tasks SET due_at = ?, notes = ?, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND kind = 'stay_ready' AND subject_type = 'booking' AND subject_id = ? AND status = 'open' AND due_at IS NOT ? AND ${guard.query}`,
    params: [input.dueAt, `${input.guestName ?? 'A guest'} was moved here and arrives ${formatCalendarDate(input.checkInDate, 'en', { weekday: 'short', month: 'short', day: 'numeric' })}.`, now,
      organizationId, stayId, input.dueAt, ...guard.params!],
  }]
}

export async function notifyStayReady(env: CloudflareEnv, db: DbClient, input: { organizationId: string; stayId: string; productId: string; actorUserId: string | null }): Promise<void> {
  const task = await queryFirst<{ id: string; assigned_member_id: string | null }>(db,
    'SELECT id, assigned_member_id FROM tasks WHERE organization_id = ? AND dedupe_key = ?', [input.organizationId, stayReadyKey(input.stayId, input.productId)])
  if (!task) throw new Error(`The move of stay ${input.stayId} left no job to make its home ready`)
  const assigned = task.assigned_member_id
  // A cleaner's job is posted in the stay's conversation when the business change below wakes the organization's jobs.
  const recipients = !assigned || await jobHasConversation(db, input.organizationId, assigned) ? [] : (await assigneeUsers(db, input.organizationId, assigned)).filter(userId => userId !== input.actorUserId)
  if (recipients.length) {
    const { notifyTaskAssigned } = await import('~/server/utils/notifications')
    await notifyTaskAssigned(env, db, { organizationId: input.organizationId, taskId: task.id, actorUserId: input.actorUserId, recipientUserIds: recipients })
  }
  await publishBusinessInvalidation(env, input.organizationId)
}

async function afterWrite(db: DbClient, viewer: TaskViewer, taskId: string, assigned?: string): Promise<TaskView> {
  const env = viewer.principal.env as CloudflareEnv
  if (assigned) {
    // A job given to a cleaner is posted in the stay's conversation when the business change below wakes the organization's jobs.
    const row = await queryFirst<Pick<TaskRow, 'kind' | 'dedupe_key'>>(db, 'SELECT kind, dedupe_key FROM tasks WHERE organization_id = ? AND id = ?', [viewer.principal.organizationId, taskId])
    if (!row) throw new Error(`Task ${taskId} disappeared after its write`)
    const recipients = isJobTask(row) && await jobHasConversation(db, viewer.principal.organizationId, assigned) ? []
      : (await assigneeUsers(db, viewer.principal.organizationId, assigned)).filter(userId => userId !== viewer.principal.userId)
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
  const key = text(body.idempotency_key, 'idempotency_key', 200, true)!
  const title = text(body.title, 'title', 200, true)!
  const notes = text(body.notes, 'notes', 5000)
  const startsAt = instant(body.starts_at, 'starts_at'), dueAt = instant(body.due_at, 'due_at')
  if (startsAt && dueAt && startsAt > dueAt) fail(422, 'INVALID_TASK_FIELD', 'starts_at must not be after due_at', 'starts_at')
  const actorId = viewer.principal.userId
  const productId = body.product_id ?? null, locationId = body.location_id ?? null
  const assignedMemberId = body.assigned_member_id ?? null
  const dedupeKey = `custom:${organizationId}:${key}`
  const eventKey = creationDedupeKey('task', organizationId, key)
  const requestHash = await creationRequestHash({ actorId, title, notes, startsAt, dueAt, productId, locationId, assignedMemberId })
  const readReplay = async (): Promise<string | null> => {
    const record = await readCreationRecord(db, eventKey)
    if (!record) return null
    if (record.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different task request', 'idempotency_key')
    return record.entityId
  }
  const replayId = await readReplay()
  if (replayId) return { task: await afterWrite(db, viewer, replayId), created: false }

  const assigned = await readTaskAssignee(db, organizationId, body)
  type Place = { location_id: string; timezone: string }
  const places = productId !== null
    ? await queryAll<Place>(db, `SELECT pl.location_id, l.timezone FROM product_locations pl
        JOIN business_locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id
        WHERE pl.organization_id = ? AND pl.product_id = ? ${locationId !== null ? 'AND pl.location_id = ?' : ''} LIMIT 2`,
      [organizationId, productId, ...(locationId !== null ? [locationId] : [])])
    : locationId !== null ? await queryAll<Place>(db, 'SELECT id AS location_id, timezone FROM business_locations WHERE organization_id = ? AND id = ?', [organizationId, locationId]) : []
  if (places.length > 1) fail(422, 'TASK_LOCATION_REQUIRED', 'Choose a location for a product linked to multiple locations', 'location_id')
  const place = places[0]
  if ((productId !== null || locationId !== null) && !place) fail(422, 'INVALID_TASK_FIELD', productId !== null ? 'The offering is not at that location in this organization' : 'The location is not in this organization', productId !== null ? 'product_id' : 'location_id')
  const organization = await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [organizationId])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const id = crypto.randomUUID(), now = new Date().toISOString()
  const resolvedLocationId = place?.location_id ?? null
  const results = await executeBatch(db, [{
    query: `INSERT INTO tasks (id, organization_id, kind, product_id, location_id, title, notes, assigned_member_id, starts_at, due_at, timezone, status, dedupe_key, version, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [id, organizationId, productId, resolvedLocationId, title, notes, assigned, startsAt, dueAt, place?.timezone ?? organization.timezone, dedupeKey, actorId, now, now],
  }, organizationEventQuery({ organizationId, locationId: resolvedLocationId, actorId, eventType: 'task.created', entityType: 'task', entityId: id,
    dedupeKey: eventKey, metadata: { kind: 'custom', request_hash: requestHash }, onlyIfPreviousChangedOneRow: true,
    afterState: { title, assigned_member_id: assigned, starts_at: startsAt, due_at: dueAt },
  })], { operation: 'Create task' })
  if (results[0]?.meta.changes !== 1) {
    const winnerId = await readReplay()
    if (!winnerId) fail(409, 'IDEMPOTENCY_CONFLICT', 'This key already belongs to a task whose original request could not be verified. Read your tasks before creating another.', 'idempotency_key')
    return { task: await afterWrite(db, viewer, winnerId), created: false }
  }
  return { task: await afterWrite(db, viewer, id, assigned ?? undefined), created: true }
}

export async function updateTask(db: DbClient, viewer: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskView> {
  const current = await readTaskRow(db, viewer, taskId)
  const touchesAssignee = body.assigned_member_id !== undefined
  await assertRoleAllows({ ...viewer.principal, permissions: { task: touchesAssignee ? ['assign'] : ['update'] } })
  if (body.version !== current.version) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'version')
  if (current.status !== 'open') fail(409, 'TASK_CLOSED', 'Reopen the task before changing it', 'status')
  const assigned = touchesAssignee ? await readTaskAssignee(db, viewer.principal.organizationId, body) : current.assigned_member_id
  const startsAt = body.starts_at === undefined ? current.starts_at : instant(body.starts_at, 'starts_at')
  const dueAt = body.due_at === undefined ? current.due_at : instant(body.due_at, 'due_at')
  if (startsAt && dueAt && startsAt > dueAt) fail(422, 'INVALID_TASK_FIELD', 'starts_at must not be after due_at', 'starts_at')
  const notes = body.notes === undefined ? current.notes : text(body.notes, 'notes', 5000)
  const title = body.title === undefined ? current.title : current.kind === 'custom' || current.kind === 'opportunity' ? text(body.title, 'title', 200, true) : fail(422, 'INVALID_TASK_FIELD', 'This task takes its title from what it is about', 'title')
  const after = { assigned_member_id: assigned, starts_at: startsAt, due_at: dueAt, notes, title }
  const before = { assigned_member_id: current.assigned_member_id, starts_at: current.starts_at, due_at: current.due_at, notes: current.notes, title: current.title }
  if (JSON.stringify(after) === JSON.stringify(before)) fail(422, 'INVALID_TASK_FIELD', 'Provide at least one change', 'task')
  const reassigned = after.assigned_member_id !== before.assigned_member_id
  const results = await executeBatch(db, [{
    query: `UPDATE tasks SET assigned_member_id = ?, starts_at = ?, due_at = ?, notes = ?, title = ?, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND status = 'open'`,
    params: [after.assigned_member_id, startsAt, dueAt, notes, title, new Date().toISOString(), viewer.principal.organizationId, taskId, current.version],
  }, taskEventQuery(viewer, current, reassigned ? 'task.assigned' : 'task.updated', { before, after })], { operation: 'Update task' })
  if (results[0]?.meta.changes !== 1) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'version')
  return afterWrite(db, viewer, taskId, reassigned && assigned ? assigned : undefined)
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
  const note = text(input.note, 'note', 5000)
  const now = new Date().toISOString()
  const organizationId = viewer.principal.organizationId
  // A job closes in its conversation too: the note and photos are the person's own message there, and nobody is alerted.
  // The conversation that carries this job is the one its automatic post went to, and the closer must still sit in it.
  const privatePrep = current.subject_type === 'product_session'
  const hasThread = view.booking_id && (isJobTask(current) || (privatePrep
    && await jobHasConversation(db, organizationId, current.assigned_member_id)))
  const thread = hasThread ? await queryFirst<{ id: string }>(db, `SELECT c.id FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.author_kind = 'krabiclaw'
      JOIN conversation_participants seat ON seat.conversation_id = c.id AND seat.user_id = ?
     WHERE c.organization_id = ? AND c.kind = 'team' AND c.booking_id = ?
       AND (? = 0 OR EXISTS (SELECT 1 FROM conversation_participants assignee
         JOIN member assigned ON assigned.organizationId = c.organization_id AND assigned.userId = assignee.user_id
         WHERE assignee.conversation_id = c.id AND assigned.id = ?))
       AND (json_extract(m.payload_json, '$.key') = ? OR instr(json_extract(m.payload_json, '$.key'), ?) = 1)
       AND (? = 0 OR NOT EXISTS (SELECT 1 FROM messages later JOIN json_each(?) stop
         ON json_extract(later.payload_json, '$.key') = stop.value OR instr(json_extract(later.payload_json, '$.key'), stop.value || ':') = 1
         WHERE later.conversation_id = c.id AND later.author_kind = 'krabiclaw' AND later.sequence > m.sequence))
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1`, [viewer.principal.userId, organizationId, view.booking_id, privatePrep ? 1 : 0, current.assigned_member_id,
    jobKey(current), `${jobKey(current)}:after:`, privatePrep ? 1 : 0, d1JsonStringSet(jobEndKeys(current.id))]) : null
  const assetIds = input.photos.length ? await uploadMessagePhotos(db, input.env, organizationId, input.photos, { source: 'uploaded', userId: viewer.principal.userId })
    .catch((error: unknown) => error instanceof MessagePhotoRejection ? fail(422, 'INVALID_PHOTO', error.message, 'photos') : Promise.reject(error)) : []
  // The person's own message in the job's conversation, written by the one message writer.
  const message = thread ? messageQueries({
    conversationId: thread.id, authorKind: 'member', authorUserId: viewer.principal.userId,
    body: note ?? (input.status === 'done' ? 'Done' : 'Skipped'), dedupeKey: `team:${thread.id}:task-closed:${taskId}:${current.version + 1}`,
    guard: { sql: 'EXISTS (SELECT 1 FROM conversation_participants seat WHERE seat.conversation_id = c.id AND seat.user_id = ?)', params: [viewer.principal.userId] },
  }) : null
  const closedMessage: BatchQuery[] = message ? [...message.queries, ...messagePhotoPlacements(organizationId, 'message', message.id, assetIds, now)] : []
  try {
    await executeBatch(db, [{
      query: `UPDATE tasks SET status = ?, outcome_note = ?, closed_at = ?, closed_by_user_id = ?, version = version + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND version = ? AND status = 'open'`,
      params: [input.status, note, now, viewer.principal.userId, now, organizationId, taskId, current.version],
    },
    // Everything after this is this request's own close: a close that lost to another one fails the batch here.
    { query: "SELECT CASE WHEN changes() = 1 THEN NULL ELSE json('TASK_VERSION_CONFLICT') END" },
    taskEventQuery(viewer, current, input.status === 'done' ? 'task.completed' : 'task.skipped', { after: { status: input.status, outcome_note: note, photos: assetIds.length } }),
    ...messagePhotoPlacements(organizationId, 'task', taskId, assetIds, now), ...closedMessage], { operation: input.status === 'done' ? 'Complete task' : 'Skip task' })
  } catch (error) {
    await discardMessagePhotos(db, input.env, viewer.principal.organizationId, assetIds, viewer.principal.userId, error)
    if (/malformed JSON/.test(error instanceof Error ? error.message : String(error))) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'task')
    throw error
  }
  if (thread) await publishConversationEvent(input.env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
  return afterWrite(db, viewer, taskId)
}

export async function reopenTask(db: DbClient, viewer: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskView> {
  const current = await readTaskRow(db, viewer, taskId)
  const view = present(current, viewer, await loadContext(db, viewer, [current]), new Date())
  if (!view.can.reopen) fail(409, 'TASK_NOT_REOPENABLE', 'Only a task a person closed can be reopened, by them or a manager', 'status')
  if (body.version !== current.version) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'version')
  const now = new Date().toISOString()
  const results = await executeBatch(db, [{
    query: `UPDATE tasks SET status = 'open', outcome_note = NULL, closed_at = NULL, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND status IN ('done', 'skipped')`,
    params: [now, viewer.principal.organizationId, taskId, current.version],
  }, taskEventQuery(viewer, current, 'task.reopened', { before: { status: current.status, outcome_note: current.outcome_note } }),
  { query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'task' AND owner_id = ? AND changes() = 1`, params: [viewer.principal.organizationId, taskId] }], { operation: 'Reopen task' })
  if (results[0]?.meta.changes !== 1) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'version')
  return afterWrite(db, viewer, taskId)
}

/** The accepted opportunity's task, written in the accept's own batch. */
export function opportunityTaskInsert(input: { organizationId: string; opportunityId: string; title: string; subject: { type: TaskRow['subject_type']; id: string } | null; productId: string | null; locationId: string | null; assignedMemberId: string | null; dueAt: string | null; timezone: string; userId: string; now: string; taskId: string }): BatchQuery {
  return {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, opportunity_id, title, assigned_member_id, due_at, timezone, status, dedupe_key, version, created_by_user_id, created_at, updated_at)
      SELECT ?, ?, 'opportunity', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ? WHERE changes() = 1`,
    params: [input.taskId, input.organizationId, input.subject?.type ?? null, input.subject?.id ?? null, input.productId, input.locationId, input.opportunityId, input.title,
      input.assignedMemberId, input.dueAt, input.timezone, `opportunity:${input.opportunityId}`, input.userId, input.now, input.now],
  }
}

