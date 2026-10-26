<template>
  <!--
    One record, opened beneath Today, Calendar or the guest thread it belongs
    to. This is the summary;
    the things that change it — the request, a note, the guest — are levels of
    their own under the record's canonical URL, which both mounts link to.
  -->
  <!--
    The provider owns its chrome: the levels below inject what this component
    holds, and `<NuxtPage>` reaches them only from inside its own subtree. In
    the thread's leaf there is no column to own, so it is the body alone.
  -->
  <component :is="embedded ? 'div' : DashboardIndexPanel" v-bind="chrome">
    <UAlert v-if="error" color="error" variant="soft" title="Booking details could not be loaded" :description="getErrorMessage(error, 'Booking request failed')" />
    <div v-else class="min-w-0 [overflow-wrap:anywhere]">
      <UAlert
        v-if="actionError"
        class="mb-5"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        :description="actionError"
      />
      <template v-if="booking">
        <!-- The business reads who is coming; the account reads what it booked and where. A purchase is what was bought, for both. -->
        <div class="flex items-start gap-6">
          <div class="min-w-0 flex-1">
            <h2 class="break-words text-2xl font-semibold text-highlighted">{{ personalScope || purchase ? booking.resourceTitle : partyTitle }}</h2>
            <p class="mt-1 break-words text-base text-muted">{{ subline }}</p>
          </div>
          <img v-if="bookingImageUrl" :src="bookingImageUrl" alt="" class="size-20 shrink-0 rounded-xl bg-elevated object-contain">
        </div>

        <!-- Airbnb's "Change requested", for both sides and both kinds: the proposal is out and the record stays as it is until the guest answers. -->
        <UAlert
          v-if="booking.pendingChange"
          class="mt-4"
          color="info"
          variant="soft"
          icon="i-lucide-clock"
          :title="personalScope ? `${booking.organizationName} requested a change` : 'Change requested'"
          :description="`${booking.pendingChange.afterLabel} · ${booking.pendingChange.partySize} ${booking.pendingChange.partySize === 1 ? 'guest' : 'guests'}${personalScope ? '' : ` · Waiting for ${firstName(booking.guestName ?? '')} to respond`}`"
          :actions="personalScope ? [
            { label: 'Accept', color: 'neutral' as const, loading: answering === 'accept', onClick: () => answerChange('accept') },
            { label: 'Decline', color: 'neutral' as const, variant: 'soft' as const, loading: answering === 'decline', onClick: () => answerChange('decline') },
          ] : undefined"
        />
        <div class="mt-6 flex flex-wrap gap-3">
          <UButton
            v-for="action in availableActions"
            :key="action.value"
            :label="action.label"
            :icon="action.icon"
            :color="action.color"
            variant="ghost"
            :loading="pendingAction === action.value"
            @click="action.value === 'cancel' && !booking.guestCanRetryCancellation ? openCancel() : runAction(action.value)"
          />
          <UButton
            v-if="canChangeBooking && !personalScope"
            :label="`Change ${noun}`"
            color="neutral"
            variant="soft"
            :to="`${editorPath}/change`"
            @click="beginChange"
          />
          <UButton
            v-if="messageTo"
            :label="personalScope ? 'Message' : 'Message guest'"
            color="neutral"
            variant="soft"
            :to="messageTo"
          />
          <UButton
            v-if="personalScope && booking.contactPhone"
            label="Call"
            color="neutral"
            variant="soft"
            :to="`tel:${booking.contactPhone}`"
          />
        </div>

        <div v-if="!purchase" class="mt-8 grid grid-cols-2 gap-4 border-t border-default pt-6">
          <div>
            <p class="text-base font-semibold text-highlighted">Date</p>
            <p class="mt-1 text-base text-muted">{{ formattedDate }}</p>
          </div>
          <div>
            <p class="text-base font-semibold text-highlighted">Time</p>
            <p class="mt-1 text-base text-muted">{{ formattedTime }}</p>
          </div>
        </div>

        <template v-if="booking.type === 'booking' && !personalScope">
          <component :is="canChangeBooking ? NuxtLink : 'div'" :to="canChangeBooking ? `${editorPath}/team-member` : undefined" class="mt-6 flex items-center gap-4 border-y border-default py-6">
            <span class="min-w-0 flex-1"><span class="block text-base font-medium text-highlighted">Team member</span><span class="block text-sm text-muted">{{ booking.assignedMemberName || (booking.assignedMemberId ? 'Previously assigned member' : booking.organizationName) }}</span></span>
            <UIcon v-if="canChangeBooking" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </component>
          <UAlert v-if="booking.providerConflict" class="mt-4" color="warning" description="This booking overlaps a busy time. Contact your guest to change it." />
          <UAlert v-if="booking.providerCalendarStatus" class="mt-4" color="warning" :description="booking.providerCalendarStatus" />
        </template>

        <PaymentDetails v-for="detail in booking.payments" :key="detail.payment.id" :payment="detail.payment" :refunds="detail.refunds" :order="detail.order">
          <template v-if="!personalScope && detail.payment.captured_amount > detail.payment.refunded_amount" #actions>
            <!-- Airbnb's host sends money from the reservation; the amount is asked for on its own leaf. -->
            <NuxtLink :to="{ path: `${editorPath}/refund`, query: { payment: detail.payment.id } }" class="flex items-center gap-4 border-t border-default py-4">
              <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
              <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
            </NuxtLink>
          </template>
        </PaymentDetails>

        <div class="mt-6 border-t border-default pt-2">
          <!-- The business opens the guest; the account reads its own party, as Airbnb's "Who's coming". A purchase names its buyer and nothing opens. -->
          <div v-if="personalScope && !purchase" class="py-4">
            <p class="text-base font-medium text-highlighted">Who’s coming</p>
            <p class="mt-1 text-sm text-muted">{{ guestCountLabel }}</p>
          </div>
          <component :is="purchase ? 'div' : NuxtLink" v-else-if="!personalScope && booking.guestName" :to="purchase ? undefined : `${editorPath}/guest`" class="flex items-center gap-4 py-4">
            <UAvatar :src="booking.guestImageUrl || undefined" :alt="booking.guestName" icon="i-lucide-user" size="md" class="shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">{{ booking.guestName }}</span>
              <span v-if="!purchase" class="block text-sm text-muted">{{ guestCountLabel }}</span>
            </span>
            <UIcon v-if="!purchase" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </component>

          <div v-if="booking.requests" class="border-t border-default py-4">
            <p class="text-base font-medium text-highlighted">{{ personalScope ? 'Your requests' : 'Guest requests' }}</p>
            <p class="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">{{ booking.requests }}</p>
          </div>

          <button v-if="!purchase" type="button" class="flex w-full items-center gap-4 border-t border-default py-4 text-left" @click="policyOpen = true">
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">Cancellation policy</span>
              <span class="block text-sm text-muted">{{ cancellationSummary }}</span>
            </span>
            <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </button>

          <NuxtLink v-if="!personalScope && !purchase" :to="`${editorPath}/notes`" class="flex items-center gap-4 border-t border-default py-4">
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">Your notes</span>
              <span class="block text-sm text-muted">{{ notesSummary }}</span>
            </span>
            <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </NuxtLink>


          <div class="flex items-center gap-4 border-t border-default py-4">
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">{{ capitalize(noun) }} made</span>
              <span class="block text-sm text-muted">{{ formatCreatedAt(booking.createdAt) }}</span>
            </span>
          </div>
        </div>
      </template>
    </div>
  </component>

  <DashboardListItemDialog v-model:open="policyOpen" :title="booking?.policy?.heading || 'Cancellation policy'" :show-actions="false">
    <div v-if="booking" class="space-y-4">
      <div v-if="booking.policy?.items.length" class="space-y-3">
        <div v-for="item in booking.policy!.items" :key="item.id" class="flex gap-3">
          <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-success" />
          <p class="text-sm leading-relaxed text-muted">{{ item.text }}</p>
        </div>
      </div>
      <p v-else-if="!booking.policy?.additional_notes_html" class="text-sm text-muted">No cancellation terms have been configured for this booking.</p>
      <div v-if="booking.policy?.additional_notes_html" class="border-t border-default pt-4 text-sm text-muted">
        <!-- Canonical booking-policy writes sanitize this CMS-authored HTML before persistence. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-html="booking.policy!.additional_notes_html" />
      </div>
    </div>
  </DashboardListItemDialog>
  <!--
    Cancelling gets a screen that states the consequence and lets the tenant say
    why, rather than a native confirm() stacked on top of the sheet that opened
    it. The note travels with the notification the guest receives.
  -->
  <DashboardListItemDialog
    v-model:open="cancelOpen"
    :title="`Cancel ${noun}`"
    :show-actions="false"
    :error="actionError"
  >
    <div v-if="booking" class="space-y-5">
      <p class="text-sm leading-relaxed text-muted">{{ cancellationSummary }}</p>
      <UFormField v-if="!personalScope" :label="`Add a note for ${firstName(booking.guestName ?? '')}`" hint="Optional">
        <UTextarea v-model="cancelNote" :rows="4" maxlength="500" class="w-full" placeholder="Let them know why, and what happens next." />
      </UFormField>
      <p v-if="personalScope" class="text-sm text-muted">
        {{ booking.organizationName }} is told the {{ noun }} was cancelled.
        <template v-if="booking.type === 'reservation' && refundable">Your deposit is automatically refunded unless the cancellation deadline has passed.</template>
        <template v-else-if="refundable">Cancelling doesn’t automatically refund your payment. Contact {{ booking.organizationName }} about a refund.</template>
        This cannot be undone.
      </p>
      <p v-else class="text-sm text-muted">
        {{ firstName(booking.guestName ?? '') }} is told the {{ noun }} was cancelled{{ cancelNote.trim() ? ', with your note' : '' }}.
        <template v-if="refundable">Their {{ paymentMoney(refundable, booking.payments![0]!.payment.currency) }} payment is refunded in full; you approve that next.</template>
        This cannot be undone.
      </p>
      <div class="flex items-center justify-between gap-4 pt-1">
        <UButton :label="`Keep ${noun}`" color="neutral" variant="ghost" @click="cancelOpen = false" />
        <UButton :label="`Cancel ${noun}`" color="error" :loading="pendingAction === 'cancel'" @click="runAction('cancel')" />
      </div>
    </div>
  </DashboardListItemDialog>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { DashboardBookingDetails, DashboardRecordType } from '~/server/utils/dashboard-booking-details'

