import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import { inviteLinkTokenHash, newInviteLinkToken } from '~/server/utils/invite-links'
import { platformOrigin, type DashboardNotificationLinkEnv } from '~/server/utils/dashboard-notification-links'

/**
 * A host hands one guest conversation to its guest with a link they share
 * themselves. The guest opens it on the platform, where guest accounts live,
 * signs in (or continues without an account) and the conversation becomes that
 * account's: `requests.user_id` and its stay's `user_id`, the same columns every
 * other guest-account link moves. Only the token's SHA-256 is stored, and the
 * link carries nothing about the guest.
 */
export const GUEST_INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

function refuse(statusCode: number, code: string, field: string, message: string): never {
  throw new HTTPError({ statusCode, message, data: { code, field } })
}

/** The page a guest opens, and the path the claim lands on afterwards. */
export function guestInvitePath(token: string): string {
  return `/guest-invite/${encodeURIComponent(token)}`
}

export function guestAccountThreadPath(threadId: string): string {
  return `/dashboard/account/messages/${encodeURIComponent(threadId)}`
}

type InviteTarget = {
  request_id: string
  kind: string
  user_id: string | null
  holder_anonymous: number | null
  stay_owner: string | null
}

/**
 * Only a stay the host keeps in the app is handed over this way; a channel stay
 * is answered through its channel. A conversation that already belongs to a
 * named account is that guest's and is not handed to anyone else; one held by
 * an anonymous identity (a guest who continued without an account) may be.
 */
function assertInvitable(target: InviteTarget, claimer?: string): void {
  if (target.kind !== 'stay' || target.stay_owner !== 'app') {
    refuse(409, 'GUEST_INVITE_UNSUPPORTED', 'request_id', 'Only a stay kept in KrabiClaw can invite its guest to the conversation')
  }
  if (target.user_id !== null && target.user_id !== claimer && target.holder_anonymous !== 1) {
    refuse(409, 'GUEST_THREAD_ALREADY_CLAIMED', 'request_id', 'This conversation already belongs to a guest account')
  }
}

/** No named account holds the conversation `r`. */
const UNHELD_SQL = '(r.user_id IS NULL OR EXISTS (SELECT 1 FROM user u WHERE u.id = r.user_id AND u."isAnonymous" = 1))'

const TARGET_SQL = `SELECT r.id AS request_id, r.kind, r.user_id, u."isAnonymous" AS holder_anonymous, st.owner AS stay_owner
  FROM requests r
  LEFT JOIN user u ON u.id = r.user_id
  LEFT JOIN stays st ON st.request_id = r.id AND st.organization_id = r.organization_id`

/** A new single-use link for one conversation; any earlier unused link for it stops working. */
export async function createGuestThreadInvite(
  db: DbClient,
  env: DashboardNotificationLinkEnv,
  input: { organizationId: string; threadId: string; actorUserId: string },
): Promise<{ url: string; expires_at: string }> {
  const target = await queryFirst<InviteTarget>(db, `${TARGET_SQL} WHERE r.id = ? AND r.organization_id = ?`, [input.threadId, input.organizationId])
  if (!target) refuse(404, 'THREAD_NOT_FOUND', 'request_id', 'Conversation not found')
  assertInvitable(target)

  const token = newInviteLinkToken()
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + GUEST_INVITE_LIFETIME_MS).toISOString()
  const id = crypto.randomUUID()
  // The guard repeats the checks above so a conversation claimed meanwhile gets no link.
  const [, inserted] = await executeBatch(db, [
    {
      query: `UPDATE guest_thread_invites SET revoked_at = ? WHERE request_id = ? AND claimed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM requests r WHERE r.id = guest_thread_invites.request_id AND ${UNHELD_SQL})`,
      params: [createdAt, target.request_id],
    },
    {
      query: `INSERT INTO guest_thread_invites (id, request_id, token_hash, created_by_user_id, expires_at, created_at)
        SELECT ?, r.id, ?, ?, ?, ? FROM requests r WHERE r.id = ? AND r.organization_id = ? AND ${UNHELD_SQL}`,
      params: [id, await inviteLinkTokenHash(token), input.actorUserId, expiresAt, createdAt, target.request_id, input.organizationId],
    },
  ], { operation: 'guest thread invite' })
  if ((inserted?.meta?.changes ?? 0) !== 1) refuse(409, 'GUEST_THREAD_ALREADY_CLAIMED', 'request_id', 'This conversation already belongs to a guest account')
  return { url: `${platformOrigin(env)}${guestInvitePath(token)}`, expires_at: expiresAt }
}

type InviteRow = InviteTarget & {
  id: string
  expires_at: string
  claimed_at: string | null
  claimed_user_id: string | null
  revoked_at: string | null
  organization_id: string
  organization_name: string
  location_title: string | null
}

