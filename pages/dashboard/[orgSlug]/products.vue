<template>
  <ProductListPage />
</template>

<script setup lang="ts">
import ProductListPage from '~/components/dashboard/ProductListPage.vue'

// Catalog is a tab root, like Airbnb's Listings: nothing above it, so no Back.
definePageMeta({ layout: 'dashboard', tab: 'catalog', key: route => `catalog:${route.params.orgSlug}` })
</script>
