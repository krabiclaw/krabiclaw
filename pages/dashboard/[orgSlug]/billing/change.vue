<template>
  <!--
    Business's one change: to Growth at the end of the period, through Better
    Auth's scheduled change. The leaf says when it happens and what ends with
    Business before the owner commits, so it is never a one-click downgrade.
  -->
  <DashboardLeafPanel
    id="organization-change-plan"
    title="Change plan"
    :lead="lead"
    :footer="dashboard.canUpdateBilling.value"
    :saving="busy"
    :error="error"
    :save-label="`Change to ${planName(GROWTH_PLAN_ID)}`"
    @save="change"
  >
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-sm text-muted">Owners change the plan.</p>
    <div class="flex items-baseline justify-between gap-4 border-b border-default pb-6">
      <h2 class="text-2xl font-semibold text-highlighted">{{ planName(GROWTH_PLAN_ID) }}</h2>
      <span class="text-base font-medium text-highlighted">{{ formatRecurring(PAID_PLAN_PRICES[GROWTH_PLAN_ID].monthly, 'USD') }}</span>
    </div>
    <EditorNavigationList :groups="[{ id: 'ends', items: ends }]" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { BUSINESS_ADDITIONS, BUSINESS_PLAN_ID, GROWTH_PLAN_ID, PAID_PLAN_PRICES } from '~/shared/billing-model'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Change plan | KrabiClaw', robots: 'noindex, nofollow' })

const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans, formatRecurring } = await usePlans()
const { formatExactDateTime } = useHumanTime()
const { billing } = await useOrganizationBilling()
const planName = (id: string) => plans.value.find(plan => plan.id === id)?.name ?? id

// Only Business moves to Growth, and a plan already changing has no second change to start.
watchEffect(() => {
  const status = billing.value
  if (status && (status.plan !== BUSINESS_PLAN_ID || status.cancelAtPeriodEnd || status.scheduledPlan)) showError({ statusCode: 404, statusMessage: 'There is no plan change for this plan' })
})

const lead = computed(() => billing.value?.currentPeriodEnd
  ? `${planName(BUSINESS_PLAN_ID)} continues until ${formatExactDateTime(billing.value.currentPeriodEnd)}, then ${planName(GROWTH_PLAN_ID)} at ${formatRecurring(PAID_PLAN_PRICES[GROWTH_PLAN_ID].monthly, 'USD')} without what is listed here.`
  : undefined)
const ends: EditorNavigationItem[] = BUSINESS_ADDITIONS.map(row => ({ ...row }))

const busy = ref(false)
const error = ref('')
async function change() {
  if (busy.value) return
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  busy.value = true
  error.value = ''
  try {
    await startOrganizationCheckout(organizationId, GROWTH_PLAN_ID)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The plan could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
