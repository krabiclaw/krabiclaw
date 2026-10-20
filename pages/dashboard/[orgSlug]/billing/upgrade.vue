<template>
  <!--
    The one step up. From Growth: what Business changes and Continue, which is
    Better Auth's subscription change confirmed by Stripe. From Starter, with
    no subscription: Growth or Business as two cards, then Continue to Checkout.
  -->
  <DashboardLeafPanel
    id="organization-upgrade"
    :title="onStarter ? 'Choose a plan' : 'Upgrade to Business'"
    :lead="onStarter ? undefined : `${paymentMoney(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD')} per month`"
    :footer="dashboard.canUpdateBilling.value"
    :saving="busy"
    :disabled="onStarter && !chosen"
    :error="error"
    save-label="Continue"
    @save="upgrade"
  >
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-base text-muted">Owners change the plan.</p>
    <URadioGroup v-if="onStarter" v-model="chosen" :items="choices" variant="card" indicator="hidden" class="w-full" :disabled="!dashboard.canUpdateBilling.value" />
    <EditorNavigationList v-else :groups="[{ id: 'changes', items: changes }]" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, INCLUDED_RENTAL_UNITS, PAID_PLAN_PRICES, STARTER_PLAN_ID, additionalRentalUnitPrice, type NewSalePlanId } from '~/shared/billing-model'
import { paymentMoney } from '~/shared/payment-display'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })

const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans } = await usePlans()
const { billing } = await useOrganizationBilling()
const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
useSeoMeta({ title: () => `${onStarter.value ? 'Choose a plan' : 'Upgrade to Business'} | KrabiClaw`, robots: 'noindex, nofollow' })

// Business has nothing above it, and a plan already changing has no second change to start.
watchEffect(() => {
  const status = billing.value
  if (status && (status.plan === BUSINESS_PLAN_ID || status.cancelAtPeriodEnd || status.scheduledPlan)) showError({ statusCode: 404, statusMessage: 'There is no upgrade for this plan' })
})

const changes: EditorNavigationItem[] = [
  { id: 'payments', label: 'Online payments and direct stay booking' },
  { id: 'rental-units', label: 'Rental units', summary: `${INCLUDED_RENTAL_UNITS} included, then ${additionalRentalUnitPrice()}` },
  { id: 'google-ads', label: 'Google Ads campaigns' },
  { id: 'ios', label: 'The iOS app' },
]

const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id
const choices = computed(() => ([GROWTH_PLAN_ID, BUSINESS_PLAN_ID] as const).map(id => ({
  value: id,
  label: `${planName(id)} · ${paymentMoney(PAID_PLAN_PRICES[id].monthly, 'USD')}/mo`,
  // The plan's own tagline, from its Stripe product.
  description: plans.value.find(plan => plan.id === id)?.tagline,
})))
const chosen = ref<NewSalePlanId | undefined>(undefined)

const busy = ref(false)
const error = ref('')
async function upgrade() {
  if (busy.value) return
  const plan = onStarter.value ? chosen.value : BUSINESS_PLAN_ID
  if (!plan) return
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  busy.value = true
  error.value = ''
  try {
    await startOrganizationCheckout(organizationId, plan)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The plan could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
