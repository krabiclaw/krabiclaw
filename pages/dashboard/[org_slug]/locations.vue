<template>
  <LocationsPage />
</template>

<script setup lang="ts">
import LocationsPage from '~/components/dashboard/LocationsPage.vue'

// A row on Menu: Menu is both its pane and its Back.
definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
</script>
