<template>
  <!-- Airbnb's Messages: the title, then the list with its own All / Unread pills. -->
  <DashboardIndexPanel :id="personalScope ? 'account-messages' : 'organization-messages'" :title="pastOnly ? 'Past conversations' : 'Messages'" :auto-open="firstThread" fill>
    <GuestThreadList :personal-scope="personalScope" @first="firstThread = $event" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import GuestThreadList from '~/lib/components/workspace/messages/GuestThreadList.vue'
defineProps<{ personalScope?: boolean }>()
const route = useRoute()
const pastOnly = computed(() => route.query.archived !== undefined)
const firstThread = ref<RouteLocationRaw | null>(null)
useSeoMeta({ title: 'Messages | KrabiClaw', robots: 'noindex, nofollow' })
</script>
