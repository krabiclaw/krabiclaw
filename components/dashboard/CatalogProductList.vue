<template>
  <!--
    Everything in Catalog's scope, whatever its kind — dishes, experiences,
    services and products in one list, the way Airbnb's Listings holds homes and
    experiences. Every row opens the one Product editor.
  -->
  <div>
    <div v-if="!fixedKind" class="mb-6 flex flex-wrap items-center gap-2">
      <UButton
        v-for="filter in kindFilters"
        :key="filter.value"
        :to="filterTo(filter.value)"
        :label="filter.label"
        size="sm"
        color="neutral"
        :variant="kind === filter.value ? 'solid' : 'outline'"
        class="rounded-full"
        :aria-pressed="kind === filter.value"
      />
    </div>

    <p v-if="!rows.length" class="py-5 text-sm text-muted">No {{ activeFilterLabel.toLowerCase() }} yet.</p>
    <OrganizationLocationSelector
      v-else
      :items="items"
      :active-item="activeItem"
      :label-heading-level="itemHeadingLevel"
      rows-on-mobile
      missing-image-label="No photo"
      missing-image-hint="Add one in this item’s photo editor."
    />
  </div>
</template>

<script setup lang="ts">
import OrganizationLocationSelector, { type OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import type { Collection, Product } from '~/server/types/products'
import { PRODUCT_KINDS, type ProductKind } from '~/shared/product-details'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const props = defineProps<{
  products: Product[]
  collections: Collection[]
  locations: ReadonlyArray<{ id: string; title: string; status: string }>
  /** The list's own path, which the kind filters link to. */
  path: string
  /** What one product costs in this scope. */
  priceLabel: (product: Product) => string
  activeItem?: string | null
  /** A list of one kind — Experiences, Services — with no kind filters of its own. */
  fixedKind?: ProductKind
  itemHeadingLevel?: 2 | 3
}>()

const route = useRoute()
const router = useRouter()
const catalogPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/products`)

// Kind is the product's own, so the filters are kinds, named the same on every
// template. `item` is the generic kind and reads as Products.
const KIND_FILTER_LABELS: Record<ProductKind, string> = { dish: 'Menu items', experience: 'Experiences', service: 'Services', item: 'Products', stay: 'Places to stay' }
const kind = computed<ProductKind | 'all'>(() => props.fixedKind ?? (PRODUCT_KINDS.includes(route.query.kind as ProductKind) ? route.query.kind as ProductKind : 'all'))
// A filter for every kind this catalog holds; a kind nobody sells is not a choice.
const kindFilters = computed(() => [
  { value: 'all' as const, label: 'All' },
  ...PRODUCT_KINDS.filter(value => value === kind.value || props.products.some(product => product.kind === value)).map(value => ({ value, label: KIND_FILTER_LABELS[value] })),
])
const activeFilterLabel = computed(() => kind.value === 'all' ? 'Products' : KIND_FILTER_LABELS[kind.value])

/** A path in this catalog's scope: the explicit location and kind ride along, nothing else does. */
function scoped(path: string, query: Record<string, string | undefined> = {}) {
  return router.resolve({ path, query: { location_id: route.query.location_id, ...query } }).fullPath
}
function filterTo(value: ProductKind | 'all') {
  return scoped(props.path, { kind: value === 'all' ? undefined : value })
}

// The server orders by name.
const rows = computed(() => props.products.filter(product => kind.value === 'all' || product.kind === kind.value))
const items = computed<OrganizationLocationSelectorItem[]>(() => rows.value.map(product => ({
    id: product.id,
    label: product.name,
    eyebrow: [...product.collections.map(membership => {
      const collection = props.collections.find(row => row.id === membership.collection_id)
      if (!collection) throw createError({ statusCode: 500, statusMessage: 'An item’s section could not be loaded' })
      return collection.name
    }), props.priceLabel(product) || 'No price set'].join(' · '),
    summary: [product.booking?.held_online ? 'Online' : null, ...product.locations.map(binding => {
      const location = props.locations.find(row => row.id === binding.location_id)
      if (!location) throw createError({ statusCode: 500, statusMessage: 'An item’s location could not be loaded' })
      const status = [location.status !== 'active' ? location.status : null, !binding.published ? 'Not listed' : null, !binding.active ? 'Unavailable' : null].filter(Boolean)
      return `${location.title}${status.length ? ` (${status.join(', ')})` : ''}`
    })].filter(Boolean).join(' · ') || 'No locations set',
    imageUrl: mediaStillUrl(product.image),
    to: scoped(`${catalogPath.value}/${product.id}`),
  })))
</script>
