<template>
  <DashboardLeafPanel id="product-visibility" title="Status" lead="Choose whether customers can see this offering on your website." :saving="p.saving.value" :disabled="p.saveDisabled.value" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" @cancel="p.revert" @save="p.save">
    <SettingRow v-if="p.isNew.value || p.product.value" v-model="p.form.published" label="Published" description="When published, customers can find and book this offering on your website." />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
</script>
