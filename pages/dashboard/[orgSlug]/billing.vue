<template>
  <!--
    Plan and billing: money the organization pays KrabiClaw, apart from the
    money it takes in (Earnings → Payments). Airbnb's host tools have no plan,
    so this is the smallest honest index: the plan, the way up, the services
    sold beside it, Stripe's own portal for cards and invoices, and Cancel.
    Each row opens one leaf beside this column; the plan opens on arrival.
  -->
  <DashboardIndexPanel id="organization-billing" title="Plan and billing" :auto-open="`${level.path.value}/plan`">
    <div class="pb-10">
      <p v-if="!dashboard.canUpdateBilling.value && owner" class="mb-6 text-base text-muted" data-testid="billing-owner-line">{{ owner }} is the owner and changes the plan and billing.</p>
      <UAlert v-if="billingError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(billingError, 'Failed to load billing')" />
      <UAlert v-if="servicesError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(servicesError, 'Services could not be loaded')" />
      <UAlert v-if="methodsError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(methodsError, 'Payment methods could not be loaded')" />
      <UAlert v-if="ownerError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(ownerError, 'The owner could not be loaded')" />
      <UAlert v-if="errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
      <UAlert v-if="successMessage" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="successMessage" />
      <EditorNavigationList :groups="groups" :active-item="level.child.value" @act="onRowAction">
        <!-- A service states whether it is on before what it costs. -->
        <template #summary="{ item }">
          <UBadge v-if="serviceState[item.id]" :label="serviceState[item.id]!.on ? 'On' : 'Off'" :color="serviceState[item.id]!.on ? 'success' : 'neutral'" :variant="serviceState[item.id]!.on ? 'solid' : 'soft'" size="lg" class="me-2 align-middle" />{{ item.summary }}
        </template>
      </EditorNavigationList>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, PAID_PLAN_PRICES, SERVICE_PRICES, SERVICES, STARTER_PLAN_ID, isNewSalePlan } from '~/shared/billing-model'
import { cardBrandLabel, useOrganizationBilling, useOrganizationServices, usePaymentMethods } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Plan and billing | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const { trackSubscriptionCheckoutSuccess } = useAnalytics()
const { startOrganizationCheckout, openBillingPortal } = useOrganizationSubscription()
const { formatExactDateTime } = useHumanTime()
const { plans, formatRecurring } = await usePlans()

const [{ billing, billingError }, { services, servicesError }, { methods, methodsError }] = await Promise.all([
  useOrganizationBilling(), useOrganizationServices(), usePaymentMethods(),
])

// Admins read billing and do not change it; the line names who does.
const { data: owner, error: ownerError } = await useAsyncData(`billing-owner:${String(route.params.orgSlug)}`, async () => {
  if (dashboard.canUpdateBilling.value) return null
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  const listed = await authClient.organization.listMembers({ query: { organizationId, filterField: 'role', filterOperator: 'eq', filterValue: 'owner' } })
  if (listed.error) throw new Error(listed.error.message ?? 'The owner could not be loaded')
  const found = listed.data?.members[0]
  if (!found) throw new Error('This organization has no owner')
  return found.user.name || found.user.email
})

const errorMessage = ref('')
const successMessage = ref('')
const busy = ref(false)
const to = (leaf: string) => `${level.path.value}/${leaf}`
const monthly = (cents: number) => formatRecurring(cents, 'USD')

const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id
const scheduledPlan = computed(() => billing.value?.scheduledPlan ?? null)

// "Growth · $49/mo · Renews Nov 17, 2026": the plan, Stripe's amount and interval, then what happens next.
const planSummary = computed(() => {
  const status = billing.value
  if (!status) return ''
  if (onStarter.value) return `${planName(status.plan)} · Free`
  const price = status.subscriptionPrice
  const parts = [price?.name ?? planName(status.plan)]
  if (price) parts.push(formatRecurring(price.amount, price.currency, price.interval))
  if (status.subscriptionStatus === 'past_due') parts.push('Payment past due')
  else if (scheduledPlan.value) parts.push(`Changes to ${planName(scheduledPlan.value.plan)} on ${formatExactDateTime(scheduledPlan.value.at)}`)
  else if (status.currentPeriodEnd) parts.push(`${status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatExactDateTime(status.currentPeriodEnd)}`)
  return parts.join(' · ')
})

