<template>
  <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
    <UAlert
      v-if="realtimeFailed"
      color="warning"
      variant="soft"
      icon="i-lucide-wifi-off"
      title="Live updates are unavailable"
      description="This conversation may be out of date until the dashboard reconnects."
      class="m-3"
    >
      <template #actions>
        <UButton color="warning" variant="soft" size="xs" :loading="pending" @click="refreshThreadState">
          Refresh
        </UButton>
      </template>
    </UAlert>

    <!-- A request that failed, or a conversation that is gone, is a state this
         surface shows rather than a blank column. -->
    <UAlert
      v-if="!thread && !pending"
      class="m-3"
      color="error"
      variant="soft"
      :title="isNotFoundError(error) ? 'This conversation is no longer available' : 'Conversation could not be loaded'"
      :description="isNotFoundError(error) ? 'It may have been deleted, or the link is from another business.' : getErrorMessage(error, 'Guest thread request failed')"
    />

    <template v-else-if="thread">
      <!-- Positioned so UChatMessages' jump-to-latest button sits over the
           stream rather than scrolling away with it. -->
      <div class="relative flex min-h-0 flex-1 flex-col">
        <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <UChatMessages :auto-scroll="{ size: 'sm' }" :ui="{ root: 'gap-0 px-4 py-4 sm:px-6' }">
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
                    <span class="ms-1.5">{{ item.providerTimestamp ? 'Recorded ' : '' }}{{ formatClockTime(item.occurredAt) }}</span>
                  <span v-if="item.providerTimestamp" class="block break-all text-xs text-muted">Provider timestamp: {{ item.providerTimestamp }}</span>
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

      <div class="shrink-0 px-4 pb-4 pt-2 sm:px-6">
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

        <!-- Airbnb's composer, measured at 1440: a ~112px box, 20px insets,
             16px text, the photo glyph (24px) flush with the text's left
             edge and a 32px send circle at the right — pale until there is
             something to send. A pasted photo is added the same way. The
             form's own spacing goes in `class`: `ui.root` is forwarded to the
             textarea inside it as well. It does not take focus on mount: on
             desktop the first conversation opens beside the list, and Nuxt
             UI's default autofocus took the keyboard away from the list. -->
        <UChatPrompt
          v-model="draft"
          :autofocus="false"
          placeholder="Write a message…"
          color="neutral"
          :disabled="!canReply"
          :rows="2"
          :maxrows="8"
          class="gap-2 rounded-2xl px-5 pb-2.5 pt-4"
          :ui="{ header: 'flex-wrap gap-2 pb-1', base: 'px-0 py-0 text-base/6 sm:text-base/6', footer: 'items-center' }"
          @submit="sendReply"
          @paste="addPastedPhotos"
        >
          <template v-if="chosen.length" #header>
            <TransitionGroup
              enter-from-class="opacity-0 scale-75"
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              leave-to-class="opacity-0 scale-75"
              leave-active-class="transition duration-150 motion-reduce:transition-none"
            >
              <div v-for="(photo, at) in chosen" :key="photo.url" class="relative">
                <img :src="photo.url" :alt="photo.file.name" class="size-16 rounded-xl object-cover">
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="solid"
                  size="xs"
                  square
                  class="absolute -right-1.5 -top-1.5 rounded-full ring-2 ring-default"
                  :aria-label="`Remove ${photo.file.name}`"
                  @click="removePhoto(at)"
                />
              </div>
            </TransitionGroup>
          </template>

          <template #footer>
            <UButton
              icon="i-lucide-image"
              color="neutral"
              variant="ghost"
              square
              class="-ms-1.5 size-9 justify-center rounded-full p-0"
              :ui="{ leadingIcon: 'size-6' }"
              aria-label="Add photos"
              :title="thread.replyChannel === 'airbnb' ? 'Photo replies via Airbnb are unavailable here' : 'Add photos'"
              :disabled="!canReply || thread.replyChannel === 'airbnb' || chosen.length >= MAX_PHOTOS"
              @click="picker?.click()"
            />
            <input ref="picker" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple class="hidden" @change="addPickedPhotos">
            <UChatPromptSubmit
              status="ready"
              color="neutral"
              variant="solid"
              square
              class="size-8 justify-center rounded-full p-0 transition duration-200 active:scale-90 disabled:bg-elevated disabled:text-dimmed disabled:opacity-100"
              :ui="{ leadingIcon: 'size-4' }"
              aria-label="Send reply"
              title="Send reply"
              :disabled="!canReply || sending || (!draft.trim() && !chosen.length)"
            />
          </template>
        </UChatPrompt>

        <!-- A photo opens whole over the conversation, and steps through the
             others it was sent with. -->
        <UModal
          :open="viewer !== null"
          :title="viewer ? `Photo ${viewer.at + 1} of ${viewer.photos.length}` : ''"
          :ui="{ content: 'max-w-4xl bg-transparent shadow-none ring-0', header: 'sr-only', body: 'p-0 sm:p-0' }"
          @update:open="open => { if (!open) viewer = null }"
        >
          <template #body>
            <div v-if="viewer" class="relative flex items-center justify-center">
              <Transition
                mode="out-in"
                enter-from-class="opacity-0 scale-[0.98]"
                enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                leave-to-class="opacity-0"
                leave-active-class="transition duration-100"
              >
                <img
                  :key="viewer.photos[viewer.at]!.url"
                  :src="viewer.photos[viewer.at]!.url"
                  :alt="viewer.photos[viewer.at]!.alt ?? ''"
                  class="max-h-[85vh] w-auto rounded-2xl object-contain"
                >
              </Transition>
              <template v-if="viewer.photos.length > 1">
                <UButton
                  icon="i-lucide-chevron-left"
                  color="neutral"
                  variant="solid"
                  square
                  class="absolute left-3 rounded-full"
                  aria-label="Previous photo"
                  @click="viewer.at = (viewer.at + viewer.photos.length - 1) % viewer.photos.length"
                />
                <UButton
                  icon="i-lucide-chevron-right"
                  color="neutral"
                  variant="solid"
                  square
                  class="absolute right-3 rounded-full"
                  aria-label="Next photo"
                  @click="viewer.at = (viewer.at + 1) % viewer.photos.length"
                />
              </template>
            </div>
          </template>
        </UModal>

        <p v-if="!canReply" class="mt-2 text-xs text-warning">This guest has no email on file. Once they accept an invite to this conversation, your replies reach their KrabiClaw inbox.</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import type { AvatarProps } from '@nuxt/ui'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'
