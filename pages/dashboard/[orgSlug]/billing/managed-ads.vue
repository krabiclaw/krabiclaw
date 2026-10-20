<template>
  <!--
    Managed ads: what Chris does, its price, then what agreeing needs as ✓/✗
    rows — each unmet one opens where it is met — and the consent that starts
    the fee, enabled only when every row holds. The same leaf turns it off.
  -->
  <DashboardLeafPanel
    id="organization-managed-ads"
    :title="SERVICES.managed_ads.name"
    :lead="SERVICES.managed_ads.description"
    :footer="dashboard.canUpdateBilling.value"
    :saving="busy"
    :disabled="!services || (!on && !met)"
    :error="error || (requirementsError ? getErrorMessage(requirementsError, 'What managed ads needs could not be checked') : '')"
    :save-label="on ? 'Turn off' : 'Agree and turn on'"
    @save="toggle"
  >
    <UAlert v-if="success" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-base text-muted">Owners turn services on and off.</p>
    <div class="space-y-3 text-base text-muted">
      <p class="font-medium text-highlighted">{{ priceLine }}</p>
      <template v-if="on">
        <p>On since {{ formatExactDateTime(services!.managed_ads!.agreed_at) }}.</p>
        <p>Turning it off stops Chris managing your campaigns. Today's spend is excluded if you turn it off before the day closes in your Google Ads account's time zone; earlier managed days are still billed.</p>
        <p>Keep Google Ads connected until your earlier managed spend has been counted. We count each day after two days.</p>
      </template>
    </div>
    <template v-if="!on && requirements">
      <EditorNavigationList class="mt-6" :groups="[{ id: 'requirements', items: requirementRows }]" @act="act" />
      <p v-if="met" class="mt-6 text-base text-muted">By turning it on you agree to {{ SERVICES.managed_ads.price }}, read from Google each day and billed on your plan's invoice. Google bills the ad spend itself to your Google Ads account.</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
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
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const { openBillingPortal } = useOrganizationSubscription()
const { formatExactDateTime } = useHumanTime()
const orgSlug = String(route.params.orgSlug)
const [{ servicesResource, services, refreshServices, servicesError }, { data: checked, error: requirementsError, refresh: refreshRequirements }] = await Promise.all([
  useOrganizationServices(),
  useAsyncData(`dashboard-services-requirements:${orgSlug}`, () => dashboardApi('/api/dashboard/services', { query: { requirements: 'managed_ads' }, validate: isRequirements })),
])
const on = computed(() => !!services.value?.managed_ads)
const requirements = computed(() => checked.value?.requirements.managed_ads ?? null)
const met = computed(() => !!requirements.value && Object.values(requirements.value).every(Boolean))
const priceLine = `${SERVICES.managed_ads.price[0]!.toUpperCase()}${SERVICES.managed_ads.price.slice(1)}, added to your plan's invoice.`

// Each row says whether it holds; one that does not opens where it is met.
const row = (id: string, label: string, holds: boolean, open: Pick<EditorNavigationItem, 'to' | 'action'>): EditorNavigationItem =>
  ({ id, label, icon: holds ? 'i-lucide-check' : 'i-lucide-x', summary: holds ? 'Done' : 'Not yet', ...(holds || !dashboard.canUpdateBilling.value ? {} : open) })
const requirementRows = computed<EditorNavigationItem[]>(() => {
  const state = requirements.value
  if (!state) return []
  return [
    row('google-ads', 'Google Ads account connected (USD)', state.google_ads_usd, { to: `/dashboard/${encodeURIComponent(orgSlug)}/integrations/google-ads` }),
    row('business-plan', 'Business plan', state.business_plan, { to: level.to.value ? `${level.to.value}/upgrade` : undefined }),
    // Stripe's portal needs the plan's customer, which only a paid plan has.
    row('payment-method', 'Default payment method', state.default_payment_method, state.business_plan ? { action: { label: 'Add' } } : {}),
  ]
})

const busy = ref(false)
const error = ref('')
const success = ref('')
async function act(id: string) {
  if (id !== 'payment-method' || busy.value) return
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
