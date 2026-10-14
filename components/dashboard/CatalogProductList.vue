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

    <div v-if="!rows.length" class="rounded-2xl border border-default bg-elevated px-6 py-20 text-center">
      <UIcon name="i-lucide-layout-grid" class="mx-auto size-6 text-muted" />
      <h2 class="mt-5 text-base font-semibold text-highlighted">No {{ activeFilterLabel.toLowerCase() }} yet</h2>
    </div>
    <EditorNavigationList v-else :groups="groups" :active-item="activeItem" />
  </div>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import type { Product } from '~/server/types/products'
import { PRODUCT_KINDS, PRODUCT_KIND_LABELS, type ProductKind } from '~/shared/product-details'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const props = defineProps<{
  products: Product[]
  /** The list's own path, which the kind filters link to. */
  path: string
  /** What one product costs in this scope. */
  priceLabel: (product: Product) => string
  activeItem?: string | null
  /** A list of one kind — Experiences, Services — with no kind filters of its own. */
  fixedKind?: ProductKind
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
const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'catalog',
  items: rows.value.map(product => ({
    id: product.id,
    label: product.name,
    summary: [PRODUCT_KIND_LABELS[product.kind], props.priceLabel(product) || 'No price set'].join(' · '),
    lead: { image: mediaStillUrl(product.image ?? undefined) ?? null, icon: 'i-lucide-image' },
    to: scoped(`${catalogPath.value}/${product.id}`),
  })),
}])
</script>
