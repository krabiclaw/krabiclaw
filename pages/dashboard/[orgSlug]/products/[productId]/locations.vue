<template>
  <!--
    Where this product is offered: one row per location, each previewing whether
    it is shown and taking orders or bookings there, each opening its own leaf.
    A location keeps its own address and hours; this edits only the product's
    relationship to it.
  -->
  <DashboardIndexPanel id="product-locations" :title="p.sectionLabels['locations']">
    <UAlert v-if="p.organizationLocationsError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.organizationLocationsError.value" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const paused = computed(() => p.form.bookable || p.form.kind === 'service' ? 'Bookings paused' : 'Orders paused')
function summary(locationId: string) {
  const entry = p.form.locations[locationId]
  if (!entry) return 'Not offered here'
  return [entry.published ? 'Visible at this location' : 'Hidden at this location', ...(entry.active ? [] : [paused.value])].join(' · ')
}
const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'locations',
  items: p.organizationLocations.value.map(location => ({
    id: location.id,
    label: location.title,
    icon: 'i-lucide-map-pin',
    summary: summary(location.id),
    placeholder: !p.form.locations[location.id],
    to: p.sectionPath(`locations/${encodeURIComponent(location.id)}`),
  })),
}])
</script>
