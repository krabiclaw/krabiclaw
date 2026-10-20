<template>
  <BlogPostEditorPage />
</template>

<script setup lang="ts">
import BlogPostEditorPage from '~/components/dashboard/BlogPostEditorPage.vue'

// A new post becomes its own id when it is made; that is a different post, so a fresh page.
definePageMeta({ layout: 'dashboard', key: route => String(route.params.postId) })
</script>
