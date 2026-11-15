<template>
  <DashboardIndexPanel id="organization-messages-thread" :title="conversation?.title ?? 'Conversation'" fill>
    <template v-if="conversation" #center>
      <div class="flex min-w-0 items-center gap-4" :data-thread-id="conversation.id">
        <InboxAvatar :name="conversation.title" :initial="conversation.title.slice(0, 1)" :support="conversation.kind === 'support'" />
        <p class="truncate text-2xl font-semibold text-highlighted">{{ conversation.title }}</p>
      </div>
    </template>
    <template v-if="conversation" #right>
      <UButton v-if="data?.work?.type === 'done'" label="Done" color="neutral" class="rounded-full" :loading="closing" data-testid="conversation-job-done" @click="done" />
      <UButton v-if="bookingTo" :to="bookingTo" :label="data?.work?.type === 'review' ? 'Review' : 'Show booking'" color="neutral" :variant="data?.work?.type === 'review' ? 'solid' : 'soft'" class="rounded-full" />
      <UButton icon="i-lucide-info" color="neutral" variant="ghost" aria-label="In this conversation" @click="sheetOpen = true" />
    </template>

    <UAlert v-if="doneError" color="error" variant="soft" title="Done could not be saved" :description="getErrorMessage(doneError, 'The request failed')" class="mx-4 mb-2" />
    <ConversationThread :key="threadId" :thread-id="threadId" :history="history" :personal-scope="personalScope" />
    <ConversationSheet v-if="data" v-model:open="sheetOpen" :page="data" :history="history" :on-left="left" @moved="moved" @participants-changed="refresh()" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import ConversationThread from '~/lib/components/workspace/messages/ConversationThread.vue'
import ConversationSheet from '~/lib/components/workspace/messages/ConversationSheet.vue'
import InboxAvatar from '~/lib/components/workspace/messages/InboxAvatar.vue'
import { removeInboxConversationKey } from '~/lib/components/workspace/messages/guest-thread-client'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard', tab: 'messages', key: route => route.path })

const route = useRoute()
const router = useRouter()
const personalScope = route.params.org_slug === undefined
const listPath = personalScope ? '/dashboard/account/messages' : `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/messages`
const removeInboxConversation = inject(removeInboxConversationKey)
const threadId = computed(() => String(route.params.conversation_id))
const history = useConversation(threadId, personalScope)
const { data, refresh } = history.request
const conversation = computed(() => data.value?.conversation)
const sheetOpen = ref(false)
const bookingTo = computed(() => personalScope ? conversation.value?.activity_path
  : conversation.value?.booking_id
    ? `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/${encodeURIComponent(conversation.value.booking_id)}`
    : null)

// A job is done in one tap; its conversation then shows "Done" as the person's own message.
const closing = ref(false)
const doneError = ref<unknown>(null)
async function done() {
  const work = data.value?.work
  if (work?.type !== 'done' || !conversation.value) return
  closing.value = true
  doneError.value = null
  try {
    await applicationFetch(`/api/organizations/${encodeURIComponent(conversation.value.organization_id)}/tasks/${encodeURIComponent(work.task_id)}/complete`, { method: 'POST', body: {}, validate: (value: unknown): value is { task: { id: string } } => isRecord(value) && isRecord(value.task) && value.task.id === work.task_id })
    await refresh()
  } catch (cause) {
    doneError.value = cause
  } finally {
    closing.value = false
  }
}

async function left() {
  removeInboxConversation?.(threadId.value)
  await router.push({ path: listPath, query: route.query })
}

async function moved(transition: string) {
  if (transition === 'archive' || transition === 'block') await left()
  else await refresh()
}

useSeoMeta({ title: 'Conversation | KrabiClaw', robots: 'noindex, nofollow' })
</script>
