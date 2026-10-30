<template>
  <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
    <!-- A request that failed, or a conversation that is gone, is a state this
         surface shows rather than a blank column. -->
    <div v-if="!thread && !pending" class="pt-3" :class="dashboardGutterClass">
      <UAlert
        color="error"
        variant="soft"
        :title="isNotFoundError(error) ? 'This conversation is no longer available' : 'Conversation could not be loaded'"
        :description="isNotFoundError(error) ? 'It may have been deleted, or the link is from another business.' : getErrorMessage(error, 'Guest thread request failed')"
      />
    </div>

    <template v-else-if="thread">
      <!-- Positioned so UChatMessages' jump-to-latest button sits over the
           stream rather than scrolling away with it. -->
      <div class="relative flex min-h-0 flex-1 flex-col">
        <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <UChatMessages :auto-scroll="{ size: 'sm' }" :ui="{ root: ['gap-0 py-4', dashboardGutterClass] }">
            <!-- What is already here appears at once; what arrives while the
                 thread is open rises into place. -->
            <TransitionGroup
              enter-from-class="opacity-0 translate-y-3 scale-[0.98]"
              enter-active-class="origin-bottom-left transition duration-300 ease-out motion-reduce:transition-none"
            >
              <div v-for="item in stream" :key="item.key">
                <p v-if="item.type === 'day'" class="pb-2 pt-6 text-center text-xs font-medium text-highlighted">
                  {{ item.label }}
                </p>

                <!-- Something that happened to the record, not something anyone
                     said: no bubble, which is what says no one is talking. -->
                <p v-else-if="item.type === 'event'" class="flex items-center justify-center gap-2 py-3 text-center text-xs text-muted">
                  <UIcon :name="item.icon" class="size-3.5 shrink-0" />
                  <span>{{ item.label }}</span>
                </p>

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

                <!-- The current buyer's own web replies sit opposite the business;
                     historical authors retain the identity actually recorded. -->
                <UChatMessage
                  v-else
                  :id="item.key"
                  :role="item.outgoing ? 'user' : 'assistant'"
                  :side="item.outgoing ? 'right' : 'left'"
                  :parts="[]"
                  :avatar="item.avatar"
                  :class="item.startsRun ? 'pt-4' : 'pt-1'"
                  :ui="{
                    root: 'scroll-mt-0',
                    header: item.outgoing ? 'mb-1 text-xs text-muted' : 'mb-1 ps-12 text-xs text-muted',
                    container: 'items-end gap-2 pb-0',
                    leading: 'mt-0 min-h-0',
                    leadingAvatar: item.endsRun ? undefined : 'invisible',
                    body: 'min-w-0 max-w-[min(36rem,86%)]',
                  }"
                >
                  <template v-if="item.startsRun" #header>
                    <span class="font-medium text-highlighted">{{ item.who }}</span>
                    <UPopover v-if="item.providerTimestamp">
                      <button type="button" class="ms-1.5 rounded focus-visible:outline-2" aria-label="Message time details">{{ messageTime(item) }}</button>
                      <template #content>
                        <div class="max-w-xs space-y-2 p-4 text-sm">
                          <p>{{ providerDate(item.providerTimestamp) }} · {{ messageTime(item) }}</p>
                          <p v-if="!hasProviderTimezone(item.providerTimestamp)" class="text-muted">Airbnb supplied this time without a timezone.</p>
                          <p class="text-muted">Recorded in KrabiClaw {{ new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.occurredAt)) }}</p>
                        </div>
                      </template>
                    </UPopover>
                    <span v-else class="ms-1.5">{{ messageTime(item) }}</span>
                  </template>
                  <template #body>
                    <!-- Photos lead, the way they do on Airbnb: each one whole,
                         a pair side by side, and the words, if any, beneath. -->
                    <div
                      v-if="item.photos.length"
                      class="mb-1 grid max-w-sm gap-1 transition-opacity duration-300"
                      :class="[item.photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1', item.sending ? 'opacity-60' : '']"
                    >
                      <button
                        v-for="(photo, at) in item.photos"
                        :key="photo.url"
                        type="button"
                        class="block overflow-hidden rounded-2xl bg-accented focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverted"
                        :aria-label="`Open photo ${at + 1} of ${item.photos.length} from ${item.who}`"
                        @click="viewer = { photos: item.photos, at }"
                      >
                        <img
                          :src="photo.url"
                          :alt="photo.alt ?? ''"
                          :width="photo.width ?? undefined"
                          :height="photo.height ?? undefined"
                          loading="lazy"
                          class="size-full object-cover transition-transform duration-300 hover:scale-[1.02]"
                          :class="item.photos.length > 1 ? 'aspect-square' : 'max-h-80'"
                        >
                      </button>
                    </div>
                    <div
                      v-if="item.announcement || item.body"
                      class="rounded-2xl bg-elevated px-4 py-3 text-base leading-normal text-default transition-opacity duration-300"
                      :class="item.sending ? 'opacity-60' : ''"
                    >
                      <!-- One bubble, one text size: the platform's facts read as
                           lines of its message, labelled by weight not scale. -->
                      <template v-if="item.announcement">
                        <p class="font-medium">{{ item.announcement.title }}</p>
                        <p v-for="row in item.announcement.rows" :key="row.label" class="mt-1">
                          <span class="font-semibold text-highlighted">{{ row.label }}</span>
                          <span class="ms-2 break-words">{{ row.value }}</span>
                        </p>
                      </template>
                      <span v-else class="whitespace-pre-wrap break-words">{{ item.body }}</span>
                    </div>
                    <div v-if="item.attachmentLinks.length" class="mt-1 flex flex-col gap-1 text-sm">
                      <a v-for="(url, index) in item.attachmentLinks" :key="url" :href="url" target="_blank" rel="noopener noreferrer" class="underline">Open attachment {{ index + 1 }}</a>
                    </div>
                    <!-- A file the guest sent that the conversation cannot show
                         is named, so nothing they sent goes missing silently. -->
                    <p v-if="item.unshown.length" class="mt-1 flex items-center gap-1.5 text-xs text-muted">
                      <UIcon name="i-lucide-paperclip" class="size-3.5 shrink-0" />
                      <span>Not shown here: {{ item.unshown.join(', ') }}</span>
                    </p>
                    <Transition
                      enter-from-class="opacity-0"
                      enter-active-class="transition-opacity duration-200 motion-reduce:transition-none"
                      mode="out-in"
                    >
                      <p v-if="item.receipt" :key="item.receipt.label" class="mt-1 text-xs" :class="item.receipt.failed ? 'text-error' : 'text-muted'">
                        {{ item.receipt.label }}
                      </p>
                    </Transition>
                  </template>
                </UChatMessage>
              </div>
            </TransitionGroup>
          </UChatMessages>
        </div>
      </div>

      <div class="shrink-0 pb-4 pt-2" :class="dashboardGutterClass">
        <TransitionGroup
          tag="div"
          class="space-y-2"
          enter-from-class="opacity-0 -translate-y-1"
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-to-class="opacity-0"
          leave-active-class="transition-opacity duration-150"
          aria-live="polite"
        >
          <UAlert
            v-if="actionError || readError"
            key="action-error"
            color="error"
            variant="soft"
            icon="i-lucide-circle-alert"
            :description="actionError ?? readError ?? undefined"
            class="mb-1"
          />
          <UAlert
            v-for="failure in thread.deliveryFailures"
            :key="failure.id"
            color="error"
            variant="soft"
            icon="i-lucide-mail-warning"
            :title="deliveryFailureTitle(failure)"
            :description="deliveryFailureDescription(failure)"
            class="mb-1"
          />
        </TransitionGroup>

        <!-- Your own messages set to send later in this conversation; only you see them. -->
        <ul v-if="pendingLater?.messages.length" class="mb-2 space-y-1">
          <li v-for="later in pendingLater.messages" :key="later.id" class="flex items-center gap-2 rounded-xl border border-dashed border-primary px-3 py-2 text-sm">
            <UIcon name="i-lucide-clock" class="size-4 shrink-0 text-primary" />
            <span class="min-w-0 flex-1 truncate"><span class="text-primary">{{ laterLabel(later.sendAt) }}</span> · {{ later.body }}</span>
            <span v-if="later.status !== 'pending'" class="text-error">{{ later.reason }}</span>
            <UButton v-if="later.status === 'pending'" label="Cancel" color="neutral" variant="ghost" size="xs" :loading="cancellingLater === later.id" @click="cancelLater(later.id)" />
          </li>
        </ul>
        <p v-if="suggestionError" class="mb-2 flex items-center gap-2 text-xs text-muted">
          <UIcon name="i-lucide-triangle-alert" class="size-3.5" />{{ suggestionError }}
          <UButton label="Retry" color="neutral" variant="link" size="xs" @click="suggestionAttempt += 1" />
        </p>
        <UAlert v-if="requestingChange" class="mb-3" color="info" variant="soft" :description="t(changeRequestSent ? 'booking.change_request_sent' : 'booking.change_request_help')" />
        <MessageComposer v-model="draft" v-model:photos="chosen" v-model:send-at="sendAt" :disabled="!canReply" :sending="sending" :channel="!personalScope && thread.replyChannel === 'airbnb' ? 'airbnb' : 'email'" :send-later="!personalScope" :suggestion="suggestion" :send-label="requestingChange && !changeRequestSent ? t('booking.request_change') : 'Send reply'" @send="sendReply" />
        <MessagePhotoViewer v-model="viewer" />

        <p v-if="!canReply" class="mt-2 text-xs text-warning">This guest has no email on file. Once they accept an invite to this conversation, your replies reach their KrabiClaw inbox.</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import { formatCalendarDate, formatTime, isValidInstant } from '~/utils/timezone'
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import type { AvatarProps } from '@nuxt/ui'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'
import { isThreadDetailResponse, threadRecordTitle, type ThreadDetail } from '~/lib/components/workspace/messages/guest-thread-client'
import type { GuestThreadDeliveryFailureViewModel, GuestThreadEntryViewModel } from '~/server/domain/guest-threads/types'
import type { BookingChangeView } from '~/server/domain/guest-threads/booking-changes'
import { useDashboardInvalidations } from '~/composables/useDashboardInvalidations'
import { authClient } from '~/lib/auth-client'
import MessageComposer, { messageReplyForm, sameMessagePhotos, useMessagePhotoDraft, type MessagePhotoDraft } from './MessageComposer.vue'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import { isSendLaterList, isSendLaterResponse, isSuggestedReply, useSuggestedReplies } from './guest-messaging-client'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'

