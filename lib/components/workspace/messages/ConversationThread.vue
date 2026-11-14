<template>
  <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
    <!-- A request that failed, or a conversation that is gone, is a state this surface shows rather than a blank column. -->
    <div v-if="!thread && !pending" class="pt-3" :class="dashboardGutterClass">
      <UAlert
        color="error"
        variant="soft"
        :title="isNotFoundError(error) ? 'This conversation is no longer available' : 'Conversation could not be loaded'"
        :description="isNotFoundError(error) ? 'It may have been deleted, or the link is from another business.' : getErrorMessage(error, 'Conversation request failed')"
      />
    </div>

    <template v-else-if="thread">
      <div v-if="thread.kind === 'team' && (thread.stay || thread.record || thread.location)" class="pb-2 pt-3" :class="dashboardGutterClass">
        <span v-if="thread.stay" class="text-sm text-muted">{{ thread.stay.name }} · {{ thread.stay.check_in_date }} – {{ thread.stay.check_out_date }}</span>
        <span v-else class="text-sm text-muted">{{ thread.record?.title ?? thread.location?.title }}</span>
        <TaskCard v-if="thread.job" class="mt-3" :task="thread.job" data-testid="team-thread-job" @open="jobOpen = true" />
      </div>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-default" style="overflow-anchor: none">
        <div v-if="olderFailureCount" class="px-4 pt-3 text-center text-sm text-error" role="status">
          {{ olderFailureCount === 1 ? 'An older message has a delivery failure.' : `${olderFailureCount} older messages have delivery failures.` }}
        </div>
        <div v-if="before || olderError" class="flex flex-col items-center gap-2 pt-3">
          <UButton v-if="before" color="neutral" variant="ghost" :loading="loadingOlder" @click="loadOlder">{{ thread.kind === 'team' ? 'Earlier messages' : 'Load older messages' }}</UButton>
          <p v-if="olderError" class="text-sm text-error" role="alert">{{ olderError }}</p>
        </div>
        <div class="flex flex-col gap-1 py-4" :class="dashboardGutterClass">
          <p v-if="!rows.length && !pending && !error" class="py-10 text-center text-muted">Start the conversation</p>
          <template v-for="item in rows" :key="item.key">
            <p v-if="item.type === 'day'" class="mb-1 mt-3 text-center text-xs font-medium text-dimmed">{{ item.label }}</p>

            <p v-else-if="item.type === 'event'" class="my-2 text-center text-xs text-muted">{{ item.text }}</p>

            <div v-else class="flex min-w-0 max-w-[76%] flex-col gap-0.5" :class="item.mine ? 'items-end self-end' : 'relative items-start self-start pl-10'" :data-message="item.key">
              <span v-if="!item.mine" class="absolute bottom-0 left-0"><InboxAvatar :name="item.runs[0]!.author" :initial="initialOf(item.runs[0]!.author)" :support="thread.kind === 'support'" size="sm" /></span>
              <p class="mb-1 mt-2.5 text-sm text-muted"><span class="text-highlighted">{{ item.runs[0]!.label ? `${item.runs[0]!.author} · ${item.runs[0]!.label}` : item.runs[0]!.author }}</span> {{ item.runs[0]!.time }}</p>
              <div v-for="message in item.runs" :key="settledKeys[message.id] ?? message.id" class="flex min-w-0 flex-col" :class="item.mine ? 'items-end' : 'items-start'" :data-team-message="thread.kind === 'team' ? message.id : undefined" :data-automatic="message.automatic || undefined">
                <div v-if="message.photos.length" class="grid max-w-sm gap-1" :class="[message.photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1', message.sending ? 'opacity-60' : '']">
                  <button
                    v-for="(photo, at) in message.photos"
                    :key="photo.id"
                    type="button"
                    class="block overflow-hidden rounded-2xl bg-accented focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverted"
                    :aria-label="`Open photo ${at + 1} of ${message.photos.length} from ${message.author}`"
                    @click="viewer = { photos: message.photos.map(item => ({ url: item.url })), at }"
                  >
                    <img :src="photo.thumbnail_url" alt="" :width="photo.width ?? undefined" :height="photo.height ?? undefined" loading="lazy" class="size-full object-cover" :class="message.photos.length > 1 ? 'aspect-square' : 'max-h-80'">
                  </button>
                </div>
                <div
                  v-if="message.body"
                  class="max-w-full whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2.5 text-base [overflow-wrap:anywhere]"
                  :class="[item.mine ? 'rounded-br-md bg-inverted text-inverted' : 'rounded-bl-md bg-elevated text-default', message.sending ? 'opacity-60' : '']"
                >{{ message.translated && originals.has(message.id) ? message.translated.original : message.body }}</div>
                <p v-if="message.unshown_files" class="mx-1 mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <UIcon name="i-lucide-paperclip" class="size-3.5 shrink-0" />{{ message.unshown_files === 1 ? 'Sent a file that can’t be shown here' : `Sent ${message.unshown_files} files that can’t be shown here` }}
                </p>
                <p v-if="message.translated" class="mx-1 mt-0.5 text-xs text-muted">
                  Translated · <button type="button" class="text-highlighted underline underline-offset-2" @click="toggleOriginal(message.id)">{{ originals.has(message.id) ? 'Show translation' : 'Show original' }}</button>
                </p>
                <p v-if="message.receipt" class="mt-0.5 text-xs" :class="message.receipt === 'Not delivered' ? 'text-error' : 'text-muted'">
                  {{ message.receipt }}<template v-if="message.retryable"> · <button type="button" class="underline underline-offset-2 disabled:opacity-50" :disabled="retrying" @click="retry(message.id)">Try again</button></template>
                </p>
                <UButton v-if="thread.kind === 'team' && !message.automatic && !item.mine" color="neutral" variant="link" size="xs" class="mt-1 p-0 text-muted" @click="reportError = null; reporting = message">Report</UButton>
                <div v-if="thread.kind === 'team' && failedDeliveries(message).length" class="mt-1 text-xs text-error" data-team-delivery-failure>
                  <p>Message saved. {{ failedDeliveries(message).length === 1 ? 'A notification failed.' : `${failedDeliveries(message).length} notifications failed.` }}</p>
                  <UCollapsible v-if="failedDeliveries(message).some(delivery => delivery.error)">
                    <UButton color="error" variant="link" size="xs" class="p-0" label="Delivery error details" trailing-icon="i-lucide-chevron-down" />
                    <template #content>
                      <p v-for="delivery in failedDeliveries(message).filter(delivery => delivery.error)" :key="delivery.id" class="mt-1 whitespace-pre-wrap break-words">{{ delivery.channel }}: {{ delivery.error }}</p>
                    </template>
                  </UCollapsible>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="shrink-0 pb-6 pt-2" :class="dashboardGutterClass">
        <UAlert v-if="actionError || readError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError ?? readError ?? undefined" class="mb-2" />
        <UButton v-if="readError" class="mb-2" color="neutral" variant="ghost" @click="readThroughNewest">Retry read receipt</UButton>

        <UButton v-if="scheduledTo" :to="scheduledTo" label="Sent and upcoming" icon="i-lucide-clock" color="neutral" variant="link" size="sm" class="mb-1" />

        <!-- Suggested replies: rows above the composer, never side by side; one fills the field and does not send. -->
        <div v-if="shownSuggestions.length" class="mb-2">
          <div class="mb-2 flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-sparkles" class="size-[18px]" />Suggested replies
            <button type="button" class="ms-auto flex size-6 items-center justify-center" aria-label="Dismiss suggested replies" @click="dismissedFor = latestGuestMessage; recalledFor = null">
              <UIcon name="i-lucide-x" class="size-4" />
            </button>
          </div>
          <div class="flex flex-col gap-2">
            <button v-for="(option, index) in shownSuggestions" :key="option" type="button" class="flex min-h-12 items-center gap-3 rounded-2xl bg-elevated px-4 py-3 text-left text-base text-highlighted transition hover:bg-accented" @click="useSuggestion(option, index)">
              <span class="flex-1">{{ option }}</span>
              <UIcon name="i-lucide-arrow-up-right" class="size-4 shrink-0 text-muted" />
            </button>
          </div>
        </div>
        <p v-if="suggestionError" class="mb-2 flex items-center gap-2 text-xs text-muted">
          {{ suggestionError }}
          <UButton label="Retry" color="neutral" variant="link" size="xs" @click="suggestionAttempt += 1" />
        </p>

        <UAlert v-if="requestingChange" class="mb-3" color="info" variant="soft" :description="t(changeRequestSent ? 'booking.change_request_sent' : 'booking.change_request_help')" />
        <!-- Where the reply operation cannot send (no email, account or connected Airbnb home), there is no composer: its reason shows instead. -->
        <p v-if="!canSend" class="rounded-2xl bg-elevated px-4 py-3 text-sm text-muted">{{ guestThread?.composer.reason ?? 'Sending is unavailable in this conversation.' }}</p>
        <MessageComposer v-else v-model="draft" v-model:photos="chosen" v-model:send-at="sendAt" :sending="sending" :channel="guestThread?.composer.channel ?? 'team'" :send-later="!personalScope && guestThread !== null" :suggestions-hidden="suggestionsHidden" :placeholder="thread.kind === 'team' ? 'Message your team' : undefined" :send-label="requestingChange && !changeRequestSent ? t('booking.request_change') : guestThread ? 'Send reply' : 'Send message'" @send="sendReply" @show-suggestions="recallSuggestions" />
        <MessagePhotoViewer v-model="viewer" />
        <TodayTaskSheet v-if="thread.kind === 'team' && thread.job && dashboard.organizationId.value" v-model:open="jobOpen" :task="thread.job" :organization-id="dashboard.organizationId.value" :assignees="[]" @changed="refresh()" />
        <ReportDialog :open="reporting !== null" title="Report this message" :description="reporting ? `Tell KrabiClaw what is wrong with ${reporting.author}'s message.` : ''" confirm-label="Report" :saving="reportSaving" :error="reportError" @submit="report" @close="reporting = null" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { isConversationEntry, isConversationOperation } from './guest-thread-client'
