<template>
  <DashboardIndexPanel id="stay-details" :title="title" column="record">
    <template #right>
      <UButton v-if="recordLevel.to.value" :to="recordLevel.to.value" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close stay details" />
    </template>
    <UAlert v-if="error" color="error" variant="soft" title="This stay could not be loaded" :description="getErrorMessage(error, 'Stay request failed')" />
    <div v-else-if="stay" class="min-w-0 [overflow-wrap:anywhere]">
      <UAlert v-if="actionError" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <UAlert v-if="homeError" class="mb-5" color="error" variant="soft" title="The home could not be loaded" :description="getErrorMessage(homeError, 'Home request failed')" />
      <p v-if="changeResult" class="mb-5 text-sm text-highlighted" role="status">{{ changeResult }}</p>
      <section v-for="change in pendingChanges" :key="change.id" class="mb-5 rounded-2xl border border-default bg-elevated p-5" :aria-labelledby="`change-title-${change.id}`" data-testid="booking-change-request">
        <h3 :id="`change-title-${change.id}`" class="font-semibold text-highlighted">{{ t('booking.change_review') }}</h3>
        <p v-if="change.requested_by === 'guest'" class="mt-1 text-sm text-muted">{{ t('booking.change_requested_by_guest', { guest: detail?.guest_name, channel: 'Airbnb' }) }}</p>
        <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div v-for="{ label, terms } in [{ label: 'booking.change_before', terms: change.before }, { label: 'booking.change_proposed', terms: change.after }]" :key="label">
            <h4 class="font-medium text-highlighted">{{ t(label) }}</h4>
            <dl class="mt-2 space-y-2">
              <div><dt class="sr-only">Dates</dt><dd>{{ terms.dates }}</dd></div>
              <div><dt class="text-muted">{{ t('stay.guests') }}</dt><dd>{{ terms.guests }}</dd></div>
              <div><dt class="text-muted">{{ t('booking.change_total') }}</dt><dd>{{ terms.total }}</dd></div>
            </dl>
          </div>
        </div>
        <p class="mt-4 text-sm text-muted">{{ t(change.requested_by === 'guest' ? 'booking.change_guest_waiting' : 'booking.change_host_waiting', { channel: 'Airbnb' }) }}</p>
        <div v-if="change.requested_by === 'guest'" class="mt-4 flex flex-wrap gap-3">
          <UButton :label="t('booking.change_accept')" :loading="busy === `accept-${change.id}`" :disabled="busy !== null" @click="answerChange(change.id, 'accept')" />
          <UButton :label="t('booking.change_decline')" color="neutral" variant="outline" :loading="busy === `decline-${change.id}`" :disabled="busy !== null" @click="answerChange(change.id, 'decline')" />
        </div>
      </section>
      <!-- A channel stay overlapping another is the host's to resolve; it never resolves itself. -->
      <UAlert
        v-if="detail?.overbooked"
        class="mb-5"
        color="error"
        icon="i-lucide-triangle-alert"
        title="Overbooked"
        :description="`${channelName} confirmed this stay on nights another stay holds. Move this guest to another home, cancel this stay on ${channelName}, or cancel the other stay where it was booked.`"
      />
      <UAlert
        v-if="manage && detail?.booked_home_name"
        class="mb-5"
        color="info"
        variant="soft"
        icon="i-lucide-move-right"
        title="Moved"
        :description="`Booked as ${detail.booked_home_name} on ${channelName}. These nights are held on the home the guest moved to.`"
        :actions="[{ label: 'Undo move', color: 'neutral', variant: 'outline', loading: busy === 'undo_move', onClick: undoMove }]"
      />
      <UAlert v-if="!personalScope && guest.state === 'missing'" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" title="Guest name missing" description="This stay was made in KrabiClaw, which requires a guest name, but it has none." />
      <div class="flex flex-col items-center pb-12 text-center" :class="homeImageUrl ? 'pt-2' : 'pt-10'">
        <img v-if="homeImageUrl" :src="homeImageUrl" :alt="recordHome?.name ?? ''" class="mb-10 aspect-square w-full max-w-80 shrink-0 rounded-2xl object-cover">
        <div v-if="!personalScope && guest.state === 'named'" class="relative mb-6 shrink-0 md:mb-8" :class="guestCount > 1 ? 'h-30 w-35 md:h-40 md:w-46' : 'size-27 md:size-36'">
          <UAvatar :src="detail?.guest_image_url || undefined" :alt="guest.name" :text="guestFirstName?.slice(0, 1).toUpperCase()" size="3xl" class="absolute bottom-0 left-0" :class="guestCount > 1 ? 'size-21 md:size-28' : 'size-27 md:size-36'" :ui="{ fallback: 'text-[30px] font-semibold text-highlighted md:text-4xl' }" />
          <span v-if="guestCount > 1" class="absolute right-0 top-0 flex size-16 items-center justify-center rounded-full bg-elevated text-[9px] font-bold text-highlighted md:size-21 md:text-xs" :aria-label="`${guestCount - 1} other guests`">+{{ guestCount - 1 }}</span>
        </div>
        <h2 v-if="personalScope && home" class="max-w-full text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ home.name }}</h2>
        <h2 v-else-if="guest.state === 'named'" class="max-w-full text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ partyTitle }}</h2>
        <h2 v-else-if="guest.state === 'not-provided'" class="text-2xl font-semibold text-muted">Name not provided by {{ channelName }}</h2>
        <h2 v-else-if="guest.state === 'missing'" class="text-2xl font-semibold text-error">Guest name missing</h2>
        <h2 v-else-if="guest.state === 'unnamed'" class="text-2xl font-semibold text-muted">Guest</h2>
        <p v-if="personalScope && home" class="mt-1 text-base text-muted">{{ home.organization_name }}</p>
        <p class="mt-4 text-base text-muted">{{ stayDates }}</p>
        <p v-if="!personalScope && hostHome" class="mt-1 text-base text-muted">{{ hostHome.internal_name }}</p>
        <UBadge v-if="personalScope" class="mt-3" :color="stay.status === 'cancelled' ? 'neutral' : 'success'" variant="soft" :label="statusLabel" />
      </div>

      <div class="space-y-4">
      <UCard variant="record">
      <div class="grid grid-cols-2 divide-x divide-default">
        <div class="min-w-0 pe-6">
          <h3 class="text-base font-semibold text-highlighted">Check-in</h3>
          <p class="mt-1 text-sm text-muted">{{ formatCalendarDate(stay.check_in_date, 'en') }}</p>
          <p v-if="checkInTime" class="mt-1 text-sm text-muted">{{ checkInTime }}</p>
        </div>
        <div class="min-w-0 ps-6 text-right">
          <h3 class="text-base font-semibold text-highlighted">Checkout</h3>
          <p class="mt-1 text-sm text-muted">{{ formatCalendarDate(stay.check_out_date, 'en') }}</p>
          <p v-if="recordHome?.check_out_time" class="mt-1 text-sm text-muted">By {{ formatTime(recordHome.check_out_time, 'en') }}</p>
        </div>
      </div>
      <div v-if="arrivalTime" class="mt-6 border-t border-default pt-4">
        <p class="text-base font-medium text-highlighted">Arriving</p>
        <p class="mt-1 text-base text-muted">{{ arrivalTime }}</p>
      </div>
      <!-- A member's turnover says the guest never arrived; managers read it with the stay's payments below. -->
      <p v-if="!personalScope && !detail && stay.no_show_at" class="mt-6 border-t border-default pt-4 text-base text-muted" data-testid="stay-no-show">No-show recorded {{ formatCalendarDate(stay.no_show_at.slice(0, 10), 'en') }}.</p>
      </UCard>
      <UCard v-if="!personalScope && hostHome && (hostHome.check_in_method || hostHome.check_in_instructions)" variant="record">
        <h3 class="text-base font-semibold text-highlighted">{{ t('stay.check_in_method') }}</h3>
        <p v-if="hostHome.check_in_method" class="mt-3 text-base text-muted">{{ STAY_CHECK_IN_METHODS[hostHome.check_in_method].label }}</p>
        <p v-if="hostHome.check_in_instructions" class="mt-3 whitespace-pre-wrap text-base text-muted">{{ hostHome.check_in_instructions }}</p>
      </UCard>

      <UCard v-if="personalScope && home?.location && (guestAddress || home.location.maps_url)" variant="record">
        <h2 class="text-base font-semibold text-highlighted">{{ t('stay.where_youll_be') }}</h2>
        <p v-if="guestAddress" class="mt-3 whitespace-pre-line break-words text-base text-muted">{{ guestAddress }}</p>
        <UButton v-if="home.location.maps_url" :to="home.location.maps_url" target="_blank" rel="noopener noreferrer" class="mt-4" color="neutral" variant="outline" :label="t('site.experience_detail.open_in_maps')" />
      </UCard>

      <UCard v-if="personalScope && home?.arrival_guide" variant="record">
        <h2 class="mb-6 text-base font-semibold text-highlighted">{{ t('stay.arrival_guide') }}</h2>
        <StayArrivalGuideView :guide="home.arrival_guide" :rules="home.house_rules" :safety="home.safety" />
      </UCard>

      <UCard variant="record">
        <h3 class="text-base font-semibold text-highlighted">{{ personalScope ? 'Who’s coming' : 'Guests' }}</h3>
        <div v-if="guest.state === 'named'" class="mt-4 flex items-center gap-4">
          <UAvatar :src="detail?.guest_image_url || undefined" :alt="guest.name" :text="guestFirstName?.slice(0, 1).toUpperCase()" size="xl" class="size-12 bg-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 text-base text-highlighted">{{ guest.name }}</span>
        </div>
        <div v-if="guestCount > 1" class="mt-4 flex items-center gap-4">
          <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden="true">+{{ guestCount - 1 }}</span>
          <span class="text-base text-highlighted">{{ guestCount - 1 }} other {{ guestCount === 2 ? 'guest' : 'guests' }}</span>
        </div>
        <p class="mt-3 text-base text-muted">{{ partyLabel }}</p>
        <a v-if="detail?.guest_phone" :href="`tel:${detail.guest_phone}`" class="mt-3 block w-fit text-base text-highlighted underline underline-offset-4">{{ formatPhone(detail.guest_phone) }}</a>
        <a v-if="detail?.guest_email" :href="`mailto:${detail.guest_email}`" class="mt-2 block w-fit break-all text-base text-highlighted underline underline-offset-4">{{ detail.guest_email }}</a>
      </UCard>
      <template v-if="detail">
      <FormAnswersCard :answers="detail.answers" :title="personalScope ? 'Your answers' : undefined" />
      <UCard v-if="!personalScope && detail.private_notes" variant="record">
        <h3 class="text-base font-semibold text-highlighted">Private note</h3>
        <p class="mt-3 whitespace-pre-wrap text-base text-muted">{{ detail.private_notes }}</p>
      </UCard>

      <!-- The policy the guest booked under, in Airbnb's words: what their own cancellation returns. -->
      <UCard v-if="policy || detail.cancellation_reason" variant="record">
      <template v-if="policy">
        <h2 class="text-base font-semibold text-highlighted">Cancellation policy</h2>
        <p class="mt-1 text-base text-highlighted">{{ policy.label }}</p>
        <ul class="mt-2 space-y-1 text-base text-muted">
          <li v-for="term in policy.terms" :key="term">{{ term }}</li>
        </ul>
      </template>
      <section v-if="detail.cancellation_reason" class="mt-6">
        <h3 class="text-base font-semibold text-highlighted">Cancellation reason</h3>
        <p class="mt-2 whitespace-pre-wrap text-base text-muted">{{ detail.cancellation_reason }}</p>
      </section>
      </UCard>

      <UCard variant="record">
      <dl class="space-y-4">
        <div class="flex items-start justify-between gap-4">
          <dt class="text-base font-semibold text-highlighted">Total</dt>
          <dd class="text-right text-base font-semibold text-highlighted">{{ money(detail.total_minor) }}</dd>
        </div>
        <div v-if="!channelManaged" class="flex items-start justify-between gap-4 border-t border-default pt-4">
          <dt class="text-base text-muted">Paid</dt>
          <dd class="text-right text-base text-highlighted">{{ money(detail.paid_minor) }}</dd>
        </div>
      </dl>
      </UCard>

      <!-- The Stripe payment the guest made on the site: its record and refunds are the payment's own screens. -->
      <UCard v-if="!personalScope && (!channelManaged || detail.online_payment)" variant="record">
      <h2 class="text-base font-semibold text-highlighted">Payments</h2>
      <template v-if="detail.online_payment">
        <h3 class="mt-6 text-base font-semibold text-highlighted">Paid on your site</h3>
        <p class="mt-1 text-base text-muted">{{ money(detail.online_payment.captured_minor) }}{{ detail.online_payment.refunded_minor ? ` · ${money(detail.online_payment.refunded_minor)} refunded` : '' }}</p>
        <div class="mt-4 divide-y divide-default border-y border-default">
          <NuxtLink :to="`${paymentPath}`" class="flex items-center gap-4 py-4">
            <span class="min-w-0 flex-1 text-base font-medium text-highlighted">View payment</span>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </NuxtLink>
          <NuxtLink v-if="manage && detail.online_payment.captured_minor > detail.online_payment.refunded_minor" :to="{ path: `${paymentPath}/refund`, query: { payment: detail.online_payment.payment_id } }" class="flex items-center gap-4 py-4">
            <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </NuxtLink>
        </div>
      </template>

      <template v-if="!channelManaged">
        <p class="text-sm text-muted" :class="detail.online_payment ? 'mt-6' : 'mt-1'">Money you received or refunded outside KrabiClaw. Recording it moves no money.</p>
        <ul v-if="detail.payments.length" class="mt-4 divide-y divide-default border-y border-default">
          <li v-for="payment in detail.payments" :key="payment.id" class="flex items-center gap-4 py-3">
            <span class="min-w-0 flex-1">
              <span class="block text-base text-highlighted">{{ money(payment.amount_minor) }} · {{ methodLabel(payment.method) }}</span>
              <span class="block text-sm text-muted">{{ formatCalendarDate(payment.paid_on, 'en') }}{{ payment.reference ? ` · ${payment.reference}` : '' }}</span>
            </span>
            <UButton v-if="manage" icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Delete payment of ${money(payment.amount_minor)}`" :loading="busy === payment.id" @click="deletePayment(payment.id)" />
          </li>
        </ul>
        <p v-else class="mt-4 text-base text-muted">No payments recorded.</p>

        <UForm v-if="manage" :state="draft" class="mt-6 space-y-4" @submit="recordPayment">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="`Amount (${detail.currency})`" name="amount" description="Negative for a refund." required>
              <UInput v-model="draft.amount" inputmode="decimal" class="w-full" />
            </UFormField>
            <UFormField label="Method" name="method" required>
              <USelect v-model="draft.method" :items="methods" class="w-full" />
            </UFormField>
            <UFormField label="Date" name="paid_on" required>
              <UInput v-model="draft.paid_on" type="date" class="w-full" />
            </UFormField>
            <UFormField label="Reference" name="reference">
              <UInput v-model="draft.reference" class="w-full" />
            </UFormField>
          </div>
          <UButton type="submit" label="Record payment" :loading="busy === 'record'" :disabled="!draft.amount.trim() || !draft.paid_on" />
        </UForm>
        <UButton v-if="manage && detail.status !== 'cancelled'" class="mt-8" color="error" variant="soft" label="Cancel stay" :loading="busy === 'cancel'" @click="cancel" />
        <p v-if="!personalScope && detail.no_show_at" class="mt-6 text-sm text-muted" data-testid="stay-no-show">No-show recorded {{ formatCalendarDate(detail.no_show_at.slice(0, 10), 'en') }}. No review invitation is sent.</p>
        <UButton v-else-if="canMarkNoShow" class="mt-4 ms-2" color="neutral" variant="soft" label="Mark as a no-show" :loading="busy === 'no_show'" @click="markNoShow" />
      </template>
      </UCard>
      <UCard v-if="personalScope" as="button" type="button" variant="record" class="w-full text-left" @click="manageOpen = true">
        <span class="flex items-center gap-4"><span class="min-w-0 flex-1 text-base font-semibold text-highlighted">{{ t('booking.manage') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></span>
      </UCard>

      <UCard variant="record">
      <dl class="space-y-4">
        <div v-if="detail.channel_booking_id" class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <dt class="text-base text-muted">{{ STAY_CHANNEL_LABELS[detail.channel] }} confirmation</dt>
          <dd class="break-words text-right text-base text-highlighted">{{ detail.channel_booking_id }}</dd>
        </div>
        <div class="flex items-start justify-between gap-4">
          <dt class="text-base text-muted">Booked through</dt>
          <dd class="text-right text-base text-highlighted">{{ STAY_CHANNEL_LABELS[detail.channel] }}</dd>
        </div>
      </dl>
      <UButton v-if="manage && detail.status !== 'cancelled'" class="mt-4" color="neutral" variant="outline" label="Move guest" :to="`/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/${encodeURIComponent(detail.id)}/move`" data-testid="stay-move" />
      <p v-if="!personalScope && channelManaged" class="mt-4 text-base text-muted">
        Payments, changes and cancellations for this stay are managed on
        <ULink v-if="detail.channel_booking_url" :to="detail.channel_booking_url" target="_blank" rel="noopener noreferrer" class="text-highlighted underline">{{ channelName }}</ULink><template v-else>{{ channelName }}</template>.
      </p>
      </UCard>
      </template>
      </div>
    </div>
    <template v-if="stay && !error && (messagePath || callPhone)" #footer>
      <div class="flex flex-wrap justify-center gap-3">
        <UButton v-if="messagePath" :to="messagePath" color="neutral" variant="solid" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" :label="personalScope ? t('stay.message_host') : 'Message'" :aria-label="personalScope ? t('stay.message_host') : 'Message guest'" />
        <UButton v-if="callPhone" :to="`tel:${callPhone}`" color="neutral" variant="solid" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" label="Call" />
      </div>
    </template>
  </DashboardIndexPanel>
  <DashboardListItemDialog v-model:open="manageOpen" :title="t('booking.manage')" :show-actions="false" :error="actionError">
    <div v-if="detail" class="divide-y divide-default">
      <p v-if="channelManaged" class="py-4 text-base text-muted">{{ t('booking.channel_manage', { channel: channelName }) }}</p>
      <NuxtLink v-if="canRequestChange && messagePath" :to="{ path: messagePath, query: { intent: 'booking-change' } }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('booking.request_change') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="messagePath" :to="messagePath" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('stay.message_host') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <p v-if="personalScope && !channelManaged && recordHome?.check_in_time === null && detail.online_payment && detail.status !== 'cancelled'" class="py-4 text-base text-muted">Contact your host to cancel this stay.</p>
      <UButton v-if="personalScope && !channelManaged && cancellation" color="error" variant="ghost" block class="justify-start py-4" label="Cancel stay" :loading="busy === 'cancel'" @click="manageOpen = false; cancelAsGuest()" />
    </div>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import FormAnswersCard from '~/components/forms/FormAnswersCard.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { formatPhone } from '~/utils/phone'
import StayArrivalGuideView from '~/components/booking/StayArrivalGuide.vue'
import { isGuestStay, isStayArrivalGuide, stayCheckInWindow } from '~/shared/stay-arrival'
import { STAY_CHECK_IN_METHODS } from '~/shared/stay-listing'
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import type { GuestStay, StayHome } from '~/server/domain/stays'
import { isChannelManagedStay, STAY_CHANNEL_LABELS, STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { STAY_MOVE_MESSAGE_QUEUED, isMovedStayResponse } from '~/shared/stay-move'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { formatCalendarDate, formatTime, localDateAt } from '~/utils/timezone'
import { formatPostalAddress } from '~/utils/postal-address'
import { getErrorMessage } from '~/utils/errors'
import { ApiClientError } from '~/utils/api-clients'

const props = defineProps<{
  stayId: string
  /** The guest's own stay, read and cancelled from their account; stayId is then its activity ID. */
  personalScope?: boolean
}>()
const recordLevel = useRouteLevel()
const dashboardApi = useDashboardApi()
const { t } = useI18n()
const route = useRoute()
const realtime = useDashboardInvalidations()
const toast = useToast()
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const manageOpen = ref(false)

const canonical = !props.personalScope ? await useDashboardBooking(props.stayId) : null
const buyer = props.personalScope ? await useAsyncData(`account-stay:${props.stayId}`, async (): Promise<GuestStay> => {
  const response = await applicationFetch(`/api/account/bookings/${encodeURIComponent(props.stayId)}?lookup=conversation`, {
    validate: (value): value is Omit<GuestStay, 'stay'> & { booking: Omit<GuestStay['stay'], 'id'> & { booking_id: string } } =>
      isRecord(value) && isNightBooking(value) && isGuestStay({ ...value, stay: { ...value.booking, id: value.booking.booking_id } }),
  })
  return { ...response, stay: { ...response.booking, id: response.booking.booking_id } }
}) : null
const error = canonical?.error ?? buyer!.error
const refresh = canonical?.refresh ?? buyer!.refresh
const data = computed(() => {
  if (buyer) return buyer.data.value
  const response = canonical?.data.value
  if (!response || response.booking.unit !== 'nights') return null
  if (response.manage && 'can_message_guest' in response && isNightBooking(response)) {
    return { ...response, stay: { ...response.booking, id: response.booking.booking_id } }
  }
  return { manage: false as const, stay: { ...response.booking, id: response.booking.booking_id } }
})
const stay = computed(() => data.value?.stay ?? null)
/** The whole stay: the guest's own, or a manager's. Null for a member's turnover. */
const detail = computed(() => !data.value ? null : 'home' in data.value ? data.value.stay : data.value.manage ? data.value.stay : null)
const pendingChanges = computed(() => data.value && 'manage' in data.value && data.value.manage ? data.value.stay.pending_changes : [])
const channelManaged = computed(() => detail.value !== null && isChannelManagedStay(detail.value))
const manage = computed(() => !props.personalScope && data.value !== null && 'manage' in data.value! && data.value.manage === true)
const home = computed(() => data.value && 'home' in data.value ? data.value.home : null)
const { data: hostHomeData, error: homeError, refresh: refreshHostHome } = await useAsyncData(
  computed(() => `${props.personalScope ? 'account' : String(route.params.org_slug)}-stay-home:${stay.value?.product_id ?? props.stayId}`),
  async (): Promise<{ home: StayHome } | null> => {
    if (props.personalScope || !stay.value) return null
    const productId = stay.value.product_id
    return dashboardApi(`/api/dashboard/stay-homes/${encodeURIComponent(productId)}`, {
      validate: (value: unknown): value is { home: StayHome } => isRecord(value) && isRecord(value.home)
        && value.home.product_id === productId && typeof value.home.internal_name === 'string' && !!value.home.internal_name.trim() && typeof value.home.name === 'string' && !!value.home.name.trim()
        && (value.home.check_in_time === null || typeof value.home.check_in_time === 'string') && (value.home.check_out_time === null || typeof value.home.check_out_time === 'string')
        && (value.home.check_in_end_time === null || typeof value.home.check_in_end_time === 'string')
        && Array.isArray(value.home.photos) && value.home.photos.every(photo => isRecord(photo)
          && typeof photo.url === 'string' && !!photo.url && (photo.kind === 'image' || photo.kind === 'video'))
        && isStayArrivalGuide(value.home),
    })
  },
)
const hostHome = computed(() => hostHomeData.value?.home ?? null)
const recordHome = computed(() => home.value ?? hostHome.value)
const homeImageUrl = computed(() => home.value ? home.value.image_url : hostHome.value?.photos[0]?.url ?? null)
const checkInTime = computed(() => recordHome.value?.check_in_time
  ? stayCheckInWindow(formatTime(recordHome.value.check_in_time, 'en'), hostHome.value?.check_in_end_time ? formatTime(hostHome.value.check_in_end_time, 'en') : null)
  : null)
/** When the guest said they arrive, where that is not the home's check-in time: the stay's stored start in the home's clock. */
const arrivalTime = computed(() => {
  const value = stay.value
  if (!value || value.starts_at.length === 10) return null
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value.starts_at))
  return local === recordHome.value?.check_in_time ? null : formatTime(local, 'en')
})
const messagePath = computed(() => {
  if (!detail.value?.conversation_id) return null
  const id = encodeURIComponent(detail.value.conversation_id)
  if (props.personalScope) return `/dashboard/account/messages/${id}`
  if (!data.value || !('manage' in data.value) || !data.value.manage || !data.value.can_message_guest) return null
  return `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/messages/${id}`
})
const callPhone = computed(() => !props.personalScope ? detail.value?.guest_phone ?? null : null)
const guestAddress = computed(() => home.value?.location?.address ? formatPostalAddress(home.value.location.address) : '')
const cancellation = computed(() => data.value && 'cancellation' in data.value ? data.value.cancellation : null)
const canRequestChange = computed(() => props.personalScope && detail.value !== null && !isChannelManagedStay(detail.value) && Boolean(messagePath.value) && ['pending', 'confirmed'].includes(detail.value.status)
  && (detail.value.ends_at.length === 10 ? detail.value.check_out_date >= localDateAt(new Date(), detail.value.timezone) : Date.parse(detail.value.ends_at) > Date.now()))
const policy = computed(() => detail.value?.cancellation_policy ? bookedPolicyTerms(detail.value.cancellation_policy) : null)
const paymentPath = computed(() => detail.value?.online_payment ? `/dashboard/${route.params.org_slug}/bookings/payment/${encodeURIComponent(detail.value.online_payment.payment_id)}` : '')
watch(realtime.event, event => {
  if (canonical && (event?.type === 'access.changed' || (event?.type === 'CONVERSATION_LEAVE' && event.conversation_id === detail.value?.conversation_id))) {
    canonical.clear()
    void refresh()
  }
  if (canonical && detail.value?.channel === 'airbnb' && event?.type === 'MESSAGE_CREATE' && !event.message && event.conversation_id === detail.value.conversation_id) {
    void refresh()
  }
  if (event?.type === 'stay.changed' && (event.booking_id === props.stayId || (event.booking_id === null && event.product_id === stay.value?.product_id))) {
    void refresh()
    if (!props.personalScope && event.booking_id === null) void refreshHostHome()
  }
})
watch(realtime.connectionEpoch, epoch => {
  if (epoch > 0) {
    void refresh()
    if (!props.personalScope) void refreshHostHome()
  }
})

const methods = Object.entries(STAY_PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))
const channelName = computed(() => detail.value ? detail.value.channel === 'direct' ? 'You' : STAY_CHANNEL_LABELS[detail.value.channel] : '')
/**
 * Who the stay is for. A stay made here always names its guest, so one without
 * is missing data; a channel may send a stay without a name, which is said as
 * such rather than given one.
 */
type GuestIdentity = { state: 'loading' } | { state: 'named'; name: string } | { state: 'not-provided' } | { state: 'missing' } | { state: 'unnamed' }
const guest = computed<GuestIdentity>(() => {
  const value = detail.value
  // A turnover carries the guest's first name and nothing about who booked it.
  if (!value) return !stay.value ? { state: 'loading' } : stay.value.guest_name ? { state: 'named', name: stay.value.guest_name } : { state: 'unnamed' }
  if (value.owner === 'app' && !value.guest_name) return { state: 'missing' }
  return value.guest_name ? { state: 'named', name: value.guest_name } : { state: 'not-provided' }
})
const title = computed(() => props.personalScope ? 'Your stay' : statusLabel.value)
const nights = computed(() => stay.value ? Math.round((Date.parse(`${stay.value.check_out_date}T00:00:00Z`) - Date.parse(`${stay.value.check_in_date}T00:00:00Z`)) / 86_400_000) : 0)
const stayDates = computed(() => stay.value
  ? `${formatCalendarDate(stay.value.check_in_date, 'en')} – ${formatCalendarDate(stay.value.check_out_date, 'en')} · ${nights.value === 1 ? '1 night' : `${nights.value} nights`}`
  : '')
const partyLabel = computed(() => {
  const value = stay.value
  if (!value) return ''
  const parts = [`${value.adults} ${value.adults === 1 ? 'adult' : 'adults'}`]
  if (value.children) parts.push(`${value.children} ${value.children === 1 ? 'child' : 'children'}`)
  if (value.infants) parts.push(`${value.infants} ${value.infants === 1 ? 'infant' : 'infants'}`)
  return parts.join(', ')
})
const guestCount = computed(() => stay.value ? stay.value.adults + stay.value.children + stay.value.infants : 0)
const guestFirstName = computed(() => guest.value.state === 'named' ? guest.value.name.trim().split(/\s+/)[0] || guest.value.name : null)
const partyTitle = computed(() => guestFirstName.value && guestCount.value > 1 ? `${guestFirstName.value}’s group of ${guestCount.value}` : guestFirstName.value)
const statusLabel = computed(() => !stay.value ? 'Stay' : stay.value.status === 'cancelled' ? 'Cancelled' : stay.value.status === 'pending' ? 'Pending' : 'Confirmed')

function money(minor: number): string {
  const currency = detail.value?.currency
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported stay currency ${String(currency)}`)
  return `${minor < 0 ? '−' : ''}${formatMinorAmount(Math.abs(minor), currency)}`
}
function methodLabel(method: StayPaymentMethod) { return STAY_PAYMENT_METHOD_LABELS[method] }

