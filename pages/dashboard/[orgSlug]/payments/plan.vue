<template>
  <!-- ChatGPT's picker in our cards: every plan for sale, the current one marked, each with what it includes. The change itself is Better Auth's subscription flow, which Stripe confirms with its proration before anything is charged. -->
  <DashboardLeafPanel id="organization-plan" :title="onStarter ? 'Choose a plan' : 'Change plan'" :footer="false">
    <UAlert v-if="error" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error" />
    <div class="grid gap-4">
      <BillingPlanCard v-for="plan in salePlans" :key="plan.id" :plan="plan" :highlighted="plan.id === billing?.plan">
        <template #cta>
          <UButton v-if="plan.id === billing?.plan" label="Your current plan" color="neutral" variant="outline" size="xl" block disabled />
          <UButton v-else :label="`Switch to ${plan.name}`" size="xl" block :loading="busy" @click="choose(plan.id)" />
        </template>
      </BillingPlanCard>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { STARTER_PLAN_ID, isNewSalePlan } from '~/shared/billing-model'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Plan | KrabiClaw', robots: 'noindex, nofollow' })

const dashboard = useDashboardOrganization()
const { startOrganizationCheckout } = useOrganizationSubscription()
const { plans } = await usePlans()
const { billing } = await useOrganizationBilling()
const onStarter = computed(() => billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
const salePlans = computed(() => plans.value.filter(plan => isNewSalePlan(plan.id)))
const busy = ref(false)
const error = ref('')
async function choose(plan: string) {
  if (busy.value || !isNewSalePlan(plan)) return
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
