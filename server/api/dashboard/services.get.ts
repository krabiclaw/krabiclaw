import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { listServices } from '~/server/utils/organization-services'
import { readStrategy, strategyOffer } from '~/server/utils/strategy-service'

/** Payments → Plan → Services: the services the business is on. */
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['read'] } })
  const [agreements, strategy, offer] = await Promise.all([listServices(db, organization.id), readStrategy(env, db, organization.id), strategyOffer(env)])
  return jsonResponse({ success: true, services: { ...agreements, strategy }, strategy_offer: offer }, { headers: { 'cache-control': 'private, no-store' } })
})
