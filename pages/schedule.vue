<template>
  <NuxtLayout :name="site.layout">
    <TenantPublicPage path="/schedule" />
  </NuxtLayout>
</template>

<script setup lang="ts">
const { site } = useTenantOrganization().organization

definePageMeta({ layout: false })
</script>
