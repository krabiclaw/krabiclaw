import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { announceContentReport, assertSameReport, contentReportId, contentReportInsert, reportReason, type ContentReport, type ContentReportEnv } from '~/server/domain/content-reports'
import { assertAssignedBookingAccess, assertLocationAccess, assertRoleAllows, listAllOrganizationMembers, organizationAdapter, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { publishDashboardInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { notifyTeamMessage } from '~/server/utils/notifications'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { GuestThreadDeliveryStatus } from '~/server/domain/guest-threads/types'
import type { NotificationChannel } from '~/shared/notification-categories'
import { getStay, stayAccessFor } from '~/server/domain/stays'
import { subjectJobViews, taskViewer, type JobSubject, type TaskView } from '~/server/domain/tasks'
import {
  discardMessagePhotos,
  listMessagePhotos,
  MAX_MESSAGE_PHOTOS,
  MessagePhotoRejection,
  messagePhotoPlacements,
  messagePreview,
  uploadMessagePhotos,
  type MessagePhotoInput,
} from '~/server/domain/guest-threads/attachments'

/**
 * Team conversations: the organization's own members talking to each other,
 * optionally about one stay. The dashboard and the native app call these
 * functions; nothing else reads or writes the team tables. Staff removal of a
 * reported message runs `teamMessageRemovalQueries` from here.
 *
 * Who may take part is Better Auth membership and the `team_messages`
 * permission. A seat is a member row, so leaving the organization ends a
 * person's seats, while what they wrote stays with their user id.
 */

type TeamEnv = CloudflareEnv & GuestInboxPublicationEnv

/** The caller, as a seat-holder: their member row and user in one organization. */
export interface TeamAccess {
  organizationId: string
  userId: string
  memberId: string
  principal: MemberAccessPrincipal
}

export async function teamAccessFor(principal: MemberAccessPrincipal, memberId: string, action: 'read' | 'send'): Promise<TeamAccess> {
  await assertRoleAllows({ ...principal, permissions: { team_messages: [action] } })
  return { organizationId: principal.organizationId, userId: principal.userId, memberId, principal }
}

export interface TeamMember {
  memberId: string
  /** The member's user id: what participants and senders are named by. */
  id: string
  name: string
  email: string
  image: string | null
  role: string
}

export interface TeamParticipant {
  id: string
  memberId: string
  name: string
  image: string | null
}

export interface TeamStaySummary {
  id: string
  productId: string
  homeName: string
  checkInDate: string
  checkOutDate: string
  status: 'pending' | 'confirmed' | 'cancelled'
}

export interface TeamLocationSummary {
  id: string
  title: string
  slug: string
  timezone: string
}

export interface TeamThread {
  id: string
  /** A group's name; a stay conversation is titled by the home the guest sleeps in. */
  name: string | null
  isGroup: boolean
  createdByUserId: string | null
  canManage: boolean
  canLeave: boolean
  createdAt: string
  lastMessageAt: string
  stayId: string | null
  bookingId: string | null
  locationId: string | null
  stay: TeamStaySummary | null
  booking: { id: string; title: string } | null
  /** The stay's cleaning job (its turnover, or the job to get a home ready after a move), as the Today card draws it; null when the stay has none. */
  job: TaskView | null
  location: TeamLocationSummary | null
  participants: TeamParticipant[]
  lastMessage: { id: string; senderId: string | null; body: string; attachmentCount: number; createdAt: string } | null
  unread: boolean
  unreadCount: number
}

export interface TeamMessage {
  id: string
  threadId: string
  /** null for an automatic message, and for a person's message once their account has been deleted. */
  senderId: string | null
  /** Written by KrabiClaw (a job, a reminder, a move), not by a member: shown as sent automatically, never counted as unread. */
  automatic: boolean
  body: string
  attachments: Array<{ id: string; url: string; width: number | null; height: number | null }>
  /** Each push this message was sent as, with Apple's outcome. */
  deliveries: Array<{ id: string; channel: NotificationChannel; status: GuestThreadDeliveryStatus; error: string | null; updatedAt: string }>
  createdAt: string
}

const MAX_BODY = 5000
const MAX_THREAD_MEMBERS = 50
const MAX_GROUP_NAME = 100
const ROLE_ORDER = new Map([['owner', 0], ['admin', 1]])

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, field } })
}

const messageEventKey = (messageId: string) => `team-message:${messageId}`

function requestKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'MISSING_IDEMPOTENCY_KEY', 'An idempotency key is required', 'idempotencyKey')
  if (value.trim().length > 200) fail(422, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key must be at most 200 characters', 'idempotencyKey')
  return value.trim()
}

function groupName(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_GROUP_NAME) {
    fail(422, 'INVALID_GROUP_NAME', `A group name must contain 1 to ${MAX_GROUP_NAME} characters, or be null`, 'name')
  }
  return value.trim()
}

const groupCreationKey = (access: TeamAccess, key: string) => `team-group-create:${access.organizationId}:${access.userId}:${key}`

async function canManageGroups(access: TeamAccess): Promise<boolean> {
  return await roleAllows({ ...access.principal, permissions: { member: ['update'] } })
}

/** Every current member of the organization, owners and admins first. */
export async function listTeamMembers(env: CloudflareEnv, access: TeamAccess): Promise<TeamMember[]> {
  const members = await listAllOrganizationMembers(await organizationAdapter(env), access.organizationId)
  return members
    .map(member => ({ memberId: member.id, id: member.user.id, name: member.user.name, email: member.user.email, image: member.user.image ?? null, role: member.role }))
    .sort((left, right) => (ROLE_ORDER.get(left.role) ?? 99) - (ROLE_ORDER.get(right.role) ?? 99) || left.name.localeCompare(right.name))
}

async function membersById(env: CloudflareEnv, organizationId: string) {
  const members = await listAllOrganizationMembers(await organizationAdapter(env), organizationId)
  return new Map(members.map(member => [member.id, member]))
}

/** The caller's seat in one conversation of this organization. */
async function requireSeat(db: DbClient, access: TeamAccess, threadId: string) {
  const seat = await queryFirst<{ id: string; last_read_at: string | null }>(db, `
    SELECT t.id, s.last_read_at FROM team_threads t
      JOIN team_thread_members s ON s.organization_id = t.organization_id AND s.thread_id = t.id
     WHERE t.organization_id = ? AND t.id = ? AND s.member_id = ?`, [access.organizationId, threadId, access.memberId])
  if (!seat) fail(404, 'TEAM_THREAD_NOT_FOUND', 'That conversation is not one of yours', 'threadId')
  return seat
}

