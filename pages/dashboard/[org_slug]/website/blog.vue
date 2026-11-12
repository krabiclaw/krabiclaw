<template>
  <DashboardIndexPanel id="organization-blog" title="Blog">
    <BlogPostList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import BlogPostList from '~/components/dashboard/BlogPostList.vue'

// A row on Website: Website is both its pane and its Back.
definePageMeta({ layout: 'dashboard' })

</script>
