import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { resolveMembership } from '~/server/utils/member-access'

// Invite-link tokens are random, shown once, and stored only as their SHA-256.

export const INVITE_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const INVITE_LINK_ROLES = ['admin', 'member'] as const

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export function newInviteLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function inviteLinkTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function refuse(statusCode: number, code: string, message: string, extra: Record<string, string> = {}): never {
  throw new HTTPError({ statusCode, message, data: { code, field: 'token', ...extra } })
}

type InviteLinkRow = { id: string; organization_id: string; organization_name: string; role: string; expires_at: string; used_at: string | null }

/** A live link: an unknown or withdrawn one is 404, a used or expired one 410, each with its code. */
async function openInviteLink(db: DbClient, token: string): Promise<InviteLinkRow> {
  if (!TOKEN_PATTERN.test(token)) refuse(404, 'INVITE_LINK_NOT_FOUND', 'This invite link does not exist')
  const link = await queryFirst<InviteLinkRow>(db, `
    SELECT l.id, l.organization_id, o.name AS organization_name, l.role, l.expires_at, l.used_at
    FROM organization_invite_links l JOIN organization o ON o.id = l.organization_id
    WHERE l.token_hash = ?`, [await inviteLinkTokenHash(token)])
  if (!link) refuse(404, 'INVITE_LINK_NOT_FOUND', 'This invite link does not exist')
  if (link.used_at) refuse(410, 'INVITE_LINK_USED', 'This invite link has already been used')
  if (Date.parse(link.expires_at) <= Date.now()) refuse(410, 'INVITE_LINK_EXPIRED', 'This invite link has expired')
  return link
}

/**
 * What a link offers, for anyone holding it: the workspace's name, the role and
 * when it expires. It names nothing about the workspace's members.
 */
export async function describeInviteLink(db: DbClient, token: string): Promise<{ organization: { name: string }; role: string; expiresAt: string }> {
  const link = await openInviteLink(db, token)
  return { organization: { name: link.organization_name }, role: link.role, expiresAt: link.expires_at }
}

/**
 * The signed-in caller joins the link's organization with the link's role. The
 * link is claimed first so two people cannot both use it; if Better Auth then
 * refuses the member, the claim is released and its error returned.
 */
export async function acceptInviteLink(env: CloudflareEnv, token: string, userId: string): Promise<{ organization: { id: string; name: string }; role: string; memberId: string }> {
  const link = await openInviteLink(env.DB, token)
  if (await resolveMembership(env, { organizationId: link.organization_id, userId })) {
    refuse(409, 'ALREADY_MEMBER', 'You are already a member of this organization', { organizationId: link.organization_id })
  }

  const usedAt = new Date().toISOString()
  const claimed = await execute(env.DB, `
    UPDATE organization_invite_links SET used_at = ?, used_by_user_id = ?
    WHERE id = ? AND used_at IS NULL AND expires_at > ?
  `, [usedAt, userId, link.id, usedAt])
  if (!claimed.meta.changes) refuse(410, 'INVITE_LINK_USED', 'This invite link has already been used')

  try {
    const { createAuth } = await import('~/server/utils/auth')
    const member = await createAuth(env).api.addMember({
      body: { userId, organizationId: link.organization_id, role: link.role as typeof INVITE_LINK_ROLES[number] },
    })
    if (!member) throw new Error('Better Auth added no member for an accepted invite link')
    return { organization: { id: link.organization_id, name: link.organization_name }, role: member.role, memberId: member.id }
  } catch (cause) {
    await execute(env.DB, 'UPDATE organization_invite_links SET used_at = NULL, used_by_user_id = NULL WHERE id = ? AND used_at = ?', [link.id, usedAt])
    throw cause
  }
}
