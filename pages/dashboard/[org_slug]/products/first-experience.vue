<template>
  <GuidedExperienceSetup />
</template>

<script setup lang="ts">
import GuidedExperienceSetup from '~/components/dashboard/GuidedExperienceSetup.vue'

definePageMeta({
  layout: 'dashboard',
  tabs: false,
  dashboardFrame: true,
  key: route => JSON.stringify([route.params.org_slug, route.query.step ?? null]),
})
</script>
