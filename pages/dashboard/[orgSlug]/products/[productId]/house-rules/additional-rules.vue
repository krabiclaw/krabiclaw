<template>
  <DashboardLeafPanel
    id="product-additional-rules"
    title="Additional rules"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || value.length > PRODUCT_LIMITS.description"
    :error="p.loadError.value || p.saveError.value || ''"
    desktop-cancel
    @cancel="p.revert('additional-rules')"
    @save="p.save(level.to.value ?? undefined, 'additional-rules')"
  >
    <template v-if="p.product.value?.kind === 'stay' && !p.loadError.value">
      <UTextarea v-model="value" aria-label="Additional rules" :rows="12" :maxlength="PRODUCT_LIMITS.description" :disabled="p.saving.value" autofocus class="w-full" />
      <p class="mt-2 text-sm text-muted">{{ value.length }}/{{ PRODUCT_LIMITS.description }}</p>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { PRODUCT_LIMITS } from '~/shared/product-limits'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const value = computed({
  get: () => typeof p.form.details.house_rules === 'string' ? p.form.details.house_rules : '',
  set: (text: string) => {
    if (text.trim()) p.form.details.house_rules = text
    else Reflect.deleteProperty(p.form.details, 'house_rules')
  },
})
onBeforeRouteLeave(() => p.revert('additional-rules'))
</script>