const upgradeRow = computed<EditorNavigationItem | null>(() => {
  const status = billing.value
  if (!status || status.plan === BUSINESS_PLAN_ID || status.cancelAtPeriodEnd || scheduledPlan.value) return null
  if (onStarter.value) return { id: 'upgrade', label: 'Choose a plan', summary: `Growth ${monthly(PAID_PLAN_PRICES[GROWTH_PLAN_ID].monthly)} or Business ${monthly(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly)}`, to: to('upgrade') }
  return { id: 'upgrade', label: 'Upgrade to Business', summary: `${monthly(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly)} · online payments, direct stay booking, Google Ads`, to: to('upgrade') }
})

const serviceRows = computed<EditorNavigationItem[]>(() => {
  const current = services.value
  if (!current) return []
  return [
    { id: 'managed-ads', label: SERVICES.managed_ads.name, to: to('managed-ads'),
      summary: `${current.managed_ads ? `since ${formatExactDateTime(current.managed_ads.agreed_at)} · ` : ''}${SERVICES.managed_ads.price}` },
    { id: 'strategy', label: SERVICES.strategy.name, to: to('strategy'),
      summary: current.strategy
        ? `since ${formatExactDateTime(current.strategy.since)} · ${formatRecurring(current.strategy.amount, current.strategy.currency, current.strategy.interval)}`
        : monthly(SERVICE_PRICES.strategy.monthly) },
  ]
})
const serviceState = computed<Record<string, { on: boolean } | undefined>>(() => services.value
  ? { 'managed-ads': { on: !!services.value.managed_ads }, 'strategy': { on: !!services.value.strategy } }
  : {})

// Stripe's portal owns cards, invoices and receipts; the row names the default card and opens it.
const portalRow = computed<EditorNavigationItem | null>(() => {
  if (!billing.value?.stripeCustomerId) return null
  const cards = methods.value?.payment_methods ?? []
  const main = cards.find(card => card.default) ?? cards[0]
  return {
    id: 'portal', label: 'Payment method and invoices',
    summary: main ? `${cardBrandLabel(main.brand)} •••• ${main.last4}` : 'No payment method saved',
    ...(dashboard.canUpdateBilling.value ? { action: { label: 'Open' } } : {}),
  }
})

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'billing',
  items: [
    ...(billing.value ? [{ id: 'plan', label: 'Plan', summary: planSummary.value, to: to('plan') }] : []),
    ...(upgradeRow.value ? [upgradeRow.value] : []),
    ...serviceRows.value,
    ...(portalRow.value ? [portalRow.value] : []),
    ...(billing.value && !onStarter.value && !billing.value.cancelAtPeriodEnd && !scheduledPlan.value ? [{ id: 'cancel', label: 'Cancel plan', summary: 'If you cancel, you keep full access to your plan features until the end of your billing period.', to: to('cancel') }] : []),
  ],
}])

async function onRowAction(id: string) {
  if (busy.value || id !== 'portal') return
  busy.value = true
  errorMessage.value = ''
  try {
    await openBillingPortal()
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Stripe’s billing portal could not be opened')
  } finally {
    busy.value = false
  }
}

// Stripe sends the owner back to the leaf they left with success or canceled;
// /api/post-login?plan=… arrives here with the plan still to buy.
onMounted(async () => {
  const { success, plan, canceled, ...restQuery } = route.query
  if (success === 'true') {
    const id = dashboard.organization.value?.id
    if (id) trackSubscriptionCheckoutSuccess(id, typeof plan === 'string' ? plan : undefined)
    successMessage.value = typeof plan === 'string' && billing.value?.plan === plan
      ? 'Payment confirmed. Your plan has been updated.'
      : 'Payment is processing. Your plan will activate after Stripe confirms the subscription.'
  }
  if (canceled === 'true') errorMessage.value = 'Payment was canceled. Your plan was not changed.'
  if (success || plan || canceled) await router.replace({ query: restQuery })
  if (success || canceled) return
  const planId = Array.isArray(plan) ? plan[0] : plan
  if (typeof planId === 'string' && isNewSalePlan(planId) && !busy.value) {
    busy.value = true
    try {
      const organizationId = dashboard.organization.value?.id
      if (!organizationId) throw new Error('Organization context is unavailable')
      await startOrganizationCheckout(organizationId, planId)
    } catch (error) {
      errorMessage.value = getErrorMessage(error, 'The plan could not be changed')
    } finally {
      busy.value = false
    }
  }
})
</script>
