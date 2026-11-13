<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div v-if="!thread" class="py-4" :class="dashboardGutterClass">
      <UAlert color="error" title="Team conversation could not be loaded" :description="getErrorMessage(error, 'This conversation is not available to your membership')" :actions="[{ label: 'Reload', color: 'neutral', variant: 'outline', onClick: () => refresh() }]" />
    </div>
    <template v-else-if="thread">
      <div v-if="error" class="py-3" :class="dashboardGutterClass">
        <UAlert color="error" title="Messages could not be loaded" :description="getErrorMessage(error, 'Team message request failed')" :actions="[{ label: 'Reload', color: 'neutral', variant: 'outline', onClick: () => refresh() }]" />
      </div>
      <div v-if="thread.stay || thread.record || thread.location" class="pb-2 pt-3" :class="dashboardGutterClass">
        <span v-if="thread.stay" class="text-sm text-muted">{{ thread.stay.name }} · {{ thread.stay.check_in_date }} – {{ thread.stay.check_out_date }}</span>
        <span v-else class="text-sm text-muted">{{ thread.record?.title ?? thread.location?.title }}</span>
        <TaskCard v-if="thread.job" class="mt-3" :task="thread.job" data-testid="team-thread-job" @open="jobOpen = true" />
      </div>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <UChatMessages :auto-scroll="{ size: 'sm' }" :ui="{ root: ['gap-0 py-4', dashboardGutterClass] }">
          <UButton v-if="hasMore ?? data?.has_more" class="mx-auto mb-4" color="neutral" variant="ghost" :loading="loadingMore" @click="loadMore">Earlier messages</UButton>
          <template v-for="(message, index) in messages" :key="message.id">
            <p v-if="index === 0 || day(messages[index - 1]!.created_at) !== day(message.created_at)" class="pb-2 pt-6 text-center text-xs font-medium text-highlighted">{{ day(message.created_at) }}</p>
            <div v-if="message.automatic" :id="message.id" :data-team-message="message.id" data-automatic class="mx-auto my-3 max-w-[min(36rem,86%)] rounded-2xl border border-default px-4 py-3 text-sm">
              <p class="mb-1 text-xs text-muted">Sent automatically · {{ formatClockTime(message.created_at) }}</p>
              <p class="whitespace-pre-wrap break-words">{{ message.body }}</p>
            </div>
            <UChatMessage
              v-else :id="message.id" :data-team-message="message.id" :role="message.author_user_id === userId ? 'user' : 'assistant'" :side="message.author_user_id === userId ? 'right' : 'left'" :parts="[]" :avatar="{ src: author(message)?.image ?? undefined, alt: senderName(message) }" :class="startsRun(message, index) ? 'pt-4' : 'pt-1'" :ui="{ header: message.author_user_id === userId ? 'mb-1 text-xs text-muted' : 'mb-1 ps-12 text-xs text-muted', container: 'items-end gap-2 pb-0', leading: 'mt-0 min-h-0', leadingAvatar: endsRun(message, index) ? undefined : 'invisible', body: 'min-w-0 max-w-[min(36rem,86%)]' }">
              <template v-if="startsRun(message, index)" #header><span class="font-medium text-highlighted">{{ senderName(message) }}</span><span class="ms-1.5">{{ formatClockTime(message.created_at) }}</span></template>
              <template #body>
                <div v-if="message.attachments.length" class="mb-1 grid max-w-sm gap-1" :class="message.attachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
                  <button v-for="(photo, at) in message.attachments" :key="photo.id" type="button" :aria-label="`Open photo ${at + 1} from ${senderName(message)}`" class="overflow-hidden rounded-2xl bg-elevated focus-visible:ring-2 focus-visible:ring-primary" @click="viewer = { photos: message.attachments, at }"><img :src="photo.url" :width="photo.width ?? undefined" :height="photo.height ?? undefined" alt="" class="size-full max-h-80 object-cover" :class="message.attachments.length > 1 ? 'aspect-square' : undefined" loading="lazy"></button>
                </div>
                <p v-if="message.body" class="whitespace-pre-wrap break-words rounded-2xl bg-elevated px-4 py-3 text-base leading-normal">{{ message.body }}</p>
                <UButton v-if="message.author_user_id !== userId" color="neutral" variant="link" size="xs" class="mt-1 p-0 text-muted" @click="reportError = null; reporting = message">Report</UButton>
                <div v-if="failedDeliveries(message).length" class="mt-1 text-xs text-error" data-team-delivery-failure>
                  <p>Message saved. {{ failedDeliveries(message).length === 1 ? 'A notification failed.' : `${failedDeliveries(message).length} notifications failed.` }}</p>
                  <UCollapsible v-if="failedDeliveries(message).some(delivery => delivery.error)">
                    <UButton color="error" variant="link" size="xs" class="p-0" label="Delivery error details" trailing-icon="i-lucide-chevron-down" />
                    <template #content>
                      <p v-for="delivery in failedDeliveries(message).filter(delivery => delivery.error)" :key="delivery.id" class="mt-1 whitespace-pre-wrap break-words">{{ delivery.channel }}: {{ delivery.error }}</p>
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
        <MessageComposer v-model="draft" v-model:photos="photos" :disabled="Boolean(error)" :sending="sending" placeholder="Message your team" @send="send" />
        <MessagePhotoViewer v-model="viewer" />
        <TodayTaskSheet v-if="thread.job && dashboard.organizationId.value" v-model:open="jobOpen" :task="thread.job" :organization-id="dashboard.organizationId.value" :assignees="[]" @changed="jobChanged" />
        <ReportDialog :open="reporting !== null" title="Report this message" :description="reporting ? `Tell KrabiClaw what is wrong with ${senderName(reporting)}'s message.` : ''" confirm-label="Report" :saving="reportSaving" :error="reportError" @submit="report" @close="reporting = null" />
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
import { isTeamMessagesResponse, isTeamMessageResponse, useTeamThread, type TeamMessage } from './team-thread-client'
import MessageComposer, { messageReplyForm, sameMessagePhotos, useMessagePhotoDraft, type MessagePhotoDraft } from './MessageComposer.vue'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import ReportDialog from './ReportDialog.vue'
import TaskCard from '~/components/dashboard/TaskCard.vue'
import TodayTaskSheet from '~/components/dashboard/TodayTaskSheet.vue'
const props = defineProps<{ threadId: string }>()
const api = useDashboardApi()
const dashboard = useDashboardOrganization()
const session = authClient.useSession()
const userId = computed(() => session.value.data?.user.id)
const { locale } = useI18n()
const path = computed(() => `/api/dashboard/team/threads/${encodeURIComponent(props.threadId)}`)
const { data, pending, error, refresh, clear } = await useTeamThread(computed(() => props.threadId))
const thread = computed(() => data.value?.thread ?? null)
const older = shallowRef<TeamMessage[]>([])
const hasMore = ref<boolean | null>(null)
const messages = computed(() => {
  const head = data.value?.messages ?? []
  const headIds = new Set(head.map(message => message.id))
  return [...older.value.filter(message => !headIds.has(message.id)), ...[...head].reverse()]
})
watch(data, (next, previous) => {
  if (!next || !previous || !older.value.length) return
  const nextEdge = next.messages.at(-1)?.sequence
  if (nextEdge === undefined) return
  const known = new Map(older.value.map(message => [message.id, message]))
  for (const message of previous.messages) {
    if (message.sequence < nextEdge) known.set(message.id, message)
  }
  older.value = [...known.values()].sort((a, b) => a.sequence - b.sequence)
})
const actionError = ref('')
const readError = ref('')
const pageError = ref('')
const loadingMore = ref(false)
const draft = ref('')
const photos = useMessagePhotoDraft()
const viewer = ref<MessagePhotoViewerState | null>(null)
const sending = ref(false)
let ownMessage: Pick<TeamMessage, 'id' | 'sequence'> | undefined
const attempt = ref<{ key: string; body: string; photos: MessagePhotoDraft[] } | null>(null)
const scroller = useTemplateRef<HTMLElement>('scroller')
function author(message: TeamMessage) { return thread.value?.participants.find(member => member.id === message.author_user_id) }
function senderName(message: TeamMessage) { return message.automatic ? 'Sent automatically' : message.author_user_id === userId.value ? 'You' : author(message)?.name ?? 'Former member' }
// The job strip opens the task sheet; closing the job there posts the person's own message here.
const jobOpen = ref(false)
async function jobChanged() {
  await refresh()
}
function failedDeliveries(message: TeamMessage) { return message.deliveries.filter(delivery => delivery.status === 'failed') }
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }))
const clockFormat = computed(() => new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }))
function day(at: string) { return dateFormat.value.format(new Date(at)) }
function formatClockTime(at: string) { return clockFormat.value.format(new Date(at)) }
function startsRun(message: TeamMessage, index: number) { const before = messages.value[index - 1]; return !before || before.automatic || before.author_user_id !== message.author_user_id || day(before.created_at) !== day(message.created_at) }
function endsRun(message: TeamMessage, index: number) { const after = messages.value[index + 1]; return !after || after.automatic || after.author_user_id !== message.author_user_id || day(after.created_at) !== day(message.created_at) }
let accessRevision = 0
async function loadMore() {
  if (loadingMore.value || pending.value || !(hasMore.value ?? data.value?.has_more)) return
  const before = messages.value[0]!
  const revision = accessRevision
  const height = scroller.value?.scrollHeight ?? 0
  loadingMore.value = true
  pageError.value = ''
  try {
    const page = await api(`${path.value}/messages`, { query: { limit: 20, before: before.created_at, before_id: before.id }, validate: isTeamMessagesResponse })
    if (revision !== accessRevision) return
    const existing = new Set(messages.value.map(message => message.id))
    older.value = [...page.messages].reverse().filter(message => !existing.has(message.id)).concat(older.value)
    hasMore.value = page.has_more
    await nextTick()
    if (scroller.value) scroller.value.scrollTop += scroller.value.scrollHeight - height
  } catch (cause) {
    pageError.value = getErrorMessage(cause, 'Earlier messages could not be loaded')
  } finally { loadingMore.value = false }
}

