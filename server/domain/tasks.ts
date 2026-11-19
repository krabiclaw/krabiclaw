import { PLATFORM_MESSAGE_AUTHOR_KINDS_SQL } from '~/shared/messages-contract'
import { listingGrantSql, staffAccessWritesEnabled } from '~/server/domain/listing-access'
import { assignedOperationsRoles, isOrganizationRole, organizationRoleCards, roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { publishChangedJobs } from '~/server/events'
import { HTTPError } from 'nitro'
import type { ProductKind } from '~/shared/product-details'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, locationMemberSql, roleAllows, type MemberAccessPrincipal, type ViewerTerms } from '~/server/utils/member-access'
import { creationDedupeKey, creationRequestHash, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { publishBusinessInvalidation, publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { conversationMemberSql, messageQueries, participantGuard } from '~/server/domain/conversations'
import { firstName } from '~/server/domain/guest-threads/presentation'
import { discardMessagePhotos, groupMessagePhotos, messagePhotoPlacements, messagePhotoRowsSql, MessagePhotoRejection, uploadMessagePhotos, type MessagePhoto, type MessagePhotoRow } from '~/server/domain/guest-threads/attachments'
import { bookingEditorPath, guestConversationPath } from '~/server/utils/dashboard-links'
import { ownerPicture } from '~/server/notifications/hero'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { addLocalDays, formatCalendarDate, formatTimestamp, isValidInstant, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import type { CloudflareEnv } from '~/server/utils/auth'
import { BOOKING_RECORDS_SQL, bookingDay } from '~/server/domain/requests'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { guestGroup } from '~/shared/dashboard-today'

/*
  A turnover or failed scheduled message follows changes to its subject.
  People create custom tasks. People assign, reschedule, complete, skip and
  reopen them here, from the dashboard, MCP and the app alike.
*/

export const TASK_KINDS = ['turnover', 'message_delivery', 'booking_review', 'booking_change', 'custom', 'consultation_prep', 'consultation_follow_up'] as const
export const SUPPORTED_TASK_KINDS = d1JsonStringSet(TASK_KINDS)
export type TaskKind = typeof TASK_KINDS[number]
export type TaskStatus = 'open' | 'done' | 'skipped' | 'cancelled'

export interface TaskRow {
  id: string; organization_id: string; kind: TaskKind
  subject_type: 'scheduled_guest_message' | 'booking' | 'product_session' | null; subject_id: string | null
  product_id: string | null; location_id: string | null
  title: string | null; notes: string | null
  assigned_member_id: string | null
  claim_role?: string | null
  starts_at: string | null; due_at: string | null; timezone: string
  status: TaskStatus; closed_at: string | null; closed_by_user_id: string | null
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

export function isJobTask(row: Pick<TaskRow, 'kind'>): boolean {
  return row.kind === 'turnover' || row.kind === 'consultation_follow_up'
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
  return { id: row.subject_id, unit: row.kind === 'turnover' ? 'nights' : 'slot' }
}

/** The key of a job's post in its team conversation (messages.payload_json $.key): the one place it is built. */
const JOB_POST_PREFIX = 'job:'
export const jobKey = (task: Pick<TaskRow, 'id' | 'product_id'>, after?: string) => `${JOB_POST_PREFIX}${task.id}:${task.product_id}${after ? `:after:${after}` : ''}`
export function jobPostMatchSql(task: string, message: string): string {
  const key = `json_extract(${message}.payload_json, '$.key')`
  const base = `('${JOB_POST_PREFIX}' || ${task}.id || ':' || COALESCE(${task}.product_id, 'null'))`
  return `(${key} = ${base} OR instr(${key}, ${base} || ':after:') = 1)`
}
const JOB_END_STATES = ['released', 'cancelled', 'closed'] as const
export const jobEndKeys = (taskId: string) => JOB_END_STATES.map(state => `${state}:${taskId}`)

/**
 * Who a job is given when it is written: the offering's or home's member, else
 * the organization's owner (the first, by when they joined). A job is never
 * stored with nobody; the one place the fallback is written.
 */
export const jobAssigneeSql = (organizationSql: string, memberSql: string) =>
  `COALESCE(${memberSql}, (SELECT owner.id FROM member owner WHERE owner.organizationId = ${organizationSql} AND owner.role = 'owner' ORDER BY owner.createdAt, owner.id LIMIT 1))`

// ---------------------------------------------------------------------------
// Subject writes. Each returns statements for the batch that changes the
// subject, so the task and its subject commit together.
// ---------------------------------------------------------------------------

/** A stay as one write leaves it: the turnover window is computed for this state. */
export interface StayWindow { id: string; product_id: string; status: 'pending' | 'confirmed' | 'cancelled'; check_in_date: string; check_out_date: string }

export interface TurnoverHome {
  product_id: string
  location_id: string
  timezone: string
  check_in_time: string | null
  check_out_time: string | null
  assigned_member_id: string | null
  turnover_neighbours: string
}

/** A nights booking's stored ends read as the home's days. */
type StoredStay = { id: string; product_id: string; status: StayWindow['status']; starts_at: string; ends_at: string; actual_check_out_date: string | null; timezone: string }
const stayWindowOf = (row: StoredStay): StayWindow => ({ id: row.id, product_id: row.product_id, status: row.status, check_in_date: bookingDay(row.starts_at, row.timezone), check_out_date: row.actual_check_out_date ?? bookingDay(row.ends_at, row.timezone) })

function nextTurnoverArrival<T extends Pick<StayWindow, 'id' | 'check_in_date'>>(stay: Pick<StayWindow, 'id' | 'check_out_date'>, confirmed: T[]): T | null {
  return confirmed.reduce<T | null>((next, other) => other.id === stay.id || other.check_in_date < stay.check_out_date
    || next && (other.check_in_date > next.check_in_date || other.check_in_date === next.check_in_date && other.id > next.id)
    ? next : other, null)
}

/** A stored end on this local day: the day alone, or an instant within it. */
function storedOn(column: string, date: string, timezone: string): BatchQuery {
  return { query: `(${column} = ? OR (length(${column}) > 10 AND ${column} >= ? AND ${column} < ?))`,
    params: [date, localDateTimeToInstant(date, '00:00', timezone, 'earlier').toISOString(), localDateTimeToInstant(addLocalDays(date, 1), '00:00', timezone, 'earlier').toISOString()] }
}

/** The batch guard: the turnover statements apply only if the booking is what they were computed for, its ends on these days in its home's clock. */
function stayIs(organizationId: string, stay: StayWindow, timezone: string): BatchQuery {
  const starts = storedOn('starts_at', stay.check_in_date, timezone), ends = storedOn('COALESCE(actual_check_out_date, ends_at)', stay.check_out_date, timezone)
  return { query: `EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND product_id = ? AND status = ? AND product_session_id IS NULL AND ${starts.query} AND ${ends.query})`,
    params: [organizationId, stay.id, stay.product_id, stay.status, ...starts.params!, ...ends.params!] }
}

export const TURNOVER_HOME_FROM = `product_stay_configs c
  JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
  JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id`

/** The clocks and neighbouring stays in a projection that already reads the home. */
export function turnoverHomeColumns(checkIn: string): string {
  const fields = {
    product_id: 'c.product_id',
    location_id: 'c.location_id',
    timezone: 'l.timezone',
    check_in_time: 'b.check_in_time',
    check_out_time: 'b.check_out_time',
    assigned_member_id: 'b.assigned_member_id',
    // Read one day wider for a checkout instant on a different UTC day than its local day.
    turnover_neighbours: `(SELECT json_group_array(json_object('id', id, 'product_id', product_id, 'status', status,
      'starts_at', starts_at, 'ends_at', ends_at, 'actual_check_out_date', actual_check_out_date, 'timezone', timezone))
      FROM (SELECT id, product_id, status, starts_at, ends_at, actual_check_out_date, timezone FROM bookings
        WHERE organization_id = c.organization_id AND product_id = c.product_id AND product_session_id IS NULL
          AND status = 'confirmed' AND ends_at >= date(${checkIn}, '-401 days')
        ORDER BY id)) || ''`,
  } satisfies Record<keyof TurnoverHome, string>
  return Object.entries(fields).map(([key, value]) => `${value} AS ${key}`).join(', ')
}

type TurnoverAnchor = Pick<StayWindow, 'product_id' | 'check_in_date'>
type TurnoverChange = { organizationId: string; before: TurnoverAnchor | null; after: TurnoverAnchor }

function turnoverAnchors({ after, before }: TurnoverChange) {
  const anchors = new Map([[after.product_id, [after.check_in_date]]])
  if (before) anchors.set(before.product_id, [...(anchors.get(before.product_id) ?? []), before.check_in_date].sort())
  return anchors
}

/** A move supplies both affected homes through one read of the same facts. */
export function readTurnoverHomes(db: DbClient, change: TurnoverChange): Promise<TurnoverHome[]> {
  const anchors = Object.fromEntries(Array.from(turnoverAnchors(change), ([product, dates]) => [product, dates[0]!]))
  return queryAll<TurnoverHome>(db, `SELECT ${turnoverHomeColumns('anchor.value')}
    FROM ${TURNOVER_HOME_FROM} JOIN json_each(?) anchor ON c.product_id = anchor.key
    WHERE c.organization_id = ?`, [JSON.stringify(anchors), change.organizationId])
}

function turnoverTimes(home: TurnoverHome, checkout: string, next: string | null) {
  const startsAt = home.check_out_time === null ? null : localDateTimeToInstant(checkout, home.check_out_time, home.timezone, 'compatible').toISOString()
  const arrival = next === null || home.check_in_time === null ? null : localDateTimeToInstant(next, home.check_in_time, home.timezone, 'compatible').toISOString()
  return { startsAt, dueAt: arrival !== null && startsAt !== null && arrival < startsAt ? startsAt : arrival }
}

/** After a home merge, every open turnover uses the surviving home's hours and combined bookings. */
export async function mergedHomeTurnovers(db: DbClient, organizationId: string, sourceId: string, targetId: string, today: string, now: string): Promise<BatchQuery> {
  const homes = await readTurnoverHomes(db, {
    organizationId, before: { product_id: sourceId, check_in_date: today }, after: { product_id: targetId, check_in_date: today },
  })
  const target = homes.find(home => home.product_id === targetId)
  if (!target) throw new Error(`Home ${targetId} has no stay settings`)
  const stays = homes.flatMap(home => (JSON.parse(home.turnover_neighbours) as StoredStay[]).map(stayWindowOf))
  const times = stays.map(stay => {
    const { startsAt, dueAt } = turnoverTimes(target, stay.check_out_date, nextTurnoverArrival(stay, stays)?.check_in_date ?? null)
    return { id: stay.id, starts_at: startsAt, due_at: dueAt }
  })
  return {
    query: `UPDATE tasks SET starts_at = json_extract(window.value, '$.starts_at'),
        due_at = json_extract(window.value, '$.due_at'), updated_at = ?, version = tasks.version + 1
      FROM json_each(?) window WHERE tasks.organization_id = ? AND tasks.product_id = ? AND tasks.kind = 'turnover'
        AND tasks.status = 'open' AND tasks.subject_id = json_extract(window.value, '$.id')
        AND (tasks.starts_at IS NOT json_extract(window.value, '$.starts_at') OR tasks.due_at IS NOT json_extract(window.value, '$.due_at'))`,
    params: [now, JSON.stringify(times), organizationId, targetId],
  }
}

/**
 * The turnover tasks one stay write changes: the stay's own (opened when it is
 * confirmed and checks out today or later, moved with it, cancelled with it),
 * and the turnover before it at its old and new place, whose window ends at
 * the next arrival.
 * `before` is the stay as it was, null when the write creates it.
 */
export function turnoverTaskQueries(input: TurnoverChange & { after: StayWindow; now: string; homes: TurnoverHome[] }) {
  const { organizationId, after, now, homes } = input
  const afterHome = homes.find(home => home.product_id === after.product_id)
  if (!afterHome) throw new Error(`Home ${after.product_id} has no stay settings`)
  const guard = stayIs(organizationId, after, afterHome.timezone)
  const queries: BatchQuery[] = []
  const windows = new Map<string, { stay: StayWindow; home: TurnoverHome; next: string | null }>()
  for (const [productId, anchors] of turnoverAnchors(input)) {
    const home = homes.find(home => home.product_id === productId)
    if (!home) throw new Error(`Home ${productId} has no stay settings`)
    const firstCheckout = addLocalDays(anchors[0]!, -400)
    const rows = JSON.parse(home.turnover_neighbours) as StoredStay[]
    const others = rows.filter(row => row.id !== after.id).map(stayWindowOf).filter(stay => stay.check_out_date >= firstCheckout)
    const confirmed = [...others, ...(after.product_id === productId && after.status === 'confirmed' ? [after] : [])]
    const nextArrival = (stay: StayWindow) => nextTurnoverArrival(stay, confirmed)?.check_in_date ?? null
    const previousStay = (date: string) => confirmed.filter(other => other.id !== after.id && other.check_out_date <= date)
      .reduce<StayWindow | null>((latest, other) => latest === null || other.check_out_date > latest.check_out_date ? other : latest, null)
    if (after.product_id === productId && after.status === 'confirmed') windows.set(after.id, { stay: after, home, next: nextArrival(after) })
    for (const anchor of anchors) {
      const previous = previousStay(anchor)
      if (previous) windows.set(previous.id, { stay: previous, home, next: nextArrival(previous) })
    }
  }
  for (const { stay, home, next } of windows.values()) {
    const { startsAt, dueAt } = turnoverTimes(home, stay.check_out_date, next)
    const key = `turnover:${stay.id}`
    queries.push({
      query: `UPDATE tasks SET product_id = ?, location_id = ?, timezone = ?, starts_at = ?, due_at = ?,
          assigned_member_id = CASE WHEN product_id IS ? AND assigned_member_id IS NOT NULL THEN assigned_member_id ELSE ${jobAssigneeSql('organization_id', '?')} END,
          version = version + 1, updated_at = ?
        WHERE dedupe_key = ? AND status = 'open' AND (${guard.query})
          AND (product_id IS NOT ? OR starts_at IS NOT ? OR due_at IS NOT ?) RETURNING id AS changed_task_id`,
      params: [home.product_id, home.location_id, home.timezone, startsAt, dueAt, home.product_id, home.assigned_member_id, now, key, ...guard.params!, home.product_id, startsAt, dueAt],
    })
    // A stay that checked out before today at its home is history, not work.
    if (stay.check_out_date >= localDateAt(new Date(now), home.timezone)) {
      queries.push({
        query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id,
            starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
          SELECT ?, ?, 'turnover', 'booking', ?, ?, ?, ${jobAssigneeSql('?', '?')}, ?, ?, ?, 'open', ?, 1, ?, ? WHERE (${guard.query})
          ON CONFLICT (dedupe_key) DO NOTHING RETURNING id AS changed_task_id`,
        params: [crypto.randomUUID(), organizationId, stay.id, home.product_id, home.location_id, home.assigned_member_id, organizationId,
          startsAt, dueAt, home.timezone, key, now, now, ...guard.params!],
      })
    }
  }
  if (after.status !== 'confirmed') {
    queries.push({
      query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = version + 1, updated_at = ?
        WHERE dedupe_key = ? AND status = 'open' AND (${guard.query}) RETURNING id AS changed_task_id`,
      params: [now, now, `turnover:${after.id}`, ...guard.params!],
    })
  }
  const keys = [...windows.keys()].map(id => `turnover:${id}`)
  if (after.status !== 'confirmed') keys.push(`turnover:${after.id}`)
  return { queries, keys }
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

// ---------------------------------------------------------------------------
// Who may see and act on a task.
// ---------------------------------------------------------------------------

/**
 * One prep task for the session's assigned member (else the owner) while any confirmed booking
 * still holds it. The caller supplies the affected session IDs in its write batch.
 */
export function sessionPrepTaskQueries(sessions: BatchQuery, now: string): BatchQuery[] {
  const confirmed = `EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = s.organization_id
    AND b.product_session_id = s.id AND b.status = 'confirmed')`
  return [{
    query: `UPDATE tasks SET status = 'cancelled', closed_at = ?, closed_by_user_id = NULL, version = tasks.version + 1, updated_at = ?
      FROM product_sessions s JOIN product_booking_configs cfg ON cfg.organization_id = s.organization_id AND cfg.product_id = s.product_id
      WHERE tasks.kind = 'consultation_prep' AND tasks.subject_type = 'product_session' AND tasks.subject_id = s.id
        AND tasks.organization_id = s.organization_id AND tasks.status = 'open' AND s.id IN (${sessions.query})
        AND (s.status <> 'scheduled' OR NOT ${confirmed}) RETURNING id AS changed_task_id`,
    params: [now, now, ...(sessions.params ?? [])],
  }, {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, assigned_member_id, starts_at, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
      SELECT 'session-prep:' || s.id, s.organization_id, 'consultation_prep', 'product_session', s.id, s.product_id, s.location_id,
        ${jobAssigneeSql('s.organization_id', 'cfg.assigned_member_id')}, s.starts_at, s.starts_at, s.timezone, 'open', 'consultation_prep:session:' || s.id, 1, ?, ?
      FROM product_sessions s JOIN product_booking_configs cfg ON cfg.organization_id = s.organization_id AND cfg.product_id = s.product_id
      WHERE s.id IN (${sessions.query}) AND s.status = 'scheduled' AND s.starts_at > ? AND ${confirmed}
      ON CONFLICT (dedupe_key) DO UPDATE SET status = 'open', closed_at = NULL, closed_by_user_id = NULL,
        assigned_member_id = excluded.assigned_member_id, starts_at = excluded.starts_at, due_at = excluded.due_at, timezone = excluded.timezone,
        version = tasks.version + 1, updated_at = excluded.updated_at
      WHERE tasks.status = 'cancelled' OR (tasks.status = 'open' AND (tasks.assigned_member_id IS NOT excluded.assigned_member_id
        OR tasks.starts_at IS NOT excluded.starts_at OR tasks.timezone IS NOT excluded.timezone)) RETURNING id AS changed_task_id`,
    params: [now, now, ...(sessions.params ?? []), now],
  }]
}

export interface TaskViewer { principal: MemberAccessPrincipal; manage: boolean; memberId: string }

export async function taskViewer(principal: MemberAccessPrincipal): Promise<TaskViewer> {
  await assertRoleAllows({ ...principal, permissions: { task: ['read'] } })
  return { principal, manage: await roleAllows({ ...principal, permissions: { task: ['assign'] } }), memberId: principal.memberId }
}

/**
 * A member reads the tasks given to them, every task at an offering or location
 * they are responsible for; an owner or admin reads every task. The member row
 * is matched in the same statement.
 */
const claimRoles = rolesAllowing({ task: ['claim'] })

function claimAudienceSql(task: string, member: string) {
  return `${task}.kind = 'custom' AND ${task}.claim_role IS NOT NULL
    AND ${roleMatchesSql(`${member}.role`, claimRoles)}
    AND instr(',' || replace(${member}.role, ' ', '') || ',', ',' || ${task}.claim_role || ',') > 0
    AND ${listingGrantSql(`${task}.organization_id`, `${task}.product_id`, `${member}.id`, 'task')}`
}

export function taskScopeSql(alias: string, who: () => ViewerTerms): string {
  return `${alias}.kind IN (SELECT value FROM json_each('${SUPPORTED_TASK_KINDS}')) AND EXISTS (
    SELECT 1 FROM member m WHERE m.id = ${who().member} AND m.organizationId = ${who().organization} AND m.userId = ${who().user}
    AND (${who().organizationWide} = 1
      OR (${alias}.claim_role IS NULL AND ${alias}.assigned_member_id = m.id
        AND ${alias}.kind NOT IN ('message_delivery', 'booking_change', 'booking_review'))
      OR ((${alias}.assigned_member_id = m.id OR (${alias}.assigned_member_id IS NULL AND ${alias}.status = 'open'))
        AND ${claimAudienceSql(alias, 'm')})
      OR (${alias}.claim_role IS NULL AND ${roleMatchesSql('m.role', assignedOperationsRoles)}
        AND NOT (${alias}.kind = 'booking_review' AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = ${alias}.subject_id
          AND b.organization_id = ${alias}.organization_id AND b.product_session_id IS NULL))
        AND (${alias}.assigned_member_id = m.id
          OR EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.organization_id = ${alias}.organization_id
            AND c.product_id = ${alias}.product_id AND c.assigned_member_id = m.id)
          OR (${alias}.product_id IS NULL AND ${alias}.location_id IS NOT NULL AND ${locationMemberSql(`${alias}.organization_id`, `${alias}.location_id`, 'm.userId')})))))`
}

/** `taskScopeSql` for a resolved viewer: every term is bound, in the order the SQL reads it. */
function scopeSql(viewer: TaskViewer, alias = 't'): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const { organizationId, userId } = viewer.principal
  const bind = (value: unknown) => { params.push(value); return '?' }
  // Each term is read once per call, so a call binds exactly the term it places.
  const terms = { get organization() { return bind(organizationId) }, get user() { return bind(userId) }, get member() { return bind(viewer.memberId) }, organizationWide: viewer.manage ? '1' : '0' }
  return { sql: taskScopeSql(alias, () => terms), params }
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
interface TaskSheetSide { label: 'Checkout' | 'Check-in'; time: string; guest: string | null }
interface TaskPhoto { id: string; url: string; thumbnail_url: string }
/**
 * A task as its API, MCP, its alert and its job posts read it, every string
 * formatted here. Today draws its own cards (shared/dashboard-today.ts).
 */
export interface TaskView {
  id: string
  kind: TaskKind
  status: TaskStatus
  version: number
  face: 'photo' | 'compact'
  tag: string | null
  avatar: { initial: string; tone: 'warm' | 'cool' } | null
  /** The offering's or home's picture. */
  image_url: string | null
  /** The place or state: "Ocean Avenue Studio", "Waiting for your approval · Raleigh", "Done at 11:48 AM". */
  status_line: string | null
  /** What the work is: "Clean up after Parity’s group of 2", a person, or the task's own title. */
  title: string
  /** The stored window: "11:00 AM – 3:00 PM", "11:00 AM". */
  when: string | null
  /** One sentence of context. */
  detail: string | null
  /** What our record says went wrong: "Check-in instructions didn’t send". */
  error: string | null
  note: string | null
  /** The assignee while open, the person who closed it after. */
  person: TaskPerson | null
  assignee: TaskPerson | null
  /** Done, a pill that opens the subject, or the check that undoes a close. */
  action: { type: 'complete'; label: 'Done' } | { type: 'open'; label: string; path: string } | { type: 'reopen'; label: 'Undo Done' | 'Undo' } | null
  claim?: { label: 'Claim'; path: string; version: number }
  /** How a job post names it: "Turnover", "Ocean Avenue Studio", "Sat, Nov 7". */
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
  /** How an open task is set aside. */
  dismiss: { label: 'Skip' | 'Dismiss' } | null
}

/** A run of cards: Today's open work has no header; "Done"; Upcoming's "Tomorrow" with "Sat, Nov 7" in grey. */
export interface TaskSection { id: string; title: string | null; subtitle: string | null; tasks: TaskView[] }

interface StayFacts { id: string; product_id: string; guest_name: string | null; adults: number; children: number; starts_at: string; ends_at: string; timezone: string; check_in_date: string; check_out_date: string; conversation_id: string }
type StayRow = Omit<StayFacts, 'check_in_date' | 'check_out_date'> & { status: StayWindow['status'] }
/** A nights booking with its guest as their conversation names them; `s` is the booking, `r` its guest conversation. */
const STAY_FACTS = `s.id, s.product_id, s.status, json_extract(r.payload_json, '$.guest.name') AS guest_name, s.adults, s.children, s.starts_at, s.ends_at, s.timezone, r.id AS conversation_id`
function stayFacts(row: StayRow): StayFacts {
  if (row.adults === null || row.children === null) throw new Error(`Stay ${row.id} has no party breakdown`)
  return { ...row, check_in_date: bookingDay(row.starts_at, row.timezone), check_out_date: bookingDay(row.ends_at, row.timezone) }
}
type BookedRow = { id: string; conversation_id: string | null; starts_at: string; ends_at: string; timezone: string; product_kind: ProductKind; unit: 'slot' | 'nights' }
type DeliveryTaskMessage = { id: string; template_title: string; status: string; unreachable_reason: string | null; conversation_id: string | null; booking_id: string }

interface Context {
  slug: string
  vertical: string
  consultations: Map<string, string>
  people: Map<string, { name: string; userId: string }>
  users: Map<string, string>
  /** An offering by id; a task's offering without a name is a broken record. */
  product: (id: string) => { name: string; kind: ProductKind; imageUrl: string | null } | null
  locations: Map<string, string>
  stay: (id: string) => StayFacts | null
  arrival: (stay: StayFacts) => StayFacts | null
  requests: Map<string, { guest_name: string | null; participant: string | null }>
  messages: Map<string, DeliveryTaskMessage>
  /** A booking's conversation, when it is and what was booked. */
  records: Map<string, BookedRow>
  outcomes: Map<string, { note: string | null; photos: TaskPhoto[] }>
}

/**
 * Everything the listed tasks' cards show, as statements a batch runs beside
 * the task read: `listed` is a query of task rows, so no statement waits on
 * another's result. `taskContext` reads their results in this order.
 */
function taskContextQueries(organizationId: string, listed: { sql: string; params: unknown[] }, userId: string): BatchQuery[] {
  const query = (select: string): BatchQuery => ({ query: `WITH listed AS (${listed.sql}), scope(organization_id) AS (SELECT ?) ${select}`, params: [...listed.params, organizationId] })
  const org = '(SELECT organization_id FROM scope)'
  const subjects = (type: string) => `(SELECT subject_id FROM listed WHERE subject_type = '${type}')`
  // The bookings the cards show: a booking task's own, a failed message's, a private consultation's.
  const bookingIds = `(SELECT subject_id FROM listed WHERE subject_type = 'booking' AND kind <> 'turnover'
    UNION SELECT m.booking_id FROM scheduled_guest_messages m WHERE m.organization_id = ${org} AND m.id IN ${subjects('scheduled_guest_message')}
    UNION SELECT ${consultationBookingSql('candidate.id', 'candidate.organization_id')} FROM product_sessions candidate WHERE candidate.organization_id = ${org} AND candidate.id IN ${subjects('product_session')})`
  const stayIds = `(SELECT subject_id FROM listed WHERE kind = 'turnover'
    UNION SELECT * FROM ${bookingIds}
    UNION SELECT incoming.id FROM listed task
      JOIN bookings outgoing ON outgoing.organization_id = task.organization_id AND outgoing.id = task.subject_id
      JOIN bookings incoming ON incoming.organization_id = outgoing.organization_id AND incoming.product_id = outgoing.product_id
        AND incoming.product_session_id IS NULL AND incoming.status = 'confirmed' AND incoming.starts_at >= date(outgoing.ends_at, '-1 day')
      WHERE task.kind = 'turnover')`
  const productIds = `SELECT product_id FROM listed WHERE product_id IS NOT NULL UNION SELECT product_id FROM bookings WHERE organization_id = ${org} AND product_session_id IS NULL AND id IN ${stayIds}`
  const stays = "bookings s JOIN conversations r ON r.organization_id = s.organization_id AND r.booking_id = s.id AND r.kind = 'booking'"
  const pictures = mediaPlacementsQuery({ organizationId, ownerType: 'product', owners: { sql: productIds } })
  const closure = `SELECT t.id AS task_id, m.id AS message_id, m.body FROM listed t
      JOIN messages m ON m.organization_id = t.organization_id AND m.dedupe_key = 'task-closed:' || t.id || ':' || t.version
      JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
      WHERE t.closed_at IS NOT NULL AND c.kind = 'team' AND ${conversationMemberSql('c', '?')}
        AND json_extract(m.payload_json, '$.task_outcome') = 1`
  const outcomePhotos = messagePhotoRowsSql("mp.owner_type = 'message' AND mp.owner_id IN (SELECT message_id FROM closure)", '', ', mp.sort_order')
  return [
    query('SELECT slug, vertical FROM organization WHERE id = (SELECT organization_id FROM scope)'),
    query(`SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ${org}
      AND (m.id IN (SELECT assigned_member_id FROM listed) OR m.userId IN (SELECT closed_by_user_id FROM listed))`),
    query(`SELECT id, title FROM business_locations WHERE organization_id = ${org} AND id IN (SELECT location_id FROM listed WHERE kind <> 'turnover')`),
    query(`SELECT m.id, m.template_title, m.status, CASE WHEN m.error_code = 'GUEST_UNREACHABLE' THEN m.reason END AS unreachable_reason,
      (SELECT c.id FROM conversations c WHERE c.organization_id = m.organization_id AND c.booking_id = m.booking_id AND c.kind = 'booking') AS conversation_id, m.booking_id
      FROM scheduled_guest_messages m WHERE m.organization_id = ${org} AND m.id IN ${subjects('scheduled_guest_message')}`),
    query(`SELECT candidate.id, ${consultationBookingSql('candidate.id', 'candidate.organization_id')} AS booking_id FROM product_sessions candidate
      WHERE candidate.organization_id = ${org} AND candidate.id IN ${subjects('product_session')}`),
    query(`SELECT br.id, br.starts_at, br.ends_at, br.timezone, br.product_kind, br.unit, br.conversation_id FROM ${BOOKING_RECORDS_SQL} br
      WHERE br.organization_id = ${org} AND br.id IN ${bookingIds}`),
    query(`SELECT ${STAY_FACTS} FROM ${stays} WHERE s.organization_id = ${org} AND s.product_session_id IS NULL AND s.id IN ${stayIds}`),
    query(`SELECT id, json_extract(payload_json, '$.guest.name') AS guest_name, json_extract(payload_json, '$.participant.title') AS participant
      FROM conversations WHERE organization_id = ${org} AND kind = 'booking' AND booking_id IN ${bookingIds}`),
    query(`SELECT p.id, p.kind, CASE WHEN p.kind = 'stay' THEN c.internal_name ELSE p.name END AS name
      FROM products p LEFT JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
      WHERE p.organization_id = ${org} AND p.id IN (${productIds})`),
    { query: `WITH listed AS (${listed.sql}), scope(organization_id) AS (SELECT ?) ${pictures.query}`, params: [...listed.params, organizationId, ...pictures.params!] },
    { query: `WITH listed AS (${listed.sql}), closure AS (${closure})
      SELECT closure.*, photos.* FROM closure LEFT JOIN (${outcomePhotos}) photos ON photos.owner_id = closure.message_id
      ORDER BY closure.task_id, photos.sort_order`, params: [...listed.params, userId] },
  ]
}

function taskContext(organizationId: string, rows: TaskRow[], results: Array<{ results: unknown[] }>): Context {
  const [organizations, members, locations, messages, privateConsultations, booked, stayRows, requests, products, pictures, closureRows]
    = results.map(result => result.results) as [
      Array<{ slug: string; vertical: string }>, Array<{ id: string; userId: string; name: string }>, Array<{ id: string; title: string }>,
      DeliveryTaskMessage[],
      Array<{ id: string; booking_id: string | null }>, BookedRow[], StayRow[], Array<{ id: string; guest_name: string | null; participant: string | null }>,
      Array<{ id: string; name: string | null; kind: ProductKind }>, unknown[],
      Array<{ task_id: string; message_id: string; body: string | null } & (MessagePhotoRow | { owner_id: null })>,
    ]
  const organization = organizations[0]
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const placements = groupMediaPlacements(pictures)
  const offerings = new Map(products.map(product => [product.id, product]))
  const stays = new Map(stayRows.map(stay => [stay.id, stay]))
  const stay = (id: string) => { const row = stays.get(id); return row ? stayFacts(row) : null }
  const arrivals = new Map<string, Array<StayRow & { check_in_date: string }>>()
  for (const row of stayRows) {
    if (row.status !== 'confirmed') continue
    const home = arrivals.get(row.product_id) ?? []
    home.push({ ...row, check_in_date: bookingDay(row.starts_at, row.timezone) })
    arrivals.set(row.product_id, home)
  }
  const records = booked.filter(record => record.unit === 'slot' || rows.some(row => row.kind === 'booking_review' && row.subject_id === record.id))
  const photoRows = closureRows.filter((row): row is typeof row & MessagePhotoRow => row.owner_id !== null)
  const photos = groupMessagePhotos(photoRows)
  return {
    slug: organization.slug,
    vertical: organization.vertical,
    consultations: new Map(privateConsultations.flatMap(row => row.booking_id ? [[row.id, row.booking_id] as const] : [])),
    people: new Map(members.map(member => [member.id, { name: member.name, userId: member.userId }])),
    users: new Map(members.map(member => [member.userId, member.name])),
    product: (id) => {
      const product = offerings.get(id)
      if (!product) return null
      if (!product.name?.trim()) throw new Error(`Product ${product.id} has no name for this task`)
      return { name: product.name, kind: product.kind, imageUrl: ownerPicture('product', placements.get(id) ?? [], [])?.imageUrl ?? null }
    },
    locations: new Map(locations.map(location => [location.id, location.title])),
    stay,
    arrival: (outgoing) => {
      const next = nextTurnoverArrival(outgoing, arrivals.get(outgoing.product_id) ?? [])
      return next ? stayFacts(next) : null
    },
    requests: new Map(requests.map(request => [request.id, request])),
    messages: new Map(messages.map(message => [message.id, message])),
    records: new Map(records.map(record => [record.id, record])),
    outcomes: new Map(closureRows.map(row => [row.task_id, { note: row.body, photos: (photos.get(row.message_id) ?? [])
      .map(photo => ({ id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl })) }])),
  }
}

/** The tasks named, as `taskContextQueries` lists them. */
const namedTasks = (organizationId: string, rows: TaskRow[]) => ({ sql: 'SELECT * FROM tasks WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', params: [organizationId, d1JsonStringSet(rows.map(row => row.id))] })

/** The context of tasks already read, in one batch. */
async function loadContext(db: DbClient, viewer: TaskViewer, rows: TaskRow[]): Promise<Context> {
  const organizationId = viewer.principal.organizationId
  return taskContext(organizationId, rows, await executeBatch(db, taskContextQueries(organizationId, namedTasks(organizationId, rows), viewer.principal.userId)))
}

const initialOf = (name: string) => name.trim().charAt(0).toUpperCase()

function present(row: TaskRow, viewer: TaskViewer, context: Context, now: Date): TaskView {
  const zone = row.timezone
  const today = localDateAt(now, zone)
  const time = (instant: string) => formatTimestamp(instant, 'en', zone, { hour: 'numeric', minute: '2-digit' })
  const day = (instant: string) => formatTimestamp(instant, 'en', zone, { weekday: 'short', month: 'short', day: 'numeric' })
  const calendarDay = (date: string) => formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
  const sameDay = (a: string, b: string) => localDateAt(new Date(a), zone) === localDateAt(new Date(b), zone)
  const product = row.product_id ? context.product(row.product_id) : null
  const place = product?.name ?? (row.location_id ? context.locations.get(row.location_id) ?? null : null)
  const member = row.assigned_member_id ? context.people.get(row.assigned_member_id) : null
  const assignee: TaskPerson | null = row.assigned_member_id && member ? { type: 'member', id: row.assigned_member_id, name: member.userId === viewer.principal.userId ? 'You' : member.name, initial: initialOf(member.name), you: member.userId === viewer.principal.userId } : null
  const closerName = row.closed_by_user_id === null ? null : row.closed_by_user_id === viewer.principal.userId ? 'You' : context.users.get(row.closed_by_user_id) ?? 'A former member'
  const closer: TaskPerson | null = closerName === null ? null : { type: 'member', id: row.closed_by_user_id!, name: closerName, initial: initialOf(closerName === 'You' ? context.users.get(row.closed_by_user_id!) ?? 'Y' : closerName), you: closerName === 'You' }
  const conversation = (conversation_id: string | null) => conversation_id ? guestConversationPath(context.slug, conversation_id) : null
  const bookingPath = (bookingId: string) => bookingEditorPath(context.slug, bookingId)
  const who = (name: string | null) => name ? firstName(name) : 'Guest'
  let status_line: string | null = null, title = '', when: string | null = null, detail: string | null = null, error: string | null = null, path: string | null = null
  let booking_id = row.subject_type === 'booking' ? row.subject_id : null
  const product_session_id = row.subject_type === 'product_session' ? row.subject_id : null
  let conversation_id: string | null = null
  let action: TaskView['action'] = { type: 'complete', label: 'Done' }
  let sheet: Omit<TaskView['sheet'], 'checkout' | 'checkin'> = { heading: 'Task', title: '', date: null }
  let checkoutSide: TaskSheetSide | null = null, checkinSide: TaskSheetSide | null = null
  let face: TaskView['face'] = product ? 'photo' : 'compact'
  let avatar: TaskView['avatar'] = null
  switch (row.kind) {
    case 'turnover': {
      const stay = context.stay(row.subject_id!)
      if (!stay || !product) throw new Error(`Turnover ${row.id} has no stay or home`)
      booking_id = stay.id
      title = `Clean up after ${guestGroup(stay.guest_name, stay.adults + stay.children)}`
      status_line = product.name
      // The stored window: checkout, and the next arrival when it is the same day.
      const checkout = row.starts_at === null ? null : time(row.starts_at)
      checkoutSide = { label: 'Checkout', time: checkout ?? 'Time not set', guest: who(stay.guest_name) }
      const next = context.arrival(stay)
      if (next) {
        const localTime = row.due_at === null ? 'Time not set' : time(row.due_at)
        const party = next.adults + next.children
        checkinSide = { label: 'Check-in', time: next.check_in_date === stay.check_out_date ? localTime : `${calendarDay(next.check_in_date)}, ${localTime}`,
          guest: `${who(next.guest_name)} · ${party} ${party === 1 ? 'guest' : 'guests'}` }
      }
      when = checkout && row.due_at !== null && sameDay(row.starts_at!, row.due_at) ? `${checkout} – ${time(row.due_at)}` : checkout
      // The job as its team reads it: "Clean Ocean Avenue Studio after Parity checks out, Sun Nov 15, 11:00 AM."
      const checkoutDay = (row.starts_at === null ? calendarDay(stay.check_out_date) : day(row.starts_at)).replace(',', '')
      detail = `Clean ${product.name} after ${who(stay.guest_name)} checks out, ${checkoutDay}${checkout ? `, ${checkout}` : ''}.`
      path = viewer.manage ? bookingPath(stay.id) : null
      sheet = { heading: 'Turnover', title: product.name, date: row.starts_at === null ? calendarDay(stay.check_out_date) : day(row.starts_at) }
      break
    }
    case 'message_delivery': {
      const message = context.messages.get(row.subject_id!)
      if (!message) throw new Error(`Delivery task ${row.id} has no scheduled message`)
      conversation_id = message.conversation_id
      booking_id = message.booking_id
      // Only what our own record knows: the message, and that it did not send.
      error = `${message.template_title} didn’t send`
      detail = message.unreachable_reason ?? (message.status === 'needs_review' ? 'Its send was already used for a different message. Check the conversation before sending it again.' : 'You can send it yourself from the conversation.')
      const stay = context.stay(message.booking_id)
      if (stay) {
        const home = context.product(stay.product_id)?.name ?? null
        const arrival = stay.check_in_date > today
          ? stay.check_in_date === addLocalDays(today, 1) ? 'Arriving tomorrow' : `Arriving ${calendarDay(stay.check_in_date)}`
          : stay.check_in_date === today ? 'Arriving today' : stay.check_out_date > today ? 'Staying now' : `Checked out ${calendarDay(stay.check_out_date)}`
        status_line = [arrival, home].filter(Boolean).join(' · ')
        title = who(stay.guest_name)
        path = conversation(message.conversation_id) ?? bookingPath(message.booking_id)
        action = { type: 'open', label: message.conversation_id ? 'Open conversation' : 'Open stay', path }
      } else {
        // A consultation, class or table: its time and place, and its conversation when it has one.
        const record = context.records.get(message.booking_id)
        if (!record) throw new Error(`Delivery task ${row.id} has no booking`)
        const request = record.conversation_id ? context.requests.get(record.conversation_id) : undefined
        title = request?.guest_name ? firstName(request.guest_name) : request?.participant ?? 'Guest'
        status_line = [`${day(record.starts_at)}, ${time(record.starts_at)}`, place].filter(Boolean).join(' · ')
        path = conversation(message.conversation_id)
        action = path ? { type: 'open', label: 'Open conversation', path } : { type: 'complete', label: 'Done' }
      }
      sheet = { heading: 'Message', title, date: null }
      face = 'compact'
      avatar = { initial: initialOf(title), tone: 'cool' }
      break
    }
    case 'booking_review': {
      const record = context.records.get(row.subject_id!)
      const request = record?.conversation_id ? context.requests.get(record.conversation_id) : undefined
      if (!record?.conversation_id || !request) throw new Error(`Review task ${row.id} has no booking conversation`)
      conversation_id = record.conversation_id
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      status_line = ['Waiting for your approval', place].filter(Boolean).join(' · ')
      const nights = record.unit === 'nights'
      const checkin = nights ? bookingDay(record.starts_at, record.timezone) : null
      const checkout = nights ? bookingDay(record.ends_at, record.timezone) : null
      detail = checkin && checkout ? `${calendarDay(checkin)} – ${calendarDay(checkout)}` : `${day(record.starts_at)}, ${time(record.starts_at)}`
      path = bookingPath(record.id)
      action = { type: 'open', label: 'Review', path }
      sheet = { heading: nights ? 'Stay request' : 'Booking request', title, date: checkin ? calendarDay(checkin) : day(record.starts_at) }
      face = 'compact'
      avatar = { initial: initialOf(title), tone: 'warm' }
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
        title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Client'
        status_line = [heading, place].filter(Boolean).join(' · ')
        detail = `${day(record.starts_at)}, ${time(record.starts_at)}`
        path = bookingPath(record.id)
        sheet = { heading, title, date: null }
        face = 'compact'
        avatar = { initial: initialOf(title), tone: 'warm' }
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
      sheet = { heading, title, date: day(row.starts_at) }
      break
    }
    case 'consultation_follow_up': {
      const record = context.records.get(row.subject_id!)
      const request = record?.conversation_id ? context.requests.get(record.conversation_id) : undefined
      if (!record?.conversation_id || !request) throw new Error(`Visit job ${row.id} has no booking conversation`)
      const presentation = resolveBookingPresentation(record.product_kind, context.vertical)
      const heading = 'Follow up'
      conversation_id = record.conversation_id
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? `${presentation.counterpartyNoun.charAt(0).toUpperCase()}${presentation.counterpartyNoun.slice(1)}`
      status_line = [heading, place].filter(Boolean).join(' · ')
      detail = `${day(record.starts_at)}, ${time(record.starts_at)}`
      path = bookingPath(record.id)
      sheet = { heading, title, date: null }
      face = 'compact'
      avatar = { initial: initialOf(title), tone: 'warm' }
      break
    }
    case 'booking_change': {
      const stay = context.stay(row.subject_id!)
      const record = stay ? null : context.records.get(row.subject_id!)
      conversation_id = stay?.conversation_id ?? record?.conversation_id ?? null
      const request = conversation_id ? context.requests.get(conversation_id) : undefined
      if (!conversation_id || !request) throw new Error(`Change task ${row.id} has no booking conversation`)
      booking_id = stay?.id ?? (record ? row.subject_id : null)
      title = request.guest_name ? firstName(request.guest_name) : request.participant ?? 'Guest'
      const status = row.starts_at === null ? 'Change requested'
        : row.starts_at > now.toISOString() ? 'Change proposal waiting on the guest' : 'Change proposal expired'
      status_line = [status, place].filter(Boolean).join(' · ')
      detail = record ? `${day(record.starts_at)}, ${time(record.starts_at)}` : null
      path = booking_id ? bookingPath(booking_id) : null
      // A change closes when it is answered or proposed again.
      action = { type: 'open', label: 'Review', path: path! }
      sheet = { heading: 'Change', title, date: null }
      face = 'compact'
      avatar = { initial: initialOf(title), tone: 'cool' }
      break
    }
    case 'custom':
      status_line = ['Task', place].filter(Boolean).join(' · ')
      title = row.title!
      detail = row.notes
      sheet = { heading: 'Task', title, date: row.due_at ? day(row.due_at) : null }
      face = 'compact'
      break
  }
  if (row.status !== 'open') {
    face = 'compact'
    when = null
    error = null
    const at = sameDay(row.closed_at!, now.toISOString()) ? time(row.closed_at!) : day(row.closed_at!)
    status_line = `${row.status === 'done' ? 'Done' : row.status === 'skipped' ? PERSON_WORK.has(row.kind) ? 'Skipped' : 'Dismissed' : 'Cancelled'} at ${at}`
    detail = null
  }
  const available = !viewer.manage && row.assigned_member_id === null && Boolean(row.claim_role) && row.status === 'open'
  if (available) {
    status_line = product?.name ?? null
    detail = null
    action = null
  }
  const mine = assignee?.you ?? false
  const reachable = viewer.manage || mine || PERSON_WORK.has(row.kind) || row.kind === 'booking_change'
  const personClosed = (row.status === 'done' || row.status === 'skipped') && row.closed_by_user_id !== null
  const can = {
    complete: row.status === 'open' && action?.type === 'complete' && reachable,
    skip: row.status === 'open' && reachable && !available,
    reopen: personClosed && (viewer.manage || row.closed_by_user_id === viewer.principal.userId),
    // Prep follows the offering's host; follow-up follows its booking.
    assign: viewer.manage && row.status === 'open' && row.kind !== 'consultation_prep' && row.kind !== 'consultation_follow_up',
    edit: viewer.manage && row.status === 'open',
  }
  if (row.kind === 'consultation_prep' && !viewer.manage && !assignedOperationsRoles.some(role => role === viewer.principal.role)) {
    path = null
    conversation_id = null
  }
  if (row.status !== 'open') action = can.reopen ? { type: 'reopen', label: row.status === 'done' ? 'Undo Done' : 'Undo' } : null
  else if (action?.type === 'complete' && !can.complete) action = null
  const authored = context.outcomes.get(row.id)
  const outcome = row.closed_at === null ? null : { note: authored?.note ?? null, photos: authored?.photos ?? [], closed_at: row.closed_at, closed_by: closerName }
  return {
    id: row.id, kind: row.kind, status: row.status, version: row.version,
    face, tag: row.status === 'open' && row.kind === 'turnover' ? 'Turnover' : null, avatar,
    image_url: product?.imageUrl ?? null, status_line, title, when, detail, error, note: outcome?.note ? `“${outcome.note}”` : null,
    person: row.status === 'open' ? assignee : closer, assignee, action, sheet: { ...sheet, checkout: checkoutSide, checkin: checkinSide },
    ...(available ? { claim: { label: 'Claim', path: taskUpdatePath(row.organization_id, row.id), version: row.version } } : {}),
    starts_at: row.starts_at, due_at: row.due_at, timezone: zone, notes: available ? null : row.notes,
    outcome,
    path, product_id: row.product_id, location_id: row.location_id, booking_id, ...(product_session_id ? { product_session_id } : {}), conversation_id, can,
    dismiss: can.skip ? { label: PERSON_WORK.has(row.kind) ? 'Skip' : 'Dismiss' } : null,
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

/** Today's open work in the owner's order: failed deliveries, turnovers, then everything else. */
/** Work a person does and closes themselves: they Skip it, and say what they found when they finish. Everything else is Dismissed. */
const PERSON_WORK: ReadonlySet<TaskKind> = new Set(['turnover', 'custom', 'consultation_prep', 'consultation_follow_up'])
const TODAY_ORDER: Record<TaskKind, number> = { message_delivery: 0, turnover: 1, booking_review: 2, booking_change: 2, consultation_prep: 2, custom: 3, consultation_follow_up: 3 }

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
  // The tasks and everything their cards show, in one round trip.
  const listed = { sql: `SELECT t.*, COALESCE(s.actual_check_out_date, s.ends_at) AS checkout_at, s.timezone AS checkout_timezone FROM tasks t
    LEFT JOIN bookings s ON t.kind = 'turnover' AND t.starts_at IS NULL AND s.organization_id = t.organization_id AND s.id = t.subject_id
    WHERE t.organization_id = ? AND ${scope.sql} AND ${statusSql}${filters.map(sql => ` AND ${sql}`).join('')}`, params: [organizationId, ...scope.params, ...statusParams, ...params] }
  const [read, ...related] = await executeBatch(db, [
    { query: `${listed.sql} ORDER BY COALESCE(t.starts_at, t.due_at, t.created_at), t.id`, params: listed.params },
    ...taskContextQueries(organizationId, listed, viewer.principal.userId),
  ], { operation: 'List tasks' })
  const rows = read!.results as Array<TaskRow & { checkout_at: string | null; checkout_timezone: string | null }>
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
  if (!shown.length) return { resolved_at: now.toISOString(), sections: [] }
  const context = taskContext(organizationId, rows, related)
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

/** An open task as Today reads it: what it is about, who has it, and the conversation it is done in. */
export interface OpenWorkRow {
  id: string; kind: TaskKind; version: number; subject_type: TaskRow['subject_type']; subject_id: string | null
  product_id: string | null; location_id: string | null; title: string | null; timezone: string; starts_at: string | null; due_at: string | null
  claim_role: string | null; notes: string | null; assigned_member_id: string | null; assignee_name: string | null; assigned_to_viewer: number
  /** Who added a task by hand; 1 when it was the viewer. */
  creator_name: string | null; created_by_viewer: number
  booking_id: string | null; booking_starts_at: string | null; booking_ends_at: string | null; booking_timezone: string | null; booking_unit: 'slot' | 'nights' | null
  party_size: number | null; guest_name: string | null; product_kind: ProductKind | null; product_name: string | null; location_title: string | null
  guest_conversation_id: string | null; viewer_seated: number
  /** The team conversation this job was posted in, when the viewer sits in it. */
  team_conversation_id: string | null
  /** A failed message's template title. */
  message_title: string | null
  unreachable_reason: string | null
}

/**
 * The viewer's open work that Today shows beside its bookings, as one statement:
 * jobs (a turnover, a home to get ready, a follow-up, a consultation's prep),
 * a message that did not send, a change waiting on the business and a task
 * someone added, starting or due on or before `to` (an untimed turnover by its
 * checkout, an untimed make-ready by the arrival; a message, a change or an
 * undated task whenever). A booking's
 * review is its pending booking.
 */
/** An untimed job's day is its booking's: a clean after the checkout. */
const UNTIMED_JOB_DAY_SQL = 'b.ends_at'

export function openWorkQuery(viewer: ViewerTerms, to: string): BatchQuery {
  const wideTo = `${addLocalDays(to, 1)}T23:59:59.999Z`
  return {
    query: `SELECT x.*, b.starts_at AS booking_starts_at, b.ends_at AS booking_ends_at, b.timezone AS booking_timezone,
        CASE WHEN b.id IS NULL THEN NULL WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS booking_unit, b.party_size,
        json_extract(r.payload_json, '$.guest.name') AS guest_name, p.kind AS product_kind, COALESCE(sc.internal_name, p.name) AS product_name, l.title AS location_title,
        r.id AS guest_conversation_id,
        ${conversationMemberSql('r', viewer.user)} AS viewer_seated,
        (SELECT c.id FROM conversations c JOIN conversation_participants seat ON seat.conversation_id = c.id AND seat.user_id = ${viewer.user} AND seat.role = 'member'
          WHERE c.organization_id = x.organization_id AND c.kind = 'team' AND c.booking_id = x.booking_id
            AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author_kind IN (${PLATFORM_MESSAGE_AUTHOR_KINDS_SQL}) AND instr(json_extract(m.payload_json, '$.key'), 'job:' || x.id || ':') = 1)
          ORDER BY c.created_at DESC, c.id LIMIT 1) AS team_conversation_id
      FROM (SELECT t.id, t.organization_id, t.kind, t.version, t.subject_type, t.subject_id, t.product_id, t.location_id, t.title, t.timezone, t.starts_at, t.due_at, t.claim_role, t.assigned_member_id,
          CASE WHEN t.kind = 'custom' AND t.assigned_member_id = ${viewer.member} THEN t.notes END AS notes,
          (SELECT u.name FROM member am JOIN user u ON u.id = am.userId WHERE am.id = t.assigned_member_id AND am.organizationId = t.organization_id) AS assignee_name,
          t.assigned_member_id IS NOT NULL AND t.assigned_member_id = ${viewer.member} AS assigned_to_viewer,
          (SELECT u.name FROM user u WHERE u.id = t.created_by_user_id) AS creator_name, COALESCE(t.created_by_user_id = ${viewer.user}, 0) AS created_by_viewer,
          CASE t.kind WHEN 'message_delivery' THEN g.booking_id
            WHEN 'booking_change' THEN t.subject_id ELSE ${jobBookingIdSql('t')} END AS booking_id,
          g.template_title AS message_title, CASE WHEN g.error_code = 'GUEST_UNREACHABLE' THEN g.reason END AS unreachable_reason
        FROM tasks t
        LEFT JOIN scheduled_guest_messages g ON t.kind = 'message_delivery' AND g.organization_id = t.organization_id AND g.id = t.subject_id
        WHERE t.organization_id = ${viewer.organization} AND t.status = 'open'
          AND t.kind IN ('turnover', 'consultation_follow_up', 'consultation_prep', 'message_delivery', 'booking_change', 'custom')
          AND ${taskScopeSql('t', () => viewer)}) x
      LEFT JOIN bookings b ON b.organization_id = x.organization_id AND b.id = x.booking_id
      LEFT JOIN products p ON p.organization_id = x.organization_id AND p.id = COALESCE(b.product_id, x.product_id)
      LEFT JOIN product_stay_configs sc ON b.product_session_id IS NULL AND sc.organization_id = b.organization_id AND sc.product_id = b.product_id
      LEFT JOIN business_locations l ON l.organization_id = b.organization_id AND l.id = COALESCE(b.location_id, sc.location_id)
      LEFT JOIN conversations r ON r.organization_id = b.organization_id AND r.booking_id = b.id AND r.kind = 'booking'
     WHERE x.kind IN ('message_delivery', 'booking_change') OR COALESCE(x.starts_at, x.due_at, ${UNTIMED_JOB_DAY_SQL}, '') <= ?
     ORDER BY COALESCE(x.starts_at, x.due_at, ${UNTIMED_JOB_DAY_SQL}), x.id`,
    params: [wideTo],
  }
}

/** The members a manager can give work to, as a statement for the caller's batch; `organization` is a bound id or a SQL term (NULL reads nothing). */
export function taskAssigneesQuery(organization: { sql: string; params?: unknown[] }): BatchQuery {
  return { query: `SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ${organization.sql} ORDER BY u.name, m.id`, params: organization.params ?? [] }
}

/** `taskAssigneesQuery`'s rows as people, the viewer as "You". */
export function taskAssignees(rows: unknown[], userId: string): TaskPerson[] {
  return (rows as Array<{ id: string; userId: string; name: string }>).map(member => ({ type: 'member' as const, id: member.id, name: member.userId === userId ? 'You' : member.name, initial: member.name.trim().charAt(0).toUpperCase(), you: member.userId === userId }))
}

/** The members a manager can give work to; empty for anyone who cannot assign. */
export async function listTaskAssignees(db: DbClient, viewer: TaskViewer): Promise<TaskPerson[]> {
  if (!viewer.manage) return []
  const query = taskAssigneesQuery({ sql: '?', params: [viewer.principal.organizationId] })
  return taskAssignees(await queryAll(db, query.query, query.params), viewer.principal.userId)
}

/** A task as an alert to one of its people tells it: the member projection, with no guest's full name or contact. */
export async function describeTaskForAlert(db: DbClient, organizationId: string, taskId: string, recipientUserId: string): Promise<{ eyebrow: string; title: string; detail: string | null; locationId: string | null; page: string }> {
  const view = await taskViewForUser(db, organizationId, taskId, recipientUserId)
  // The alert opens what the work is about, under the organization's dashboard: its booking, else its conversation, else Today.
  const page = view.booking_id ? `/bookings/${encodeURIComponent(view.booking_id)}` : view.conversation_id ? `/messages/${encodeURIComponent(view.conversation_id)}` : ''
  return { eyebrow: [view.status_line, view.when].filter(Boolean).join(' · '), title: view.title, detail: view.detail, locationId: view.location_id, page }
}

/** A task as one member sees it, from a server path with no caller: the member projection, with no guest's full name or contact. */
export async function taskViewForUser(db: DbClient, organizationId: string, taskId: string, userId: string | null, now = new Date()): Promise<TaskView> {
  const row = await queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE organization_id = ? AND id = ? AND kind IN (SELECT value FROM json_each(?))`, [organizationId, taskId, SUPPORTED_TASK_KINDS])
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

async function afterWrite(db: DbClient, viewer: TaskViewer, taskId: string, assigned?: string): Promise<TaskView> {
  const env = viewer.principal.env as CloudflareEnv
  if (assigned) {
    const row = await queryFirst<Pick<TaskRow, 'kind' | 'dedupe_key'>>(db, 'SELECT kind, dedupe_key FROM tasks WHERE organization_id = ? AND id = ?', [viewer.principal.organizationId, taskId])
    if (!row) throw new Error(`Task ${taskId} disappeared after its write`)
    // A job is told in its conversation; any other task by the task alert.
    const recipients = isJobTask(row) ? []
      : (await assigneeUsers(db, viewer.principal.organizationId, assigned)).filter(userId => userId !== viewer.principal.userId)
    if (recipients.length) {
      const { notifyTaskAssigned } = await import('~/server/utils/notifications')
      await notifyTaskAssigned(env, db, { organizationId: viewer.principal.organizationId, taskId, actorUserId: viewer.principal.userId, recipientUserIds: recipients })
    }
  }
  await publishChangedJobs(env, viewer.principal.organizationId, [taskId])
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
  const claimRole = body.claim_role ?? null
  if (claimRole !== null) {
    if (!staffAccessWritesEnabled(viewer.principal.env)) fail(503, 'STAFF_ACCESS_ROLLOUT', 'Offering work for claiming is not available yet')
    if (typeof claimRole !== 'string' || !isOrganizationRole(claimRole) || !claimRoles.includes(claimRole)
      || !organizationRoleCards[claimRole].access.includes('tasks') || typeof productId !== 'string' || assignedMemberId !== null) {
      fail(422, 'INVALID_TASK_CLAIM_ROLE', 'Choose an eligible role and listing for available work', 'claim_role')
    }
    const roleVertical = organizationRoleCards[claimRole].vertical
    const listing = await queryFirst(db, `SELECT 1 FROM products p JOIN organization o ON o.id = p.organization_id
      WHERE p.organization_id = ? AND p.id = ? AND p.kind IN ('stay', 'table', 'service', 'experience') AND (? IS NULL OR o.vertical = ?)`,
    [organizationId, productId, roleVertical ?? null, roleVertical ?? null])
    if (!listing) fail(422, 'INVALID_TASK_CLAIM_ROLE', 'Choose an eligible role and listing for available work', 'claim_role')
  }
  const dedupeKey = `custom:${organizationId}:${key}`
  const eventKey = creationDedupeKey('task', organizationId, key)
  const requestHash = await creationRequestHash({ actorId, title, notes, startsAt, dueAt, productId, locationId, assignedMemberId, ...(claimRole ? { claim_role: claimRole } : {}) })
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
  if (places.length > 1 && !claimRole) fail(422, 'TASK_LOCATION_REQUIRED', 'Choose a location for a product linked to multiple locations', 'location_id')
  const place = places.length === 1 ? places[0] : undefined
  if ((locationId !== null || (productId !== null && !claimRole)) && !place) fail(422, 'INVALID_TASK_FIELD', productId !== null ? 'The offering is not at that location in this organization' : 'The location is not in this organization', productId !== null ? 'product_id' : 'location_id')
  const organization = await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [organizationId])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const id = crypto.randomUUID(), now = new Date().toISOString()
  const resolvedLocationId = place?.location_id ?? null
  const results = await executeBatch(db, [{
    query: `INSERT INTO tasks (id, organization_id, kind, product_id, location_id, title, notes, assigned_member_id, claim_role, starts_at, due_at, timezone, status, dedupe_key, version, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    params: [id, organizationId, productId, resolvedLocationId, title, notes, assigned, claimRole, startsAt, dueAt, place?.timezone ?? organization.timezone, dedupeKey, actorId, now, now],
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

export const taskUpdatePath = (organizationId: string, taskId: string) =>
  `/api/organizations/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(taskId)}`

async function claimTask(db: DbClient, viewer: TaskViewer, taskId: string, version: unknown): Promise<TaskView> {
  await assertRoleAllows({ ...viewer.principal, permissions: { task: ['claim'] } })
  const audience = `EXISTS (SELECT 1 FROM member m WHERE m.id = ? AND m.organizationId = t.organization_id
    AND m.userId = ? AND ${claimAudienceSql('t', 'm')})`
  const key = [viewer.principal.organizationId, taskId, viewer.memberId, viewer.principal.userId]
  const current = await queryFirst<TaskRow>(db, `SELECT t.* FROM tasks t WHERE t.organization_id = ? AND t.id = ? AND ${audience}`, key)
  if (!current || current.status !== 'open' || current.assigned_member_id !== null || current.version !== version) {
    fail(409, 'TASK_CLAIM_UNAVAILABLE', 'This task is no longer available to claim', 'version')
  }
  const [result] = await executeBatch(db, [{
    query: `UPDATE tasks AS t SET assigned_member_id = ?, version = version + 1, updated_at = ?
      WHERE t.organization_id = ? AND t.id = ? AND ${audience} AND t.status = 'open' AND t.assigned_member_id IS NULL AND t.version = ?`,
    params: [viewer.memberId, new Date().toISOString(), ...key, version],
  }, taskEventQuery(viewer, current, 'task.assigned', {
    before: { assigned_member_id: null }, after: { assigned_member_id: viewer.memberId },
  })], { operation: 'Claim task' })
  if (result?.meta.changes !== 1) fail(409, 'TASK_CLAIM_UNAVAILABLE', 'This task is no longer available to claim', 'version')
  return afterWrite(db, viewer, taskId, viewer.memberId)
}

export async function updateTask(db: DbClient, viewer: TaskViewer, taskId: string, body: Record<string, unknown>): Promise<TaskView> {
  if (body.claim === true) {
    if (Object.keys(body).some(key => key !== 'claim' && key !== 'version')) fail(422, 'INVALID_TASK_FIELD', 'Claim the task before editing it', 'claim')
    return claimTask(db, viewer, taskId, body.version)
  }
  const current = await readTaskRow(db, viewer, taskId)
  const touchesAssignee = body.assigned_member_id !== undefined
  await assertRoleAllows({ ...viewer.principal, permissions: { task: touchesAssignee ? ['assign'] : ['update'] } })
  if (body.version !== current.version) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'version')
  if (current.status !== 'open') fail(409, 'TASK_CLOSED', 'Reopen the task before changing it', 'status')
  const assigned = touchesAssignee ? await readTaskAssignee(db, viewer.principal.organizationId, body) : current.assigned_member_id
  if (assigned === null && (isJobTask(current) || current.kind === 'consultation_prep')) fail(422, 'JOB_ASSIGNEE_REQUIRED', 'A job always has someone doing it: choose a member', 'assigned_member_id')
  const startsAt = body.starts_at === undefined ? current.starts_at : instant(body.starts_at, 'starts_at')
  const dueAt = body.due_at === undefined ? current.due_at : instant(body.due_at, 'due_at')
  if (startsAt && dueAt && startsAt > dueAt) fail(422, 'INVALID_TASK_FIELD', 'starts_at must not be after due_at', 'starts_at')
  const notes = body.notes === undefined ? current.notes : text(body.notes, 'notes', 5000)
  const title = body.title === undefined ? current.title : current.kind === 'custom' ? text(body.title, 'title', 200, true) : fail(422, 'INVALID_TASK_FIELD', 'This task takes its title from what it is about', 'title')
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

/** Done or skipped, in one tap. What the person found they say in the job's conversation. */
export async function closeTask(db: DbClient, viewer: TaskViewer, taskId: string, input: { status: 'done' | 'skipped'; env: CloudflareEnv; note?: unknown; photos?: MessagePhoto[] }): Promise<TaskView> {
  await assertRoleAllows({ ...viewer.principal, permissions: { task: ['complete'] } })
  const current = await readTaskRow(db, viewer, taskId)
  const context = await loadContext(db, viewer, [current])
  const view = present(current, viewer, context, new Date())
  if (current.status !== 'open') fail(409, 'TASK_CLOSED', `This task is already ${current.status}`, 'status')
  if (input.status === 'done' && !view.can.complete) fail(409, 'TASK_CLOSES_WITH_SUBJECT', 'This task is done when its subject is: open it instead', 'status')
  if (input.status === 'skipped' && !view.can.skip) fail(403, 'TASK_SCOPE_DENIED', 'You cannot skip this task', 'status')
  const now = new Date().toISOString()
  const organizationId = viewer.principal.organizationId
  const note = text(input.note, 'note', 5000)
  const photos = input.photos ?? []
  const authored = note !== null || photos.length > 0
  // A job closes in its conversation too: "Done" is the person's own message there, and nobody is alerted.
  // The conversation that carries this job is the one its automatic post went to, and the closer must still sit in it.
  const privatePrep = current.subject_type === 'product_session'
  const hasThread = view.booking_id && (isJobTask(current) || privatePrep)
  const thread = hasThread ? await queryFirst<{ id: string }>(db, `SELECT c.id FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.author_kind IN (${PLATFORM_MESSAGE_AUTHOR_KINDS_SQL})
      JOIN conversation_participants seat ON seat.conversation_id = c.id AND seat.role = 'member' AND seat.user_id = ?
     WHERE c.organization_id = ? AND c.kind = 'team' AND c.booking_id = ?
       AND (? = 0 OR EXISTS (SELECT 1 FROM conversation_participants assignee
         JOIN member assigned ON assigned.organizationId = c.organization_id AND assigned.userId = assignee.user_id
         WHERE assignee.conversation_id = c.id AND assignee.role = 'member' AND assigned.id = ?))
       AND (json_extract(m.payload_json, '$.key') = ? OR instr(json_extract(m.payload_json, '$.key'), ?) = 1)
       AND (? = 0 OR NOT EXISTS (SELECT 1 FROM messages later JOIN json_each(?) stop
         ON json_extract(later.payload_json, '$.key') = stop.value OR instr(json_extract(later.payload_json, '$.key'), stop.value || ':') = 1
         WHERE later.conversation_id = c.id AND later.author_kind IN (${PLATFORM_MESSAGE_AUTHOR_KINDS_SQL}) AND later.sequence > m.sequence))
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1`, [viewer.principal.userId, organizationId, view.booking_id, privatePrep ? 1 : 0, current.assigned_member_id,
    jobKey(current), `${jobKey(current)}:after:`, privatePrep ? 1 : 0, d1JsonStringSet(jobEndKeys(current.id))]) : null
  if (authored && !thread) fail(422, 'TASK_OUTCOME_REQUIRES_CONVERSATION', 'Notes and photos need the job’s team conversation', photos.length ? 'photos' : 'note')
  const assetIds = await uploadMessagePhotos(db, input.env, organizationId, photos, { source: 'uploaded', userId: viewer.principal.userId }).catch((error: unknown) => {
    if (error instanceof MessagePhotoRejection) fail(422, 'INVALID_PHOTO', error.message, 'photos')
    throw error
  })
  // The person's own message in the job's conversation, written by the one message writer.
  const message = thread ? messageQueries({
    conversationId: thread.id, authorKind: 'member', authorUserId: viewer.principal.userId,
    body: authored ? note : input.status === 'done' ? 'Done' : 'Skipped', dedupeKey: `task-closed:${taskId}:${current.version + 1}`,
    ...(authored ? { payload: { task_outcome: true } } : {}),
    guard: participantGuard('c', viewer.principal.userId, 'member'),
  }) : null
  try {
    await executeBatch(db, [{
      query: `UPDATE tasks SET status = ?, closed_at = ?, closed_by_user_id = ?, version = version + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND version = ? AND status = 'open'`,
      params: [input.status, now, viewer.principal.userId, now, organizationId, taskId, current.version],
    },
    // Everything after this is this request's own close: a close that lost to another one fails the batch here.
    { query: "SELECT CASE WHEN changes() = 1 THEN NULL ELSE json('TASK_VERSION_CONFLICT') END" },
    taskEventQuery(viewer, current, input.status === 'done' ? 'task.completed' : 'task.skipped', { after: { status: input.status } }),
    ...message?.queries ?? [],
    ...(message && authored ? [
      { query: "SELECT CASE WHEN EXISTS (SELECT 1 FROM messages WHERE id = ?) THEN NULL ELSE json('TASK_THREAD_ACCESS_CHANGED') END", params: [message.id] },
      ...messagePhotoPlacements(organizationId, message.id, assetIds, now),
    ] : [])], { operation: input.status === 'done' ? 'Complete task' : 'Skip task' })
  } catch (error) {
    await discardMessagePhotos(db, input.env, organizationId, assetIds, viewer.principal.userId, error)
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
    query: `UPDATE tasks SET status = 'open', closed_at = NULL, closed_by_user_id = NULL, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND id = ? AND version = ? AND status IN ('done', 'skipped')`,
    params: [now, viewer.principal.organizationId, taskId, current.version],
  }, taskEventQuery(viewer, current, 'task.reopened', { before: { status: current.status } })], { operation: 'Reopen task' })
  if (results[0]?.meta.changes !== 1) fail(409, 'TASK_VERSION_CONFLICT', 'This task changed since you opened it; reload it and try again', 'version')
  return afterWrite(db, viewer, taskId)
}

