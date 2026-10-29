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
        {{ guestStay.stay.status === 'cancelled' ? t('site.experience_cancel.cancelled_title') : copy.thankYouLabel(guestStay.stay.guest_name ?? '') }}
      </template>
      <template #subtitle>
        {{ receiptDescription }}
      </template>
      <template #actions>
        <TenantButton v-if="guestStay.manage_url" :href="guestStay.manage_url" variant="outline">{{ t('booking.manage_account') }}</TenantButton>
        <TenantButton v-if="guestStay.home.location?.maps_url" :href="guestStay.home.location.maps_url" variant="outline" target="_blank" rel="noopener noreferrer">
          {{ t('site.experience_detail.open_in_maps') }}
        </TenantButton>
        <TenantButton v-if="guestStay.stay.request_id" :href="messageHostUrl" variant="outline">{{ t('stay.message_host') }}</TenantButton>
        <p v-if="guestStay.manage_url" class="w-full text-sm text-muted">{{ t('booking.manage_account_help') }}</p>
      </template>
      <template v-if="guestStay.home.arrival_guide" #details>
        <section class="mt-10 border-t border-default pt-8">
          <h2 class="mb-6 text-xl font-semibold text-default">{{ t('stay.arrival_guide') }}</h2>
          <StayArrivalGuideView :guide="guestStay.home.arrival_guide" :rules="guestStay.home.house_rules" :safety="guestStay.home.safety" />
        </section>
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
// The guest's own stay, opened by the confirmation link that names and signs it.
import BookingConfirmation from '~/components/booking/BookingConfirmation.vue'
import StayArrivalGuideView from '~/components/booking/StayArrivalGuide.vue'
import { isGuestStay } from '~/shared/stay-arrival'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate, formatTime } from '~/utils/timezone'
import { formatPostalAddress } from '~/utils/postal-address'
import { publicApiRequest } from '~/utils/api-clients'
import type { GuestStay } from '~/server/domain/stays'

definePageMeta({ layout: false })
useResponseHeader('cache-control').value = 'private, no-store'

const { locale, localePath, t } = useI18n()
const route = useRoute()
const { organization } = useTenantOrganization()
const { template } = organization
const copy = computed(() => getVerticalCopy(organization.vertical, locale.value))

type ManagedGuestStay = GuestStay & { manage_url: string | null }
const guestStay = ref<ManagedGuestStay | null>(null)
const platformDomain = useRuntimeConfig().public.platformDomain
const messageHostUrl = computed(() => new URL(`/dashboard/account/messages/${encodeURIComponent(guestStay.value!.stay.request_id!)}`, platformDomain).toString())
const pending = ref(true)
const loadError = ref<string | null>(null)

onMounted(async () => {
  const id = typeof route.query.id === 'string' ? route.query.id : ''
  try {
    // The link's signature is in the fragment: no server log or referrer sees it.
    if (id) guestStay.value = await publicApiRequest<ManagedGuestStay>(`/api/public/guest-stays/${encodeURIComponent(id)}`, {
      validate: (value): value is ManagedGuestStay => isGuestStay(value) && 'manage_url' in value && (value.manage_url === null || (typeof value.manage_url === 'string' && URL.canParse(value.manage_url))),
      headers: { Authorization: `Bearer ${route.hash.slice(1)}` },
    })
  } catch (cause) {
    loadError.value = getErrorMessage(cause, t('booking.receipt_failed'))
  } finally {
    pending.value = false
  }
})

const policy = computed(() => guestStay.value?.stay.cancellation_policy ? bookedPolicyTerms(guestStay.value.stay.cancellation_policy) : null)
const receiptTitle = computed(() => t(guestStay.value?.stay.status === 'cancelled' ? 'site.experience_cancel.cancelled_title' : guestStay.value?.stay.status === 'pending' ? 'booking.request_received' : 'stay.confirmed_title'))
const day = (date: string) => formatCalendarDate(date, locale.value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const receiptDescription = computed(() => {
  const value = guestStay.value
  if (!value) return ''
  if (value.stay.status === 'cancelled') return t('site.experience_cancel.cancelled_desc', { date: day(value.stay.check_in_date) })
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
    ...(home.location?.address ? [{ label: t('site.location.address'), value: formatPostalAddress(home.location.address), wide: true }] : []),
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
