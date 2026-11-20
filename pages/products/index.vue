<template>
  <NuxtLayout :name="isPlatform ? 'platform' : 'tenant'">
    <TenantPublicPage v-if="isPlatform" path="/products" />
    <TenantCatalog v-else surface="products" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import TenantCatalog from '~/components/products/TenantCatalog.vue'
definePageMeta({ layout: false })
const { site } = useTenantOrganization().organization
const isPlatform = site.slug === 'platform'
</script>
