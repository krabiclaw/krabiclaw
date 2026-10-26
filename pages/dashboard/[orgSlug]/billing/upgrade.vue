<template>
  <!--
    The one step up. From Growth: what Business changes and Continue, which is
    Better Auth's subscription change confirmed by Stripe. From Starter, with
    no subscription: Growth or Business as two cards, then Continue to Checkout.
  -->
  <DashboardLeafPanel
    id="organization-upgrade"
    :title="onStarter ? 'Choose a plan' : 'Upgrade to Business'"
    :lead="onStarter ? 'Change or cancel at any time. Stripe shows the total before you pay.' : `${formatRecurring(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly - PAID_PLAN_PRICES[GROWTH_PLAN_ID].monthly, 'USD')} more than ${planName(GROWTH_PLAN_ID)}. Stripe charges the difference for the rest of this period${billing?.currentPeriodEnd ? `, then ${formatRecurring(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD')} from ${formatExactDateTime(billing.currentPeriodEnd)}` : ''}.`"
    :footer="dashboard.canUpdateBilling.value"
    :saving="busy"
    :error="error"
    save-label="Continue"
    @save="upgrade"
  >
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-base text-muted">Owners change the plan.</p>
    <!-- Text cards: the hidden indicator's centred icon layout does not apply, so the copy keeps the left edge. -->
    <URadioGroup v-if="onStarter" v-model="chosen" :items="choices" variant="card" indicator="hidden" class="w-full" :ui="{ wrapper: 'w-full items-stretch text-start' }" :disabled="!dashboard.canUpdateBilling.value">
      <template #label="{ item }">
        <span class="flex items-baseline justify-between gap-4"><span>{{ (item as Choice).label }}</span><span>{{ (item as Choice).price }}</span></span>
      </template>
    </URadioGroup>
    <template v-else>
      <div class="flex items-baseline justify-between gap-4 border-b border-default pb-6">
        <h2 class="text-2xl font-semibold text-highlighted">{{ planName(BUSINESS_PLAN_ID) }}</h2>
        <span class="text-base font-medium text-highlighted">{{ formatRecurring(PAID_PLAN_PRICES[BUSINESS_PLAN_ID].monthly, 'USD') }}</span>
      </div>
      <EditorNavigationList :groups="[{ id: 'changes', items: changes }]" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, BUSINESS_ADDITIONS, PAID_PLAN_PRICES, STARTER_PLAN_ID, type NewSalePlanId } from '~/shared/billing-model'
import { OFFERS } from '~/shared/offers'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })

const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans, formatRecurring } = await usePlans()
const { billing } = await useOrganizationBilling()
const { formatExactDateTime } = useHumanTime()
const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
useSeoMeta({ title: () => `${onStarter.value ? 'Choose a plan' : 'Upgrade to Business'} | KrabiClaw`, robots: 'noindex, nofollow' })

// Business has nothing above it, and a plan already changing has no second change to start.
watchEffect(() => {
  const status = billing.value
  if (status && (status.plan === BUSINESS_PLAN_ID || status.cancelAtPeriodEnd || status.scheduledPlan)) showError({ statusCode: 404, statusMessage: 'There is no upgrade for this plan' })
})

// Each addition leads with its offer's illustration, the same picture Menu and Today offered it with.
const changes: EditorNavigationItem[] = BUSINESS_ADDITIONS.map(row => {
  const illustration = OFFERS.find(item => item.id === row.id.replace('-', '_'))?.illustration
  return { ...row, ...(illustration ? { lead: { image: illustration, imageFit: 'contain' as const } } : {}) }
})

const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id
type Choice = { value: NewSalePlanId; label: string; price: string; description?: string }
const choices = computed<Choice[]>(() => ([GROWTH_PLAN_ID, BUSINESS_PLAN_ID] as const).map(id => ({
  value: id,
  label: planName(id),
  price: formatRecurring(PAID_PLAN_PRICES[id].monthly, 'USD'),
  // The plan's own tagline, from its Stripe product.
  description: plans.value.find(plan => plan.id === id)?.tagline,
})))
// The plan the catalog recommends starts chosen, so Continue is live.
const chosen = ref<NewSalePlanId>(choices.value.find(choice => plans.value.find(plan => plan.id === choice.value)?.highlighted)?.value ?? GROWTH_PLAN_ID)

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