const actionError = ref<string | null>(null)
const busy = ref<string | null>(null)
const changeResult = ref<string | null>(null)
// The payment day defaults to today where the home is; one key per payment being entered, kept across retries.
const homeToday = () => stay.value ? localDateAt(new Date(), stay.value.timezone) : ''
const draft = reactive({ amount: '', method: 'cash' as StayPaymentMethod, paid_on: homeToday(), reference: '', key: crypto.randomUUID() })
watch(stay, () => { if (!draft.paid_on) draft.paid_on = homeToday() })

async function run(key: string, action: () => Promise<unknown>, failure: string) {
  busy.value = key
  actionError.value = null
  try {
    await action()
    await refresh()
    if (error.value) throw error.value
  } catch (cause) {
    actionError.value = getErrorMessage(cause, failure)
    if (cause instanceof ApiClientError && (cause.code === 'CHANGE_REQUEST_RESOLVED' || cause.data.committed === true || (isRecord(cause.data.data) && cause.data.data.committed === true))) {
      try {
        await refresh()
        if (error.value) throw error.value
      } catch (readError) {
        actionError.value += ` ${getErrorMessage(readError, 'The saved stay could not be reloaded.')}`
      }
    }
  } finally {
    busy.value = null
  }
}

async function answerChange(messageId: string, decision: 'accept' | 'decline') {
  if (busy.value !== null || !detail.value) return
  const bookingId = detail.value.id
  changeResult.value = null
  await run(`${decision}-${messageId}`, async () => {
    await dashboardApi(`${dashboardBookingPath(bookingId)}/${decision}_change`, {
      method: 'POST',
      body: { message_id: messageId },
      validate: (value): value is undefined => value === undefined,
    })
    changeResult.value = decision === 'accept' ? t('booking.change_guest_accepted', { channel: 'Airbnb' }) : t('booking.change_declined')
  }, t('booking.change_failed'))
}

