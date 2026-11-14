import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { announceContentReport, assertSameReport, contentReportId, contentReportInsert, reportReason, type ContentReport, type ContentReportEnv } from '~/server/domain/content-reports'
import { assertAssignedBookingAccess, assertLocationAccess, listAllOrganizationMembers, organizationAdapter, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { publishConversationEvent, publishDashboardInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { notifyTeamMessage } from '~/server/utils/notifications'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { MessageIdentity } from '~/shared/dashboard-invalidations'
import { getStay, stayAccessFor } from '~/server/domain/stays'
import type { JobSubject } from '~/server/domain/tasks'
import { appendMessage, conversationAccessDenied, participantGuard, type ConversationParticipantRow, type ConversationRow, type MessageRow } from '~/server/domain/conversations'
import { messagePreview } from '~/server/domain/guest-threads/attachments'

/**
 * Team conversations: the organization's own members talking to each other,
 * optionally about one booking (a job's conversation) or one place. They are
 * conversations of kind `team` (server/domain/conversations.ts): a seat is a
 * conversation_participants row of the member's user, and the messages are
 * messages, so read positions, unread and archive are the conversation's
 * own. The dashboard, the native app and MCP call these functions.
 *
 * A current Better Auth member can start a conversation. A seat grants access.
 * Leaving the organization ends a person's seats
 * (conversations.ts `departedParticipantsQuery`), while what they wrote stays with their user id.
 */

type TeamEnv = CloudflareEnv & GuestInboxPublicationEnv

export interface TeamMember {
  member_id: string
  /** The member's user id: what participants and senders are named by. */
  id: string
  name: string
  email: string
  image: string | null
  role: string
}

export interface TeamParticipant {
  id: string
  member_id: string
  name: string
  image: string | null
}

export interface TeamThread {
  id: string
  name: string | null
  is_group: boolean
  created_by_user_id: string | null
  can_manage: boolean
  can_leave: boolean
  created_at: string
  last_message_at: string
  booking_id: string | null
  location_id: string | null
  participants: TeamParticipant[]
  /** A message from someone else after the caller's read position (conversations.ts unreadSql). */
  unread: boolean
}

const MAX_BODY = 5000
const MAX_THREAD_MEMBERS = 50
const MAX_GROUP_NAME = 100
const ROLE_ORDER = new Map([['owner', 0], ['admin', 1]])

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, field } })
}

/** A team message's key in the one message table: one per conversation and sender key. */
export const teamMessageKey = (threadId: string, key: string) => `team:${threadId}:${key}`

function requestKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'MISSING_IDEMPOTENCY_KEY', 'An idempotency key is required', 'idempotency_key')
  if (value.trim().length > 200) fail(422, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key must be at most 200 characters', 'idempotency_key')
  return value.trim()
}

function groupName(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_GROUP_NAME) {
    fail(422, 'INVALID_GROUP_NAME', `A group name must contain 1 to ${MAX_GROUP_NAME} characters, or be null`, 'name')
  }
  return value.trim()
}

const groupCreationKey = (access: MemberAccessPrincipal, key: string) => `team-group-create:${access.organizationId}:${access.userId}:${key}`

async function canManageGroups(access: MemberAccessPrincipal): Promise<boolean> {
  return await roleAllows({ ...access, permissions: { member: ['update'] } })
}

/** Every current member of the organization, owners and admins first. */
export async function listTeamMembers(env: CloudflareEnv, access: MemberAccessPrincipal): Promise<TeamMember[]> {
  const members = await listAllOrganizationMembers(await organizationAdapter(env), access.organizationId)
  return members
    .map(member => ({ member_id: member.id, id: member.user.id, name: member.user.name, email: member.user.email, image: member.user.image ?? null, role: member.role }))
    .sort((left, right) => (ROLE_ORDER.get(left.role) ?? 99) - (ROLE_ORDER.get(right.role) ?? 99) || left.name.localeCompare(right.name))
}

