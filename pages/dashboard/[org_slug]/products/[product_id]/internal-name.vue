<template>
  <DashboardLeafPanel id="product-internal-name" title="Internal name" lead="A short name for your team, used in your calendar, reservations and messages." :saving="p.saving.value" :disabled="p.saveDisabled.value" :error="p.loadError.value || p.saveError.value || ''" @cancel="p.revert" @save="p.save">
    <UInput v-if="p.product.value?.stay" v-model="p.form.internal_name" aria-label="Internal name" maxlength="240" autofocus class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
</script>
