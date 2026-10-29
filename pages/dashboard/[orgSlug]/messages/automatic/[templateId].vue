<template><AutomaticMessageEditorPage /></template>
<script setup lang="ts">
import AutomaticMessageEditorPage from '~/components/dashboard/AutomaticMessageEditorPage.vue'
definePageMeta({ layout: 'dashboard', key: route => `automatic-message:${route.params.orgSlug}:${route.params.templateId}` })
</script>
