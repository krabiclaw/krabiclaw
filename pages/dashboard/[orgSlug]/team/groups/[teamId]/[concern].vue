<template><BookingTeamPage :concern="String(route.params.concern)" /></template>
<script setup lang="ts">
import BookingTeamPage from '~/components/dashboard/BookingTeamPage.vue'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
</script>
