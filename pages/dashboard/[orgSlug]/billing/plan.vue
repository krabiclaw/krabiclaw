<template>
  <!--
    The plan as an Airbnb leaf: one line on when it renews and what it is billed
    to, the plan and its price, what it includes with today's counts, then the
    one way to change it and Stripe's portal for the card and invoices.
  -->
  <DashboardLeafPanel id="organization-plan" title="Plan" :lead="lead" :footer="false" :error="error">
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-sm text-muted">Owners change the plan.</p>
    <UAlert v-if="usageError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(usageError, 'Payment fees could not be loaded')" />
    <UAlert v-if="methodsError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(methodsError, 'Payment methods could not be loaded')" />
    <div v-if="billing" class="flex items-baseline justify-between gap-4 border-b border-default pb-6" data-testid="plan-hero">
      <h2 class="text-2xl font-semibold text-highlighted">{{ currentName }}</h2>
      <span class="text-base font-medium text-highlighted">{{ price }}</span>
    </div>
    <EditorNavigationList :groups="[{ id: 'included', items: included }]" />
    <EditorNavigationList v-if="actions.length" class="mt-6 border-t border-default pt-6" :groups="[{ id: 'actions', items: actions }]" @act="act" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, INCLUDED_LOCATIONS, INCLUDED_RENTAL_UNITS, PAID_PLAN_PRICES, STARTER_PLAN_ID, additionalLocationPrice, additionalRentalUnitPrice } from '~/shared/billing-model'
import { cardBrandLabel, useOrganizationBilling, usePaymentMethods, usePaymentsUsage } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Plan | KrabiClaw', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const { startOrganizationCheckout, openBillingPortal } = useOrganizationSubscription()
const { plans, formatRecurring } = await usePlans()
const { formatExactDateTime } = useHumanTime()
const [{ billing, refreshBilling }, { usage, usageError }, { methods, methodsError }] = await Promise.all([useOrganizationBilling(), usePaymentsUsage(), usePaymentMethods()])

const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id
const currentName = computed(() => billing.value?.subscriptionPrice?.name ?? (billing.value ? planName(billing.value.plan) : ''))
const price = computed(() => {
  const subscription = billing.value?.subscriptionPrice
  return subscription ? formatRecurring(subscription.amount, subscription.currency, subscription.interval) : 'Free'
})
const card = computed(() => {
  const cards = methods.value?.payment_methods ?? []
  const main = cards.find(entry => entry.default) ?? cards[0]
  return main ? `${cardBrandLabel(main.brand)} •••• ${main.last4}` : null
})

// The one line under the title: what happens next, and what it is billed to.
const lead = computed(() => {
  const status = billing.value
  if (!status) return undefined
  if (onStarter.value) return `${currentName.value} is free. Growth and Business add your own domain, messaging and more.`
  const billedTo = card.value ? ` and is billed to ${card.value}` : ''
  if (status.subscriptionStatus === 'past_due') return `Your last payment didn't go through. Update the payment method to keep ${currentName.value}.`
  if (status.scheduledPlan) return `Your plan changes to ${planName(status.scheduledPlan.plan)} on ${formatExactDateTime(status.scheduledPlan.at)}.`
  if (status.currentPeriodEnd) return status.cancelAtPeriodEnd
    ? `Your plan ends on ${formatExactDateTime(status.currentPeriodEnd)}.`
    : `Your plan renews on ${formatExactDateTime(status.currentPeriodEnd)}${billedTo}.`
  return undefined
})

// Stripe's phrasing: what is in use against the included allowance, then the charge per additional unit.
const included = computed<EditorNavigationItem[]>(() => {
  const status = billing.value
  if (!status) return []
  const used = status.billsRentalUnits ? status.businessUsage.locations : status.locations.used
  const locations = used <= INCLUDED_LOCATIONS
    ? `${used} of ${INCLUDED_LOCATIONS} included`
    : `${used} in use · ${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice(status.billingInterval)}`
  const pricing = usage.value?.pricing
  return [
    { id: 'locations', label: 'Locations', summary: onStarter.value ? `${used} of ${INCLUDED_LOCATIONS} included` : locations },
    ...(status.rentalUnits
      ? [{ id: 'rental-units', label: 'Rental units', summary: status.rentalUnits.used <= INCLUDED_RENTAL_UNITS
          ? `${status.rentalUnits.used} of ${INCLUDED_RENTAL_UNITS} included`
          : `${status.rentalUnits.used} in use · ${INCLUDED_RENTAL_UNITS} included, then ${additionalRentalUnitPrice()}` }]
      : []),
    ...(pricing ? [{ id: 'fees', label: 'Payment fees', summary: `${pricing.captured_volume_rate_percent}% of payment volume, plus Stripe fees` }] : []),
  ]
})

// The one change this plan offers, then Stripe's portal; an admin reads the plan and changes nothing.
const actions = computed<EditorNavigationItem[]>(() => {
  const status = billing.value
  if (!status || !dashboard.canUpdateBilling.value) return []
  const rows: EditorNavigationItem[] = []
  if (status.scheduledPlan || status.cancelAtPeriodEnd) {
    rows.push({ id: 'restore', label: `Keep ${currentName.value}`, summary: status.scheduledPlan ? `Instead of changing to ${planName(status.scheduledPlan.plan)}` : `After ${formatExactDateTime(status.currentPeriodEnd!)}`, action: { label: 'Keep' } })
  }
  else if (status.plan === BUSINESS_PLAN_ID) {
    rows.push({ id: 'change', label: 'Change plan', summary: `${planName(GROWTH_PLAN_ID)} · ${formatRecurring(PAID_PLAN_PRICES[GROWTH_PLAN_ID].monthly, 'USD')} from your next billing date`, action: { label: 'Change' } })
  }
  else if (level.to.value) {
    rows.push(onStarter.value
      ? { id: 'upgrade', label: 'Choose a plan', summary: `Growth ${formatRecurring(PAID_PLAN_PRICES[GROWTH_PLAN_ID].monthly, 'USD')} or Business ${formatRecurring(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD')}`, to: `${level.to.value}/upgrade` }
      : { id: 'upgrade', label: 'Upgrade to Business', summary: `${formatRecurring(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD')} · online payments, direct stay booking, Google Ads`, to: `${level.to.value}/upgrade` })
  }
  if (status.stripeCustomerId) rows.push({ id: 'portal', label: 'Payment method and invoices', summary: card.value ?? 'No payment method saved', action: { label: 'Open' } })
  return rows
})

const busy = ref(false)
const error = ref('')
async function act(id: string) {
  if (busy.value) return
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  busy.value = true
  error.value = ''
  try {
    if (id === 'change') await startOrganizationCheckout(organizationId, GROWTH_PLAN_ID)
    else if (id === 'portal') await openBillingPortal()
    else if (id === 'restore') {
      // Better Auth's restore releases the schedule or the pending cancellation at Stripe.
      const restored = await authClient.subscription.restore({ referenceId: organizationId, customerType: 'organization' })
      if (restored.error) throw new Error(restored.error.message ?? 'Your plan could not be kept')
      await refreshBilling()
    }
    else throw new Error('Unknown plan action')
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The plan could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
