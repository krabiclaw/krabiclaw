import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { assertLocationAccess, assertRoleAllows, listAllOrganizationMembers, organizationAdapter, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationRequestHash, organizationEventQuery } from '~/server/utils/organization-events'
import { publishDashboardInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { notifyTeamMessage } from '~/server/utils/notifications'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { GuestThreadDeliveryStatus } from '~/server/domain/guest-threads/types'
import { getStay, stayAccessFor } from '~/server/domain/stays'
import {
  discardMessagePhotos,
  listMessagePhotos,
  MAX_MESSAGE_PHOTOS,
  MessagePhotoRejection,
  messagePhotoPlacements,
  messagePreview,
  uploadMessagePhotos,
  type MessagePhoto,
} from '~/server/domain/guest-threads/attachments'

/**
 * Team conversations: the organization's own members talking to each other,
 * optionally about one stay. The dashboard and the native app call these
 * functions; nothing else reads or writes the team tables.
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
  createdAt: string
  lastMessageAt: string
  stayId: string | null
  locationId: string | null
  stay: TeamStaySummary | null
  location: TeamLocationSummary | null
  participants: TeamParticipant[]
  lastMessage: { id: string; senderId: string | null; body: string; attachmentCount: number; createdAt: string } | null
  unread: boolean
  unreadCount: number
}

export interface TeamMessage {
  id: string
  threadId: string
  /** null only once the sender's account has been deleted. */
  senderId: string | null
  body: string
  attachments: Array<{ id: string; url: string; width: number | null; height: number | null }>
  /** Each push this message was sent as, with Apple's outcome. */
  deliveries: Array<{ id: string; channel: 'push'; status: GuestThreadDeliveryStatus; error: string | null; updatedAt: string }>
  createdAt: string
}

const MAX_BODY = 5000
const MAX_THREAD_MEMBERS = 50
const ROLE_ORDER = new Map([['owner', 0], ['admin', 1]])

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, field } })
}

const messageEventKey = (messageId: string) => `team-message:${messageId}`

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
export async function listTeamThreads(env: CloudflareEnv, db: DbClient, access: TeamAccess, filter?: { locationId?: string; stayId?: string }): Promise<TeamThread[]> {
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
  const threads = await queryAll<{ id: string; stay_id: string | null; location_id: string | null; last_message_at: string; created_at: string; unread_count: number }>(db, `
    SELECT t.id, t.stay_id, t.location_id, t.last_message_at, t.created_at,
           (SELECT COUNT(*) FROM team_messages m
             WHERE m.organization_id = t.organization_id AND m.thread_id = t.id AND m.sender_user_id IS NOT ?
               AND (s.last_read_at IS NULL OR m.created_at > s.last_read_at)) AS unread_count
      FROM team_threads t
      JOIN team_thread_members s ON s.organization_id = t.organization_id AND s.thread_id = t.id
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY t.last_message_at DESC, t.id DESC`, params)
  if (!threads.length) return []
  const ids = d1JsonStringSet(threads.map(thread => thread.id))
  const stayIds = threads.flatMap(thread => thread.stay_id ? [thread.stay_id] : [])
  const locationIds = threads.flatMap(thread => thread.location_id ? [thread.location_id] : [])
  const [seats, lastMessages, stays, locations, members] = await Promise.all([
    queryAll<{ thread_id: string; member_id: string }>(db, `SELECT thread_id, member_id FROM team_thread_members
      WHERE organization_id = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id, created_at, member_id`, [access.organizationId, ids]),
    queryAll<{ id: string; thread_id: string; sender_user_id: string | null; body: string; created_at: string }>(db, `
      SELECT m.id, m.thread_id, m.sender_user_id, m.body, m.created_at FROM team_messages m
       WHERE m.organization_id = ? AND m.thread_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM team_messages n WHERE n.thread_id = m.thread_id
           AND (n.created_at > m.created_at OR (n.created_at = m.created_at AND n.id > m.id)))`, [access.organizationId, ids]),
    stayIds.length ? queryAll<{ id: string; product_id: string; home_name: string; check_in_date: string; check_out_date: string; status: TeamStaySummary['status'] }>(db, `
      SELECT s.id, s.product_id, p.name AS home_name, s.check_in_date, s.check_out_date, s.status FROM stays s
        JOIN products p ON p.organization_id = s.organization_id AND p.id = s.product_id
       WHERE s.organization_id = ? AND s.id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(stayIds)]) : [],
    locationIds.length ? queryAll<{ id: string; title: string; slug: string; timezone: string }>(db, `
      SELECT id, title, slug, timezone FROM business_locations
       WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(locationIds)]) : [],
    membersById(env, access.organizationId),
  ])
  const photos = await listMessagePhotos(db, 'team_message', lastMessages.map(message => message.id))
  return threads.map((thread) => {
    const participants = seats.filter(seat => seat.thread_id === thread.id).map((seat) => {
      const member = members.get(seat.member_id)
      if (!member) throw new Error(`Team conversation ${thread.id} seats member ${seat.member_id}, which Better Auth does not hold`)
      return { id: member.user.id, memberId: member.id, name: member.user.name, image: member.user.image ?? null }
    })
    const stayRow = thread.stay_id ? stays.find(stay => stay.id === thread.stay_id) : null
    if (thread.stay_id && !stayRow) throw new Error(`Team conversation ${thread.id} names stay ${thread.stay_id}, which was not found`)
    const locationRow = thread.location_id ? locations.find(location => location.id === thread.location_id) : null
    if (thread.location_id && !locationRow) throw new Error(`Team conversation ${thread.id} names location ${thread.location_id}, which was not found`)
    const last = lastMessages.find(message => message.thread_id === thread.id)
    const unreadCount = Number(thread.unread_count)
    return {
      id: thread.id,
      createdAt: thread.created_at,
      lastMessageAt: thread.last_message_at,
      stayId: thread.stay_id,
      locationId: thread.location_id,
      stay: stayRow ? { id: stayRow.id, productId: stayRow.product_id, homeName: stayRow.home_name, checkInDate: stayRow.check_in_date, checkOutDate: stayRow.check_out_date, status: stayRow.status } : null,
      location: locationRow ? { id: locationRow.id, title: locationRow.title, slug: locationRow.slug, timezone: locationRow.timezone } : null,
      participants,
      lastMessage: last ? { id: last.id, senderId: last.sender_user_id, body: last.body, attachmentCount: photos.get(last.id)?.length ?? 0, createdAt: last.created_at } : null,
      unread: unreadCount > 0,
      unreadCount,
    }
  })
}

