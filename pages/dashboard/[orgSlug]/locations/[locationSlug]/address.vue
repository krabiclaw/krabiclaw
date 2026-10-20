<template>
  <LocationAddressEditor :organization-id="organizationId" :location-id="locationId" />
</template>

<script setup lang="ts">
import LocationAddressEditor from '~/lib/components/workspace/location/LocationAddressEditor.vue'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
// Nuxt mounts this page for one resolved slug. Keep its canonical ID while a
// successful save refreshes the context and moves a renamed slug's route.
const locationId = dashboardLocation.currentLocationId.value
if (!locationId) throw showNotFound('Location not found')
</script>