import type { ConversationEntry, ConversationPage } from '~/shared/messages-contract'
import type { MessageIdentity } from '~/shared/dashboard-invalidations'

import { useDocumentVisibility } from '@vueuse/core'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'
import { useConversationInvalidations } from '~/composables/useDashboardInvalidations'
import { authClient } from '~/lib/auth-client'
import MessageComposer, { messageReplyForm, sameMessagePhotos, useMessagePhotoDraft, type MessagePhotoDraft } from './MessageComposer.vue'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import InboxAvatar from './InboxAvatar.vue'
import ReportDialog from './ReportDialog.vue'
import TaskCard from '~/components/dashboard/TaskCard.vue'
import TodayTaskSheet from '~/components/dashboard/TodayTaskSheet.vue'
import { isScheduledMessageResponse, isSuggestedReplies, useSuggestedReplies } from './guest-messaging-client'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'

const props = withDefaults(defineProps<{ threadId: string; personalScope?: boolean; history: ReturnType<typeof useConversation> }>(), { personalScope: false })

const dashboard = useDashboardOrganization()
const route = useRoute()
const dashboardApi = useDashboardApi()
const toast = useToast()
const { locale, t } = useI18n()
const session = authClient.useSession()
const userId = computed(() => session.value.data?.user.id)
const { readPage, path, organizationId } = props.history
const { data, pending, error, refresh: refreshHead, clear } = props.history.request
const thread = computed(() => data.value?.conversation ?? null)
const conversationOrganization = computed(() => thread.value?.organization_id ?? organizationId.value ?? undefined)
const realtime = useConversationInvalidations(computed(() => props.threadId), conversationOrganization, props.personalScope)
const guestThread = computed(() => thread.value?.kind === 'team' ? null : thread.value)
const scheduledTo = computed(() => !props.personalScope && guestThread.value ? {
  path: `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/messages/scheduled`,
  query: { ...route.query, conversation_id: props.threadId },
} : null)
const entries = computed(() => data.value?.entries ?? [])
const canSend = computed(() => data.value?.capabilities.can_send === true)
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }))
const clockFormat = computed(() => new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }))
const older = shallowRef<ConversationPage[]>([])
const olderError = ref<string | null>(null)
const loadingOlder = ref(false)
const transcriptPage = computed(() => data.value?.page)
const jobOpen = ref(false)
const olderFailureCount = computed(() => {
  const failures = transcriptPage.value?.failed_messages ?? []
  if (!failures.length) return 0
  const loaded = new Set([...entries.value, ...older.value.flatMap(page => page.entries)].map(item => item.id))
  return failures.filter(id => !loaded.has(id)).length
})
const before = computed(() => older.value.length ? older.value[0]!.page.before : transcriptPage.value?.before)
let olderRequest: AbortController | undefined

