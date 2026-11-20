<template>
  <NuxtLayout :name="site.layout">
    <TenantCatalog surface="experiences" scoped />
  </NuxtLayout>
</template>

<script setup lang="ts">
import TenantCatalog from '~/components/products/TenantCatalog.vue'

definePageMeta({ layout: false })
const { site } = useTenantOrganization().organization
</script>
