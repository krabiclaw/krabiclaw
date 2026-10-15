<template>
  <!--
    The menu: one location's sections, in the order its guests see them. A menu
    belongs to a location, so the location is always on screen. With several
    locations and none chosen, every location's menu can be read side by side,
    but only a chosen location's sections can be reordered or added to — a
    single reorderable list is never assembled from several locations.
    Sections shared by every location are their own list, edited as such.
  -->
  <DashboardIndexPanel id="catalog-menu" title="Menu">
    <div class="mb-6 flex">
      <p v-if="locations.length === 1" class="text-sm font-semibold text-highlighted" data-testid="menu-location">{{ locations[0]!.title }}</p>
      <USelect
        v-else-if="locations.length > 1"
        :model-value="locationId ?? ALL_LOCATIONS"
        :items="locationItems"
        size="sm"
        class="min-w-48"
        aria-label="Location"
        data-testid="menu-location"
        @update:model-value="setLocation"
      />
    </div>

    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Menu could not be loaded" :description="loadError" />
    <div v-else class="space-y-10">
      <section v-for="scope in scopes" :key="scope.id ?? 'shared'" :data-testid="`menu-scope-${scope.id ?? 'shared'}`">
        <div v-if="scopes.length > 1" class="flex items-center justify-between gap-4 px-1">
          <h2 class="text-sm font-semibold text-muted">{{ scope.title }}</h2>
          <UButton v-if="scope.chooseTo" :to="scope.chooseTo" label="Edit this menu" size="sm" color="neutral" variant="link" />
        </div>
        <CollectionList :scope="scope.id" :read-only="scope.readOnly" :description="scope.description" />
      </section>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import CollectionList from '~/components/dashboard/CollectionList.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()
const locationId = useLocationScope()
const catalog = useProductCatalog(organizationId, locationId)
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations({ includeInactive: true })

const ALL_LOCATIONS = 'all'
const locationItems = computed(() => [{ label: 'All locations', value: ALL_LOCATIONS }, ...locations.value.map(location => ({ label: `${location.title}${location.status === 'active' ? '' : ` (${location.status})`}`, value: location.id }))])
function setLocation(value: string) {
  void navigateTo(router.resolve({ path: level.path.value, query: { ...route.query, location_id: value === ALL_LOCATIONS ? undefined : value } }).fullPath)
}
watchEffect(() => {
  if (level.mode.value === 'yield' || !locationId.value || locationsError.value) return
  if (!locations.value.some(location => location.id === locationId.value)) showError(createError({ statusCode: 404, statusMessage: 'Location not found' }))
})

const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The menu could not be loaded') : null
})

const titleOf = (id: string) => locations.value.find(location => location.id === id)?.title ?? id
const hasShared = computed(() => catalog.collections.value.some(row => row.location_id === null))

/**
 * The lists on screen, each one scope with one order. A chosen location's own
 * sections are editable; the shared sections read beside it and are edited
 * with no location chosen, where every location's menu reads with an
 * "Edit this menu" way in.
 */
const scopes = computed(() => {
  const order = 'Guests see sections in this order.'
  if (locationId.value) {
    return [
      { id: locationId.value, title: titleOf(locationId.value), readOnly: false, description: order, chooseTo: null },
      ...(hasShared.value ? [{ id: null, title: 'Shared by every location', readOnly: true, description: 'Choose All locations to edit these.', chooseTo: null }] : []),
    ]
  }
  return [
    ...(hasShared.value || !locations.value.length ? [{ id: null, title: 'Shared by every location', readOnly: false, description: order, chooseTo: null }] : []),
    ...locations.value.map(location => ({
      id: location.id,
      title: location.title,
      readOnly: true,
      description: undefined,
      chooseTo: router.resolve({ path: level.path.value, query: { location_id: location.id } }).fullPath,
    })),
  ]
})

useSeoMeta({ title: 'Menu | Krabiclaw Dashboard', robots: 'noindex, nofollow' })
</script>
