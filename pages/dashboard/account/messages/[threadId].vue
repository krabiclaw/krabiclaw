<template>
  <DashboardIndexPanel id="account-message-thread" :title="thread?.organizationName || 'Conversation'" fill>
    <!-- Airbnb's "Show reservation": the record this conversation is about. A contact thread has none. -->
    <template v-if="activityTo" #right><UButton :to="activityTo" color="neutral" variant="soft" class="rounded-full" :label="activityLabel" /></template>
    <GuestThreadDetail :thread-id="threadId" personal-scope />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import GuestThreadDetail from '~/lib/components/workspace/messages/GuestThreadDetail.vue'
import { threadRecordTitle } from '~/lib/components/workspace/messages/guest-thread-client'
definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Conversation | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const threadId = computed(() => {
  if (typeof route.params.threadId !== 'string' || !route.params.threadId) throw createError({ statusCode: 404, statusMessage: 'Conversation not found.', fatal: true })
  return route.params.threadId
})
const { thread } = await useGuestThread(threadId, computed(() => true))
const activityTo = computed(() => thread.value?.activityPath || null)
const activityLabel = computed(() => thread.value ? `Show ${threadRecordTitle(thread.value.submissionType, thread.value.organizationVertical).toLowerCase()}` : '')
</script>
