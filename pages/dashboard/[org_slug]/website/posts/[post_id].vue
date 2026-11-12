<template>
  <PostEditorPage />
</template>

<script setup lang="ts">
import PostEditorPage from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({
  layout: 'dashboard', dashboardFrame: true,
  key: route => [route.params.org_slug, route.params.post_id, ...(route.params.post_id === 'new' ? [route.query.article_id ?? '', route.query.location_id ?? ''] : [])].join(':'),
})
</script>
