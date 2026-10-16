<template>
  <!--
    The menu: one location's sections, in the order its guests see them. A menu
    belongs to a location, and Catalog opens it from that location's card, so
    the location arrives in the URL and its share preview heads the page — the
    picture with its name, as its own Location page shows it — rather than a
    sentence naming it or a switcher. Only a chosen location's sections can be reordered or added
    to — a single reorderable list is never assembled from several locations.
    Sections shared by every location are their own list, edited with no
    location chosen, where every location's menu reads beside them.
  -->
  <DashboardIndexPanel id="catalog-menu" title="Menu">
    <img
      v-if="chosenLocation?.social_image"
      :src="chosenLocation.social_image.url"
      :alt="chosenLocation.title"
      class="mb-8 aspect-[1200/630] w-full rounded-xl object-cover lg:max-w-xl"
      data-testid="menu-location-preview"
    >

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
const unsectioned = computed(() => catalog.products.value.filter(product => product.kind === 'dish'
  && !product.collections.some(membership => catalog.collections.value.some(collection => collection.id === membership.collection_id))))

watchEffect(() => {
  if (level.mode.value === 'yield' || !locationId.value || locationsError.value) return
  if (!locations.value.some(location => location.id === locationId.value)) showError(createError({ statusCode: 404, statusMessage: 'Location not found' }))
})

const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The menu could not be loaded') : null
})

const chosenLocation = computed(() => locationId.value ? locations.value.find(location => location.id === locationId.value) : undefined)
const titleOf = (id: string) => locations.value.find(location => location.id === id)?.title ?? id
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
    ...(hasShared.value || !locations.value.length ? [{ id: null, title: 'Shared by every location', readOnly: false, chooseTo: null }] : []),
    ...locations.value.map(location => ({
      id: location.id,
      title: location.title,
      readOnly: true,
     
      chooseTo: router.resolve({ path: level.path.value, query: { location_id: location.id } }).fullPath,
    })),
  ]
})

useSeoMeta({ title: 'Menu | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
