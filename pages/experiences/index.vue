<template>
  <NuxtLayout :name="site.layout">
    <TenantPublicPage v-if="isPlatform" path="/experiences" />
    <TenantExperienceCatalog v-else />
  </NuxtLayout>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const { site } = useTenantOrganization().organization
const isPlatform = site.slug === 'platform'
</script>
