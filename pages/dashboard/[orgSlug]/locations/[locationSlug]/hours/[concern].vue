<template>
  <LocationHoursLeaf :editor="editor" :concern="String(route.params.concern)" />
</template>

<script setup lang="ts">
import LocationHoursLeaf from '~/lib/components/workspace/location/LocationHoursLeaf.vue'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const dashboardLocation = useDashboardLocation()
const organizationId = useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'hours')
</script>
