<template>
  <LocationHoursIndex id="location-hours" :editor="editor" exceptions />
</template>

<script setup lang="ts">
import LocationHoursIndex from '~/lib/components/workspace/location/LocationHoursIndex.vue'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, null)
</script>
