<template>
  <DashboardIndexPanel id="organization-messages-thread" :title="conversation?.title ?? 'Conversation'" fill :auto-open="reservationTo">
    <!-- Airbnb's thread header: who is in it, what it is about, and one way into "In this conversation". No row of buttons. -->
    <template v-if="conversation" #center>
      <button type="button" class="me-auto flex min-w-0 items-center gap-3 overflow-hidden rounded-full py-1 pe-2 text-left hover:bg-elevated" :data-thread-id="conversation.id" aria-label="In this conversation" @click="sheetOpen = true">
        <span class="flex shrink-0 -space-x-3">
          <InboxAvatar v-for="person in conversation.participants.slice(0, 3)" :key="person.id ?? person.name" :name="person.name" :initial="person.name.slice(0, 1)" :image="person.image" :support="conversation.kind === 'support'" size="sm" class="ring-2 ring-default" />
        </span>
        <span class="truncate text-xl font-semibold text-highlighted">{{ conversation.title }}</span>
        <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </button>
    </template>

    <!-- The reservation opens beside the conversation; its way in sits right of the title, as Airbnb's does, while the panel is closed. -->
    <template v-if="reservationTo && !level.child.value" #right>
      <UButton :to="reservationTo" :label="data?.work?.type === 'review' ? 'Review' : 'Show reservation'" color="neutral" variant="soft" class="rounded-full" data-testid="conversation-show-reservation" />
    </template>

    <UAlert v-if="doneError" color="error" variant="soft" title="Done could not be saved" :description="getErrorMessage(doneError, 'The request failed')" class="mx-4 mb-2" />
    <ConversationThread :key="threadId" :thread-id="threadId" :history="history" :personal-scope="personalScope" :closing="closing" @done="done" />
    <ConversationSheet v-if="data" v-model:open="sheetOpen" :page="data" :history="history" :on-left="left" :booking-to="reservationTo" @moved="moved" @participants-changed="refresh()" />
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
const level = useRouteLevel()
// The reservation's panel is this conversation's child, so the thread stays beside it.
const reservationTo = computed(() => personalScope ? conversation.value?.activity_path ?? null
  : conversation.value?.booking_id ? `${listPath}/${encodeURIComponent(threadId.value)}/reservation/${encodeURIComponent(conversation.value.booking_id)}` : null)

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
