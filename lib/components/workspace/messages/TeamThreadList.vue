<template>
  <div class="flex min-h-0 flex-1 flex-col" :data-team-thread-list-hydrated="hydrated ? 'true' : 'false'">
    <header class="flex shrink-0 items-center gap-2 py-3 flex-wrap" :class="dashboardGutterClass">
      <slot name="filters" />
      <UButton color="neutral" :variant="unreadOnly ? 'solid' : 'outline'" class="h-10 rounded-full px-4 text-sm font-normal shrink-0" :aria-pressed="unreadOnly" @click="router.replace({ path: route.path, query: { view: 'team', unread: unreadOnly ? undefined : '1' } })">Unread</UButton>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto" :class="dashboardGutterClass">
      <UAlert v-if="error" class="mb-4" color="error" title="Team conversations could not be loaded" :description="getErrorMessage(error, 'Team conversation request failed')" />
      <!-- Structured shimmer skeletons matching team thread rows -->
      <div v-if="pending && !threads.length" class="space-y-1" role="status" aria-label="Loading team messages...">
        <div v-for="index in 4" :key="index" class="-mx-3 flex items-start gap-3 rounded-xl px-3 py-4 animate-pulse">
          <div class="flex h-12 w-2 shrink-0 items-center justify-center" />
          <div class="size-11 shrink-0 rounded-full bg-elevated/80" />
          <div class="min-w-0 flex-1 space-y-2 py-0.5">
            <div class="flex justify-between gap-3">
              <div class="h-4 w-1/3 rounded bg-elevated/80" />
              <div class="h-3 w-12 rounded bg-elevated/40" />
            </div>
            <div class="h-3 w-1/2 rounded bg-elevated/40" />
            <div class="h-3 w-4/5 rounded bg-elevated/30" />
          </div>
        </div>
      </div>
      <div v-for="thread in threads" :key="thread.id" class="-mx-3">
        <MessageRowActions :unread="thread.unread" :name="teamThreadName(thread, userId)" @toggle="toggleRead(thread)">
          <NuxtLink :to="target(thread.id)" :data-team-thread="thread.id" class="flex items-start gap-3 rounded-xl px-3 py-4 transition hover:bg-elevated/60" :class="route.params.teamThreadId === thread.id ? 'bg-elevated' : undefined">
            <div class="flex h-12 w-2 shrink-0 items-center justify-center"><span v-if="thread.unread" class="size-2 rounded-full bg-primary" aria-label="Unread" /></div>
            <UAvatar :src="thread.participants.find(person => person.id !== userId)?.image ?? undefined" :alt="teamThreadName(thread, userId)" size="xl" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-3"><p class="truncate text-sm font-medium text-highlighted">{{ teamThreadName(thread, userId) }}</p><span class="shrink-0 text-xs text-muted">{{ formatRelativeTime(thread.lastMessageAt) }}</span></div>
              <p v-if="thread.stay || thread.location" class="mt-0.5 truncate text-xs text-muted">{{ thread.stay ? `${thread.stay.homeName} · ${thread.stay.checkInDate} – ${thread.stay.checkOutDate}` : thread.location?.title }}</p>
              <p class="mt-0.5 line-clamp-2 text-sm leading-snug text-muted">{{ thread.lastMessage?.body || (thread.lastMessage?.attachmentCount ? `${thread.lastMessage.attachmentCount} photo${thread.lastMessage.attachmentCount === 1 ? '' : 's'}` : 'New conversation') }}</p>
            </div>
          </NuxtLink>
        </MessageRowActions>
      </div>
      <p v-if="!pending && !error && !threads.length" class="py-14 text-center text-base text-muted">{{ unreadOnly ? 'No unread team conversations' : 'No team conversations yet' }}</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { teamThreadName, useTeamThreads, type TeamThread } from './team-thread-client'
import MessageRowActions from './MessageRowActions.vue'
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
if (import.meta.client) {
  onMounted(() => {
    if (useNuxtApp().payload.data[`team-threads:${dashboard.organizationId.value}`]) {
      void refresh()
    }
  })
}
const unreadOnly = computed(() => route.query.unread === '1')
const threads = computed(() => (data.value?.threads ?? []).filter(thread => !unreadOnly.value || thread.unread))
const target = (id: string) => ({ path: `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages/team/${encodeURIComponent(id)}`, query: { view: 'team', unread: unreadOnly.value ? '1' : undefined } })
watch(threads, rows => emit('first', rows[0] ? target(rows[0].id) : null), { immediate: true })
// Read or unread without opening it, as the guest list does.
const api = useDashboardApi()
const toast = useToast()
// A row being saved takes no second toggle, so a failure cannot put back a state the member has since changed.
const toggling = new Set<string>()
async function toggleRead(thread: TeamThread) {
  if (toggling.has(thread.id)) return
  toggling.add(thread.id)
  try { await saveRead(thread) } finally { toggling.delete(thread.id) }
}
async function saveRead(thread: TeamThread) {
  const read = thread.unread
  const mark = (unread: boolean) => {
    if (data.value) data.value = { ...data.value, threads: data.value.threads.map(row => row.id === thread.id ? { ...row, unread, unreadCount: unread ? Math.max(row.unreadCount, 1) : 0 } : row) }
  }
  mark(!read)
  try {
    await api(`/api/dashboard/team/threads/${encodeURIComponent(thread.id)}/${read ? 'read' : 'unread'}`, {
      method: 'POST',
      validate: (value: unknown): value is { status: string } => typeof value === 'object' && value !== null && Reflect.get(value, 'status') === (read ? 'read' : 'unread'),
    })
  } catch (cause) {
    mark(read)
    toast.add({ color: 'error', title: read ? 'Could not mark as read' : 'Could not mark as unread', description: getErrorMessage(cause, 'The conversation was not changed') })
    return
  }
  await refresh()
}
const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  // notification.read: this member read or marked a conversation on another device or tab.
  if ((event?.type === 'team_thread.changed' || event?.type === 'team_thread.access_ended' || event?.type === 'access.changed' || event?.type === 'notification.read') && event.organizationId === dashboard.organizationId.value) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refresh() })
</script>