/** The caller's seat in one team conversation of this organization. */
async function requireSeat(db: DbClient, access: MemberAccessPrincipal, threadId: string) {
  const guard = participantGuard('c', access.userId, 'member')
  const seat = await queryFirst<{ id: string }>(db, `SELECT c.id FROM conversations c
     WHERE c.organization_id = ? AND c.id = ? AND c.kind = 'team' AND ${guard.sql}`, [access.organizationId, threadId, ...guard.params])
  if (!seat) fail(404, 'TEAM_THREAD_NOT_FOUND', 'That conversation is not one of yours', 'conversation_id')
  return seat
}

async function publishThreadChanged(env: GuestInboxPublicationEnv, db: DbClient, threadId: string, type: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE', committed: Record<string, string>, message?: MessageIdentity) {
  try {
    await publishConversationEvent(env, db, { conversationId: threadId, type, message })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'The change was saved, but open apps could not be told. Retry with the same request.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, conversation_id: threadId, ...committed }, cause })
  }
}

/**
 * The team context shown above the shared transcript.
 * The list of conversations is the one list (guest-threads/repository.ts
 * listConversations).
 */
export async function presentGroupConversation(access: MemberAccessPrincipal, thread: ConversationRow, roster: ConversationParticipantRow[], unread: boolean): Promise<TeamThread> {
  const mutableGroup = thread.is_group === 1 && !thread.booking_id && !thread.location_id
  const participants = roster.flatMap(({ id, member_id, name, image, role }) =>
    role === 'member' && id && member_id ? [{ id, member_id, name, image }] : [])
  if (!participants.some(person => person.id === access.userId && person.member_id === access.memberId)) conversationAccessDenied()
  const managesGroup = mutableGroup && (thread.created_by_user_id === access.userId || await canManageGroups(access))
  return {
    id: thread.id,
    name: thread.name,
    is_group: thread.is_group === 1,
    created_by_user_id: thread.created_by_user_id,
    can_manage: managesGroup,
    can_leave: mutableGroup,
    created_at: thread.created_at,
    last_message_at: thread.last_message_at,
    booking_id: thread.booking_id,
    location_id: thread.location_id,
    participants,
    unread,
  }
}

