import { jsonResponse } from '~/server/utils/api-response'
import { assertRoleAllows } from '~/server/utils/member-access'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { getOrganizationMembersData, getOrganizationTeamsData } from '~/server/utils/dashboard-members'

export default defineHandler(async (event) => {
  const { env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { members: ['read'] } })
  const [{ members, invitations }, teams] = await Promise.all([getOrganizationMembersData(env, organization.id), getOrganizationTeamsData(env, organization.id)])
  return jsonResponse({ members, invitations, teams })
})
import { defineHandler } from 'nitro';