import { isThreadDetailResponse, threadRecordTitle, type ThreadDetail } from '~/lib/components/workspace/messages/guest-thread-client'
import type { GuestThreadDeliveryFailureViewModel, GuestThreadEntryViewModel } from '~/server/domain/guest-threads/types'
import { useDashboardInvalidations } from '~/composables/useDashboardInvalidations'
import { authClient } from '~/lib/auth-client'

/*
  One guest thread: the conversation and its composer. The list is a separate
  level of the route tree, and the panel, navbar and the way into the record
  belong to the route that mounts this.
*/
const props = withDefaults(defineProps<{ threadId: string; personalScope?:boolean }>(),{personalScope:false})

const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi(useDashboardRouteScope())
const realtime = useDashboardInvalidations()
const realtimeFailed = computed(() => !props.personalScope && realtime.status.value === 'failed')
const { locale } = useI18n()
const session = authClient.useSession()

// The one copy of this thread. The record beside the conversation reads the
// same entry, so writing a reply's answer into it updates both.
const { data, thread, pending, error, refresh } = await useGuestThread(computed(() => props.threadId),computed(()=>props.personalScope))
const canReply = computed(() => props.personalScope || thread.value?.replyChannel === 'airbnb' || Boolean(thread.value?.guestEmail) || Boolean(thread.value?.guestAccountLinked))
const threadPath = computed(() => props.personalScope ? `/api/account/messages/${encodeURIComponent(props.threadId)}` : `/api/dashboard/organizations/${dashboard.organizationId.value}/guest-threads/${encodeURIComponent(props.threadId)}`)

const draft = ref('')
const actionError = ref<string | null>(null)
const readError = ref<string | null>(null)

/*
  A reply shows the moment it is sent, dimmed and "Sending…" until the server
  has it. The attempt keeps its idempotency key until it succeeds, so sending
  the same words again after a failure is the same request, not a second one.
*/
const attempt = ref<{ key: string; body: string; photos: ChosenPhoto[]; sentAfter: Set<string> } | null>(null)
const sending = ref(false)
// The server's entry for a reply that was on screen as a pending one takes the
// pending one's key, so it settles in place instead of animating in again.
const settledKeys = ref<Record<string, string>>({})

async function sendReply() {
  const body = draft.value.trim()
  const photos = chosen.value
  if (!thread.value || !canReply.value || (!body && !photos.length) || sending.value) return
  if (attempt.value?.body !== body || !samePhotos(attempt.value.photos, photos)) {
    attempt.value = { key: crypto.randomUUID(), body, photos, sentAfter: new Set(thread.value.entries.map(entry => entry.id)) }
  }
  const current = attempt.value
  sending.value = true
  actionError.value = null
  draft.value = ''
  chosen.value = []
  void scrollToLatest()
  try {
    const res = await (props.personalScope?applicationFetch:dashboardApi)<{ thread: ThreadDetail }>(`${threadPath.value}/${props.personalScope?'reply':'operations/reply'}`, {
      method: 'POST',
      body: photos.length ? replyForm(body, photos, current.key) : { body, idempotencyKey: current.key },
      validate: isThreadDetailResponse,
    })
    const reply = res.thread.entries.findLast(entry => entry.kind === 'message' && entry.actorKind === (props.personalScope?'guest':'member') && !current.sentAfter.has(entry.id))
    if (reply) settledKeys.value = { ...settledKeys.value, [reply.id]: `pending:${current.key}` }
    data.value = res
    attempt.value = null
    for (const photo of photos) URL.revokeObjectURL(photo.url)
  } catch (err) {
    actionError.value = getErrorMessage(err, 'Failed to send reply')
    // The words and photos come back to the composer rather than vanishing with the bubble.
    if (!draft.value) draft.value = body
    if (!chosen.value.length) chosen.value = photos
  } finally {
    sending.value = false
  }
}

