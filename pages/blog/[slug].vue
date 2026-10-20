<template>
  <ArticlePage collection="blog" />
</template>

<script setup lang="ts">
import ArticlePage from '~/components/blog/ArticlePage.vue'

definePageMeta({ layout: 'articles', articleCollection: 'blog' })
</script>
