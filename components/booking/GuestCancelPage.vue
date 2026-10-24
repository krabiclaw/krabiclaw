<template>
  <div class="min-h-screen bg-default text-default">
    <header class="mx-auto max-w-7xl px-4 pt-16 pb-10 text-center sm:px-6 lg:px-8">
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
          <h2 class="tenant-display tenant-italic text-3xl">{{ copy('cancel_visit') }}</h2>
          <div class="mt-6 space-y-2 border-y border-default py-6 text-sm">
            <p><strong>{{ copy(kind === 'booking' ? 'booking_for' : 'reservation_for') }}</strong> {{ booking.name }}</p>
            <p v-if="booking.product_name"><strong>{{ booking.product_name }}</strong></p>
            <p><strong>{{ copy('date') }}</strong> {{ readableDate }}</p>
            <p><strong>{{ copy('time') }}</strong> {{ readableTime }}</p>
            <p><strong>{{ copy('guests') }}</strong> {{ booking.guests }}</p>
          </div>
          <p v-if="cancelError" class="mt-4 text-sm text-error">{{ cancelError }}</p>
          <div class="mt-10 flex flex-col gap-3">
            <TenantButton color="error" size="lg" block :loading="loading" @click="handleCancel">
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
            <TenantButton v-if="booking.can_retry_cancellation && !cancellationSubmitted" class="mb-3" size="lg" block :loading="loading" @click="handleCancel">{{ t('site.reservation_cancel.retry_refund') }}</TenantButton>
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

/**
 * The page a guest's cancellation link opens.
 *
 * A booking and a reservation are cancelled by the same act through the same
 * endpoint; only the words differ, so the wording is the one thing this takes
 * as a parameter.
 */
const props = defineProps<{ kind: 'reservation' | 'booking' }>()

const { locale, localePath, t } = useI18n()
const route = useRoute()

const keyPrefix = computed(() => props.kind === 'booking' ? 'experience_cancel' : 'reservation_cancel')
const copy = (key: string) => t(`site.${keyPrefix.value}.${key}`)
const requestId = computed(() => typeof route.query.id === 'string' ? route.query.id : '')
const token = computed(() => route.hash ? route.hash.slice(1) : '')

useSocialMetadata(() => ({
  path: route.path,
  title: copy('title'),
  description: copy('cancel_visit'),
  socialImage: null,
  discoverability: 'private',
}))

interface GuestBookingView {
  kind: 'booking' | 'reservation'
  name: string
  starts_at: string
  timezone: string
  guests: string
  status: string
  can_retry_cancellation: boolean
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
// reservations page. A site whose vertical presents no catalogue sends them
// home rather than to a route that does not exist.
const startOverHref = computed(() => localePath(props.kind === 'booking'
  ? (presentation.value?.collectionPath ?? '/')
  : '/reservations'))

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
    const message = (err as { data?: { error?: string } })?.data?.error
    cancelError.value = message || (booking.value?.can_retry_cancellation ? t('site.reservation_cancel.toast_refund_failed') : copy('toast_cancel_failed'))
  } finally {
    loading.value = false
  }
}
</script>
