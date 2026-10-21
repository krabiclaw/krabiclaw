<template>
  <DashboardLeafPanel id="product-location-description" :title="definition?.name ?? 'Location'" :saving="p.saving.value" :disabled="p.saveDisabled.value || !definition || value.length > PRODUCT_LIMITS.description" :error="p.loadError.value || p.saveError.value || ''" desktop-cancel @cancel="p.revert" @save="p.save(level.to.value ?? undefined)">
    <template v-if="definition && p.product.value && !p.loadError.value">
      <p class="mb-2 text-sm font-semibold text-muted">{{ PRODUCT_LIMITS.description - value.length }}/{{ PRODUCT_LIMITS.description }} available</p>
      <UTextarea v-model="value" :aria-label="definition.name" :rows="10" :maxlength="PRODUCT_LIMITS.description" :disabled="p.saving.value" autofocus class="w-full" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { productDetailFields, STAY_LOCATION_DETAIL_KEYS } from '~/shared/product-details'
import { PRODUCT_LIMITS } from '~/shared/product-limits'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const definition = computed(() => productDetailFields('stay').find(field => STAY_LOCATION_DETAIL_KEYS.some(key => key === field.key) && field.key === route.params.field))
const value = computed({ get: () => definition.value ? p.textValue(definition.value) : '', set: text => { if (definition.value) p.setDetail(definition.value, text) } })
watchEffect(() => {
  if (p.product.value && !p.loadError.value && (p.product.value.kind !== 'stay' || !definition.value)) showNotFound()
})
onBeforeRouteLeave(() => p.revert())
onBeforeRouteUpdate((to, from) => { if (to.params.field !== from.params.field) p.revert() })
</script>
