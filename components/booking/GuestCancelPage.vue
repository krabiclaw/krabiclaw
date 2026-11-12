<template>
  <div class="min-h-screen bg-default text-default">
    <header class="tenant-container pt-16 pb-10 text-center">
      <h1 class="tenant-display-md text-default"><em class="tenant-italic">{{ copy('title') }}</em></h1>
    </header>

    <div class="mx-auto max-w-xl px-4 pb-24 text-center">
      <template v-if="pending">
        <TenantIcon name="arrow-path" class="mx-auto size-12 animate-spin text-muted" />
        <p class="mt-4 text-muted">{{ copy('checking') }}</p>
      </template>

      <template v-else-if="booking">
        <div v-if="!cancelled" class="rounded-3xl border border-default bg-elevated p-12 shadow-sm">
          <div class="mb-6 flex justify-center">
            <div class="flex size-16 items-center justify-center rounded-full bg-red-500/10 text-red-500">
              <TenantIcon name="calendar-days" class="size-10" />
            </div>
          </div>
          <h2 v-if="!cancellationClosed" class="tenant-display tenant-italic text-3xl">{{ copy('cancel_visit') }}</h2>
          <div class="mt-6 space-y-2 border-y border-default py-6 text-sm">
            <p><strong>{{ copy(isTable ? 'reservation_for' : 'booking_for') }}</strong> {{ booking.name }}</p>
            <p v-if="booking.product_name"><strong>{{ booking.product_name }}</strong></p>
            <p><strong>{{ copy('date') }}</strong> {{ readableDate }}</p>
            <p><strong>{{ copy('time') }}</strong> {{ readableTime }}</p>
            <p><strong>{{ copy('guests') }}</strong> {{ booking.guests }}</p>
          </div>
          <p v-if="cancellationClosed" class="mt-6 text-sm text-default">{{ t('booking_policy.cancel_closed', { window: noticeDuration(booking.advance_notice_minutes!, locale) }) }}</p>
          <p v-else-if="booking.paid" class="mt-6 text-sm text-default">{{ t(booking.refund_on_cancel ? 'booking_policy.cancel_refund' : 'booking_policy.cancel_no_refund', { window: noticeDuration(freeCancellationNoticeMinutes(booking.advance_notice_minutes), locale) }) }}</p>
          <p v-if="cancelError" class="mt-4 text-sm text-error">{{ cancelError }}</p>
          <div class="mt-10 flex flex-col gap-3">
            <TenantButton v-if="!cancellationClosed" color="error" size="lg" block :loading="loading" @click="handleCancel">
              {{ copy('confirm') }}
            </TenantButton>
            <TenantButton :to="localePath('/')" variant="ghost" size="lg" block>{{ copy('keep') }}</TenantButton>
          </div>
        </div>

        <div v-else class="rounded-3xl border border-default bg-muted/20 p-12">
          <div class="mb-6 flex justify-center">
            <div class="flex size-16 items-center justify-center rounded-full bg-zinc-500/10 text-zinc-500">
              <TenantIcon name="check-circle" class="size-10" />
            </div>
          </div>
          <h2 class="tenant-display tenant-italic text-3xl">{{ copy('cancelled_title') }}</h2>
          <p class="mt-4 text-muted">{{ t(`site.${keyPrefix}.cancelled_desc`, { date: readableDate }) }}</p>
          <p v-if="cancelError" class="mt-4 text-sm text-error">{{ cancelError }}</p>
          <div class="mt-10">
            <TenantButton v-if="booking.can_retry_cancellation && !cancellationSubmitted" class="mb-3" size="lg" block :loading="loading" @click="handleCancel">{{ copy('retry_refund') }}</TenantButton>
            <TenantButton :to="localePath('/')" variant="soft">{{ copy('back_home') }}</TenantButton>
          </div>
        </div>
      </template>

      <div v-else class="rounded-3xl border border-default bg-muted/20 p-12">
        <TenantIcon name="exclamation-triangle" class="mx-auto size-12 text-error" />
        <h2 class="mt-6 text-xl font-bold">{{ copy('invalid_link') }}</h2>
        <p class="mt-2 text-muted">{{ copy('invalid_link_desc') }}</p>
        <TenantButton :to="startOverHref" variant="soft" class="mt-10">{{ copy('make_new') }}</TenantButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { $fetch } from 'ofetch'
