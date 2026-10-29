<template>
  <DashboardIndexPanel id="team-conversation-details" title="Conversation details" :lead="thread?.name ?? undefined">
    <UAlert v-if="error || !thread" color="error" title="Conversation is unavailable" :description="getErrorMessage(error, 'This conversation is not available to your membership')" />
    <template v-else>
      <EditorNavigationList :groups="groups" :active-item="level.child.value" />
      <UButton v-if="thread.canLeave" class="mt-8" color="error" variant="ghost" label="Leave conversation" @click="leaving = true" />
    </template>
    <UAlert v-if="actionError" class="mt-6" color="error" :description="actionError" />
    <UButton v-if="actionError && !thread" class="mt-4" color="neutral" variant="outline" label="Retry leaving conversation" :loading="saving" @click="leave" />
    <UModal v-model:open="leaving" title="Leave conversation?" description="You will lose access to this conversation. Its messages will stay for the remaining participants." :dismissible="!saving">
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" :disabled="saving" @click="leaving = false" />
        <UButton color="error" label="Leave conversation" :loading="saving" @click="leave" />
      </template>
    </UModal>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { useTeamGroup } from '~/lib/components/workspace/messages/team-thread-client'
import { getErrorMessage } from '~/utils/errors'
definePageMeta({ layout: 'dashboard', tab: 'messages' })
const route = useRoute()
const level = useRouteLevel()
const { thread, error, operate } = await useTeamGroup()
const leaving = ref(false)
const saving = ref(false)
const actionError = ref('')
const groups = computed(() => [{ id: 'conversation', items: [
  ...(thread.value?.canManage ? [{ id: 'name', label: 'Name', summary: thread.value.name ?? 'No name', to: `${level.path.value}/name?view=team` }] : []),
  { id: 'members', label: 'Members', summary: `${thread.value?.participants.length ?? 0} people`, icon: 'i-lucide-users', to: `${level.path.value}/members?view=team` },
] }])
async function leave() {
  if (saving.value) return
  saving.value = true
  actionError.value = ''
  try {
    await operate({ action: 'leave' })
    leaving.value = false
    await navigateTo({ path: `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages`, query: { view: 'team' } }, { replace: true })
  } catch (error) { leaving.value = false; actionError.value = getErrorMessage(error, 'The conversation could not be left') }
  finally { saving.value = false }
}
</script>
