import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import {
  buildStripeConnectOnboardingUrls,
  createStripeConnectOnboardingLink,
  ensureStripeConnectedAccount,
  organizationPaymentsLivemode,
  paymentsStripe,
} from '~/server/utils/stripe-connect'

export default defineHandler(async (event) => {
  requireFinancialBrowserOrigin(event)
  const { env, db, session, organization } = await getDashboardContext(event, {})
  // Connecting the merchant account requires an explicit financial integration grant.
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  if (!env.NUXT_PUBLIC_PLATFORM_DOMAIN) {
    throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe Connect is not configured' })
  }

  const userEmail = session.user.email
  if (typeof userEmail !== 'string' || !userEmail) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Your account needs an email address before Stripe onboarding' })
  }

  const livemode = organizationPaymentsLivemode(env, organization)
  const stripe = paymentsStripe(env, livemode)
  const body = await readBody(event) as { country?: unknown } | undefined
  const country = typeof body?.country === 'string' ? body.country : null
  try {
    const account = await ensureStripeConnectedAccount(db, stripe, {
      organizationId: organization.id,
      organizationName: organization.name,
      contactEmail: userEmail,
      livemode,
      country,
    })
    if (!account.stripeAccountId) throw new Error('Stripe connected account ID is missing after creation')
    const urls = buildStripeConnectOnboardingUrls(env.NUXT_PUBLIC_PLATFORM_DOMAIN, organization.slug)
    const onboardingUrl = await createStripeConnectOnboardingLink(stripe, {
      stripeAccountId: account.stripeAccountId,
      ...urls,
    })
    return jsonResponse({ success: true, account, onboardingUrl })
  } catch (error) {
    console.error('stripe_connect_onboarding_failed', {
      organizationId: organization.id,
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof HTTPError) throw error
    // Stripe decides what it supports; its own reason is what the owner sees.
    throw new HTTPError({ statusCode: 502, statusMessage: error instanceof stripe.errors.StripeError ? error.message : 'Stripe onboarding could not be started' })
  }
})
