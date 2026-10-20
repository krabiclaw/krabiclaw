<template>
  <!-- Strategy: the consent that adds Julia's service to the plan subscription; Stripe prorates and bills it. The same leaf turns it off. -->
  <DashboardLeafPanel id="organization-strategy" :title="on ? 'Turn off the strategy service' : SERVICES.strategy.name" :saving="busy" :disabled="!services || needsPlan" :error="error" :save-label="on ? 'Turn off' : 'Agree and turn on'" @save="toggle">
    <UAlert v-if="success" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
    <div class="space-y-3 text-base text-muted">
      <template v-if="on">
        <p>On since {{ formatExactDateTime(services!.strategy!.since) }} · {{ paymentMoney(services!.strategy!.amount, services!.strategy!.currency) }} per {{ services!.strategy!.interval }}.</p>
        <p>Julia's service ends now. Stripe credits the unused part of this period to your next invoice.</p>
      </template>
      <template v-else>
        <p>{{ SERVICES.strategy.description }}</p>
        <p>It costs <strong class="text-highlighted">{{ paymentMoney(SERVICE_PRICES.strategy.monthly, 'USD') }} per month</strong>, added to your plan's subscription and billed to the same card. Stripe invoices and charges today's share as soon as you agree, then the full amount every month on the service's own schedule, whatever your plan's renewal. You can turn it off here at any time.</p>
        <template v-if="needsPlan">
          <p>It is added to a paid plan. Choose one first.</p>
          <UButton label="Choose a plan" color="neutral" variant="outline" :to="`${parent}/plan`" />
        </template>
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { SERVICES, SERVICE_PRICES, STARTER_PLAN_ID } from '~/shared/billing-model'
import { paymentMoney } from '~/shared/payment-display'
import { isServices, useOrganizationBilling, useOrganizationServices } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'SEO and marketing strategy | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const dashboardApi = useDashboardApi()
const { formatExactDateTime } = useHumanTime()
// Sibling leaves under the same Payments column.
const parent = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/payments`)
const [{ servicesResource, services }, { billing, refreshBilling }] = await Promise.all([useOrganizationServices(), useOrganizationBilling()])
const on = computed(() => !!services.value?.strategy)
const needsPlan = computed(() => !on.value && billing.value?.plan === STARTER_PLAN_ID && !billing.value.stripeSubscriptionId)
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
    await refreshBilling()
    success.value = updated.services.strategy ? 'The strategy service is on. Julia will be in touch to set up your weekly meeting and chat.' : 'The strategy service is off.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The strategy service could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
