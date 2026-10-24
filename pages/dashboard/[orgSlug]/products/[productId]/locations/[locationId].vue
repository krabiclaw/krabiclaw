<template>
  <DashboardLeafPanel
    id="product-location"
    :title="location?.title ?? ''"
    :lead="legal ? 'Choose whether this offering is visible and available at this office. Edit the office’s address and hours in Offices.' : 'Choose whether this location shows it and takes orders or bookings for it. The location’s own address and hours stay as they are.'"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <template v-if="p.product.value && entry">
      <SettingRow v-model="entry.published" :label="legal ? 'Show at this office' : 'Show at this location'" />
      <SettingRow v-model="entry.active" :label="legal ? 'Available at this office' : 'Accept at this location'" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const legal = computed(() => p.product.value?.kind === 'service')
const locationId = computed(() => String(route.params.locationId))
const location = computed(() => p.allOrganizationLocations.value.find(entry => entry.id === locationId.value && (entry.status === 'active' || p.product.value?.locations.some(placement => placement.location_id === entry.id))) ?? null)
// A location the product is not offered at starts off on both switches; saving
// is what offers it there.
watchEffect(() => {
  if (p.product.value && location.value && !p.form.locations[locationId.value]) p.form.locations[locationId.value] = { active: false, published: false }
})
const entry = computed(() => (location.value ? p.form.locations[locationId.value] ?? null : null))

// A location this organization does not have is not a page.
watchEffect(() => {
  if (level.mode.value === 'yield' || !p.product.value || p.loadError.value || p.organizationLocationsError.value) return
  if (p.allOrganizationLocations.value.length && !location.value) showError(createError({ statusCode: 404, statusMessage: 'Location not found' }))
})
</script>