function clearTranscript() {
  olderRequest?.abort()
  older.value = []
  clear()
}

async function loadOlder() {
  if (!before.value || loadingOlder.value || pending.value || reconciling) return
  const cursor = before.value
  const controller = new AbortController()
  olderRequest = controller
  loadingOlder.value = true
  olderError.value = null
  try {
    const previous = await readPage(cursor, controller.signal)
    if (controller.signal.aborted || cursor !== before.value || previous.conversation.id !== props.threadId) return
    const el = scroller.value
    const height = el?.scrollHeight ?? 0
    const top = el?.scrollTop ?? 0
    older.value = [previous, ...older.value]
    await nextTick()
    if (el) el.scrollTop = top + el.scrollHeight - height
  } catch (cause) {
    if (!controller.signal.aborted) {
      olderError.value = getErrorMessage(cause, 'Older messages could not be loaded')
      if (isNotFoundError(cause) || (isRecord(cause) && cause.statusCode === 403)) clearTranscript()
    }
  } finally {
    loadingOlder.value = false
  }
}

async function refresh(options?: Parameters<typeof refreshHead>[0], rebuild = true) {
  olderRequest?.abort()
  const previous = data.value ?? null
  const revision = accessRevision
  await refreshHead(options)
  if (revision !== accessRevision) return
  if (!rebuild && retainOlder(previous)) return
  await reconcileOlder(previous?.page, older.value.length)
}