/**
 * Start a conversation with other members, optionally about one stay or location
 * the caller can see. A conversation started with exactly these members about
 * the same target (or about none) is reused rather than duplicated, also when two
 * starts race.
 */
export async function createTeamThread(env: TeamEnv, db: DbClient, access: TeamAccess, input: { memberIds: unknown; stayId?: unknown; locationId?: unknown }): Promise<{ id: string; created: boolean }> {
  const { memberIds, stayId, locationId } = input
  if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > MAX_THREAD_MEMBERS || memberIds.some(id => typeof id !== 'string' || !id)) {
    fail(422, 'INVALID_TEAM_MEMBERS', `memberIds must list 1 to ${MAX_THREAD_MEMBERS} member user ids`, 'memberIds')
  }
  if (stayId !== undefined && (typeof stayId !== 'string' || !stayId)) fail(422, 'INVALID_STAY_ID', 'stayId must name a stay', 'stayId')
  if (locationId !== undefined && (typeof locationId !== 'string' || !locationId)) fail(422, 'INVALID_LOCATION_ID', 'locationId must name a location', 'locationId')
  const members = await listAllOrganizationMembers(await organizationAdapter(env), access.organizationId)
  const byUser = new Map(members.map(member => [member.user.id, member]))
  const unknown = (memberIds as string[]).filter(id => !byUser.has(id))
  if (unknown.length) fail(422, 'INVALID_TEAM_MEMBERS', `Not members of this organization: ${unknown.join(', ')}`, 'memberIds')
  const others = [...new Set(memberIds as string[])].filter(id => id !== access.userId)
  if (!others.length) fail(422, 'TEAM_THREAD_MEMBERS_REQUIRED', 'Choose at least one other member', 'memberIds')
  if (typeof stayId === 'string') {
    try {
      await getStay(db, await stayAccessFor(access.principal), stayId)
    } catch (error) {
      if (HTTPError.isError(error) && error.status === 404) fail(404, 'STAY_NOT_FOUND', 'That stay is not in a home you can see', 'stayId')
      throw error
    }
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
  const participantsKey = await creationRequestHash({
    stay_id: stayId ?? null,
    location_id: locationId ?? null,
    member_ids: [...seatIds].sort(),
  })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  // The unique key makes a repeated or concurrent start find the first conversation.
  await executeBatch(db, [
    {
      query: `INSERT INTO team_threads (id, organization_id, stay_id, location_id, created_by_user_id, participants_key, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (organization_id, participants_key) DO NOTHING`,
      params: [id, access.organizationId, stayId ?? null, locationId ?? null, access.userId, participantsKey, now, now],
    },
    ...seatIds.map(memberId => ({
      query: 'INSERT INTO team_thread_members (thread_id, organization_id, member_id, last_read_at, created_at) SELECT id, organization_id, ?, ?, ? FROM team_threads WHERE id = ?',
      params: [memberId, memberId === access.memberId ? now : null, now, id],
    })),
  ], { operation: 'Start a team conversation' })
  const thread = await queryFirst<{ id: string }>(db, 'SELECT id FROM team_threads WHERE organization_id = ? AND participants_key = ?', [access.organizationId, participantsKey])
  if (!thread) throw new Error(`Team conversation ${participantsKey} was neither created nor found`)
  if (thread.id !== id) return { id: thread.id, created: false }
  await publishThreadChanged(env, access.organizationId, id, {})
  return { id, created: true }
}

