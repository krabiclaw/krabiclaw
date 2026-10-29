<template>
  <!--
    The conversation's own column: the guest in the navbar, Details beside it
    for a thread with a record behind it, the stream in the body. The record is
    a level below this one, so it is the column beside the thread where there
    is room for one and the sheet over it where there is not — the shells decide
    that, not this page.
  -->
  <DashboardIndexPanel
    id="organization-messages-thread"
    :title="thread ? thread.participantLabel : 'Conversation'"
    fill
  >
    <template #right>
      <UDropdownMenu v-if="thread" :items="actions" :content="{ align: 'end' }">
        <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" aria-label="Conversation actions" />
      </UDropdownMenu>
      <UButton v-if="recordTo" :to="recordTo" color="neutral" variant="soft" class="h-10 rounded-full px-4" :aria-label="`Show ${recordTitle.toLowerCase()}`">
        Details
      </UButton>
    </template>

    <GuestThreadDetail :thread-id="threadId" />
    <UModal v-model:open="settingsOpen" title="Messaging settings">
      <template #body><MessagingSettings /></template>
    </UModal>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import GuestThreadDetail from '~/lib/components/workspace/messages/GuestThreadDetail.vue'
import MessagingSettings from '~/lib/components/workspace/messages/MessagingSettings.vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { threadRecordTitle } from '~/lib/components/workspace/messages/guest-thread-client'

definePageMeta({ layout: 'dashboard', key: route => `guest-conversation:${route.params.orgSlug}:${route.params.threadId}` })

const route = useRoute()
const threadId = computed(() => String(route.params.threadId))
const level = useRouteLevel()
const threadPath = level.path

// The drawer's title says what the record is called here, in the tenant's own
// word, so the conversation's control and the panel it opens agree.
const { thread } = await useGuestThread(threadId)
const dashboard = useDashboardOrganization()
// Settings for how this person writes to guests, and the conversation's automatic messages.
const settingsOpen = ref(false)
const actions = computed<DropdownMenuItem[]>(() => [
  { label: 'Messaging settings', icon: 'i-lucide-settings', onSelect: () => { settingsOpen.value = true } },
  { label: 'Automatic messages', icon: 'i-lucide-clock', to: { path: `${threadPath.value}/scheduled`, query: route.query } },
])
const recordTitle = computed(() => thread.value
  ? threadRecordTitle(thread.value.submissionType, dashboard.organization.value?.vertical ?? null)
  : 'Details')
// Opening the record keeps the list it was reached through, the same way
// closing it does. A contact thread has no record and offers no way to one.
const recordTo = computed(() => {
  if (!thread.value?.operationalRecord) return null
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(route.query)) {
    // `archived` is present and empty on the past list; the emptiness is the value.
    if (typeof value === 'string') query.set(key, value)
  }
  const search = query.toString()
  return search ? `${threadPath.value}/details?${search}` : `${threadPath.value}/details`
})

useSeoMeta({ title: 'Conversation | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
