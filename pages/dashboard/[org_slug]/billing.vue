<template>
  <DashboardIndexPanel id="organization-billing" title="Plan and billing" :auto-open="firstLeaf">
    <div class="pb-10">
      <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-sm text-muted" data-testid="billing-owner-line">
        Only the organization owner can manage billing.<template v-if="owner"> Contact {{ owner }} to change or cancel your plan.</template>
      </p>
      <UAlert v-if="billingError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(billingError, 'Failed to load billing')" />
      <p v-if="dashboard.hasFeature('stays') && homesPending" role="status" class="mb-6 text-sm text-muted">Loading home cost…</p>
      <UAlert v-else-if="homesError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(homesError, 'Homes could not be loaded')" />
      <UAlert v-if="servicesError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(servicesError, 'Services could not be loaded')" />
      <UAlert v-if="methodsError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(methodsError, 'Payment methods could not be loaded')" />
      <UAlert v-if="ownerError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(ownerError, 'The owner could not be loaded')" />
      <UAlert v-if="errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
      <UAlert v-if="successMessage" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="successMessage" />

      <UCard v-if="billing" variant="record" class="mb-6 rounded-3xl" data-testid="billing-plan-card">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium text-muted">Current plan</p>
            <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 class="text-3xl font-semibold tracking-tight text-highlighted">{{ planName }}</h2>
              <span class="text-base font-medium text-highlighted">{{ price }}</span>
            </div>
            <UButton v-if="dashboard.canUpdateBilling.value && change" class="mt-5 rounded-full px-4" :label="change.label" :to="change.to" :variant="change.outline ? 'outline' : 'solid'" />
            <UButton v-else-if="dashboard.canUpdateBilling.value && pending" class="mt-5 rounded-full px-4" :label="`Keep ${planName}`" variant="outline" :loading="busy" @click="keepPlan" />
          </div>
          <img src="/images/website/storefront.webp" alt="" class="size-20 shrink-0 object-contain sm:size-28" />
        </div>
        <p v-if="planLine" class="mt-4 border-t border-default pt-3 text-sm text-muted">{{ planLine }}</p>
      </UCard>

      <div v-if="serviceCards.length" class="mb-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4">
        <NuxtLink
          v-for="card in serviceCards"
          :key="card.id"
          :to="to(card.id)"
          :aria-current="level.child.value === card.id ? 'page' : undefined"
          :data-testid="`editor-card-${card.id}`"
          class="group flex flex-col overflow-hidden rounded-3xl bg-elevated text-highlighted shadow-[0_4px_24px_rgb(0_0_0/0.08)] transition-shadow hover:shadow-[0_6px_28px_rgb(0_0_0/0.14)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted aria-[current=page]:ring-2 aria-[current=page]:ring-highlighted"
        >
          <img :src="card.offer.banner" alt="" width="512" height="512" class="aspect-[8/5] w-full bg-[#f9efe7] object-contain" />
          <div class="flex flex-1 flex-col gap-3 p-5">
            <div class="flex flex-wrap items-center gap-2 text-sm font-medium text-muted">
              {{ card.offer.name }}
              <UBadge v-if="card.active" label="On" color="success" variant="soft" />
            </div>
            <h2 class="text-lg font-semibold leading-snug">{{ card.offer.headline }}</h2>
            <p class="text-sm leading-relaxed text-toned">{{ card.offer.line }}</p>
            <div class="mt-auto flex items-center justify-between gap-2 pt-2 text-sm font-semibold">
              <span>{{ card.price }}</span>
              <UIcon name="i-lucide-arrow-right" class="size-5 shrink-0 transition-transform group-hover:translate-x-0.5" />
            </div>
          </div>
        </NuxtLink>
      </div>

      <EditorNavigationList v-if="groups[0]?.items.length" variant="cards" :groups="groups" @act="onRowAction" />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { offer } from '~/shared/offers'
