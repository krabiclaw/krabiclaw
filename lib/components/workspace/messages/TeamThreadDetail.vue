<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div v-if="!thread" class="py-4" :class="dashboardGutterClass">
      <UAlert color="error" title="Team conversation could not be loaded" :description="getErrorMessage(error || threadError, 'This conversation is not available to your membership')" :actions="[{ label: 'Reload', color: 'neutral', variant: 'outline', onClick: () => refreshNuxtData(`team-threads:${dashboard.organizationId.value}`) }]" />
    </div>
    <template v-else-if="thread">
      <div v-if="error || threadError" class="py-3" :class="dashboardGutterClass">
        <UAlert color="error" title="Messages could not be loaded" :description="getErrorMessage(error || threadError, 'Team message request failed')" :actions="[{ label: 'Reload', color: 'neutral', variant: 'outline', onClick: () => refresh() }]" />
      </div>
      <div v-if="thread.stay || thread.location" class="pb-2 pt-3" :class="dashboardGutterClass">
        <span v-if="thread.stay" class="text-sm text-muted">{{ thread.stay.homeName }} · {{ thread.stay.checkInDate }} – {{ thread.stay.checkOutDate }}</span>
        <span v-else class="text-sm text-muted">{{ thread.location?.title }}</span>
      </div>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <UChatMessages :auto-scroll="{ size: 'sm' }" :ui="{ root: ['gap-0 py-4', dashboardGutterClass] }">
          <UButton v-if="data?.hasMore" class="mx-auto mb-4" color="neutral" variant="ghost" :loading="loadingMore" @click="loadMore">Earlier messages</UButton>
          <template v-for="(message, index) in messages" :key="message.id">
            <p v-if="index === 0 || day(messages[index - 1]!.createdAt) !== day(message.createdAt)" class="pb-2 pt-6 text-center text-xs font-medium text-highlighted">{{ day(message.createdAt) }}</p>
            <UChatMessage :id="message.id" :data-team-message="message.id" :role="message.senderId === userId ? 'user' : 'assistant'" :side="message.senderId === userId ? 'right' : 'left'" :parts="[]" :avatar="{ src: author(message)?.image ?? undefined, alt: senderName(message) }" :class="startsRun(message, index) ? 'pt-4' : 'pt-1'" :ui="{ header: message.senderId === userId ? 'mb-1 text-xs text-muted' : 'mb-1 ps-12 text-xs text-muted', container: 'items-end gap-2 pb-0', leading: 'mt-0 min-h-0', leadingAvatar: endsRun(message, index) ? undefined : 'invisible', body: 'min-w-0 max-w-[min(36rem,86%)]' }">
              <template v-if="startsRun(message, index)" #header><span class="font-medium text-highlighted">{{ senderName(message) }}</span><span class="ms-1.5">{{ formatClockTime(message.createdAt) }}</span></template>
              <template #body>
                <div v-if="message.attachments.length" class="mb-1 grid max-w-sm gap-1" :class="message.attachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
                  <button v-for="(photo, at) in message.attachments" :key="photo.id" type="button" :aria-label="`Open photo ${at + 1} from ${senderName(message)}`" class="overflow-hidden rounded-2xl bg-elevated focus-visible:ring-2 focus-visible:ring-primary" @click="viewer = { photos: message.attachments, at }"><img :src="photo.url" :width="photo.width ?? undefined" :height="photo.height ?? undefined" alt="" class="size-full max-h-80 object-cover" :class="message.attachments.length > 1 ? 'aspect-square' : undefined" loading="lazy"></button>
                </div>
                <p v-if="message.body" class="whitespace-pre-wrap break-words rounded-2xl bg-elevated px-4 py-3 text-base leading-normal">{{ message.body }}</p>
                <div v-if="failedPushes(message).length" class="mt-1 text-xs text-error" data-team-push-failure>
                  <p>Message saved. {{ failedPushes(message).length === 1 ? 'A push notification failed.' : `${failedPushes(message).length} push notifications failed.` }}</p>
                  <UCollapsible v-if="failedPushes(message).some(delivery => delivery.error)">
                    <UButton color="error" variant="link" size="xs" class="p-0" label="Push error details" trailing-icon="i-lucide-chevron-down" />
                    <template #content>
                      <p v-for="delivery in failedPushes(message).filter(delivery => delivery.error)" :key="delivery.id" class="mt-1 whitespace-pre-wrap break-words">{{ delivery.error }}</p>
                    </template>
                  </UCollapsible>
                </div>
              </template>
            </UChatMessage>
          </template>
          <p v-if="!pending && !error && !messages.length" class="py-10 text-center text-muted">Start the conversation</p>
        </UChatMessages>
      </div>
      <div class="shrink-0 pb-4 pt-2" :class="dashboardGutterClass">
        <UAlert v-if="actionError || readError || pageError" class="mb-3" color="error" title="Conversation needs attention" :description="actionError || readError || pageError" />
        <UButton v-if="readError" class="mb-3" color="neutral" variant="ghost" @click="markRead">Retry read receipt</UButton>
        <MessageComposer v-model="draft" v-model:photos="photos" :disabled="Boolean(error || threadError)" :sending="sending" placeholder="Message your team" @send="send" />
        <MessagePhotoViewer v-model="viewer" />
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { useDocumentVisibility } from '@vueuse/core'
import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { isTeamMessagesResponse, isTeamMessageResponse, type TeamThread, type TeamMessage } from './team-thread-client'
import MessageComposer, { messageReplyForm, sameMessagePhotos, useMessagePhotoDraft, type MessagePhotoDraft } from './MessageComposer.vue'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
const props = defineProps<{ threadId: string; thread: TeamThread | null; threadError?: unknown }>()
const api = useDashboardApi()
const dashboard = useDashboardOrganization()
const session = authClient.useSession()
const userId = computed(() => session.value.data?.user.id)
const { locale } = useI18n()
const path = computed(() => `/api/dashboard/team/threads/${encodeURIComponent(props.threadId)}`)
let loadedCount = 20
let historyAnchor: { createdAt: string; id: string } | null = null
const key = `team-messages:${dashboard.organizationId.value}:${props.threadId}`
// A reconnect re-reads the loaded history window, including arrivals beyond one page.
const { data, pending, error, refresh } = await useAsyncData(key, async (_app, { signal }) => {
  let page = await api(`${path.value}/messages`, { query: { limit: Math.min(100, loadedCount) }, signal, validate: isTeamMessagesResponse })
  const beforeAnchor = (oldest: TeamMessage) => historyAnchor && (oldest.createdAt > historyAnchor.createdAt || oldest.createdAt === historyAnchor.createdAt && oldest.id > historyAnchor.id)
  while (page.hasMore && (page.messages.length < loadedCount || beforeAnchor(page.messages.at(-1)!))) {
    const oldest = page.messages.at(-1)!
    const older = await api(`${path.value}/messages`, { query: { limit: Math.min(100, Math.max(20, loadedCount - page.messages.length)), before: oldest.createdAt, beforeId: oldest.id }, signal, validate: isTeamMessagesResponse })
    page = { messages: [...page.messages, ...older.messages], hasMore: older.hasMore }
  }
  return page
})
const messages = computed(() => [...(data.value?.messages ?? [])].reverse())
const actionError = ref('')
const readError = ref('')
const pageError = ref('')
const loadingMore = ref(false)
const draft = ref('')
const photos = useMessagePhotoDraft()
const viewer = ref<MessagePhotoViewerState | null>(null)
const sending = ref(false)
const attempt = ref<{ key: string; body: string; photos: MessagePhotoDraft[] } | null>(null)
const scroller = useTemplateRef<HTMLElement>('scroller')
function author(message: TeamMessage) { return props.thread?.participants.find(member => member.id === message.senderId) }
function senderName(message: TeamMessage) { return message.senderId === userId.value ? 'You' : author(message)?.name ?? (message.senderId === null ? 'Deleted account' : 'Former team member') }
function failedPushes(message: TeamMessage) { return message.deliveries.filter(delivery => delivery.channel === 'push' && delivery.status === 'failed') }
function day(at: string) { return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(at)) }
function formatClockTime(at: string) { return new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }).format(new Date(at)) }
function startsRun(message: TeamMessage, index: number) { const before = messages.value[index - 1]; return !before || before.senderId !== message.senderId || day(before.createdAt) !== day(message.createdAt) }
function endsRun(message: TeamMessage, index: number) { const after = messages.value[index + 1]; return !after || after.senderId !== message.senderId || day(after.createdAt) !== day(message.createdAt) }
async function loadMore() {
  if (loadingMore.value || pending.value || !data.value?.hasMore) return
  loadingMore.value = true
  pageError.value = ''
  const previousCount = loadedCount
  const previousRows = data.value.messages.length
  const before = data.value.messages.at(-1)!
  const height = scroller.value?.scrollHeight ?? 0
  try {
    const older = await api(`${path.value}/messages`, { query: { limit: 20, before: before.createdAt, beforeId: before.id }, validate: isTeamMessagesResponse })
    const oldest = older.messages.at(-1) ?? before
    historyAnchor = { id: oldest.id, createdAt: oldest.createdAt }
    loadedCount = previousRows + older.messages.length
    // Reconcile from the top to the requested cursor; a concurrent arrival cannot leave a gap.
    await refresh()
    if (error.value) throw error.value
    await nextTick()
    if (scroller.value) scroller.value.scrollTop += scroller.value.scrollHeight - height
  } catch (cause) { loadedCount = previousCount; pageError.value = error.value ? '' : getErrorMessage(cause, 'Earlier messages could not be loaded') }
  finally { loadingMore.value = false }
}
async function send() {
  const body = draft.value.trim()
  const selected = photos.value
  if (sending.value || (!body && !selected.length)) return
  if (attempt.value?.body !== body || !sameMessagePhotos(attempt.value.photos, selected)) attempt.value = { key: crypto.randomUUID(), body, photos: [...selected] }
  const current = attempt.value
  sending.value = true
  actionError.value = ''
  try {
    await api(`${path.value}/messages`, { method: 'POST', body: selected.length ? messageReplyForm(body, selected, current.key) : { body, idempotencyKey: current.key }, validate: isTeamMessageResponse })
    // Clear only the exact committed draft; a failed receipt/reconciliation keeps the keyed retry.
    await refresh()
    if (error.value) throw error.value
    await refreshNuxtData(`team-threads:${dashboard.organizationId.value}`)
    draft.value = ''
    photos.value = []
    attempt.value = null
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
  } catch (error) { actionError.value = getErrorMessage(error, 'Your message could not be sent') }
  finally { sending.value = false }
}
const visibility = useDocumentVisibility()
let readThrough = ''
let markingRead = false
async function markRead() {
  if (!import.meta.client || visibility.value !== 'visible' || !data.value || markingRead) return
  const latest = data.value.messages[0]?.id ?? ''
  if (!latest || latest === readThrough) return
  markingRead = true
  try {
    await api(`${path.value}/read`, { method: 'POST', validate: (value): value is { status: 'read'; lastReadAt: string } => isRecord(value) && value.status === 'read' && typeof value.lastReadAt === 'string' })
    readThrough = latest
    readError.value = ''
    await refreshNuxtData(`team-threads:${dashboard.organizationId.value}`)
  } catch (error) { readError.value = getErrorMessage(error, 'Read state could not be saved') }
  finally {
    markingRead = false
    if (!readError.value && data.value?.messages[0]?.id && data.value.messages[0].id !== readThrough) void markRead()
  }
}
watch([data, visibility], markRead, { immediate: true })
const realtime = useDashboardInvalidations()
watch(realtime.event, event => { if (event?.type === 'team_thread.changed' && event.organizationId === dashboard.organizationId.value && event.teamThreadId === props.threadId) void refresh() })
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refresh() })
</script>
