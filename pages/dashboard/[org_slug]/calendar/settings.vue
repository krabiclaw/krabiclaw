<template>
  <!--
    The calendar's gear, Airbnb's Settings sheet (measured live 2026-10-01):
    a rail of cards, each showing its value and opening a picker of a few
    choices. Availability is when guests can book — the hours the slots come
    from, how far ahead, how many seats. Closures are the calendar's own: block a day on it.
  -->
  <DashboardIndexPanel id="calendar-settings" title="Settings" :auto-open="groups[0]?.items[0]?.to ?? null">
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'

definePageMeta({ layout: 'dashboard', key: route => String(route.query.location_id ?? 'business') })

const route = useRoute()
const level = useRouteLevel()

const router = useRouter()
// Each leaf keeps the calendar's query — its location and view — so Close lands on the same calendar.
const to = (segment: string) => router.resolve({ path: `${level.path.value}/${segment}`, query: route.query }).fullPath
const groups = computed<EditorNavigationGroup[]>(() => [
  {
    id: 'availability',
    items: [{ id: 'availability', icon: 'i-lucide-calendar-clock', label: 'Availability', to: to('availability') }],
  },
])
</script>
