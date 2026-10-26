<template><SavedReplyEditorPage /></template>
<script setup lang="ts">
import SavedReplyEditorPage from '~/components/dashboard/SavedReplyEditorPage.vue'
definePageMeta({ layout: 'dashboard', key: route => `saved-reply:${route.params.orgSlug}:${route.params.templateId}` })
</script>
