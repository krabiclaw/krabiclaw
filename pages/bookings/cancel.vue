<template>
  <NuxtLayout :name="site.layout">
    <GuestCancelPage />
  </NuxtLayout>
</template>

<script setup lang="ts">
import GuestCancelPage from '~/components/booking/GuestCancelPage.vue'

definePageMeta({ layout: false })
const { site } = useTenantOrganization().organization
</script>
