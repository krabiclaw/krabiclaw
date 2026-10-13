<template>
  <NuxtLayout :name="template.layout">
    <GuestCancelPage kind="booking" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import GuestCancelPage from '~/components/booking/GuestCancelPage.vue'

definePageMeta({ layout: false })
const { template } = useTenantOrganization()
</script>
