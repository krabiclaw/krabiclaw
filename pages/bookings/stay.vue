<template>
  <NuxtLayout :name="template.layout">
  <div class="min-h-screen bg-default text-default">
    <div v-if="pending" class="flex min-h-screen items-center justify-center">
      <TenantIcon name="arrow-path" class="size-12 animate-spin text-muted" />
    </div>
    <BookingConfirmation
      v-else-if="guestStay"
      :kicker="receiptTitle"
      :cancelled="guestStay.stay.status === 'cancelled'"
      :item-title="guestStay.home.name"
      :item-subtitle="guestStay.home.organization_name"
      :image-url="guestStay.home.image_url"
      :receipt-rows="receiptRows"
      :next-steps-kicker="t('stay.cancellation_policy')"
      :next-steps="policy ? [...policy.terms] : []"
      next-steps-style="plain"
      :guest-email="guestStay.stay.guest_email"
    >
      <template #title>
        {{ guestStay.stay.status === 'cancelled' ? t('saya.experience_cancel.cancelled_title') : copy.thankYouLabel(guestStay.stay.guest_name ?? '') }}
      </template>
      <template #subtitle>
        {{ receiptDescription }}
      </template>
    </BookingConfirmation>

    <div v-else class="mx-auto max-w-xl px-4 pt-24 pb-24 text-center sm:px-6 lg:px-8">
      <TenantIcon name="exclamation-triangle" class="mx-auto size-12 text-error" />
      <h2 class="mt-6 text-xl font-bold">{{ t(loadError ? 'booking.receipt_failed' : 'booking.receipt_missing') }}</h2>
      <p class="mt-2 text-muted">{{ loadError ?? t('stay.receipt_missing_description') }}</p>
      <TenantButton :to="localePath('/')" variant="soft" class="mt-10">{{ t('site_pages.home') }}</TenantButton>
    </div>
  </div>
  </NuxtLayout>
</template>

<script setup lang="ts">
// A stay paid on this site, confirmed here as a visit is: by the link that names and signs it.
import BookingConfirmation from '~/components/booking/BookingConfirmation.vue'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate, formatTime } from '~/utils/timezone'
import { isRecord, publicApiRequest } from '~/utils/api-clients'
import type { GuestStay } from '~/server/domain/stays'

definePageMeta({ layout: false })
useResponseHeader('cache-control').value = 'private, no-store'

const { locale, localePath, t } = useI18n()
const route = useRoute()
const { organization } = useTenantOrganization()
const { template } = organization
const copy = computed(() => getVerticalCopy(organization.vertical, locale.value))

const isGuestStay = (value: unknown): value is GuestStay => isRecord(value) && typeof value.organization_id === 'string' && isRecord(value.stay) && isRecord(value.home)
  && typeof value.stay.check_in_date === 'string' && typeof value.stay.check_out_date === 'string' && typeof value.home.name === 'string'
const guestStay = ref<GuestStay | null>(null)
const pending = ref(true)
const loadError = ref<string | null>(null)

onMounted(async () => {
  const id = typeof route.query.id === 'string' ? route.query.id : ''
  try {
    // The link's signature is in the fragment: no server log or referrer sees it.
    if (id) guestStay.value = await publicApiRequest<GuestStay>(`/api/public/guest-stays/${encodeURIComponent(id)}`, { validate: isGuestStay, headers: { Authorization: `Bearer ${route.hash.slice(1)}` } })
  } catch (cause) {
    loadError.value = getErrorMessage(cause, t('booking.receipt_failed'))
  } finally {
    pending.value = false
  }
})

const policy = computed(() => guestStay.value?.stay.cancellation_policy ? bookedPolicyTerms(guestStay.value.stay.cancellation_policy) : null)
const receiptTitle = computed(() => t(guestStay.value?.stay.status === 'cancelled' ? 'saya.experience_cancel.cancelled_title' : guestStay.value?.stay.status === 'pending' ? 'booking.request_received' : 'stay.confirmed_title'))
const day = (date: string) => formatCalendarDate(date, locale.value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const receiptDescription = computed(() => {
  const value = guestStay.value
  if (!value) return ''
  if (value.stay.status === 'cancelled') return t('saya.experience_cancel.cancelled_desc', { date: day(value.stay.check_in_date) })
  return value.stay.status === 'pending' ? t('booking.pending_message') : t('stay.confirmed_message', { home: value.home.name })
})
// The receipt the guest's confirmation email gives, at the home's own check-in and checkout times.
const receiptRows = computed(() => {
  const value = guestStay.value
  if (!value) return []
  const { stay, home } = value
  const nights = Math.round((Date.parse(`${stay.check_out_date}T00:00:00Z`) - Date.parse(`${stay.check_in_date}T00:00:00Z`)) / 86_400_000)
  return [
    { label: t('stay.check_in'), value: `${day(stay.check_in_date)} · ${formatTime(home.check_in_time, locale.value)}` },
    { label: t('stay.check_out'), value: `${day(stay.check_out_date)} · ${formatTime(home.check_out_time, locale.value)}` },
    { label: t('stay.nights'), value: String(nights) },
    { label: t('stay.guests'), value: String(stay.adults + stay.children) },
    { label: t('payment.paid'), value: paymentMoney(stay.paid_minor, stay.currency) },
  ]
})

useSocialMetadata(() => ({
  path: localePath('/bookings/stay'),
  title: receiptTitle.value,
  description: receiptDescription.value,
  socialImage: null,
  discoverability: 'private',
}))
</script>
