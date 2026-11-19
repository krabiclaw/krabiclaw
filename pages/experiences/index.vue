<template>
  <NuxtLayout :name="site.layout">
    <TenantPublicPage v-if="isPlatform" path="/experiences" />
    <TenantCatalog v-else surface="experiences" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import TenantCatalog from '~/components/products/TenantCatalog.vue'
definePageMeta({ layout: false })

const { site } = useTenantOrganization().organization
const isPlatform = site.slug === 'platform'
</script>
