<template>
  <NuxtLayout name="blawby">
    <BlawbyTenantPage path="/donate" />
  </NuxtLayout>
</template>

<script setup lang="ts">
const { template } = useTenantOrganization().organization
if (template.slug !== 'blawby') throw createError({ statusCode: 404 })

definePageMeta({ layout: false })
</script>
