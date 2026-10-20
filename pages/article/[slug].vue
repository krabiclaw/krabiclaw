<template>
  <div />
</template>

<script setup lang="ts">
// /article/:slug is permanently moved to /blog/:slug across all templates.
definePageMeta({
  middleware: 'tenant-blog-canonical',
})
</script>