export interface BookingChangeDraft { overridePolicy: boolean; bookingDate: string; bookingTime: string; partySize: number; locationId: string; sessionId: string; sessionLabel: string; sourceUpdatedAt: string }
export type BookingChangeField = 'date' | 'time' | 'guests' | 'location' | 'session'

/** The record and the drafts its levels edit: one change request, one note. */
export interface BookingEditor {
  bookingType: DashboardRecordType
  refresh: () => Promise<void>
  booking: Ref<DashboardBookingDetails | null>
  noun: ComputedRef<string>
  messageTo: ComputedRef<string | null>
  callTo: ComputedRef<string | null>
  // the change request
  changeDraft: Ref<BookingChangeDraft>
  changeFields: ComputedRef<Array<{ key: string; label: string; summary: string }>>
  changeLocation: ComputedRef<{ title: string; imageUrl?: string | null } | undefined>
  changeDirty: ComputedRef<boolean>
  changeValid: ComputedRef<boolean>
  changeSaving: Ref<boolean>
  changeError: Ref<string | null>
  resetChangeDraft: () => void
  /** Remembers the field's value so a cancelled field leaf can put it back. */
  beginChangeField: (field: BookingChangeField) => void
  cancelChangeField: (field: BookingChangeField) => void
  sendChangeRequest: () => Promise<void>
  firstName: (name: string) => string
  // notes
  noteDraft: Ref<string>
  noteSaving: Ref<boolean>
  noteError: Ref<string | null>
  selectedNote: ComputedRef<{ id: string; body: string } | undefined>
  /** Points the note draft at one note, or at a new one. */
  openNote: (noteId: string | null) => void
  saveNote: () => Promise<boolean>
  formatCreatedAt: (value: string) => string
}

