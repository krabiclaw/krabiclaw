<template>
  <DashboardIndexPanel id="account-menu" title="Menu" column>
    <DashboardMenuContent />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardMenuContent from '~/lib/components/workspace/dashboard/DashboardMenuContent.vue'
definePageMeta({ layout: 'dashboard', tab: 'menu' })
useSeoMeta({ title: 'Menu | Krabiclaw', robots: 'noindex, nofollow' })
</script>
