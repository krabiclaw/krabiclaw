<template>
  <DashboardLeafPanel id="product-availability" :title="p.bookingOffering.value ? 'Accept bookings' : 'Accept orders'" :lead="p.bookingOffering.value ? 'Your page can stay visible while bookings are paused.' : 'Your page can stay visible while orders are paused.'" :saving="p.saving.value" :disabled="p.saveDisabled.value || (!p.saveError.value && p.form.active === p.product.value?.active)" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" :desktop-cancel="p.product.value?.kind === 'stay'" @cancel="p.revert" @save="p.save(level.to.value ?? undefined, 'publication-availability')">
    <SettingRow v-if="p.product.value && !p.loadError.value" v-model="p.form.active" :label="p.bookingOffering.value ? 'Accept bookings' : 'Accept orders'" :disabled="p.saving.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
onBeforeRouteLeave(() => p.revert())
</script>
