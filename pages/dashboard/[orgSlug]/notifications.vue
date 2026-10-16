<template>
  <DashboardIndexPanel id="organization-notifications" title="Notifications" column="reading">
    <NotificationList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import NotificationList from '~/components/dashboard/NotificationList.vue'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Notifications | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
