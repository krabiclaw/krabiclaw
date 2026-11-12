<template><AutomaticMessageEditorPage /></template>
<script setup lang="ts">
import AutomaticMessageEditorPage from '~/components/dashboard/AutomaticMessageEditorPage.vue'
definePageMeta({ layout: 'dashboard', key: route => `automatic-message:${route.params.org_slug}:${route.params.template_id}` })
</script>
