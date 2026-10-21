<template>
  <DashboardIndexPanel id="product-sessions" title="Dated sessions">
    <template #right>
      <UButton v-if="route.query.location_id !== 'online'" icon="i-lucide-plus" label="Add a session" :to="canCreate ? to('new') : undefined" :disabled="!canCreate" />
      <UButton v-else-if="p.product.value?.booking" icon="i-lucide-clock" label="Bookable times" :to="p.product.value.booking.assigned_member_id ? `/dashboard/${route.params.orgSlug}/team/${p.product.value.booking.assigned_member_id}/hours` : `/dashboard/${route.params.orgSlug}/team`" />
    </template>
    <UAlert v-if="error || p.loadError.value || p.organizationLocationsError.value" color="error" :description="p.loadError.value ?? p.organizationLocationsError.value ?? getErrorMessage(error, 'Sessions could not be loaded')" />
    <p v-else-if="pending" role="status" class="text-muted">Loading sessions…</p>
    <template v-else>
      <UButton v-if="p.locationId.value" class="mb-4" :to="chooseLocationPath" label="Change location" color="neutral" variant="outline" />
      <EditorNavigationList v-if="!p.locationId.value && route.query.location_id !== 'online' && scopeGroups[0]?.items.length" class="mb-8" :groups="scopeGroups" />
      <UEmpty v-else-if="!p.locationId.value && route.query.location_id !== 'online'" class="mb-8" title="No physical locations" description="Add this offering to a location before adding individual dates." :actions="[{ label: 'Locations', to: p.sectionPath('locations'), color: 'neutral' }]" />
      <p class="mb-4 text-sm text-muted">{{ p.location.value?.title ?? (route.query.location_id === 'online' ? 'Online' : 'All locations') }} · Sessions in the next 90 days.</p>
      <EditorNavigationList v-if="groups[0]?.items.length" :groups="groups" :active-item="level.child.value" />
      <p v-else class="text-muted">No dated sessions in this period.</p>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { isSessionsResponse } from '~/utils/session-contract'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const to = (id: string) => router.resolve({ path: `${level.path.value}/${id}`, query: route.query }).fullPath
const chooseLocationPath = computed(() => router.resolve({ path: level.path.value, query: { ...route.query, location_id: undefined } }).fullPath)
const canCreate = computed(() => Boolean(p.product.value?.booking && p.location.value?.status === 'active' && !p.loadError.value && !p.organizationLocationsError.value && !error.value))
const { data, error, pending } = await useAsyncData(
  () => `product-sessions:${p.organizationId}:${p.product.value?.id}:${route.query.location_id === 'online' ? 'online' : p.locationId.value ?? 'all'}`,
  async () => p.product.value?.booking
    ? dashboardApi(`/api/editor/organizations/${p.organizationId}/products/${p.product.value.id}/sessions`, { validate: isSessionsResponse })
    : null,
)
const scopeGroups = computed<EditorNavigationGroup[]>(() => [{ id: 'locations', items: (p.product.value?.locations ?? []).map(placement => {
  const location = p.allOrganizationLocations.value.find(entry => entry.id === placement.location_id)
  if (!location) throw new Error('A saved offering location could not be loaded')
  return {
    id: location.id, label: location.title, icon: 'i-lucide-map-pin',
    summary: [location.status === 'active' ? 'Choose to add a session here' : 'Location inactive', placement.published ? 'Visible at this location' : 'Hidden at this location', placement.active ? 'Accepting bookings' : 'Bookings paused'].join(' · '),
    ...(location.status === 'active' ? { to: router.resolve({ path: level.path.value, query: { ...route.query, location_id: location.id } }).fullPath } : {}),
  }
}) }])
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'sessions', items: (data.value?.sessions ?? []).filter(session => route.query.location_id === 'online' ? session.location_id === null : !p.locationId.value || session.location_id === p.locationId.value).map(session => ({
  id: session.id,
  label: new Intl.DateTimeFormat('en', { timeZone: session.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.starts_at)),
  summary: `${session.location_id ? p.allOrganizationLocations.value.find(location => location.id === session.location_id)?.title ?? session.location_id : 'Online'} · ${session.status === 'cancelled' ? 'Cancelled' : `${session.claimed} places reserved`}${session.capacity === null ? '' : ` · ${session.capacity} places`} · ${session.timezone}`,
  to: router.resolve({ path: `${level.path.value}/${session.id}`, query: { ...route.query, location_id: session.location_id ?? (p.product.value?.kind === 'experience' ? 'online' : undefined) } }).fullPath,
})) }])
</script>
