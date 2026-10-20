<template>
  <DashboardIndexPanel id="product-sessions" title="Dated sessions">
    <template #right>
      <UButton icon="i-lucide-plus" label="Add a session" :to="to('new')" :disabled="!p.product.value?.booking" />
    </template>
    <UAlert v-if="error || p.loadError.value || p.organizationLocationsError.value" color="error" :description="p.loadError.value ?? p.organizationLocationsError.value ?? getErrorMessage(error, 'Sessions could not be loaded')" />
    <p v-else-if="pending" role="status" class="text-muted">Loading sessions…</p>
    <template v-else>
      <p class="mb-4 text-sm text-muted">Sessions in the next 90 days.</p>
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
const { data, error, pending } = await useAsyncData(
  () => `product-sessions:${p.organizationId}:${p.product.value?.id}:${p.locationId.value ?? 'all'}`,
  async () => p.product.value?.booking
    ? dashboardApi(`/api/editor/organizations/${p.organizationId}/products/${p.product.value.id}/sessions`, { validate: isSessionsResponse })
    : null,
)
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'sessions', items: (data.value?.sessions ?? []).filter(session => !p.locationId.value || session.location_id === p.locationId.value).map(session => ({
  id: session.id,
  label: new Intl.DateTimeFormat('en', { timeZone: session.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.starts_at)),
  summary: `${session.location_id ? p.organizationLocations.value.find(location => location.id === session.location_id)?.title ?? session.location_id : 'Online'} · ${session.status === 'cancelled' ? 'Cancelled' : `${session.claimed} places reserved`}${session.capacity === null ? '' : ` · ${session.capacity} places`} · ${session.timezone}`,
  to: to(session.id),
})) }])
</script>