export const bookingEditorKey = Symbol('booking-editor') as InjectionKey<BookingEditor>
</script>

<script setup lang="ts">
import PaymentDetails from '~/components/dashboard/PaymentDetails.vue'
import { paymentMoney } from '~/shared/payment-display'
import { authClient } from '~/lib/auth-client'
import { NuxtLink } from '#components'
import { formatCalendarDate, formatTime, formatTimestamp } from '~/utils/timezone'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import { getErrorMessage } from '~/utils/errors'
import { htmlToPlainText } from '~/utils/markdown'

const props = defineProps<{
  bookingType: DashboardRecordType
  bookingId: string
  /** The record's canonical URL, which the rows that change it link into. */
  editorPath: string
  /** Mounted inside the guest thread's leaf, which already owns the column and its padding. */
  embedded?: boolean
  /** The account that booked, reading its own record: no team controls, its own cancel. */
  personalScope?: boolean
}>()

type ActionColor = 'success' | 'error' | 'neutral'

const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const realtime = useDashboardInvalidations()
const actionError = ref<string | null>(null)
const editorPath = computed(() => props.editorPath)
// Owning the column means owning its header; inside the thread's leaf it is that leaf's body.
const chrome = computed(() => (props.embedded
  ? {}
  : { id: props.personalScope ? 'account-booking-details' : 'booking-details', title: pageTitle.value, column: 'leaf' as const }))
