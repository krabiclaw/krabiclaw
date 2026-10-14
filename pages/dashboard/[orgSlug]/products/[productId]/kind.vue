<template>
  <DashboardLeafPanel id="product-kind" title="Type" lead="Choose what customers are buying. Each type has its own useful details." :saving="p.saving.value" :disabled="p.saveDisabled.value" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" @cancel="p.revert" @save="p.save">
    <URadioGroup v-if="p.isNew.value || p.product.value" v-model="p.form.kind" :items="items" variant="card" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
// A place to stay keeps its kind, and nothing else becomes one: its location and
// stays are held by the kind, so the choice is made once, when it is created.
const items = computed(() => [
  { value: 'dish', label: 'Food or drink' },
  { value: 'experience', label: 'Experience or class' },
  { value: 'service', label: 'Service or appointment' },
  { value: 'item', label: 'Physical item' },
  { value: 'stay', label: 'Place to stay' },
].filter(item => p.isNew.value || (item.value === 'stay') === (p.product.value?.kind === 'stay')))
</script>