/*
  One guest thread: the conversation and its composer. The list is a separate
  level of the route tree, and the panel, navbar and the way into the record
  belong to the route that mounts this.
*/
const props = withDefaults(defineProps<{ threadId: string; personalScope?:boolean }>(),{personalScope:false})

const dashboard = useDashboardOrganization()
const route = useRoute()
const dashboardApi = useDashboardApi(useDashboardRouteScope())
const realtime = useDashboardInvalidations()
const { locale, t } = useI18n()
const session = authClient.useSession()

// The one copy of this thread. The record beside the conversation reads the
// same entry, so writing a reply's answer into it updates both.
const { data, thread, pending, error, refresh } = await useGuestThread(computed(() => props.threadId),computed(()=>props.personalScope))
const canReply = computed(() => props.personalScope || thread.value?.replyChannel === 'airbnb' || Boolean(thread.value?.guestEmail) || Boolean(thread.value?.guestAccountLinked))
const threadPath = computed(() => props.personalScope ? `/api/account/messages/${encodeURIComponent(props.threadId)}` : `/api/dashboard/organizations/${dashboard.organizationId.value}/guest-threads/${encodeURIComponent(props.threadId)}`)

const draft = ref('')
const requestingChange = computed(() => props.personalScope && route.query.intent === 'booking-change' && thread.value?.operationalRecord && thread.value.replyChannel === 'email')
const changeRequestSent = ref(false)
watch(() => `${props.threadId}:${String(route.query.intent)}`, () => { changeRequestSent.value = false })
const sendAt = ref<string | null>(null)

