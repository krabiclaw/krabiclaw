import { jsonResponse } from '~/server/utils/api-response'
import { assertRoleAllows } from '~/server/utils/member-access'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { getOrganizationMembersData } from '~/server/utils/dashboard-members'

export default defineHandler(async (event) => {
  const { env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { members: ['read'] } })
  const { members, invitations } = await getOrganizationMembersData(env, organization.id)
  return jsonResponse({ members, invitations })
})
import { defineHandler } from 'nitro';
