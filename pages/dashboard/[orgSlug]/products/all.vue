<template>
  <!-- Everything in Catalog's scope in one list, whatever section it sits in. -->
  <DashboardIndexPanel id="catalog-all" :title="choosingAvailability ? 'Choose an item' : 'All items'">
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Catalog could not be loaded" :description="loadError" />
    <CatalogProductList v-else :products="catalog.products.value" :collections="catalog.collections.value" :locations="locations" :path="level.path.value" :price-label="priceLabel" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import CatalogProductList from '~/components/dashboard/CatalogProductList.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const level = useRouteLevel()
const route = useRoute()
const choosingAvailability = computed(() => route.query.action === 'availability')
const organizationId = await useDashboardOrganizationId()
const locationId = useLocationScope()
const catalog = useProductCatalog(organizationId, locationId)
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })
const { priceLabel } = useCatalogPrice(locationId, locations)
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The catalog could not be loaded') : null
})

useSeoMeta({ title: 'All items | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
