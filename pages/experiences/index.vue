<template>
  <NuxtLayout :name="template.layout">
    <TenantPublicPage v-if="isPlatform" :path="documentPath" />
    <LazySayaExperienceCatalog v-else />
  </NuxtLayout>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const { isPlatform, template } = useTenantOrganization()
const documentPath = template.pageDocuments.paths.find(p => p === '/experiences') ?? '/experiences'
</script>