/** The seats a batch writes: each member's user, only while they are still a member. */
function seatQueries(organizationId: string, threadId: string, memberIds: readonly string[], now: string): BatchQuery[] {
  return memberIds.map(memberId => ({
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at)
      SELECT c.id, c.organization_id, m.userId, 'member', ? FROM conversations c JOIN member m ON m.organizationId = c.organization_id AND m.id = ?
       WHERE c.organization_id = ? AND c.id = ?
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'member' WHERE conversation_participants.role IS NULL`,
    params: [now, memberId, organizationId, threadId],
  }))
}

/**
 * Direct and contextual conversations reuse their initial roster. A manually
 * created group has its own identity and replays only its creation request key.
 */
export interface TeamConversationInput {
  member_user_ids?: unknown
  booking_id?: unknown
  location_id?: unknown
  name?: unknown
  idempotency_key?: unknown
}

export async function createTeamThread(env: TeamEnv, db: DbClient, access: MemberAccessPrincipal, input: TeamConversationInput): Promise<{ id: string; created: boolean }> {
  const { member_user_ids: memberIds, booking_id: bookingId, location_id: locationId } = input
  if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > MAX_THREAD_MEMBERS || memberIds.some(id => typeof id !== 'string' || !id)) {
    fail(422, 'INVALID_TEAM_MEMBERS', `member_user_ids must list 1 to ${MAX_THREAD_MEMBERS} member user ids`, 'member_user_ids')
  }
  if (bookingId !== undefined && (typeof bookingId !== 'string' || !bookingId)) fail(422, 'INVALID_BOOKING_ID', 'booking_id must name a booking', 'booking_id')
  if (locationId !== undefined && (typeof locationId !== 'string' || !locationId)) fail(422, 'INVALID_LOCATION_ID', 'location_id must name a location', 'location_id')
  const members = await listAllOrganizationMembers(await organizationAdapter(env), access.organizationId)
  const byUser = new Map(members.map(member => [member.user.id, member]))
  if (byUser.get(access.userId)?.id !== access.memberId) fail(404, 'ORGANIZATION_MEMBER_NOT_FOUND', 'Your workspace membership has ended', 'memberId')
  const others = [...new Set(memberIds as string[])].filter(id => id !== access.userId)
  if (!others.length) fail(422, 'TEAM_THREAD_MEMBERS_REQUIRED', 'Choose at least one other member', 'member_user_ids')
  if (others.length + 1 > MAX_THREAD_MEMBERS) fail(422, 'INVALID_TEAM_MEMBERS', `A conversation can have at most ${MAX_THREAD_MEMBERS} members including you`, 'member_user_ids')
  const isGroup = others.length >= 2 && bookingId === undefined && locationId === undefined
  if (!isGroup && input.name !== undefined) fail(422, 'TEAM_GROUP_REQUIRED', 'Only manually created internal groups can have a group name', 'name')
  const name = input.name === undefined ? null : groupName(input.name)
  const dedupeKey = isGroup ? groupCreationKey(access, requestKey(input.idempotency_key)) : null
  const requestHash = isGroup ? await creationRequestHash({ member_user_ids: [...others, access.userId].sort(), name }) : null
  if (dedupeKey) {
    // A committed creation survives later roster changes. Only the caller's
    // current membership and seat matter when finishing its publication.
    const replay = await readCreationRecord(db, dedupeKey)
    if (replay) {
      if (replay.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different group creation', 'idempotency_key')
      await requireSeat(db, access, replay.entityId)
      await publishThreadChanged(env, db, replay.entityId, 'MESSAGE_UPDATE', {})
      return { id: replay.entityId, created: false }
    }
  }
  const unknown = (memberIds as string[]).filter(id => !byUser.has(id))
  if (unknown.length) fail(422, 'INVALID_TEAM_MEMBERS', `Not members of this organization: ${unknown.join(', ')}`, 'member_user_ids')
  let subject: JobSubject | null = null
  if (typeof bookingId === 'string') {
    const booking = await queryFirst<{ nights: number }>(db, 'SELECT product_session_id IS NULL AS nights FROM bookings WHERE organization_id = ? AND id = ?', [access.organizationId, bookingId])
    if (!booking) fail(404, 'BOOKING_NOT_FOUND', 'That booking is not one you can see', 'booking_id')
    subject = { id: bookingId, unit: booking.nights === 1 ? 'nights' : 'slot' }
    try {
      // A stay is seen by who looks after its home; any other booking by who handles it.
      if (subject.unit === 'nights') await getStay(db, await stayAccessFor(access), bookingId)
      else await assertAssignedBookingAccess(db, { ...access, bookingId })
    } catch (error) {
      if (HTTPError.isError(error) && error.status === 404) fail(404, 'BOOKING_NOT_FOUND', 'That booking is not one you can see', 'booking_id')
      throw error
    }
  }
  if (typeof locationId === 'string') {
    try {
      await assertLocationAccess(db, { ...access, locationId })
    } catch (error) {
      if (HTTPError.isError(error) && error.status === 404) fail(404, 'LOCATION_NOT_FOUND', 'That location is not one you can see', 'location_id')
      throw error
    }
  }
  const seatIds = [access.memberId, ...others.map(id => byUser.get(id)!.id)]
  const participantsKey = dedupeKey ?? await threadParticipantsKey(subject, locationId as string | undefined ?? null, seatIds)
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
      query: `INSERT INTO conversations (id, organization_id, kind, booking_id, location_id, created_by_user_id, name, is_group, participants_key, last_message_at, created_at)
              SELECT ?, ?, 'team', ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM member WHERE id = ? AND organizationId = ? AND userId = ?)
                AND (SELECT COUNT(*) FROM member WHERE organizationId = ? AND id IN (SELECT value FROM json_each(?))) = ?
              ON CONFLICT (organization_id, participants_key) WHERE participants_key IS NOT NULL DO NOTHING`,
      params: [id, access.organizationId, subject?.id ?? null, locationId ?? null, access.userId, name, Number(isGroup), participantsKey, now, now,
        access.memberId, access.organizationId, access.userId, access.organizationId, d1JsonStringSet(seatIds), seatIds.length],
    },
    ...seatQueries(access.organizationId, id, seatIds, now),
    ...(creationAudit ? [{ query: creationAudit.query + ' WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?)', params: [...creationAudit.params!, id] }] : []),
  ], { operation: 'Start a team conversation' })
  const thread = await queryFirst<{ id: string }>(db, 'SELECT id FROM conversations WHERE organization_id = ? AND participants_key = ?', [access.organizationId, participantsKey])
  if (!thread) fail(409, 'TEAM_MEMBERS_CHANGED', 'Workspace membership changed while starting the conversation. Choose its members again.', 'member_user_ids')
  if (dedupeKey) {
    const record = await readCreationRecord(db, dedupeKey)
    if (!record || record.entityId !== thread.id) throw new Error(`Team group ${thread.id} has no creation receipt`)
    if (record.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different group creation', 'idempotency_key')
  }
  await requireSeat(db, access, thread.id)
  await publishThreadChanged(env, db, thread.id, 'MESSAGE_UPDATE', {})
  return { id: thread.id, created: thread.id === id }
}

export interface TeamGroupOperationInput {
  action: unknown
  idempotency_key: unknown
  name?: unknown
  member_user_ids?: unknown
  user_id?: unknown
}

export interface TeamGroupOperationResult {
  status: 'updated' | 'left'
  conversation_id: string
}

/**
 * Only manual groups have a mutable roster. The operation receipt is committed
 * atomically with its mutation and replays after a leave has ended the seat.
 */
export async function operateTeamGroup(env: TeamEnv, db: DbClient, access: MemberAccessPrincipal, threadId: string, input: TeamGroupOperationInput): Promise<TeamGroupOperationResult> {
  const { action } = input
  if (action !== 'rename' && action !== 'add' && action !== 'remove' && action !== 'leave') fail(422, 'INVALID_GROUP_OPERATION', 'Choose rename, add, remove or leave', 'action')
  for (const field of ['name', 'member_user_ids', 'user_id'] as const) {
    if (input[field] !== undefined && !((action === 'rename' && field === 'name') || (action === 'add' && field === 'member_user_ids') || (action === 'remove' && field === 'user_id'))) {
      fail(422, 'INVALID_GROUP_OPERATION', `${field} is not used by ${action}`, field)
    }
  }
  const key = requestKey(input.idempotency_key)
  const name = action === 'rename' ? groupName(input.name) : undefined
  let memberIds: string[] = []
  if (action === 'add') {
    if (!Array.isArray(input.member_user_ids) || !input.member_user_ids.length || input.member_user_ids.length > MAX_THREAD_MEMBERS
      || input.member_user_ids.some(id => typeof id !== 'string' || !id)) fail(422, 'INVALID_TEAM_MEMBERS', 'Choose current workspace members to add', 'member_user_ids')
    memberIds = [...new Set(input.member_user_ids as string[])].sort()
  }
  const removedUserId = action === 'leave' ? access.userId : action === 'remove' ? input.user_id : null
  if (action === 'remove' && (typeof removedUserId !== 'string' || !removedUserId)) fail(422, 'INVALID_TEAM_MEMBER', 'Choose a participant to remove', 'user_id')
  if (action === 'remove' && removedUserId === access.userId) fail(422, 'USE_LEAVE_GROUP', 'Use Leave group to leave this conversation', 'user_id')
  const dedupeKey = `team-group-operation:${access.organizationId}:${access.userId}:${key}`
  const requestHash = await creationRequestHash({ threadId, action, name, memberIds, removedUserId })
  const currentMember = await queryFirst(db, 'SELECT id FROM member WHERE id = ? AND organizationId = ? AND userId = ?', [access.memberId, access.organizationId, access.userId])
  if (!currentMember) fail(404, 'ORGANIZATION_MEMBER_NOT_FOUND', 'Your workspace membership has ended', 'memberId')
  const publish = async () => {
    try {
      // No payload content is sent to a person whose seat ended. The hub also
      // suppresses this event if the person has since been added again.
      if (typeof removedUserId === 'string') await publishDashboardInvalidation(env, {
        event_id: crypto.randomUUID(), type: 'CONVERSATION_LEAVE', organization_id: access.organizationId,
        conversation_id: threadId, user_id: removedUserId, occurred_at: new Date().toISOString(),
      })
      await publishConversationEvent(env, db, { conversationId: threadId, type: 'MESSAGE_UPDATE' })
    } catch (cause) {
      throw new HTTPError({ statusCode: 503, message: 'The group change was saved, but open apps could not be told. Retry with the same request.',
        data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, conversation_id: threadId }, cause })
    }
    return { status: action === 'leave' ? 'left' as const : 'updated' as const, conversation_id: threadId }
  }
  const verifyRecord = (record: NonNullable<Awaited<ReturnType<typeof readCreationRecord>>>) => {
    if (record.entityId !== threadId || record.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different group operation', 'idempotency_key')
  }
  const replay = await readCreationRecord(db, dedupeKey)
  if (replay) {
    verifyRecord(replay)
    return await publish()
  }
  const requireGroup = async () => {
    await requireSeat(db, access, threadId)
    const thread = await queryFirst<{ is_group: number; booking_id: string | null; location_id: string | null; created_by_user_id: string | null }>(db,
      "SELECT is_group, booking_id, location_id, created_by_user_id FROM conversations WHERE organization_id = ? AND id = ? AND kind = 'team'", [access.organizationId, threadId])
    if (!thread?.is_group || thread.booking_id || thread.location_id) fail(409, 'TEAM_GROUP_PROTECTED', 'Only manually created internal groups can be changed or left', 'conversation_id')
    if (action !== 'leave' && thread.created_by_user_id !== access.userId && !await canManageGroups(access)) {
      fail(403, 'TEAM_GROUP_MANAGEMENT_REQUIRED', 'Only the group creator and participating workspace owners or admins can manage this group', 'permissions')
    }
  }
  await requireGroup()
  if (action === 'add') {
    const available = await listTeamMembers(env, access)
    if (memberIds.some(id => !available.some(member => member.id === id))) fail(422, 'INVALID_TEAM_MEMBERS', 'Only current members of this workspace can be added', 'member_user_ids')
  }
  if (typeof removedUserId === 'string' && !await queryFirst(db, 'SELECT 1 FROM conversation_participants WHERE organization_id = ? AND conversation_id = ? AND user_id = ?', [access.organizationId, threadId, removedUserId])) {
    fail(404, 'TEAM_GROUP_MEMBER_NOT_FOUND', 'That person is not in this group', 'user_id')
  }
  const permittedManager = await canManageGroups(access)
  const targets = d1JsonStringSet(memberIds)
  const guard = `EXISTS (SELECT 1 FROM conversations t
    JOIN conversation_participants s ON s.conversation_id = t.id
    JOIN member m ON m.organizationId = t.organization_id AND m.userId = s.user_id
    WHERE t.organization_id = ? AND t.id = ? AND t.kind = 'team' AND t.is_group = 1 AND t.booking_id IS NULL AND t.location_id IS NULL AND s.role = 'member'
      AND m.id = ? AND m.userId = ? AND m.role = ?
      AND (? = 'leave' OR t.created_by_user_id = ? OR ? = 1))`
  const guardParams: unknown[] = [access.organizationId, threadId, access.memberId, access.userId, access.role, action, access.userId, Number(permittedManager)]
  const conditions = [guard]
  if (action === 'add') {
    conditions.push(`(SELECT COUNT(*) FROM member WHERE organizationId = ? AND userId IN (SELECT value FROM json_each(?))) = ?`)
    guardParams.push(access.organizationId, targets, memberIds.length)
    conditions.push(`(SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = ? AND role = 'member') +
      (SELECT COUNT(*) FROM member m WHERE m.organizationId = ? AND m.userId IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM conversation_participants s WHERE s.conversation_id = ? AND s.user_id = m.userId AND s.role = 'member')) <= ?`)
    guardParams.push(threadId, access.organizationId, targets, threadId, MAX_THREAD_MEMBERS)
  }
  if (typeof removedUserId === 'string') {
    conditions.push('EXISTS (SELECT 1 FROM conversation_participants s WHERE s.conversation_id = ? AND s.user_id = ?)')
    guardParams.push(threadId, removedUserId)
  }
  const audit = organizationEventQuery({ organizationId: access.organizationId, actorId: access.userId, eventType: 'team.group_updated', entityType: 'team_thread', entityId: threadId,
    dedupeKey, metadata: { request_hash: requestHash, action, name, member_user_ids: memberIds, removed_user_id: removedUserId },
  })
  // Only this batch's freshly inserted receipt admits its writes. A different
  // request racing with the same key must never borrow the earlier receipt.
  const receipt = 'EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)'
  const receiptId = audit.params![0]
  const writes: BatchQuery[] = [{ query: audit.query + ` WHERE ${conditions.join(' AND ')}`, params: [...audit.params!, ...guardParams] }]
  if (action === 'rename') writes.push({ query: `UPDATE conversations SET name = ? WHERE organization_id = ? AND id = ? AND ${receipt}`, params: [name, access.organizationId, threadId, receiptId] })
  if (action === 'add') writes.push({
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at)
      SELECT ?, m.organizationId, m.userId, 'member', ? FROM member m WHERE m.organizationId = ? AND m.userId IN (SELECT value FROM json_each(?)) AND ${receipt}
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'member' WHERE conversation_participants.role IS NULL`,
    params: [threadId, new Date().toISOString(), access.organizationId, targets, receiptId],
  })
  if (typeof removedUserId === 'string') writes.push({
    query: `DELETE FROM conversation_participants WHERE organization_id = ? AND conversation_id = ? AND user_id = ? AND ${receipt}`,
    params: [access.organizationId, threadId, removedUserId, receiptId],
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
    fail(409, 'TEAM_GROUP_CHANGED', 'Group membership changed or the group would exceed 50 members. Reload before trying again.', 'member_user_ids')
  }
  verifyRecord(committed)
  return await publish()
}

