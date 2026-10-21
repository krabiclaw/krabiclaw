import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { listServices, managedAdsRequirements } from '~/server/utils/organization-services'
import { readStrategy } from '~/server/utils/strategy-service'

/**
 * Plan and billing's services: the ones the business is on, and, for the
 * Managed ads leaf (`?requirements=managed_ads`), what agreeing to it needs.
 */
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['read'] } })
  const withRequirements = getQuery(event).requirements === 'managed_ads'
  const [agreements, strategy, requirements] = await Promise.all([
    listServices(db, organization.id),
    readStrategy(env, db, organization.id),
    withRequirements ? managedAdsRequirements(db, env, organization.id) : null,
  ])
  return jsonResponse({ success: true, services: { ...agreements, strategy }, ...(requirements ? { requirements: { managed_ads: requirements } } : {}) }, { headers: { 'cache-control': 'private, no-store' } })
})