async function loadInvite(db: DbClient, token: string): Promise<InviteRow> {
  if (!TOKEN_PATTERN.test(token)) refuse(404, 'GUEST_INVITE_NOT_FOUND', 'token', 'This invite link does not exist')
  const invite = await queryFirst<InviteRow>(db, `
    SELECT i.id, i.expires_at, i.claimed_at, i.claimed_user_id, i.revoked_at,
      r.id AS request_id, r.kind, r.user_id, r.organization_id, u."isAnonymous" AS holder_anonymous, st.owner AS stay_owner,
      o.name AS organization_name, l.title AS location_title
    FROM guest_thread_invites i
    JOIN requests r ON r.id = i.request_id
    JOIN organization o ON o.id = r.organization_id
    LEFT JOIN business_locations l ON l.id = r.location_id AND l.organization_id = r.organization_id
    LEFT JOIN user u ON u.id = r.user_id
    LEFT JOIN stays st ON st.request_id = r.id AND st.organization_id = r.organization_id
    WHERE i.token_hash = ?`, [await inviteLinkTokenHash(token)])
  if (!invite) refuse(404, 'GUEST_INVITE_NOT_FOUND', 'token', 'This invite link does not exist')
  return invite
}

/** Refuses a link that can no longer be claimed, saying which way it ended. */
function assertOpen(invite: InviteRow, now: string): void {
  if (invite.claimed_at !== null) refuse(410, 'GUEST_INVITE_USED', 'token', 'This invite link has already been used')
  if (invite.revoked_at !== null) refuse(410, 'GUEST_INVITE_REVOKED', 'token', 'This invite link was replaced by a newer one')
  if (invite.expires_at <= now) refuse(410, 'GUEST_INVITE_EXPIRED', 'token', 'This invite link has expired')
}

/**
 * What an open link offers, for the page that asks the guest to sign in. It
 * answers anyone holding the token, so it names the business and the home and
 * nothing about the guest. The account that already holds the conversation
 * (an anonymous guest who has since signed in) may still open it.
 */
export async function describeGuestThreadInvite(db: DbClient, token: string, viewerUserId?: string): Promise<{ organization_name: string; location_title: string | null; expires_at: string }> {
  const invite = await loadInvite(db, token)
  assertOpen(invite, new Date().toISOString())
  assertInvitable(invite, viewerUserId)
  return { organization_name: invite.organization_name, location_title: invite.location_title, expires_at: invite.expires_at }
}

/**
 * The signed-in (or anonymous) user takes the conversation the link names. The
 * link is spent, its conversation and stay become the user's, and any other open
 * link for it stops working, in one batch. Opening a spent link again as the
 * user who spent it lands on the same conversation.
 */
export async function claimGuestThreadInvite(db: DbClient, input: { token: string; userId: string }): Promise<{ thread_id: string; path: string }> {
  const invite = await loadInvite(db, input.token)
  const landed = async () => {
    const held = await queryFirst(db, 'SELECT id FROM requests WHERE id = ? AND user_id = ?', [invite.request_id, input.userId])
    if (!held) refuse(409, 'GUEST_THREAD_ALREADY_CLAIMED', 'request_id', 'This conversation already belongs to a guest account')
    return { thread_id: invite.request_id, path: guestAccountThreadPath(invite.request_id) }
  }
  if (invite.claimed_at !== null && invite.claimed_user_id === input.userId) return await landed()
  const now = new Date().toISOString()
  assertOpen(invite, now)
  assertInvitable(invite, input.userId)

  const spent = 'EXISTS (SELECT 1 FROM guest_thread_invites WHERE id = ? AND claimed_user_id = ? AND claimed_at = ?)'
  const [claimed] = await executeBatch(db, [
    {
      query: `UPDATE guest_thread_invites SET claimed_at = ?, claimed_user_id = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM requests r WHERE r.id = guest_thread_invites.request_id AND (r.user_id = ? OR ${UNHELD_SQL}))`,
      params: [now, input.userId, invite.id, now, input.userId],
    },
    { query: `UPDATE requests SET user_id = ? WHERE id = ? AND ${spent}`, params: [input.userId, invite.request_id, invite.id, input.userId, now] },
    { query: `UPDATE stays SET user_id = ? WHERE request_id = ? AND organization_id = ? AND ${spent}`, params: [input.userId, invite.request_id, invite.organization_id, invite.id, input.userId, now] },
    {
      query: `UPDATE guest_thread_invites SET revoked_at = ? WHERE request_id = ? AND id <> ? AND claimed_at IS NULL AND revoked_at IS NULL AND ${spent}`,
      params: [now, invite.request_id, invite.id, invite.id, input.userId, now],
    },
  ], { operation: 'guest thread invite claim' })
  if ((claimed?.meta?.changes ?? 0) === 1) return await landed()

  // Another claim or a newer link changed it between the read and the batch.
  const current = await loadInvite(db, input.token)
  if (current.claimed_at !== null && current.claimed_user_id === input.userId) return await landed()
  assertOpen(current, new Date().toISOString())
  assertInvitable(current, input.userId)
  throw new Error('Guest invite claim changed nothing for an open, claimable link')
}
