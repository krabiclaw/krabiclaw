<template>
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
    <div class="mx-auto max-w-2xl space-y-6 pb-6">
      <UAlert v-if="success" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
      <BillingServiceIntro :offer="serviceOffer" :price="priceLine" />
      <p v-if="!dashboard.canUpdateBilling.value" class="text-sm text-muted">Owners turn services on and off.</p>
      <div v-if="on" class="space-y-3 rounded-2xl border border-default p-5 text-sm text-toned">
        <p class="font-semibold text-highlighted">On since {{ formatExactDateTime(services!.strategy!.since) }}</p>
        <p>{{ SERVICES.strategy.ending }}</p>
      </div>
      <template v-else-if="dashboard.canUpdateBilling.value">
        <div v-if="onPaidPlan === false" class="space-y-3 rounded-2xl border border-default p-5">
          <p class="text-sm text-toned">Choose a paid plan to add this service to your subscription.</p>
          <UButton :to="planPath" label="Choose a plan" trailing-icon="i-lucide-arrow-right" />
        </div>
        <p v-else-if="onPaidPlan" class="text-sm text-toned">{{ SERVICES.strategy.consent }}</p>
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BillingServiceIntro from '~/components/dashboard/BillingServiceIntro.vue'
import { offer } from '~/shared/offers'
import { SERVICES, SERVICE_PRICES } from '~/shared/billing-model'
import { isServices, useOrganizationBilling, useOrganizationServices } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'SEO and marketing strategy | KrabiClaw', robots: 'noindex, nofollow' })

const serviceOffer = offer('strategy')
const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const { formatPrice, formatRecurring } = await usePlans()
const { formatExactDateTime } = useHumanTime()
const [{ servicesResource, services, servicesError, refreshServices }, { refreshBilling }] = await Promise.all([useOrganizationServices('strategy'), useOrganizationBilling()])
const on = computed(() => !!services.value?.strategy)
// The service is an item on the plan's subscription, so it needs one that is running.
const onPaidPlan = computed(() => servicesResource.value?.requirements?.strategy?.paid_plan)
const priceLine = computed(() => services.value?.strategy
  ? formatRecurring(services.value.strategy.amount, services.value.strategy.currency)
  : `${formatPrice(SERVICE_PRICES.strategy.monthly)} per month, added to your plan and billed with it.`)
const route = useRoute()
const planPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/billing/upgrade?service=strategy`)

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