// A create can shift rows out of the head without changing the older window.
function retainOlder(previous: ConversationPage | null): boolean {
  if (!previous || !older.value.length) return true
  const current = data.value
  if (!current) return false
  if (previous.page.oldest === current.page.oldest) return true
  const headIds = new Set(current.entries.filter(item => item.type !== 'day').map(item => item.id))
  const overlap = previous.entries.findIndex(item => headIds.has(item.id))
  if (overlap < 0) return false
  const pages = older.value
  const last = pages.at(-1)!
  older.value = [...pages.slice(0, -1), { ...last, entries: [...last.entries, ...previous.entries.slice(0, overlap)] }]
  return true
}

async function reconcileOlder(previousHead: typeof transcriptPage.value | undefined, olderPages: number) {
  if (!thread.value) { older.value = []; return }
  // Rebuild the loaded cursor window when the head moves or an existing
  // message changes. Commit the older pages together so deleted rows vanish.
  const nextHead = transcriptPage.value
  if (olderPages && nextHead) {
    const controller = new AbortController()
    olderRequest = controller
    const pages: ConversationPage[] = []
    let cursor = nextHead.before
    const oldest = older.value[0]?.page.oldest ?? previousHead?.oldest
    try {
      for (let remaining = olderPages + 1; cursor && remaining > 0; remaining--) {
        const page = await readPage(cursor, controller.signal)
        pages.unshift(page)
        cursor = page.page.before
        if (oldest !== null && oldest !== undefined && page.page.oldest !== null && page.page.oldest <= oldest) break
      }
      if (!controller.signal.aborted) older.value = pages
    } catch (cause) {
      if (!controller.signal.aborted) {
        olderError.value = getErrorMessage(cause, 'Loaded messages could not be refreshed')
        if (isNotFoundError(cause) || (isRecord(cause) && cause.statusCode === 403)) clearTranscript()
      }
    }
  }
}
onScopeDispose(() => olderRequest?.abort())
const guestActions = computed(() => `/api/dashboard/organizations/${organizationId.value}/guest-threads/${encodeURIComponent(props.threadId)}`)

