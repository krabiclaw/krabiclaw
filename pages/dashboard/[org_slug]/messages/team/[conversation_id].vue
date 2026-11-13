<template>
  <DashboardIndexPanel id="team-conversation" :title="thread ? teamThreadName(thread, session.data?.user.id) : 'Team conversation'" fill>
    <template v-if="thread?.is_group && !thread.booking_id && !thread.location_id" #right>
      <UButton :to="{ path: `${level.path.value}/details`, query: { kind: 'team' } }" icon="i-lucide-info" aria-label="Conversation details" color="neutral" variant="ghost" />
    </template>
    <TeamThreadDetail :key="threadId" :thread-id="threadId" />
  </DashboardIndexPanel>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { teamThreadName, useTeamThread } from '~/lib/components/workspace/messages/team-thread-client'
import TeamThreadDetail from '~/lib/components/workspace/messages/TeamThreadDetail.vue'
definePageMeta({ layout: 'dashboard', tab: 'messages' })
const route = useRoute()
const level = useRouteLevel()
const threadId = computed(() => String(route.params.conversation_id))
const session = authClient.useSession()
const { data } = await useTeamThread(threadId)
const thread = computed(() => data.value?.thread ?? null)
useSeoMeta({ title: 'Team conversation | KrabiClaw', robots: 'noindex, nofollow' })
</script>
