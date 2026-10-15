<template>
  <DashboardLeafPanel id="product-availability" title="Accept bookings or orders" lead="Pause bookings or orders whenever you need to. Its information can stay on your website." :saving="p.saving.value" :disabled="p.saveDisabled.value" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" @cancel="p.revert" @save="p.save">
    <SettingRow v-if="p.isNew.value || p.product.value" v-model="p.form.active" :label="p.form.kind === 'experience' || p.form.kind === 'service' || p.form.kind === 'stay' ? 'Accept bookings' : 'Accept orders'" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
</script>