/** Which note a leaf is editing, or none for a new one. */
const openNoteId = ref<string | null>(null)
const selectedNote = computed(() => booking.value?.notes.find(note => note.id === openNoteId.value))

const { resource, booking, error, presentation, noun, pageTitle, orgSlug, purchase, refresh: refreshDetails } = await useBookingDetails(props.bookingType, props.bookingId, props.personalScope)

const formattedDate = computed(() => booking.value ? formatCalendarDate(booking.value.bookingDate, 'en') : '')
const formattedTime = computed(() => {
  if (!booking.value?.bookingTime) return ''
  return formatTime(booking.value.bookingTime, 'en')
})
// Under the title: when, then where it was booked or who bought it.
const subline = computed(() => {
  if (!booking.value) return ''
  const when = purchase ? `${booking.value.type === 'order' ? 'Ordered' : 'Paid'} ${formattedDate.value}` : formattedDate.value
  const who = props.personalScope ? booking.value.organizationName : purchase ? booking.value.guestName : booking.value.resourceTitle
  return [when, who].filter(Boolean).join(' · ')
})
// Context for the record's identity: a compact resource or location picture.
const bookingImageUrl = computed(() => {
  if (!booking.value) return null
  return booking.value.resourceImageUrl
})
// Airbnb's host-side stay page titles the party, not the listing: "Chris's
// group of 2". A single guest is just their name.
const partyTitle = computed(() => {
  if (!booking.value) return ''
  const size = booking.value.partySize ?? 0
  return size > 1 ? `${booking.value.guestName}'s group of ${size}` : booking.value.guestName ?? ''
})
const notesSummary = computed(() => {
  const count = booking.value?.notes.length ?? 0
  if (count === 0) return 'Only your team can see these notes'
  return count === 1 ? '1 note' : `${count} notes`
})

const guestCountLabel = computed(() => `${booking.value?.partySize ?? 0} ${(booking.value?.partySize ?? 0) === 1 ? 'guest' : 'guests'}`)
const cancellationSummary = computed(() => booking.value?.policy?.items.find(item => item.id === 'cancellation')?.text
  ?? (booking.value?.policy?.additional_notes_html ? htmlToPlainText(booking.value.policy.additional_notes_html) : 'No cancellation terms have been configured.'))
const messageTo = computed(() => {
  if (!booking.value?.threadId) return null
  return `/dashboard/${orgSlug.value}/messages/${encodeURIComponent(booking.value.threadId)}`
})
const canChangeBooking = computed(() => Boolean(booking.value && !booking.value.complete && ['pending', 'confirmed'].includes(booking.value.status)))
const callTo = computed(() => booking.value?.guestPhone ? `tel:${booking.value.guestPhone}` : null)