async function readMessages(db: DbClient, organizationId: string, rows: Array<{ id: string; thread_id: string; sender_user_id: string | null; body: string; created_at: string }>): Promise<TeamMessage[]> {
  const [photos, deliveries] = await Promise.all([
    listMessagePhotos(db, 'team_message', rows.map(row => row.id)),
    rows.length ? queryAll<{ dedupe_key: string; id: string; status: GuestThreadDeliveryStatus; error: string | null; updated_at: string }>(db, `
      SELECT a.dedupe_key, d.id, d.status, d.error, d.updated_at FROM guest_thread_deliveries d
        JOIN activity_entries a ON a.id = d.entry_id
       WHERE a.organization_id = ? AND a.scope_kind = 'organization' AND d.channel = 'push'
         AND a.dedupe_key IN (SELECT value FROM json_each(?))
       ORDER BY d.created_at, d.id`, [organizationId, d1JsonStringSet(rows.map(row => messageEventKey(row.id)))]) : [],
  ])
  return rows.map(row => ({
    id: row.id,
    threadId: row.thread_id,
    senderId: row.sender_user_id,
    body: row.body,
    attachments: (photos.get(row.id) ?? []).map(photo => ({ id: photo.id, url: photo.url, width: photo.width, height: photo.height })),
    deliveries: deliveries.filter(delivery => delivery.dedupe_key === messageEventKey(row.id))
      .map(delivery => ({ id: delivery.id, channel: 'push' as const, status: delivery.status, error: delivery.error, updatedAt: delivery.updated_at })),
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
  const cursor = typeof query.before === 'string' ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''
  const rows = await queryAll<{ id: string; thread_id: string; sender_user_id: string | null; body: string; created_at: string }>(db, `
    SELECT id, thread_id, sender_user_id, body, created_at FROM team_messages
     WHERE organization_id = ? AND thread_id = ? ${cursor}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  [access.organizationId, threadId, ...(cursor ? [query.before, query.before, query.beforeId] : []), limit + 1])
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
  input: { body: unknown; photos: MessagePhoto[]; idempotencyKey: unknown; senderName: string },
): Promise<{ message: TeamMessage; created: boolean }> {
  await requireSeat(db, access, threadId)
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) fail(400, 'MISSING_IDEMPOTENCY_KEY', 'An idempotency key is required', 'idempotencyKey')
  const idempotencyKey = input.idempotencyKey.trim()
  if (idempotencyKey.length > 200) fail(422, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key must be at most 200 characters', 'idempotencyKey')
  if (input.body !== undefined && typeof input.body !== 'string') fail(422, 'INVALID_MESSAGE', 'body must be text', 'body')
  const body = (input.body ?? '').trim()
  if (body.length > MAX_BODY) fail(422, 'MESSAGE_TOO_LONG', `A message can be at most ${MAX_BODY} characters`, 'body')
  if (!body && !input.photos.length) fail(422, 'EMPTY_MESSAGE', 'Write a message or add a photo', 'body')
  if (input.photos.length > MAX_MESSAGE_PHOTOS) fail(422, 'INVALID_PHOTO', `A message can carry at most ${MAX_MESSAGE_PHOTOS} photos`, 'photos')
  const requestHash = await creationRequestHash({
    body,
    photos: await Promise.all(input.photos.map(async photo => [...new Uint8Array(await crypto.subtle.digest('SHA-256', photo.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''))),
  })
  const findByKey = () => queryFirst<{ id: string; thread_id: string; sender_user_id: string | null; body: string; created_at: string; request_hash: string }>(db,
    'SELECT id, thread_id, sender_user_id, body, created_at, request_hash FROM team_messages WHERE organization_id = ? AND thread_id = ? AND idempotency_key = ?',
    [access.organizationId, threadId, idempotencyKey])
  const reused = (row: { sender_user_id: string | null; request_hash: string }) => row.sender_user_id !== access.userId || row.request_hash !== requestHash
  let row = await findByKey()
  let created = false
  if (row && reused(row)) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different message', 'idempotencyKey')
  if (!row) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    let assetIds: string[]
    try {
      assetIds = await uploadMessagePhotos(db, env, access.organizationId, input.photos, { source: 'uploaded', userId: access.userId })
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
        { query: 'UPDATE team_threads SET last_message_at = ? WHERE organization_id = ? AND id = ? AND last_message_at < ?', params: [now, access.organizationId, threadId, now] },
        { query: 'UPDATE team_thread_members SET last_read_at = ? WHERE organization_id = ? AND thread_id = ? AND member_id = ?', params: [now, access.organizationId, threadId, access.memberId] },
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
    messageId: row.id,
    entryId: entry.id,
    senderName: input.senderName,
    preview: messagePreview(row.body, photoCount).slice(0, 180),
    recipientUserIds: recipients.map(recipient => recipient.user_id),
  })
  await publishThreadChanged(env, access.organizationId, threadId, { message_id: row.id })
  const [message] = await readMessages(db, access.organizationId, [row])
  return { message: message!, created }
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
