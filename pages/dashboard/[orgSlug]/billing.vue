<template>
  <!--
    Plan and billing: what the organization pays KrabiClaw, apart from the
    money it takes in (Earnings → Payments). Airbnb's host tools have no plan,
    so this is the smallest honest index: the plan as the page's one card with
    its one change, the locations it bills, the services sold beside it, and
    Stripe's own portal for the card, invoices and cancelling.
  -->
  <DashboardIndexPanel id="organization-billing" title="Plan and billing" lead="What you pay KrabiClaw. Money you take from guests is under Earnings." :auto-open="firstLeaf">
    <div class="pb-10">
      <p v-if="!dashboard.canUpdateBilling.value && owner" class="mb-6 text-sm text-muted" data-testid="billing-owner-line">{{ owner }} is the owner and changes the plan and billing.</p>
      <UAlert v-if="billingError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(billingError, 'Failed to load billing')" />
      <UAlert v-if="servicesError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(servicesError, 'Services could not be loaded')" />
      <UAlert v-if="methodsError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(methodsError, 'Payment methods could not be loaded')" />
      <UAlert v-if="ownerError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(ownerError, 'The owner could not be loaded')" />
      <UAlert v-if="errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
      <UAlert v-if="successMessage" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="successMessage" />

      <!-- The plan: the page's one card, with its price and its one change. -->
      <UCard v-if="billing" variant="subtle" class="mb-6" data-testid="billing-plan-card">
        <div class="flex items-baseline justify-between gap-4">
          <h2 class="text-2xl font-semibold text-highlighted">{{ planName }}</h2>
          <span class="text-base font-medium text-highlighted">{{ price }}</span>
        </div>
        <p v-if="planLine" class="mt-1 text-sm text-muted">{{ planLine }}</p>
        <template v-if="dashboard.canUpdateBilling.value && change">
          <UButton v-if="change.to" class="mt-6" :label="change.label" :to="change.to" :variant="change.outline ? 'outline' : 'solid'" />
          <UButton v-else class="mt-6" :label="change.label" variant="outline" :loading="busy" @click="changeToGrowth" />
        </template>
      </UCard>

      <EditorNavigationList :groups="groups" :active-item="level.child.value" @act="onRowAction">
        <!-- A service states whether it is on before what it costs. -->
        <template #summary="{ item }">
          <UBadge v-if="serviceState[item.id]" :label="serviceState[item.id]!.on ? 'On' : 'Off'" :color="serviceState[item.id]!.on ? 'success' : 'neutral'" :variant="serviceState[item.id]!.on ? 'solid' : 'soft'" size="lg" class="me-2 align-middle" :class="serviceState[item.id]!.on ? undefined : 'bg-muted text-highlighted'" />{{ item.summary }}
        </template>
      </EditorNavigationList>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, INCLUDED_LOCATIONS, SERVICE_PRICES, SERVICES, STARTER_PLAN_ID, additionalLocationPrice, isNewSalePlan } from '~/shared/billing-model'
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
const nameOf = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id

const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const scheduledPlan = computed(() => billing.value?.scheduledPlan ?? null)
const planName = computed(() => billing.value?.subscriptionPrice?.name ?? (billing.value ? nameOf(billing.value.plan) : ''))
const price = computed(() => {
  const subscription = billing.value?.subscriptionPrice
  return subscription ? formatRecurring(subscription.amount, subscription.currency, subscription.interval) : 'Free'
})
const card = computed(() => {
  const cards = methods.value?.payment_methods ?? []
  const main = cards.find(entry => entry.default) ?? cards[0]
  return main ? `${cardBrandLabel(main.brand)} •••• ${main.last4}` : null
})
// "Renews Nov 4, 2026 · Visa •••• 4242": what happens next, and the card it is billed to.
const planLine = computed(() => {
  const status = billing.value
  if (!status || onStarter.value) return ''
  const parts: string[] = []
  if (status.subscriptionStatus === 'past_due') parts.push('Payment past due')
  else if (scheduledPlan.value) parts.push(`Changes to ${nameOf(scheduledPlan.value.plan)} on ${formatExactDateTime(scheduledPlan.value.at)}`)
  else if (status.currentPeriodEnd) parts.push(`${status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatExactDateTime(status.currentPeriodEnd)}`)
  if (card.value) parts.push(card.value)
  return parts.join(' · ')
})
// The plan's one change: up from Basic or Growth, down from Business at the period's end; none while a change is pending.
const change = computed<{ label: string; to?: string; outline?: boolean } | null>(() => {
  const status = billing.value
  if (!status || status.cancelAtPeriodEnd || scheduledPlan.value) return null
  if (onStarter.value) return { label: 'Choose a plan', to: to('upgrade') }
  if (status.plan === BUSINESS_PLAN_ID) return { label: 'Change plan', outline: true }
  return { label: 'Upgrade to Business', to: to('upgrade') }
})
const firstLeaf = computed(() => change.value?.to ?? to('managed-ads'))

// Stripe's phrasing: the locations in use, the included allowance, then the charge per additional one.
const locationsRow = computed<EditorNavigationItem | null>(() => {
  const used = billing.value?.usage.locations
  if (used === undefined) return null
  return { id: 'locations', label: 'Locations', summary: onStarter.value ? `${used} in use · ${INCLUDED_LOCATIONS} included · ${nameOf(STARTER_PLAN_ID)} stops at ${INCLUDED_LOCATIONS}` : `${used} in use · ${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice()}` }
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

// Stripe's portal owns the card, invoices, receipts and cancelling; the row opens it.
const portalRow = computed<EditorNavigationItem | null>(() => billing.value?.stripeCustomerId
  ? { id: 'portal', label: 'Manage billing', summary: 'Card, invoices and receipts, cancel', ...(dashboard.canUpdateBilling.value ? { action: { opens: true } } : {}) }
  : null)

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'billing',
  items: [
    ...(locationsRow.value ? [locationsRow.value] : []),
    ...serviceRows.value,
    ...(portalRow.value ? [portalRow.value] : []),
  ],
}])

// Business moves down to Growth at the period's end through Better Auth's scheduled change.
async function changeToGrowth() {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    await startOrganizationCheckout(organizationId, GROWTH_PLAN_ID)
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'The plan could not be changed')
  } finally {
    busy.value = false
  }
}

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
