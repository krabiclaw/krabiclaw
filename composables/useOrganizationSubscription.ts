import { authClient } from '~/lib/auth-client'
import { isBillingResponse, type BillingStatus } from '~/composables/usePaymentsSettings'

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
): Promise<{ id?: string; status?: string; plan: string; canUpdate: boolean; actions: BillingStatus['actions'] }> {
  const response = await dashboardApi('/api/billing/status', { query: { organizationId }, validate: isBillingResponse })
  return { id: response.billing.stripeSubscriptionId, status: response.billing.subscriptionStatus, plan: response.billing.plan, canUpdate: response.billing.canUpdate, actions: response.billing.actions }
}

export const useOrganizationSubscription = () => {
  const dashboard = useDashboardOrganization()
  const dashboardApi = useDashboardApi()
  const { trackSubscriptionUpgrade, trackSubscriptionDowngrade } = useAnalytics()
  const { startSubscriptionCheckout } = useSubscriptionCheckout()

  // Stripe's hosted portal: card, invoices, receipts, cancelling. The plugin
  // exposes nothing else for those, so nothing here draws them.
  function organizationSlug() {
    const slug = dashboard.organization.value?.slug
    if (!slug) throw new Error('Organization context is unavailable')
    return slug
  }

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
    if (!subscription.canUpdate || !subscription.actions.changes.some(change => change.plan === plan)) throw new Error('This plan change is no longer available. Review Plan and billing before approving another change.')
    const currentPlan = subscription.plan
    // Better Auth swaps the plan price and adds or removes the plans' metered
    // items in one change; what they bill is charged at the end of the period.
    await startSubscriptionCheckout({
      organizationId,
      plan,
      currentPlan,
      subscriptionId: subscription.id,
      // The leaf that started the change may no longer apply once it is made, so the owner returns to the plan.
      returnPath: `/dashboard/${encodeURIComponent(organizationSlug())}/billing`,
      onAction: action => {
        if (action === 'upgrade') trackSubscriptionUpgrade(plan, organizationId)
        if (action === 'downgrade' && plan !== 'free') trackSubscriptionDowngrade(plan, organizationId)
      },
    })
  }

  return { startOrganizationCheckout, openBillingPortal }
}
