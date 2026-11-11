<template>
  <DashboardIndexPanel id="organization-reviews" title="Reviews">
    <TestimonialList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import TestimonialList from '~/components/dashboard/TestimonialList.vue'

definePageMeta({ layout: 'dashboard' })

useSeoMeta({ title: 'Reviews | KrabiClaw', robots: 'noindex, nofollow' })
</script>