const draft = ref('')
// A suggestion on Today opens the conversation with its message written in the navigation's state; the owner reviews and sends it.
watch(() => props.threadId, () => {
  if (!import.meta.client || props.personalScope) return
  const { draft: written, ...state } = (window.history.state ?? {}) as Record<string, unknown>
  if (typeof written !== 'string') return
  if (!draft.value.trim()) draft.value = written
  window.history.replaceState(state, '')
}, { immediate: true })
const requestingChange = computed(() => props.personalScope && route.query.intent === 'booking-change' && guestThread.value?.booking_id && guestThread.value.composer.channel === 'email')
const changeRequestSent = ref(false)
watch(() => `${props.threadId}:${String(route.query.intent)}`, () => { changeRequestSent.value = false })
const sendAt = ref<string | null>(null)
const actionError = ref<string | null>(null)
const readError = ref<string | null>(null)

type MessageItem = Extract<ConversationEntry, { type: 'message' }> & { sending?: boolean }
const failedDeliveries = (message: MessageItem) => message.deliveries.filter(delivery => delivery.status === 'failed')
type Row =
  | { type: 'day'; key: string; label: string }
  | { type: 'event'; key: string; text: string }
  | { type: 'run'; key: string; mine: boolean; runs: MessageItem[] }

/*
  A reply shows the moment it is sent, dimmed and "Sending" until the server
  has it. The attempt keeps its idempotency key until it succeeds, so sending
  the same words again after a failure is the same request, not a second one.
*/
const attempt = ref<{ key: string; body: string; photos: MessagePhotoDraft[] } | null>(null)
const sending = ref(false)
let settledReply: MessageIdentity | undefined
const deferredCreates: MessageIdentity[] = []
let reconcileRequested = false
let rebuildRequested = false
let reconciling = false
let accessRevision = 0

function reconcileThread(rebuild = false) {
  reconcileRequested = true
  rebuildRequested ||= rebuild
  void drainThreadChanges()
}

async function drainThreadChanges() {
  if (reconciling || pending.value || sending.value || !reconcileRequested) return
  reconciling = true
  try {
    while (reconcileRequested && !sending.value) {
      reconcileRequested = false
      const rebuild = rebuildRequested
      rebuildRequested = false
      await refresh({ dedupe: 'defer' }, rebuild)
    }
  } finally {
    reconciling = false
  }
}
watch([pending, sending], () => { void drainThreadChanges() })

// The server's message for a reply that was on screen as a pending one takes its key, so it settles in place.
const settledKeys = ref<Record<string, string>>({})

// The reader's own side is on the right: the business in its inbox, the guest in theirs.
const mineSide = computed(() => props.personalScope ? 'guest' : 'business')

/** The server marks the first message of each run with its time; a run continues until the next mark. */
const rows = computed<Row[]>(() => {
  const current = thread.value
  if (!current) return []
  const items: Array<ConversationEntry | MessageItem> = []
  const seen = new Set<string>()
  let previousDay: string | undefined
  let previousMessage: MessageItem | undefined
  const currentIds = new Set(entries.value.map(item => item.id))
  for (const item of [...older.value.flatMap(page => page.entries).filter(item => !currentIds.has(item.id)), ...entries.value]) {
    if (seen.has(item.id)) continue
    if (item.type === 'day') {
      if (previousDay === item.label) continue
      previousDay = item.label
    }
    if (current.kind === 'team' && item.type === 'message') {
      const date = new Date(item.sent_at)
      const day = dateFormat.value.format(date)
      if (previousDay !== day) {
        items.push({ type: 'day', id: `day:${day}`, label: day })
        previousDay = day
        previousMessage = undefined
      }
      const startsRun = !previousMessage || item.automatic || previousMessage.automatic || item.author_user_id !== previousMessage.author_user_id
      items.push({ ...item, time: startsRun ? clockFormat.value.format(date) : null })
      previousMessage = item
    } else items.push(item)
    seen.add(item.id)
  }
  if (attempt.value && sending.value && !items.some(item => item.type === 'message' && settledKeys.value[item.id] === `pending:${attempt.value?.key}`)) {
    items.push({
      type: 'message', id: `pending:${attempt.value.key}`, sequence: Number.MAX_SAFE_INTEGER, side: mineSide.value, author: 'You', author_user_id: userId.value ?? null, automatic: false, deliveries: [], label: null, sent_at: new Date().toISOString(),
      time: 'Sending', body: attempt.value.body || null, translated: null, receipt: null, retryable: false, unshown_files: 0, sending: true,
      photos: attempt.value.photos.map((photo, at) => ({ id: `${attempt.value!.key}:${at}`, url: photo.url, thumbnail_url: photo.url, width: null, height: null })),
    })
  }
  const out: Row[] = []
  for (const item of items) {
    const key = settledKeys.value[item.id] ?? item.id
    if (item.type === 'day') out.push({ type: 'day', key, label: item.label })
    else if (item.type === 'event') out.push({ type: 'event', key, text: item.text })
    else {
      const last = out.at(-1)
      const mine = current.kind === 'team' ? item.author === 'You' : item.side === mineSide.value
      if (item.time === null && last?.type === 'run' && last.mine === mine && last.runs[0]!.author === item.author) last.runs.push(item)
      else out.push({ type: 'run', key, mine, runs: [item] })
    }
  }
  return out
})

