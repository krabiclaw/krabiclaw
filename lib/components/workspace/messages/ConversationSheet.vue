<template>
  <!-- Airbnb's "In this conversation": who is in it, its photos, then what can be done to it. -->
  <UModal v-model:open="open" title="In this conversation" :ui="{ content: 'max-w-lg rounded-2xl', title: 'text-2xl font-semibold' }">
    <template #body>
      <UForm v-if="page.capabilities.can_manage_participants" :state="{ name }" class="mb-3 flex items-end gap-2" @submit="operate({ action: 'rename', name: name.trim() || null })">
        <UFormField label="Conversation name" class="flex-1">
          <UInput v-model="name" :maxlength="100" class="w-full" />
        </UFormField>
        <UButton type="submit" label="Save name" :loading="groupSaving" :disabled="(name.trim() || null) === page.conversation.name" />
      </UForm>
      <ul>
        <li v-for="(person, index) in page.conversation.participants" :key="person.id ?? index" class="flex flex-wrap items-center gap-3 border-b border-default py-3">
          <UAvatar :src="person.image ?? undefined" :alt="person.name" />
          <span class="min-w-0 flex-1 text-base text-highlighted">{{ person.name }}<span class="block text-sm text-muted">{{ person.role === 'guest' ? 'Guest' : page.conversation.kind === 'team' ? 'Member' : 'Host' }}</span></span>
          <UButton v-if="(person.can_remove || (page.capabilities.can_manage_participants && person.id !== userId)) && person.id && removing !== person.id" label="Remove" color="error" variant="ghost" :aria-label="`Remove ${person.name}`" :disabled="savingRemoval" @click="removing = person.id; removalError = null" />
          <div v-if="person.id && removing === person.id" class="flex w-full flex-wrap items-center gap-2">
            <p class="w-full text-sm text-muted">Remove {{ person.name }} from this conversation?</p>
            <UButton label="Remove" color="error" :loading="savingRemoval || groupSaving" @click="removeParticipant(person.id)" />
            <UButton label="Cancel" color="neutral" variant="ghost" :disabled="savingRemoval" @click="removing = null; removalError = null" />
          </div>
        </li>
        <li v-if="page.conversation.kind === 'support'" class="flex items-center gap-3 border-b border-default py-3">
          <InboxAvatar name="Airbnb Support" initial="A" support size="sm" />
          <span class="min-w-0 text-base text-highlighted">Airbnb Support</span>
        </li>
      </ul>
      <div v-if="page.capabilities.can_manage_participants" class="mt-4">
        <UButton v-if="!pickingMembers" label="Add people" icon="i-lucide-user-plus" color="neutral" variant="outline" :loading="loadingMembers" @click="loadMembers" />
        <template v-else>
          <UCheckbox v-for="person in availableMembers" :key="person.id" :model-value="selected.includes(person.id)" :label="person.name" :description="person.email" :disabled="groupSaving" class="py-2" @update:model-value="checked => selectMember(person.id, checked === true)" />
          <p v-if="!availableMembers.length" class="py-2 text-sm text-muted">Everyone in this workspace is already in the conversation.</p>
          <UButton v-if="availableMembers.length" label="Add" :loading="groupSaving" :disabled="!selected.length || selected.length + page.conversation.participants.length > 50" @click="operate({ action: 'add', member_user_ids: [...selected].sort() })" />
        </template>
      </div>
      <div v-if="page.capabilities.can_leave" class="mt-4">
        <UButton v-if="!leaving" label="Leave conversation" color="error" variant="ghost" @click="leaving = true" />
        <div v-else class="space-y-2">
          <p class="text-sm text-muted">Leave this conversation? The remaining participants will keep its messages.</p>
          <UButton label="Leave conversation" color="error" :loading="groupSaving" @click="operate({ action: 'leave' })" />
          <UButton label="Cancel" color="neutral" variant="ghost" :disabled="groupSaving" @click="leaving = false" />
        </div>
      </div>
      <UAlert v-if="groupError" class="mt-3" color="error" variant="soft" :description="groupError" />
      <UAlert v-if="removalError" color="error" variant="soft" :description="removalError" />
      <UAlert v-if="error" color="error" variant="soft" title="The conversation details could not be loaded" :description="getErrorMessage(error, 'Conversation details request failed')" />
      <p v-else-if="!details" role="status" class="text-sm text-muted">Loading…</p>
      <template v-if="details">
        <div v-if="page.capabilities.can_invite_guest" class="mt-6">
          <UButton label="Invite a guest" icon="i-lucide-user-plus" color="neutral" variant="outline" @click="inviting = !inviting" />
          <UForm v-if="inviting" :state="{ email: inviteEmail }" class="mt-3 space-y-3" @submit="createInvite">
            <UFormField label="Email address" required>
              <UInput v-model="inviteEmail" type="email" autocomplete="email" required :disabled="creatingInvite" class="w-full" />
            </UFormField>
            <UButton type="submit" label="Create invitation link" :loading="creatingInvite" :disabled="!inviteEmail.trim()" />
            <UFormField v-if="inviteUrl" label="Invitation link">
              <div class="flex gap-2">
                <UInput :model-value="inviteUrl" readonly class="min-w-0 flex-1" />
                <UButton :label="copied ? 'Copied' : 'Copy link'" color="neutral" variant="outline" @click="copyInvite" />
              </div>
            </UFormField>
            <UAlert v-if="inviteError" color="error" variant="soft" :description="inviteError" />
          </UForm>
        </div>

        <template v-if="details.photos.length">
          <div class="mb-2 mt-6 flex items-center justify-between">
            <h3 class="text-base font-semibold text-highlighted">Gallery</h3>
            <UButton v-if="details.photos.length > 3" color="neutral" variant="link" class="p-0 text-sm font-medium text-highlighted" trailing-icon="i-lucide-chevron-right" @click="allPhotos = !allPhotos">{{ allPhotos ? 'Show less' : 'Show all' }}</UButton>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <button v-for="(photo, at) in shownPhotos" :key="photo.id" type="button" class="aspect-square overflow-hidden rounded-xl bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverted" :aria-label="`Open photo ${at + 1} of ${details.photos.length}`" @click="viewer = { photos: details.photos.map(item => ({ url: item.url })), at }">
              <img :src="photo.thumbnail_url" alt="" loading="lazy" class="size-full object-cover">
            </button>
          </div>
        </template>

        <div class="mt-6 flex flex-col border-t border-default">
          <button v-if="details.actions.archive" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" :disabled="saving !== null" @click="move('archive')">Archive</button>
          <button v-if="details.actions.unarchive" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" :disabled="saving !== null" @click="move('unarchive')">Move to Messages</button>
          <button v-if="details.actions.report" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" :disabled="saving !== null" @click="reporting = { block: false }">Report</button>
          <button v-if="details.actions.block" type="button" class="border-b border-default py-4 text-left text-base font-medium text-error" :disabled="saving !== null" @click="reporting = { block: true }">Block</button>
          <button v-if="details.actions.unblock" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" :disabled="saving !== null" @click="move('unblock')">Unblock</button>
        </div>
        <UAlert v-if="moveError" class="mt-3" color="error" variant="soft" :description="moveError" />
      </template>
    </template>
  </UModal>
  <ReportDialog
    :open="reporting !== null"
    :title="reporting?.block ? 'Block this guest' : 'Report this conversation'"
    :description="reporting?.block ? 'Their conversation moves to Blocked guests and new messages from them stop alerting your team.' : 'Tell KrabiClaw what this guest sent.'"
    :confirm-label="reporting?.block ? 'Block and report' : 'Report'"
    :saving="saving === 'report' || saving === 'block'"
    :error="moveError"
    @submit="reason => reporting && void move(reporting.block ? 'block' : 'report', reason)"
    @close="reporting = null"
  />
  <MessagePhotoViewer v-model="viewer" />