/** Team delivery fans out to current participants after the shared message commit. */
export async function deliverTeamMessage(env: TeamEnv, db: DbClient, row: MessageRow, senderName: string, photoCount: number, created: boolean): Promise<void> {
  const recipients = await queryAll<{ user_id: string }>(db, `SELECT seat.user_id FROM conversation_participants seat
    JOIN member m ON m.organizationId = seat.organization_id AND m.userId = seat.user_id
    WHERE seat.conversation_id = ? AND seat.role = 'member' AND seat.user_id <> ?`, [row.conversation_id, row.author_user_id])
  await notifyTeamMessage(env, db, {
    organizationId: row.organization_id,
    threadId: row.conversation_id,
    messageId: row.id,
    senderName,
    messagePreview: messagePreview(row.body, photoCount),
    recipientUserIds: recipients.map(recipient => recipient.user_id),
  })
  await publishThreadChanged(env, db, row.conversation_id, created ? 'MESSAGE_CREATE' : 'MESSAGE_UPDATE', { message_id: row.id }, { id: row.id, sequence: row.sequence })
}

/**
 * The identity of a direct or contextual conversation: its booking, place and
 * exact seats. The hashed fields keep the shape conversations were first keyed
 * with (a stay's id as `stay_id`, any other booking's as `booking_id`), so an
 * existing conversation is found again.
 */