// Your send-later messages for this conversation.
const { data: pendingLater, refresh: refreshLater } = await useAsyncData(
  () => `send-later:${dashboard.organizationId.value}:${props.threadId}`,
  () => props.personalScope ? Promise.resolve(null) : dashboardApi(`/api/dashboard/organizations/${dashboard.organizationId.value}/send-later`, { query: { threadId: props.threadId }, validate: isSendLaterList }),
)
const cancellingLater = ref<string | null>(null)
async function cancelLater(id: string) {
  cancellingLater.value = id
  actionError.value = null
  try {
    await dashboardApi(`/api/dashboard/organizations/${dashboard.organizationId.value}/send-later/${encodeURIComponent(id)}/cancel`, { method: 'POST', validate: isSendLaterResponse })
    await refreshLater()
  } catch (err) {
    actionError.value = getErrorMessage(err, 'The message could not be cancelled')
  } finally {
    cancellingLater.value = null
  }
}
const laterLabel = (instant: string) => new Intl.DateTimeFormat(locale.value, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant))

// A drafted reply to the guest's latest message becomes the composer's placeholder.
const suggestionsOn = useSuggestedReplies(() => dashboard.organizationId.value)
const suggestion = ref<string | null>(null)
const suggestionError = ref<string | null>(null)
const suggestionAttempt = ref(0)
const latestGuestMessage = computed(() => {
  const last = thread.value?.entries.findLast(entry => entry.kind === 'message' && entry.actorKind !== 'system' && entry.body?.trim())
  return last?.actorKind === 'guest' ? last.id : null
})
watch([latestGuestMessage, suggestionsOn, suggestionAttempt], async ([messageId, on]) => {
  suggestion.value = null
  suggestionError.value = null
  if (props.personalScope || !on || !messageId || !import.meta.client) return
  try {
    const result = await dashboardApi(`${threadPath.value}/suggested-reply`, { method: 'POST', validate: isSuggestedReply })
    if (latestGuestMessage.value === messageId) suggestion.value = result.suggestion
  } catch (err) {
    suggestionError.value = `A reply could not be suggested: ${getErrorMessage(err, 'Suggested reply request failed')}`
  }
}, { immediate: true })
const actionError = ref<string | null>(null)
const readError = ref<string | null>(null)
const currentBusiness = computed(() => thread.value?.organizationName)
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
    await refresh()
    if (error.value) throw error.value
    await refreshNuxtData(`account-activity:${session.value.data?.user.id}`)
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Your answer could not be saved')
    // A concurrent answer or changed destination must be shown after the failed action.
    await refresh()
  } finally {
    answeringChange.value = null
  }
}