async function recordPayment() {
  const value = detail.value
  if (!value || isChannelManagedStay(value) || !isCurrencyCode(value.currency)) return
  const typed = draft.amount.trim()
  const negative = typed.startsWith('-')
  await run('record', async () => {
    const minor = majorAmountToMinor(negative ? typed.slice(1) : typed, value.currency as Parameters<typeof majorAmountToMinor>[1])
    await dashboardApi(`${dashboardBookingPath(value.id)}/payments`, {
      method: 'POST', validate: isNightBooking,
      body: { amount_minor: negative ? -minor : minor, method: draft.method, paid_on: draft.paid_on, reference: draft.reference || undefined, idempotency_key: draft.key },
    })
    draft.amount = ''
    draft.reference = ''
    draft.key = crypto.randomUUID()
  }, 'The payment could not be recorded')
}

async function deletePayment(paymentId: string) {
  const value = detail.value
  if (!value || isChannelManagedStay(value)) return
  await run(paymentId, () => dashboardApi(`${dashboardBookingPath(value.id)}/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', validate: isNightBooking }), 'The payment could not be deleted')
}

// A stay paid on the site returns the guest's whole payment, as Airbnb's host cancellation does; the host approves that refund next.
// A stay booked here that has begun, before its guest reviewed it. The thread
// operation is the writer; it refuses a stay that no longer qualifies.
const canMarkNoShow = computed(() => !props.personalScope && manage.value && detail.value?.channel === 'direct' && detail.value.status === 'confirmed'
  && !detail.value.no_show_at && Boolean(detail.value.conversation_id) && detail.value.check_in_date <= localDateAt(new Date(), detail.value.timezone))

async function undoMove() {
  const value = detail.value
  if (!value?.booked_product_id) return
  if (!await confirmDialog.open({ title: 'Undo this move', description: `The guest goes back to ${value.booked_home_name} and a message with its address and entry details is queued.`, confirmLabel: 'Undo move', cancelLabel: 'Keep the move' })) return
  await run('undo_move', async () => {
    await dashboardApi(`${dashboardBookingPath(value.id)}/move`, { method: 'POST', validate: isMovedStayResponse, body: { version: value.version, product_id: value.booked_product_id } })
    toast.add(STAY_MOVE_MESSAGE_QUEUED)
  }, 'The move could not be undone.')
}

async function markNoShow() {
  const value = detail.value
  if (!value?.conversation_id) return
  if (!await confirmDialog.open({
    title: 'Mark as a no-show',
    description: `${guest.value.state === 'named' ? guest.value.name : 'The guest'} won’t be asked to review this stay, and a review link already sent stops working. The stay itself stays as it is. This cannot be undone.`,
    confirmLabel: 'Mark as a no-show', cancelLabel: 'Keep as is',
  })) return
  busy.value = 'no_show'
  actionError.value = null
  try {
    await dashboardApi(`${dashboardBookingPath(value.id)}/no_show`, {
      method: 'POST',
      body: { version: value.version, idempotency_key: `no-show:${value.id}` },
      validate: isDashboardBooking,
    })
    await refresh()
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The stay could not be marked as a no-show')
  } finally {
    busy.value = null
  }
}

async function cancel() {
  const value = detail.value
  if (!value || isChannelManagedStay(value)) return
  const held = value.online_payment ? value.online_payment.captured_minor - value.online_payment.refunded_minor : 0
  const description = held > 0
    ? `Its nights become available again and ${guest.value.state === 'named' ? guest.value.name : 'the guest'} is refunded ${money(held)} in full. You approve the refund next.`
    : 'Its nights become available again. Record any refund as a payment.'
  if (!await confirmDialog.open({ title: guest.value.state === 'named' ? `Cancel ${guest.value.name}’s stay` : 'Cancel this stay', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  busy.value = 'cancel'
  actionError.value = null
  try {
    await dashboardApi(`${dashboardBookingPath(value.id)}/cancel`, { method: 'POST', validate: isNightBooking, body: { version: value.version } })
    await refresh()
  } catch (cause) {
    const approval = isRecord(cause) && isRecord(cause.data) && isRecord(cause.data.data) && typeof cause.data.data.financial_approval_url === 'string' ? cause.data.data.financial_approval_url : null
    if (approval) await navigateTo(approval)
    else {
      actionError.value = getErrorMessage(cause, 'The stay could not be cancelled')
      if (cause instanceof ApiClientError && (cause.data.committed === true || (isRecord(cause.data.data) && cause.data.data.committed === true))) {
        try {
          await refresh()
          if (error.value) throw error.value
        } catch (readError) {
          actionError.value += ` ${getErrorMessage(readError, 'The saved stay could not be reloaded.')}`
        }
      }
    }
  } finally {
    busy.value = null
  }
}

/** The guest cancels their own stay; the policy they booked under decides what comes back. */
async function cancelAsGuest() {
  const value = detail.value
  const quote = cancellation.value
  if (!value || isChannelManagedStay(value) || !quote || !value.conversation_id || !policy.value) return
  const description = quote.refund_minor === quote.paid_minor ? `You get back the full ${money(quote.paid_minor)}.`
    : quote.refund_minor > 0 ? `Under the ${policy.value.label} policy you get back ${money(quote.refund_minor)} of the ${money(quote.paid_minor)} you paid.`
      : `Under the ${policy.value.label} policy none of the ${money(quote.paid_minor)} you paid comes back.`
  if (!await confirmDialog.open({ title: 'Cancel your stay?', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  await run('cancel', () => applicationFetch(`/api/account/bookings/${encodeURIComponent(value.id)}/cancel`, {
    method: 'POST', body: { version: value.version },
    validate: (response: unknown): response is { success: true } => isRecord(response) && response.success === true,
  }), 'Your stay could not be cancelled')
}
</script>
