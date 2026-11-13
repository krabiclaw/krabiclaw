<template>
  <DashboardIndexPanel :id="conversation?.kind === 'team' ? 'team-conversation' : 'organization-messages-thread'" :title="conversation?.title ?? 'Conversation'" fill>
    <template v-if="guestConversation" #center>
      <div class="flex min-w-0 items-center gap-4" :data-thread-id="guestConversation.id">
        <InboxAvatar :name="guestConversation.title" :initial="guestConversation.avatar_initial" :support="guestConversation.kind === 'support'" />
        <div class="min-w-0">
          <p class="truncate text-2xl font-semibold text-highlighted">{{ guestConversation.title }}</p>
          <p class="truncate text-sm text-muted">{{ [guestConversation.home, guestConversation.when, guestConversation.translated ? 'Translation on' : null].filter(Boolean).join(' · ') }}</p>
        </div>
      </div>
    </template>
    <template v-if="conversation" #right>
      <UButton v-if="conversation.kind !== 'team'" icon="i-lucide-chevron-right" color="neutral" variant="outline" class="size-12! rounded-full bg-elevated" aria-label="In this conversation" @click="sheetOpen = true" />
      <UButton v-else-if="conversation.is_group && !conversation.booking_id && !conversation.location_id" :to="{ path: `${level.path.value}/group`, query: route.query }" icon="i-lucide-info" aria-label="Conversation details" color="neutral" variant="ghost" />
    </template>

    <ConversationThread :key="threadId" :thread-id="threadId" :history="history" />
    <ConversationSheet v-if="guestConversation" v-model:open="sheetOpen" :thread-id="threadId" :participants="guestConversation.participants" :support="guestConversation.kind === 'support'" :reservation-to="reservationTo" :can-invite="data?.capabilities.can_invite_guest ?? false" @moved="moved" @participants-changed="refresh()" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import ConversationThread from '~/lib/components/workspace/messages/ConversationThread.vue'
import ConversationSheet from '~/lib/components/workspace/messages/ConversationSheet.vue'
import InboxAvatar from '~/lib/components/workspace/messages/InboxAvatar.vue'

definePageMeta({ layout: 'dashboard', tab: 'messages', key: route => `conversation:${route.params.org_slug}:${route.params.conversation_id}` })

const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const threadId = computed(() => String(route.params.conversation_id))
const history = useConversation(threadId)
const { data, refresh } = await history.request
const conversation = computed(() => data.value?.conversation)
const guestConversation = computed(() => conversation.value?.kind === 'team' ? null : conversation.value)
const sheetOpen = ref(false)
const reservationTo = computed(() => guestConversation.value?.booking_id ? { path: `${level.path.value}/details`, query: route.query } : null)

async function moved(transition: string) {
  if (transition === 'archive' || transition === 'block') {
    await router.push({ path: `/dashboard/${String(route.params.org_slug)}/messages`, query: route.query })
  } else await refresh()
}

useSeoMeta({ title: 'Conversation | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