const policyOpen = ref(false)
const session = authClient.useSession()
// The buyer's answer to a change, on the record itself; the email link records the same decision.
const answering = ref<'accept' | 'decline' | null>(null)
async function answerChange(decision: 'accept' | 'decline') {
  const change = booking.value?.pendingChange
  if (!change || !booking.value?.threadId || answering.value) return
  answering.value = decision
  actionError.value = null
  try {
    await applicationFetch('/api/account/bookings/change', {
      method: 'POST',
      body: { thread_id: booking.value.threadId, request_id: change.requestId, decision },
      validate: (value: unknown): value is Record<string, unknown> => isRecord(value),
    })
    await refreshDetails()
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Your answer could not be saved')
  } finally {
    answering.value = null
  }
}
const cancelOpen = ref(false)
const cancelNote = ref('')
// What a cancellation gives back: everything still captured, as Airbnb's host cancellation does.
const refundable = computed(() => (booking.value?.payments ?? []).reduce((sum, entry) => sum + entry.payment.captured_amount - entry.payment.refunded_amount, 0))
const changeSaving = ref(false)
const changeDraft = useState(
  `booking-change-draft:${orgSlug.value}:${props.bookingType}:${props.bookingId}`,
  () => ({ overridePolicy: false, bookingDate: '', bookingTime: '', partySize: 1, locationId: '', sessionId: '', sessionLabel: '', sourceUpdatedAt: '' }),
)
const changeAttemptKey = ref<string | null>(null)
const changeAttemptDraft = ref('')
const changeFieldOriginal = ref<string | number | null>(null)
const changeLocation = computed(() => booking.value?.locations.find(location => location.id === changeDraft.value.locationId))
const changeDirty = computed(() => {
  if (!booking.value) return false
  if (changeDraft.value.partySize !== (booking.value.partySize ?? 1)) return true
  // Only the fields this kind can actually change count as a change.
  if (props.bookingType !== 'reservation') return changeDraft.value.sessionId !== (booking.value.sessionId ?? '')
  return changeDraft.value.bookingDate !== booking.value.bookingDate
    || changeDraft.value.bookingTime !== (booking.value.bookingTime ?? '').slice(0, 5)
    || changeDraft.value.locationId !== booking.value.locationId
})
/**
 * What this record can be changed to.
 *
 * A reservation moves to a location, date and time. A booking moves to another
 * SESSION of its product — an occurrence that exists as a row — so its "Date
 * and time" is chosen from the product's open sessions.
 */
const changeFields = computed(() => props.bookingType === 'reservation'
  ? [
      { key: 'date', label: 'Date', summary: changeDraft.value.bookingDate ? formatCalendarDate(changeDraft.value.bookingDate, 'en') : 'Choose a date' },
      { key: 'time', label: 'Time', summary: changeDraft.value.bookingTime ? formatTime(changeDraft.value.bookingTime, 'en') : 'Choose a time' },
      { key: 'guests', label: 'Guests', summary: `${changeDraft.value.partySize} ${changeDraft.value.partySize === 1 ? 'guest' : 'guests'}` },
    ]
  : [
      { key: 'session', label: 'Date and time', summary: changeDraft.value.sessionLabel || (booking.value?.bookingDate ? `${formatCalendarDate(booking.value.bookingDate, 'en')}${booking.value.bookingTime ? ` · ${formatTime(booking.value.bookingTime, 'en')}` : ''}` : 'Choose a time') },
      { key: 'guests', label: 'Guests', summary: `${changeDraft.value.partySize} ${changeDraft.value.partySize === 1 ? 'guest' : 'guests'}` },
    ])
const changeValid = computed(() => props.bookingType === 'reservation'
  ? Boolean(changeDraft.value.bookingDate && changeDraft.value.bookingTime && changeDraft.value.locationId && Number.isInteger(changeDraft.value.partySize) && changeDraft.value.partySize > 0)
  : Boolean((changeDraft.value.sessionId || booking.value?.sessionId) && Number.isInteger(changeDraft.value.partySize) && changeDraft.value.partySize > 0))
const pendingAction = ref<string | null>(null)
const actionAttempt = ref<{ draft: string; key: string } | null>(null)
const noteDraft = ref('')
const noteRevisionId = ref<string>()
const noteSaving = ref(false)
const noteAttemptKey = ref<string | null>(null)
const noteAttemptDraft = ref<string | null>(null)
const noteError = ref<string | null>(null)
const changeError = ref<string | null>(null)

function openNote(noteId: string | null) {
  openNoteId.value = noteId
  noteDraft.value = selectedNote.value?.body ?? ''
  noteRevisionId.value = selectedNote.value?.revisionId
  noteAttemptKey.value = null
  noteAttemptDraft.value = null
  noteError.value = null
}