async function publishThreadChanged(env: GuestInboxPublicationEnv, organizationId: string, threadId: string, committed: Record<string, string>) {
  try {
    await publishDashboardInvalidation(env, { eventId: crypto.randomUUID(), type: 'team_thread.changed', organizationId, teamThreadId: threadId, occurredAt: new Date().toISOString() })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The change was saved, but open apps could not be told. Retry with the same request.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, thread_id: threadId, ...committed }, cause })
  }
}

/** The caller's conversations, newest activity first. */
export async function listTeamThreads(env: CloudflareEnv, db: DbClient, access: TeamAccess, filter?: { bookingId?: string; locationId?: string; stayId?: string }): Promise<TeamThread[]> {
  const whereClauses = [
    't.organization_id = ?',
    's.member_id = ?',
  ]
  const params: unknown[] = [access.userId, access.organizationId, access.memberId]
  if (filter?.locationId) {
    whereClauses.push('t.location_id = ?')
    params.push(filter.locationId)
  }
  if (filter?.stayId) {
    whereClauses.push('t.stay_id = ?')
    params.push(filter.stayId)
  }
  if (filter?.bookingId) {
    whereClauses.push('t.booking_id = ?')
    params.push(filter.bookingId)
  }
  const threads = await queryAll<{ id: string; name: string | null; is_group: number; created_by_user_id: string | null; stay_id: string | null; booking_id: string | null; location_id: string | null; last_message_at: string; created_at: string; unread_count: number }>(db, `
    SELECT t.id, t.name, t.is_group, t.created_by_user_id, t.stay_id, t.booking_id, t.location_id, t.last_message_at, t.created_at,
           (SELECT COUNT(*) FROM team_messages m
             WHERE m.organization_id = t.organization_id AND m.thread_id = t.id AND m.sender_user_id IS NOT ? AND m.automatic = 0
               AND (s.last_read_at IS NULL OR m.created_at > s.last_read_at)) AS unread_count
      FROM team_threads t
      JOIN team_thread_members s ON s.organization_id = t.organization_id AND s.thread_id = t.id
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY t.last_message_at DESC, t.id DESC`, params)
  if (!threads.length) return []
  const ids = d1JsonStringSet(threads.map(thread => thread.id))
  const stayIds = threads.flatMap(thread => thread.stay_id ? [thread.stay_id] : [])
  const bookingIds = threads.flatMap(thread => thread.booking_id ? [thread.booking_id] : [])
  const bookings = bookingIds.length ? await queryAll<{ id: string; product_name: string; client_name: string | null }>(db, `
    SELECT b.id, p.name AS product_name, json_extract(r.payload_json, '$.guest.name') AS client_name
      FROM bookings b JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      LEFT JOIN requests r ON r.id = b.request_id
     WHERE b.organization_id = ? AND b.id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(bookingIds)]) : []
  const locationIds = threads.flatMap(thread => thread.location_id ? [thread.location_id] : [])
  const [seats, lastMessages, stays, locations, members] = await Promise.all([
    queryAll<{ thread_id: string; member_id: string }>(db, `SELECT thread_id, member_id FROM team_thread_members
      WHERE organization_id = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id, created_at, member_id`, [access.organizationId, ids]),
    queryAll<{ id: string; thread_id: string; sender_user_id: string | null; body: string; created_at: string }>(db, `
      SELECT m.id, m.thread_id, m.sender_user_id, m.body, m.created_at FROM team_messages m
        JOIN team_thread_members s ON s.organization_id = m.organization_id AND s.thread_id = m.thread_id AND s.member_id = ?
       WHERE m.organization_id = ? AND m.thread_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM team_messages n WHERE n.thread_id = m.thread_id
           AND (n.created_at > m.created_at OR (n.created_at = m.created_at AND n.id > m.id)))`, [access.memberId, access.organizationId, ids]),
    stayIds.length ? queryAll<{ id: string; product_id: string; home_name: string; check_in_date: string; check_out_date: string; status: TeamStaySummary['status'] }>(db, `
      SELECT s.id, s.product_id, p.internal_name AS home_name, s.check_in_date, s.check_out_date, s.status FROM stays s
        JOIN product_stay_configs p ON p.organization_id = s.organization_id AND p.product_id = s.product_id
       WHERE s.organization_id = ? AND s.id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(stayIds)]) : [],
    locationIds.length ? queryAll<{ id: string; title: string; slug: string; timezone: string }>(db, `
      SELECT id, title, slug, timezone FROM business_locations
       WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(locationIds)]) : [],
    membersById(env, access.organizationId),
  ])
  const photos = await listMessagePhotos(db, 'team_message', lastMessages.map(message => message.id))
  const managesGroups = await canManageGroups(access)
  const jobs = stayIds.length || bookingIds.length ? await subjectJobViews(db, await taskViewer(db, access.principal), [...stayIds, ...bookingIds]) : new Map<string, TaskView>()
  const currentSeats = await queryAll<{ thread_id: string }>(db, `SELECT thread_id FROM team_thread_members
    WHERE organization_id = ? AND member_id = ? AND thread_id IN (SELECT value FROM json_each(?))`, [access.organizationId, access.memberId, ids])
  const visibleIds = new Set(currentSeats.map(seat => seat.thread_id))
  return threads.filter(thread => visibleIds.has(thread.id)).map((thread) => {
    const participants = seats.filter(seat => seat.thread_id === thread.id).map((seat) => {
      const member = members.get(seat.member_id)
      if (!member) throw new Error(`Team conversation ${thread.id} seats member ${seat.member_id}, which Better Auth does not hold`)
      return { id: member.user.id, memberId: member.id, name: member.user.name, image: member.user.image ?? null }
    })
    const stayRow = thread.stay_id ? stays.find(stay => stay.id === thread.stay_id) : null
    if (thread.stay_id && !stayRow) throw new Error(`Team conversation ${thread.id} names stay ${thread.stay_id}, which was not found`)
    const bookingRow = thread.booking_id ? bookings.find(booking => booking.id === thread.booking_id) : null
    if (thread.booking_id && !bookingRow) throw new Error(`Team conversation ${thread.id} names booking ${thread.booking_id}, which was not found`)
    const bookingTitle = bookingRow ? bookingRow.client_name ?? bookingRow.product_name : null
    const locationRow = thread.location_id ? locations.find(location => location.id === thread.location_id) : null
    if (thread.location_id && !locationRow) throw new Error(`Team conversation ${thread.id} names location ${thread.location_id}, which was not found`)
    const last = lastMessages.find(message => message.thread_id === thread.id)
    const unreadCount = Number(thread.unread_count)
    return {
      id: thread.id,
      name: thread.name ?? stayRow?.home_name ?? bookingTitle,
      isGroup: thread.is_group === 1,
      createdByUserId: thread.created_by_user_id,
      canManage: thread.is_group === 1 && !thread.stay_id && !thread.location_id && (thread.created_by_user_id === access.userId || managesGroups),
      canLeave: thread.is_group === 1 && !thread.stay_id && !thread.location_id,
      createdAt: thread.created_at,
      lastMessageAt: thread.last_message_at,
      stayId: thread.stay_id,
      bookingId: thread.booking_id,
      locationId: thread.location_id,
      booking: bookingRow ? { id: bookingRow.id, title: bookingTitle! } : null,
      stay: stayRow ? { id: stayRow.id, productId: stayRow.product_id, homeName: stayRow.home_name, checkInDate: stayRow.check_in_date, checkOutDate: stayRow.check_out_date, status: stayRow.status } : null,
      job: jobs.get(stayRow?.id ?? bookingRow?.id ?? '') ?? null,
      location: locationRow ? { id: locationRow.id, title: locationRow.title, slug: locationRow.slug, timezone: locationRow.timezone } : null,
      participants,
      lastMessage: last ? { id: last.id, senderId: last.sender_user_id, body: last.body, attachmentCount: photos.get(last.id)?.length ?? 0, createdAt: last.created_at } : null,
      unread: unreadCount > 0,
      unreadCount,
    }
  })
}

/**
 * Direct and contextual conversations reuse their initial roster. A manually
 * created group has its own identity and replays only its creation request key.
 */
export async function createTeamThread(env: TeamEnv, db: DbClient, access: TeamAccess, input: { memberIds: unknown; stayId?: unknown; bookingId?: unknown; locationId?: unknown; name?: unknown; idempotencyKey?: unknown }): Promise<{ id: string; created: boolean }> {
  const { memberIds, stayId, bookingId, locationId } = input
  if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > MAX_THREAD_MEMBERS || memberIds.some(id => typeof id !== 'string' || !id)) {
    fail(422, 'INVALID_TEAM_MEMBERS', `memberIds must list 1 to ${MAX_THREAD_MEMBERS} member user ids`, 'memberIds')
  }
  if (stayId !== undefined && (typeof stayId !== 'string' || !stayId)) fail(422, 'INVALID_STAY_ID', 'stayId must name a stay', 'stayId')
  if (bookingId !== undefined && (typeof bookingId !== 'string' || !bookingId)) fail(422, 'INVALID_BOOKING_ID', 'bookingId must name a booking', 'bookingId')
  if (locationId !== undefined && (typeof locationId !== 'string' || !locationId)) fail(422, 'INVALID_LOCATION_ID', 'locationId must name a location', 'locationId')
  const members = await listAllOrganizationMembers(await organizationAdapter(env), access.organizationId)
  const byUser = new Map(members.map(member => [member.user.id, member]))
  if (byUser.get(access.userId)?.id !== access.memberId) fail(404, 'ORGANIZATION_MEMBER_NOT_FOUND', 'Your workspace membership has ended', 'memberId')
  const others = [...new Set(memberIds as string[])].filter(id => id !== access.userId)
  if (!others.length) fail(422, 'TEAM_THREAD_MEMBERS_REQUIRED', 'Choose at least one other member', 'memberIds')
  if (others.length + 1 > MAX_THREAD_MEMBERS) fail(422, 'INVALID_TEAM_MEMBERS', `A conversation can have at most ${MAX_THREAD_MEMBERS} members including you`, 'memberIds')
  const isGroup = others.length >= 2 && stayId === undefined && bookingId === undefined && locationId === undefined
  if (!isGroup && input.name !== undefined) fail(422, 'TEAM_GROUP_REQUIRED', 'Only manually created internal groups can have a group name', 'name')
  const name = input.name === undefined ? null : groupName(input.name)
  const dedupeKey = isGroup ? groupCreationKey(access, requestKey(input.idempotencyKey)) : null
  const requestHash = isGroup ? await creationRequestHash({ member_user_ids: [...others, access.userId].sort(), name }) : null
  if (dedupeKey) {
    // A committed creation survives later roster changes. Only the caller's
    // current membership and seat matter when finishing its publication.
    const replay = await readCreationRecord(db, dedupeKey)
    if (replay) {
      if (replay.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different group creation', 'idempotencyKey')
      await requireSeat(db, access, replay.entityId)
      await publishThreadChanged(env, access.organizationId, replay.entityId, {})
      return { id: replay.entityId, created: false }
    }
  }
  const unknown = (memberIds as string[]).filter(id => !byUser.has(id))
  if (unknown.length) fail(422, 'INVALID_TEAM_MEMBERS', `Not members of this organization: ${unknown.join(', ')}`, 'memberIds')
  if (typeof stayId === 'string') {
    try {
      await getStay(db, await stayAccessFor(access.principal), stayId)
    } catch (error) {
      if (HTTPError.isError(error) && error.status === 404) fail(404, 'STAY_NOT_FOUND', 'That stay is not in a home you can see', 'stayId')
      throw error
    }
  }
  if (typeof bookingId === 'string') {
    try {
      await assertAssignedBookingAccess(db, { ...access.principal, bookingId })
    } catch (error) {
      if (HTTPError.isError(error) && error.status === 404) fail(404, 'BOOKING_NOT_FOUND', 'That booking is not one you can see', 'bookingId')
      throw error
    }
    if (!await queryFirst(db, 'SELECT 1 FROM bookings WHERE organization_id = ? AND id = ?', [access.organizationId, bookingId])) fail(404, 'BOOKING_NOT_FOUND', 'That booking is not one you can see', 'bookingId')
  }
  if (typeof locationId === 'string') {
    try {
      await assertLocationAccess(db, { ...access.principal, locationId })
    } catch (error) {
      if (HTTPError.isError(error) && error.status === 404) fail(404, 'LOCATION_NOT_FOUND', 'That location is not one you can see', 'locationId')
      throw error
    }
  }
  const seatIds = [access.memberId, ...others.map(id => byUser.get(id)!.id)]
  const participantsKey = dedupeKey ?? await creationRequestHash({
    stay_id: stayId ?? null,
    ...(bookingId ? { booking_id: bookingId } : {}),
    location_id: locationId ?? null,
    member_ids: [...seatIds].sort(),
  })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  // A group key identifies this creation, never whichever people happen to
  // remain later. Direct/contextual starts keep their existing roster identity.
  const creationAudit = dedupeKey ? organizationEventQuery({ organizationId: access.organizationId, actorId: access.userId,
    eventType: 'team.group_created', entityType: 'team_thread', entityId: id, dedupeKey,
    metadata: { request_hash: requestHash },
  }) : null
  await executeBatch(db, [
    {
      query: `INSERT INTO team_threads (id, organization_id, stay_id, booking_id, location_id, created_by_user_id, name, is_group, participants_key, last_message_at, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM member WHERE id = ? AND organizationId = ? AND userId = ?)
                AND (SELECT COUNT(*) FROM member WHERE organizationId = ? AND id IN (SELECT value FROM json_each(?))) = ?
              ON CONFLICT (organization_id, participants_key) DO NOTHING`,
      params: [id, access.organizationId, stayId ?? null, bookingId ?? null, locationId ?? null, access.userId, name, Number(isGroup), participantsKey, now, now,
        access.memberId, access.organizationId, access.userId, access.organizationId, d1JsonStringSet(seatIds), seatIds.length],
    },
    ...seatIds.map(memberId => ({
      query: 'INSERT INTO team_thread_members (thread_id, organization_id, member_id, last_read_at, created_at) SELECT id, organization_id, ?, ?, ? FROM team_threads WHERE id = ?',
      params: [memberId, memberId === access.memberId ? now : null, now, id],
    })),
    ...(creationAudit ? [{ query: creationAudit.query + ' WHERE EXISTS (SELECT 1 FROM team_threads WHERE id = ?)', params: [...creationAudit.params!, id] }] : []),
  ], { operation: 'Start a team conversation' })
  const thread = await queryFirst<{ id: string }>(db, 'SELECT id FROM team_threads WHERE organization_id = ? AND participants_key = ?', [access.organizationId, participantsKey])
  if (!thread) fail(409, 'TEAM_MEMBERS_CHANGED', 'Workspace membership changed while starting the conversation. Choose its members again.', 'memberIds')
  if (dedupeKey) {
    const record = await readCreationRecord(db, dedupeKey)
    if (!record || record.entityId !== thread.id) throw new Error(`Team group ${thread.id} has no creation receipt`)
    if (record.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different group creation', 'idempotencyKey')
  }
  await requireSeat(db, access, thread.id)
  await publishThreadChanged(env, access.organizationId, thread.id, {})
  return { id: thread.id, created: thread.id === id }
}

export interface TeamGroupOperationInput {
  action: unknown
  idempotencyKey: unknown
  name?: unknown
  memberIds?: unknown
  userId?: unknown
}

export interface TeamGroupOperationResult {
  status: 'updated' | 'left'
  threadId: string
}

/**
 * Only manual groups have a mutable roster. The operation receipt is committed
 * atomically with its mutation and replays after a leave has ended the seat.
 */
export async function operateTeamGroup(env: TeamEnv, db: DbClient, access: TeamAccess, threadId: string, input: TeamGroupOperationInput): Promise<TeamGroupOperationResult> {
  const { action } = input
  if (action !== 'rename' && action !== 'add' && action !== 'remove' && action !== 'leave') fail(422, 'INVALID_GROUP_OPERATION', 'Choose rename, add, remove or leave', 'action')
  for (const field of ['name', 'memberIds', 'userId'] as const) {
    if (input[field] !== undefined && !((action === 'rename' && field === 'name') || (action === 'add' && field === 'memberIds') || (action === 'remove' && field === 'userId'))) {
      fail(422, 'INVALID_GROUP_OPERATION', `${field} is not used by ${action}`, field)
    }
  }
  const key = requestKey(input.idempotencyKey)
  const name = action === 'rename' ? groupName(input.name) : undefined
  let memberIds: string[] = []
  if (action === 'add') {
    if (!Array.isArray(input.memberIds) || !input.memberIds.length || input.memberIds.length > MAX_THREAD_MEMBERS
      || input.memberIds.some(id => typeof id !== 'string' || !id)) fail(422, 'INVALID_TEAM_MEMBERS', 'Choose current workspace members to add', 'memberIds')
    memberIds = [...new Set(input.memberIds as string[])].sort()
  }
  const removedUserId = action === 'leave' ? access.userId : action === 'remove' ? input.userId : null
  if (action === 'remove' && (typeof removedUserId !== 'string' || !removedUserId)) fail(422, 'INVALID_TEAM_MEMBER', 'Choose a participant to remove', 'userId')
  if (action === 'remove' && removedUserId === access.userId) fail(422, 'USE_LEAVE_GROUP', 'Use Leave group to leave this conversation', 'userId')
  const dedupeKey = `team-group-operation:${access.organizationId}:${access.userId}:${key}`
  const requestHash = await creationRequestHash({ threadId, action, name, memberIds, removedUserId })
  const currentMember = await queryFirst(db, 'SELECT id FROM member WHERE id = ? AND organizationId = ? AND userId = ?', [access.memberId, access.organizationId, access.userId])
  if (!currentMember) fail(404, 'ORGANIZATION_MEMBER_NOT_FOUND', 'Your workspace membership has ended', 'memberId')
  const publish = async () => {
    try {
      // No payload content is sent to a person whose seat ended. The hub also
      // suppresses this event if the person has since been added again.
      if (typeof removedUserId === 'string') await publishDashboardInvalidation(env, {
        eventId: crypto.randomUUID(), type: 'team_thread.access_ended', organizationId: access.organizationId,
        teamThreadId: threadId, targetUserId: removedUserId, occurredAt: new Date().toISOString(),
      })
      await publishThreadChanged(env, access.organizationId, threadId, {})
    } catch (cause) {
      throw new HTTPError({ statusCode: 503, message: 'The group change was saved, but open apps could not be told. Retry with the same request.',
        data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, thread_id: threadId }, cause })
    }
    return { status: action === 'leave' ? 'left' as const : 'updated' as const, threadId }
  }
  const verifyRecord = (record: NonNullable<Awaited<ReturnType<typeof readCreationRecord>>>) => {
    if (record.entityId !== threadId || record.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different group operation', 'idempotencyKey')
  }
  const replay = await readCreationRecord(db, dedupeKey)
  if (replay) {
    verifyRecord(replay)
    return await publish()
  }
  const requireGroup = async () => {
    await requireSeat(db, access, threadId)
    const thread = await queryFirst<{ is_group: number; stay_id: string | null; location_id: string | null; created_by_user_id: string | null }>(db,
      'SELECT is_group, stay_id, location_id, created_by_user_id FROM team_threads WHERE organization_id = ? AND id = ?', [access.organizationId, threadId])
    if (!thread?.is_group || thread.stay_id || thread.location_id) fail(409, 'TEAM_GROUP_PROTECTED', 'Only manually created internal groups can be changed or left', 'threadId')
    if (action !== 'leave' && thread.created_by_user_id !== access.userId && !await canManageGroups(access)) {
      fail(403, 'TEAM_GROUP_MANAGEMENT_REQUIRED', 'Only the group creator and participating workspace owners or admins can manage this group', 'permissions')
    }
  }
  await requireGroup()
  if (action === 'add') {
    const available = await listTeamMembers(env, access)
    if (memberIds.some(id => !available.some(member => member.id === id))) fail(422, 'INVALID_TEAM_MEMBERS', 'Only current members of this workspace can be added', 'memberIds')
  }
  if (typeof removedUserId === 'string' && !await queryFirst(db, `SELECT 1 FROM team_thread_members s JOIN member m ON m.id = s.member_id AND m.organizationId = s.organization_id
    WHERE s.organization_id = ? AND s.thread_id = ? AND m.userId = ?`, [access.organizationId, threadId, removedUserId])) {
    fail(404, 'TEAM_GROUP_MEMBER_NOT_FOUND', 'That person is not in this group', 'userId')
  }
  const permittedManager = await canManageGroups(access)
  const targets = d1JsonStringSet(memberIds)
  const guard = `EXISTS (SELECT 1 FROM team_threads t
    JOIN team_thread_members s ON s.organization_id = t.organization_id AND s.thread_id = t.id
    JOIN member m ON m.id = s.member_id AND m.organizationId = s.organization_id
    WHERE t.organization_id = ? AND t.id = ? AND t.is_group = 1 AND t.stay_id IS NULL AND t.location_id IS NULL
      AND s.member_id = ? AND m.userId = ? AND m.role = ?
      AND (? = 'leave' OR t.created_by_user_id = ? OR ? = 1))`
  const guardParams: unknown[] = [access.organizationId, threadId, access.memberId, access.userId, access.principal.role, action, access.userId, Number(permittedManager)]
  const conditions = [guard]
  if (action === 'add') {
    conditions.push(`(SELECT COUNT(*) FROM member WHERE organizationId = ? AND userId IN (SELECT value FROM json_each(?))) = ?`)
    guardParams.push(access.organizationId, targets, memberIds.length)
    conditions.push(`(SELECT COUNT(*) FROM team_thread_members WHERE organization_id = ? AND thread_id = ?) +
      (SELECT COUNT(*) FROM member m WHERE m.organizationId = ? AND m.userId IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM team_thread_members s WHERE s.organization_id = m.organizationId AND s.thread_id = ? AND s.member_id = m.id)) <= ?`)
    guardParams.push(access.organizationId, threadId, access.organizationId, targets, threadId, MAX_THREAD_MEMBERS)
  }
  if (typeof removedUserId === 'string') {
    conditions.push(`EXISTS (SELECT 1 FROM team_thread_members s JOIN member m ON m.id = s.member_id AND m.organizationId = s.organization_id
      WHERE s.organization_id = ? AND s.thread_id = ? AND m.userId = ?)`)
    guardParams.push(access.organizationId, threadId, removedUserId)
  }
  const audit = organizationEventQuery({ organizationId: access.organizationId, actorId: access.userId, eventType: 'team.group_updated', entityType: 'team_thread', entityId: threadId,
    dedupeKey, metadata: { request_hash: requestHash, action, name, member_user_ids: memberIds, removed_user_id: removedUserId },
  })
  // Only this batch's freshly inserted receipt admits its writes. A different
  // request racing with the same key must never borrow the earlier receipt.
  const receipt = 'EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)'
  const receiptId = audit.params![0]
  const writes: BatchQuery[] = [{ query: audit.query + ` WHERE ${conditions.join(' AND ')}`, params: [...audit.params!, ...guardParams] }]
  if (action === 'rename') writes.push({ query: `UPDATE team_threads SET name = ? WHERE organization_id = ? AND id = ? AND ${receipt}`, params: [name, access.organizationId, threadId, receiptId] })
  if (action === 'add') writes.push({
    query: `INSERT INTO team_thread_members (thread_id, organization_id, member_id, created_at)
      SELECT ?, m.organizationId, m.id, ? FROM member m WHERE m.organizationId = ? AND m.userId IN (SELECT value FROM json_each(?)) AND ${receipt}
      ON CONFLICT (thread_id, member_id) DO NOTHING`,
    params: [threadId, new Date().toISOString(), access.organizationId, targets, receiptId],
  })
  if (typeof removedUserId === 'string') writes.push({
    query: `DELETE FROM team_thread_members WHERE organization_id = ? AND thread_id = ? AND member_id IN
      (SELECT id FROM member WHERE organizationId = ? AND userId = ?) AND ${receipt}`,
    params: [access.organizationId, threadId, access.organizationId, removedUserId, receiptId],
  })
  try {
    await executeBatch(db, writes, { operation: 'Update a team group' })
  } catch (error) {
    if (!isUniqueDedupeConflict(error)) throw error
    const concurrent = await readCreationRecord(db, dedupeKey)
    if (!concurrent) throw error
    verifyRecord(concurrent)
  }
  const committed = await readCreationRecord(db, dedupeKey)
  if (!committed) {
    await requireGroup()
    fail(409, 'TEAM_GROUP_CHANGED', 'Group membership changed or the group would exceed 50 members. Reload before trying again.', 'memberIds')
  }
  verifyRecord(committed)
  return await publish()
}

type MessageRow = { id: string; thread_id: string; sender_user_id: string | null; automatic: number; body: string; created_at: string }

async function readMessages(db: DbClient, organizationId: string, rows: MessageRow[]): Promise<TeamMessage[]> {
  const [photos, deliveries] = await Promise.all([
    listMessagePhotos(db, 'team_message', rows.map(row => row.id)),
    rows.length ? queryAll<{ dedupe_key: string; id: string; channel: NotificationChannel; status: GuestThreadDeliveryStatus; error: string | null; updated_at: string }>(db, `
      SELECT a.dedupe_key, d.id, d.channel, d.status, d.error, d.updated_at FROM guest_thread_deliveries d
        JOIN activity_entries a ON a.id = d.entry_id
       WHERE a.organization_id = ? AND a.scope_kind = 'organization' AND d.purpose = 'owner_alert'
         AND a.dedupe_key IN (SELECT value FROM json_each(?))
       ORDER BY d.created_at, d.id`, [organizationId, d1JsonStringSet(rows.map(row => messageEventKey(row.id)))]) : [],
  ])
  return rows.map(row => ({
    id: row.id,
    threadId: row.thread_id,
    senderId: row.sender_user_id,
    automatic: row.automatic === 1,
    body: row.body,
    attachments: (photos.get(row.id) ?? []).map(photo => ({ id: photo.id, url: photo.url, width: photo.width, height: photo.height })),
    deliveries: deliveries.filter(delivery => delivery.dedupe_key === messageEventKey(row.id))
      .map(delivery => ({ id: delivery.id, channel: delivery.channel, status: delivery.status, error: delivery.error, updatedAt: delivery.updated_at })),
    createdAt: row.created_at,
  }))
}

/** Newest first. `before` and `beforeId` name the oldest message already loaded. */
export async function listTeamMessages(db: DbClient, access: TeamAccess, threadId: string, query: { limit?: unknown; before?: unknown; beforeId?: unknown }): Promise<{ messages: TeamMessage[]; hasMore: boolean }> {
  await requireSeat(db, access, threadId)
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(422, 'INVALID_LIMIT', 'limit must be a whole number from 1 to 100', 'limit')
  if ((query.before === undefined) !== (query.beforeId === undefined)) fail(422, 'INVALID_CURSOR', 'before and beforeId are sent together', query.before === undefined ? 'before' : 'beforeId')
  if (query.before !== undefined && (typeof query.before !== 'string' || !query.before || typeof query.beforeId !== 'string' || !query.beforeId)) fail(422, 'INVALID_CURSOR', 'before and beforeId must name a loaded message', 'before')
  const cursor = typeof query.before === 'string' ? 'AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))' : ''
  const rows = await queryAll<MessageRow>(db, `
    SELECT m.id, m.thread_id, m.sender_user_id, m.automatic, m.body, m.created_at FROM team_messages m
      JOIN team_thread_members s ON s.organization_id = m.organization_id AND s.thread_id = m.thread_id
     WHERE m.organization_id = ? AND m.thread_id = ? AND s.member_id = ? ${cursor}
     ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
  [access.organizationId, threadId, access.memberId, ...(cursor ? [query.before, query.before, query.beforeId] : []), limit + 1])
  if (!rows.length) await requireSeat(db, access, threadId)
  return { messages: await readMessages(db, access.organizationId, rows.slice(0, limit)), hasMore: rows.length > limit }
}

