<template>
  <!-- Products as tiles, each opening the one Product editor: the Menu's dishes in no section. -->
  <OrganizationLocationSelector
    :items="products.map(product => catalogProductItem(product, { collections, locations, priceLabel, to: scoped(`${catalogPath}/${product.id}`) }))"
    :active-item="activeItem"
    :label-heading-level="itemHeadingLevel"
    missing-image-label="No photo"
    missing-image-hint="Add one in this item’s photo editor."
  />
</template>

<script lang="ts">
import type { OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import type { Collection, Product } from '~/server/types/products'
import { mediaStillUrl } from '~/shared/media-placement-contract'

/** One product as a catalog tile: its sections and price, then where it is offered. */
export function catalogProductItem(product: Product, context: {
  collections: Collection[]
  locations: ReadonlyArray<{ id: string; title: string; status: string }>
  priceLabel: (product: Product) => string
  to: string
}): OrganizationLocationSelectorItem {
  return {
    id: product.id,
    label: product.name,
    eyebrow: [...product.collections.map(membership => {
      const collection = context.collections.find(row => row.id === membership.collection_id)
      if (!collection) throw createError({ statusCode: 500, statusMessage: 'An item’s section could not be loaded' })
      return collection.name
    }), context.priceLabel(product) || 'No price set'].join(' · '),
    summary: [product.booking?.held_online ? 'Online' : null, ...product.locations.map(binding => {
      const location = context.locations.find(row => row.id === binding.location_id)
      if (!location) throw createError({ statusCode: 500, statusMessage: 'An item’s location could not be loaded' })
      const status = [location.status !== 'active' ? location.status : null, !binding.published ? 'Not listed' : null, !binding.active ? 'Unavailable' : null].filter(Boolean)
      return `${location.title}${status.length ? ` (${status.join(', ')})` : ''}`
    })].filter(Boolean).join(' · ') || 'No locations set',
    imageUrl: mediaStillUrl(product.image),
    to: context.to,
  }
}
</script>

<script setup lang="ts">
import OrganizationLocationSelector from '~/components/dashboard/OrganizationLocationSelector.vue'

defineProps<{
  products: Product[]
  collections: Collection[]
  locations: ReadonlyArray<{ id: string; title: string; status: string }>
  /** What one product costs in this scope. */
  priceLabel: (product: Product) => string
  activeItem?: string | null
  itemHeadingLevel?: 2 | 3
}>()

const route = useRoute()
const router = useRouter()
const catalogPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/products`)
/** A path in this catalog's scope: the explicit location rides along, nothing else does. */
function scoped(path: string) {
  return router.resolve({ path, query: { location_id: route.query.location_id } }).fullPath
}
</script>
