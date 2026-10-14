import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'

import { execute } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { INVITE_LINK_LIFETIME_MS, INVITE_LINK_ROLES, inviteLinkTokenHash, newInviteLinkToken } from '~/server/utils/invite-links'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertRoleAllows } from '~/server/utils/member-access'

// POST /api/organizations/:organizationId/invite-links {role} — a single-use
// link, valid seven days, that adds whoever accepts it with that role. Whoever
// may send an invitation may make a link, under the same permission.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const body = await readBody<{ role?: unknown }>(event)
  const role = body?.role
  if (!INVITE_LINK_ROLES.includes(role as typeof INVITE_LINK_ROLES[number])) {
    return jsonResponse({ error: `role must be one of: ${INVITE_LINK_ROLES.join(', ')}` }, { status: 400 })
  }

  const { db, session, organization } = await requireOrganizationMembership(event, organizationId)
  await assertRoleAllows({ organizationId, role: organization.member_role, permissions: { invitation: ['create'] }, message: 'You cannot invite members to this organization' })

  const token = newInviteLinkToken()
  const expiresAt = new Date(Date.now() + INVITE_LINK_LIFETIME_MS).toISOString()
  const id = crypto.randomUUID()
  await execute(db, `
    INSERT INTO organization_invite_links (id, organization_id, role, token_hash, inviter_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, organizationId, role, await inviteLinkTokenHash(token), session.user.id, expiresAt])

  return jsonResponse({ id, token, role, expiresAt }, { status: 201 })
})
