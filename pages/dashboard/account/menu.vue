<template>
  <DashboardIndexPanel id="account-menu" title="Menu" column="leaf">
    <template #right>
      <DashboardNotificationBell :to="notificationsTo" />
    </template>
    <DashboardMenuContent />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardMenuContent from '~/lib/components/workspace/dashboard/DashboardMenuContent.vue'
import DashboardNotificationBell from '~/lib/components/workspace/dashboard/DashboardNotificationBell.vue'
definePageMeta({ layout: 'dashboard', tab: 'menu' })
useSeoMeta({ title: 'Menu | KrabiClaw', robots: 'noindex, nofollow' })
const { notificationsTo } = useDashboardMenu()
</script>