function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1) }
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

/*
  A reply shows the moment it is sent, dimmed and "Sending…" until the server
  has it. The attempt keeps its idempotency key until it succeeds, so sending
  the same words again after a failure is the same request, not a second one.
*/
const attempt = ref<{ key: string; body: string; photos: MessagePhotoDraft[]; sentAfter: Set<string> } | null>(null)
const sending = ref(false)
// The server's entry for a reply that was on screen as a pending one takes the
// pending one's key, so it settles in place instead of animating in again.
const settledKeys = ref<Record<string, string>>({})

async function sendReply() {
  const body = draft.value.trim()
  const photos = chosen.value
  if (!thread.value || !canReply.value || (!body && !photos.length) || sending.value) return
  if (sendAt.value) {
    sending.value = true
    actionError.value = null
    try {
      await dashboardApi(`${threadPath.value}/send-later`, { method: 'POST', body: { body, sendAt: sendAt.value }, validate: isSendLaterResponse })
      draft.value = ''
      sendAt.value = null
      await refreshLater()
    } catch (err) {
      actionError.value = getErrorMessage(err, 'The message could not be scheduled')
    } finally {
      sending.value = false
    }
    return
  }
  if (attempt.value?.body !== body || !sameMessagePhotos(attempt.value.photos, photos)) {
    attempt.value = { key: crypto.randomUUID(), body, photos, sentAfter: new Set(thread.value.entries.map(entry => entry.id)) }
  }
  const current = attempt.value
  sending.value = true
  actionError.value = null
  void scrollToLatest()
  try {
    const res = await (props.personalScope?applicationFetch:dashboardApi)<{ thread: ThreadDetail }>(`${threadPath.value}/${props.personalScope?'reply':'operations/reply'}`, {
      method: 'POST',
      body: photos.length ? messageReplyForm(body, photos, current.key) : { body, idempotencyKey: current.key },
      validate: isThreadDetailResponse,
    })
    const reply = res.thread.entries.findLast(entry => entry.kind === 'message' && entry.actorKind === (props.personalScope?'guest':'member') && !current.sentAfter.has(entry.id))
    if (reply) settledKeys.value = { ...settledKeys.value, [reply.id]: `pending:${current.key}` }
    data.value = res
    if (requestingChange.value) changeRequestSent.value = true
    attempt.value = null
    draft.value = ''
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
const viewer = ref<MessagePhotoViewerState | null>(null)

function refreshThreadState() {
  if (!props.personalScope) realtime.connect()
  void refresh()
  void refreshLater()
}

watch(realtime.event, (event) => {
  if (props.personalScope || !event) return
  if (event.organizationId !== dashboard.organizationId.value) return
  if (event.type === 'access.changed' || ('threadId' in event && event.threadId === props.threadId)) void refresh()
})

watch(error, cause => {
  if (cause?.statusCode !== 403 && cause?.statusCode !== 404) return
  draft.value = ''
  chosen.value = []
  viewer.value = null
  attempt.value = null
  sendAt.value = null
  pendingLater.value = undefined
  suggestion.value = null
}, { flush: 'sync' })

watch(realtime.connectionEpoch, (epoch) => {
  if (epoch > 0) refreshThreadState()
})

const documentVisibility = useDocumentVisibility()
useIntervalFn(() => { if (props.personalScope && documentVisibility.value === 'visible') void refresh() }, 15_000)

// Reading is an explicit user receipt on the rendered public entries, never a GET mutation.
// This set avoids repeated network requests; the server's ledger owns read state.
const acknowledgedEntryIds = new Set<string>()
let acknowledgedScope: string | null = null
let markingRead = false
const readScope = computed(() => `${session.value.data?.user.id ?? ''}:${props.threadId}:${props.personalScope}`)
const visibleEntryIds = computed(() => thread.value?.entries.map(entry => entry.id).join('|') ?? '')

async function acknowledgeVisibleEntries() {
  if (!import.meta.client || markingRead || !props.personalScope || documentVisibility.value !== 'visible' || pending.value) return
  markingRead = true
  await nextTick()
  try {
    // Re-read the displayed entries after each successful batch, including any
    // that arrived while the previous request was in flight.
    while (props.personalScope && documentVisibility.value === 'visible' && !pending.value) {
      const scope = readScope.value
      if (acknowledgedScope !== scope) {
        acknowledgedEntryIds.clear()
        acknowledgedScope = scope
      }
      const batch = (thread.value?.entries ?? []).map(entry => entry.id).filter(id => !acknowledgedEntryIds.has(id)).slice(0, 200)
      if (!batch.length) { readError.value = null; return }
      await applicationFetch<{acknowledged:number}>(`${threadPath.value}/read`, {
        method:'POST',body:{entry_ids:batch},
        validate:(value):value is {acknowledged:number}=>!!value&&typeof value==='object'&&'acknowledged' in value&&typeof value.acknowledged==='number'&&Number.isSafeInteger(value.acknowledged)&&value.acknowledged>=0,
      })
      if (readScope.value === scope) for (const id of batch) acknowledgedEntryIds.add(id)
    }
  } catch(error) { readError.value=getErrorMessage(error,'Message read state could not be saved') }
  finally { markingRead = false }
}

// A normal refresh retries failed IDs; successful IDs generate no new POST.
watch([visibleEntryIds, documentVisibility, pending, readScope], acknowledgeVisibleEntries, { immediate:true })

/*
  Following the conversation. UChatMessages opens it at the newest message and
  offers the way back down; a message arriving while someone reads back through
  the thread leaves them where they were, and one arriving at the end follows.
*/
const scroller = useTemplateRef<HTMLElement>('scroller')

async function scrollToLatest() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

watch(() => thread.value?.entries.length, () => {
  const el = scroller.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) void scrollToLatest()
})

// The tenant's own word for the record.
const recordNoun = computed(() => thread.value
  ? threadRecordTitle(thread.value.submissionType, (props.personalScope ? thread.value.organizationVertical : dashboard.organization.value?.vertical) ?? null).toLowerCase()
  : 'details')

/*
  What the platform says when a booking arrives: every fact the record carries
  except the guest's own note, which is their message and reads as one.
*/
const announcement = computed(() => {
  const current = thread.value
  if (!current?.operationalRecord) return null
  const fields = current.source.fields
  // `guests` is the party size alone ("6", or "6+" when it is a minimum).
  const isConsultation = recordNoun.value === 'consultation'
  const noun = isConsultation ? (fields.guests === '1' ? 'client' : 'clients') : (fields.guests === '1' ? 'guest' : 'guests')
  const size = fields.guests?.trim() ? `${fields.guests} ${noun}` : null
  const rows = [
    { label: 'When', value: fields.whenLabel },
    { label: isConsultation ? 'Clients' : 'Guests', value: size },
    { label: recordNoun.value.charAt(0).toUpperCase() + recordNoun.value.slice(1), value: fields.productTitle },
    { label: 'Location', value: fields.locationTitle ?? current.locationLabel },
    { label: 'Email', value: current.guestEmail },
    { label: 'Phone', value: current.guestPhone && formatPhone(current.guestPhone) },
  ].filter((row): row is { label: string; value: string } => typeof row.value === 'string' && row.value.trim().length > 0)
  return { title: `New ${recordNoun.value}`, rows }
})

// A contact thread's words are its `message`; a reservation or booking carries
// them as `notes`. Either way they are what the guest typed to start this.
const openingMessage = computed(() => {
  const fields = thread.value?.source.fields
  const text = fields?.message ?? fields?.notes
  return text?.trim() ? text : null
})

type Speaker = 'platform' | 'guest' | 'member' | 'system'
type MessagePhotoView = { url: string; alt: string | null; width: number | null; height: number | null }
type MessageItem = {
  type: 'message'
  key: string
  body: string | null
  photos: MessagePhotoView[]
  attachmentLinks: string[]
  providerTimestamp: string | null
  unshown: string[]
  occurredAt: string
  run: string
  who: string
  own: boolean
  /** Which side it reads from: the account's own replies, or the business's whole side of the conversation. */
  outgoing: boolean
  avatar: AvatarProps
  startsRun: boolean
  endsRun: boolean
  announcement?: { title: string; rows: Array<{ label: string; value: string }> }
  receipt?: { label: string; failed: boolean }
  sending?: boolean
}
type StreamItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'event'; key: string; icon: string; label: string }
  | { type: 'change'; key: string; change: BookingChangeView }
  | MessageItem

