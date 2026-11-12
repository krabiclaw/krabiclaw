<template>
  <ProductEditorPage />
</template>

<script setup lang="ts">
import ProductEditorPage from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({
  layout: 'dashboard', dashboardFrame: true,
  key: route => JSON.stringify([route.params.org_slug, route.params.product_id, ...(route.params.product_id === 'new' ? [route.query.kind ?? null, route.query.location_id ?? null, route.query.collection_id ?? null] : [])]),
})
</script>
