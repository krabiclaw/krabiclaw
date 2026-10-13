<template>
  <NuxtLayout name="blawby">
    <BlawbySchedule />
  </NuxtLayout>
</template>

<script setup lang="ts">
const { template } = useTenantOrganization()
if (template.slug !== 'blawby') throw createError({ statusCode: 404 })

definePageMeta({ layout: false })
</script>
