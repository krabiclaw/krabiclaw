<template>
  <DashboardLeafPanel id="team-conversation-members" title="Members" lead="People added to this conversation can read its history. Removing someone ends their access and keeps their messages." :footer="false" :error="actionError || (error || membersError ? getErrorMessage(error || membersError, 'Conversation members could not be loaded') : !thread ? 'This conversation is not available to your membership' : '')">
    <template v-if="thread">
      <div class="divide-y divide-default">
        <div v-for="person in thread.participants" :key="person.id" class="flex items-center gap-3 py-4">
          <UAvatar :src="person.image ?? undefined" :alt="person.name" />
          <span class="min-w-0 flex-1 text-highlighted">{{ person.name }}{{ person.id === userId ? ' (you)' : '' }}</span>
          <UButton v-if="thread.canManage && person.id !== userId" icon="i-lucide-user-minus" :aria-label="`Remove ${person.name}`" color="error" variant="ghost" :disabled="saving" @click="removing = person" />
        </div>
      </div>
      <template v-if="thread.canManage && members">
        <h2 class="mt-8 text-lg font-semibold">Add people</h2>
        <div class="mt-3 divide-y divide-default">
          <UCheckbox v-for="person in available" :key="person.id" :model-value="selected.includes(person.id)" :label="person.name" :description="person.email" :disabled="saving" class="w-full py-4" @update:model-value="toggle(person.id, $event === true)" />
        </div>
        <p v-if="!available.length" class="mt-4 text-muted">Everyone in this workspace is already in the conversation.</p>
        <UButton v-if="available.length" class="mt-6" label="Add" :loading="saving" :disabled="!selected.length || thread.participants.length + selected.length > 50" @click="add" />
      </template>
    </template>
    <UModal :open="removing !== null" :title="`Remove ${removing?.name ?? 'participant'}?`" description="They will lose access to this conversation. Their messages will stay." :dismissible="!saving" @update:open="value => { if (!value) removing = null }">
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" :disabled="saving" @click="removing = null" />
        <UButton color="error" label="Remove" :loading="saving" @click="remove" />
      </template>
    </UModal>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { isTeamMembersResponse, useTeamGroup } from '~/lib/components/workspace/messages/team-thread-client'
import { getErrorMessage } from '~/utils/errors'
import type { TeamParticipant } from '~/server/domain/team-messages'
definePageMeta({ layout: 'dashboard', tab: 'messages' })
const { thread, error, operate } = await useTeamGroup()
const api = useDashboardApi()
const dashboard = useDashboardOrganization()
const session = authClient.useSession()
const userId = computed(() => session.value.data?.user.id)
const { data: members, error: membersError } = await useAsyncData(`team-members:${dashboard.organizationId.value}`, () => api('/api/dashboard/team/members', { validate: isTeamMembersResponse }))
const available = computed(() => members.value?.members.filter(person => !thread.value?.participants.some(participant => participant.id === person.id)) ?? [])
const selected = ref<string[]>([])
const removing = ref<TeamParticipant | null>(null)
const saving = ref(false)
const actionError = ref('')
function toggle(id: string, checked: boolean) { selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter(userId => userId !== id) }
async function add() {
  if (saving.value || !selected.value.length || !thread.value?.canManage) return
  saving.value = true
  actionError.value = ''
  try { await operate({ action: 'add', memberIds: [...selected.value].sort() }); selected.value = [] }
  catch (error) { actionError.value = getErrorMessage(error, 'People could not be added to the conversation') }
  finally { saving.value = false }
}
async function remove() {
  if (saving.value || !removing.value || !thread.value?.canManage) return
  saving.value = true
  actionError.value = ''
  try { await operate({ action: 'remove', userId: removing.value.id }); removing.value = null }
  catch (error) { removing.value = null; actionError.value = getErrorMessage(error, 'The participant could not be removed') }
  finally { saving.value = false }
}
</script>
