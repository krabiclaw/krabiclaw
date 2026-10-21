<template>
  <!-- The price of one combination: what a customer actually buys. -->
  <DashboardLeafPanel
    id="product-combination-price"
    :title="variant?.name ?? ''"
    :lead="p.locationId.value ? `Set the price at ${priceLocationName}. Leave the amount empty to use the shared price, if one is set.` : 'Set the shared price for this option.'"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <UButton v-if="p.saveError.value" label="Use saved details" color="neutral" variant="outline" :disabled="p.saving.value" class="mb-5" @click="p.revert()" />
    <UFormField v-if="variant" :label="`Amount (${p.currency})`">
      <UInput v-model="variant.price_major" inputmode="decimal" autofocus class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
// The saved variant's id, never the label its choices happen to spell.
const variant = computed(() => p.form.variants.find(entry => entry.id === String(route.params.variantId)) ?? null)
const priceLocationName = computed(() => p.organizationLocations.value.find(location => location.id === p.locationId.value)?.title ?? 'this location')

watchEffect(() => {
  if (p.product.value && !p.loadError.value && !variant.value) showError(createError({ statusCode: 404, statusMessage: 'Combination not found' }))
})
</script>
