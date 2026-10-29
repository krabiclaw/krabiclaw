import { defineHandler } from 'nitro'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { organizationPaymentsLivemode, paymentsStripe } from '~/server/utils/stripe-connect'

/**
 * The countries Stripe can create a connected account in, for the payout
 * setup's country choice. Stripe's country specs answer slowly (about 20 s
 * cold), so only the screen that asks for a country reads them.
 */
export default defineHandler(async (event) => {
  const { env, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const countries = (await paymentsStripe(env, organizationPaymentsLivemode(env, organization)).countrySpecs.list({ limit: 100 }).autoPagingToArray({ limit: 250 })).map(country => country.id)
  return jsonResponse({ success: true, countries })
})