</template>

<script setup lang="ts">
import type { ConversationPage } from '~/shared/messages-contract'
import InboxAvatar from './InboxAvatar.vue'
import { authClient } from '~/lib/auth-client'
import type { TeamMember } from '~/server/domain/team-messages'
import { isTeamMembersResponse, useTeamGroupLeaveRequest, type TeamGroupOperation } from './team-thread-client'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'
import { isConversationOperation, isThreadDetails, type ThreadDetails } from './guest-thread-client'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import ReportDialog from './ReportDialog.vue'

const props = defineProps<{ page: ConversationPage; history: ReturnType<typeof useConversation>; onLeft: () => Promise<void> }>()
const emit = defineEmits<{ moved: [transition: 'archive' | 'unarchive' | 'report' | 'block' | 'unblock']; participantsChanged: [] }>()
const threadId = computed(() => props.page.conversation.id)
const open = defineModel<boolean>('open', { required: true })
const dashboard = useDashboardOrganization()
const api = useDashboardApi(useDashboardRouteScope())
const path = computed(() => `/api/dashboard/organizations/${dashboard.organizationId.value}/guest-threads/${encodeURIComponent(threadId.value)}`)

const details = ref<ThreadDetails | null>(null)
const error = ref<unknown>(null)
// Read when the sheet opens, so it always shows the conversation as it is now.
let reading = 0
watch(open, async isOpen => {
  if (!isOpen) {
    reading++
    inviting.value = false
    inviteEmail.value = ''
    inviteUrl.value = ''
    inviteError.value = null
    copied.value = false
    removing.value = null
    removalError.value = null
    pickingMembers.value = false
    selected.value = []
    groupError.value = null
    leaving.value = false
    return
  }
  details.value = null
  // Only the latest open's answer is shown; an earlier one arriving late is dropped.
  const read = ++reading
  error.value = null
  try {
    const answer = await applicationFetch(`/api/messages/${encodeURIComponent(threadId.value)}/details`, { validate: isThreadDetails })
    if (read === reading) details.value = answer
  } catch (cause) {
    if (read === reading) error.value = cause
  }
})
const inviting = ref(false)
const inviteEmail = ref('')
const creatingInvite = ref(false)
const inviteUrl = ref('')
const inviteError = ref<string | null>(null)
const copied = ref(false)
const removing = ref<string | null>(null)
const savingRemoval = ref(false)
const removalError = ref<string | null>(null)

