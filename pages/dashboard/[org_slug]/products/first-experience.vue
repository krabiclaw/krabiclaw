<template>
  <GuidedOfferingSetup />
</template>

<script setup lang="ts">
import GuidedOfferingSetup from '~/components/dashboard/GuidedOfferingSetup.vue'

definePageMeta({
  layout: 'dashboard',
  tabs: false,
  dashboardFrame: true,
  key: route => route.fullPath,
})
</script>
