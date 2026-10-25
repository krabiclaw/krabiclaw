<template>
  <BlogPostEditorPage />
</template>

<script setup lang="ts">
import BlogPostEditorPage from '~/components/dashboard/BlogPostEditorPage.vue'

// A new post becomes its own id when it is made; that is a different post, so a fresh page.
definePageMeta({ layout: 'dashboard', dashboardFrame: true, key: route => JSON.stringify([route.params.orgSlug, route.params.postId, route.params.postId === 'new' ? route.query.collection ?? null : null]) })
</script>
