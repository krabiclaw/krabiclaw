<template>
  <DashboardIndexPanel id="catalog" title="Catalog" column="wide">
    <template #right>
      <UButton :to="scoped(`${level.path.value}/new/kind`)" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" data-testid="catalog-add" />
    </template>

    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Catalog could not be loaded" :description="loadError" />
    <template v-else>
      <div v-if="locations.length" class="mb-8 flex">
        <USelect
          :model-value="locationId ?? ALL_LOCATIONS"
          :items="locationItems"
          icon="i-lucide-map-pin"
          class="min-w-48 rounded-full"
          aria-label="Location"
          @update:model-value="setLocation"
        />
      </div>
      <UAlert v-if="navigationError" class="mb-6" color="error" variant="soft" :description="getErrorMessage(navigationError, 'The location could not be selected')" />
      <div class="space-y-10 pb-6">
        <section aria-labelledby="catalog-menu-heading" data-testid="catalog-section-menu">
          <div class="mb-3 flex items-center justify-between gap-4">
            <h2 id="catalog-menu-heading" class="text-xl font-semibold text-highlighted">Menu</h2>
            <UButton :to="scoped(`${level.path.value}/menu`)" label="Edit menu" color="neutral" variant="link" size="sm" />
          </div>
          <OrganizationLocationSelector
            v-if="menuSections.length"
            :items="menuSections"
            rows-on-mobile
            :label-heading-level="3"
            :active-item="level.child.value"
          />
          <CatalogProductList
            v-if="unsectionedDishes.length"
            :products="unsectionedDishes"
            :collections="catalog.collections.value"
            :locations="locations"
            :path="level.path.value"
            :price-label="priceLabel"
            :active-item="level.child.value"
            :item-heading-level="3"
            fixed-kind="dish"
          />
          <p v-if="!menuSections.length && !unsectionedDishes.length" class="py-5 text-sm text-muted">No menu items or sections yet.</p>
        </section>
        <section v-for="group in productGroups" :key="group.kind" :aria-labelledby="`catalog-${group.kind}-heading`" :data-testid="`catalog-section-${group.kind}`">
          <h2 :id="`catalog-${group.kind}-heading`" class="mb-3 text-xl font-semibold text-highlighted">{{ group.label }}</h2>
          <CatalogProductList
            :products="visibleProducts"
            :collections="catalog.collections.value"
            :locations="locations"
            :path="level.path.value"
            :price-label="priceLabel"
            :active-item="level.child.value"
            :item-heading-level="3"
            :fixed-kind="group.kind"
          />
        </section>
      </div>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import CatalogProductList from '~/components/dashboard/CatalogProductList.vue'
import OrganizationLocationSelector, { type OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import { collectionEditorPath } from '~/server/utils/dashboard-links'
import { mediaStillUrl } from '~/shared/media-placement-contract'
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
const locationId = useLocationScope()
const { priceLabel } = useCatalogPrice(locationId, locations)
const navigationError = ref<unknown>(null)
const ALL_LOCATIONS = '__all__'
const productGroups = computed(() => [
  { kind: 'experience' as const, label: 'Experiences' },
  { kind: 'item' as const, label: 'Products' },
  { kind: 'service' as const, label: 'Services' },
  ...(catalog.products.value.some(product => product.kind === 'stay')
    ? [{ kind: 'stay' as const, label: 'Places to stay' }]
    : []),
])
const locationItems = computed(() => [{ label: 'All locations', value: ALL_LOCATIONS }, ...locations.value.map(location => ({ label: `${location.title}${location.status === 'active' ? '' : ` (${location.status})`}`, value: location.id }))])
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The catalog could not be loaded') : null
})
const visibleProducts = computed(() => catalog.products.value.filter(product => !locationId.value || product.locations.some(location => location.location_id === locationId.value)))
const grouped = computed(() => new Map(groupProductsByCollection(catalog.products.value, catalog.collections.value).map(group => [group.id, group])))
const menuCollections = computed(() => catalog.collections.value.filter(collection => {
  const members = grouped.value.get(collection.id)?.products ?? []
  return (!locationId.value || collection.location_id === null || collection.location_id === locationId.value)
    && (!members.length || members.some(product => product.kind === 'dish'))
}))
const menuSections = computed<OrganizationLocationSelectorItem[]>(() => menuCollections.value.map(collection => {
  const members = grouped.value.get(collection.id)?.products ?? []
  const cover = members.find(product => mediaStillUrl(product.image))?.image
  const location = collection.location_id ? locations.value.find(item => item.id === collection.location_id) : null
  if (collection.location_id && !location) throw createError({ statusCode: 500, statusMessage: 'A menu section’s location could not be loaded' })
  return {
    id: collection.id, label: collection.name, imageUrl: mediaStillUrl(cover), fallbackIcon: 'i-lucide-utensils',
    eyebrow: `${members.length} ${members.length === 1 ? 'item' : 'items'}`,
    summary: location ? `${location.title}${location.status === 'active' ? '' : ` (${location.status})`}` : 'Shared by every location',
    to: collectionEditorPath(String(route.params.orgSlug), collection.id, collection.location_id),
  }
}))
const unsectionedDishes = computed(() => {
  const sectionIds = new Set(menuCollections.value.map(collection => collection.id))
  return visibleProducts.value.filter(product => product.kind === 'dish' && !product.collections.some(membership => sectionIds.has(membership.collection_id)))
})

function scoped(path: string) { return router.resolve({ path, query: { location_id: locationId.value ?? undefined } }).fullPath }
function setLocation(value: string) {
  void router.replace({ path: level.path.value, query: { ...route.query, location_id: value === ALL_LOCATIONS ? undefined : value } })
    .then(() => { navigationError.value = null }, cause => { navigationError.value = cause })
}
watchEffect(() => {
  if (level.mode.value === 'yield' || locationsError.value || !locationId.value) return
  if (!locations.value.some(location => location.id === locationId.value)) showError(createError({ statusCode: 404, statusMessage: 'Location not found' }))
})

useSeoMeta({ title: 'Catalog | Krabiclaw Dashboard', robots: 'noindex, nofollow' })
</script>
