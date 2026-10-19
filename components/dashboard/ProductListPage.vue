<template>
  <!--
    Catalog is where everything the business offers is found, as Airbnb's Your
    listings: kind pills, then one card per thing. A menu is one card per
    location, opening that location's menu, so the locations need no filter of
    their own; every other offering is its own card, opening the one Product editor.
  -->
  <DashboardIndexPanel id="catalog" title="Catalog">
    <template #right>
      <UButton :to="`${level.path.value}/new/kind`" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" data-testid="catalog-add" />
    </template>

    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Catalog could not be loaded" :description="loadError" />
    <template v-else>
      <DashboardFilterPills id="catalog-kind" v-model="kind" label="Kind" :items="kindFilters" class="mb-8" />
      <OrganizationLocationSelector
        v-if="items.length"
        :items="items"
        :active-item="level.child.value"
        :label-heading-level="2"
        missing-image-label="No photo"
        missing-image-hint="Add one in this item’s photo editor."
        data-testid="catalog-grid"
      />
      <UEmpty v-else icon="i-lucide-store" :title="`No ${activeFilterLabel.toLowerCase()} yet`" />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { catalogProductItem } from '~/components/dashboard/CatalogProductList.vue'
import OrganizationLocationSelector, { type OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import type { ProductKind } from '~/shared/product-details'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { getErrorMessage } from '~/utils/errors'

const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const organizationId = await useDashboardOrganizationId()
// One authorized organization read. Location narrows this projection by its
// explicit product relationships, without dropping membership needed by editors.
const catalog = useProductCatalog(organizationId, ref(null))
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const { priceLabel } = useCatalogPrice(ref(null), locations)
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The catalog could not be loaded') : null
})

// The kinds this business offers, in Catalog's order; a kind nobody sells is not a pill.
type CatalogKind = 'all' | 'menu' | Exclude<ProductKind, 'dish'>
const KINDS: Array<{ value: Exclude<CatalogKind, 'all'>; label: string }> = [
  { value: 'menu', label: 'Menu' },
  { value: 'experience', label: 'Experiences' },
  { value: 'item', label: 'Products' },
  { value: 'service', label: 'Services' },
  { value: 'stay', label: 'Places to stay' },
]
const grouped = computed(() => new Map(groupProductsByCollection(catalog.products.value, catalog.collections.value).map(group => [group.id, group])))
// A section is the menu's when it holds dishes or nothing yet.
const menuCollections = computed(() => catalog.collections.value.filter(collection => {
  const members = grouped.value.get(collection.id)?.products ?? []
  return !members.length || members.some(product => product.kind === 'dish')
}))
const hasMenu = computed(() => menuCollections.value.length > 0 || catalog.products.value.some(product => product.kind === 'dish'))
const offered = (value: Exclude<CatalogKind, 'all'>) => value === 'menu' ? hasMenu.value : catalog.products.value.some(product => product.kind === value)
// The chosen kind is held in the URL, so a filtered Catalog can be linked and gone Back to.
const kind = computed({
  get: (): CatalogKind => KINDS.find(row => row.value === route.query.kind)?.value ?? 'all',
  set: (value: string) => void navigateTo({ path: level.path.value, query: { ...route.query, kind: value === 'all' ? undefined : value } }),
})
const kindFilters = computed(() => [{ value: 'all' as const, label: 'All' }, ...KINDS.filter(row => row.value === kind.value || offered(row.value))])
const activeFilterLabel = computed(() => kind.value === 'all' ? 'offerings' : KINDS.find(row => row.value === kind.value)!.label)

// A menu belongs to a location: one card for each, holding that location's
// sections and the ones every location shares. With no locations there is one menu.
const menuCards = computed<OrganizationLocationSelectorItem[]>(() => {
  const sectionCount = (id: string | null) => menuCollections.value.filter(collection => collection.location_id === null || collection.location_id === id).length
  const sections = (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`
  if (!locations.value.length) {
    return [{ id: 'menu', label: 'Menu', eyebrow: 'Menu', summary: sections(sectionCount(null)), imageUrl: null, fallbackIcon: 'i-lucide-utensils', to: `${level.path.value}/menu` }]
  }
  return locations.value.map(location => ({
    id: `menu-${location.id}`,
    label: location.title,
    eyebrow: `Menu${location.status === 'active' ? '' : ` (${location.status})`}`,
    summary: sections(sectionCount(location.id)),
    imageUrl: location.picture_url,
    fallbackIcon: 'i-lucide-utensils',
    to: router.resolve({ path: `${level.path.value}/menu`, query: { location_id: location.id } }).fullPath,
  }))
})
const offerings = computed(() => catalog.products.value.filter(product => product.kind !== 'dish' && (kind.value === 'all' || product.kind === kind.value)))
const items = computed<OrganizationLocationSelectorItem[]>(() => [
  ...(hasMenu.value && (kind.value === 'all' || kind.value === 'menu') ? menuCards.value : []),
  ...(kind.value === 'menu' ? [] : offerings.value.map(product => catalogProductItem(product, {
    collections: catalog.collections.value,
    locations: locations.value,
    priceLabel,
    to: `${level.path.value}/${product.id}`,
  }))),
])

useSeoMeta({ title: 'Catalog | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