// The staged change lives in Nuxt state so the change index and its field leaves,
// each a route of its own, edit one draft. It is reseeded only when it belongs
// to an older source revision.
watch(booking, (currentBooking) => {
  if (currentBooking && changeDraft.value.sourceUpdatedAt !== currentBooking.updatedAt) resetChangeDraft()
}, { immediate: true })

function beginChangeField(field: BookingChangeField) {
  changeFieldOriginal.value = changeDraft.value[draftKey(field)]
}

function cancelChangeField(field: BookingChangeField) {
  changeError.value = null
  if (changeFieldOriginal.value === null) return
  const key = draftKey(field)
  if (key === 'partySize') changeDraft.value.partySize = Number(changeFieldOriginal.value)
  else changeDraft.value[key] = String(changeFieldOriginal.value)
}

function draftKey(field: BookingChangeField) {
  return field === 'date' ? 'bookingDate' : field === 'time' ? 'bookingTime' : field === 'guests' ? 'partySize' : field === 'session' ? 'sessionId' : 'locationId'
}

function resetChangeDraft() {
  if (!booking.value) return
  changeDraft.value.bookingDate = booking.value.bookingDate
  changeDraft.value.bookingTime = (booking.value.bookingTime ?? '').slice(0, 5)
  changeDraft.value.overridePolicy = false
  changeDraft.value.partySize = booking.value.partySize ?? 1
  changeDraft.value.locationId = booking.value.locationId ?? ''
  changeDraft.value.sessionId = booking.value.sessionId ?? ''
  changeDraft.value.sessionLabel = ''
  changeDraft.value.sourceUpdatedAt = booking.value.updatedAt
  changeAttemptKey.value = null
  changeAttemptDraft.value = ''
}

function beginChange() {
  resetChangeDraft()
}

