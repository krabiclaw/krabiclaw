import { defineHandler, HTTPError } from 'nitro'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { getStripeConnectedAccount, paymentsStripe, refreshStripeConnectedAccount } from '~/server/utils/stripe-connect'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardContext(event, {})
  // Connecting the organization's Stripe account is an integration change:
  // owner and admin, per utils/organization-access.ts.
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const connected = await getStripeConnectedAccount(db, organization.id)
  if (!connected?.stripeAccountId) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe onboarding has not started', data: { code: 'CONNECT_NOT_STARTED' } })
  }
  try {
    const account = await refreshStripeConnectedAccount(db, paymentsStripe(env, connected.livemode), connected)
    return jsonResponse({ success: true, account })
  } catch (error) {
    console.error('stripe_connect_status_refresh_failed', {
      organizationId: organization.id,
      stripeAccountId: connected.stripeAccountId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe account status could not be refreshed', data: { code: 'STRIPE_STATUS_FAILED' } })
  }
})
