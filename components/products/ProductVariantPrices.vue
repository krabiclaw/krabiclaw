<template>
  <dl v-if="offers.some(variant => variant.prices.length)" class="space-y-2 tabular-nums">
    <div v-for="variant in offers" :key="variant.id" class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <dt :class="offers.length === 1 ? 'sr-only' : 'font-medium'">{{ offers.length === 1 ? product.name : variant.name }}</dt>
      <dd class="flex flex-wrap gap-x-5 gap-y-1">
        <span v-for="price in variant.prices" :key="price.lowest!.currency">
          <span v-if="price.count === 1 && price.lowest!.compare_at_unit_amount !== null" class="mr-2 text-muted line-through">{{ formatProductMoney({ ...price.lowest!, unit_amount: price.lowest!.compare_at_unit_amount! }, locale) }}</span>
          {{ formatProductPriceRange(price, locale) }} <span v-if="variant.prices.length > 1" class="text-xs text-muted">{{ price.lowest!.currency }}</span>
        </span>
        <span v-if="!variant.prices.length" class="text-muted">{{ t('booking.price_unavailable') }}</span>
      </dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import type { PublicProduct } from '~/server/types/products'
import type { CurrencyCode } from '~/shared/currencies'
import { formatProductMoney, formatProductPriceRange, summarizeProductPrices } from '~/utils/product-money'

const props = defineProps<{ product: PublicProduct; locationIds: (string | null)[]; currency: CurrencyCode }>()
const { t, locale } = useI18n()
const offers = computed(() => {
  const at = new Date().toISOString()
  return props.product.variants.filter(variant => variant.active).map(variant => ({
    id: variant.id,
    name: variant.name,
    prices: [...new Set([props.currency, ...variant.prices.filter(price => price.active).map(price => price.currency)])]
      .map(currency => summarizeProductPrices([variant], props.locationIds.map(location_id => ({ currency, location_id, at }))))
      .filter(price => price.lowest !== null),
  }))
})
</script>
