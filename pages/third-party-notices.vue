<template>
  <NuxtLayout name="blawby">
    <BlawbyTenantPage :path="documentPath" />
  </NuxtLayout>
</template>

<script setup lang="ts">
const { template } = useTenantOrganization()
if (template.slug !== 'blawby') throw createError({ statusCode: 404 })
const documentPath = template.pageDocuments.recipes['third-party-notices'] || '/third-party-notices'

definePageMeta({ layout: false })
</script>
