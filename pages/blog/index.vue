<template>
  <ArticleIndex collection="blog" />
</template>

<script setup lang="ts">
import ArticleIndex from '~/components/blog/ArticleIndex.vue'

definePageMeta({ layout: 'articles', articleCollection: 'blog' })
const shell = useOrganizationShellState()
await shell.ready
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (shell.sections.value?.blog === false) throw createError({ statusCode: 404 })
</script>