const reporting = ref<TeamMessage | null>(null)
const reportSaving = ref(false)
const reportError = ref<string | null>(null)
const reportKeys = new Map<string, string>()
async function report(reason: string) {
  const message = reporting.value
  if (!message) return
  if (!reportKeys.has(message.id)) reportKeys.set(message.id, crypto.randomUUID())
  reportSaving.value = true
  reportError.value = null
  try {
    await api(`${path.value}/messages/${encodeURIComponent(message.id)}/report`, { method: 'POST', body: { reason, idempotency_key: reportKeys.get(message.id) }, validate: isReportResponse })
    reportKeys.delete(message.id)
    reporting.value = null
  } catch (error) { reportError.value = getErrorMessage(error, 'The report could not be sent') } finally { reportSaving.value = false }
}
function isReportResponse(value: unknown): value is { report: { id: string; status: 'open' } } {
  return isRecord(value) && isRecord(value.report) && typeof value.report.id === 'string' && value.report.status === 'open'
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
    const revision = accessRevision
    const { message } = await api(`${path.value}/messages`, { method: 'POST', body: selected.length ? messageReplyForm(body, selected, current.key) : { body, idempotency_key: current.key }, validate: isTeamMessageResponse })
    if (revision !== accessRevision || !data.value) return
    ownMessage = message
    const page = data.value
    if (pending.value) { clear(); reconcile(true) }
    data.value = { ...page, messages: [message, ...page.messages.filter(item => item.id !== message.id)].sort((a, b) => b.sequence - a.sequence) }
    draft.value = ''
    photos.value = []
    attempt.value = null
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
  } catch (error) { actionError.value = getErrorMessage(error, 'Your message could not be sent') }
  finally {
    sending.value = false
    if (deferredCreates.some(message => message.id !== ownMessage?.id || message.sequence !== ownMessage.sequence)) reconcile()
    deferredCreates.length = 0
  }
}
/*
  Opening the conversation reads it through to the newest message shown, while
  the page is visible; the read GET wrote nothing. A conversation with only
  this member's own messages has nothing to read.
*/
const visibility = useDocumentVisibility()
let readThrough = ''
let markingRead = false
async function markRead() {
  if (!import.meta.client || visibility.value !== 'visible' || !data.value || markingRead) return
  const latest = data.value.messages[0]?.id ?? ''
  if (!latest || latest === readThrough || latest === ownMessage?.id || !data.value.messages.some(message => message.automatic || message.author_user_id !== userId.value)) return
  markingRead = true
  try {
    await api(`/api/dashboard/organizations/${encodeURIComponent(dashboard.organizationId.value ?? '')}/conversations/${encodeURIComponent(props.threadId)}/read`, {
      method: 'POST', body: { message_id: latest },
      validate: (value): value is { read: true; last_read_message_id: string } => isRecord(value) && value.read === true && typeof value.last_read_message_id === 'string',
    })
    readThrough = latest
    readError.value = ''
    refreshConversationUnreadCount()
  } catch (error) { readError.value = getErrorMessage(error, 'Read state could not be saved') }
  finally {
    markingRead = false
    if (!readError.value && data.value?.messages[0]?.id && data.value.messages[0].id !== readThrough) void markRead()
  }
}
watch([data, visibility], markRead, { immediate: true })
const realtime = useDashboardInvalidations()
const deferredCreates: Pick<TeamMessage, 'id' | 'sequence'>[] = []
let refreshPending = false
let fullRefresh = false
let refreshing = false
function reconcile(full = false) {
  refreshPending = true
  fullRefresh ||= full
  void drainUpdates()
}
async function drainUpdates() {
  if (refreshing || sending.value || loadingMore.value || pending.value) return
  refreshing = true
  try {
    while (refreshPending && !sending.value && !loadingMore.value && !pending.value) {
      refreshPending = false
      const rebuild = fullRefresh
      fullRefresh = false
      const oldest = older.value[0]
      const previousEdge = data.value?.messages[0]?.sequence
      const revision = accessRevision
      await refresh()
      if (!data.value || revision !== accessRevision || !oldest) continue
      const page = data.value
      const history: TeamMessage[] = []
      let hasOlder = page.has_more
      let edge = page.messages.at(-1)
      if (!rebuild && (edge === undefined || previousEdge === undefined || edge.sequence <= previousEdge)) continue
      try {
        while (hasOlder && edge && edge.sequence > oldest.sequence) {
          const next = await api(`${path.value}/messages`, { query: { limit: 100, before: edge.created_at, before_id: edge.id }, validate: isTeamMessagesResponse })
          if (revision !== accessRevision) break
          history.unshift(...[...next.messages].reverse())
          hasOlder = next.has_more
          edge = next.messages.at(-1)
        }
        if (revision === accessRevision) { older.value = history; hasMore.value = hasOlder }
      } catch (cause) {
        pageError.value = getErrorMessage(cause, 'Loaded messages could not be refreshed')
      }
    }
  } finally { refreshing = false }
}
watch([pending, sending, loadingMore], () => { void drainUpdates() })
watch(error, cause => {
  if (cause?.statusCode !== 403 && cause?.statusCode !== 404) return
  accessRevision++
  older.value = []
  hasMore.value = null
  data.value = undefined
}, { flush: 'sync' })
watch(realtime.event, event => {
  if (!event || event.organization_id !== dashboard.organizationId.value) return
  if (event.type === 'access.changed' || (event.type === 'CONVERSATION_LEAVE' && event.conversation_id === props.threadId && event.user_id === userId.value)) {
    accessRevision++
    older.value = []
    hasMore.value = null
    clear()
    if (event.type === 'access.changed') reconcile()
    return
  }
  if ((event.type !== 'MESSAGE_CREATE' && event.type !== 'MESSAGE_UPDATE') || event.conversation_id !== props.threadId) return
  if (event.type === 'MESSAGE_CREATE' && event.message) {
    if (sending.value) { deferredCreates.push(event.message); return }
    if (event.message.id === ownMessage?.id && event.message.sequence === ownMessage.sequence) return
  }
  const newest = data.value?.messages[0]?.sequence
  const headEdge = data.value?.messages.at(-1)?.sequence
  const oldest = older.value[0]?.sequence ?? headEdge
  if (event.type === 'MESSAGE_UPDATE' && event.message) {
    if (oldest !== undefined && event.message.sequence < oldest) return
    reconcile(headEdge !== undefined && event.message.sequence < headEdge)
    return
  }
  if (event.type === 'MESSAGE_CREATE' && event.message && newest !== undefined && event.message.sequence <= newest) return
  reconcile(event.type === 'MESSAGE_UPDATE')
}, { flush: 'sync' })
watch(realtime.connectionEpoch, epoch => { if (epoch > 1) reconcile(true) })
</script>
