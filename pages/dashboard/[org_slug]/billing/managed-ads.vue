<template>
  <DashboardLeafPanel
    id="organization-managed-ads"
    :title="SERVICES.managed_ads.name"
    :footer="dashboard.canUpdateBilling.value && (on || met || next?.action === 'payment')"
    :saving="busy"
    :disabled="!services"
    :error="error || (servicesError ? getErrorMessage(servicesError, 'The service could not be loaded') : '') || (requirementsError ? getErrorMessage(requirementsError, 'What managed ads needs could not be checked') : '')"
    :save-label="on ? 'Turn off' : next?.action === 'payment' ? next.label : 'Agree and turn on'"
    @save="next?.action === 'payment' && !on ? addPaymentMethod() : toggle()"
  >
    <div class="mx-auto max-w-2xl space-y-6 pb-6">
      <UAlert v-if="success" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
      <BillingServiceIntro :offer="serviceOffer" :price="priceLine" />
      <p v-if="!dashboard.canUpdateBilling.value" class="text-sm text-muted">Owners turn services on and off.</p>
      <div v-if="on" class="space-y-3 rounded-2xl border border-default p-5 text-sm text-toned">
        <p class="font-semibold text-highlighted">On since {{ formatExactDateTime(services!.managed_ads!.agreed_at) }}</p>
        <p>{{ SERVICES.managed_ads.ending }}</p>
      </div>
      <template v-else-if="dashboard.canUpdateBilling.value">
        <div v-if="next" class="space-y-3 rounded-2xl border border-default p-5">
          <p class="text-sm text-toned">{{ next.detail }}</p>
          <UButton v-if="next.to" :to="next.to" :label="next.label" trailing-icon="i-lucide-arrow-right" />
        </div>
        <p v-else-if="met" class="text-sm text-toned">{{ SERVICES.managed_ads.consent }}</p>
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BillingServiceIntro from '~/components/dashboard/BillingServiceIntro.vue'
import { offer } from '~/shared/offers'
import { SERVICES } from '~/shared/billing-model'
import { isServices, useOrganizationServices } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Managed ads | KrabiClaw', robots: 'noindex, nofollow' })

type Requirements = { google_ads_usd: boolean; business_plan: boolean; default_payment_method: boolean }
const isRequirements = (value: unknown): value is { success: true; requirements: { managed_ads: Requirements } } => {
  if (!isRecord(value) || value.success !== true || !isRecord(value.requirements)) return false
  const state = value.requirements.managed_ads
  return isRecord(state) && ['google_ads_usd', 'business_plan', 'default_payment_method'].every(key => typeof state[key] === 'boolean')
}

const route = useRoute()
const serviceOffer = offer('managed_ads')
const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const { openBillingPortal } = useOrganizationSubscription()
const { formatExactDateTime } = useHumanTime()
const orgSlug = String(route.params.org_slug)
const [{ servicesResource, services, refreshServices, servicesError }, { data: checked, error: requirementsError, refresh: refreshRequirements }] = await Promise.all([
  useOrganizationServices(),
  useAsyncData(`dashboard-services-requirements:${orgSlug}`, () => dashboardApi('/api/dashboard/services', { query: { requirements: 'managed_ads' }, validate: isRequirements })),
])
const on = computed(() => !!services.value?.managed_ads)
const requirements = computed(() => checked.value?.requirements.managed_ads ?? null)
const met = computed(() => !!requirements.value && Object.values(requirements.value).every(Boolean))
const priceLine = `${SERVICES.managed_ads.price[0]!.toUpperCase()}${SERVICES.managed_ads.price.slice(1)}, added to your plan's invoice.`

const base = `/dashboard/${encodeURIComponent(orgSlug)}`
const next = computed(() => {
  const state = requirements.value
  if (!state) return null
  if (!state.google_ads_usd) return {
    label: 'Connect Google Ads', detail: 'Choose the Google Ads account you want Chris to manage. Managed ads uses accounts billed in USD.',
    to: `${base}/integrations/google-ads?service=managed-ads`,
  }
  if (!state.business_plan) return {
    label: 'Review Business plan', detail: 'Business includes the billing support for managed ads.',
    to: `${base}/billing/upgrade?service=managed-ads`,
  }
  if (!state.default_payment_method) return {
    action: 'payment', label: 'Add payment method', detail: 'Save a default payment method for your plan in Stripe.',
  }
  return null
})
const busy = ref(false)
const error = ref('')
const success = ref('')
async function addPaymentMethod() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await openBillingPortal()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Stripe’s billing portal could not be opened')
  } finally {
    busy.value = false
  }
}
async function toggle() {
  if (!services.value || busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'managed_ads', action: services.value.managed_ads ? 'end' : 'agree' }, validate: isServices })
    servicesResource.value = updated
    clearNuxtData(`dashboard-integrations:${orgSlug}`)
    await Promise.all([refreshServices(), refreshRequirements()])
    if (servicesError.value || requirementsError.value) {
      // Nuxt records refresh errors instead of rejecting. Keep the actual write
      // result visible, and report the failed independent read before success.
      servicesResource.value = updated
      throw new Error(`Managed ads was turned ${updated.services.managed_ads ? 'on' : 'off'}, but its status could not be refreshed. ${getErrorMessage(servicesError.value || requirementsError.value, 'Reload to check its status.')}`)
    }
    success.value = updated.services.managed_ads ? 'Managed ads is on. Chris will be in touch to set up your weekly meeting.' : 'Managed ads is off.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Managed ads could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
