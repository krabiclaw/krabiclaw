<template>
  <!-- Cancelling is Better Auth's move to Basic, which Stripe confirms; access stays until the period ends. -->
  <DashboardLeafPanel id="organization-plan-cancel" title="Cancel plan" lead="If you cancel, you keep full access to your plan features until the end of your billing period." :footer="dashboard.canUpdateBilling.value" :saving="busy" :disabled="!cancellable" :error="error" save-label="Cancel plan" @save="cancel">
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-base text-muted">Owners change the plan.</p>
    <p v-if="billing?.currentPeriodEnd && cancellable" class="text-base text-muted">Your {{ currentPlan?.name ?? 'plan' }} continues until {{ formatExactDateTime(billing.currentPeriodEnd) }}. Stripe confirms the change before it is made.</p>
    <p v-else class="text-base text-muted">There is no paid plan to cancel.</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { STARTER_PLAN_ID } from '~/shared/billing-model'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Cancel plan | KrabiClaw', robots: 'noindex, nofollow' })

const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans } = await usePlans()
const { formatExactDateTime } = useHumanTime()
const { billing } = await useOrganizationBilling()
const currentPlan = computed(() => billing.value?.subscriptionPrice ?? plans.value.find(plan => plan.id === billing.value?.plan) ?? null)
const cancellable = computed(() => !!billing.value && !(billing.value.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId) && !billing.value.cancelAtPeriodEnd && !billing.value.scheduledPlan)
const busy = ref(false)
const error = ref('')
async function cancel() {
  if (busy.value || !cancellable.value) return
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  busy.value = true
  error.value = ''
  try {
    await startOrganizationCheckout(organizationId, STARTER_PLAN_ID)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The plan could not be cancelled')
  } finally {
    busy.value = false
  }
}
</script>