// Nothing to approve and nothing to mark done: a booking arrives confirmed and
// is complete once its end passes. Cancelling is the one thing left to decide,
// and changing it is the link above.
const availableActions = computed<Array<{ value: string; label: string; icon: string; color: ActionColor }>>(() => {
  if (!booking.value || !presentation.value || !booking.value.threadId) return []
  if (props.personalScope && booking.value.guestCanRetryCancellation) return [
    { value: 'cancel', label: 'Retry deposit refund', icon: 'i-lucide-refresh-cw', color: 'neutral' as const },
  ]
  // The account's one decision is its own cancellation, on the public cancel rule the server already answered.
  if (props.personalScope) return booking.value.guestCanCancel
    ? [{ value: 'cancel', label: `Cancel ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const }]
    : []
  if (booking.value.complete) return []
  if (booking.value.type === 'booking' && booking.value.status === 'pending') return [
    { value: 'confirm', label: `Confirm ${presentation.value.noun}`, icon: 'i-lucide-calendar-check', color: 'success' as const },
    { value: 'reject', label: `Decline ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const },
  ]
  if (booking.value.status !== 'confirmed') return []
  return [{ value: 'cancel', label: `Cancel ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const }]
})

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : ''
}

function formatCreatedAt(value: string) {
  return formatTimestamp(value, 'en', 'UTC', { dateStyle: 'medium' })
}


function openCancel() {
  cancelNote.value = ''
  actionError.value = null
  cancelOpen.value = true
}

watch(realtime.event, (event) => {
  if (!event || (event.type !== 'thread.changed' && event.type !== 'delivery.changed')) return
  if (event.threadId === booking.value?.threadId) void refreshDetails()
})
watch(realtime.connectionEpoch, (epoch) => {
  if (epoch > 0) void refreshDetails()
})

async function saveNote() {
  if (!noteDraft.value.trim()) return false
  if (noteAttemptDraft.value !== noteDraft.value) {
    noteAttemptKey.value = crypto.randomUUID()
    noteAttemptDraft.value = noteDraft.value
  }
  noteSaving.value = true
  noteError.value = null
  try {
    const response = await dashboardApi<{ booking: DashboardBookingDetails }>(
      `/api/dashboard/bookings/${props.bookingType}/${encodeURIComponent(props.bookingId)}/notes`,
      {
        method: 'POST',
        body: { note: noteDraft.value, idempotencyKey: noteAttemptKey.value, noteId: selectedNote.value?.id, revisionId: noteRevisionId.value },
        validate: isBookingDetailsResponse,
      },
    )
    resource.value = response
    return true
  } catch (cause) {
    noteError.value = getErrorMessage(cause, 'Note could not be saved')
    return false
  } finally {
    noteSaving.value = false
  }
}

async function sendChangeRequest() {
  if (!changeValid.value || !changeDirty.value) return
  const draft = JSON.stringify(changeDraft.value)
  if (!changeAttemptKey.value || changeAttemptDraft.value !== draft) {
    changeAttemptKey.value = crypto.randomUUID()
    changeAttemptDraft.value = draft
  }
  changeSaving.value = true
  changeError.value = null
  try {
    // The writer takes one shape per kind and refuses anything else, so the
    // screen says which it is sending rather than posting a reservation-shaped
    // body for both — which is how every change request came back a 400.
    const proposal = props.bookingType === 'reservation'
      ? {
          kind: 'reservation' as const,
          overridePolicy: changeDraft.value.overridePolicy,
          bookingDate: changeDraft.value.bookingDate,
          bookingTime: changeDraft.value.bookingTime,
          partySize: changeDraft.value.partySize,
          locationId: changeDraft.value.locationId,
        }
      : { kind: 'booking' as const, sessionId: changeDraft.value.sessionId || (booking.value?.sessionId ?? ''), partySize: changeDraft.value.partySize }
    const response = await dashboardApi<{ booking: DashboardBookingDetails }>(
      `/api/dashboard/bookings/${props.bookingType}/${encodeURIComponent(props.bookingId)}/changes`,
      {
        method: 'POST',
        body: { ...proposal, expectedUpdatedAt: booking.value?.updatedAt, idempotencyKey: changeAttemptKey.value },
        validate: isBookingDetailsResponse,
      },
    )
    resource.value = response
    resetChangeDraft()
    await navigateTo(editorPath.value)
  } catch (cause) {
    changeError.value = getErrorMessage(cause, 'Change request could not be sent')
  } finally {
    changeSaving.value = false
  }
}

async function runAction(action: string) {
  if (!booking.value?.threadId || pendingAction.value) return
  const note = action === 'cancel' ? cancelNote.value.trim() : ''
  const draft = JSON.stringify([booking.value.threadId, action, note])
  if (actionAttempt.value?.draft !== draft) actionAttempt.value = { draft, key: crypto.randomUUID() }
  pendingAction.value = action
  actionError.value = null
  try {
    if (props.personalScope) {
      await applicationFetch('/api/account/cancel', {
        method: 'POST',
        body: { request_id: booking.value.threadId },
        validate: (value: unknown): value is { success: true } => isRecord(value) && value.success === true,
      })
      await refreshNuxtData(`account-activity:${session.value.data?.user.id}`)
    } else {
      await dashboardApi(`/api/dashboard/organizations/${booking.value.organizationId}/guest-threads/${booking.value.threadId}/operations/${action}`, {
        method: 'POST',
        body: { idempotencyKey: actionAttempt.value.key, ...(note ? { body: note } : {}) },
        validate: (value: unknown): value is { thread: Record<string, unknown> } => isRecord(value) && isRecord(value.thread),
      })
    }
    await refreshDetails()
    actionAttempt.value = null
    cancelOpen.value = false
  } catch (cause) {
    const approvalUrl=isRecord(cause)&&isRecord(cause.data)&&isRecord(cause.data.data)&&typeof cause.data.data.financial_approval_url==='string'?cause.data.data.financial_approval_url:null
    if(approvalUrl) await navigateTo(approvalUrl)
    else actionError.value = getErrorMessage(cause, 'Booking could not be updated')
  } finally {
    pendingAction.value = null
  }
}
provide(bookingEditorKey, {
  bookingType: props.bookingType,
  refresh: async () => { await refreshDetails() },
  booking,
  noun,
  messageTo,
  callTo,
  changeDraft,
  changeFields,
  changeLocation,
  changeDirty,
  changeValid,
  changeSaving,
  changeError,
  resetChangeDraft,
  beginChangeField,
  cancelChangeField,
  sendChangeRequest,
  firstName,
  noteDraft,
  noteSaving,
  noteError,
  selectedNote,
  openNote,
  saveNote,
  formatCreatedAt,
})
</script>
