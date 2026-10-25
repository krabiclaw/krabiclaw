<template><StayCreatePage :concern="String(route.params.concern)" /></template>

<script setup lang="ts">
import StayCreatePage from '~/components/dashboard/StayCreatePage.vue'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
</script>
