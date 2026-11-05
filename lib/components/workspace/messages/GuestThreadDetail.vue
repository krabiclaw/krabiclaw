<template>
  <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
    <!-- A request that failed, or a conversation that is gone, is a state this surface shows rather than a blank column. -->
    <div v-if="!thread && !pending" class="pt-3" :class="dashboardGutterClass">
      <UAlert
        color="error"
        variant="soft"
        :title="isNotFoundError(error) ? 'This conversation is no longer available' : 'Conversation could not be loaded'"
        :description="isNotFoundError(error) ? 'It may have been deleted, or the link is from another business.' : getErrorMessage(error, 'Guest thread request failed')"
      />
    </div>

    <template v-else-if="thread">
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-default">
        <!--
          The stream as the server wrote it: day headers, runs of messages with
          one "Name time" line each, events as centred sentences, change
          requests. Nothing here works out a time, a name or a status.
        -->
        <TransitionGroup
          tag="div"
          class="flex flex-col gap-1 py-4"
          :class="dashboardGutterClass"
          enter-from-class="opacity-0 translate-y-3 scale-[0.98]"
          enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
        >
          <template v-for="item in rows" :key="item.key">
            <p v-if="item.type === 'day'" class="mb-1 mt-3 text-center text-xs font-medium text-dimmed">{{ item.label }}</p>

            <p v-else-if="item.type === 'event'" class="my-2 text-center text-xs text-muted">{{ item.text }}</p>

            <section v-else-if="item.type === 'change'" class="mx-auto my-4 max-w-xl rounded-2xl border border-default bg-elevated p-5" :aria-labelledby="`change-title-${item.key}`" data-testid="booking-change-request">
              <h3 :id="`change-title-${item.key}`" class="font-semibold text-highlighted">{{ t('booking.change_review') }}</h3>
              <p class="mt-1 text-sm text-muted">{{ item.change.requestedBy === 'guest' ? t('booking.change_requested_by_guest', { guest: item.change.guestName, channel: 'Airbnb' }) : t('booking.change_requested_by', { organization: currentBusiness }) }}</p>
              <dl class="mt-4 space-y-4 text-sm">
                <div v-for="field in changeFields(item.change)" :key="field.label">
                  <dt class="font-medium text-highlighted">{{ field.label }}</dt>
                  <dd class="mt-1 grid grid-cols-2 gap-4">
                    <div><span class="block text-xs text-muted">{{ t('booking.change_before') }}</span><span>{{ field.before }}</span></div>
                    <div><span class="block text-xs text-muted">{{ t('booking.change_proposed') }}</span><span>{{ field.after }}</span></div>
                  </dd>
                </div>
              </dl>
              <p class="mt-4 text-sm" :class="item.change.status === 'pending' ? 'text-muted' : 'text-highlighted'" role="status">{{ changeStatus(item.change) }}</p>
              <div v-if="item.change.status === 'pending' && (personalScope ? item.change.requestedBy === 'business' && !item.change.channel : item.change.requestedBy === 'guest')" class="mt-4 flex gap-3">
                <UButton :label="t('booking.change_accept')" :loading="answeringChange?.requestId === item.key && answeringChange.decision === 'accept'" :disabled="answeringChange !== null" @click="answerChange(item.key, 'accept')" />
                <UButton :label="t('booking.change_decline')" color="neutral" variant="outline" :loading="answeringChange?.requestId === item.key && answeringChange.decision === 'decline'" :disabled="answeringChange !== null" @click="answerChange(item.key, 'decline')" />
              </div>
            </section>

            <!-- A run: the guest on the left with their circle at its foot, the business on the right. -->
            <div v-else class="flex min-w-0 max-w-[76%] flex-col gap-0.5" :class="item.mine ? 'items-end self-end' : 'relative items-start self-start pl-10'" :data-message="item.key">
              <span v-if="!item.mine" class="absolute bottom-0 left-0"><InboxAvatar :name="item.runs[0]!.author" :initial="initialOf(item.runs[0]!.author)" :support="thread.kind === 'support'" size="sm" /></span>
              <p class="mb-1 mt-2.5 text-sm text-muted"><span class="text-highlighted">{{ item.runs[0]!.label ? `${item.runs[0]!.author} · ${item.runs[0]!.label}` : item.runs[0]!.author }}</span> {{ item.runs[0]!.time }}</p>
              <template v-for="message in item.runs" :key="message.id">
                <div v-if="message.photos.length" class="grid max-w-sm gap-1" :class="[message.photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1', message.sending ? 'opacity-60' : '']">
                  <button
                    v-for="(photo, at) in message.photos"
                    :key="photo.id"
                    type="button"
                    class="block overflow-hidden rounded-2xl bg-accented focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverted"
                    :aria-label="`Open photo ${at + 1} of ${message.photos.length} from ${message.author}`"
                    @click="viewer = { photos: message.photos.map(item => ({ url: item.url })), at }"
                  >
                    <img :src="photo.url" alt="" :width="photo.width ?? undefined" :height="photo.height ?? undefined" loading="lazy" class="size-full object-cover" :class="message.photos.length > 1 ? 'aspect-square' : 'max-h-80'">
                  </button>
                </div>
                <div
                  v-if="message.body"
                  class="max-w-full whitespace-pre-wrap rounded-[18px] px-3.5 py-2.5 text-base [overflow-wrap:anywhere]"
                  :class="[item.mine ? 'rounded-br-md bg-inverted text-inverted' : 'rounded-bl-md bg-elevated text-default', message.sending ? 'opacity-60' : '']"
                >{{ message.translated && originals.has(message.id) ? message.translated.original : message.body }}</div>
                <p v-if="message.unshownFiles" class="mx-1 mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <UIcon name="i-lucide-paperclip" class="size-3.5 shrink-0" />{{ message.unshownFiles === 1 ? 'Sent a file that can’t be shown here' : `Sent ${message.unshownFiles} files that can’t be shown here` }}
                </p>
                <p v-if="message.translated" class="mx-1 mt-0.5 text-xs text-muted">
                  Translated · <button type="button" class="text-highlighted underline underline-offset-2" @click="toggleOriginal(message.id)">{{ originals.has(message.id) ? 'Show translation' : 'Show original' }}</button>
                </p>
                <p v-if="message.receipt" class="mt-0.5 text-xs" :class="message.receipt === 'Not delivered' ? 'text-error' : 'text-muted'">
                  {{ message.receipt }}<template v-if="message.retryable"> · <button type="button" class="underline underline-offset-2 disabled:opacity-50" :disabled="retrying" @click="retry(message.id)">Try again</button></template>
                </p>
              </template>
            </div>
          </template>
        </TransitionGroup>
      </div>

      <div class="shrink-0 pb-6 pt-2" :class="dashboardGutterClass">
        <UAlert v-if="actionError || readError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError ?? readError ?? undefined" class="mb-2" />

        <!-- A message still to go out: one row per message, the only place it appears. -->
        <div v-for="later in thread.pending" :key="later.id" class="mb-2 flex min-h-12 items-center gap-3 rounded-2xl bg-elevated px-4 py-3 text-base text-highlighted">
          <UIcon name="i-lucide-clock" class="size-4 shrink-0 text-muted" />
          <span class="min-w-0 flex-1 truncate">{{ later.label }} · {{ later.time }}</span>
          <button v-if="later.cancellable" type="button" class="flex size-6 shrink-0 items-center justify-center text-highlighted disabled:opacity-50" :aria-label="`Cancel ${later.label}`" :disabled="cancelling === later.id" @click="cancelPending(later)">
            <UIcon name="i-lucide-x" class="size-4" />
          </button>
        </div>

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
        <MessageComposer v-model="draft" v-model:photos="chosen" v-model:send-at="sendAt" :disabled="!thread.composer.available" :sending="sending" :channel="thread.composer.channel" :send-later="!personalScope" :suggestions-hidden="suggestionsHidden" :send-label="requestingChange && !changeRequestSent ? t('booking.request_change') : 'Send reply'" @send="sendReply" @show-suggestions="recallSuggestions" />
        <MessagePhotoViewer v-model="viewer" />
        <p v-if="!thread.composer.available" class="mt-2 text-xs text-warning">This guest has no email on file. Once they accept an invite to this conversation, your replies reach their KrabiClaw inbox.</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'
