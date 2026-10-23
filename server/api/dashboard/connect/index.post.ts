import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { buildAppPayoutsOnboardingUrls, buildStripeConnectOnboardingUrls, startStripeConnectOnboarding } from '~/server/utils/stripe-connect'

// Stripe-hosted onboarding: { country?, returnTo?: "app" }. The dashboard returns to Payments; the iPhone app
// (returnTo "app") to /app/return/payouts, which hands back to krabiclaw://payouts/<outcome>.
export default defineHandler(async (event) => {
  requireFinancialBrowserOrAppRequest(event)
  const { env, db, session, organization } = await getDashboardContext(event, {})
  // Connecting the merchant account requires an explicit financial integration grant.
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  if (!env.NUXT_PUBLIC_PLATFORM_DOMAIN) {
    throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe Connect is not configured', data: { code: 'CONNECT_NOT_CONFIGURED' } })
  }

  const userEmail = session.user.email
  if (typeof userEmail !== 'string' || !userEmail) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Your account needs an email address before Stripe onboarding', data: { code: 'ACCOUNT_EMAIL_REQUIRED' } })
  }

  const body = await readBody(event) as { country?: unknown; returnTo?: unknown } | undefined
  if (body?.returnTo !== undefined && body.returnTo !== 'app') {
    throw new HTTPError({ statusCode: 422, statusMessage: 'returnTo must be "app" when given', data: { code: 'VALIDATION_ERROR', field: 'returnTo' } })
  }
  const { account, url } = await startStripeConnectOnboarding(db, env, {
    organization,
    contactEmail: userEmail,
    country: typeof body?.country === 'string' ? body.country : null,
    urls: body?.returnTo === 'app'
      ? buildAppPayoutsOnboardingUrls(env.NUXT_PUBLIC_PLATFORM_DOMAIN)
      : buildStripeConnectOnboardingUrls(env.NUXT_PUBLIC_PLATFORM_DOMAIN, organization.slug),
  })
  return jsonResponse({ success: true, account, onboardingUrl: url })
})
