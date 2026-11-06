import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, assignedGuestThreadScope, assignedResponsibilitySql, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { discardMessagePhotos, listMessagePhotos, messagePhotoPlacements, uploadMessagePhotos, MessagePhotoRejection, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { firstName } from '~/server/domain/guest-threads/presentation'
import { guestConversationPath } from '~/server/utils/dashboard-links'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { addLocalDays, formatTimestamp, isValidInstant, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import type { CloudflareEnv } from '~/server/utils/auth'

/*
  Work someone has to do. A turnover, a guest's unanswered question and a
  failed scheduled message are opened and closed by the batch that changes
  their subject (the builders below); an accepted opportunity by its accept;
  a custom task by a person. People assign, reschedule, complete, skip and
  reopen them here, from the dashboard, MCP and the app alike.
*/

export const TASK_KINDS = ['turnover', 'guest_reply', 'message_delivery', 'opportunity', 'custom'] as const
export type TaskKind = typeof TASK_KINDS[number]
export type TaskStatus = 'open' | 'done' | 'skipped' | 'cancelled'

export interface TaskRow {
  id: string; organization_id: string; kind: TaskKind
  subject_type: 'stay' | 'request' | 'scheduled_guest_message' | 'article' | 'post' | 'product' | null; subject_id: string | null
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

interface HomeClock { product_id: string; location_id: string; timezone: string; check_in_time: string; check_out_time: string; assigned_member_id: string | null; assigned_team_id: string | null }

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
    const startsAt = localDateTimeToInstant(stay.check_out_date, home.check_out_time, home.timezone, 'compatible').toISOString()
    const arrival = next === null ? null : localDateTimeToInstant(next, home.check_in_time, home.timezone, 'compatible').toISOString()
    const dueAt = arrival === null ? null : arrival < startsAt ? startsAt : arrival
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
export interface TaskView {
  id: string
  kind: TaskKind
  status: TaskStatus
  version: number
  /** Kind and time: "Turnover · 11:00 AM – 3:00 PM", "Reply · asked 2h ago", "Done 9:42 AM by you". */
  eyebrow: string
  /** The place or person. */
  title: string
  /** One line of context, null when there is none. */
  detail: string | null
  imageUrl: string | null
  icon: string
  assignee: TaskPerson | null
  startsAt: string | null
  dueAt: string | null
  timezone: string
  /** The owner's instructions. */
  notes: string | null
  /** What the person who closed it found, and their photos. */
  outcome: { note: string | null; photos: TaskPhoto[]; closedAt: string; closedBy: string | null } | null
  /** A reply or a failed message closes when its subject does: its button opens the subject instead of Done. */
  action: { type: 'complete' } | { type: 'open'; label: string; path: string }
  /** The dashboard page of the task's subject, when it has one. */
  path: string | null
  productId: string | null
  locationId: string | null
  stayId: string | null
  requestId: string | null
  can: { complete: boolean; skip: boolean; reopen: boolean; assign: boolean; edit: boolean }
}

export interface TaskSection { id: string; title: string; tasks: TaskView[] }

interface Context {
  slug: string
  people: Map<string, { name: string; userId: string }>
  teams: Map<string, string>
  users: Map<string, string>
  products: Map<string, { name: string; imageUrl: string | null }>
  stays: Map<string, { id: string; guest_name: string | null; adults: number; children: number; check_in_date: string; check_out_date: string; request_id: string | null }>
  arrivals: Map<string, { guest_name: string | null; adults: number; children: number } | null>
  requests: Map<string, { guest: string; preview: string | null; asked_at: string | null }>
  messages: Map<string, { title: string; reason: string | null; request_id: string | null; stay_id: string }>
  photos: Map<string, TaskPhoto[]>
}

async function loadContext(db: DbClient, viewer: TaskViewer, rows: TaskRow[]): Promise<Context> {
  const organizationId = viewer.principal.organizationId
  const ids = (pick: (row: TaskRow) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const stayIds = ids(row => row.subject_type === 'stay' ? row.subject_id : null)
  const requestIds = ids(row => row.subject_type === 'request' ? row.subject_id : null)
  const messageIds = ids(row => row.subject_type === 'scheduled_guest_message' ? row.subject_id : null)
  const productIds = ids(row => row.product_id)
  const [organization, members, teams, products, pictures, stays, requests, messages, photos] = await Promise.all([
    queryFirst<{ slug: string }>(db, 'SELECT slug FROM organization WHERE id = ?', [organizationId]),
    queryAll<{ id: string; userId: string; name: string }>(db, 'SELECT m.id, m.userId, u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?', [organizationId]),
    queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM team WHERE organizationId = ?', [organizationId]),
    queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM products WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(productIds)]),
    loadOwnerPictures(db, organizationId, 'product', productIds, { organizationFallback: false }),
    queryAll<{ id: string; product_id: string; guest_name: string | null; adults: number; children: number; check_in_date: string; check_out_date: string; request_id: string | null }>(db,
      'SELECT id, product_id, guest_name, adults, children, check_in_date, check_out_date, request_id FROM stays WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(stayIds)]),
    queryAll<{ id: string; guest: string; preview: string | null; asked_at: string | null }>(db, `
      SELECT r.id, COALESCE(json_extract(r.payload_json, '$.guest.name'), json_extract(r.payload_json, '$.participant.title')) AS guest,
        (SELECT CASE WHEN e.kind = 'submission' THEN json_extract(r.payload_json, '$.message') ELSE e.body END FROM activity_entries e JOIN tasks t ON t.subject_id = r.id AND t.kind = 'guest_reply'
          WHERE e.id = substr(t.dedupe_key, length('guest_reply:' || r.id || ':') + 1) ORDER BY t.created_at DESC LIMIT 1) AS preview,
        (SELECT e.occurred_at FROM activity_entries e JOIN tasks t ON t.subject_id = r.id AND t.kind = 'guest_reply'
          WHERE e.id = substr(t.dedupe_key, length('guest_reply:' || r.id || ':') + 1) ORDER BY t.created_at DESC LIMIT 1) AS asked_at
      FROM requests r WHERE r.organization_id = ? AND r.id IN (SELECT value FROM json_each(?))`, [organizationId, d1JsonStringSet(requestIds)]),
    queryAll<{ id: string; template_title: string; reason: string | null; request_id: string | null; stay_id: string }>(db,
      'SELECT id, template_title, reason, request_id, stay_id FROM scheduled_guest_messages WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))', [organizationId, d1JsonStringSet(messageIds)]),
    listMessagePhotos(db, 'task', rows.map(row => row.id)),
  ])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  // The next guests at the home, for the turnovers shown.
  const arrivals = new Map<string, { guest_name: string | null; adults: number; children: number } | null>()
  for (const row of rows.filter(row => row.kind === 'turnover' && row.due_at !== null && row.product_id !== null)) {
    const stay = stays.find(item => item.id === row.subject_id)
    if (!stay) continue
    arrivals.set(row.id, await queryFirst(db, `SELECT guest_name, adults, children FROM stays WHERE organization_id = ? AND product_id = ? AND status = 'confirmed'
      AND id <> ? AND check_in_date >= ? ORDER BY check_in_date, id LIMIT 1`, [organizationId, row.product_id, stay.id, stay.check_out_date]) ?? null)
  }
  return {
    slug: organization.slug,
    people: new Map(members.map(member => [member.id, { name: member.name, userId: member.userId }])),
    teams: new Map(teams.map(team => [team.id, team.name])),
    users: new Map(members.map(member => [member.userId, member.name])),
    products: new Map(products.map(product => [product.id, { name: product.name, imageUrl: pictures.get(product.id)?.imageUrl ?? null }])),
    stays: new Map(stays.map(stay => [stay.id, stay])),
    arrivals,
    requests: new Map(requests.map(request => [request.id, request])),
    messages: new Map(messages.map(message => [message.id, { title: message.template_title, reason: message.reason, request_id: message.request_id, stay_id: message.stay_id }])),
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

function present(row: TaskRow, viewer: TaskViewer, context: Context, now: Date): TaskView {
  const zone = row.timezone
  const time = (instant: string) => formatTimestamp(instant, 'en', zone, { hour: 'numeric', minute: '2-digit' })
  const day = (instant: string) => formatTimestamp(instant, 'en', zone, { weekday: 'short', month: 'short', day: 'numeric' })
  const sameDay = (a: string, b: string) => localDateAt(new Date(a), zone) === localDateAt(new Date(b), zone)
  const product = row.product_id ? context.products.get(row.product_id) ?? null : null
  const person = row.assigned_member_id ? context.people.get(row.assigned_member_id) : null
  const assignee: TaskPerson | null = row.assigned_member_id && person
    ? { type: 'member', id: row.assigned_member_id, name: person.userId === viewer.principal.userId ? 'You' : person.name, initial: person.name.trim().charAt(0).toUpperCase(), you: person.userId === viewer.principal.userId }
    : row.assigned_team_id && context.teams.has(row.assigned_team_id)
      ? { type: 'team', id: row.assigned_team_id, name: context.teams.get(row.assigned_team_id)!, initial: context.teams.get(row.assigned_team_id)!.trim().charAt(0).toUpperCase(), you: false }
      : null
  const mine = assignee?.you ?? false
  const by = (userId: string | null) => userId === null ? null : userId === viewer.principal.userId ? 'you' : context.users.get(userId) ?? 'a former member'
  const closer = row.status === 'open' ? null : by(row.closed_by_user_id)
  const conversation = (requestId: string | null) => requestId ? guestConversationPath(context.slug, requestId) : null
  const stayPath = (stayId: string) => `/dashboard/${encodeURIComponent(context.slug)}/bookings/stay/${encodeURIComponent(stayId)}`
  let eyebrow = '', title = '', detail: string | null = null, icon = 'i-lucide-list-checks', path: string | null = null
  let stayId: string | null = null, requestId: string | null = null
  let action: TaskView['action'] = { type: 'complete' }
  switch (row.kind) {
    case 'turnover': {
      const stay = context.stays.get(row.subject_id!)
      if (!stay || !product || !row.starts_at) throw new Error(`Turnover ${row.id} has no stay or home`)
      stayId = stay.id
      const window = `${time(row.starts_at)} – ${row.due_at === null ? 'no next guests' : sameDay(row.starts_at, row.due_at) ? time(row.due_at) : `no arrival ${sameDay(row.starts_at, now.toISOString()) ? 'today' : 'that day'}`}`
      eyebrow = viewer.manage ? `Turnover · ${window}` : window
      title = product.name
      const next = context.arrivals.get(row.id) ?? null
      const arrives = row.due_at === null ? 'No next guests yet'
        : sameDay(row.starts_at, row.due_at) ? null : `Next guests ${day(row.due_at)}`
      detail = viewer.manage
        ? [`${stay.guest_name ? firstName(stay.guest_name) : 'The guest'} checks out`, next && row.due_at && sameDay(row.starts_at, row.due_at) ? `${next.guest_name ? firstName(next.guest_name) : 'The next guest'} arrives, ${guests(next)}` : arrives].filter(Boolean).join(' · ')
        : next && row.due_at && sameDay(row.starts_at, row.due_at) ? `Next guests arrive ${time(row.due_at)} · ${guests(next)}` : arrives
      icon = 'i-lucide-sparkles'
      path = viewer.manage ? stayPath(stay.id) : null
      break
    }
    case 'guest_reply': {
      const request = context.requests.get(row.subject_id!)
      if (!request) throw new Error(`Reply task ${row.id} has no conversation`)
      requestId = row.subject_id
      eyebrow = `Reply · asked ${request.asked_at ? relative(request.asked_at, now) : relative(row.created_at, now)}`
      title = request.guest
      detail = request.preview?.trim() || null
      icon = 'i-lucide-message-circle'
      path = conversation(row.subject_id)
      action = { type: 'open', label: 'Reply', path: path! }
      break
    }
    case 'message_delivery': {
      const message = context.messages.get(row.subject_id!)
      if (!message) throw new Error(`Delivery task ${row.id} has no scheduled message`)
      requestId = message.request_id
      stayId = message.stay_id
      eyebrow = 'Message didn’t send'
      title = [message.title, product?.name].filter(Boolean).join(' · ')
      detail = message.reason
      icon = 'i-lucide-message-circle-warning'
      path = conversation(message.request_id) ?? stayPath(message.stay_id)
      action = { type: 'open', label: 'Open', path }
      break
    }
    case 'opportunity':
      eyebrow = 'Accepted opportunity'
      title = row.title!
      detail = product?.name ?? null
      icon = 'i-lucide-sprout'
      break
    case 'custom':
      eyebrow = `Task · added by ${by(row.created_by_user_id) ?? 'KrabiClaw'}`
      title = row.title!
      detail = [product?.name, row.due_at ? `by ${day(row.due_at)}` : null].filter(Boolean).join(' · ') || null
      break
  }
  if (row.status !== 'open') {
    const photos = context.photos.get(row.id) ?? []
    eyebrow = `${row.status === 'done' ? 'Done' : row.status === 'skipped' ? 'Skipped' : 'Cancelled'} ${sameDay(row.closed_at!, now.toISOString()) ? time(row.closed_at!) : day(row.closed_at!)}${closer ? ` by ${closer}` : ''}`
    detail = [row.outcome_note ? `“${row.outcome_note}”` : null, photos.length ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}` : null].filter(Boolean).join(' · ') || detail
  }
  const reachable = viewer.manage || mine || row.assigned_team_id !== null || row.kind === 'turnover' || row.kind === 'custom' || row.kind === 'opportunity'
  const personClosed = row.status !== 'open' && row.status !== 'cancelled' && row.closed_by_user_id !== null
  return {
    id: row.id, kind: row.kind, status: row.status, version: row.version,
    eyebrow, title, detail, imageUrl: product?.imageUrl ?? null, icon, assignee,
    startsAt: row.starts_at, dueAt: row.due_at, timezone: zone, notes: row.notes,
    outcome: row.status === 'open' ? null : { note: row.outcome_note, photos: context.photos.get(row.id) ?? [], closedAt: row.closed_at!, closedBy: closer },
    action, path, productId: row.product_id, locationId: row.location_id, stayId, requestId,
    can: {
      complete: row.status === 'open' && action.type === 'complete' && reachable,
      skip: row.status === 'open' && reachable,
      reopen: personClosed && (viewer.manage || row.closed_by_user_id === viewer.principal.userId),
      assign: viewer.manage && row.status === 'open',
      edit: viewer.manage && row.status === 'open',
    },
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
  const rows = await queryAll<TaskRow>(db, `SELECT t.* FROM tasks t WHERE t.organization_id = ? AND ${scope.sql} AND ${statusSql}${filters.map(sql => ` AND ${sql}`).join('')}
    ORDER BY COALESCE(t.starts_at, t.due_at, t.created_at), t.id LIMIT 500`, [organizationId, ...scope.params, ...statusParams, ...params])
  const today = (row: TaskRow) => localDateAt(now, row.timezone)
  const dayOf = (instant: string | null, row: TaskRow) => instant === null ? null : localDateAt(new Date(instant), row.timezone)
  const isToday = (row: TaskRow) => {
    if (row.status !== 'open') return dayOf(row.closed_at, row) === today(row)
    const start = dayOf(row.starts_at, row), due = dayOf(row.due_at, row)
    if (start === null && due === null) return true
    return (start !== null && start <= today(row)) || (due !== null && due <= today(row))
  }
  const shown = rows.filter(row => query.range === 'today' ? isToday(row) : row.status === 'open' && !isToday(row))
  const context = await loadContext(db, viewer, shown)
  const views = shown.map(row => ({ row, view: present(row, viewer, context, now) }))
  const resolvedAt = now.toISOString()
  if (query.range === 'today') {
    const open = views.filter(item => item.row.status === 'open').map(item => item.view)
    const closed = views.filter(item => item.row.status !== 'open').sort((a, b) => b.row.closed_at!.localeCompare(a.row.closed_at!)).map(item => item.view)
    const onlyTurnovers = open.length > 0 && open.every(task => task.kind === 'turnover') && !viewer.manage
    return { resolvedAt, sections: [
      ...(open.length ? [{ id: 'open', title: `${onlyTurnovers ? 'Your turnovers' : 'Tasks'} · ${open.length}`, tasks: open }] : []),
      ...(closed.length ? [{ id: 'done', title: 'Done', tasks: closed }] : []),
    ] }
  }
  const byDay = new Map<string, TaskSection>()
  for (const { row, view } of views) {
    const date = dayOf(row.starts_at ?? row.due_at, row)!
    const title = date === addLocalDays(today(row), 1) ? 'Tomorrow' : formatTimestamp(row.starts_at ?? row.due_at!, 'en', row.timezone, { weekday: 'short', month: 'short', day: 'numeric' })
    const section = byDay.get(date) ?? { id: date, title, tasks: [] }
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
  return { eyebrow: view.eyebrow, title: view.title, detail: view.detail, locationId: row.location_id }
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

