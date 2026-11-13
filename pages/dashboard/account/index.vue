<template>
  <TodayPage personal-scope />
</template>

<script setup lang="ts">
import TodayPage from '~/components/dashboard/TodayPage.vue'

definePageMeta({ layout: 'dashboard', tab: 'today' })
</script>