const session = authClient.useSession()
const userId = computed(() => session.value.data?.user.id)
const name = ref('')
watch(() => props.page.conversation.name, value => { name.value = value ?? '' }, { immediate: true })
const groupSaving = ref(false)
const groupError = ref<string | null>(null)
const leaving = ref(false)
const leaveRequest = useTeamGroupLeaveRequest()
const keys = new Map<string, string>()
const members = shallowRef<TeamMember[]>([])
const loadingMembers = ref(false)
const pickingMembers = ref(false)
const selected = ref<string[]>([])
const availableMembers = computed(() => members.value.filter(person => !props.page.conversation.participants.some(participant => participant.id === person.id)))
function selectMember(id: string, checked: boolean) {
  selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id)
}
async function loadMembers() {
  const read = reading
  loadingMembers.value = true
  groupError.value = null
  try {
    const response = await api('/api/dashboard/team/members', { validate: isTeamMembersResponse })
    if (read !== reading) return
    members.value = response.members
    pickingMembers.value = true
  } catch (cause) {
    if (read === reading) groupError.value = getErrorMessage(cause, 'Workspace members could not be loaded')
  } finally {
    loadingMembers.value = false
  }
}

async function operate(operation: TeamGroupOperation) {
  if (groupSaving.value) return
  const id = threadId.value
  const onLeft = props.onLeft
  const identity = JSON.stringify(operation)
  const key = keys.get(identity) ?? crypto.randomUUID()
  keys.set(identity, key)
  if (operation.action === 'leave') leaveRequest.value = id
  groupSaving.value = true
  groupError.value = null
  try {
    await api(`/api/dashboard/team/threads/${encodeURIComponent(id)}/operations`, {
      method: 'POST', body: { ...operation, idempotency_key: key },
      validate: (value): value is { status: 'updated' | 'left'; conversation_id: string } => isRecord(value)
        && value.conversation_id === id && value.status === (operation.action === 'leave' ? 'left' : 'updated'),
    })
    await props.history.request.refresh()
    const { data, error } = props.history.request
    if (operation.action === 'leave') {
      if (error.value?.statusCode !== 404) throw new Error('Leaving the conversation could not be verified.')
      await onLeft()
    } else {
      if (error.value) throw error.value
      const saved = data.value?.conversation
      const verified = saved && (
        operation.action === 'rename' ? saved.name === operation.name
          : operation.action === 'add' ? operation.member_user_ids.every(id => saved.participants.some(person => person.id === id))
            : !saved.participants.some(person => person.id === operation.user_id))
      if (!verified) throw new Error('The conversation change could not be verified.')
      selected.value = []
      removing.value = null
    }
    keys.delete(identity)
  } catch (cause) {
    groupError.value = getErrorMessage(cause, 'The conversation could not be updated')
  } finally {
    if (leaveRequest.value === id) leaveRequest.value = null
    groupSaving.value = false
  }
}

