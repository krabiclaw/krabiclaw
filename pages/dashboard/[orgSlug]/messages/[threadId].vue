<template>
  <!--
    The conversation's own column, headed as Airbnb's is: one row with the
    person's circle, their name, the home and dates, and a chevron that opens
    "In this conversation". The reservation is the level below, beside the
    thread where there is room and over it where there is not.
  -->
  <DashboardIndexPanel id="organization-messages-thread" :title="thread?.guestName ?? 'Conversation'" fill>
    <template v-if="thread" #center>
      <div class="flex min-w-0 items-center gap-4" :data-thread-id="thread.id">
        <InboxAvatar :name="thread.guestName" :initial="thread.avatarInitial" :support="thread.kind === 'support'" />
        <div class="min-w-0">
          <p class="truncate text-2xl font-semibold text-highlighted">{{ thread.guestName }}</p>
          <p class="truncate text-sm text-muted">{{ [thread.home, thread.when, thread.translated ? 'Translation on' : null].filter(Boolean).join(' · ') }}</p>
        </div>
      </div>
    </template>
    <template v-if="thread" #right>
      <UButton icon="i-lucide-chevron-right" color="neutral" variant="outline" class="size-12! rounded-full bg-elevated" aria-label="In this conversation" @click="sheetOpen = true" />
    </template>

    <GuestThreadDetail :thread-id="threadId" />
    <ConversationSheet v-model:open="sheetOpen" :thread-id="threadId" :reservation-to="reservationTo" @moved="moved" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import GuestThreadDetail from '~/lib/components/workspace/messages/GuestThreadDetail.vue'
import ConversationSheet from '~/lib/components/workspace/messages/ConversationSheet.vue'
import InboxAvatar from '~/lib/components/workspace/messages/InboxAvatar.vue'

definePageMeta({ layout: 'dashboard', key: route => `guest-conversation:${route.params.orgSlug}:${route.params.threadId}` })

const route = useRoute()
const router = useRouter()
const threadId = computed(() => String(route.params.threadId))
const level = useRouteLevel()
const { thread, refresh } = await useGuestThread(threadId)
const sheetOpen = ref(false)

// Show reservation keeps the list it was reached through. A conversation with no record has none.
const reservationTo = computed(() => {
  if (!thread.value?.recordId) return null
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(route.query)) if (typeof value === 'string') query.set(key, value)
  const search = query.toString()
  return search ? `${level.path.value}/details?${search}` : `${level.path.value}/details`
})

// A conversation archived or blocked leaves this list; the list opens the next one.
async function moved(transition: string) {
  refreshNuxtData()
  if (transition === 'archive' || transition === 'block') await router.push({ path: `/dashboard/${String(route.params.orgSlug)}/messages`, query: route.query })
  else await refresh()
}

useSeoMeta({ title: 'Conversation | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
