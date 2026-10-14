import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { execute, queryFirst } from '~/server/db'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth, getAuthSession } from '~/server/utils/auth'
import { inviteLinkTokenHash } from '~/server/utils/invite-links'
import { resolveMembership } from '~/server/utils/member-access'

// POST /api/invite-links/:token/accept — the signed-in caller joins the link's
// organization with the link's role. The link is claimed first so two people
// cannot both use it; if Better Auth then refuses the member, the claim is
// released and its error returned.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) return jsonResponse({ error: 'Authentication required' }, { status: 401 })
  const token = getRouterParam(event, 'token')
  if (!token) return jsonResponse({ error: 'Invite link token is required' }, { status: 400 })

  const link = await queryFirst<{ id: string; organization_id: string; role: string; expires_at: string; used_at: string | null }>(env.DB,
    'SELECT id, organization_id, role, expires_at, used_at FROM organization_invite_links WHERE token_hash = ?',
    [await inviteLinkTokenHash(token)])
  if (!link) return jsonResponse({ error: 'This invite link does not exist' }, { status: 404 })
  if (link.used_at) return jsonResponse({ error: 'This invite link has already been used', code: 'INVITE_LINK_USED' }, { status: 410 })
  if (Date.parse(link.expires_at) <= Date.now()) return jsonResponse({ error: 'This invite link has expired', code: 'INVITE_LINK_EXPIRED' }, { status: 410 })
  if (await resolveMembership(env, { organizationId: link.organization_id, userId: session.user.id })) {
    return jsonResponse({ error: 'You are already a member of this organization', code: 'ALREADY_MEMBER', organizationId: link.organization_id }, { status: 409 })
  }

  const usedAt = new Date().toISOString()
  const claimed = await execute(env.DB, `
    UPDATE organization_invite_links SET used_at = ?, used_by_user_id = ?
    WHERE id = ? AND used_at IS NULL AND expires_at > ?
  `, [usedAt, session.user.id, link.id, usedAt])
  if (!claimed.meta.changes) return jsonResponse({ error: 'This invite link has already been used', code: 'INVITE_LINK_USED' }, { status: 410 })

  try {
    const member = await createAuth(env).api.addMember({
      body: { userId: session.user.id, organizationId: link.organization_id, role: link.role as 'admin' | 'member' },
    })
    return jsonResponse({ organizationId: link.organization_id, member: { id: member?.id, role: member?.role } })
  } catch (cause) {
    await execute(env.DB, 'UPDATE organization_invite_links SET used_at = NULL, used_by_user_id = NULL WHERE id = ? AND used_at = ?', [link.id, usedAt])
    throw cause
  }
})
