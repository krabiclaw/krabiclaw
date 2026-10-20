<template>
  <!-- What the plan includes, each with its current count, then the one way to change it. -->
  <DashboardLeafPanel id="organization-plan" title="Plan" :footer="false" :error="error">
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-base text-muted">Owners change the plan.</p>
    <UAlert v-if="usageError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(usageError, 'Payment fees could not be loaded')" />
    <EditorNavigationList :groups="groups" @act="act" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, INCLUDED_LOCATIONS, INCLUDED_RENTAL_UNITS, STARTER_PLAN_ID, additionalLocationPrice, additionalRentalUnitPrice } from '~/shared/billing-model'
import { useOrganizationBilling, usePaymentsUsage } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Plan | KrabiClaw', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans } = await usePlans()
const { formatExactDateTime } = useHumanTime()
const [{ billing, refreshBilling }, { usage, usageError }] = await Promise.all([useOrganizationBilling(), usePaymentsUsage()])

const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id
const currentName = computed(() => billing.value?.subscriptionPrice?.name ?? (billing.value ? planName(billing.value.plan) : 'plan'))
const pending = computed(() => !!billing.value && (!!billing.value.scheduledPlan || !!billing.value.cancelAtPeriodEnd))
// A sibling leaf under Plan and billing.
const upgrade = computed(() => level.to.value ? `${level.to.value}/upgrade` : undefined)

// Stripe's phrasing: what is in use, the included allowance, then the charge per additional unit.
const included = computed<EditorNavigationItem[]>(() => {
  const status = billing.value
  if (!status) return []
  const locations = status.billsRentalUnits
    ? `${status.locations.used} in use, not counting locations with only rental units · ${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice()}`
    : `${status.locations.used} in use · ${INCLUDED_LOCATIONS} included${onStarter.value ? '' : `, then ${additionalLocationPrice(status.billingInterval)}`}`
  const pricing = usage.value?.pricing
  return [
    { id: 'locations', label: 'Locations', summary: locations },
    ...(status.rentalUnits ? [{ id: 'rental-units', label: 'Rental units', summary: `${status.rentalUnits.used} in use · ${INCLUDED_RENTAL_UNITS} included, then ${additionalRentalUnitPrice()}` }] : []),
    ...(pricing ? [{ id: 'fees', label: 'Payment fees', summary: `${pricing.captured_volume_rate_percent}% of payment volume, plus Stripe fees` }] : []),
  ]
})

// The one change this plan offers: up to Business, down to Growth at the period's end, or keeping it when a change is pending.
const change = computed<EditorNavigationItem | null>(() => {
  const status = billing.value
  if (!status) return null
  if (pending.value) {
    if (!dashboard.canUpdateBilling.value) return null
    return { id: 'restore', label: `Keep ${currentName.value}`, summary: status.scheduledPlan
      ? `Stay on ${currentName.value} instead of changing to ${planName(status.scheduledPlan.plan)}.`
      : `Stay on ${currentName.value} after ${formatExactDateTime(status.currentPeriodEnd!)}.`, action: { label: 'Keep plan' } }
  }
  if (status.plan === BUSINESS_PLAN_ID) {
    if (!dashboard.canUpdateBilling.value) return null
    return { id: 'change', label: 'Change plan', summary: `Change to ${planName(GROWTH_PLAN_ID)} at the end of your billing period.`, action: { label: 'Change' } }
  }
  return { id: 'upgrade', label: onStarter.value ? 'Choose a plan' : 'Upgrade to Business', to: upgrade.value }
})

const groups = computed<EditorNavigationGroup[]>(() => [
  { id: 'included', items: included.value },
  ...(change.value ? [{ id: 'change', items: [change.value] }] : []),
])

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
