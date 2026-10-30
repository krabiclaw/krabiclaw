<template>
  <!--
    Managed ads: what Chris does and what it costs, then what agreeing needs as
    rows that each say where they stand and open where they are met. The
    consent appears once every row holds; until then the line under the rows
    says what is left. The same leaf turns it off.
  -->
  <DashboardLeafPanel
    id="organization-managed-ads"
    :title="SERVICES.managed_ads.name"
    :footer="dashboard.canUpdateBilling.value && (on || met)"
    :saving="busy"
    :disabled="!services"
    :error="error || (servicesError ? getErrorMessage(servicesError, 'The service could not be loaded') : '') || (requirementsError ? getErrorMessage(requirementsError, 'What managed ads needs could not be checked') : '')"
    :save-label="on ? 'Turn off' : 'Agree and turn on'"
    @save="toggle"
  >
    <UAlert v-if="success" class="mb-6" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
    <p v-if="!dashboard.canUpdateBilling.value" class="mb-6 text-sm text-muted">Owners turn services on and off.</p>
    <p class="text-base text-highlighted">{{ SERVICES.managed_ads.description }} Results stay in Insights.</p>
    <p class="mt-4 text-base font-semibold text-highlighted">{{ priceLine }}</p>
    <div v-if="on" class="mt-6 space-y-3 text-sm text-muted">
      <p>On since {{ formatExactDateTime(services!.managed_ads!.agreed_at) }}.</p>
      <p>{{ SERVICES.managed_ads.ending }}</p>
    </div>
    <template v-else-if="requirements">
      <EditorNavigationList class="mt-6" :groups="[{ id: 'requirements', items: requirementRows }]" @act="act" />
      <p v-if="!met" class="mt-6 text-sm text-muted">{{ outstanding }}</p>
      <p v-else class="mt-6 text-sm text-muted">{{ SERVICES.managed_ads.consent }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { SERVICES } from '~/shared/billing-model'
import { isServices, useOrganizationBilling, useOrganizationServices } from '~/composables/usePaymentsSettings'

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
const { plans } = await usePlans()
const [{ servicesResource, services, refreshServices, servicesError }, { billing }, { data: checked, error: requirementsError, refresh: refreshRequirements }] = await Promise.all([
  useOrganizationServices(),
  useOrganizationBilling(),
  useAsyncData(`dashboard-services-requirements:${orgSlug}`, () => dashboardApi('/api/dashboard/services', { query: { requirements: 'managed_ads' }, validate: isRequirements })),
])
const on = computed(() => !!services.value?.managed_ads)
const requirements = computed(() => checked.value?.requirements.managed_ads ?? null)
const met = computed(() => !!requirements.value && Object.values(requirements.value).every(Boolean))
const priceLine = `${SERVICES.managed_ads.price[0]!.toUpperCase()}${SERVICES.managed_ads.price.slice(1)}, added to your plan's invoice.`

// Each row names where it stands: a check once it holds, an open circle until
// then, and a chevron only where there is somewhere to go to meet it.
const row = (id: string, label: string, holds: boolean, state: string, open: Pick<EditorNavigationItem, 'to' | 'action'>): EditorNavigationItem =>
  ({ id, label, summary: state, mark: holds ? 'met' : 'open', ...(holds || !dashboard.canUpdateBilling.value ? {} : open) })
const currentPlan = computed(() => billing.value?.subscriptionPrice?.name ?? plans.value.find(plan => plan.id === billing.value?.plan)?.name ?? 'your plan')
const requirementRows = computed<EditorNavigationItem[]>(() => {
  const state = requirements.value
  if (!state) return []
  return [
    row('google-ads', 'Google Ads', state.google_ads_usd, state.google_ads_usd ? 'Connected, billed in USD' : 'Not connected in USD', { to: `/dashboard/${encodeURIComponent(orgSlug)}/integrations/google-ads` }),
    row('business-plan', 'Business plan', state.business_plan, state.business_plan ? 'On Business' : `On ${currentPlan.value}`, { to: level.to.value ? `${level.to.value}/upgrade` : undefined }),
    // Stripe's portal needs the plan's customer, which only a paid plan has.
    row('payment-method', 'Default payment method', state.default_payment_method, state.default_payment_method ? 'Saved' : 'None saved', state.business_plan ? { action: { opens: true } } : {}),
  ]
})
// What is left, in the footer where the consent will be.
const outstanding = computed(() => {
  const state = requirements.value
  if (!state) return ''
  const left = [
    ...(state.google_ads_usd ? [] : ['connect Google Ads in USD']),
    ...(state.business_plan ? [] : ['upgrade to Business']),
    ...(state.default_payment_method ? [] : ['add a payment method']),
  ]
  const list = left.length > 1 ? `${left.slice(0, -1).join(', ')} and ${left.at(-1)}` : left[0] ?? ''
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} to turn this on.`
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