const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

// "Show original" swaps a translated bubble to the guest's own words.
const originals = ref(new Set<string>())
function toggleOriginal(id: string) {
  const next = new Set(originals.value)
  if (!next.delete(id)) next.add(id)
  originals.value = next
}
const viewer = ref<MessagePhotoViewerState | null>(null)

/*
  Suggested replies, from the latest guest message: none for a support case or
  while the host is typing, gone on ×, and asked again when the guest writes.
*/
const suggestionsOn = useSuggestedReplies(() => dashboard.organizationId.value)
const suggestions = ref<string[]>([])
const generationId = ref<string | null>(null)
// The draft the field was filled from, sent with the reply so the server meters it; edits keep it.
const usedSuggestion = ref<{ generation_id: string; index: number } | null>(null)
const suggestionError = ref<string | null>(null)
const suggestionAttempt = ref(0)
const dismissedFor = ref<string | null>(null)
// None for a conversation nobody can reply to: it has no composer, so nothing is drafted for it.
const latestGuestMessage = computed(() => {
  if (!guestThread.value?.composer.available) return null
  const last = entries.value.findLast(item => item.type === 'message')
  return last?.type === 'message' && last.side === 'guest' && guestThread.value.kind === 'guest' ? last.id : null
})
// Typing or × puts them away; the composer's + brings them back until the guest writes again.
const recalledFor = ref<string | null>(null)
const suggestionsVisible = computed(() => recalledFor.value === latestGuestMessage.value || (!draft.value.trim() && dismissedFor.value !== latestGuestMessage.value))
const shownSuggestions = computed(() => suggestionsVisible.value ? suggestions.value : [])
const suggestionsHidden = computed(() => suggestions.value.length > 0 && !suggestionsVisible.value)
function recallSuggestions() { recalledFor.value = latestGuestMessage.value }
function useSuggestion(option: string, index: number) {
  draft.value = option
  usedSuggestion.value = generationId.value ? { generation_id: generationId.value, index } : null
}
// Clearing the field lets go of the draft it came from.
watch(draft, words => { if (!words.trim()) usedSuggestion.value = null })
watch([latestGuestMessage, suggestionsOn, suggestionAttempt], async ([messageId, on]) => {
  suggestions.value = []
  generationId.value = null
  suggestionError.value = null
  if (props.personalScope || !on || !messageId || !import.meta.client) return
  try {
    const result = await dashboardApi(`${guestActions.value}/suggested-reply`, { method: 'POST', validate: isSuggestedReplies })
    if (latestGuestMessage.value === messageId) { suggestions.value = result.suggestions; generationId.value = result.generation_id }
  } catch (err) {
    suggestionError.value = `Replies could not be suggested: ${getErrorMessage(err, 'Suggested reply request failed')}`
  }
}, { immediate: true })

