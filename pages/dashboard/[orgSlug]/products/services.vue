<template>
  <!-- Catalog's Services: every one the organization offers, opened straight from the list. -->
  <DashboardIndexPanel id="catalog-services" title="Services">
    <template #right>
      <!-- A list of one kind already knows what is being added. -->
      <UButton :to="`/dashboard/${String(route.params.orgSlug)}/products/new/name?kind=service`" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" data-testid="catalog-add" />
    </template>
    <div v-if="locations.length > 1" class="mb-6 flex">
      <USelect
        :model-value="locationId ?? ALL_LOCATIONS"
        :items="locationItems"
        size="sm"
        class="min-w-48"
        aria-label="Location"
        @update:model-value="setLocation"
      />
    </div>
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Services could not be loaded" :description="loadError" />
    <CatalogProductList v-else :products="catalog.products.value" :collections="catalog.collections.value" :locations="locations" :path="level.path.value" :price-label="priceLabel" :active-item="level.child.value" fixed-kind="service" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import CatalogProductList from '~/components/dashboard/CatalogProductList.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()
// Location is a filter here, never a step: no location is every services.
const locationId = useLocationScope()
const catalog = useProductCatalog(organizationId, locationId)
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const { priceLabel } = useCatalogPrice(locationId, locations)

const ALL_LOCATIONS = 'all'
const locationItems = computed(() => [{ label: 'All locations', value: ALL_LOCATIONS }, ...locations.value.map(location => ({ label: location.title, value: location.id }))])
function setLocation(value: string) {
  void navigateTo(router.resolve({ path: level.path.value, query: { ...route.query, location_id: value === ALL_LOCATIONS ? undefined : value } }).fullPath)
}
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The catalog could not be loaded') : null
})

useSeoMeta({ title: 'Services | Krabiclaw Dashboard', robots: 'noindex, nofollow' })
</script>
