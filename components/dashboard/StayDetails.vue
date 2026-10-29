<template>
  <!-- One stay at a place to stay: who is coming, when, and what the host has collected. -->
  <!-- Inside the guest thread's leaf, which owns the column, it is the body alone. -->
  <component :is="embedded ? 'div' : DashboardIndexPanel" v-bind="embedded ? {} : { id: 'stay-details', title, column: 'record' }">
    <template #right>
      <UButton v-if="!embedded && recordLevel.to.value" :to="recordLevel.to.value" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close stay details" />
    </template>
    <UAlert v-if="error" color="error" variant="soft" title="This stay could not be loaded" :description="getErrorMessage(error, 'Stay request failed')" />
    <div v-else-if="stay" class="min-w-0 [overflow-wrap:anywhere]">
      <UAlert v-if="actionError" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <UAlert v-if="homeError" class="mb-5" color="error" variant="soft" title="The home could not be loaded" :description="getErrorMessage(homeError, 'Home request failed')" />
      <!-- A channel stay overlapping another is the host's to resolve; it never resolves itself. -->
      <UAlert
        v-if="stay.overbooked"
        class="mb-5"
        color="error"
        icon="i-lucide-triangle-alert"
        title="Overbooked"
        :description="`${channelName} confirmed this stay on nights another stay holds. Cancel this stay on ${channelName}, or cancel the other stay where it was booked.`"
      />
      <UAlert v-if="!personalScope && guest.state === 'missing'" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" title="Guest name missing" description="This stay was made in KrabiClaw, which requires a guest name, but it has none." />
      <div class="flex flex-col items-center pb-12 pt-10 text-center">
        <div v-if="!personalScope && guest.state === 'named'" class="relative mb-6 shrink-0 md:mb-8" :class="guestCount > 1 ? 'h-30 w-35 md:h-40 md:w-46' : 'size-27 md:size-36'">
          <UAvatar :src="stay.guest_image_url || undefined" :alt="guest.name" :text="guestFirstName?.slice(0, 1).toUpperCase()" size="3xl" class="absolute bottom-0 left-0" :class="guestCount > 1 ? 'size-21 md:size-28' : 'size-27 md:size-36'" :ui="{ fallback: 'text-[30px] font-semibold text-highlighted md:text-4xl' }" />
          <span v-if="guestCount > 1" class="absolute right-0 top-0 flex size-16 items-center justify-center rounded-full bg-elevated text-[9px] font-bold text-highlighted md:size-21 md:text-xs" :aria-label="`${guestCount - 1} other guests`">+{{ guestCount - 1 }}</span>
        </div>
        <h2 v-if="personalScope && home" class="max-w-full text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ home.name }}</h2>
        <h2 v-else-if="guest.state === 'named'" class="max-w-full text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ partyTitle }}</h2>
        <h2 v-else-if="guest.state === 'not-provided'" class="text-2xl font-semibold text-muted">Name not provided by {{ channelName }}</h2>
        <h2 v-else-if="guest.state === 'missing'" class="text-2xl font-semibold text-error">Guest name missing</h2>
        <p v-if="personalScope && home" class="mt-1 text-base text-muted">{{ home.organization_name }}</p>
        <p class="mt-4 text-base text-muted">{{ stayDates }}</p>
        <p v-if="!personalScope && recordHome" class="mt-1 text-base text-muted">{{ recordHome.name }}</p>
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
          <p v-if="recordHome" class="mt-1 text-sm text-muted">By {{ formatTime(recordHome.check_out_time, 'en') }}</p>
        </div>
      </div>
      <div v-if="stay.arrival_time" class="mt-6 border-t border-default pt-4">
        <p class="text-base font-medium text-highlighted">Arriving</p>
        <p class="mt-1 text-base text-muted">{{ formatTime(stay.arrival_time, 'en') }}</p>
      </div>
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
          <UAvatar :src="stay.guest_image_url || undefined" :alt="guest.name" :text="guestFirstName?.slice(0, 1).toUpperCase()" size="xl" class="size-12 bg-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 text-base text-highlighted">{{ guest.name }}</span>
        </div>
        <div v-if="guestCount > 1" class="mt-4 flex items-center gap-4">
          <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden="true">+{{ guestCount - 1 }}</span>
          <span class="text-base text-highlighted">{{ guestCount - 1 }} other {{ guestCount === 2 ? 'guest' : 'guests' }}</span>
        </div>
        <p class="mt-3 text-base text-muted">{{ partyLabel }}</p>
        <a v-if="stay.guest_phone" :href="`tel:${stay.guest_phone}`" class="mt-3 block w-fit text-base text-highlighted underline underline-offset-4">{{ formatPhone(stay.guest_phone) }}</a>
        <a v-if="stay.guest_email" :href="`mailto:${stay.guest_email}`" class="mt-2 block w-fit break-all text-base text-highlighted underline underline-offset-4">{{ stay.guest_email }}</a>
      </UCard>
      <UCard v-if="stay.notes" variant="record">
        <h3 class="text-base font-semibold text-highlighted">{{ personalScope ? 'Your requests' : 'Guest requests' }}</h3>
        <p class="mt-3 whitespace-pre-wrap text-base text-muted">{{ stay.notes }}</p>
      </UCard>

      <!-- The policy the guest booked under, in Airbnb's words: what their own cancellation returns. -->
      <UCard v-if="policy || stay.cancellation_reason" variant="record">
      <template v-if="policy">
        <h2 class="text-base font-semibold text-highlighted">Cancellation policy</h2>
        <p class="mt-1 text-base text-highlighted">{{ policy.label }}</p>
        <ul class="mt-2 space-y-1 text-base text-muted">
          <li v-for="term in policy.terms" :key="term">{{ term }}</li>
        </ul>
      </template>
      <section v-if="stay.cancellation_reason" class="mt-6">
        <h3 class="text-base font-semibold text-highlighted">Cancellation reason</h3>
        <p class="mt-2 whitespace-pre-wrap text-base text-muted">{{ stay.cancellation_reason }}</p>
      </section>
      </UCard>

      <UCard variant="record">
      <dl class="space-y-4">
        <div class="flex items-start justify-between gap-4">
          <dt class="text-base font-semibold text-highlighted">Total</dt>
          <dd class="text-right text-base font-semibold text-highlighted">{{ money(stay.total_minor) }}</dd>
        </div>
        <div v-if="stay.owner === 'app'" class="flex items-start justify-between gap-4 border-t border-default pt-4">
          <dt class="text-base text-muted">Paid</dt>
          <dd class="text-right text-base text-highlighted">{{ money(stay.paid_minor) }}</dd>
        </div>
      </dl>
      </UCard>

      <!-- The Stripe payment the guest made on the site: its record and refunds are the payment's own screens. -->
      <UCard v-if="!personalScope && (stay.owner === 'app' || stay.online_payment)" variant="record">
      <h2 class="text-base font-semibold text-highlighted">Payments</h2>
      <template v-if="stay.online_payment">
        <h3 class="mt-6 text-base font-semibold text-highlighted">Paid on your site</h3>
        <p class="mt-1 text-base text-muted">{{ money(stay.online_payment.captured_minor) }}{{ stay.online_payment.refunded_minor ? ` · ${money(stay.online_payment.refunded_minor)} refunded` : '' }}</p>
        <div class="mt-4 divide-y divide-default border-y border-default">
          <NuxtLink :to="`${paymentPath}`" class="flex items-center gap-4 py-4">
            <span class="min-w-0 flex-1 text-base font-medium text-highlighted">View payment</span>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </NuxtLink>
          <NuxtLink v-if="manage && stay.online_payment.captured_minor > stay.online_payment.refunded_minor" :to="{ path: `${paymentPath}/refund`, query: { payment: stay.online_payment.payment_id } }" class="flex items-center gap-4 py-4">
            <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
            <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
          </NuxtLink>
        </div>
      </template>

      <template v-if="stay.owner === 'app'">
        <p class="text-sm text-muted" :class="stay.online_payment ? 'mt-6' : 'mt-1'">Money you received or refunded outside KrabiClaw. Recording it moves no money.</p>
        <ul v-if="stay.payments.length" class="mt-4 divide-y divide-default border-y border-default">
          <li v-for="payment in stay.payments" :key="payment.id" class="flex items-center gap-4 py-3">
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
            <UFormField :label="`Amount (${stay.currency})`" name="amount" description="Negative for a refund." required>
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
        <UButton v-if="manage && stay.status !== 'cancelled'" class="mt-8" color="error" variant="soft" label="Cancel stay" :loading="busy === 'cancel'" @click="cancel" />
      </template>
      </UCard>
      <UCard v-if="personalScope" as="button" type="button" variant="record" class="w-full text-left" @click="manageOpen = true">
        <span class="flex items-center gap-4"><span class="min-w-0 flex-1 text-base font-semibold text-highlighted">{{ t('booking.manage') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></span>
      </UCard>

      <UCard variant="record">
      <dl class="space-y-4">
        <div v-if="stay.channel_booking_id" class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <dt class="text-base text-muted">{{ STAY_CHANNEL_LABELS[stay.channel] }} confirmation</dt>
          <dd class="break-words text-right text-base text-highlighted">{{ stay.channel_booking_id }}</dd>
        </div>
        <div class="flex items-start justify-between gap-4">
          <dt class="text-base text-muted">Booked through</dt>
          <dd class="text-right text-base text-highlighted">{{ STAY_CHANNEL_LABELS[stay.channel] }}</dd>
        </div>
      </dl>
      <p v-if="!personalScope && stay.owner === 'channel'" class="mt-4 text-base text-muted">{{ channelName }} collected payment for this stay. Change or cancel it on {{ channelName }}.</p>
      <div v-if="embedded && (messagePath || callPhone)" class="mt-6 flex flex-wrap justify-center gap-3">
        <UButton v-if="messagePath" :to="messagePath" color="neutral" variant="solid" class="h-14 rounded-full px-8 shadow-lg" :label="personalScope ? t('stay.message_host') : 'Message'" :aria-label="personalScope ? t('stay.message_host') : 'Message guest'" />
        <UButton v-if="callPhone" :to="`tel:${callPhone}`" color="neutral" variant="solid" class="h-14 rounded-full px-8 shadow-lg" label="Call" />
      </div>
      </UCard>
      </div>
    </div>
    <template v-if="!embedded && stay && !error && (messagePath || callPhone)" #footer>
      <div class="flex flex-wrap justify-center gap-3">
        <UButton v-if="messagePath" :to="messagePath" color="neutral" variant="solid" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" :label="personalScope ? t('stay.message_host') : 'Message'" :aria-label="personalScope ? t('stay.message_host') : 'Message guest'" />
        <UButton v-if="callPhone" :to="`tel:${callPhone}`" color="neutral" variant="solid" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" label="Call" />
      </div>
    </template>
  </component>
  <DashboardListItemDialog v-model:open="manageOpen" :title="t('booking.manage')" :show-actions="false" :error="actionError">
    <div v-if="stay" class="divide-y divide-default">
      <p v-if="stay.owner === 'channel'" class="py-4 text-base text-muted">{{ t('booking.channel_manage', { channel: channelName }) }}</p>
      <NuxtLink v-if="canRequestChange && messagePath" :to="{ path: messagePath, query: { intent: 'booking-change' } }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('booking.request_change') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="messagePath" :to="messagePath" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('stay.message_host') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <UButton v-if="personalScope && stay.owner === 'app' && cancellation" color="error" variant="ghost" block class="justify-start py-4" label="Cancel stay" :loading="busy === 'cancel'" @click="manageOpen = false; cancelAsGuest()" />
    </div>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { formatPhone } from '~/utils/phone'
import StayArrivalGuideView from '~/components/booking/StayArrivalGuide.vue'
import { isGuestStay, isStayArrivalGuide, stayCheckInWindow } from '~/shared/stay-arrival'
import { STAY_CHECK_IN_METHODS } from '~/shared/stay-listing'
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import type { GuestStay, StayDetail, StayHome } from '~/server/domain/stays'
import { STAY_CHANNEL_LABELS, STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { formatCalendarDate, formatTime, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { formatPostalAddress } from '~/utils/postal-address'
import { getErrorMessage } from '~/utils/errors'
import { ApiClientError } from '~/utils/api-clients'

const props = defineProps<{
  stayId: string
  /** Mounted inside the guest thread's leaf, which already owns the column and its padding. */
  embedded?: boolean
  /** The guest's own stay, read and cancelled from their account; stayId is then its activity ID. */
  personalScope?: boolean
}>()
const recordLevel = useRouteLevel()
const dashboardApi = useDashboardApi()
const { t } = useI18n()
const route = useRoute()
const realtime = useDashboardInvalidations()
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const manageOpen = ref(false)

const isStay = (value: unknown): value is { stay: StayDetail; manage?: boolean } => isRecord(value) && isRecord(value.stay) && typeof value.stay.id === 'string'
  && (value.stay.guest_image_url === null || typeof value.stay.guest_image_url === 'string')
const { data, error, refresh } = await useAsyncData(`${props.personalScope ? 'account' : 'dashboard'}-stay:${props.stayId}`, (): Promise<{ stay: StayDetail; manage?: boolean } | GuestStay> => props.personalScope
  ? applicationFetch(`/api/account/stays/${encodeURIComponent(props.stayId)}`, { validate: isGuestStay })
  : dashboardApi(`/api/dashboard/stays/${encodeURIComponent(props.stayId)}`, { validate: isStay }))
const stay = computed(() => data.value?.stay ?? null)
const manage = computed(() => !props.personalScope && data.value !== null && 'manage' in data.value! && data.value.manage === true)
const home = computed(() => data.value && 'home' in data.value ? data.value.home : null)
const { data: hostHomeData, error: homeError, refresh: refreshHostHome } = await useAsyncData(
  computed(() => `${props.personalScope ? 'account' : String(route.params.orgSlug)}-stay-home:${stay.value?.product_id ?? props.stayId}`),
  async (): Promise<{ home: StayHome } | null> => {
    if (props.personalScope || !stay.value) return null
    const productId = stay.value.product_id
    return dashboardApi(`/api/dashboard/stay-homes/${encodeURIComponent(productId)}`, {
      validate: (value: unknown): value is { home: StayHome } => isRecord(value) && isRecord(value.home)
        && value.home.product_id === productId && typeof value.home.name === 'string' && !!value.home.name.trim()
        && typeof value.home.check_in_time === 'string' && typeof value.home.check_out_time === 'string'
        && (value.home.check_in_end_time === null || typeof value.home.check_in_end_time === 'string')
        && Array.isArray(value.home.photos) && value.home.photos.every(photo => isRecord(photo)
          && typeof photo.url === 'string' && !!photo.url && (photo.kind === 'image' || photo.kind === 'video'))
        && isStayArrivalGuide(value.home),
    })
  },
)
const hostHome = computed(() => hostHomeData.value?.home ?? null)
const recordHome = computed(() => home.value ?? hostHome.value)
const checkInTime = computed(() => recordHome.value
  ? stayCheckInWindow(formatTime(recordHome.value.check_in_time, 'en'), hostHome.value?.check_in_end_time ? formatTime(hostHome.value.check_in_end_time, 'en') : null)
  : null)
const messagePath = computed(() => stay.value?.request_id
  ? props.personalScope ? `/dashboard/account/messages/${encodeURIComponent(stay.value.request_id)}`
    : `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages/${encodeURIComponent(stay.value.request_id)}`
  : null)
const callPhone = computed(() => !props.personalScope ? stay.value?.guest_phone ?? null : null)
const guestAddress = computed(() => home.value?.location?.address ? formatPostalAddress(home.value.location.address) : '')
const cancellation = computed(() => data.value && 'cancellation' in data.value ? data.value.cancellation : null)
const canRequestChange = computed(() => props.personalScope && stay.value?.owner === 'app' && Boolean(messagePath.value) && ['pending', 'confirmed'].includes(stay.value.status)
  && Boolean(recordHome.value) && localDateTimeToInstant(stay.value.check_out_date, recordHome.value!.check_out_time, stay.value.timezone, 'compatible').getTime() > Date.now())
const policy = computed(() => stay.value?.cancellation_policy ? bookedPolicyTerms(stay.value.cancellation_policy) : null)
const paymentPath = computed(() => stay.value?.online_payment ? `/dashboard/${route.params.orgSlug}/bookings/payment/${encodeURIComponent(stay.value.online_payment.payment_id)}` : '')
watch(realtime.event, event => {
  if (event?.type === 'stay.changed' && (event.stayId === props.stayId || (event.stayId === null && event.productId === stay.value?.product_id))) {
    void refresh()
    if (!props.personalScope && event.stayId === null) void refreshHostHome()
  }
})
watch(realtime.connectionEpoch, epoch => {
  if (epoch > 0) {
    void refresh()
    if (!props.personalScope) void refreshHostHome()
  }
})

const methods = Object.entries(STAY_PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))
const channelName = computed(() => stay.value ? stay.value.channel === 'direct' ? 'You' : STAY_CHANNEL_LABELS[stay.value.channel] : '')
/**
 * Who the stay is for. A stay made here always names its guest, so one without
 * is missing data; a channel may send a stay without a name, which is said as
 * such rather than given one.
 */
type GuestIdentity = { state: 'loading' } | { state: 'named'; name: string } | { state: 'not-provided' } | { state: 'missing' }
const guest = computed<GuestIdentity>(() => {
  const value = stay.value
  if (!value) return { state: 'loading' }
  if (value.owner === 'app' && !value.guest_name) return { state: 'missing' }
  const name = [value.guest_name, value.guest_surname].filter(Boolean).join(' ')
  return name ? { state: 'named', name } : { state: 'not-provided' }
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
  const currency = stay.value?.currency
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported stay currency ${String(currency)}`)
  return `${minor < 0 ? '−' : ''}${formatMinorAmount(Math.abs(minor), currency)}`
}
function methodLabel(method: StayPaymentMethod) { return STAY_PAYMENT_METHOD_LABELS[method] }

const actionError = ref<string | null>(null)
const busy = ref<string | null>(null)
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
    if (cause instanceof ApiClientError && (cause.data.committed === true || (isRecord(cause.data.data) && cause.data.data.committed === true))) {
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

async function recordPayment() {
  const value = stay.value
  if (!value || !isCurrencyCode(value.currency)) return
  const typed = draft.amount.trim()
  const negative = typed.startsWith('-')
  await run('record', async () => {
    const minor = majorAmountToMinor(negative ? typed.slice(1) : typed, value.currency as Parameters<typeof majorAmountToMinor>[1])
    await dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/payments`, {
      method: 'POST', validate: isStay,
      body: { amount_minor: negative ? -minor : minor, method: draft.method, paid_on: draft.paid_on, reference: draft.reference || undefined, idempotency_key: draft.key },
    })
    draft.amount = ''
    draft.reference = ''
    draft.key = crypto.randomUUID()
  }, 'The payment could not be recorded')
}

async function deletePayment(paymentId: string) {
  const value = stay.value
  if (!value) return
  await run(paymentId, () => dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', validate: isStay }), 'The payment could not be deleted')
}

// A stay paid on the site returns the guest's whole payment, as Airbnb's host cancellation does; the host approves that refund next.
async function cancel() {
  const value = stay.value
  if (!value) return
  const held = value.online_payment ? value.online_payment.captured_minor - value.online_payment.refunded_minor : 0
  const description = held > 0
    ? `Its nights become available again and ${guest.value.state === 'named' ? guest.value.name : 'the guest'} is refunded ${money(held)} in full. You approve the refund next.`
    : 'Its nights become available again. Record any refund as a payment.'
  if (!await confirmDialog.open({ title: guest.value.state === 'named' ? `Cancel ${guest.value.name}’s stay` : 'Cancel this stay', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  busy.value = 'cancel'
  actionError.value = null
  try {
    await dashboardApi(`/api/dashboard/stays/${encodeURIComponent(value.id)}/cancel`, { method: 'POST', validate: isStay, body: { expected_version: value.version } })
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
  const value = stay.value
  const quote = cancellation.value
  if (!value || !quote || !value.request_id || !policy.value) return
  const description = quote.refund_minor === quote.paid_minor ? `You get back the full ${money(quote.paid_minor)}.`
    : quote.refund_minor > 0 ? `Under the ${policy.value.label} policy you get back ${money(quote.refund_minor)} of the ${money(quote.paid_minor)} you paid.`
      : `Under the ${policy.value.label} policy none of the ${money(quote.paid_minor)} you paid comes back.`
  if (!await confirmDialog.open({ title: 'Cancel your stay?', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  await run('cancel', () => applicationFetch('/api/account/cancel', {
    method: 'POST', body: { request_id: value.request_id },
    validate: (response: unknown): response is { success: true } => isRecord(response) && response.success === true,
  }), 'Your stay could not be cancelled')
}
</script>
