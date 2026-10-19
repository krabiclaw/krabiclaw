<template>
  <!-- The locations the plan is billed for; Stripe shows what changes on the bill before the tenant confirms. -->
  <DashboardLeafPanel id="organization-plan-locations" title="Locations on your plan" :lead="note" :saving="busy" :disabled="!changed" :error="error" save-label="Continue to Stripe" @save="save">
    <UFormField label="Locations">
      <UInputNumber v-model="quantity" :min="minimum" :disabled="busy" class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { additionalLocationPrice, INCLUDED_LOCATIONS, isNewSalePlan } from '~/shared/billing-model'
import { useOrganizationBilling } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Locations on your plan | KrabiClaw', robots: 'noindex, nofollow' })

const dashboard = useDashboardOrganization()
const { setPlanLocations } = useOrganizationSubscription()
const { billing } = await useOrganizationBilling()
// Lowering below the locations in use would bill for fewer than the site has.
const minimum = computed(() => Math.max(INCLUDED_LOCATIONS, billing.value?.locations.used ?? INCLUDED_LOCATIONS))
const quantity = ref(Math.max(minimum.value, billing.value?.locations.covered ?? INCLUDED_LOCATIONS))
const changed = computed(() => quantity.value !== billing.value?.locations.covered)
const note = computed(() => billing.value && isNewSalePlan(billing.value.plan)
  ? `${INCLUDED_LOCATIONS} included, then ${additionalLocationPrice(billing.value.billingInterval)}. Stripe shows what changes on your bill before you confirm.`
  : 'Your existing plan and price continue. Stripe shows what changes on your bill before you confirm.')
const busy = ref(false)
const error = ref('')
async function save() {
  if (busy.value || !changed.value) return
  const organizationId = dashboard.organization.value?.id
  if (!organizationId) throw new Error('Organization context is unavailable')
  busy.value = true
  error.value = ''
  try {
    await setPlanLocations(organizationId, quantity.value)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Your plan’s locations could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