import { isThreadDetailResponse, type StreamItem, type ThreadDetail } from '~/lib/components/workspace/messages/guest-thread-client'
import type { BookingChangeView } from '~/server/domain/guest-threads/booking-changes'
import type { InboxPendingMessage } from '~/server/domain/guest-threads/types'
import { useDashboardInvalidations } from '~/composables/useDashboardInvalidations'
import { authClient } from '~/lib/auth-client'
import MessageComposer, { messageReplyForm, sameMessagePhotos, useMessagePhotoDraft, type MessagePhotoDraft } from './MessageComposer.vue'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import InboxAvatar from './InboxAvatar.vue'
import { isScheduledMessage, isSendLaterResponse, isSuggestedReplies, useSuggestedReplies } from './guest-messaging-client'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'

/*
  One guest thread: the stream and its composer, drawn from the server's view
  model (inbox-parity.md, "The thread") and nothing else. The header, the
  conversation sheet and the reservation belong to the route that mounts this.
*/
const props = withDefaults(defineProps<{ threadId: string; personalScope?: boolean }>(), { personalScope: false })

const dashboard = useDashboardOrganization()
const route = useRoute()
const dashboardApi = useDashboardApi(useDashboardRouteScope())
const realtime = useDashboardInvalidations()
const { locale, t } = useI18n()
const session = authClient.useSession()

