<template>
  <DashboardIndexPanel id="catalog-menu" :title="chosenLocation ? `${chosenLocation.title} menu` : 'Menu'">
    <template v-if="chosenLocation?.status !== 'active' && chosenLocation" #right><UBadge label="Inactive location" color="neutral" variant="soft" /></template>
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Menu could not be loaded" :description="loadError" />
    <div v-else class="space-y-10">
      <section v-for="scope in scopes" :key="scope.id ?? 'shared'" :data-testid="`menu-scope-${scope.id ?? 'shared'}`">
        <div v-if="scopes.length > 1" class="flex items-center justify-between gap-4 px-1">
          <h2 class="text-sm font-semibold text-muted">{{ scope.title }}</h2>
          <UButton v-if="scope.chooseTo" :to="scope.chooseTo" label="Edit this menu" size="sm" color="neutral" variant="link" />
        </div>
        <CollectionList :scope="scope.id" :read-only="scope.readOnly" />
      </section>
      <!-- A dish in no section is still on the menu's page, so it can be found and placed. -->
      <section v-if="unsectioned.length" data-testid="menu-unsectioned">
        <h2 class="mb-3 text-xl font-semibold text-highlighted">Not in a section</h2>
        <CatalogProductList :products="unsectioned" :collections="catalog.collections.value" :locations="locations" :price-label="priceLabel" :active-item="level.child.value" :item-heading-level="3" />
      </section>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import CatalogProductList from '~/components/dashboard/CatalogProductList.vue'
import CollectionList from '~/components/dashboard/CollectionList.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const router = useRouter()
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()
const locationId = useLocationScope()
const catalog = useProductCatalog(organizationId, locationId)
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const { priceLabel } = useCatalogPrice(locationId, locations)
const unsectioned = computed(() => {
  const visibleSections = new Set(catalog.collections.value.filter(collection => !locationId.value || collection.location_id === null || collection.location_id === locationId.value).map(collection => collection.id))
  return catalog.products.value.filter(product => product.kind === 'dish' && !product.collections.some(membership => visibleSections.has(membership.collection_id)))
})

watchEffect(() => {
  if (level.mode.value === 'yield' || !locationId.value || locationsError.value) return
  if (!locations.value.some(location => location.id === locationId.value)) showError(createError({ statusCode: 404, statusMessage: 'Location not found' }))
})

const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The menu could not be loaded') : null
})

const chosenLocation = computed(() => locationId.value ? locations.value.find(location => location.id === locationId.value) : undefined)
const titleOf = (id: string) => {
  const location = locations.value.find(location => location.id === id)
  if (!location) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
  return location.title
}
const hasShared = computed(() => catalog.collections.value.some(row => row.location_id === null))

/**
 * The lists on screen, each one scope with one order. A chosen location's own
 * sections are editable; the shared sections read beside it and are edited
 * with no location chosen, where every location's menu reads with an
 * "Edit this menu" way in.
 */
const scopes = computed(() => {
  if (locationId.value) {
    return [
      { id: locationId.value, title: titleOf(locationId.value), readOnly: false, chooseTo: null },
      ...(hasShared.value ? [{ id: null, title: 'Shared by every location', readOnly: true, chooseTo: level.path.value }] : []),
    ]
  }
  return [
    { id: null, title: 'Shared by every location', readOnly: false, chooseTo: null },
    ...locations.value.map(location => ({
      id: location.id,
      title: location.status === 'active' ? location.title : `${location.title} (Inactive)`,
      readOnly: true,
      chooseTo: router.resolve({ path: level.path.value, query: { location_id: location.id } }).fullPath,
    })),
  ]
})

useSeoMeta({ title: 'Menu | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
