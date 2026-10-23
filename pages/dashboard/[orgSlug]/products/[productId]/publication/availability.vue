<template>
  <DashboardLeafPanel id="product-availability" :title="label" :lead="legal ? p.product.value?.booking ? 'Your page can stay visible while consultation requests are paused.' : 'Choose whether this offering is available. This does not change whether its page is published.' : p.bookingOffering.value ? 'Your page can stay visible while bookings are paused.' : 'Your page can stay visible while orders are paused.'" :saving="p.saving.value" :disabled="p.saveDisabled.value || (!p.saveError.value && p.form.active === p.product.value?.active)" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" :desktop-cancel="p.product.value?.kind === 'stay'" @cancel="p.revert" @save="p.save(level.to.value ?? undefined, 'publication-availability')">
    <SettingRow v-if="p.product.value && !p.loadError.value" v-model="p.form.active" :label="label" :disabled="p.saving.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const legal = computed(() => p.product.value?.kind === 'service')
const label = computed(() => legal.value ? p.product.value?.booking ? 'Accept consultation requests' : 'Offering available' : p.bookingOffering.value ? 'Accept bookings' : 'Accept orders')
onBeforeRouteLeave(() => p.revert())
</script>