function threadParticipantsKey(subject: JobSubject | null, locationId: string | null, seatMemberIds: readonly string[]): Promise<string> {
  return creationRequestHash({ stay_id: subject?.unit === 'nights' ? subject.id : null, ...(subject?.unit === 'slot' ? { booking_id: subject.id } : {}),
    location_id: locationId, member_ids: [...new Set(seatMemberIds)].sort() })
}

/** The identity of a job's conversation with exactly these seats: what `createTeamThread` gives the same roster. */
export function jobThreadParticipantsKey(subject: JobSubject, seatMemberIds: readonly string[]): Promise<string> {
  return threadParticipantsKey(subject, null, seatMemberIds)
}

/**
 * KrabiClaw writes into a stay's team conversation: a cleaning job, a
 * reminder, a move, a cancellation. The conversation with exactly these seats
 * is the one a member starts for the same people (`createTeamThread`), opened
 * here when nobody has yet. The message is sent once per key (kept as its
 * payload's `key`); it alerts only the users named, and like every message
 * from someone else it is unread until read. Owners and admins read it in the
 * conversation.
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
  let threadId = input.threadId
  if (threadId) {
    if (!await queryFirst(db, "SELECT 1 FROM conversations WHERE organization_id = ? AND id = ? AND kind = 'team'", [input.organizationId, threadId])) throw new Error(`Team conversation ${threadId} does not exist in organization ${input.organizationId}`)
  } else {
    const participantsKey = await jobThreadParticipantsKey(input.subject, seatIds)
    const now = new Date().toISOString()
    const id = (await queryFirst<{ id: string }>(db, 'SELECT id FROM conversations WHERE organization_id = ? AND participants_key = ?', [input.organizationId, participantsKey]))?.id ?? crypto.randomUUID()
    await executeBatch(db, [{
      // Only while every seat is a current member; a roster that has lost someone is not opened.
      query: `INSERT INTO conversations (id, organization_id, kind, booking_id, participants_key, last_message_at, created_at)
              SELECT ?, ?, 'team', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.organization_id = ? AND b.id = ?)
                AND (SELECT COUNT(*) FROM member WHERE organizationId = ? AND id IN (SELECT value FROM json_each(?))) = ?
              ON CONFLICT (organization_id, participants_key) WHERE participants_key IS NOT NULL DO NOTHING`,
      params: [id, input.organizationId, input.subject.id, participantsKey, now, now, input.organizationId, input.subject.id, input.organizationId, d1JsonStringSet(seatIds), seatIds.length],
    }, ...seatQueries(input.organizationId, id, seatIds, now)], { operation: 'Open a job conversation' })
    threadId = (await queryFirst<{ id: string }>(db, 'SELECT id FROM conversations WHERE organization_id = ? AND participants_key = ?', [input.organizationId, participantsKey]))?.id
    if (!threadId) throw new Error(`Automatic team message ${input.idempotencyKey} for booking ${input.subject.id} has no conversation: a seat is no longer a member or the booking is gone`)
  }
  const messageId = crypto.randomUUID()
  const row = await appendMessage(db, {
    id: messageId, conversationId: threadId, authorKind: 'krabiclaw', authorUserId: null, body,
    payload: { key: input.idempotencyKey }, dedupeKey: teamMessageKey(threadId, input.idempotencyKey),
  })
  const created = row.id === messageId
  if (created) {
    const seated = await queryAll<{ user_id: string }>(db, `SELECT seat.user_id FROM conversation_participants seat
      JOIN member m ON m.organizationId = seat.organization_id AND m.userId = seat.user_id WHERE seat.conversation_id = ? AND seat.role = 'member'`, [threadId])
    const recipients = seated.map(seat => seat.user_id).filter(userId => input.alertUserIds.includes(userId))
    try {
      await notifyTeamMessage(env, db, { organizationId: input.organizationId, threadId, messageId: row.id, senderName: input.senderName, messagePreview: body, recipientUserIds: recipients })
    } catch (error) {
      // The alert is part of the message: one that could not be told is not kept, so the next post writes and tells it again.
      await executeBatch(db, [{ query: 'DELETE FROM messages WHERE organization_id = ? AND id = ?', params: [input.organizationId, row.id] }],
        { operation: 'Withdraw an automatic team message whose alert failed' })
      throw error
    }
    // Told and kept: a refresh that fails is reported, and the next change refreshes the open inboxes.
    await publishThreadChanged(env, db, threadId, 'MESSAGE_CREATE', { message_id: row.id }, { id: row.id, sequence: row.sequence })
  }
  return { threadId, messageId: row.id, created }
}

/**
 * A job's conversation keeps its history when the owners and admins change: the
 * seats are brought up to today's roster and the conversation is addressed by
 * that roster from now on. Nobody is removed; a departed member's seat is gone
 * with their membership.
 */
