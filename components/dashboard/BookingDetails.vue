<template>
  <DashboardIndexPanel :id="personalScope ? 'account-booking-details' : 'booking-details'" :title="pageTitle" column="record">
    <template #right>
      <UButton v-if="recordLevel.to.value" :to="recordLevel.to.value" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close booking details" />
    </template>
    <UAlert v-if="error" color="error" variant="soft" title="Booking details could not be loaded" :description="getErrorMessage(error, 'Booking request failed')" />
    <div v-else class="min-w-0 [overflow-wrap:anywhere]">
      <UAlert v-if="actionError" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <template v-if="booking">
        <div class="flex flex-col items-center pb-12 text-center" :class="booking.resource_image_url ? 'pt-2' : 'pt-10'">
          <img v-if="booking.resource_image_url" :src="booking.resource_image_url" alt="" class="aspect-square w-full max-w-80 rounded-2xl bg-elevated object-cover" :class="!personalScope && !purchase && booking.guest_name ? '' : 'mb-6'">
          <div v-if="!personalScope && !purchase && booking.guest_name" class="relative mx-auto mb-6 shrink-0 md:mb-8" :class="[booking.resource_image_url ? '-mt-12 md:-mt-14' : '', booking.party_size && booking.party_size > 1 ? 'h-30 w-35 md:h-40 md:w-46' : 'size-27 md:size-36']">
            <UAvatar :src="booking.guest_image_url || undefined" :alt="booking.guest_name" :text="booking.guest_name.slice(0, 1).toUpperCase()" size="3xl" class="absolute bottom-0 left-0" :class="booking.party_size && booking.party_size > 1 ? 'size-21 md:size-28' : 'size-27 md:size-36'" :ui="{ fallback: 'text-[30px] font-semibold text-highlighted md:text-4xl' }" />
            <span v-if="booking.party_size && booking.party_size > 1" class="absolute right-0 top-0 flex size-16 items-center justify-center rounded-full bg-elevated text-[9px] font-bold text-highlighted md:size-21 md:text-xs" :aria-label="otherGuestLabel">+{{ booking.party_size - 1 }}</span>
          </div>
          <h2 class="max-w-full break-words text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ personalScope || purchase ? offeringName : partyTitle }}</h2>
          <p v-if="purchase || personalScope" class="mt-4 break-words text-base text-muted">{{ purchase ? `${booking.type === 'order' ? 'Ordered' : 'Paid'} ${formattedDate}` : formattedDate }}</p>
          <p v-if="personalScope ? booking.organization_name : purchase ? booking.guest_name : offeringName" class="mt-1 break-words text-base text-muted">{{ personalScope ? booking.organization_name : purchase ? booking.guest_name : offeringName }}</p>
        </div>

        <div class="space-y-4">
          <p v-if="changeResult" class="text-sm text-highlighted" role="status">{{ changeResult }}</p>
          <UAlert
            v-if="booking.pending_change"
            data-testid="booking-change-request"
            color="info"
            variant="soft"
            icon="i-lucide-clock"
            :title="personalScope ? `${booking.organization_name} requested a change` : 'Change requested'"
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

          <UCard v-if="!purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Where</h3>
            <p class="mt-1 text-sm text-muted">{{ booking.location_title }}</p>
            <p v-if="booking.location_address" class="mt-1 text-sm text-muted">{{ booking.location_address }}</p>
          </UCard>

          <UCard v-if="booking.type === 'booking' && !personalScope" variant="record">
            <h3 class="text-base font-semibold text-highlighted">What’s booked</h3>
            <p class="mt-1 text-sm text-muted">{{ offeringName }}<template v-if="booking.party_size"> · {{ guestCountLabel }}</template></p>
          </UCard>

          <template v-if="booking.type === 'booking' && !personalScope">
            <UCard variant="record">
              <div class="flex items-center gap-4">
                <span class="min-w-0 flex-1"><span class="block text-base font-semibold text-highlighted">{{ recordCopy?.assigneeLabel }}</span><span class="mt-1 block text-sm text-muted">{{ booking.assigned_member_name || (booking.assigned_member_id ? 'Previously assigned member' : booking.organization_name) }}</span></span>
              </div>
            </UCard>
            <UAlert v-if="booking.provider_conflict" color="warning" :description="`This ${noun} overlaps a busy time. Contact your ${recordCopy?.guestLabel} to change it.`" />
          </template>

          <UCard v-if="!personalScope && !purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Private note</h3>
            <p class="mt-1 text-sm text-muted">Only your team sees this.</p>
            <div class="group mt-4">
              <UTextarea v-model="noteDraft" aria-label="Private note" placeholder="Add a note for your team" :rows="2" autoresize maxlength="2000" :disabled="noteSaving" class="w-full" @blur="saveNote" />
              <p class="mt-2 hidden text-right text-xs text-muted group-focus-within:block">{{ 2000 - noteDraft.length }} characters available</p>
              <UAlert v-if="noteError" class="mt-3" color="error" variant="soft" :description="noteError" :actions="[{ label: 'Retry', color: 'neutral' as const, loading: noteSaving, onClick: saveNote }]" />
            </div>
          </UCard>

          <UCard v-if="personalScope && !purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Who’s coming</h3>
            <p class="mt-1 text-sm text-muted">{{ guestCountLabel }}</p>
          </UCard>
          <UCard v-else-if="!personalScope && booking.guest_name" variant="record">
            <component :is="purchase ? 'div' : NuxtLink" :to="purchase ? undefined : { path: `${editorPath}/guest`, query: route.query }" class="block" :aria-label="`${purchase ? 'Buyer' : guestHeading} ${booking.guest_name}${purchase ? '' : ` · ${guestCountLabel}`}`">
              <h3 class="text-base font-semibold text-highlighted">{{ purchase ? 'Buyer' : guestHeading }}</h3>
              <div class="mt-4 flex items-center gap-4">
                <UAvatar :src="booking.guest_image_url || undefined" :alt="booking.guest_name" :text="booking.guest_name.slice(0, 1).toUpperCase()" size="xl" class="size-12 bg-muted" aria-hidden="true" />
                <span class="min-w-0 flex-1 text-base text-highlighted">{{ booking.guest_name }}</span>
                <UIcon v-if="!purchase" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </div>
              <div v-if="!purchase && booking.party_size && booking.party_size > 1" class="mt-4 flex items-center gap-4">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden="true">+{{ booking.party_size - 1 }}</span>
                <span class="text-base text-highlighted">{{ otherGuestLabel }}</span>
              </div>
            </component>
          </UCard>

          <!-- The guest did not come, or where the visit's review invitation stands: the team's own record of it. -->
          <UCard v-if="!personalScope && (booking.no_show_at || booking.review_invitation)" variant="record" data-testid="booking-review-state">
            <h3 class="text-base font-semibold text-highlighted">{{ booking.no_show_at ? 'No-show' : 'Review invitation' }}</h3>
            <p class="mt-1 text-sm text-muted">{{ reviewStateLabel }}</p>
          </UCard>

          <FormAnswersCard :answers="booking.answers" :title="personalScope ? 'Your answers' : undefined" />
          <UCard v-if="booking.notes" variant="record">
            <h3 class="text-base font-semibold text-highlighted">{{ personalScope ? 'Your requests' : `${recordCopy?.guestLabel.charAt(0).toUpperCase()}${recordCopy?.guestLabel.slice(1)} requests` }}</h3>
            <p class="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">{{ booking.notes }}</p>
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
            <p class="mt-1 text-sm text-muted">{{ formatCreatedAt(booking.created_at) }}</p>
          </UCard>
        </div>
      </template>
    </div>
    <template v-if="booking && (messageTo || contactCallTo)" #footer>
      <div class="flex flex-wrap justify-center gap-3">
        <UButton v-if="messageTo" :to="messageTo" label="Message" :aria-label="personalScope ? 'Message' : `Message ${recordCopy?.guestLabel}`" color="neutral" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" />
        <UButton v-if="contactCallTo" :to="contactCallTo" label="Call" color="neutral" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" />
      </div>
    </template>
  </DashboardIndexPanel>

  <DashboardListItemDialog v-model:open="manageOpen" :title="`Manage ${noun}`" :show-actions="false" :error="actionError">
    <div v-if="booking" class="divide-y divide-default">
      <NuxtLink v-if="canChangeBooking && !personalScope" :to="{ path: `${editorPath}/change`, query: route.query }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>Change {{ noun }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="personalScope && canChangeBooking && messageTo" :to="{ path: messageTo, query: { intent: 'booking-change' } }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('booking.request_change') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="!purchase" :to="{ path: personalScope ? `/dashboard/account/calendar/${booking.booking_date}` : `/dashboard/${orgSlug}/calendar/${booking.booking_date}`, query: !personalScope && booking.location_id ? { locationId: booking.location_id } : undefined }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>View on calendar</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <UButton v-for="action in availableActions" :key="action.value" :label="action.label" :icon="action.icon" :color="action.color" variant="ghost" block class="justify-start py-4" :loading="pendingAction === action.value" @click="selectAction(action.value)" />
    </div>
  </DashboardListItemDialog>
  <DashboardListItemDialog v-model:open="policyOpen" :title="booking?.policy?.heading || 'Cancellation policy'" :show-actions="false">
    <div v-if="booking" class="space-y-4">
      <div class="space-y-3">
        <div v-for="item in booking.policy!.items" :key="item.id" class="flex gap-3">
          <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-success" />
          <p class="text-sm leading-relaxed text-muted">{{ item.text }}</p>
        </div>
      </div>
    </div>
  </DashboardListItemDialog>
  <DashboardListItemDialog v-model:open="noShowOpen" title="Mark as a no-show" :show-actions="false" :error="actionError">
    <div v-if="booking" class="space-y-5">
      <p class="text-sm leading-relaxed text-muted">{{ firstName(booking.guest_name ?? '') }} won’t be asked to review this {{ noun }}, and a review link already sent stops working. The {{ noun }} itself stays as it is. This cannot be undone.</p>
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
      <UFormField v-if="!personalScope" :label="`Add a note for ${firstName(booking.guest_name ?? '')}`" hint="Optional">
        <UTextarea v-model="cancelNote" :rows="4" maxlength="500" class="w-full" placeholder="Let them know why, and what happens next." />
      </UFormField>
      <p v-if="personalScope" class="text-sm text-muted">
        {{ booking.organization_name }} is told the {{ noun }} was cancelled.
        <template v-if="refundable && booking.guest_cancel_refunds">Your payment is refunded in full.</template>
        <template v-else-if="refundable">Free cancellation has closed, so your payment won’t be refunded.</template>
        This cannot be undone.
      </p>
      <p v-else class="text-sm text-muted">
        {{ firstName(booking.guest_name ?? '') }} is told the {{ noun }} was cancelled{{ cancelNote.trim() ? ', with your note' : '' }}.
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

