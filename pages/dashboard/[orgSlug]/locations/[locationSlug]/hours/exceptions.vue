<template>
  <!-- Closures and date exceptions as rows, each opening its own leaf. -->
  <DashboardIndexPanel id="location-hours-exceptions" title="Closures and date exceptions">
    <UAlert v-if="editor.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor.error.value" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { exceptionLabel, exceptionSummary } from '~/lib/components/workspace/location/hours'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const level = useRouteLevel()
const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, null)

const groups = computed<EditorNavigationGroup[]>(() => [
  {
    id: 'dates',
    items: (editor.hoursForm.value.specialHours ?? []).map((entry, index) => ({
      id: String(index),
      label: exceptionLabel(entry),
      summary: exceptionSummary(entry),
      to: `${level.path.value}/${index}`,
    })),
  },
  {
    id: 'add',
    items: [
      { id: 'new-closure', icon: 'i-lucide-calendar-off', label: 'Add closure', to: `${level.path.value}/new-closure` },
      { id: 'new-hours', icon: 'i-lucide-calendar-plus', label: 'Add date hours', to: `${level.path.value}/new-hours` },
    ],
  },
].filter(group => group.items.length))
</script>
