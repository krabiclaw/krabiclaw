<template>
  <TenantCatalog surface="products" scoped />
</template>

<script setup lang="ts">
import TenantCatalog from '~/components/products/TenantCatalog.vue'

definePageMeta({ layout: 'tenant' })
</script>