/** The record its levels edit; the change request keeps its own draft. */
export interface BookingEditor {
  bookingType: DashboardRecordType
  refresh: () => Promise<void>
  booking: Ref<DashboardBookingDetails | null>
  noun: ComputedRef<string>
  messageTo: ComputedRef<string | null>
  callTo: ComputedRef<string | null>
  firstName: (name: string) => string
  formatCreatedAt: (value: string) => string
}

export const bookingEditorKey = Symbol('booking-editor') as InjectionKey<BookingEditor>
</script>

<script setup lang="ts">
import FormAnswersCard from '~/components/forms/FormAnswersCard.vue'
import PaymentDetails from '~/components/dashboard/PaymentDetails.vue'
import { paymentMoney } from '~/shared/payment-display'
import { authClient } from '~/lib/auth-client'
import { NuxtLink } from '#components'
import { formatCalendarDate, formatTime, formatTimestamp } from '~/utils/timezone'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import { getErrorMessage } from '~/utils/errors'
import { getVerticalCopy } from '~/utils/vertical-copy'

const props = defineProps<{
  bookingType: DashboardRecordType
  bookingId: string
  /** The record's canonical URL, which the rows that change it link into. */
  editorPath: string
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
const { resource, booking, error, presentation, noun, pageTitle, orgSlug, purchase, refresh: refreshDetails } = await useBookingDetails(props.bookingType, props.bookingId, props.personalScope)
watchEffect(() => {
  if (error.value && !booking.value) showError(error.value)
})

const formattedDate = computed(() => booking.value ? formatCalendarDate(booking.value.booking_date, 'en') : '')
const formattedTime = computed(() => {
  if (!booking.value?.booking_time) return ''
  const start = formatTime(booking.value.booking_time, 'en')
  const { booking_date: bookingDate, booking_end_date: bookingEndDate, booking_end_time: bookingEndTime } = booking.value
  if (!bookingEndTime) return start
  // A visit past midnight says which day it ends.
  const endDay = bookingEndDate && bookingEndDate !== bookingDate
    ? `${formatCalendarDate(bookingEndDate, 'en', { month: 'short', day: 'numeric', ...(bookingEndDate.slice(0, 4) !== bookingDate.slice(0, 4) ? { year: 'numeric' } : {}) })}, `
    : ''
  return `${start} – ${endDay}${formatTime(bookingEndTime, 'en')}`
})
// Airbnb's host-side stay page titles the party, not the listing: "Chris's
// group of 2". A single guest is just their name.
const partyTitle = computed(() => {
  if (!booking.value) return ''
  const size = booking.value.party_size ?? 0
  const name = firstName(booking.value.guest_name ?? '')
  return size > 1 ? `${name}’s group of ${size}` : name
})
const recordCopy = computed(() => booking.value ? getVerticalCopy(booking.value.vertical) : null)
const guestHeading = computed(() => {
  const label = recordCopy.value?.guestsLabelPlural ?? ''
  return label.charAt(0).toUpperCase() + label.slice(1)
})
const offeringName = computed(() => booking.value?.product_kind === 'table' ? booking.value.location_title : booking.value?.name ?? '')
const guestCountLabel = computed(() => `${booking.value?.party_size ?? 0} ${booking.value?.party_size === 1 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}`)
const otherGuestLabel = computed(() => `${(booking.value?.party_size ?? 0) - 1} other ${booking.value?.party_size === 2 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}`)
const cancellationSummary = computed(() => booking.value?.policy?.items.find(item => item.id === 'cancellation')?.text)
const messageTo = computed(() => {
  if (!booking.value?.conversation_id) return null
  return `/dashboard/${orgSlug.value}/messages/${encodeURIComponent(booking.value.conversation_id)}`
})
const canChangeBooking = computed(() => Boolean(booking.value && !booking.value.complete && ['pending', 'confirmed'].includes(booking.value.status)))
const callTo = computed(() => booking.value?.guest_phone ? `tel:${booking.value.guest_phone}` : null)
const contactCallTo = computed(() => props.personalScope ? booking.value?.contact_phone ? `tel:${booking.value.contact_phone}` : null : callTo.value)

const policyOpen = ref(false)
const { t } = useI18n()
const manageOpen = ref(false)
const session = authClient.useSession()
// The buyer's answer to a change, on the record itself; the email link records the same decision.
const answering = ref<'accept' | 'decline' | null>(null)
const changeResult = ref<string | null>(null)
const pendingChangeDescription = computed(() => {
  const change = booking.value?.pending_change
  if (!change) return ''
  const details = [`${change.before_label} → ${change.after_label}`]
  if (booking.value?.type === 'booking') details.push(`${change.before_assigned_member_name ?? 'Unassigned'} → ${change.after_assigned_member_name ?? 'Unassigned'}`)
  details.push(`${change.party_size} ${change.party_size === 1 ? 'guest' : 'guests'}`)
  details.push(props.personalScope ? 'Your appointment stays unchanged until you accept.' : `Waiting for ${firstName(booking.value?.guest_name ?? '')} to respond`)
  return details.join(' · ')
})
async function answerChange(decision: 'accept' | 'decline') {
  const change = booking.value?.pending_change
  if (!change || !booking.value?.conversation_id || answering.value) return
  answering.value = decision
  actionError.value = null
  changeResult.value = null
  try {
    await applicationFetch(`/api/public/booking-changes/${encodeURIComponent(booking.value.conversation_id)}/${encodeURIComponent(change.message_id)}`, {
      method: 'POST',
      body: { decision },
      validate: (value): value is { status: 'accepted' | 'declined' } => isRecord(value) && value.status === (decision === 'accept' ? 'accepted' : 'declined'),
    })
    await refreshDetails()
    if (error.value) throw error.value
    changeResult.value = decision === 'accept' ? t('booking.change_accepted') : t('booking.change_declined')
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Your answer could not be saved')
    if (!error.value) await refreshDetails()
  } finally {
    answering.value = null
  }
}
const cancelOpen = ref(false)
const noShowOpen = ref(false)
const cancelNote = ref('')
// What a cancellation gives back: everything still captured, as Airbnb's host cancellation does.
const refundable = computed(() => (booking.value?.payments ?? []).reduce((sum, entry) => sum + entry.payment.captured_amount - entry.payment.refunded_amount, 0))
const pendingAction = ref<string | null>(null)
const actionAttempt = ref<{ draft: string; key: string } | null>(null)
// The team's one private note on the booking, saved as a whole when the field is left.
const noteDraft = ref('')
const noteSaving = ref(false)
const noteError = ref<string | null>(null)
watch(() => booking.value?.private_notes, (saved) => { if (!noteSaving.value) noteDraft.value = saved ?? '' }, { immediate: true })

// Nothing to approve and nothing to mark done: a booking arrives confirmed and
// is complete once its end passes. Cancelling is the one thing left to decide,
// and changing it is the link above.
const availableActions = computed<Array<{ value: string; label: string; icon: string; color: ActionColor }>>(() => {
  if (!booking.value || !presentation.value || !booking.value.conversation_id) return []
  if (props.personalScope && booking.value.guest_can_retry_cancellation) return [
    { value: 'cancel', label: 'Retry deposit refund', icon: 'i-lucide-refresh-cw', color: 'neutral' as const },
  ]
  // The account's one decision is its own cancellation, on the public cancel rule the server already answered.
  if (props.personalScope) return booking.value.guest_can_cancel
    ? [{ value: 'cancel', label: `Cancel ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const }]
    : []
  const noShow = booking.value.can_mark_no_show ? [{ value: 'no_show', label: 'Mark as a no-show', icon: 'i-lucide-user-x', color: 'neutral' as const }] : []
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
  if (record.no_show_at) return `Recorded ${formatCreatedAt(record.no_show_at)}. No review invitation is sent.`
  const invitation = record.review_invitation
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
  if (!event || (event.type !== 'MESSAGE_CREATE' && event.type !== 'MESSAGE_UPDATE') || event.scheduled) return
  if (event.conversation_id === booking.value?.conversation_id) void refreshDetails()
})
watch(realtime.connectionEpoch, (epoch) => {
  if (epoch > 0) void refreshDetails()
})

// A blur save and the navigation it caused share one write. Failed text stays
// visible on the record.
let pendingNote: Promise<boolean> | null = null
function saveNote(): Promise<boolean> {
  if (pendingNote) return pendingNote
  const current = booking.value
  if (!current || noteDraft.value.trim() === (current.private_notes ?? '')) return Promise.resolve(true)
  pendingNote = writeNote(current).finally(() => { pendingNote = null })
  return pendingNote
}
onBeforeRouteUpdate(saveNote)
onBeforeRouteLeave(saveNote)

function selectAction(action: string) {
  if (action === 'cancel' && !booking.value?.guest_can_retry_cancellation) {
    manageOpen.value = false
    openCancel()
  } else if (action === 'no_show') {
    manageOpen.value = false
    actionError.value = null
    noShowOpen.value = true
  } else void runAction(action)
}

async function writeNote(current: DashboardBookingDetails) {
  noteSaving.value = true
  noteError.value = null
  try {
    const response = await dashboardApi<{ booking: DashboardBookingDetails }>(
      dashboardBookingPath(props.bookingId),
      {
        method: 'PATCH',
        // Guarded by the booking as it was read: an edit since then is not overwritten.
        body: { private_notes: noteDraft.value, version: current.version },
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

async function runAction(action: string) {
  if (!booking.value?.conversation_id || pendingAction.value) return
  const note = action === 'cancel' ? cancelNote.value.trim() : ''
  const draft = JSON.stringify([booking.value.conversation_id, action, note])
  if (actionAttempt.value?.draft !== draft) actionAttempt.value = { draft, key: crypto.randomUUID() }
  pendingAction.value = action
  actionError.value = null
  try {
    if (props.personalScope) {
      await applicationFetch(`/api/account/bookings/${encodeURIComponent(booking.value.booking_id!)}/cancel`, {
        method: 'POST',
        body: { version: booking.value.version },
        validate: (value: unknown): value is { success: true } => isRecord(value) && value.success === true,
      })
      await refreshNuxtData(`account-activity:${session.value.data?.user.id}`)
    } else {
      await dashboardApi(`${dashboardBookingPath(props.bookingId)}/${action}`, {
        method: 'POST',
        body: { version: booking.value.version, idempotency_key: actionAttempt.value.key, ...(note ? { reason: note } : {}) },
        validate: isBookingDetailsResponse,
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
  noun,
  messageTo,
  callTo,
  firstName,
  formatCreatedAt,
})
</script>