// A provider civil clock is valid data too; the instant predicate only tells us
// whether a timezone was supplied, not whether the message can be displayed.
const hasProviderTimezone: (value: string) => boolean = isValidInstant

/**
 * The stream in the shape it reads in: a heading per day, messages grouped into
 * runs from one speaker under one name line, the reply on its way at the end,
 * and a receipt under the newest reply — whether it arrived is a real question.
 */
const stream = computed<StreamItem[]>(() => {
  const current = thread.value
  if (!current) return []
  const items: StreamItem[] = []
  let previousDay: string | null = null

  const push = (occurredAt: string, item: StreamItem) => {
    const providerTime = item.type === 'message' ? item.providerTimestamp : null
    const civil = providerTime !== null && !hasProviderTimezone(providerTime)
    const occurred = new Date(providerTime && !civil ? providerTime : occurredAt)
    const day = civil ? providerTime.slice(0, 10) : `${occurred.getFullYear()}-${String(occurred.getMonth() + 1).padStart(2, '0')}-${String(occurred.getDate()).padStart(2, '0')}`
    if (day !== previousDay) {
      items.push({ type: 'day', key: `day:${item.key}`, label: civil ? formatCalendarDate(day, locale.value) : dayLabel(occurred) })
      previousDay = day
    }
    items.push(item)
  }

  // The decoder guarantees every member and system message carries its actor label.
  const message = (key: string, occurredAt: string, body: string | null, speaker: Speaker, label: string | null, extra: Partial<MessageItem> = {}) => {
    const who = extra.own ? 'You' : speaker === 'platform' ? 'KrabiClaw' : speaker === 'guest' ? current.participantLabel : label as string
    const avatar: AvatarProps = speaker === 'platform'
      ? { src: '/platform/krabiclaw-symbol.svg', alt: who }
      : { alt: who }
    const outgoing = props.personalScope ? Boolean(extra.own) : speaker === 'member'
    push(occurredAt, { type: 'message', key, body, photos: [], attachmentLinks: [], providerTimestamp: null, unshown: [], occurredAt, run: `${speaker}:${who}`, who, own: false, outgoing, avatar, startsRun: true, endsRun: true, ...extra })
  }

  for (const entry of current.entries) {
    const key = settledKeys.value[entry.id] ?? entry.id
    if (entry.kind === 'submission') {
      /*
        A submission is how the conversation starts: the platform saying a
        booking came in, and the guest's own words. Both read as messages.
      */
      if (announcement.value) message(`${key}:announcement`, entry.occurredAt, null, 'platform', null, { announcement: announcement.value })
      if (openingMessage.value) message(key, entry.occurredAt, openingMessage.value, 'guest', null)
      if (!announcement.value && !openingMessage.value) {
        push(entry.occurredAt, { type: 'event', key, icon: 'i-lucide-sparkles', label: `Conversation with ${current.participantLabel} recorded` })
      }
    } else if (entry.kind === 'message') {
      const member = entry.actorKind === 'member'
      const mirrored = entry.eventName === 'channel.message_mirrored'
      const unshown = entry.payload?.unshownFiles
      message(key, entry.occurredAt, entry.body, member ? 'member' : entry.actorKind === 'system' ? 'system' : 'guest', entry.actorLabel, {
        own: props.personalScope && entry.actorKind === 'guest' && entry.channel === 'web' && entry.actorUserId !== null && entry.actorUserId === session.value.data?.user.id,
        photos: mirrored ? [] : entry.attachments,
        attachmentLinks: mirrored ? entry.attachments.map(attachment => attachment.url) : [],
        providerTimestamp: entry.providerTimestamp,
        run: `${entry.actorKind}:${entry.actorUserId ?? entry.actorLabel ?? current.participantLabel}`,
        unshown: Array.isArray(unshown) ? unshown.filter((name): name is string => typeof name === 'string') : [],
        ...(member ? { receipt: receiptFor(entry, current.participantLabel) } : {}),
      })
    } else if (entry.bookingChange) {
      push(entry.occurredAt, { type: 'change', key, change: entry.bookingChange })
    } else {
      push(entry.occurredAt, { type: 'event', key, icon: systemEventIcon(entry), label: systemEventLabel(entry) })
    }
  }

  if (attempt.value && sending.value) {
    message(`pending:${attempt.value.key}`, new Date().toISOString(), attempt.value.body || null, props.personalScope?'guest':'member', session.value.data?.user.name ?? null, {
      photos: attempt.value.photos.map(photo => ({ url: photo.url, alt: photo.file.name, width: null, height: null })),
      sending: true,
      own: props.personalScope && Boolean(session.value.data?.user.id),
      receipt: { label: 'Sending…', failed: false },
    })
  }

  // A run is consecutive messages from one speaker: the name line opens it and
  // the avatar closes it. Only the newest reply keeps its receipt.
  const newest = items.findLast((item): item is MessageItem => item.type === 'message' && Boolean(item.receipt))
  items.forEach((item, at) => {
    if (item.type !== 'message') return
    const before = items[at - 1]
    const after = items[at + 1]
    item.startsRun = before?.type !== 'message' || before.run !== item.run
    item.endsRun = after?.type !== 'message' || after.run !== item.run
    if (item !== newest) delete item.receipt
  })
  return items
})

