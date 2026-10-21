<template>
  <DashboardIndexPanel id="booking-schedule" title="Weekly schedule" :auto-open="p.location.value?.status === 'active' && !scopeError ? groups[0]?.items[0]?.to ?? null : null">
    <template v-if="p.locationId.value" #right><UButton :to="chooseLocationPath" label="Change location" color="neutral" variant="outline" /></template>
    <UAlert v-if="p.loadError.value || p.organizationLocationsError.value || scopeError" color="error" variant="soft" :description="p.loadError.value || p.organizationLocationsError.value || scopeError || ''" />
    <p v-else-if="!p.product.value" role="status" class="text-muted">Loading offering…</p>
    <UEmpty v-else-if="!groups[0]?.items.length" title="No physical locations" description="Add this offering to a location before setting its weekly times." :actions="[{ label: 'Locations', to: p.sectionPath('locations'), color: 'neutral' }]" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { formatTime } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const chooseLocationPath = computed(() => router.resolve({ path: level.path.value, query: { ...route.query, location_id: undefined } }).fullPath)
const scopeError = computed(() => p.locationId.value
  ? p.location.value?.status !== 'active' ? 'Choose an active location for this weekly schedule.' : p.scheduleError.value
  : null)
const groups = computed<EditorNavigationGroup[]>(() => {
  if (route.query.location_id === 'online') {
    const config = p.product.value?.booking
    return [{ id: 'online', items: config?.held_online ? [{
      id: 'hours', label: 'Bookable times', icon: 'i-lucide-clock', summary: 'Online sessions follow the host’s working hours.',
      to: config.assigned_member_id ? `/dashboard/${route.params.orgSlug}/team/${config.assigned_member_id}/hours` : `/dashboard/${route.params.orgSlug}/team`,
    }] : [] }]
  }
  if (!p.locationId.value) return [{ id: 'locations', items: (p.product.value?.locations ?? []).map(placement => {
    const location = p.allOrganizationLocations.value.find(entry => entry.id === placement.location_id)
    if (!location) throw new Error('A saved offering location could not be loaded')
    return {
      id: location.id, label: location.title, icon: 'i-lucide-map-pin',
      summary: [location.status === 'active' ? location.timezone : 'Location inactive', placement.published ? 'Visible at this location' : 'Hidden at this location', placement.active ? 'Accepting bookings' : 'Bookings paused'].join(' · '),
      ...(location.status === 'active' ? { to: router.resolve({ path: level.path.value, query: { ...route.query, location_id: location.id } }).fullPath } : {}),
    }
  }) }]
  return [{ id: 'week', items: p.weekdays.map(day => ({
  id: day.label.toLowerCase(), label: day.label,
  summary: p.savedSlotsFor(day.value).length ? p.savedSlotsFor(day.value).map(slot => formatTime(slot.start_time, 'en-US')).join(', ') : 'No sessions',
  to: router.resolve({ path: `${level.path.value}/${day.label.toLowerCase()}`, query: route.query }).fullPath,
  })) }]
})
</script>