import { formatTimestamp } from '~/utils/timezone'
import { presentationForProduct } from '~/utils/product-presentation'
import type { ProductKind } from '~/shared/product-details'
import { freeCancellationNoticeMinutes, noticeDuration, outsideNotice } from '~/shared/availability-settings'
import { ApiClientError } from '~/utils/api-clients'

/**
 * The page a guest's cancellation link opens. Every booking is cancelled by
 * the same act through the same endpoint; a table's is worded as a reservation.
 */
const { locale, localePath, t } = useI18n()
const route = useRoute()

const requestId = computed(() => typeof route.query.id === 'string' ? route.query.id : '')
const token = computed(() => route.hash ? route.hash.slice(1) : '')

interface GuestBookingView {
  kind: 'booking'
  name: string
  starts_at: string
  timezone: string
  guests: string
  status: string
  can_retry_cancellation: boolean
  refund_on_cancel: boolean
  advance_notice_minutes: number | null
  paid: { amount: number; currency: string } | null
  product_name: string | null
  product_kind: ProductKind | null
}

const { data, pending } = await useAsyncData<{ success: true; booking: GuestBookingView }>(
  computed(() => `guest-cancel-${requestId.value}-${locale.value}`),
  () => $fetch(`/api/public/booking-requests/${requestId.value}`, {
    query: { locale: locale.value },
    headers: { Authorization: `Bearer ${token.value}` },
  }),
  { immediate: Boolean(requestId.value) && Boolean(token.value) },
)

const booking = computed(() => data.value?.booking ?? null)
const isTable = computed(() => booking.value?.product_kind === 'table')
const keyPrefix = computed(() => isTable.value ? 'reservation_cancel' : 'experience_cancel')
const copy = (key: string) => t(`site.${keyPrefix.value}.${key}`)
useSocialMetadata(() => ({
  path: route.path,
  title: copy('title'),
  description: copy('cancel_visit'),
  socialImage: null,
  discoverability: 'private',
}))

const presentation = computed(() => booking.value?.product_kind ? presentationForProduct({ kind: booking.value.product_kind }) : null)
// One instant plus its zone: the guest reads the local time of the place they
// booked, not of the browser they happen to open the link in.
const readableDate = computed(() => booking.value
  ? formatTimestamp(booking.value.starts_at, locale.value, booking.value.timezone, { dateStyle: 'full' })
  : '')
const readableTime = computed(() => booking.value
  ? formatTimestamp(booking.value.starts_at, locale.value, booking.value.timezone, { timeStyle: 'short' })
  : '')
// Where a guest goes to start over: the catalogue they booked from, or the
// reservations page for a table. A site whose vertical presents no catalogue
// sends them home rather than to a route that does not exist.
const startOverHref = computed(() => localePath(isTable.value ? '/reservations' : (presentation.value?.collectionPath ?? '/')))

// The offering's advance notice closes the guest's own cancellation, as the cancel route refuses it.
// A page left open past the cutoff learns it from the server's refusal.
const closedByServer = ref(false)
const cancellationClosed = computed(() => closedByServer.value || Boolean(booking.value && booking.value.advance_notice_minutes !== null && !outsideNotice(booking.value.starts_at, booking.value.advance_notice_minutes)))
const cancellationSubmitted = ref(false)
const cancelled = computed(() => cancellationSubmitted.value || booking.value?.status === 'cancelled')
const loading = ref(false)
const cancelError = ref('')

async function handleCancel() {
  if (loading.value) return
  loading.value = true
  cancelError.value = ''
  try {
    await publicApiMutation<{ success: true }>(`/api/public/booking-requests/${requestId.value}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}` },
      validate: (value): value is { success: true } => isRecord(value) && value.success === true,
    })
    cancellationSubmitted.value = true
  } catch (err) {
    if (err instanceof ApiClientError && err.code === 'cancellation_closed') { closedByServer.value = true; return }
    const message = (err as { data?: { error?: string } })?.data?.error
    cancelError.value = message || (booking.value?.can_retry_cancellation ? copy('toast_refund_failed') : copy('toast_cancel_failed'))
  } finally {
    loading.value = false
  }
}
</script>