const { data, thread, pending, error, refresh, clear } = await useGuestThread(computed(() => props.threadId), computed(() => props.personalScope))
const threadPath = computed(() => props.personalScope ? `/api/account/messages/${encodeURIComponent(props.threadId)}` : `/api/dashboard/organizations/${dashboard.organizationId.value}/guest-threads/${encodeURIComponent(props.threadId)}`)

const draft = ref('')
const requestingChange = computed(() => props.personalScope && route.query.intent === 'booking-change' && thread.value?.recordId && thread.value.composer.channel === 'email')
const changeRequestSent = ref(false)
watch(() => `${props.threadId}:${String(route.query.intent)}`, () => { changeRequestSent.value = false })
const sendAt = ref<string | null>(null)
// The business that asked for a change: the one whose inbox this is, or, in a guest's own inbox, the one they are writing to.
const currentBusiness = computed(() => props.personalScope ? thread.value?.guestName : dashboard.organization.value?.name)
const actionError = ref<string | null>(null)
const readError = ref<string | null>(null)

type MessageItem = Extract<StreamItem, { type: 'message' }> & { sending?: boolean }
type Row =
  | { type: 'day'; key: string; label: string }
  | { type: 'event'; key: string; text: string }
  | { type: 'change'; key: string; change: BookingChangeView }
  | { type: 'run'; key: string; mine: boolean; runs: MessageItem[] }

/*
  A reply shows the moment it is sent, dimmed and "Sending" until the server
  has it. The attempt keeps its idempotency key until it succeeds, so sending
  the same words again after a failure is the same request, not a second one.
*/
const attempt = ref<{ key: string; body: string; photos: MessagePhotoDraft[]; sentAfter: Set<string> } | null>(null)
const sending = ref(false)
// The server's message for a reply that was on screen as a pending one takes its key, so it settles in place.
const settledKeys = ref<Record<string, string>>({})

// The reader's own side is on the right: the business in its inbox, the guest in theirs.
const mineSide = computed(() => props.personalScope ? 'guest' : 'business')

