<template>
  <TodayPage />
</template>

<script setup lang="ts">
import TodayPage from '~/components/dashboard/TodayPage.vue'

definePageMeta({ layout: 'dashboard', tab: 'today', key: route => `today:${route.params.orgSlug}` })
</script>
