<template>
  <!-- Managed ads: the consent that starts the 10% fee, stated before it is agreed; the same leaf turns it off. -->
  <DashboardLeafPanel id="organization-managed-ads" :title="on ? 'Turn off managed ads' : SERVICES.managed_ads.name" :saving="busy" :disabled="!services" :error="error" :save-label="on ? 'Turn off' : 'Agree and turn on'" @save="toggle">
    <UAlert v-if="success" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
    <div class="space-y-3 text-base text-muted">
      <template v-if="on">
        <p>On since {{ formatExactDateTime(services!.managed_ads!.agreed_at) }}.</p>
        <p>Chris stops managing your campaigns. Today's spend is excluded if you turn this off before the day closes in your Google Ads account's time zone. Earlier managed days are still billed.</p>
        <p>Keep Google Ads connected until your prior managed spend has been counted. We count each day after two days.</p>
      </template>
      <template v-else>
        <p>{{ SERVICES.managed_ads.description }} Results stay in Insights.</p>
        <p>The fee is <strong class="text-highlighted">{{ SERVICES.managed_ads.price }}</strong>, read from Google each day and billed with your monthly KrabiClaw fees. Google bills the ad spend itself to your Google Ads account. You can turn it off here at any time.</p>
        <p>Reporting days follow your Google Ads account's time zone. A day's spend is included only if managed ads is on when that day closes.</p>
        <p>Before turning it on, connect a Google Ads account billed in USD and set up active Payments billing with a default payment method.</p>
        <div class="flex flex-wrap gap-3">
          <UButton v-if="billing && (!billing.stripeCustomerId || (usage?.configured === false && !getPlanEntitlements(billing.plan).payments))" label="Choose a plan with Payments" color="neutral" variant="outline" :to="`${parent}/plan`" />
          <UButton v-if="billing?.stripeCustomerId" label="Payment methods" color="neutral" variant="outline" :to="`${parent}/payment-methods`" />
          <UButton label="Google Ads settings" color="neutral" variant="outline" :to="`/dashboard/${route.params.orgSlug}/integrations/google-ads`" />
          <UButton label="Billing setup help" color="neutral" variant="link" to="/help" />
        </div>
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { SERVICES } from '~/shared/billing-model'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { isServices, useOrganizationBilling, useOrganizationServices, usePaymentsUsage } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Managed ads | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const dashboardApi = useDashboardApi()
const { formatExactDateTime } = useHumanTime()
// Sibling leaves under the same Payments column.
const parent = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/payments`)
const [{ servicesResource, services, refreshServices, servicesError }, { billing }, { usage }] = await Promise.all([useOrganizationServices(), useOrganizationBilling(), usePaymentsUsage()])
const on = computed(() => !!services.value?.managed_ads)
const busy = ref(false)
const error = ref('')
const success = ref('')
async function toggle() {
  if (!services.value || busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'managed_ads', action: services.value.managed_ads ? 'end' : 'agree' }, validate: isServices })
    servicesResource.value = updated
    clearNuxtData(`dashboard-integrations:${String(route.params.orgSlug)}`)
    await refreshServices()
    if (servicesError.value) {
      // Nuxt records refresh errors instead of rejecting. Keep the actual write
      // result visible, and report the failed independent read before success.
      servicesResource.value = updated
      throw new Error(`Managed ads was turned ${updated.services.managed_ads ? 'on' : 'off'}, but its status could not be refreshed. ${getErrorMessage(servicesError.value, 'Reload to check its status.')}`)
    }
    success.value = updated.services.managed_ads ? 'Managed ads is on. Chris will be in touch to set up your weekly meeting.' : 'Managed ads is off.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Managed ads could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
