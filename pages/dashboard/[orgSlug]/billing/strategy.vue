<template>
  <!--
    SEO and marketing strategy: what Julia does and what it costs, what agreeing
    needs as a row that says where it stands, and the consent that adds it to the
    plan's subscription, which Stripe prorates and bills. Until the plan allows
    it the line under the row says what is left. The same leaf turns it off.
  -->
  <DashboardLeafPanel
    id="organization-strategy"
    :title="SERVICES.strategy.name"
    :footer="dashboard.canUpdateBilling.value && (on || onPaidPlan)"
    :saving="busy"
    :error="error || (servicesError ? getErrorMessage(servicesError, 'The service could not be loaded') : '')"
    :disabled="!services"
    :save-label="on ? 'Turn off' : 'Agree and turn on'"
    @save="toggle"
  >
    <UAlert v-if="success" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-sm text-muted">Owners turn services on and off.</p>
    <p class="text-base text-highlighted">{{ SERVICES.strategy.description }}</p>
    <p class="mt-4 text-base font-semibold text-highlighted">{{ formatPrice(SERVICE_PRICES.strategy.monthly) }} per month, added to your plan and billed with it.</p>
    <div v-if="on" class="mt-6 space-y-3 text-sm text-muted">
      <p>On since {{ formatExactDateTime(services!.strategy!.since) }} · {{ formatRecurring(services!.strategy!.amount, services!.strategy!.currency) }}.</p>
      <p>{{ SERVICES.strategy.ending }}</p>
    </div>
    <template v-else-if="services">
      <EditorNavigationList class="mt-6" :groups="[{ id: 'requirements', items: requirementRows }]" />
      <p v-if="onPaidPlan === false" class="mt-6 text-sm text-muted">Choose a plan to turn this on.</p>
      <p v-else-if="onPaidPlan === true" class="mt-6 text-sm text-muted">{{ SERVICES.strategy.consent }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { SERVICES, SERVICE_PRICES } from '~/shared/billing-model'
import { isServices, useOrganizationBilling, useOrganizationServices } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'SEO and marketing strategy | KrabiClaw', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const { plans, formatPrice, formatRecurring } = await usePlans()
const { formatExactDateTime } = useHumanTime()
const [{ servicesResource, services, servicesError, refreshServices }, { billing, refreshBilling }] = await Promise.all([useOrganizationServices('strategy'), useOrganizationBilling()])
const on = computed(() => !!services.value?.strategy)
// The service is an item on the plan's subscription, so it needs one that is running.
const onPaidPlan = computed(() => servicesResource.value?.requirements?.strategy?.paid_plan)
const planName = computed(() => billing.value?.subscriptionPrice?.name ?? plans.value.find(plan => plan.id === billing.value?.plan)?.name ?? 'your plan')
const requirementRows = computed<EditorNavigationItem[]>(() => typeof onPaidPlan.value !== 'boolean' ? [] : [{
  id: 'paid-plan', label: 'Paid plan', mark: onPaidPlan.value ? 'met' : 'open',
  summary: `On ${planName.value}`,
  ...(onPaidPlan.value || !dashboard.canUpdateBilling.value || !level.to.value ? {} : { to: `${level.to.value}/upgrade` }),
}])

const busy = ref(false)
const error = ref('')
const success = ref('')
// One attempt per consent: a retried submit deduplicates at Stripe, a later consent does not.
let attempt = crypto.randomUUID()
async function toggle() {
  if (!services.value || busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'strategy', action: services.value.strategy ? 'end' : 'agree', attempt }, validate: isServices })
    servicesResource.value = updated
    attempt = crypto.randomUUID()
    await Promise.all([refreshBilling(), refreshServices()])
    if (servicesError.value) throw new Error(`The service changed, but its current requirements could not be read. ${getErrorMessage(servicesError.value, 'Reopen the service before another change.')}`)
    success.value = updated.services.strategy ? 'The strategy service is on. Julia will be in touch to set up your weekly meeting and chat.' : 'The strategy service is off.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The strategy service could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
