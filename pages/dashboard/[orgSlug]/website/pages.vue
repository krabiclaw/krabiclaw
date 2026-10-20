<template>
  <DashboardIndexPanel id="organization-pages" title="Pages">
    <TenantPageList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import TenantPageList from '~/components/dashboard/TenantPageList.vue'

// A row on Website: Website is both its pane and its Back.
definePageMeta({ layout: 'dashboard' })

useSeoMeta({ title: 'Pages | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
