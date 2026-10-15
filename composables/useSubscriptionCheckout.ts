import { authClient } from '~/lib/auth-client'
import { buildStripeSubscriptionMetadata, classifyStripePlanChange, type StripeGa4IntentAction } from '~/shared/stripe-ga4'
import { assertNewSalePlan, normalizeBillingPlanId, STARTER_PLAN_ID } from '~/shared/billing-model'

interface SubscriptionCheckoutInput {
  organizationId: string
  plan: string
  currentPlan: string
  subscriptionId?: string | null
  annual?: boolean
  /** Locations the subscription is billed for: its Stripe quantity, carried through every plan change. */
  locations: number
  previousPriceId?: string | null
  newPriceId?: string | null
  onAction?: (_action: StripeGa4IntentAction) => void
}

function checkoutReturnUrls(plan: string): { successUrl: string; cancelUrl: string; returnUrl: string } {
  const current = new URL(window.location.href)
  for (const key of ['success', 'canceled', 'plan']) current.searchParams.delete(key)

  const success = new URL(current)
  success.searchParams.set('success', 'true')
  success.searchParams.set('plan', plan)
  const cancel = new URL(current)
  cancel.searchParams.set('canceled', 'true')
  return { successUrl: success.toString(), cancelUrl: cancel.toString(), returnUrl: current.toString() }
}

export function useSubscriptionCheckout() {
  const dashboardApi = useDashboardApi()
  const { getBillingAnalyticsContext } = useAnalytics()

  async function startSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<StripeGa4IntentAction> {
    // Validate the requested plan before touching analytics, browser state, or
    // Better Auth. Retired historical plans remain valid for reconciliation but
    // must never be sent to a new checkout provider call.
    const normalizedPlan = normalizeBillingPlanId(input.plan)
    const plan = normalizedPlan === STARTER_PLAN_ID
      ? STARTER_PLAN_ID
      : assertNewSalePlan(normalizedPlan)
    const { successUrl, cancelUrl, returnUrl } = checkoutReturnUrls(plan)
    const action = classifyStripePlanChange(input.currentPlan, plan, Boolean(input.subscriptionId))
    if (!action) throw new Error('The selected plan is already active')
    input.onAction?.(action)

    const analyticsContext = getBillingAnalyticsContext()
    await recordBillingAnalyticsIntent(dashboardApi, {
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId ?? null,
      action,
      ...analyticsContext,
      previousPriceId: input.previousPriceId ?? null,
      newPriceId: input.newPriceId ?? null,
      effectiveTiming: action === 'downgrade' ? 'period_end' : 'immediate',
    })

    // Checkout runs from a click, not a render, so the session is read the
    // imperative way Better Auth provides for exactly that.
    const currentUser = (await authClient.getSession()).data?.user
    const metadata = {
      organization_id: input.organizationId,
      ...buildStripeSubscriptionMetadata(
        action,
        analyticsContext,
        currentUser?.id,
        input.previousPriceId,
        input.newPriceId,
      ),
    }

    if (action === 'downgrade' && plan === STARTER_PLAN_ID) {
      if (!input.subscriptionId) throw new Error('No active subscription to cancel')
      const cancelResponse = await authClient.subscription.cancel({
        referenceId: input.organizationId,
        subscriptionId: input.subscriptionId,
        customerType: 'organization',
        returnUrl,
        disableRedirect: true,
      })
      if (cancelResponse.error) throw new Error(cancelResponse.error.message ?? 'Unable to open cancellation flow')
      const portalUrl = cancelResponse.data && 'url' in cancelResponse.data ? cancelResponse.data.url : null
      if (!portalUrl) throw new Error('Missing billing cancellation URL')
      await navigateTo(portalUrl, { external: true })
      return action
    }

    const response = await authClient.subscription.upgrade({
      plan,
      annual: input.annual ?? false,
      seats: input.locations,
      referenceId: input.organizationId,
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      customerType: 'organization',
      metadata,
      ...(action === 'downgrade' ? { scheduleAtPeriodEnd: true } : {}),
      successUrl,
      cancelUrl,
      returnUrl,
      disableRedirect: true,
    })
    if (response.error) throw new Error(response.error.message ?? 'Unable to start subscription checkout')
    const checkoutUrl = response.data && 'url' in response.data ? response.data.url : null
    if (!checkoutUrl) throw new Error('Missing checkout URL from Better Auth Stripe')
    await navigateTo(checkoutUrl, { external: true })
    return action
  }

  return { startSubscriptionCheckout }
}