/** The server marks the first message of each run with its time; a run continues until the next mark. */
const rows = computed<Row[]>(() => {
  const current = thread.value
  if (!current) return []
  const items: Array<StreamItem | MessageItem> = [...current.stream]
  if (attempt.value && sending.value) {
    items.push({
      type: 'message', id: `pending:${attempt.value.key}`, side: mineSide.value, author: 'You', label: null, sentAt: new Date().toISOString(),
      time: 'Sending', body: attempt.value.body || null, translated: null, receipt: null, retryable: false, unshownFiles: 0, sending: true,
      photos: attempt.value.photos.map((photo, at) => ({ id: `${attempt.value!.key}:${at}`, url: photo.url, thumbnailUrl: photo.url, width: null, height: null })),
    })
  }
  const out: Row[] = []
  for (const item of items) {
    const key = settledKeys.value[item.id] ?? item.id
    if (item.type === 'day') out.push({ type: 'day', key, label: item.label })
    else if (item.type === 'event') out.push({ type: 'event', key, text: item.text })
    else if (item.type === 'change') out.push({ type: 'change', key, change: item.change })
    else {
      const last = out.at(-1)
      if (item.time === null && last?.type === 'run' && last.runs[0]!.side === item.side) last.runs.push(item)
      else out.push({ type: 'run', key, mine: item.side === mineSide.value, runs: [item] })
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
const usedSuggestion = ref<{ generationId: string; index: number } | null>(null)
const suggestionError = ref<string | null>(null)
const suggestionAttempt = ref(0)
const dismissedFor = ref<string | null>(null)
const latestGuestMessage = computed(() => {
  const last = thread.value?.stream.findLast(item => item.type === 'message')
  return last?.type === 'message' && last.side === 'guest' && thread.value?.kind === 'guest' ? last.id : null
})
// Typing or × puts them away; the composer's + brings them back until the guest writes again.
const recalledFor = ref<string | null>(null)
const suggestionsVisible = computed(() => recalledFor.value === latestGuestMessage.value || (!draft.value.trim() && dismissedFor.value !== latestGuestMessage.value))
const shownSuggestions = computed(() => suggestionsVisible.value ? suggestions.value : [])
const suggestionsHidden = computed(() => suggestions.value.length > 0 && !suggestionsVisible.value)
function recallSuggestions() { recalledFor.value = latestGuestMessage.value }
function useSuggestion(option: string, index: number) {
  draft.value = option
  usedSuggestion.value = generationId.value ? { generationId: generationId.value, index } : null
}
// Clearing the field lets go of the draft it came from.
watch(draft, words => { if (!words.trim()) usedSuggestion.value = null })
watch([latestGuestMessage, suggestionsOn, suggestionAttempt], async ([messageId, on]) => {
  suggestions.value = []
  generationId.value = null
  suggestionError.value = null
  if (props.personalScope || !on || !messageId || !import.meta.client) return
  try {
    const result = await dashboardApi(`${threadPath.value}/suggested-reply`, { method: 'POST', validate: isSuggestedReplies })
    if (latestGuestMessage.value === messageId) { suggestions.value = result.suggestions; generationId.value = result.generationId }
  } catch (err) {
    suggestionError.value = `Replies could not be suggested: ${getErrorMessage(err, 'Suggested reply request failed')}`
  }
}, { immediate: true })

// A pending message is cancelled where it was made: an automatic message by the business, one sent later by its author.
const cancelling = ref<string | null>(null)
async function cancelPending(later: InboxPendingMessage) {
  cancelling.value = later.id
  actionError.value = null
  try {
    if (later.source === 'later') await dashboardApi(`/api/dashboard/organizations/${dashboard.organizationId.value}/send-later/${encodeURIComponent(later.id)}/cancel`, { method: 'POST', validate: isSendLaterResponse })
    else await dashboardApi(`/api/dashboard/scheduled-guest-messages/${encodeURIComponent(later.id)}/cancel`, { method: 'POST', validate: (value: unknown): value is { message: unknown } => isRecord(value) && isScheduledMessage(value.message) })
    await refresh()
  } catch (err) {
    actionError.value = getErrorMessage(err, 'The message could not be cancelled')
  } finally {
    cancelling.value = null
  }
}

const answeringChange = ref<{ requestId: string; decision: 'accept' | 'decline' } | null>(null)
async function answerChange(requestId: string, decision: 'accept' | 'decline') {
  if (answeringChange.value) return
  answeringChange.value = { requestId, decision }
  actionError.value = null
  try {
    // The host answers a guest's request on their channel through the conversation's operations.
    if (!props.personalScope) {
      data.value = await dashboardApi(`${threadPath.value}/operations/${decision}_change`, {
        method: 'POST',
        body: { requestId, idempotencyKey: `${requestId}:${decision}` },
        validate: isThreadDetailResponse,
      })
      return
    }
    await applicationFetch('/api/account/bookings/change', {
      method: 'POST',
      body: { thread_id: props.threadId, request_id: requestId, decision },
      validate: (value: unknown): value is BookingChangeView => isRecord(value) && ['accepted', 'declined'].includes(String(value.status)),
    })
    // Read the conversation after the answer, not through a refresh that a read
    // started before the answer could satisfy with the pending card.
    data.value = await applicationFetch<{ thread: ThreadDetail }>(threadPath.value, { validate: isThreadDetailResponse })
    await refreshNuxtData(`account-activity:${session.value.data?.user.id}`)
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Your answer could not be saved')
    // A concurrent answer or changed destination must be shown after the failed action.
    await refresh()
  } finally {
    answeringChange.value = null
  }
}

function changeFields(change: BookingChangeView) {
  const copy = getVerticalCopy(change.vertical, locale.value)
  const fields = [
    { label: copy.locationLabel, before: change.originalLocationTitle, after: change.locationTitle },
    { label: copy.dateLabel, before: change.before.whenLabel, after: change.after.whenLabel },
    { label: copy.guestsLabel, before: String(change.before.partySize), after: String(change.after.partySize) },
    ...change.before.totalLabel && change.after.totalLabel ? [{ label: t('booking.change_total'), before: change.before.totalLabel, after: change.after.totalLabel }] : [],
  ]
  if (change.type === 'booking') fields.push({
    label: copy.assigneeLabel,
    before: change.before.assignedMemberName ?? t('booking.change_unassigned'),
    after: change.after.assignedMemberName ?? t('booking.change_unassigned'),
  })
  return fields.filter(field => field.label === copy.dateLabel || field.label === copy.assigneeLabel || field.before !== field.after)
}
function changeStatus(change: BookingChangeView) {
  if (change.channel) {
    if (change.status === 'pending') return t(change.requestedBy === 'guest' ? 'booking.change_guest_waiting' : 'booking.change_host_waiting', { channel: 'Airbnb' })
    if (change.status === 'accepted') return t('booking.change_guest_accepted', { channel: 'Airbnb' })
    if (change.status === 'declined') return `${t('booking.change_declined')} ${t('booking.change_unchanged')}`
    return t('booking.change_withdrawn', { channel: 'Airbnb' })
  }
  if (change.status === 'pending') return t(props.personalScope ? 'booking.change_pending' : 'booking.change_waiting')
  if (change.status === 'accepted') return `${t('booking.change_accepted')} ${t('booking.change_updated')}`
  if (change.status === 'declined') return `${t('booking.change_declined')} ${t('booking.change_unchanged')}`
  return t(change.status === 'expired' ? 'booking.change_expired' : 'booking.change_stale')
}

async function sendReply() {
  const body = draft.value.trim()
  const photos = chosen.value
  if (!thread.value || !thread.value.composer.available || (!body && !photos.length) || sending.value) return
  if (sendAt.value) {
    sending.value = true
    actionError.value = null
    try {
      await dashboardApi(`${threadPath.value}/send-later`, { method: 'POST', body: { body, sendAt: sendAt.value, ...(usedSuggestion.value ? { suggestion: usedSuggestion.value } : {}) }, validate: isSendLaterResponse })
      draft.value = ''
      usedSuggestion.value = null
      sendAt.value = null
      await refresh()
    } catch (err) {
      actionError.value = getErrorMessage(err, 'The message could not be scheduled')
    } finally {
      sending.value = false
    }
    return
  }
  if (attempt.value?.body !== body || !sameMessagePhotos(attempt.value.photos, photos)) {
    attempt.value = { key: crypto.randomUUID(), body, photos, sentAfter: new Set(thread.value.stream.map(item => item.id)) }
  }
  const current = attempt.value
  sending.value = true
  actionError.value = null
  void scrollToLatest()
  try {
    const res = await (props.personalScope ? applicationFetch : dashboardApi)<{ thread: ThreadDetail }>(`${threadPath.value}/${props.personalScope ? 'reply' : 'operations/reply'}`, {
      method: 'POST',
      body: photos.length ? messageReplyForm(body, photos, current.key, props.personalScope ? null : usedSuggestion.value) : { body, idempotencyKey: current.key, ...(!props.personalScope && usedSuggestion.value ? { suggestion: usedSuggestion.value } : {}) },
      validate: isThreadDetailResponse,
    })
    const reply = res.thread.stream.findLast(item => item.type === 'message' && item.side === mineSide.value && !current.sentAfter.has(item.id))
    if (reply) settledKeys.value = { ...settledKeys.value, [reply.id]: `pending:${current.key}` }
    data.value = res
    if (requestingChange.value) changeRequestSent.value = true
    attempt.value = null
    draft.value = ''
    usedSuggestion.value = null
    chosen.value = []
  } catch (err) {
    actionError.value = getErrorMessage(err, 'Failed to send reply')
    // The words and photos come back to the composer rather than vanishing with the bubble.
    if (!draft.value) draft.value = body
    if (!chosen.value.length) chosen.value = photos
  } finally {
    sending.value = false
  }
}

const chosen = useMessagePhotoDraft()

// "Try again" sends the same reply under its own key, so one that did land is not sent twice.
const retrying = ref(false)
async function retry(messageId: string) {
  retrying.value = true
  actionError.value = null
  try {
    data.value = await dashboardApi(`${threadPath.value}/operations/retry`, { method: 'POST', body: { messageId, idempotencyKey: messageId }, validate: isThreadDetailResponse })
  } catch (err) {
    actionError.value = getErrorMessage(err, 'The reply could not be sent again')
  } finally {
    retrying.value = false
  }
}

watch(realtime.event, (event) => {
  if (props.personalScope || !event) return
  if (event.organizationId !== dashboard.organizationId.value) return
  // Access changes invalidate the cached identity, including hydration data and in-flight reads.
  if (event.type === 'access.changed') clear()
  if (event.type === 'access.changed' || ('threadId' in event && event.threadId === props.threadId)) void refresh()
})

watch(error, cause => {
  if (cause?.statusCode !== 403 && cause?.statusCode !== 404) return
  draft.value = ''
  chosen.value = []
  viewer.value = null
  attempt.value = null
  sendAt.value = null
  suggestions.value = []
}, { flush: 'sync' })

watch(realtime.connectionEpoch, (epoch) => {
  if (epoch <= 0) return
  if (!props.personalScope) realtime.connect()
  void refresh()
})

const documentVisibility = useDocumentVisibility()
useIntervalFn(() => { if (props.personalScope && documentVisibility.value === 'visible') void refresh() }, 15_000)

// Reading is an explicit receipt on the shown entries, never a GET mutation; the server's ledger owns read state.
const acknowledgedEntryIds = new Set<string>()
let acknowledgedScope: string | null = null
let markingRead = false
const readScope = computed(() => `${session.value.data?.user.id ?? ''}:${props.threadId}:${props.personalScope}`)
const shownEntryIds = computed(() => thread.value?.stream.filter(item => item.type !== 'day').map(item => item.id) ?? [])

async function acknowledgeVisibleEntries() {
  if (!import.meta.client || markingRead || !props.personalScope || documentVisibility.value !== 'visible' || pending.value) return
  markingRead = true
  await nextTick()
  try {
    while (props.personalScope && documentVisibility.value === 'visible' && !pending.value) {
      const scope = readScope.value
      if (acknowledgedScope !== scope) { acknowledgedEntryIds.clear(); acknowledgedScope = scope }
      const batch = shownEntryIds.value.filter(id => !acknowledgedEntryIds.has(id)).slice(0, 200)
      if (!batch.length) { readError.value = null; return }
      await applicationFetch<{ acknowledged: number }>(`${threadPath.value}/read`, {
        method: 'POST', body: { entry_ids: batch },
        validate: (value): value is { acknowledged: number } => isRecord(value) && typeof value.acknowledged === 'number' && Number.isSafeInteger(value.acknowledged) && value.acknowledged >= 0,
      })
      if (readScope.value === scope) for (const id of batch) acknowledgedEntryIds.add(id)
      // A guest's read is not a notification; their Messages count is asked again here.
      refreshNotificationUnreadCounts()
    }
  } catch (cause) { readError.value = getErrorMessage(cause, 'Message read state could not be saved') }
  finally { markingRead = false }
}
watch([() => shownEntryIds.value.join('|'), documentVisibility, pending, readScope], acknowledgeVisibleEntries, { immediate: true })

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
watch(() => thread.value?.stream.length, () => {
  const el = scroller.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) void scrollToLatest()
})
</script>
