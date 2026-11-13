<template>
  <DashboardIndexPanel id="account-message-thread" :title="conversation?.title || 'Conversation'" fill>
    <template v-if="guestConversation" #right>
      <UButton v-if="activityTo" :to="activityTo" color="neutral" variant="soft" class="rounded-full" :label="activityLabel" />
      <UButton icon="i-lucide-info" color="neutral" variant="ghost" aria-label="In this conversation" @click="sheetOpen = true" />
    </template>
    <ConversationThread :key="threadId" :thread-id="threadId" :history="history" personal-scope />
    <ConversationSheet v-if="guestConversation" v-model:open="sheetOpen" :thread-id="threadId" :participants="guestConversation.participants" personal-scope />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import ConversationSheet from '~/lib/components/workspace/messages/ConversationSheet.vue'
import ConversationThread from '~/lib/components/workspace/messages/ConversationThread.vue'
definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Conversation | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const threadId = computed(() => {
  if (typeof route.params.conversation_id !== 'string' || !route.params.conversation_id) throw createError({ statusCode: 404, statusMessage: 'Conversation not found.', fatal: true })
  return route.params.conversation_id
})
const history = useConversation(threadId, true)
const { data } = await history.request
const conversation = computed(() => data.value?.conversation)
const guestConversation = computed(() => conversation.value?.kind === 'team' ? null : conversation.value)
const sheetOpen = ref(false)
const activityTo = computed(() => guestConversation.value?.activity_path || null)
const activityLabel = computed(() => guestConversation.value?.record_title ? `Show ${guestConversation.value.record_title.toLowerCase()}` : '')
</script>
