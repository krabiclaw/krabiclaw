<template>
  <div class="flex min-h-0 flex-1 flex-col" :data-team-thread-list-hydrated="hydrated ? 'true' : 'false'">
    <header class="py-3" :class="dashboardGutterClass">
      <UButton color="neutral" :variant="unreadOnly ? 'solid' : 'outline'" class="h-10 rounded-full px-4 text-sm font-normal" :aria-pressed="unreadOnly" @click="router.replace({ path: route.path, query: { view: 'team', unread: unreadOnly ? undefined : '1' } })">Unread</UButton>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto" :class="dashboardGutterClass">
      <UAlert v-if="error" class="mb-4" color="error" title="Team conversations could not be loaded" :description="getErrorMessage(error, 'Team conversation request failed')" />
      <NuxtLink v-for="thread in threads" :key="thread.id" :to="target(thread.id)" :data-team-thread="thread.id" class="-mx-3 flex items-start gap-3 rounded-xl px-3 py-4 transition hover:bg-elevated/60" :class="route.params.teamThreadId === thread.id ? 'bg-elevated' : undefined">
        <div class="flex h-12 w-2 shrink-0 items-center justify-center"><span v-if="thread.unread" class="size-2 rounded-full bg-primary" aria-label="Unread" /></div>
        <UAvatar :src="thread.participants.find(person => person.id !== userId)?.image ?? undefined" :alt="teamThreadName(thread, userId)" size="xl" />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-3"><p class="truncate text-sm font-medium text-highlighted">{{ teamThreadName(thread, userId) }}</p><span class="shrink-0 text-xs text-muted">{{ formatRelativeTime(thread.lastMessageAt) }}</span></div>
          <p v-if="thread.stay || thread.location" class="mt-0.5 truncate text-xs text-muted">{{ thread.stay ? `${thread.stay.homeName} · ${thread.stay.checkInDate} – ${thread.stay.checkOutDate}` : thread.location?.title }}</p>
          <p class="mt-0.5 line-clamp-2 text-sm leading-snug text-muted">{{ thread.lastMessage?.body || (thread.lastMessage?.attachmentCount ? `${thread.lastMessage.attachmentCount} photo${thread.lastMessage.attachmentCount === 1 ? '' : 's'}` : 'New conversation') }}</p>
        </div>
      </NuxtLink>
      <p v-if="!pending && !error && !threads.length" class="py-14 text-center text-base text-muted">{{ unreadOnly ? 'No unread team conversations' : 'No team conversations yet' }}</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { teamThreadName, useTeamThreads } from './team-thread-client'
import type { LocationQueryRaw } from 'vue-router'
const emit = defineEmits<{ first: [target: { path: string; query: LocationQueryRaw } | null] }>()
const route = useRoute()
const hydrated = ref(false)
onMounted(() => { hydrated.value = true })
const router = useRouter()
const dashboard = useDashboardOrganization()
const session = authClient.useSession()
const userId = computed(() => session.value.data?.user.id)
const { formatRelativeTime } = useHumanTime()
const { data, pending, error, refresh } = await useTeamThreads()
const unreadOnly = computed(() => route.query.unread === '1')
const threads = computed(() => (data.value?.threads ?? []).filter(thread => !unreadOnly.value || thread.unread))
const target = (id: string) => ({ path: `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages/team/${encodeURIComponent(id)}`, query: { view: 'team', unread: unreadOnly.value ? '1' : undefined } })
watch(threads, rows => emit('first', rows[0] ? target(rows[0].id) : null), { immediate: true })
const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  if ((event?.type === 'team_thread.changed' || event?.type === 'team_thread.access_ended' || event?.type === 'access.changed') && event.organizationId === dashboard.organizationId.value) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refresh() })
</script>
