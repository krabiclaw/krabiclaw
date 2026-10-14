import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { execute } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertRoleAllows } from '~/server/utils/member-access'

// DELETE /api/organizations/:organizationId/invite-links/:linkId — withdraws a
// link nobody has used yet. A used link is history and stays.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const linkId = getRouterParam(event, 'linkId')
  if (!organizationId || !linkId) return jsonResponse({ error: 'Organization and link IDs are required' }, { status: 400 })
  const { db, organization } = await requireOrganizationMembership(event, organizationId)
  await assertRoleAllows({ organizationId, role: organization.member_role, permissions: { invitation: ['cancel'] }, message: 'You cannot cancel invitations for this organization' })

  const deleted = await execute(db, 'DELETE FROM organization_invite_links WHERE id = ? AND organization_id = ? AND used_at IS NULL', [linkId, organizationId])
  if (!deleted.meta.changes) return jsonResponse({ error: 'No unused invite link with that id in this organization' }, { status: 404 })
  return new Response(null, { status: 204 })
})