async function sendReply() {
  const body = draft.value.trim()
  const photos = chosen.value
  if (!thread.value || !canSend.value || (!body && !photos.length) || sending.value) return
  if (sendAt.value) {
    sending.value = true
    actionError.value = null
    try {
      await dashboardApi(`${guestActions.value}/send-later`, { method: 'POST', body: { body, due_at: sendAt.value, ...(usedSuggestion.value ? { suggestion: usedSuggestion.value } : {}) }, validate: isScheduledMessageResponse })
      draft.value = ''
      usedSuggestion.value = null
      sendAt.value = null
      toast.add({ title: 'Message scheduled', color: 'success' })
    } catch (err) {
      actionError.value = getErrorMessage(err, 'The message could not be scheduled')
    } finally {
      sending.value = false
    }
    return
  }
  if (attempt.value?.body !== body || !sameMessagePhotos(attempt.value.photos, photos)) {
    attempt.value = { key: crypto.randomUUID(), body, photos }
  }
  const current = attempt.value
  const revision = accessRevision
  sending.value = true
  actionError.value = null
  void scrollToLatest('instant')
  try {
    const { message } = await applicationFetch(path.value, {
      method: 'POST',
      body: photos.length ? messageReplyForm(body, photos, current.key, usedSuggestion.value)
        : { body, idempotency_key: current.key, ...(usedSuggestion.value && { suggestion: usedSuggestion.value }) },
      validate: (value): value is { message: MessageItem } => isRecord(value) && isConversationEntry(value.message) && value.message.type === 'message',
    })
    if (revision !== accessRevision || !data.value) return
    settledReply = message
    settledKeys.value = { ...settledKeys.value, [message.id]: `pending:${current.key}` }
    if (!entries.value.some(item => item.id === message.id)) {
      // A delayed live refresh may have captured the head before the send landed.
      const page = data.value
      if (pending.value) {
        clear()
        reconcileThread()
      }
      const listed = page.entries
      const at = listed.findIndex(entry => entry.type !== 'day' && entry.sequence > message.sequence)
      const previous = listed[at < 0 ? listed.length - 1 : at - 1]
      const sent = previous?.type === 'message' && previous.author === message.author && previous.side === message.side
        ? message
        : { ...message, time: clockFormat.value.format(new Date(message.sent_at)) }
      data.value = {
        ...page,
        entries: at < 0 ? [...listed, sent] : [...listed.slice(0, at), sent, ...listed.slice(at)],
        page: { ...page.page, oldest: page.page.oldest ?? message.sequence, newest: Math.max(page.page.newest ?? 0, message.sequence) },
      }
    }
    if (requestingChange.value) changeRequestSent.value = true
    attempt.value = null
    draft.value = ''
    usedSuggestion.value = null
    chosen.value = []
  } catch (err) {
    if (revision !== accessRevision) return
    actionError.value = getErrorMessage(err, 'Failed to send reply')
    // The words and photos come back to the composer rather than vanishing with the bubble.
    if (!draft.value) draft.value = body
    if (!chosen.value.length) chosen.value = photos
  } finally {
    if (deferredCreates.splice(0).some(message => message.id !== settledReply?.id || message.sequence !== settledReply.sequence)) reconcileThread()
    sending.value = false
  }
}

const chosen = useMessagePhotoDraft()

const reporting = ref<MessageItem | null>(null)
const reportSaving = ref(false)
const reportError = ref<string | null>(null)
const reportKeys = new Map<string, string>()
async function report(reason: string) {
  const message = reporting.value
  if (!message) return
  const key = reportKeys.get(message.id) ?? crypto.randomUUID()
  reportKeys.set(message.id, key)
  reportSaving.value = true
  reportError.value = null
  try {
    await dashboardApi(`/api/dashboard/team/threads/${encodeURIComponent(props.threadId)}/messages/${encodeURIComponent(message.id)}/report`, {
      method: 'POST', body: { reason, idempotency_key: key },
      validate: (value): value is { report: { id: string; status: 'open' } } =>
        isRecord(value) && isRecord(value.report) && typeof value.report.id === 'string' && value.report.status === 'open',
    })
    reportKeys.delete(message.id)
    reporting.value = null
  } catch (cause) { reportError.value = getErrorMessage(cause, 'The report could not be sent') }
  finally { reportSaving.value = false }
}

// "Try again" sends the same reply under its own key, so one that did land is not sent twice.
const retrying = ref(false)
async function retry(messageId: string) {
  const revision = accessRevision
  retrying.value = true
  actionError.value = null
  try {
    await dashboardApi(`${guestActions.value}/operations/retry`, { method: 'POST', body: { message_id: messageId, idempotency_key: messageId }, validate: isConversationOperation })
    if (revision === accessRevision) await refresh()
  } catch (err) {
    actionError.value = getErrorMessage(err, 'The reply could not be sent again')
  } finally {
    retrying.value = false
  }
}

