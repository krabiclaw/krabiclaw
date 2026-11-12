<template>
  <DashboardIndexPanel id="product-publication" :title="isStay ? 'Listing status' : p.sectionLabels.publication" column="leaf">
    <UAlert v-if="p.loadError.value || p.saveError.value" color="error" variant="soft" :description="p.loadError.value || p.saveError.value || ''" class="mb-6" />
    <EditorNavigationList v-if="p.product.value && !p.loadError.value" :groups="groups" :active-item="level.child.value" :variant="isStay ? 'cards' : 'rows'" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const isStay = computed(() => p.product.value?.kind === 'stay')
const legal = computed(() => p.product.value?.kind === 'service')
const groups = computed(() => [{ id: 'website', items: [
  { id: 'visibility', label: isStay.value ? 'Listing status' : 'Show on website', summary: isStay.value ? (p.published.value ? 'Listed · Visible on your website' : 'Unlisted · Hidden from your website') : p.published.value ? `Visible to ${legal.value ? 'clients' : 'customers'}` : `Hidden from ${legal.value ? 'clients' : 'customers'}`, status: isStay.value ? (p.published.value ? 'success' as const : 'neutral' as const) : undefined, to: p.sectionPath('publication/visibility') },
  ...(!legal.value || p.product.value?.booking ? [{ id: 'availability', label: legal.value ? 'Accept consultation requests' : p.bookingOffering.value ? 'Accept bookings' : 'Accept orders', summary: legal.value ? p.product.value?.active ? 'Accepting consultation requests' : 'Consultation requests paused' : p.product.value?.active ? (p.bookingOffering.value ? 'Accepting new bookings' : 'Accepting new orders') : (p.bookingOffering.value ? 'Bookings paused' : 'Orders paused'), to: p.sectionPath('publication/availability') }] : []),
] }])
</script>
