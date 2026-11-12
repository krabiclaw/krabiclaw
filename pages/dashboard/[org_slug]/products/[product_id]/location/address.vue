<template>
  <LocationAddressEditor
    v-if="p.product.value?.kind === 'stay' && p.product.value.stay?.location_id && !p.loadError.value"
    :organization-id="p.organizationId"
    :location-id="p.product.value.stay.location_id"
    :lead="p.stayLocation.value ? `Every place to stay at ${p.stayLocation.value.title} uses this address.` : undefined"
    :save-to="level.to.value ?? undefined"
  />
  <DashboardLeafPanel v-else id="location-address" title="Address" :footer="false" :error="p.loadError.value || p.stayLocationError.value || ''">
    <p v-if="!p.loadError.value && !p.stayLocationError.value" role="status" class="text-muted">Loading location…</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import LocationAddressEditor from '~/lib/components/workspace/location/LocationAddressEditor.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
watchEffect(() => {
  if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showNotFound()
})
</script>