const RECEIPT_RANK = ['pending', 'sending', 'accepted', 'sent', 'delivered', 'read'] as const
const CHANNEL_LABELS = { email: 'email', whatsapp: 'WhatsApp', airbnb: 'Airbnb', push: 'push notification' } as const

function receiptFor(entry: GuestThreadEntryViewModel, participantLabel: string): MessageItem['receipt'] {
  const replies = entry.deliveries.filter(delivery => delivery.purpose === 'member_reply' || delivery.purpose === 'scheduled_message')
  if (!replies.length) return undefined
  const best = replies.find(delivery => delivery.status === 'uncertain') ?? replies.reduce((top, delivery) =>
    RECEIPT_RANK.indexOf(delivery.status as typeof RECEIPT_RANK[number]) > RECEIPT_RANK.indexOf(top.status as typeof RECEIPT_RANK[number]) ? delivery : top)
  const channel = CHANNEL_LABELS[best.channel]
  switch (best.status) {
    case 'read': return { label: `Read by ${participantLabel}`, failed: false }
    case 'delivered': return { label: `Delivered on ${channel}`, failed: false }
    case 'accepted': return { label: `Accepted by ${channel}`, failed: false }
    case 'sent': return { label: `Sent by ${channel}`, failed: false }
    case 'sending': return { label: 'Awaiting provider receipt', failed: false }
    case 'pending': return { label: 'Sending…', failed: false }
    case 'uncertain': return { label: 'Send outcome unknown — review before sending again', failed: true }
    case 'failed': return { label: 'Not delivered', failed: true }
    default: return undefined
  }
}

