<template>
  <!-- Airbnb's "In this conversation": who is in it, its photos, then what can be done to it. -->
  <UModal v-model:open="open" title="In this conversation" :ui="{ content: 'max-w-lg rounded-2xl', title: 'text-2xl font-semibold' }">
    <template #body>
      <ul>
        <li v-for="(person, index) in participants" :key="person.id ?? index" class="flex flex-wrap items-center gap-3 border-b border-default py-3">
          <UAvatar :src="person.image ?? undefined" :alt="person.name" />
          <span class="min-w-0 flex-1 text-base text-highlighted">{{ person.name }}<span class="block text-sm text-muted">{{ person.role === 'guest' ? 'Guest' : 'Host' }}</span></span>
          <UButton v-if="person.can_remove && person.id && removing !== person.id" label="Remove" color="error" variant="ghost" :aria-label="`Remove ${person.name}`" :disabled="savingRemoval" @click="removing = person.id; removalError = null" />
          <div v-if="person.id && removing === person.id" class="flex w-full flex-wrap items-center gap-2">
            <p class="w-full text-sm text-muted">Remove {{ person.name }} from this conversation?</p>
            <UButton label="Remove guest" color="error" :loading="savingRemoval" @click="removeGuest(person.id)" />
            <UButton label="Cancel" color="neutral" variant="ghost" :disabled="savingRemoval" @click="removing = null; removalError = null" />
          </div>
        </li>
        <li v-if="support" class="flex items-center gap-3 border-b border-default py-3">
          <InboxAvatar name="Airbnb Support" initial="A" support size="sm" />
          <span class="min-w-0 text-base text-highlighted">Airbnb Support</span>
        </li>
      </ul>
      <UAlert v-if="removalError" color="error" variant="soft" :description="removalError" />
      <UAlert v-if="error" color="error" variant="soft" title="The conversation details could not be loaded" :description="getErrorMessage(error, 'Conversation details request failed')" />
      <p v-else-if="!personalScope && !details" role="status" class="text-sm text-muted">Loading…</p>
      <template v-if="details">
        <div v-if="canInvite" class="mt-6">
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
          <NuxtLink v-if="details.actions.show_reservation && reservationTo" :to="reservationTo" class="border-b border-default py-4 text-base font-medium text-highlighted" @click="open = false">Show reservation</NuxtLink>
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
import type { RouteLocationRaw } from 'vue-router'
import type { ConversationParticipant } from '~/shared/messages-contract'
import InboxAvatar from './InboxAvatar.vue'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'
import { isConversationOperation, isThreadDetails, type ThreadDetails } from './guest-thread-client'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import ReportDialog from './ReportDialog.vue'

const props = withDefaults(defineProps<{
  threadId: string
  participants: ConversationParticipant[]
  reservationTo: RouteLocationRaw | null
  canInvite?: boolean
  support?: boolean
  personalScope?: boolean
}>(), { canInvite: false, support: false, personalScope: false })
const emit = defineEmits<{ moved: [transition: 'archive' | 'unarchive' | 'report' | 'block' | 'unblock']; participantsChanged: [] }>()
const open = defineModel<boolean>('open', { required: true })
const dashboard = useDashboardOrganization()
const api = useDashboardApi(useDashboardRouteScope())
const path = computed(() => `/api/dashboard/organizations/${dashboard.organizationId.value}/guest-threads/${encodeURIComponent(props.threadId)}`)

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
    return
  }
  if (props.personalScope) return
  details.value = null
  // Only the latest open's answer is shown; an earlier one arriving late is dropped.
  const read = ++reading
  error.value = null
  try {
    const answer = await api(`${path.value}/details`, { validate: isThreadDetails })
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

async function removeGuest(userId: string) {
  if (savingRemoval.value) return
  const revision = reading
  savingRemoval.value = true
  removalError.value = null
  try {
    await applicationFetch(`/api/messages/${encodeURIComponent(props.threadId)}/participants/${encodeURIComponent(userId)}`, {
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
    const { url } = await applicationFetch(`/api/messages/${encodeURIComponent(props.threadId)}/invite`, {
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
      await applicationFetch(`/api/messages/${encodeURIComponent(props.threadId)}/archive`, {
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
