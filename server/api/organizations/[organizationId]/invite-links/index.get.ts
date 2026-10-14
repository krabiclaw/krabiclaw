import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { queryAll } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertRoleAllows } from '~/server/utils/member-access'

// GET /api/organizations/:organizationId/invite-links — the links still waiting
// to be used. Tokens are not stored, so none is returned.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { db, organization } = await requireOrganizationMembership(event, organizationId)
  await assertRoleAllows({ organizationId, role: organization.member_role, permissions: { invitation: ['create'] }, message: 'You cannot manage invitations for this organization' })

  const inviteLinks = await queryAll<{ id: string; role: string; expiresAt: string; createdAt: string }>(db, `
    SELECT id, role, expires_at AS "expiresAt", created_at AS "createdAt" FROM organization_invite_links
    WHERE organization_id = ? AND used_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
  `, [organizationId, new Date().toISOString()])
  return jsonResponse({ inviteLinks })
})
