<template><StayPhotoGrid :room-id="String(route.params.room_id)" /></template>

<script setup lang="ts">
import StayPhotoGrid from '~/components/dashboard/StayPhotoGrid.vue'
definePageMeta({ layout: 'dashboard', dashboardFrame: true })
const route = useRoute()
</script>
