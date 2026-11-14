<template>
  <!--
    The location: one card per thing a guest sees on its page, in the order the
    page shows it, each stating what it holds now. Every card is a level below
    this one; the gear opens the settings that a guest never sees.
  -->
  <DashboardIndexPanel id="location-index" :title="isNew ? newLocation.title.value : location?.title || 'Location'" :auto-open="navigationGroups[0]?.items[0]?.to ?? null" :create="newLocation.firstStep.value">
    <template v-if="!isNew" #right>
      <UButton
        :to="`${level.path.value}/settings`"
        icon="i-lucide-settings"
        color="neutral"
        variant="soft"
        square
        :aria-label="overview?.settings.label ?? 'Location settings'"
      />
    </template>

    <!--
      The location before it exists: the sections creating it will not go
      without, walked in order.
    -->
    <template v-if="isNew">
      <UAlert v-if="newLocation.createError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="newLocation.createError.value" />
      <EditorNavigationList :groups="navigationGroups" :active-item="level.child.value" />
    </template>

    <UAlert
      v-else-if="overviewError"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      :description="getErrorMessage(overviewError, 'Failed to load location overview')"
    />

    <!-- The same rows every other index draws, so a location reads like the rest of the dashboard. -->
    <EditorNavigationList v-else-if="location" :groups="navigationGroups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import type { CatalogRow } from '~/shared/catalog-screen'
import { NEW_LOCATION_SECTIONS, useNewLocation } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { timezoneLabel } from '~/utils/timezone'

// A location is a tile on Locations, a row on Menu; Locations is its pane and its Back.
definePageMeta({ layout: 'dashboard' })

interface LocationOverviewResource {
  location: { success: boolean; location: { id: string; title: string } }
  rows: CatalogRow[]
  settings: CatalogRow
}

const dashboardApi = useDashboardApi()
const dashboardLocation = useDashboardLocation()
// The level runs while setup is still synchronous: it injects the record the
// `<RouterView>` above rendered, and an `await` before it would bind nothing.
const level = useRouteLevel()
const locationPath = level.path

const organizationId = useDashboardOrganizationId()
const newLocation = useNewLocation(organizationId, null)
const isNew = newLocation.isNew

// Only the walk's own sections live under `new`; the rest belong to a location that exists.
watchEffect(() => {
  const child = level.child.value
  if (isNew.value && child && !(NEW_LOCATION_SECTIONS as readonly string[]).includes(child)) {
    showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
  }
})

const locationId = computed(() => dashboardLocation.currentLocationId.value)

const location = computed(() => overview.value?.location.location ?? null)

const navigationGroups = computed<EditorNavigationGroup[]>(() => {
  const draft = newLocation.draft.value
  const rows = isNew.value ? [
    { id: 'name', label: 'Name', summary: draft.title.trim() || 'Not named yet', to: `${locationPath.value}/name` },
    { id: 'hours', icon: 'i-lucide-clock', label: 'Hours', summary: draft.hours.timezone ? timezoneLabel(draft.hours.timezone) : 'Choose the time zone', to: `${locationPath.value}/hours` },
  ] : overview.value?.rows ?? []
  return [{ id: 'location', items: rows.flatMap(item => item.to ? [{ ...item, to: item.to }] : []) }]
})

const isOverviewResponse = (value: unknown): value is LocationOverviewResource =>
  isRecord(value) && isRecord(value.location) && isRecord(value.location.location)
  && typeof value.location.location.title === 'string' && Array.isArray(value.rows) && isRecord(value.settings)

const overviewKey = computed(() => `dashboard-location-overview:${organizationId}:${locationId.value}`)
const { data: overview, error: overviewError } = await useAsyncData<LocationOverviewResource | null>(overviewKey, async () => {
  if (isNew.value) return null
  const requestedLocationId = locationId.value
  if (!requestedLocationId) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
  return await dashboardApi<LocationOverviewResource>(
    `/api/dashboard/organizations/${organizationId}/locations/${requestedLocationId}/overview`,
    { validate: isOverviewResponse },
  )
})

useSeoMeta({ title: () => `${isNew.value ? newLocation.title.value : location.value?.title || 'Location'} | KrabiClaw`, robots: 'noindex, nofollow' })
</script>
