<template>
  <PostEditorPage />
</template>

<script setup lang="ts">
import PostEditorPage from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({
  layout: 'dashboard', dashboardFrame: true,
  key: route => [route.params.orgSlug, route.params.postId, ...(route.params.postId === 'new' ? [route.query.article_id ?? '', route.query.location_id ?? ''] : [])].join(':'),
})
</script>
