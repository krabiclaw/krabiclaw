<template>
  <ArticlePage collection="blog" />
</template>

<script setup lang="ts">
import ArticlePage from '~/components/blog/ArticlePage.vue'

// /article is a blog article's address on templates that declare it (Blawby); nowhere else.
if (useTenantOrganization().organization.template.serviceRoutes.articleDetailPrefix !== '/article') throw createError({ statusCode: 404, statusMessage: 'Article not found' })
definePageMeta({ layout: 'articles', articleCollection: 'blog' })
</script>