import { authClient } from '~/lib/auth-client'
import { classifyStripePlanChange } from '~/shared/stripe-ga4'
import { SERVICE_PRICES, SERVICES, STARTER_PLAN_ID, isNewSalePlan } from '~/shared/billing-model'
import { cardBrandLabel, useHomesQuote, useOrganizationBilling, useOrganizationServices, usePaymentMethods } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Plan and billing | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const { trackSubscriptionCheckoutSuccess } = useAnalytics()
const { startOrganizationCheckout, openBillingPortal } = useOrganizationSubscription()
const { formatExactDateTime } = useHumanTime()
const { plans, formatPrice, formatRecurring } = await usePlans()

const organizationId = useDashboardOrganizationId()
const [{ billing, billingError, refreshBilling }, { services, servicesError }, { methods, methodsError }, { quote: homes, quoteError: homesError, quotePending: homesPending, refreshQuote: refreshHomes }] = await Promise.all([
  useOrganizationBilling(), useOrganizationServices(), usePaymentMethods(), useHomesQuote(organizationId, 0),
])

// Admins read billing and do not change it; the line names who does.
const { data: owner, error: ownerError } = await useAsyncData(`billing-owner:${String(route.params.org_slug)}`, async () => {
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
const scheduledPlan = computed(() => billing.value?.scheduled_plan ?? null)
const planName = computed(() => billing.value?.subscription_price?.name ?? (billing.value ? nameOf(billing.value.plan) : ''))
const price = computed(() => {
  const subscription = billing.value?.subscription_price
  return subscription ? formatRecurring(subscription.amount, subscription.currency) : 'Free'
})
const card = computed(() => {
  const cards = methods.value?.payment_methods ?? []
  const main = cards.find(entry => entry.default) ?? cards[0]
  return main ? `${cardBrandLabel(main.brand)} •••• ${main.last4}` : null
})
// "Renews Nov 4, 2026 · Visa •••• 4242": what happens next, and the card it is billed to.
// In a free trial, Stripe's own end behavior says what happens without a card.
const planLine = computed(() => {
  const status = billing.value
  if (!status || onStarter.value) return ''
  const parts: string[] = []
  const trial = status.subscription_price?.trial
  if (trial) {
    parts.push(`Free trial ends ${formatExactDateTime(trial.end)}`)
    // A change already set for the period's end is what happens; only without one does the card decide.
    if (status.cancelAtPeriodEnd) parts.push(`${planName.value} ends with the trial`)
    else if (scheduledPlan.value) parts.push(`Changes to ${nameOf(scheduledPlan.value.plan)} on ${formatExactDateTime(scheduledPlan.value.at)}`)
    // Only a card list that loaded can say there is no card; a failed load shows its own error above.
    else if (methods.value && !methodsError.value && !card.value) parts.push(TRIAL_WITHOUT_CARD[trial.missing_payment_method](planName.value))
  } else if (status.status === 'past_due') parts.push('Payment past due')
  else if (scheduledPlan.value) parts.push(`Changes to ${nameOf(scheduledPlan.value.plan)} on ${formatExactDateTime(scheduledPlan.value.at)}`)
  else if (status.periodEnd) parts.push(`${status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatExactDateTime(status.periodEnd)}`)
  if (card.value) parts.push(card.value)
  return parts.join(' · ')
})
const TRIAL_WITHOUT_CARD = {
  cancel: (plan: string) => `Add a card to stay on ${plan}; without one the plan ends with the trial`,
  pause: (plan: string) => `Add a card to stay on ${plan}; without one the plan pauses when the trial ends`,
  create_invoice: (plan: string) => `Add a card to pay for ${plan} when the trial ends`,
} as const

// The plan's one change: up from Basic or Growth, or to Growth from Business, each its own leaf; none while a change is pending.
const change = computed<{ label: string; to: string; outline?: boolean } | null>(() => {
  const actions = billing.value?.actions
  if (!actions?.label) return null
  const downgrade = actions.changes.some(change => change.timing === 'period_end')
  return { label: actions.label, to: to(downgrade ? 'change' : 'upgrade'), outline: downgrade }
})
const pending = computed(() => billing.value?.actions.restore === true)

// Beside a pane the index opens a way up; Business, with nothing above it, opens its first service.
const firstLeaf = computed(() => {
  if (!dashboard.canUpdateBilling.value || route.path === level.path.value && route.query.checkout) return null
  return change.value && !change.value.outline ? change.value.to : to('managed-ads')
})

// Homes from the quote the capacity check answers by: live (billed on a paid
// plan, up to what Basic includes on Basic), drafts (free), and what the live
// ones cost each month. A
// subscription from before homes were priced carries no homes price and is
// charged nothing for them, so the row says so.
const homesRow = computed<EditorNavigationItem | null>(() => {
  const current = homes.value
  if (!current || !dashboard.hasFeature('stays')) return null
  const counted = `${current.homes.used} live · ${current.homes.drafts} ${current.homes.drafts === 1 ? 'draft' : 'drafts'}`
  const summary = current.homes.limit !== null
    ? `${counted} · This plan includes ${current.homes.limit}`
    : current.homes.additional_price_minor
      ? `${counted} · ${formatPrice(current.homes.amount_minor)} per month${current.billing.trial_end ? ' after your free trial' : ''}`
      : `${counted} · not billed on this subscription`
  return { id: 'homes', label: 'Homes', summary }
})

const serviceCards = computed(() => {
  const current = services.value
  if (!current) return []
  return [
    {
      id: 'managed-ads', offer: offer('managed_ads'),
      price: SERVICES.managed_ads.price, active: Boolean(current.managed_ads),
    },
    {
      id: 'strategy', offer: offer('strategy'),
      price: current.strategy ? formatRecurring(current.strategy.amount, current.strategy.currency) : monthly(SERVICE_PRICES.strategy.monthly),
      active: Boolean(current.strategy),
    },
  ]
})

// Stripe's portal owns the card, invoices, receipts and cancelling; the row opens it.
const portalRow = computed<EditorNavigationItem | null>(() => dashboard.canUpdateBilling.value && billing.value?.stripeCustomerId
  ? { id: 'portal', label: 'Manage billing', summary: 'Card, invoices and receipts, cancel', action: { opens: true } }
  : null)

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'billing',
  items: [
    ...(homesRow.value ? [homesRow.value] : []),
    ...(portalRow.value ? [portalRow.value] : []),
  ],
}])

