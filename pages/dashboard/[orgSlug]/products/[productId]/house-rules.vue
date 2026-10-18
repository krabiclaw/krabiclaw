<template>
  <DashboardLeafPanel
    id="product-house-rules"
    title="House rules"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <template v-if="definition && p.product.value">
      <UTextarea :model-value="p.textValue(definition)" aria-label="House rules" :rows="12" :maxlength="PRODUCT_LIMITS.description" :disabled="p.saving.value" autofocus class="w-full" @update:model-value="p.setDetail(definition, $event)" />
      <p class="mt-2 text-sm text-muted">{{ p.textValue(definition).length }}/{{ PRODUCT_LIMITS.description }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { PRODUCT_LIMITS } from '~/shared/product-limits'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const definition = computed(() => p.definitions.value.find(field => field.key === 'house_rules'))
onBeforeRouteLeave(() => p.revert())
</script>