async function removeParticipant(userId: string) {
  if (props.page.capabilities.can_manage_participants) {
    await operate({ action: 'remove', user_id: userId })
    return
  }
  if (savingRemoval.value) return
  const revision = reading
  savingRemoval.value = true
  removalError.value = null
  try {
    await applicationFetch(`/api/messages/${encodeURIComponent(threadId.value)}/participants/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      validate: (value): value is { removed: true } => isRecord(value) && value.removed === true,
    })
    if (revision === reading) removing.value = null
    emit('participantsChanged')
  } catch (cause) {
    if (revision === reading) removalError.value = getErrorMessage(cause, 'The guest could not be removed')
  } finally {
    savingRemoval.value = false
  }
}

async function createInvite() {
  const revision = reading
  creatingInvite.value = true
  inviteUrl.value = ''
  inviteError.value = null
  copied.value = false
  try {
    const { url } = await applicationFetch(`/api/messages/${encodeURIComponent(threadId.value)}/invite`, {
      method: 'POST', body: { email: inviteEmail.value.trim() },
      validate: (value): value is { url: string; expires_at: string } => isRecord(value)
        && typeof value.url === 'string' && URL.canParse(value.url) && typeof value.expires_at === 'string',
    })
    if (revision === reading) inviteUrl.value = url
  } catch (cause) {
    if (revision === reading) inviteError.value = getErrorMessage(cause, 'The invitation link could not be created')
  } finally {
    creatingInvite.value = false
  }
}

async function copyInvite() {
  inviteError.value = null
  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    copied.value = true
  } catch (cause) {
    inviteError.value = getErrorMessage(cause, 'The invitation link could not be copied')
  }
}

const allPhotos = ref(false)
const shownPhotos = computed(() => allPhotos.value ? details.value?.photos ?? [] : details.value?.photos.slice(0, 3) ?? [])
const viewer = ref<MessagePhotoViewerState | null>(null)

const reporting = ref<{ block: boolean } | null>(null)
const saving = ref<string | null>(null)
const moveError = ref<string | null>(null)
const attemptKeys = new Map<string, string>()
async function move(transition: 'archive' | 'unarchive' | 'report' | 'block' | 'unblock', reason?: string) {
  // One key per attempt, kept until it succeeds, so a retry after a dropped response is the same request.
  // One key per attempt at the same request; a report with different words is a new request.
  const attempt = `${transition}:${reason ?? ''}`
  const idempotencyKey = attemptKeys.get(attempt) ?? crypto.randomUUID()
  attemptKeys.set(attempt, idempotencyKey)
  saving.value = transition
  moveError.value = null
  try {
    if (transition === 'archive' || transition === 'unarchive') {
      // Archive is this member's own filing (D2): the conversation's read and archive state, not an operation on it.
      const archived = transition === 'archive'
      await applicationFetch(`/api/messages/${encodeURIComponent(threadId.value)}/archive`, {
        method: 'POST', body: { archived },
        validate: (value: unknown): value is { archived: boolean } => isRecord(value) && value.archived === archived,
      })
    } else {
      await api(`${path.value}/operations/${transition}`, { method: 'POST', body: reason === undefined ? { idempotency_key: idempotencyKey } : { idempotency_key: idempotencyKey, reason }, validate: isConversationOperation })
    }
    attemptKeys.delete(attempt)
    reporting.value = null
    open.value = false
    emit('moved', transition)
  } catch (cause) {
    moveError.value = getErrorMessage(cause, transition === 'report' || transition === 'block' ? 'The report could not be sent' : 'The conversation could not be moved')
  } finally {
    saving.value = null
  }
}
</script>
