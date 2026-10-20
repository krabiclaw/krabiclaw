<template>
  <DashboardLeafPanel
    id="product-price"
    :lead="stayPrice ? 'Your base price for one night.' : 'Set an amount, or use price wording such as Market price. Leave both empty to show no price.'"
    :title="stayPrice ? 'Nightly price' : p.sectionLabels['price']"
    :desktop-cancel="stayPrice"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <!-- One price, on the one thing being bought. A product with options prices each combination under Options. -->
    <div v-if="p.isNew.value || p.product.value" class="space-y-5">
      <template v-if="p.form.variants.length === 1">
        <UFormField :label="`${stayPrice ? 'Per night' : 'Amount'} (${p.currency})`">
          <UInput v-model="p.form.variants[0]!.price_major" inputmode="decimal" placeholder="280" class="w-full" :ui="stayPrice ? { base: 'py-6 text-4xl text-center font-semibold' } : undefined" data-testid="product-price" />
        </UFormField>
        <UFormField v-if="!stayPrice" label="Price wording" hint="Optional">
          <UInput :model-value="p.textValue(priceWording)" placeholder="Market price" class="w-full" @update:model-value="p.setDetail(priceWording, $event)" />
        </UFormField>
      </template>
      <UAlert
        v-else
        color="neutral"
        variant="soft"
        icon="i-lucide-list"
        title="This has multiple variants"
        description="Each variant has its own price. Edit them under Variants."
      />
      <UButton
        v-if="stayPrice && p.product.value && !p.loadError.value"
        :to="{ name: 'dashboard-orgSlug-calendar', params: { orgSlug: String(route.params.orgSlug) }, query: { product_id: p.product.value.id } }"
        label="Open nightly calendar"
        icon="i-lucide-calendar-days"
        color="neutral"
        variant="outline"
      />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_DETAIL_FIELDS } from '~/shared/product-details'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const stayPrice = computed(() => p.form.kind === 'stay')
const priceWording = PRODUCT_DETAIL_FIELDS.find(field => field.key === 'pricing_note')!
</script>
