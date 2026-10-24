<template>
  <DashboardIndexPanel id="team-conversation" :title="thread ? teamThreadName(thread, session.data?.user.id) : 'Team conversation'" fill>
    <TeamThreadDetail :key="threadId" :thread-id="threadId" :thread="thread" :thread-error="error" />
  </DashboardIndexPanel>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { teamThreadName, useTeamThreads } from '~/lib/components/workspace/messages/team-thread-client'
import TeamThreadDetail from '~/lib/components/workspace/messages/TeamThreadDetail.vue'
definePageMeta({ layout: 'dashboard', tab: 'messages' })
const route = useRoute()
const threadId = computed(() => String(route.params.teamThreadId))
const session = authClient.useSession()
const { data, error } = await useTeamThreads()
const thread = computed(() => data.value?.threads.find(item => item.id === threadId.value) ?? null)
useSeoMeta({ title: 'Team conversation | KrabiClaw', robots: 'noindex, nofollow' })
</script>
