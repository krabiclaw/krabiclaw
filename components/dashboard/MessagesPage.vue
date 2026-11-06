<template>
  <DefineControls>
    <div class="space-y-3">
      <UInput v-if="searching && !teamScope" v-model="query" icon="i-lucide-search" placeholder="Search messages" aria-label="Search messages" autofocus size="lg" class="w-full" :ui="{ base: 'rounded-full' }" />
      <InboxFilters v-if="!personalScope" :team="teamScope" :can-read-team="canReadTeam" :can-read-guests="canReadGuests" />
    </div>
  </DefineControls>
  <DashboardIndexPanel :id="personalScope ? 'account-messages' : 'organization-messages'" :title="teamScope ? 'Messages' : blockedOnly ? 'Blocked guests' : pastOnly ? 'Past conversations' : 'Messages'" :auto-open="firstThread" fill>
    <!-- Search and settings beside the title, as on Airbnb. -->
    <template #right>
      <UButton v-if="!teamScope" icon="i-lucide-search" color="neutral" variant="soft" class="rounded-full" :aria-label="searching ? 'Close search' : 'Search messages'" :aria-pressed="searching" @click="toggleSearch" />
      <UButton v-if="!personalScope && canReadGuests" icon="i-lucide-settings" color="neutral" variant="soft" class="rounded-full" aria-label="Messaging settings" @click="settingsOpen = true" />
      <UButton v-if="teamScope && canSendTeam" :to="{ path: `${listPath}/new`, query: { view: 'team' } }" icon="i-lucide-square-pen" color="neutral" variant="soft" class="rounded-full" aria-label="New team conversation" />
    </template>
    <TeamThreadList v-if="teamScope && canReadTeam" @first="firstThread = $event">
      <template #filters><ReuseControls /></template>
    </TeamThreadList>
    <GuestThreadList v-else-if="personalScope || canReadGuests" :personal-scope="personalScope" @first="firstThread = $event">
      <template #filters><ReuseControls /></template>
    </GuestThreadList>
    <UAlert v-else class="m-6" color="error" title="Messages are unavailable" description="Your membership does not allow access to conversations." />
    <UAlert v-if="accessError" class="m-6" color="error" title="Conversation access changed" :description="accessError" />
    <UModal v-model:open="settingsOpen" title="Messaging settings">
      <template #body><MessagingSettings :manage="canManageMessages" @navigate="settingsOpen = false" /></template>
    </UModal>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { createReusableTemplate, watchDebounced } from '@vueuse/core'
import GuestThreadList from '~/lib/components/workspace/messages/GuestThreadList.vue'
import TeamThreadList from '~/lib/components/workspace/messages/TeamThreadList.vue'
import InboxFilters from '~/lib/components/workspace/messages/InboxFilters.vue'
import MessagingSettings from '~/lib/components/workspace/messages/MessagingSettings.vue'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import type { TeamThread } from '~/server/domain/team-messages'
import { useTeamGroupLeaveRequest } from '~/lib/components/workspace/messages/team-thread-client'
import { getErrorMessage } from '~/utils/errors'
const props = defineProps<{ personalScope?: boolean }>()
const route = useRoute()
const router = useRouter()
const dashboard = useDashboardOrganization()
const listPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages`)
const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
const canReadTeam = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { team_messages: ['read'] } })))
const canSendTeam = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { team_messages: ['send'] } })))
const canReadGuests = computed(() => Boolean(role.value && (authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['read'] } }) || authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['assigned'] } }))))
const canManageMessages = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['update'] } })))
const teamScope = computed(() => !props.personalScope && (route.query.view === 'team' || route.path.startsWith(`${listPath.value}/team/`) || route.path === `${listPath.value}/new` || !canReadGuests.value))
const settingsOpen = ref(false)
const [DefineControls, ReuseControls] = createReusableTemplate()

// Search is a field the disc opens over the pills; its words are the list's `q`, so a search is a link.
const searching = ref(typeof route.query.q === 'string' && Boolean(route.query.q))
const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value && route.query.q !== undefined) {
    query.value = ''
    const { q: _q, ...rest } = route.query
    void router.replace({ path: route.path, query: rest })
  }
}
watchDebounced(query, words => {
  const { q: _q, ...rest } = route.query
  void router.replace({ path: route.path, query: words.trim() ? { ...rest, q: words.trim() } : rest })
}, { debounce: 250 })
const pastOnly = computed(() => route.query.archived !== undefined)
const blockedOnly = computed(() => !props.personalScope && route.query.blocked !== undefined)
const firstThread = ref<RouteLocationRaw | null>(null)
const session = authClient.useSession()
const accessError = ref('')
const leaveRequest = useTeamGroupLeaveRequest()
const cachedTeamThreads = useNuxtData<{ threads: TeamThread[] }>(`team-threads:${dashboard.organizationId.value}`)
const realtime = useDashboardInvalidations()
watch(realtime.event, async event => {
  if (event?.type !== 'team_thread.access_ended' || event.organizationId !== dashboard.organizationId.value || event.targetUserId !== session.value.data?.user.id) return
  if (cachedTeamThreads.data.value) cachedTeamThreads.data.value = { threads: cachedTeamThreads.data.value.threads.filter(thread => thread.id !== event.teamThreadId) }
  clearNuxtData(`team-messages:${event.organizationId}:${event.teamThreadId}`)
  if (route.params.teamThreadId !== event.teamThreadId) return
  if (leaveRequest.value === event.teamThreadId) return
  firstThread.value = null
  try { await navigateTo({ path: listPath.value, query: { view: 'team' } }, { replace: true }) }
  catch (error) { accessError.value = getErrorMessage(error, 'The conversation could not be closed after access ended') }
})
watch(teamScope, () => { firstThread.value = null }, { flush: 'sync' })
useSeoMeta({ title: 'Messages | KrabiClaw', robots: 'noindex, nofollow' })
</script>
