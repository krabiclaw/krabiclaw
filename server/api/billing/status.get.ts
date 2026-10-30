import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { resolveRequestedOrganization } from '~/server/utils/dashboard-context'
import { getAuthSession } from '~/server/utils/auth'
import { assertRoleAllows } from '~/server/utils/member-access'
import { getOrganizationBillingStatus, getOrganizationSubscriptionPrice, hasBillingUpdatePermission, scheduledPlanChange } from '~/server/utils/billing'
import { billingPlanActions } from '~/shared/billing-model'

/** The same organization plan and permitted choices for the dashboard and native account screen. */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Billing storage is unavailable', data: { code: 'BILLING_UNAVAILABLE', field: 'database' } })
  const session = await getAuthSession(event, env)
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Sign in to read billing', data: { code: 'AUTHENTICATION_REQUIRED', field: 'session' } })
  const query = getQuery(event)
  if (query.organizationId !== undefined && (typeof query.organizationId !== 'string' || !query.organizationId.trim())) throw new HTTPError({ statusCode: 422, statusMessage: 'A valid organization ID is required', data: { code: 'INVALID_QUERY', field: 'organizationId' } })
  if (query.includePrice !== undefined && query.includePrice !== 'true' && query.includePrice !== 'false') throw new HTTPError({ statusCode: 422, statusMessage: 'includePrice must be true or false', data: { code: 'INVALID_QUERY', field: 'includePrice' } })
  const organization = await resolveRequestedOrganization(event, db, session.user.id, { explicitOrganizationId: typeof query.organizationId === 'string' ? query.organizationId : null })
  if (!organization) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a workspace to read billing', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['read'] } })
  try {
    const status = await getOrganizationBillingStatus(env, db, organization.id)
    const canUpdate = await hasBillingUpdatePermission(organization.id, organization.role)
    const [subscriptionPrice, scheduledPlan] = await Promise.all([
      getQuery(event).includePrice === 'true' ? getOrganizationSubscriptionPrice(env, status) : undefined,
      status.stripeScheduleId ? scheduledPlanChange(env, status.stripeScheduleId) : null,
    ])
    return jsonResponse({ success: true, billing: {
      ...status, subscriptionPrice, scheduledPlan, organizationId: organization.id,
      canUpdate, actions: billingPlanActions(status, scheduledPlan),
    }, userRole: organization.role }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (cause) {
    if (cause instanceof HTTPError) throw cause
    throw new HTTPError({ statusCode: 502, statusMessage: 'The current subscription could not be read',
      data: { code: 'BILLING_SUBSCRIPTION_UNAVAILABLE', field: 'billing.subscriptionPrice' }, cause })
  }
})
