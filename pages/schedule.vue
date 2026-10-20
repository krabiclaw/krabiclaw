<template>
  <NuxtLayout :name="template.layout">
    <TenantPublicPage path="/schedule" />
  </NuxtLayout>
</template>

<script setup lang="ts">
const { template } = useTenantOrganization().organization

definePageMeta({ layout: false })
</script>