async function keepPlan() {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    const restored = await authClient.subscription.restore({ referenceId: organizationId, customerType: 'organization' })
    if (restored.error) throw new Error(restored.error.message ?? 'Your plan could not be kept')
    await Promise.all([refreshBilling(), refreshHomes()])
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Your plan could not be kept')
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
  const { success, plan, canceled, checkout, ...restQuery } = route.query
  if (!success && !canceled && (!checkout || route.path !== level.path.value)) return
  if (success === 'true') {
    const id = dashboard.organization.value?.id
    if (id) trackSubscriptionCheckoutSuccess(id, typeof plan === 'string' ? plan : undefined)
    successMessage.value = typeof plan === 'string' && billing.value?.plan === plan
      ? 'Payment confirmed. Your plan has been updated.'
      : 'Payment is processing. Your plan will activate after Stripe confirms the subscription.'
  }
  if (canceled === 'true') errorMessage.value = 'Payment was canceled. Your plan was not changed.'
  await router.replace({ query: restQuery })
  if (success || canceled) return
  // A plan chosen on the pricing page starts only a way up, and only for someone who changes billing:
  // the current plan, a lower one, a plan already changing or an admin's visit leaves the index as it is.
  const planId = Array.isArray(checkout) ? checkout[0] : checkout
  const status = billing.value
  const step = typeof planId === 'string' && status && !status.cancelAtPeriodEnd && !status.scheduled_plan ? classifyStripePlanChange(status.plan, planId, Boolean(status.stripeSubscriptionId)) : null
  if (typeof planId === 'string' && isNewSalePlan(planId) && (step === 'upgrade' || step === 'initial_subscription') && dashboard.canUpdateBilling.value && !busy.value) {
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
