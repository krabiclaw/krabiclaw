<template>
  <!--
    One record, opened beneath Today, Calendar or the guest thread it belongs
    to. Changes and guest details open beneath its canonical URL.
  -->
  <!--
    The provider owns its chrome: the levels below inject what this component
    holds, and `<NuxtPage>` reaches them only from inside its own subtree. In
    the thread's leaf there is no column to own, so it is the body alone.
  -->
  <component :is="embedded ? 'div' : DashboardIndexPanel" v-bind="chrome">
    <template #right>
      <UButton v-if="!embedded && recordLevel.to.value" :to="recordLevel.to.value" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close booking details" />
    </template>
    <UAlert v-if="error" color="error" variant="soft" title="Booking details could not be loaded" :description="getErrorMessage(error, 'Booking request failed')" />
    <div v-else class="min-w-0 [overflow-wrap:anywhere]">
      <UAlert v-if="actionError" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <template v-if="booking">
        <div class="flex flex-col items-center pb-12 pt-10 text-center">
          <div v-if="!personalScope && !purchase && booking.guestName" class="relative mx-auto mb-6 shrink-0 md:mb-8" :class="booking.partySize && booking.partySize > 1 ? 'h-30 w-35 md:h-40 md:w-46' : 'size-27 md:size-36'">
            <UAvatar :src="booking.guestImageUrl || undefined" :alt="booking.guestName" :text="booking.guestName.slice(0, 1).toUpperCase()" size="3xl" class="absolute bottom-0 left-0" :class="booking.partySize && booking.partySize > 1 ? 'size-21 md:size-28' : 'size-27 md:size-36'" :ui="{ fallback: 'text-[30px] font-semibold text-highlighted md:text-4xl' }" />
            <span v-if="booking.partySize && booking.partySize > 1" class="absolute right-0 top-0 flex size-16 items-center justify-center rounded-full bg-elevated text-[9px] font-bold text-highlighted md:size-21 md:text-xs" :aria-label="otherGuestLabel">+{{ booking.partySize - 1 }}</span>
          </div>
          <h2 class="max-w-full break-words text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ personalScope || purchase ? booking.resourceTitle : partyTitle }}</h2>
          <p class="mt-4 break-words text-base text-muted">{{ purchase ? `${booking.type === 'order' ? 'Ordered' : 'Paid'} ${formattedDate}` : formattedDate }}</p>
          <p v-if="personalScope ? booking.organizationName : purchase ? booking.guestName : booking.resourceTitle" class="mt-1 break-words text-base text-muted">{{ personalScope ? booking.organizationName : purchase ? booking.guestName : booking.resourceTitle }}</p>
        </div>

        <div class="space-y-4">
          <UAlert
            v-if="booking.pendingChange"
            color="info"
            variant="soft"
            icon="i-lucide-clock"
            :title="personalScope ? `${booking.organizationName} requested a change` : 'Change requested'"
            :description="pendingChangeDescription"
            :actions="personalScope ? [
              { label: 'Accept', color: 'neutral' as const, loading: answering === 'accept', disabled: answering !== null, onClick: () => answerChange('accept') },
              { label: 'Decline', color: 'neutral' as const, variant: 'soft' as const, loading: answering === 'decline', disabled: answering !== null, onClick: () => answerChange('decline') },
            ] : undefined"
          />

          <UCard v-if="!purchase" variant="record">
            <div class="grid grid-cols-2 divide-x divide-default">
              <div class="min-w-0 pe-6">
                <h3 class="text-base font-semibold text-highlighted">Date</h3>
                <p class="mt-1 text-sm text-muted">{{ formattedDate }}</p>
              </div>
              <div class="min-w-0 ps-6 text-right">
                <h3 class="text-base font-semibold text-highlighted">Time</h3>
                <p class="mt-1 text-sm text-muted">{{ formattedTime }}</p>
              </div>
            </div>
          </UCard>

          <template v-if="booking.type === 'booking' && !personalScope">
            <UCard variant="record">
              <component :is="canReassignBooking ? NuxtLink : 'div'" :to="canReassignBooking ? { path: `${editorPath}/team-member`, query: route.query } : undefined" class="flex items-center gap-4">
                <span class="min-w-0 flex-1"><span class="block text-base font-semibold text-highlighted">{{ recordCopy?.assigneeLabel }}</span><span class="mt-1 block text-sm text-muted">{{ booking.assignedMemberName || (booking.assignedMemberId ? 'Previously assigned member' : booking.organizationName) }}</span></span>
                <UIcon v-if="canReassignBooking" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </component>
            </UCard>
            <UAlert v-if="booking.providerConflict" color="warning" :description="`This ${noun} overlaps a busy time. Contact your ${recordCopy?.guestLabel} to change it.`" />
            <UAlert v-if="booking.providerCalendarStatus" color="warning" :description="booking.providerCalendarStatus" />
          </template>

          <UCard v-if="!personalScope && !purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Your notes</h3>
            <div v-if="booking.notes.length" class="mt-4 divide-y divide-default">
              <NuxtLink v-for="note in booking.notes" :key="note.id" :to="{ path: `${editorPath}/notes/${note.id}`, query: route.query }" class="block py-3 first:pt-0" :aria-label="`Edit note: ${note.body}`">
                <span class="block whitespace-pre-wrap text-sm text-highlighted">{{ note.body }}</span>
                <span class="mt-1 block text-xs text-dimmed">{{ formatCreatedAt(note.createdAt) }}</span>
              </NuxtLink>
            </div>
            <div v-if="!selectedNote" class="group mt-4">
              <div class="flex items-center gap-3">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden="true"><UIcon name="i-lucide-circle-plus" class="size-5" /></span>
                <UTextarea v-model="noteDraft" aria-label="Add a note to yourself" placeholder="Add a note to yourself" variant="none" :rows="1" autoresize maxlength="2000" :disabled="noteSaving" class="min-w-0 flex-1" @blur="saveNewNote" />
              </div>
              <p class="mt-2 hidden text-right text-xs text-muted group-focus-within:block">{{ 2000 - noteDraft.length }} characters available</p>
              <UAlert v-if="noteError" class="mt-3" color="error" variant="soft" :description="noteError" :actions="[{ label: 'Retry', color: 'neutral' as const, loading: noteSaving, onClick: saveNewNote }]" />
            </div>
          </UCard>

          <UCard v-if="personalScope && !purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Who’s coming</h3>
            <p class="mt-1 text-sm text-muted">{{ guestCountLabel }}</p>
          </UCard>
          <UCard v-else-if="!personalScope && booking.guestName" variant="record">
            <component :is="purchase ? 'div' : NuxtLink" :to="purchase ? undefined : { path: `${editorPath}/guest`, query: route.query }" class="block" :aria-label="`${purchase ? 'Buyer' : guestHeading} ${booking.guestName}${purchase ? '' : ` · ${guestCountLabel}`}`">
              <h3 class="text-base font-semibold text-highlighted">{{ purchase ? 'Buyer' : guestHeading }}</h3>
              <div class="mt-4 flex items-center gap-4">
                <UAvatar :src="booking.guestImageUrl || undefined" :alt="booking.guestName" :text="booking.guestName.slice(0, 1).toUpperCase()" size="xl" class="size-12 bg-muted" aria-hidden="true" />
                <span class="min-w-0 flex-1 text-base text-highlighted">{{ booking.guestName }}</span>
                <UIcon v-if="!purchase" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </div>
              <div v-if="!purchase && booking.partySize && booking.partySize > 1" class="mt-4 flex items-center gap-4">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden="true">+{{ booking.partySize - 1 }}</span>
                <span class="text-base text-highlighted">{{ otherGuestLabel }}</span>
              </div>
            </component>
          </UCard>

          <!-- The guest did not come, or where the visit's review invitation stands: the team's own record of it. -->
          <UCard v-if="!personalScope && (booking.noShowAt || booking.reviewInvitation)" variant="record" data-testid="booking-review-state">
            <h3 class="text-base font-semibold text-highlighted">{{ booking.noShowAt ? 'No-show' : 'Review invitation' }}</h3>
            <p class="mt-1 text-sm text-muted">{{ reviewStateLabel }}</p>
          </UCard>

          <UCard v-if="booking.requests" variant="record">
            <h3 class="text-base font-semibold text-highlighted">{{ personalScope ? 'Your requests' : `${recordCopy?.guestLabel.charAt(0).toUpperCase()}${recordCopy?.guestLabel.slice(1)} requests` }}</h3>
            <p class="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">{{ booking.requests }}</p>
          </UCard>

          <UCard v-if="!purchase" as="button" type="button" variant="record" class="w-full text-left" @click="policyOpen = true">
            <span class="flex items-center gap-4">
              <span class="min-w-0 flex-1"><span class="block text-base font-semibold text-highlighted">Cancellation policy</span><span class="mt-1 block text-sm text-muted">{{ cancellationSummary }}</span></span>
              <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
            </span>
          </UCard>

          <PaymentDetails v-for="detail in booking.payments" :key="detail.payment.id" :payment="detail.payment" :refunds="detail.refunds" :order="detail.order">
            <template v-if="!personalScope && detail.payment.captured_amount > detail.payment.refunded_amount" #actions>
              <NuxtLink :to="{ path: `${editorPath}/refund`, query: { ...route.query, payment: detail.payment.id } }" class="flex items-center gap-4 border-t border-default py-4">
                <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
                <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </NuxtLink>
            </template>
          </PaymentDetails>

          <UCard v-if="!purchase || availableActions.length" as="button" type="button" variant="record" class="w-full text-left" @click="manageOpen = true">
            <span class="flex items-center gap-4"><span class="min-w-0 flex-1 text-base font-semibold text-highlighted">Manage {{ noun }}</span><UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" /></span>
          </UCard>
          <UCard variant="record">
            <p class="text-base font-semibold text-highlighted">{{ purchase ? 'Purchase date' : 'Booking date' }}</p>
            <p class="mt-1 text-sm text-muted">{{ formatCreatedAt(booking.createdAt) }}</p>
          </UCard>
        </div>
        <div v-if="embedded && (messageTo || contactCallTo)" class="mt-8 flex flex-wrap justify-center gap-3">
          <UButton v-if="messageTo" :to="messageTo" label="Message" :aria-label="personalScope ? 'Message' : `Message ${recordCopy?.guestLabel}`" color="neutral" class="h-14 rounded-full px-8 shadow-lg" />
          <UButton v-if="contactCallTo" :to="contactCallTo" label="Call" color="neutral" class="h-14 rounded-full px-8 shadow-lg" />
        </div>
      </template>
    </div>
    <template v-if="!embedded && booking && (messageTo || contactCallTo)" #footer>
      <div class="flex flex-wrap justify-center gap-3">
        <UButton v-if="messageTo" :to="messageTo" label="Message" :aria-label="personalScope ? 'Message' : `Message ${recordCopy?.guestLabel}`" color="neutral" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" />
        <UButton v-if="contactCallTo" :to="contactCallTo" label="Call" color="neutral" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" />
      </div>
    </template>
  </component>

  <DashboardListItemDialog v-model:open="manageOpen" :title="`Manage ${noun}`" :show-actions="false" :error="actionError">
    <div v-if="booking" class="divide-y divide-default">
      <NuxtLink v-if="canChangeBooking && !personalScope" :to="{ path: `${editorPath}/change`, query: route.query }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false; beginChange()"><span>Change {{ noun }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="personalScope && canChangeBooking && messageTo" :to="{ path: messageTo, query: { intent: 'booking-change' } }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('booking.request_change') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="!purchase" :to="{ path: personalScope ? `/dashboard/account/calendar/${booking.bookingDate}` : `/dashboard/${orgSlug}/calendar/${booking.bookingDate}`, query: !personalScope && booking.locationId ? { locationId: booking.locationId } : undefined }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>View on calendar</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <UButton v-for="action in availableActions" :key="action.value" :label="action.label" :icon="action.icon" :color="action.color" variant="ghost" block class="justify-start py-4" :loading="pendingAction === action.value" @click="selectAction(action.value)" />
    </div>
  </DashboardListItemDialog>
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
  <DashboardListItemDialog v-model:open="noShowOpen" title="Mark as a no-show" :show-actions="false" :error="actionError">
    <div v-if="booking" class="space-y-5">
      <p class="text-sm leading-relaxed text-muted">{{ firstName(booking.guestName ?? '') }} won’t be asked to review this {{ noun }}, and a review link already sent stops working. The {{ noun }} itself stays as it is. This cannot be undone.</p>
      <div class="flex items-center justify-between gap-4 pt-1">
        <UButton label="Keep as is" color="neutral" variant="ghost" @click="noShowOpen = false" />
        <UButton label="Mark as a no-show" color="error" :loading="pendingAction === 'no_show'" @click="runAction('no_show')" />
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
  canReassignBooking: ComputedRef<boolean>
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
import { getVerticalCopy } from '~/utils/vertical-copy'

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
const recordLevel = useRouteLevel()
const route = useRoute()

type ActionColor = 'success' | 'error' | 'neutral'

const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const realtime = useDashboardInvalidations()
const actionError = ref<string | null>(null)
const editorPath = computed(() => props.editorPath)
// Owning the column means owning its header; inside the thread's leaf it is that leaf's body.
const chrome = computed(() => (props.embedded
  ? {}
  : { id: props.personalScope ? 'account-booking-details' : 'booking-details', title: pageTitle.value, column: 'record' as const }))
/** Which note a leaf is editing, or none for a new one. */
const openNoteId = ref<string | null>(null)
const selectedNote = computed(() => booking.value?.notes.find(note => note.id === openNoteId.value))

const { resource, booking, error, presentation, noun, pageTitle, orgSlug, purchase, refresh: refreshDetails } = await useBookingDetails(props.bookingType, props.bookingId, props.personalScope)
watchEffect(() => {
  if (error.value && !booking.value) showError(error.value)
})

const formattedDate = computed(() => booking.value ? formatCalendarDate(booking.value.bookingDate, 'en') : '')
const formattedTime = computed(() => {
  if (!booking.value?.bookingTime) return ''
  return formatTime(booking.value.bookingTime, 'en')
})
// Airbnb's host-side stay page titles the party, not the listing: "Chris's
// group of 2". A single guest is just their name.
const partyTitle = computed(() => {
  if (!booking.value) return ''
  const size = booking.value.partySize ?? 0
  const name = firstName(booking.value.guestName ?? '')
  return size > 1 ? `${name}’s group of ${size}` : name
})
const recordCopy = computed(() => booking.value ? getVerticalCopy(booking.value.vertical) : null)
const guestHeading = computed(() => {
  const label = recordCopy.value?.guestsLabelPlural ?? ''
  return label.charAt(0).toUpperCase() + label.slice(1)
})
const guestCountLabel = computed(() => `${booking.value?.partySize ?? 0} ${booking.value?.partySize === 1 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}`)
const otherGuestLabel = computed(() => `${(booking.value?.partySize ?? 0) - 1} other ${booking.value?.partySize === 2 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}`)
const cancellationSummary = computed(() => booking.value?.policy?.items.find(item => item.id === 'cancellation')?.text
  ?? (booking.value?.policy?.additional_notes_html ? htmlToPlainText(booking.value.policy.additional_notes_html) : 'No cancellation terms have been configured.'))
const messageTo = computed(() => {
  if (!booking.value?.threadId) return null
  return `/dashboard/${orgSlug.value}/messages/${encodeURIComponent(booking.value.threadId)}`
})
const canChangeBooking = computed(() => Boolean(booking.value && !booking.value.complete && ['pending', 'confirmed'].includes(booking.value.status)))
const canReassignBooking = computed(() => !props.personalScope && props.bookingType === 'booking' && canChangeBooking.value && booking.value?.canReassignProvider === true)
const callTo = computed(() => booking.value?.guestPhone ? `tel:${booking.value.guestPhone}` : null)
const contactCallTo = computed(() => props.personalScope ? booking.value?.contactPhone ? `tel:${booking.value.contactPhone}` : null : callTo.value)

const policyOpen = ref(false)
const { t } = useI18n()
const manageOpen = ref(false)
const session = authClient.useSession()
// The buyer's answer to a change, on the record itself; the email link records the same decision.
const answering = ref<'accept' | 'decline' | null>(null)
const pendingChangeDescription = computed(() => {
  const change = booking.value?.pendingChange
  if (!change) return ''
  const details = [`${change.beforeLabel} → ${change.afterLabel}`]
  if (booking.value?.type === 'booking') details.push(`${change.beforeAssignedMemberName ?? 'Unassigned'} → ${change.afterAssignedMemberName ?? 'Unassigned'}`)
  details.push(`${change.partySize} ${change.partySize === 1 ? 'guest' : 'guests'}`)
  details.push(props.personalScope ? 'Your appointment stays unchanged until you accept.' : `Waiting for ${firstName(booking.value?.guestName ?? '')} to respond`)
  return details.join(' · ')
})
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
    await refreshNuxtData(`account-guest-thread:${session.value.data?.user.id}:${booking.value?.threadId}`)
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Your answer could not be saved')
    await refreshDetails()
  } finally {
    answering.value = null
  }
}
const cancelOpen = ref(false)
const noShowOpen = ref(false)
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
      { key: 'guests', label: guestHeading.value, summary: `${changeDraft.value.partySize} ${changeDraft.value.partySize === 1 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}` },
    ]
  : [
      { key: 'session', label: 'Date and time', summary: changeDraft.value.sessionLabel || (booking.value?.bookingDate ? `${formatCalendarDate(booking.value.bookingDate, 'en')}${booking.value.bookingTime ? ` · ${formatTime(booking.value.bookingTime, 'en')}` : ''}` : 'Choose a time') },
      { key: 'guests', label: guestHeading.value, summary: `${changeDraft.value.partySize} ${changeDraft.value.partySize === 1 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}` },
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
  const noShow = booking.value.canMarkNoShow ? [{ value: 'no_show', label: 'Mark as a no-show', icon: 'i-lucide-user-x', color: 'neutral' as const }] : []
  if (booking.value.complete) return noShow
  if (booking.value.type === 'booking' && booking.value.status === 'pending') return [
    { value: 'confirm', label: `Confirm ${presentation.value.noun}`, icon: 'i-lucide-calendar-check', color: 'success' as const },
    { value: 'reject', label: `Decline ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const },
  ]
  if (booking.value.status !== 'confirmed') return []
  return [{ value: 'cancel', label: `Cancel ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const }, ...noShow]
})

