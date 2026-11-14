<template><ScheduledGuestMessages /></template>
<script setup lang="ts">
import ScheduledGuestMessages from '~/lib/components/workspace/messages/ScheduledGuestMessages.vue'
definePageMeta({ layout: 'dashboard', key: route => JSON.stringify({ organization: route.params.org_slug, conversation: route.query.conversation_id }) })
</script>
