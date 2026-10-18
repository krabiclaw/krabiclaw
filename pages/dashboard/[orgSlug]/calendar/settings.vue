<template>
  <!--
    The calendar's gear, Airbnb's Settings sheet (measured live 2026-10-01):
    a rail of cards, each showing its value and opening a picker of a few
    choices. Availability is when guests can book — the hours the slots come
    from, how far ahead, how many seats. Cancellations is one policy chosen
    by name. Closures are the calendar's own: block a day on it.
  -->
  <DashboardIndexPanel id="calendar-settings" title="Settings" :auto-open="groups[0]?.items[0]?.to ?? null">
    <UAlert v-if="editor?.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor?.error.value" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { cancellationSummary } from '~/shared/availability-settings'

definePageMeta({ layout: 'dashboard', key: route => String(route.query.locationId ?? 'business') })

const route = useRoute()
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()
const locationId = computed(() => typeof route.query.locationId === 'string' ? route.query.locationId : null)
const editor = locationId.value ? await useLocationEditor(organizationId, locationId, null) : null

const router = useRouter()
// Each leaf keeps the calendar's query — its location and view — so Close lands on the same calendar.
const to = (segment: string) => router.resolve({ path: `${level.path.value}/${segment}`, query: route.query }).fullPath
const groups = computed<EditorNavigationGroup[]>(() => [
  {
    id: 'availability',
    items: [{ id: 'availability', icon: 'i-lucide-calendar-clock', label: 'Availability', to: to('availability') }],
  },
  ...(editor?.location.value ? [{
    id: 'cancellations',
    label: 'Cancellations',
    items: [
      { id: 'cancellation', icon: 'i-lucide-calendar-x', label: 'Cancellation policy', summary: cancellationSummary(editor.reservationForm.value), to: to('cancellation') },
    ],
  }] : []),
])
</script>
