<template>
  <DashboardLeafPanel id="organization-website-reviews" title="Review settings" :footer="false">
    <EditorNavigationList :groups="[{ id: 'reviews', items }]" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'

definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const items = computed(() => [
  { id: 'mode', label: 'Guest reviews', summary: 'Guest reviews submitted for publication require approval. Reviews imported from Google Maps are published when you import them.' },
  { id: 'reviews', label: 'Manage reviews', to: `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/website/reviews` },
])
</script>