export async function reseatAutomaticThread(db: DbClient, input: { organizationId: string; threadId: string; seatMemberIds: readonly string[]; participantsKey: string }): Promise<{ threadId: string }> {
  // Someone may already have opened the conversation this roster is addressed by ("Message host" after a host joined): that one carries the job from here.
  const addressed = await queryFirst<{ id: string }>(db, 'SELECT id FROM conversations WHERE organization_id = ? AND participants_key = ?', [input.organizationId, input.participantsKey])
  if (addressed) return { threadId: addressed.id }
  const results = await executeBatch(db, [
    ...seatQueries(input.organizationId, input.threadId, input.seatMemberIds, new Date().toISOString()),
    { query: "UPDATE conversations SET participants_key = ? WHERE organization_id = ? AND id = ? AND kind = 'team'", params: [input.participantsKey, input.organizationId, input.threadId] },
  ], { operation: 'Bring a job conversation up to today’s roster' })
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) throw new Error(`Team conversation ${input.threadId} could not be addressed by its new roster`)
  return { threadId: input.threadId }
}

/**
 * Report a message in one of the caller's conversations (App Store guideline
 * 1.2). KrabiClaw's operators are emailed before the caller hears it worked;
 * the same key finds the same report.
 */
export async function reportTeamMessage(env: ContentReportEnv, db: DbClient, access: MemberAccessPrincipal, threadId: string, messageId: string, input: { reason: unknown; idempotency_key: unknown }): Promise<ContentReport> {
  await requireSeat(db, access, threadId)
  const reason = reportReason(input.reason)
  if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim()) fail(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency key is required', 'idempotency_key')
  const message = await queryFirst<{ author_kind: string; author_user_id: string | null; body: string | null }>(db,
    'SELECT author_kind, author_user_id, body FROM messages WHERE organization_id = ? AND conversation_id = ? AND id = ?', [access.organizationId, threadId, messageId])
  if (!message) fail(404, 'TEAM_MESSAGE_NOT_FOUND', 'That message is not in this conversation', 'message_id')
  if (message.author_kind === 'member' && message.author_user_id === access.userId) fail(422, 'OWN_MESSAGE', 'You cannot report your own message', 'message_id')
  const authorUserId = message.author_kind === 'krabiclaw' ? null : message.author_user_id
  const id = contentReportId(access.userId, input.idempotency_key)
  await executeBatch(db, [contentReportInsert({
    id, organizationId: access.organizationId, reporterUserId: access.userId, subject: 'message', conversationId: null,
    messageId, authorUserId, reason, excerpt: message.body || 'Photos only', blocked: false,
  })], { operation: 'Report a team message' })
  await assertSameReport(db, id, { subject: 'message', conversationId: null, messageId, reason, blocked: false })
  return await announceContentReport(env, db, id)
}

/** Staff removal of a reported message: its photo placements, then the message. */
export function teamMessageRemovalQueries(organizationId: string, messageId: string): BatchQuery[] {
  return [
    { query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'message' AND owner_id = ?`, params: [organizationId, messageId] },
    { query: 'DELETE FROM messages WHERE organization_id = ? AND id = ?', params: [organizationId, messageId] },
  ]
}
