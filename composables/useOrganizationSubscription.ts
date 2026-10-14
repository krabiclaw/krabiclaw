import { authClient } from '~/lib/auth-client'
import { isKnownBillingPlan } from '~/shared/billing-model'

function checkoutReturnUrls(): { successUrl: string; cancelUrl: string; returnUrl: string } {
  const current = new URL(window.location.href)
  for (const key of ['success', 'canceled', 'plan']) current.searchParams.delete(key)

  const success = new URL(current)
  success.searchParams.set('success', 'true')
  const cancel = new URL(current)
  cancel.searchParams.set('canceled', 'true')
  return { successUrl: success.toString(), cancelUrl: cancel.toString(), returnUrl: current.toString() }
}

async function organizationSubscriptionId(
  dashboardApi: ReturnType<typeof useDashboardApi>,
  organizationId: string,
): Promise<{ id?: string; status?: string; plan: string; annual: boolean; locations: { used: number; covered: number } }> {
  // A business on Starter has no subscription row, so the id and status are
  // absent from the response rather than present and empty.
  type BillingStatusResponse = {
    success: true
    billing: {
      stripeSubscriptionId?: string
      subscriptionStatus?: string
      billingInterval?: 'month' | 'year'
      plan: string
      locations: { used: number; covered: number }
    }
  }
  const response = await dashboardApi<BillingStatusResponse>('/api/billing/status', {
    query: { organizationId },
    validate: (value): value is BillingStatusResponse => {
      if (typeof value !== 'object' || value === null || !('success' in value) || value.success !== true || !('billing' in value)) return false
      const billing = value.billing
      return typeof billing === 'object'
        && billing !== null
        && (!('stripeSubscriptionId' in billing) || billing.stripeSubscriptionId === undefined || typeof billing.stripeSubscriptionId === 'string')
        && (!('subscriptionStatus' in billing) || billing.subscriptionStatus === undefined || typeof billing.subscriptionStatus === 'string')
        && (!('billingInterval' in billing) || billing.billingInterval === undefined || billing.billingInterval === 'month' || billing.billingInterval === 'year')
        && 'plan' in billing
        && isKnownBillingPlan(billing.plan)
        && 'locations' in billing
        && isLocationCount(billing.locations)
    },
  })
  return {
    id: response.billing.stripeSubscriptionId,
    status: response.billing.subscriptionStatus,
    plan: response.billing.plan,
    annual: response.billing.billingInterval === 'year',
    locations: response.billing.locations,
  }
}

export function isLocationCount(value: unknown): value is { used: number; covered: number } {
  return typeof value === 'object' && value !== null
    && 'used' in value && Number.isSafeInteger(value.used)
    && 'covered' in value && Number.isSafeInteger(value.covered)
}

export const useOrganizationSubscription = () => {
  const dashboard = useDashboardOrganization()
  const dashboardApi = useDashboardApi()
  const { trackSubscriptionUpgrade, trackSubscriptionDowngrade } = useAnalytics()
  const { startSubscriptionCheckout, analyticsIntentError } = useSubscriptionCheckout()

  // Stripe's hosted portal: card, invoices, receipts, cancelling. The plugin
  // exposes nothing else for those, so nothing here draws them.
  async function openBillingPortal() {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    const { returnUrl } = checkoutReturnUrls()
    const portal = await authClient.subscription.billingPortal({
      referenceId: organizationId,
      customerType: 'organization',
      returnUrl,
      disableRedirect: true,
    })
    if (portal.error) throw new Error(portal.error.message ?? 'Unable to open billing portal')
    const portalUrl = portal.data && 'url' in portal.data ? portal.data.url : null
    if (!portalUrl) throw new Error('Missing billing portal URL')
    await navigateTo(portalUrl, { external: true })
  }

  // The organization owns one recurring subscription; its entitlements follow
  // once Better Auth confirms the subscription through Stripe.
  async function startOrganizationCheckout(organizationId: string, plan: string) {
    const subscription = await organizationSubscriptionId(dashboardApi, organizationId)
    if (subscription.status === 'past_due') {
      await openBillingPortal()
      return
    }
    const currentPlan = subscription.plan
    await startSubscriptionCheckout({
      organizationId,
      plan,
      currentPlan,
      subscriptionId: subscription.id,
      locations: Math.max(subscription.locations.used, subscription.locations.covered),
      onAction: action => {
        if (action === 'upgrade') trackSubscriptionUpgrade(plan, organizationId)
        if (action === 'downgrade' && plan !== 'free') trackSubscriptionDowngrade(plan, organizationId)
      },
    })
  }

  // The subscription's quantity is the locations it covers. Better Auth's
  // upgrade on the same plan sends it to Stripe's confirmation page, which shows
  // what changes on the bill before anything does.
  async function setPlanLocations(organizationId: string, locations: number) {
    const subscription = await organizationSubscriptionId(dashboardApi, organizationId)
    if (!subscription.id) throw new Error('Choose a plan before adding locations to it')
    if (subscription.status === 'past_due') {
      await openBillingPortal()
      return
    }
    const { returnUrl } = checkoutReturnUrls()
    const response = await authClient.subscription.upgrade({
      plan: subscription.plan,
      annual: subscription.annual,
      seats: locations,
      referenceId: organizationId,
      subscriptionId: subscription.id,
      customerType: 'organization',
      returnUrl,
      successUrl: returnUrl,
      cancelUrl: returnUrl,
      disableRedirect: true,
    })
    if (response.error) throw new Error(response.error.message ?? 'Your plan’s locations could not be changed')
    const confirmUrl = response.data && 'url' in response.data ? response.data.url : null
    if (!confirmUrl) throw new Error('Missing Stripe confirmation URL')
    await navigateTo(confirmUrl, { external: true })
  }

  // Forwarded so a checkout that went through with its billing analytics intent
  // unrecorded is visible to whatever renders this, rather than ending in a ref
  // nobody reads — which is the same silence in a newer place.
  return { startOrganizationCheckout, setPlanLocations, openBillingPortal, analyticsIntentError }
}
