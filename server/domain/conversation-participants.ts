import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { publishAccessInvalidation, publishConversationEvent, publishDashboardInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { conversationAccessDenied, participantGuard } from '~/server/domain/conversations'
import { hashIdentifier } from '~/server/utils/hourly-rate-limit'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'

const OWNER_ROLE = "((',' || replace(m.role, ' ', '') || ',') LIKE '%,owner,%')"
const GUEST_THREAD = "c.kind IN ('contact', 'booking')"

/** A channel conversation belongs to the listing where the guest booked. */
const listingOfConversation = `COALESCE(
  (SELECT COALESCE(b.booked_product_id, b.product_id) FROM bookings b WHERE b.organization_id = c.organization_id
    AND b.id = c.booking_id AND b.product_session_id IS NULL),
  (SELECT t.product_id FROM channel_threads t WHERE t.organization_id = c.organization_id AND t.conversation_id = c.id)
)`

/** Runs immediately after conversation creation in the same batch. */
export function initialConversationParticipants(conversationId: string, organizationId: string): BatchQuery {
  return {
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at)
      SELECT c.id, c.organization_id, c.user_id, 'guest', c.created_at FROM conversations c
      WHERE c.id = ? AND c.organization_id = ? AND c.user_id IS NOT NULL AND changes() = 1
      UNION ALL
      SELECT c.id, c.organization_id, m.userId, 'member', c.created_at FROM conversations c
      JOIN member m ON m.organizationId = c.organization_id
      WHERE c.id = ? AND c.organization_id = ? AND m.userId IS NOT c.user_id AND ${OWNER_ROLE} AND changes() = 1
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = excluded.role
      WHERE conversation_participants.role IS NULL`,
    params: [conversationId, organizationId, conversationId, organizationId],
  }
}

/** Attach a booking account and remove any former guest seat in the same write batch. */
export function transferBookingGuestSeat(scope: BatchQuery, userId: string, now: string): BatchQuery[] {
  const where = `${GUEST_THREAD} AND (${scope.query})`
  return [{
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, last_read_message_id, created_at)
      SELECT c.id, c.organization_id, ?, 'guest', former.last_read_message_id, ? FROM conversations c
      LEFT JOIN conversation_participants former ON former.conversation_id = c.id AND former.user_id = c.user_id AND former.role = 'guest'
      WHERE ${where}
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'guest', host_listing_id = NULL,
        last_read_message_id = CASE WHEN conversation_participants.role = 'guest' THEN conversation_participants.last_read_message_id ELSE excluded.last_read_message_id END,
        archived_at = CASE WHEN conversation_participants.role = 'guest' THEN conversation_participants.archived_at ELSE NULL END`,
    params: [userId, now, ...(scope.params ?? [])],
  }, {
    query: `DELETE FROM conversation_participants WHERE role = 'guest' AND user_id <> ?
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_participants.conversation_id
        AND c.user_id = conversation_participants.user_id AND ${where})`,
    params: [userId, ...(scope.params ?? [])],
  }]
}

/** Add the account when a previously anonymous channel inquiry becomes a booking. */
export function bookChannelConversationGuest(organizationId: string, bookingId: string, version: number): BatchQuery {
  return {
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at)
      SELECT c.id, c.organization_id, c.user_id, 'guest', b.updated_at FROM conversations c
      JOIN bookings b ON b.organization_id = c.organization_id AND b.id = c.booking_id AND b.user_id = c.user_id
      WHERE c.organization_id = ? AND c.booking_id = ? AND b.version = ? AND c.kind = 'booking' AND changes() = 1
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'guest', host_listing_id = NULL, last_read_message_id = NULL, archived_at = NULL
      WHERE conversation_participants.role IS NOT 'guest'`,
    params: [organizationId, bookingId, version],
  }
}

/** An anonymous account's guest seats follow its verified identity. */
export function linkGuestConversationSeats(from: string, to: string): BatchQuery[] {
  return [{
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, last_read_message_id, archived_at, created_at)
      SELECT conversation_id, organization_id, ?, role, last_read_message_id, archived_at, created_at
      FROM conversation_participants WHERE user_id = ? AND role = 'guest'
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'guest', host_listing_id = NULL,
        last_read_message_id = excluded.last_read_message_id, archived_at = excluded.archived_at
      WHERE conversation_participants.role IS NOT 'guest'`,
    params: [to, from],
  }, {
    query: "DELETE FROM conversation_participants WHERE user_id = ? AND role = 'guest'",
    params: [from],
  }]
}

