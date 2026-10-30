import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { listServices, managedAdsRequirements } from '~/server/utils/organization-services'
import { readStrategy } from '~/server/utils/strategy-service'
import { getOrganizationBillingStatus } from '~/server/utils/billing'
import { SERVICES as offers } from '~/shared/billing-model'

/**
 * Plan and billing's services: the ones the business is on, and, for the
 * Managed ads leaf (`?requirements=managed_ads`), what agreeing to it needs.
 */
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['read'] } })
  try {
  const requested = getQuery(event).requirements
  if (requested !== undefined && requested !== 'managed_ads' && requested !== 'strategy') throw new HTTPError({ statusCode: 422, statusMessage: 'Unknown service requirements', data: { code: 'INVALID_QUERY', field: 'requirements' } })
  const [agreements, strategy, requirements] = await Promise.all([
    listServices(db, organization.id),
    readStrategy(env, db, organization.id),
    requested === 'managed_ads' ? managedAdsRequirements(db, env, organization.id) : null,
  ])
  const billing = requested === 'strategy' ? await getOrganizationBillingStatus(env, db, organization.id) : null
  return jsonResponse({ success: true, services: { ...agreements, strategy }, offers,
    ...(requirements ? { requirements: { managed_ads: requirements } } : {}),
    ...(billing ? { requirements: { strategy: { paid_plan: !!billing.stripeSubscriptionId && ['active', 'trialing'].includes(billing.subscriptionStatus ?? '') } } } : {}),
  }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (cause) {
    if (cause instanceof HTTPError) throw cause
    throw new HTTPError({ statusCode: 502, statusMessage: 'Service status could not be read', data: { code: 'SERVICE_STATUS_UNAVAILABLE', field: 'services' }, cause })
  }
})
