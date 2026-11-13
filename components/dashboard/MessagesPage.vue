<template>
  <DefineControls>
    <div class="space-y-3">
      <UInput v-if="searching" v-model="query" icon="i-lucide-search" placeholder="Search messages" aria-label="Search messages" autofocus size="lg" class="w-full" :ui="{ base: 'rounded-full' }" />
      <InboxFilters v-if="!personalScope" />
    </div>
  </DefineControls>
  <DashboardIndexPanel :id="personalScope ? 'account-messages' : 'organization-messages'" :title="blockedOnly ? 'Blocked guests' : pastOnly ? 'Past conversations' : 'Messages'" fill>
    <!-- Search and settings beside the title, as on Airbnb. -->
    <template #right>
      <UButton icon="i-lucide-search" color="neutral" variant="soft" class="rounded-full" :aria-label="searching ? 'Close search' : 'Search messages'" :aria-pressed="searching" @click="toggleSearch" />
      <UButton v-if="!personalScope && canManageMessages" icon="i-lucide-settings" color="neutral" variant="soft" class="rounded-full" aria-label="Messaging settings" @click="settingsOpen = true" />
      <UButton v-if="!personalScope && hasWorkspaceMembership" :to="`${listPath}/new`" icon="i-lucide-square-pen" color="neutral" variant="soft" class="rounded-full" aria-label="New team conversation" />
    </template>
    <ConversationList v-if="personalScope || hasWorkspaceMembership" :personal-scope="personalScope">
      <template #filters><ReuseControls /></template>
    </ConversationList>
    <UAlert v-else class="m-6" color="error" title="Messages are unavailable" description="Your membership does not allow access to conversations." />
    <UAlert v-if="accessError" class="m-6" color="error" title="Conversation access changed" :description="accessError" />
    <UModal v-model:open="settingsOpen" title="Messaging settings">
      <template #body><MessagingSettings :manage="canManageMessages && dashboard.hasFeature('stays')" @navigate="settingsOpen = false" /></template>
    </UModal>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { createReusableTemplate, watchDebounced } from '@vueuse/core'
import ConversationList from '~/lib/components/workspace/messages/ConversationList.vue'
import InboxFilters from '~/lib/components/workspace/messages/InboxFilters.vue'
import MessagingSettings from '~/lib/components/workspace/messages/MessagingSettings.vue'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { useTeamGroupLeaveRequest } from '~/lib/components/workspace/messages/team-thread-client'
import { getErrorMessage } from '~/utils/errors'
const props = defineProps<{ personalScope?: boolean }>()
const route = useRoute()
const router = useRouter()
const dashboard = useDashboardOrganization()
const listPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/messages`)
const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
const hasWorkspaceMembership = computed(() => Boolean(role.value))
const canManageMessages = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['update'] } })))
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
const session = authClient.useSession()
const accessError = ref('')
const leaveRequest = useTeamGroupLeaveRequest()
const realtime = useDashboardInvalidations()
// This member left a conversation or was removed from it: its screen closes, wherever it is open.
watch(realtime.event, async event => {
  if (event?.type !== 'CONVERSATION_LEAVE' || event.organization_id !== dashboard.organizationId.value || event.user_id !== session.value.data?.user.id) return
  clearNuxtData(`messages:${event.organization_id}:${event.conversation_id}`)
  if (route.params.conversation_id !== event.conversation_id) return
  if (leaveRequest.value === event.conversation_id) return
  try { await navigateTo({ path: listPath.value, query: route.query }, { replace: true }) }
  catch (error) { accessError.value = getErrorMessage(error, 'The conversation could not be closed after access ended') }
})
useSeoMeta({ title: 'Messages | KrabiClaw', robots: 'noindex, nofollow' })
</script>
