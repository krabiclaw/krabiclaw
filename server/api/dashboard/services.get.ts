import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { listServices } from '~/server/utils/organization-services'

/** Payments → Plan → Services: the services the business is on. */
export default defineHandler(async (event) => {
  const { db, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['read'] } })
  return jsonResponse({ success: true, services: await listServices(db, organization.id) }, { headers: { 'cache-control': 'private, no-store' } })
})