watch(realtime.event, event => {
  if (!event || event.organization_id !== conversationOrganization.value) return
  if (event.type === 'access.changed' || (event.type === 'CONVERSATION_LEAVE' && event.conversation_id === props.threadId && event.user_id === userId.value)) {
    accessRevision++
    settledReply = undefined
    deferredCreates.length = 0
    clearTranscript()
    if (event.type === 'access.changed') reconcileThread()
    return
  }
  if ((event.type !== 'MESSAGE_CREATE' && event.type !== 'MESSAGE_UPDATE') || event.scheduled || event.conversation_id !== props.threadId) return
  if (event.type === 'MESSAGE_CREATE' && event.message) {
    const message = event.message
    if (sending.value) { deferredCreates.push(message); return }
    if (message.id === settledReply?.id && message.sequence === settledReply.sequence) return
  }
  const oldest = older.value[0]?.page.oldest ?? transcriptPage.value?.oldest
  if (event.type === 'MESSAGE_UPDATE' && event.message && oldest != null && event.message.sequence < oldest) {
    // Thread-wide delivery failure summaries still depend on offscreen messages.
    reconcileThread()
    return
  }
  reconcileThread(event.type === 'MESSAGE_UPDATE' && (!event.message || transcriptPage.value?.oldest == null || event.message.sequence < transcriptPage.value.oldest))
}, { flush: 'sync' })

watch(error, cause => {
  if (cause?.statusCode !== 403 && cause?.statusCode !== 404) return
  older.value = []
  olderRequest?.abort()
  draft.value = ''
  chosen.value = []
  viewer.value = null
  attempt.value = null
  sendAt.value = null
  suggestions.value = []
}, { flush: 'sync' })

watch(realtime.connectionEpoch, (epoch) => {
  if (epoch > 1) reconcileThread(true)
})

const documentVisibility = useDocumentVisibility()

/*
  Opening a conversation reads it through to the newest message shown, while
  the page is visible: one position for this reader, never a GET that writes.
  Every stream item but a day header is a message; the reader's own are
  "You", and a conversation with only those has nothing to read.
*/
let readThrough: string | null = null
let markingRead = false
const readScope = computed(() => `${session.value.data?.user.id ?? ''}:${props.threadId}:${props.personalScope}`)
const newestShown = computed(() => entries.value.findLast(item => item.type !== 'day'))

async function readThroughNewest() {
  if (!import.meta.client || markingRead || documentVisibility.value !== 'visible' || pending.value) return
  const newest = newestShown.value
  if (!newest || newest.sequence <= (transcriptPage.value?.read_through ?? 0)) return
  const target = `${readScope.value}:${newest.id}`
  if (target === readThrough || newest.id === settledReply?.id || !entries.value.some(item =>
    item.type !== 'day' && (item.type !== 'message' || item.author !== 'You'))) return
  markingRead = true
  try {
    await applicationFetch(`${path.value}/read`, {
      method: 'POST', body: { message_id: newest.id },
      validate: (value): value is { read: true; last_read_message_id: string } => isRecord(value) && value.read === true && typeof value.last_read_message_id === 'string',
    })
    readThrough = target
    readError.value = null
    if (props.personalScope || realtime.status.value !== 'open') refreshConversationUnreadCount()
  } catch (cause) { readError.value = getErrorMessage(cause, 'Message read state could not be saved') }
  finally {
    markingRead = false
    if (!readError.value && newestShown.value?.id !== newest.id) void readThroughNewest()
  }
}
watch([() => newestShown.value?.id, documentVisibility, pending, readScope], readThroughNewest, { immediate: true })

/*
  Following the conversation: it opens at the newest message; one arriving
  while someone reads back leaves them where they were, and one arriving at
  the end follows.
*/
const scroller = useTemplateRef<HTMLElement>('scroller')
async function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior })
}
onMounted(() => { void scrollToLatest('instant') })
watch(() => newestShown.value?.id, () => {
  const el = scroller.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) void scrollToLatest()
})
</script>
