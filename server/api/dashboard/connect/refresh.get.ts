import { defineHandler, HTTPError } from 'nitro'
import { sendRedirect } from 'nitro/h3'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import {
  buildStripeConnectOnboardingUrls,
  createStripeConnectOnboardingLink,
  getStripeConnectedAccount,
  paymentsStripe,
} from '~/server/utils/stripe-connect'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardContext(event, {})
  // Connecting the organization's Stripe account is an integration change:
  // owner and admin, per utils/organization-access.ts.
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  if (!env.NUXT_PUBLIC_PLATFORM_DOMAIN) {
    throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe Connect is not configured' })
  }
  const account = await getStripeConnectedAccount(db, organization.id)
  if (!account?.stripeAccountId) throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe onboarding has not started' })
  const onboardingUrl = await createStripeConnectOnboardingLink(
    paymentsStripe(env, account.livemode),
    { stripeAccountId: account.stripeAccountId, ...buildStripeConnectOnboardingUrls(env.NUXT_PUBLIC_PLATFORM_DOMAIN, organization.slug) },
  )
  return sendRedirect(event, onboardingUrl, 303)
})