/**
 * Send a message with text, photos or both. The photos are stored first and
 * placed by the batch that writes the message, so a message exists with all of
 * its photos or not at all. The same idempotency key returns the same message;
 * a retry also sends any push that has not been sent and tells open apps again.
 */
export async function sendTeamMessage(
  env: TeamEnv,
  db: DbClient,
  access: TeamAccess,
  threadId: string,
  input: { body: unknown; photos: MessagePhotoInput; idempotencyKey: unknown; senderName: string },
): Promise<{ message: TeamMessage; created: boolean }> {
  await requireSeat(db, access, threadId)
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) fail(400, 'MISSING_IDEMPOTENCY_KEY', 'An idempotency key is required', 'idempotencyKey')
  const idempotencyKey = input.idempotencyKey.trim()
  if (idempotencyKey.length > 200) fail(422, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key must be at most 200 characters', 'idempotencyKey')
  if (input.body !== undefined && typeof input.body !== 'string') fail(422, 'INVALID_MESSAGE', 'body must be text', 'body')
  const body = (input.body ?? '').trim()
  if (body.length > MAX_BODY) fail(422, 'MESSAGE_TOO_LONG', `A message can be at most ${MAX_BODY} characters`, 'body')
  const photoInput = input.photos
  const suppliedPhotoCount = Array.isArray(photoInput) ? photoInput.length : photoInput.sourceIds.length
  if (!body && !suppliedPhotoCount) fail(422, 'EMPTY_MESSAGE', 'Write a message or add a photo', 'body')
  if (suppliedPhotoCount > MAX_MESSAGE_PHOTOS) fail(422, 'INVALID_PHOTO', `A message can carry at most ${MAX_MESSAGE_PHOTOS} photos`, 'photos')
  const requestHash = await creationRequestHash({
    body,
    // Keep the native byte-array identity; host file IDs are a different source,
    // whose bytes are needed only when a message has not already been saved.
    photos: Array.isArray(photoInput)
      ? await Promise.all(photoInput.map(async photo => [...new Uint8Array(await crypto.subtle.digest('SHA-256', photo.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')))
      : { sourceIds: photoInput.sourceIds },
  })
  const findByKey = () => queryFirst<MessageRow & { request_hash: string }>(db,
    'SELECT id, thread_id, sender_user_id, automatic, body, created_at, request_hash FROM team_messages WHERE organization_id = ? AND thread_id = ? AND idempotency_key = ?',
    [access.organizationId, threadId, idempotencyKey])
  const reused = (row: { sender_user_id: string | null; automatic: number; request_hash: string }) => row.automatic === 1 || row.sender_user_id !== access.userId || row.request_hash !== requestHash
  let row = await findByKey()
  let created = false
  if (row && reused(row)) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different message', 'idempotencyKey')
  if (!row) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    let assetIds: string[]
    try {
      const photos = Array.isArray(photoInput) ? photoInput : await photoInput.resolve()
      if (photos.length !== suppliedPhotoCount) throw new Error('Resolved team message photos do not match their declared sources')
      assetIds = await uploadMessagePhotos(db, env, access.organizationId, photos, { source: 'uploaded', userId: access.userId })
    } catch (error) {
      if (error instanceof MessagePhotoRejection) fail(422, 'INVALID_PHOTO', error.message, 'photos')
      throw error
    }
    try {
      await executeBatch(db, [
        {
          // Written only while the sender still holds a seat.
          query: `INSERT INTO team_messages (id, organization_id, thread_id, sender_user_id, body, idempotency_key, request_hash, created_at)
                  SELECT ?, organization_id, thread_id, ?, ?, ?, ?, ? FROM team_thread_members WHERE organization_id = ? AND thread_id = ? AND member_id = ?`,
          params: [id, access.userId, body, idempotencyKey, requestHash, now, access.organizationId, threadId, access.memberId],
        },
        organizationEventQuery({ organizationId: access.organizationId, actorId: access.userId, eventType: 'team.message_sent', entityType: 'team_message', entityId: id,
          metadata: { team_thread_id: threadId }, dedupeKey: messageEventKey(id), onlyIfPreviousChangedOneRow: true }),
        ...messagePhotoPlacements(access.organizationId, 'team_message', id, assetIds, now),
        { query: `UPDATE team_threads SET last_message_at = ? WHERE organization_id = ? AND id = ? AND last_message_at < ?
            AND EXISTS (SELECT 1 FROM team_messages m WHERE m.id = ? AND m.organization_id = team_threads.organization_id AND m.thread_id = team_threads.id)`, params: [now, access.organizationId, threadId, now, id] },
        { query: `UPDATE team_thread_members SET last_read_at = ? WHERE organization_id = ? AND thread_id = ? AND member_id = ?
            AND EXISTS (SELECT 1 FROM team_messages m WHERE m.id = ? AND m.organization_id = team_thread_members.organization_id AND m.thread_id = team_thread_members.thread_id)`, params: [now, access.organizationId, threadId, access.memberId, id] },
      ], { operation: 'Send a team message' })
    } catch (error) {
      let concurrent: Awaited<ReturnType<typeof findByKey>>
      try {
        concurrent = await findByKey()
      } catch (readError) {
        throw new AggregateError([error, readError], 'The message commit could not be read; its photos have been retained', { cause: readError })
      }
      if (concurrent?.id !== id) await discardMessagePhotos(db, env, access.organizationId, assetIds, access.userId, error)
      // A seat removed since the check leaves the photos nothing to be placed on.
      if (!concurrent) await requireSeat(db, access, threadId)
      if (!concurrent || reused(concurrent)) throw error
    }
    row = await findByKey()
    // The seat was removed between the check and the write: nothing was written.
    if (!row) fail(404, 'TEAM_THREAD_NOT_FOUND', 'That conversation is not one of yours', 'threadId')
    created = row.id === id
  }
  const entry = await queryFirst<{ id: string }>(db, "SELECT id FROM activity_entries WHERE organization_id = ? AND scope_kind = 'organization' AND dedupe_key = ?", [access.organizationId, messageEventKey(row.id)])
  if (!entry) throw new Error(`Team message ${row.id} has no organization receipt`)
  const recipients = await queryAll<{ user_id: string }>(db, `SELECT m.userId AS user_id FROM team_thread_members s
    JOIN member m ON m.id = s.member_id AND m.organizationId = s.organization_id
    WHERE s.organization_id = ? AND s.thread_id = ? AND s.member_id <> ?`, [access.organizationId, threadId, access.memberId])
  const photoCount = (await listMessagePhotos(db, 'team_message', [row.id])).get(row.id)?.length ?? 0
  await notifyTeamMessage(env, db, {
    organizationId: access.organizationId,
    threadId,
    entryId: entry.id,
    senderName: input.senderName,
    messagePreview: messagePreview(row.body, photoCount),
    recipientUserIds: recipients.map(recipient => recipient.user_id),
  })
  await publishThreadChanged(env, access.organizationId, threadId, { message_id: row.id })
  const [message] = await readMessages(db, access.organizationId, [row])
  return { message: message!, created }
}

/** The identity of a stay conversation with exactly these seats: what `createTeamThread` gives the same roster. */
export function jobThreadParticipantsKey(subject: JobSubject, seatMemberIds: readonly string[]): Promise<string> {
  return creationRequestHash({ stay_id: subject.kind === 'stay' ? subject.id : null, ...(subject.kind === 'booking' ? { booking_id: subject.id } : {}), location_id: null, member_ids: [...new Set(seatMemberIds)].sort() })
}

/**
 * KrabiClaw writes into a stay's team conversation: a cleaning job, a
 * reminder, a move, a cancellation. The conversation with exactly these seats
 * is the one a member starts for the same people (`createTeamThread`), opened
 * here when nobody has yet. The message is sent once per key; it alerts only
 * the users named, never counts as unread, and carries no sender. Owners and
 * admins read it in the conversation.
 */
export async function postAutomaticTeamMessage(env: TeamEnv, db: DbClient, input: {
  organizationId: string; subject: JobSubject; seatMemberIds: readonly string[]; body: string; idempotencyKey: string
  /** Who is told, by every channel they keep for team messages; the rest of the roster reads it in the conversation. */
  alertUserIds: readonly string[]
  /** How the alert names the writer: the business. */
  senderName: string
  /** An existing conversation to post into, seats as they are: what a job's former people are told goes where the job was. */
  threadId?: string
}): Promise<{ threadId: string; messageId: string; created: boolean }> {
  const body = input.body.trim()
  if (!body || body.length > MAX_BODY) throw new Error(`An automatic team message must be 1 to ${MAX_BODY} characters`)
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) throw new Error('An automatic team message key must be 1 to 200 characters')
  const seatIds = [...new Set(input.seatMemberIds)].sort()
  if (!seatIds.length && !input.threadId) throw new Error('An automatic team message needs a roster')
  const participantsKey = input.threadId ? null : await jobThreadParticipantsKey(input.subject, seatIds)
  const now = new Date().toISOString()
  const thread = input.threadId ? 'SELECT id FROM team_threads WHERE organization_id = ? AND id = ?' : 'SELECT id FROM team_threads WHERE organization_id = ? AND participants_key = ?'
  const threadParams = [input.organizationId, input.threadId ?? participantsKey!]
  const existing = (await queryFirst<{ id: string }>(db, thread, threadParams))?.id
  if (input.threadId && !existing) throw new Error(`Team conversation ${input.threadId} does not exist in organization ${input.organizationId}`)
  const threadId = existing ?? crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const requestHash = await creationRequestHash({ body, automatic: true })
  await executeBatch(db, [
    ...(input.threadId ? [] : [{
      // Only while every seat is a current member; a roster that has lost someone is not opened.
      query: `INSERT INTO team_threads (id, organization_id, stay_id, booking_id, location_id, created_by_user_id, name, is_group, participants_key, last_message_at, created_at)
              SELECT ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${input.subject.kind === 'stay' ? 'stays' : 'bookings'} WHERE organization_id = ? AND id = ?)
                AND (SELECT COUNT(*) FROM member WHERE organizationId = ? AND id IN (SELECT value FROM json_each(?))) = ?
              ON CONFLICT (organization_id, participants_key) DO NOTHING`,
      params: [threadId, input.organizationId, input.subject.kind === 'stay' ? input.subject.id : null, input.subject.kind === 'booking' ? input.subject.id : null, participantsKey, now, now, input.organizationId, input.subject.id, input.organizationId, d1JsonStringSet(seatIds), seatIds.length],
    },
    ...seatIds.map(memberId => ({
      query: `INSERT INTO team_thread_members (thread_id, organization_id, member_id, last_read_at, created_at) SELECT id, organization_id, ?, NULL, ? FROM team_threads WHERE id = ?
              ON CONFLICT DO NOTHING`,
      params: [memberId, now, threadId],
    }))]),
    {
      query: `INSERT INTO team_messages (id, organization_id, thread_id, sender_user_id, automatic, body, idempotency_key, request_hash, created_at)
              SELECT ?, organization_id, id, NULL, 1, ?, ?, ?, ? FROM team_threads WHERE id = (${thread})
              ON CONFLICT (thread_id, idempotency_key) DO NOTHING`,
      params: [messageId, body, input.idempotencyKey, requestHash, now, ...threadParams],
    },
    organizationEventQuery({ organizationId: input.organizationId, actorId: null, eventType: 'team.message_sent', entityType: 'team_message', entityId: messageId,
      metadata: { team_thread_id: threadId, automatic: true, key: input.idempotencyKey }, dedupeKey: messageEventKey(messageId), onlyIfPreviousChangedOneRow: true }),
    { query: `UPDATE team_threads SET last_message_at = ? WHERE organization_id = ? AND id = (${thread}) AND last_message_at < ?
        AND EXISTS (SELECT 1 FROM team_messages m WHERE m.id = ? AND m.thread_id = team_threads.id)`, params: [now, input.organizationId, ...threadParams, now, messageId] },
  ], { operation: 'Post an automatic team message' })
  const row = await queryFirst<MessageRow>(db, `SELECT m.id, m.thread_id, m.sender_user_id, m.automatic, m.body, m.created_at FROM team_messages m
    WHERE m.organization_id = ? AND m.thread_id = (${thread}) AND m.idempotency_key = ?`, [input.organizationId, ...threadParams, input.idempotencyKey])
  if (!row) throw new Error(`Automatic team message ${input.idempotencyKey} for ${input.subject.kind} ${input.subject.id} was not written: a seat is no longer a member or the stay is gone`)
  const created = row.id === messageId
  if (created) {
    const entry = await queryFirst<{ id: string }>(db, "SELECT id FROM activity_entries WHERE organization_id = ? AND scope_kind = 'organization' AND dedupe_key = ?", [input.organizationId, messageEventKey(row.id)])
    if (!entry) throw new Error(`Team message ${row.id} has no organization receipt`)
    const seated = await queryAll<{ user_id: string }>(db, `SELECT m.userId AS user_id FROM team_thread_members s
      JOIN member m ON m.id = s.member_id AND m.organizationId = s.organization_id WHERE s.organization_id = ? AND s.thread_id = ?`, [input.organizationId, row.thread_id])
    const recipients = seated.map(seat => seat.user_id).filter(userId => input.alertUserIds.includes(userId))
    try {
      await notifyTeamMessage(env, db, { organizationId: input.organizationId, threadId: row.thread_id, entryId: entry.id, senderName: input.senderName, messagePreview: body, recipientUserIds: recipients })
      await publishThreadChanged(env, input.organizationId, row.thread_id, { message_id: row.id })
    } catch (error) {
      // The alert is part of the message: one that could not be told is not kept, so the next post writes and tells it again.
      await executeBatch(db, [
        { query: 'DELETE FROM activity_entries WHERE organization_id = ? AND id = ?', params: [input.organizationId, entry.id] },
        { query: 'DELETE FROM team_messages WHERE organization_id = ? AND id = ?', params: [input.organizationId, row.id] },
      ], { operation: 'Withdraw an automatic team message whose alert failed' })
      throw error
    }
  }
  return { threadId: row.thread_id, messageId: row.id, created }
}

/**
 * A job's conversation keeps its history when the owners and admins change: the
 * seats are brought up to today's roster and the conversation is addressed by
 * that roster from now on. Nobody is removed; a departed member's seat is gone
 * with their membership.
 */
export async function reseatAutomaticThread(db: DbClient, input: { organizationId: string; threadId: string; seatMemberIds: readonly string[]; participantsKey: string }): Promise<void> {
  const now = new Date().toISOString()
  const results = await executeBatch(db, [
    ...input.seatMemberIds.map(memberId => ({
      query: `INSERT INTO team_thread_members (thread_id, organization_id, member_id, last_read_at, created_at) SELECT id, organization_id, ?, NULL, ? FROM team_threads WHERE organization_id = ? AND id = ?
              ON CONFLICT DO NOTHING`,
      params: [memberId, now, input.organizationId, input.threadId],
    })),
    { query: 'UPDATE team_threads SET participants_key = ? WHERE organization_id = ? AND id = ?', params: [input.participantsKey, input.organizationId, input.threadId] },
  ], { operation: 'Bring a job conversation up to today’s roster' })
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) throw new Error(`Team conversation ${input.threadId} could not be addressed by its new roster`)
}

/**
 * Report a message in one of the caller's conversations (App Store guideline
 * 1.2). KrabiClaw's operators are emailed before the caller hears it worked;
 * the same key finds the same report.
 */
export async function reportTeamMessage(env: ContentReportEnv, db: DbClient, access: TeamAccess, threadId: string, messageId: string, input: { reason: unknown; idempotencyKey: unknown }): Promise<ContentReport> {
  await requireSeat(db, access, threadId)
  const reason = reportReason(input.reason)
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) fail(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency key is required', 'idempotencyKey')
  const message = await queryFirst<{ sender_user_id: string | null; body: string }>(db,
    'SELECT sender_user_id, body FROM team_messages WHERE organization_id = ? AND thread_id = ? AND id = ?', [access.organizationId, threadId, messageId])
  if (!message) fail(404, 'TEAM_MESSAGE_NOT_FOUND', 'That message is not in this conversation', 'messageId')
  if (message.sender_user_id === access.userId) fail(422, 'OWN_MESSAGE', 'You cannot report your own message', 'messageId')
  const id = contentReportId(access.userId, input.idempotencyKey)
  await executeBatch(db, [contentReportInsert({
    id, organizationId: access.organizationId, reporterUserId: access.userId, subject: 'team_message', requestId: null,
    teamMessageId: messageId, authorUserId: message.sender_user_id, reason, excerpt: message.body || 'Photos only', blocked: false,
  })], { operation: 'Report a team message' })
  await assertSameReport(db, id, { subject: 'team_message', requestId: null, teamMessageId: messageId, reason, blocked: false })
  return await announceContentReport(env, db, id)
}

/** Staff removal of a reported message: its photo placements, then the message. */
export function teamMessageRemovalQueries(organizationId: string, messageId: string): BatchQuery[] {
  return [
    { query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'team_message' AND owner_id = ?`, params: [organizationId, messageId] },
    { query: 'DELETE FROM team_messages WHERE organization_id = ? AND id = ?', params: [organizationId, messageId] },
  ]
}

/** The caller has read the conversation up to now. */
export async function markTeamThreadRead(db: DbClient, access: TeamAccess, threadId: string): Promise<{ status: 'read'; lastReadAt: string }> {
  await requireSeat(db, access, threadId)
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: 'UPDATE team_thread_members SET last_read_at = ? WHERE organization_id = ? AND thread_id = ? AND member_id = ?',
    params: [now, access.organizationId, threadId, access.memberId],
  }], { operation: 'Mark a team conversation read' })
  return { status: 'read', lastReadAt: now }
}
