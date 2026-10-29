<template>
  <DashboardIndexPanel :id="personalScope ? 'account-messages' : 'organization-messages'" :title="pastOnly && !teamScope ? 'Past conversations' : 'Messages'" :auto-open="firstThread" fill>
    <template v-if="!personalScope" #right>
      <UDropdownMenu v-if="canReadGuests" :items="[{ label: 'Saved replies', to: `${listPath}/replies`, icon: 'i-lucide-message-square-text' }, { label: 'Scheduled messages', to: `${listPath}/scheduled`, icon: 'i-lucide-clock' }]">
        <UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" aria-label="Guest messaging tools" />
      </UDropdownMenu>
      <UButton v-if="canSendTeam" :to="{ path: `${listPath}/new`, query: { view: 'team' } }" icon="i-lucide-square-pen" color="neutral" variant="ghost" aria-label="New team conversation" />
    </template>
    <div v-if="!personalScope && canReadTeam && canReadGuests" class="pb-2 pt-3" :class="dashboardGutterClass">
      <DashboardFilterPills v-model="messageView" id="messages-view" label="Conversations" :items="[{ value: 'guests', label: dashboard.organization.value?.vertical === 'service' ? 'Clients' : 'Guests' }, { value: 'team', label: 'Team' }]" />
    </div>
    <TeamThreadList v-if="teamScope && canReadTeam" @first="firstThread = $event" />
    <GuestThreadList v-else-if="personalScope || canReadGuests" :personal-scope="personalScope" @first="firstThread = $event" />
    <UAlert v-else class="m-6" color="error" title="Messages are unavailable" description="Your membership does not allow access to conversations." />
    <UAlert v-if="accessError" class="m-6" color="error" title="Conversation access changed" :description="accessError" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import GuestThreadList from '~/lib/components/workspace/messages/GuestThreadList.vue'
import TeamThreadList from '~/lib/components/workspace/messages/TeamThreadList.vue'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
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
const teamScope = computed(() => !props.personalScope && (route.query.view === 'team' || route.path.startsWith(`${listPath.value}/team/`) || route.path === `${listPath.value}/new` || !canReadGuests.value))
const messageView = computed({
  get: () => teamScope.value ? 'team' : 'guests',
  set: (view: string) => { firstThread.value = null; void router.push({ path: listPath.value, query: view === 'team' ? { view: 'team' } : {} }) },
})
const pastOnly = computed(() => route.query.archived !== undefined)
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
