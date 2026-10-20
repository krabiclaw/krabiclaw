<template>
  <!--
    Hours as Airbnb would draw them: an index of rows — the timezone, one row
    per weekday previewing its hours, and (for a location) its exceptions —
    each opening a leaf of its own. The location and the calendar mount the
    same index over the same field.
  -->
  <DashboardIndexPanel :id="id" title="Hours" :auto-open="groups[0]?.items[0]?.to ?? null">
    <UAlert v-if="editor.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor.error.value" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import type { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { timezoneLabel } from '~/utils/timezone'
import { WEEK_ROWS, dayHoursSummary } from './hours'

const props = defineProps<{
  id: string
  editor: Awaited<ReturnType<typeof useLocationEditor>>
  /** A location's closures and one-off dates; the calendar marks those on its own days. */
  exceptions?: boolean
}>()

const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
// Each row keeps the query — the calendar's location and view — so Close lands where it came from.
const to = (segment: string) => router.resolve({ path: `${level.path.value}/${segment}`, query: route.query }).fullPath

const groups = computed<EditorNavigationGroup[]>(() => {
  const form = props.editor.hoursForm.value
  return [
    { id: 'timezone', items: [{ id: 'timezone', icon: 'i-lucide-globe-2', label: 'Timezone', summary: form.timezone ? timezoneLabel(form.timezone) : undefined, to: to('timezone') }] },
    { id: 'week', label: 'Regular opening hours', items: WEEK_ROWS.map(day => ({ id: day.slug, label: day.label, summary: dayHoursSummary(form.hours, day.value), to: to(day.slug) })) },
    ...(props.exceptions
      ? [{ id: 'exceptions', items: [{ id: 'exceptions', icon: 'i-lucide-calendar-off', label: 'Closures and date exceptions', to: to('exceptions') }] }]
      : []),
  ]
})
</script>
