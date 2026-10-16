<template>
  <!--
    The conversation's own column: the guest in the navbar, Details beside it
    for a thread with a record behind it, the stream in the body. The record is
    a level below this one, so it is the column beside the thread where there
    is room for one and the sheet over it where there is not — the shells decide
    that, not this page.
  -->
  <!-- On a phone the conversation is pushed over the list, so it slides in the way a pushed screen does. -->
  <DashboardIndexPanel
    id="organization-messages-thread"
    :title="thread ? thread.participantLabel : 'Conversation'"
    :ui="{ root: 'max-lg:animate-[slide-in-from-right_280ms_var(--ease-out)]', body: 'p-0 sm:p-0 gap-0' }"
    fill
  >
    <template v-if="recordTo" #right>
      <UButton :to="recordTo" color="neutral" variant="soft" class="h-10 rounded-full px-4" :aria-label="`Show ${recordTitle.toLowerCase()}`">
        Details
      </UButton>
    </template>

    <GuestThreadDetail :thread-id="threadId" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import GuestThreadDetail from '~/lib/components/workspace/messages/GuestThreadDetail.vue'
import { threadRecordTitle } from '~/lib/components/workspace/messages/guest-thread-client'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const threadId = computed(() => String(route.params.threadId))
const level = useRouteLevel()
const threadPath = level.path

// The drawer's title says what the record is called here, in the tenant's own
// word, so the conversation's control and the panel it opens agree.
const { thread } = await useGuestThread(threadId)
const dashboard = useDashboardOrganization()
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
