<template>
  <NuxtLayout :name="template.layout">
    <TenantPublicPage v-if="isPlatform" path="/experiences" />
    <TenantExperienceCatalog v-else />
  </NuxtLayout>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const { template } = useTenantOrganization().organization
const isPlatform = template.slug === 'platform'
</script>
