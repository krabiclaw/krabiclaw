<template><ScheduledGuestMessages :thread-id="String(route.params.threadId)" /></template>
<script setup lang="ts">
import ScheduledGuestMessages from '~/lib/components/workspace/messages/ScheduledGuestMessages.vue'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
</script>
