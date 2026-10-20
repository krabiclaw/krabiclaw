<template>
  <NuxtLayout :name="isPlatform ? 'platform' : 'tenant'">
    <TenantPublicPage v-if="isPlatform" path="/products" />
    <TenantProductCatalog v-else />
  </NuxtLayout>
</template>

<script setup lang="ts">
import TenantProductCatalog from '~/components/products/TenantProductCatalog.vue'
definePageMeta({ layout: false })
const { template } = useTenantOrganization().organization
const isPlatform = template.slug === 'platform'
</script>