/*
  Photos chosen for the next reply, each with a local preview URL that the
  composer and the reply on its way both show until the server has them.
*/
type ChosenPhoto = { file: File; url: string }
const MAX_PHOTOS = 10
const ACCEPTED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const chosen = ref<ChosenPhoto[]>([])
const picker = useTemplateRef<HTMLInputElement>('picker')
const viewer = ref<{ photos: MessagePhotoView[]; at: number } | null>(null)

function addPhotos(files: File[]) {
  if (thread.value?.replyChannel === 'airbnb') {
    actionError.value = 'Photo replies via Airbnb are unavailable here.'
    return
  }
  const accepted = files.filter(file => ACCEPTED_PHOTO_TYPES.has(file.type))
  const refused = files.length - accepted.length
  const room = MAX_PHOTOS - chosen.value.length
  chosen.value = [...chosen.value, ...accepted.slice(0, room).map(file => ({ file, url: URL.createObjectURL(file) }))]
  actionError.value = refused
    ? `${refused === 1 ? 'That file is' : `${refused} files are`} not a JPEG, PNG, WebP, GIF or AVIF photo.`
    : accepted.length > room ? `A message can carry at most ${MAX_PHOTOS} photos.` : null
}

function addPickedPhotos(event: Event) {
  const input = event.target as HTMLInputElement
  addPhotos([...(input.files ?? [])])
  input.value = ''
}

function addPastedPhotos(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
  if (!files.length) return
  event.preventDefault()
  addPhotos(files)
}

function removePhoto(at: number) {
  const [removed] = chosen.value.splice(at, 1)
  if (removed) URL.revokeObjectURL(removed.url)
}

function samePhotos(a: ChosenPhoto[], b: ChosenPhoto[]) {
  return a.length === b.length && a.every((photo, at) => photo.file === b[at]!.file)
}

function replyForm(body: string, photos: ChosenPhoto[], idempotencyKey: string) {
  const form = new FormData()
  form.set('body', body)
  form.set('idempotencyKey', idempotencyKey)
  for (const photo of photos) form.append('photos', photo.file, photo.file.name)
  return form
}

onBeforeUnmount(() => {
  for (const photo of chosen.value) URL.revokeObjectURL(photo.url)
})

function refreshThreadState() {
  if (!props.personalScope) realtime.connect()
  void refresh()
}

watch(realtime.event, (event) => {
  if (props.personalScope || !event || !('threadId' in event)) return
  if (event.organizationId !== dashboard.organizationId.value) return
  if (event.threadId === props.threadId) void refresh()
})

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
  const size = fields.guests?.trim() ? `${fields.guests} ${fields.guests === '1' ? 'guest' : 'guests'}` : null
  const rows = [
    { label: 'When', value: fields.whenLabel },
    { label: 'Guests', value: size },
    { label: recordNoun.value.charAt(0).toUpperCase() + recordNoun.value.slice(1), value: fields.productTitle },
    { label: 'Location', value: fields.locationTitle ?? current.locationLabel },
    { label: 'Email', value: current.guestEmail },
    { label: 'Phone', value: current.guestPhone },
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
  | MessageItem

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
    const occurred = new Date(occurredAt)
    const day = `${occurred.getFullYear()}-${occurred.getMonth()}-${occurred.getDate()}`
    if (day !== previousDay) {
      items.push({ type: 'day', key: `day:${day}`, label: dayLabel(occurred) })
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
        ...(mirrored ? { run: `provider:${entry.id}` } : {}),
        unshown: Array.isArray(unshown) ? unshown.filter((name): name is string => typeof name === 'string') : [],
        ...(member ? { receipt: receiptFor(entry, current.participantLabel) } : {}),
      })
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
    if (/^(?:payment|refund|dispute)\./.test(entry.eventName ?? '')) {
      if (!entry.body?.trim()) throw createError({ statusCode: 500, statusMessage: 'Financial conversation activity requires its display message.', fatal: true })
      return entry.body
    }
    if (entry.eventName === 'migration_snapshot') return 'Imported from previous system'
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