function formatClockTime(iso: string) {
  return new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

function messageTime(item: MessageItem) {
  if (!item.providerTimestamp) return formatClockTime(item.occurredAt)
  return hasProviderTimezone(item.providerTimestamp)
    ? formatClockTime(item.providerTimestamp)
    : formatTime(item.providerTimestamp.slice(11, 16), locale.value)
}

function providerDate(timestamp: string) {
  return hasProviderTimezone(timestamp)
    ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(timestamp))
    : formatCalendarDate(timestamp.slice(0, 10), locale.value)
}

function dayLabel(date: Date) {
  const today = new Date()
  const days = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Intl.DateTimeFormat(locale.value, {
    weekday: days < 7 ? 'long' : undefined,
    month: days < 7 ? undefined : 'long',
    day: days < 7 ? undefined : 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  }).format(date)
}

function systemEventIcon(entry: GuestThreadEntryViewModel) {
  if (entry.kind === 'resolution') return entry.eventName === 'thread.resolved' ? 'i-lucide-check-check' : 'i-lucide-rotate-ccw'
  if (entry.eventName === 'thread.archived') return 'i-lucide-archive'
  if (entry.eventName === 'thread.unarchived') return 'i-lucide-inbox'
  return 'i-lucide-circle-check'
}

function systemEventLabel(entry: GuestThreadEntryViewModel) {
  const actor = entry.actorLabel ? `${entry.actorLabel} ` : ''
  if (entry.kind === 'operation') {
    if (entry.body?.trim()) return entry.body
    if (/^(?:payment|refund|dispute)\./.test(entry.eventName ?? '')) {
      if (!entry.body?.trim()) throw createError({ statusCode: 500, statusMessage: 'Financial conversation activity requires its display message.', fatal: true })
      return entry.body
    }
    if (entry.eventName === 'migration_snapshot') return 'Imported from previous system'
    if (entry.eventName === 'booking_change.accepted') return 'The client accepted the requested changes'
    if (entry.eventName === 'booking_change.declined') return 'The client declined the requested changes'
    if (entry.eventName === 'booking_change.moved') return entry.body ?? `${capitalize(recordNoun.value)} updated`
    if (entry.payload?.action === 'cancel') return `${actor}cancelled the ${recordNoun.value}`.trim()
    if (entry.eventName === 'thread.archived') return `${actor}archived this conversation`.trim()
    if (entry.eventName === 'thread.unarchived') return `${actor}moved this conversation to messages`.trim()
    return entry.eventName ?? 'Operation recorded'
  }
  // Threads are no longer resolved by hand, but the entries that were still
  // belong to the history of the ones that have them.
  if (entry.kind === 'resolution') return `${actor}${entry.eventName === 'thread.resolved' ? 'resolved' : 'reopened'} this thread`.trim()
  return entry.eventName ?? 'Recorded on this conversation'
}

const DELIVERY_PURPOSE_LABELS = {
  owner_alert: 'owner alert',
  guest_acknowledgement: 'guest acknowledgement',
  member_reply: 'reply',
  status_update: 'status update',
  scheduled_message: 'scheduled message',
  team_message: 'team message',
} satisfies Record<GuestThreadDeliveryFailureViewModel['purpose'], string>

function deliveryFailureTitle(failure: GuestThreadDeliveryFailureViewModel) {
  if (failure.status === 'uncertain') return 'Reply needs review: send outcome unknown'
  const delivery = `${CHANNEL_LABELS[failure.channel]} ${DELIVERY_PURPOSE_LABELS[failure.purpose]}`
  return `${delivery} could not be sent`
}

function deliveryFailureDescription(failure: GuestThreadDeliveryFailureViewModel) {
  if (failure.status === 'uncertain') return failure.error ?? 'The provider may have accepted this message. Review the conversation before sending again.'
  return failure.error ?? `The ${failure.channel} provider rejected this delivery.`
}
</script>