const REVIEW_INVITATION_LABELS = { sent: 'Sent', submitted: 'Answered', revoked: 'Withdrawn', expired: 'Expired' } as const
const reviewStateLabel = computed(() => {
  const record = booking.value
  if (!record) return ''
  if (record.noShowAt) return `Recorded ${formatCreatedAt(record.noShowAt)}. No review invitation is sent.`
  const invitation = record.reviewInvitation
  return invitation ? `${REVIEW_INVITATION_LABELS[invitation.state]} ${formatCreatedAt(invitation.at)}` : ''
})

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
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

// A blur save and the navigation it caused share one write. Failed text stays
// visible on the record rather than being replaced by the next note's draft.
let pendingNewNote: Promise<boolean> | null = null
function saveNewNote(): Promise<boolean> {
  if (pendingNewNote) return pendingNewNote
  if (selectedNote.value || !noteDraft.value.trim()) return Promise.resolve(true)
  pendingNewNote = saveNote().then((saved) => {
    if (saved) openNote(null)
    return saved
  }).finally(() => { pendingNewNote = null })
  return pendingNewNote
}
function saveBeforeNavigation() {
  return selectedNote.value ? !noteSaving.value : saveNewNote()
}
onBeforeRouteUpdate(saveBeforeNavigation)
onBeforeRouteLeave(saveBeforeNavigation)

function selectAction(action: string) {
  if (action === 'cancel' && !booking.value?.guestCanRetryCancellation) {
    manageOpen.value = false
    openCancel()
  } else if (action === 'no_show') {
    manageOpen.value = false
    actionError.value = null
    noShowOpen.value = true
  } else void runAction(action)
}

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
    await navigateTo({ path: editorPath.value, query: route.query })
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
    noShowOpen.value = false
    manageOpen.value = false
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
  canReassignBooking,
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
