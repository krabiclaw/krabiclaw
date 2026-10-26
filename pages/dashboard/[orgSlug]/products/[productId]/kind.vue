<template>
  <DashboardLeafPanel id="product-kind" title="Type" lead="Choose what customers are buying. Each type has its own useful details." :desktop-cancel="!p.isNew.value" :saving="p.saving.value" :disabled="p.saveDisabled.value" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" @cancel="p.revert" @save="p.save">
    <URadioGroup v-if="p.isNew.value || p.product.value" v-model="selectedKind" :items="items" variant="card" indicator="hidden" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { PRODUCT_KINDS, PRODUCT_KIND_LABELS, PRODUCT_KIND_ICONS } from '~/shared/product-details'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
// A place to stay keeps its kind, and nothing else becomes one: its location and
// stays are held by the kind, so the choice is made once, when it is created.
// The server refuses either change, so neither is offered.
const items = computed(() => PRODUCT_KINDS.filter(value => p.isNew.value || (value === 'stay') === (p.product.value?.kind === 'stay')).map(value => ({ value, label: PRODUCT_KIND_LABELS[value], icon: PRODUCT_KIND_ICONS[value] })))
const selectedKind = computed({
  get: () => p.form.kind || undefined,
  set: val => { p.form.kind = val ?? '' },
})
</script>
