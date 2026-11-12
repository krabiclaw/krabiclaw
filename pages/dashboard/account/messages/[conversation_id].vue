<template>
  <DashboardIndexPanel id="account-message-thread" :title="thread?.title || 'Conversation'" fill>
    <!-- Airbnb's "Show reservation": the record this conversation is about. A contact thread has none. -->
    <template v-if="activityTo" #right><UButton :to="activityTo" color="neutral" variant="soft" class="rounded-full" :label="activityLabel" /></template>
    <GuestThreadDetail :thread-id="threadId" personal-scope />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import GuestThreadDetail from '~/lib/components/workspace/messages/GuestThreadDetail.vue'
definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Conversation | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const threadId = computed(() => {
  if (typeof route.params.conversation_id !== 'string' || !route.params.conversation_id) throw createError({ statusCode: 404, statusMessage: 'Conversation not found.', fatal: true })
  return route.params.conversation_id
})
const { thread } = await useGuestThread(threadId, computed(() => true))
const activityTo = computed(() => thread.value?.activity_path || null)
const activityLabel = computed(() => thread.value?.record_title ? `Show ${thread.value.record_title.toLowerCase()}` : '')
</script>