export function reconcileGuestListingParticipants(organizationId: string, scope: BatchQuery): BatchQuery[] {
  return [{
    query: `DELETE FROM conversation_participants WHERE host_listing_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_participants.conversation_id
        AND c.organization_id = conversation_participants.organization_id AND c.organization_id = ? AND ${GUEST_THREAD} AND (${scope.query})
        AND conversation_participants.host_listing_id IS NOT ${listingOfConversation})`,
    params: [organizationId, ...(scope.params ?? [])],
  }, insertListingParticipants(organizationId, scope)]
}

function insertListingParticipants(organizationId: string, scope: BatchQuery): BatchQuery {
  return {
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, host_listing_id, created_at)
      SELECT c.id, c.organization_id, m.userId, 'member', grant.listing_id, grant.created_at FROM conversations c
      JOIN listing_message_members grant ON grant.organization_id = c.organization_id AND grant.listing_id = ${listingOfConversation}
      JOIN member m ON m.organizationId = grant.organization_id AND m.id = grant.member_id
      WHERE c.organization_id = ? AND ${GUEST_THREAD} AND (${scope.query}) AND m.userId IS NOT c.user_id
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'member', host_listing_id = excluded.host_listing_id
      WHERE conversation_participants.role IS NULL`,
    params: [organizationId, ...(scope.params ?? [])],
  }
}

/** New threads inherit listing grants once. */
export function initialListingParticipants(organizationId: string, conversationId: string): BatchQuery {
  return insertListingParticipants(organizationId, { query: 'c.id = ?', params: [conversationId] })
}

export async function setListingMessagingAccess(db: DbClient, env: GuestInboxPublicationEnv, principal: MemberAccessPrincipal, input: { listingId: string; memberId: string; allowed: boolean }) {
  const { organizationId, userId } = principal
  const owner = `EXISTS (SELECT 1 FROM member m WHERE m.organizationId = ? AND m.userId = ? AND ${OWNER_ROLE})`
  const ownerParams = [organizationId, userId]
  if (!await queryFirst(db, `SELECT 1 WHERE ${owner}`, ownerParams)) {
    throw new HTTPError({ statusCode: 403, message: 'Only a workspace owner can manage listing messaging access' })
  }
  const subject = await queryFirst<{ user_id: string }>(db, `SELECT m.userId AS user_id FROM product_stay_configs listing
    JOIN member m ON m.organizationId = listing.organization_id WHERE listing.organization_id = ? AND listing.product_id = ? AND m.id = ?`,
  [organizationId, input.listingId, input.memberId])
  if (!subject) throw new HTTPError({ statusCode: 404, message: 'The listing or workspace member was not found' })
  const guard = {
    query: `SELECT CASE WHEN ${owner}
      AND EXISTS (SELECT 1 FROM member WHERE id = ? AND organizationId = ? AND userId = ?)
      AND EXISTS (SELECT 1 FROM product_stay_configs WHERE product_id = ? AND organization_id = ?)
      THEN 1 ELSE json('LISTING_MESSAGING_ACCESS_CHANGED') END`,
    params: [...ownerParams, input.memberId, organizationId, subject.user_id, input.listingId, organizationId],
  }
  const grant = [organizationId, input.listingId, input.memberId]
  const selector: BatchQuery = { query: `${listingOfConversation} = ?`, params: [input.listingId] }
  await executeBatch(db, [guard, ...(input.allowed ? [{
    query: 'INSERT INTO listing_message_members (organization_id, listing_id, member_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    params: grant,
  }, ...reconcileGuestListingParticipants(organizationId, selector)] : [{
    query: "DELETE FROM conversation_participants WHERE organization_id = ? AND host_listing_id = ? AND user_id = ? AND role = 'member'",
    params: [organizationId, input.listingId, subject.user_id],
  }, {
    query: 'DELETE FROM listing_message_members WHERE organization_id = ? AND listing_id = ? AND member_id = ?',
    params: grant,
  }])], { operation: input.allowed ? 'Grant listing messaging access' : 'Revoke listing messaging access' })
  await publishAccessInvalidation(env, { organizationId })
  return { listing_id: input.listingId, member_id: input.memberId, allowed: input.allowed }
}

export async function createConversationGuestInvite(db: DbClient, principal: MemberAccessPrincipal, input: { conversationId: string; email: string }) {
  const email = input.email.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HTTPError({ statusCode: 422, message: 'A valid invite email is required' })
  const token = crypto.randomUUID() + crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const tokenHash = await hashIdentifier(token)
  const authority = participantGuard('c', principal.userId, 'member')
  const [result] = await executeBatch(db, [{
    query: `INSERT INTO conversation_guest_invites (id, organization_id, conversation_id, email, token_hash, inviter_id, expires_at)
      SELECT ?, c.organization_id, c.id, ?, ?, ?, ? FROM conversations c
      WHERE c.id = ? AND c.organization_id = ? AND c.kind = 'booking' AND c.booking_id IS NOT NULL AND c.blocked_at IS NULL AND ${authority.sql}`,
    params: [crypto.randomUUID(), email, tokenHash, principal.userId, expiresAt, input.conversationId, principal.organizationId, ...authority.params],
  }], { operation: 'Invite traveler to a conversation' })
  if (result?.meta.changes !== 1) throw new HTTPError({ statusCode: 404, message: 'Booking conversation not found' })
  return { token, expires_at: expiresAt, conversation_id: input.conversationId, organization_id: principal.organizationId }
}

export async function acceptConversationGuestInvite(db: DbClient, env: GuestInboxPublicationEnv, input: { token: string; user: { id: string; email: string; emailVerified: boolean; isAnonymous?: boolean | null } }) {
  if (!input.user.emailVerified || input.user.isAnonymous) throw new HTTPError({ statusCode: 403, message: 'Verify your email to join this conversation' })
  if (!/^[0-9a-f-]{72}$/i.test(input.token)) throw new HTTPError({ statusCode: 404, message: 'Conversation invitation not found' })
  const hash = await hashIdentifier(input.token)
  const now = new Date().toISOString()
  const userId = input.user.id
  // The token, verified email, sender's current seat and membership, and booking are checked inside the write.
  await executeBatch(db, [{
    query: `UPDATE conversation_guest_invites AS i SET accepted_at = ?, accepted_user_id = ?
      WHERE i.token_hash = ? AND i.expires_at > ? AND i.accepted_at IS NULL
        AND EXISTS (SELECT 1 FROM user u WHERE u.id = ? AND u.emailVerified = 1 AND u.isAnonymous IS NOT 1 AND lower(u.email) = i.email)
        AND EXISTS (SELECT 1 FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.role = 'member'
          JOIN member m ON m.organizationId = p.organization_id AND m.userId = p.user_id
          WHERE c.id = i.conversation_id AND c.organization_id = i.organization_id AND c.kind = 'booking' AND c.booking_id IS NOT NULL AND c.blocked_at IS NULL
            AND p.user_id = i.inviter_id)
        AND NOT EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = i.conversation_id AND p.user_id = ? AND p.role = 'member')`,
    params: [now, userId, hash, now, userId, userId],
  }, {
    query: `INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at)
      SELECT i.conversation_id, i.organization_id, i.accepted_user_id, 'guest', i.accepted_at FROM conversation_guest_invites i
      WHERE i.token_hash = ? AND i.accepted_at = ? AND i.accepted_user_id = ? AND changes() = 1
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'guest', last_read_message_id = NULL, archived_at = NULL
      WHERE conversation_participants.role IS NULL`,
    params: [hash, now, userId],
  }], { operation: 'Accept traveler conversation invitation' })
  const invite = await queryFirst<{ conversation_id: string; organization_id: string }>(db, `SELECT i.conversation_id, i.organization_id FROM conversation_guest_invites i
    JOIN conversation_participants p ON p.conversation_id = i.conversation_id AND p.organization_id = i.organization_id AND p.user_id = i.accepted_user_id AND p.role = 'guest'
    WHERE i.token_hash = ? AND i.accepted_user_id = ? AND i.accepted_at IS NOT NULL AND i.expires_at > ?`, [hash, userId, now])
  if (!invite) throw new HTTPError({ statusCode: 404, message: 'Conversation invitation not found' })
  await publishConversationEvent(env, db, { conversationId: invite.conversation_id, type: 'MESSAGE_UPDATE' })
  return invite
}

/** A host can revoke an invited traveler's access. The booking account has its own lifecycle. */
export async function removeConversationGuest(db: DbClient, env: GuestInboxPublicationEnv, input: { conversationId: string; organizationId: string; hostUserId: string; travelerUserId: string }) {
  const { conversationId, organizationId, hostUserId, travelerUserId } = input
  const authority = participantGuard('c', hostUserId, 'member')
  const target = `SELECT c.id FROM conversations c WHERE c.id = ? AND c.organization_id = ? AND c.kind = 'booking' AND c.booking_id IS NOT NULL
    AND c.user_id IS NOT ? AND ${authority.sql}
    AND EXISTS (SELECT 1 FROM conversation_guest_invites accepted WHERE accepted.conversation_id = c.id
      AND accepted.organization_id = c.organization_id AND accepted.accepted_user_id = ?)`
  const params = [conversationId, organizationId, travelerUserId, ...authority.params, travelerUserId]
  const now = new Date().toISOString()
  const [authorized] = await executeBatch(db, [{ query: target, params }, {
    query: `UPDATE conversation_guest_invites AS i SET expires_at = ?
      WHERE i.conversation_id IN (${target}) AND i.organization_id = ? AND i.expires_at > ?
      AND (i.email IN (SELECT accepted.email FROM conversation_guest_invites accepted WHERE accepted.conversation_id = i.conversation_id
        AND accepted.organization_id = i.organization_id AND accepted.accepted_user_id = ?)
        OR i.email = (SELECT lower(email) FROM user WHERE id = ? AND emailVerified = 1))`,
    params: [now, ...params, organizationId, now, travelerUserId, travelerUserId],
  }, {
    query: `DELETE FROM conversation_participants WHERE conversation_id IN (${target}) AND organization_id = ? AND user_id = ? AND role = 'guest'`,
    params: [...params, organizationId, travelerUserId],
  }], { operation: 'Remove traveler from a conversation' })
  if (!authorized?.results.length) conversationAccessDenied()
  try {
    await publishDashboardInvalidation(env, { type: 'CONVERSATION_LEAVE', conversation_id: conversationId, organization_id: organizationId,
      user_id: travelerUserId, event_id: crypto.randomUUID(), occurred_at: now })
    await publishConversationEvent(env, db, { conversationId, type: 'MESSAGE_UPDATE' })
  } catch (cause) {
    throw new HTTPError({ statusCode: 503, message: 'Traveler access ended, but open apps could not be told. Retry the same operation.',
      data: { code: 'DASHBOARD_PUBLICATION_FAILED', field: 'realtime', committed: true, conversation_id: conversationId }, cause })
  }
  return { removed: true as const }
}
