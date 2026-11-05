<template>
  <!-- Airbnb's "In this conversation": who is in it, its photos, then what can be done to it. -->
  <UModal v-model:open="open" title="In this conversation" :ui="{ content: 'max-w-lg rounded-2xl', title: 'text-2xl font-semibold' }">
    <template #body>
      <UAlert v-if="error" color="error" variant="soft" title="The conversation could not be loaded" :description="getErrorMessage(error, 'Conversation details request failed')" />
      <p v-else-if="!details" role="status" class="text-sm text-muted">Loading…</p>
      <template v-else>
        <ul>
          <li v-for="person in details.participants" :key="`${person.role}:${person.name}`" class="flex items-center gap-3 border-b border-default py-3">
            <span class="flex size-10 shrink-0 items-center justify-center rounded-full font-semibold" :class="person.role === 'Airbnb Support' ? 'bg-inverted text-[9px] text-inverted' : 'bg-accented text-highlighted'">{{ person.role === 'Airbnb Support' ? 'Airbnb' : person.initial }}</span>
            <span class="min-w-0 text-base text-highlighted">{{ person.name }}<span class="block text-sm text-muted">{{ person.role }}</span></span>
          </li>
        </ul>

        <template v-if="details.photos.length">
          <div class="mb-2 mt-6 flex items-center justify-between">
            <h3 class="text-base font-semibold text-highlighted">Gallery</h3>
            <UButton v-if="details.photos.length > 3" color="neutral" variant="link" class="p-0 text-sm font-medium text-highlighted" trailing-icon="i-lucide-chevron-right" @click="allPhotos = !allPhotos">{{ allPhotos ? 'Show less' : 'Show all' }}</UButton>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <button v-for="(photo, at) in shownPhotos" :key="photo.id" type="button" class="aspect-square overflow-hidden rounded-xl bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverted" :aria-label="`Open photo ${at + 1} of ${details.photos.length}`" @click="viewer = { photos: details.photos.map(item => ({ url: item.url })), at }">
              <img :src="photo.thumbnailUrl" alt="" loading="lazy" class="size-full object-cover">
            </button>
          </div>
        </template>

        <div class="mt-6 flex flex-col border-t border-default">
          <NuxtLink v-if="details.actions.showReservation && reservationTo" :to="reservationTo" class="border-b border-default py-4 text-base font-medium text-highlighted" @click="open = false">Show reservation</NuxtLink>
          <button v-if="details.actions.archive" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" :disabled="saving !== null" @click="move('archive')">Archive</button>
          <button v-if="details.actions.unarchive" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" :disabled="saving !== null" @click="move('unarchive')">Move to Messages</button>
          <button v-if="details.actions.report" type="button" class="border-b border-default py-4 text-left text-base font-medium text-highlighted" @click="reporting = { block: false }">Report</button>
          <button v-if="details.actions.block" type="button" class="border-b border-default py-4 text-left text-base font-medium text-error" @click="reporting = { block: true }">Block</button>
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
import { getErrorMessage } from '~/utils/errors'
import { isThreadDetailResponse, isThreadDetails, type ThreadDetails } from './guest-thread-client'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import ReportDialog from './ReportDialog.vue'

const props = defineProps<{ threadId: string; reservationTo: string | null }>()
const emit = defineEmits<{ moved: [transition: 'archive' | 'unarchive' | 'report' | 'block' | 'unblock'] }>()
const open = defineModel<boolean>('open', { required: true })
const dashboard = useDashboardOrganization()
const api = useDashboardApi(useDashboardRouteScope())
const path = computed(() => `/api/dashboard/organizations/${dashboard.organizationId.value}/guest-threads/${encodeURIComponent(props.threadId)}`)

const details = ref<ThreadDetails | null>(null)
const error = ref<unknown>(null)
// Read when the sheet opens, so it always shows the conversation as it is now.
watch(open, async isOpen => {
  if (!isOpen) return
  error.value = null
  try { details.value = await api(`${path.value}/details`, { validate: isThreadDetails }) }
  catch (cause) { error.value = cause }
})
const allPhotos = ref(false)
const shownPhotos = computed(() => allPhotos.value ? details.value?.photos ?? [] : details.value?.photos.slice(0, 3) ?? [])
const viewer = ref<MessagePhotoViewerState | null>(null)

const reporting = ref<{ block: boolean } | null>(null)
const saving = ref<string | null>(null)
const moveError = ref<string | null>(null)
const attemptKeys = new Map<string, string>()
async function move(transition: 'archive' | 'unarchive' | 'report' | 'block' | 'unblock', reason?: string) {
  // One key per attempt, kept until it succeeds, so a retry after a dropped response is the same request.
  const idempotencyKey = attemptKeys.get(transition) ?? crypto.randomUUID()
  attemptKeys.set(transition, idempotencyKey)
  saving.value = transition
  moveError.value = null
  try {
    await api(`${path.value}/operations/${transition}`, { method: 'POST', body: reason === undefined ? { idempotencyKey } : { idempotencyKey, reason }, validate: isThreadDetailResponse })
    attemptKeys.delete(transition)
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
