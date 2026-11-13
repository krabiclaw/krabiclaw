import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { getOrganizationMembersData } from '~/server/utils/dashboard-members'

export default defineHandler(async (event) => {
  const { env, organization, userId } = await getDashboardMemberContext(event, {})
  return jsonResponse(await getOrganizationMembersData(env, organization, userId))
})
