<template>
  <DashboardLeafPanel
    id="product-combination-price"
    :title="p.locationId.value ? priceLocation ? `Price at ${priceLocation.title}` : 'Price' : p.form.variants.length === 1 ? 'Shared price' : `${variant?.name ?? ''} · Shared price`"
    :lead="p.locationId.value ? priceLocation ? `Set the price at ${priceLocation.title}. Leave the amount empty to use the shared price, if one is set.` : undefined : p.form.variants.length === 1 ? `Set an amount, or use price wording such as ${priceExample}. Leave both empty to show no shared price.` : 'Set the shared price for this choice.'"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || Boolean(priceScopeError)"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || priceScopeError || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <UButton v-if="p.saveError.value" label="Use saved details" color="neutral" variant="outline" :disabled="p.saving.value" class="mb-5" @click="p.revert()" />
    <div v-if="variant && !priceScopeError" class="space-y-5">
      <UFormField :label="`Amount (${p.currency})`">
        <UInput v-model="variant.price_major" inputmode="decimal" autofocus class="w-full" data-testid="product-price" />
      </UFormField>
      <UFormField v-if="p.form.kind !== 'stay' && p.form.variants.length === 1" :label="p.locationId.value ? 'Price wording (all locations)' : 'Price wording'" hint="Optional">
        <UInput :model-value="p.textValue(priceWording)" :placeholder="priceExample" class="w-full" @update:model-value="p.setDetail(priceWording, $event)" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_DETAIL_FIELDS } from '~/shared/product-details'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const variant = computed(() => p.form.variants.find(entry => entry.id === String(route.params.variantId)) ?? null)
const priceLocation = computed(() => p.allOrganizationLocations.value.find(location => location.id === p.locationId.value) ?? null)
const priceScopeError = computed(() => p.locationId.value ? p.organizationLocationsError.value || (!priceLocation.value ? 'The price location could not be loaded.' : '') : '')
const priceExample = computed(() => p.form.kind === 'dish' ? 'Market price' : 'Price on request')
const priceWording = PRODUCT_DETAIL_FIELDS.find(field => field.key === 'pricing_note')!

watchEffect(() => {
  if (p.product.value && !p.loadError.value && !variant.value) showError(createError({ statusCode: 404, statusMessage: 'Choice not found' }))
})
</script>
