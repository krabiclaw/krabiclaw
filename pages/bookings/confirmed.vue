<template>
  <NuxtLayout :name="template.layout">
  <div class="min-h-screen bg-default text-default">
    <div v-if="pending" class="flex min-h-screen items-center justify-center">
      <TenantIcon name="arrow-path" class="size-12 animate-spin text-muted" />
    </div>
    <BookingConfirmation
      v-else-if="confirmation"
      :kicker="receiptTitle"
      :cancelled="confirmation.status === 'cancelled'"
      :item-title="confirmation.title || organizationName"
      :item-subtitle="itemSubtitle"
      :image-url="confirmation.imageUrl"
      :receipt-rows="receiptRows"
      :next-steps-kicker="resolvedPolicySummary?.heading ?? t(confirmation.productKind === 'service' ? 'booking_policy.consultation_heading' : 'booking_policy.experience_heading')"
      :next-steps="policyLines"
      :next-steps-notes-html="resolvedPolicySummary?.additional_notes_html ?? ''"
      :cta-label="browseLabel"
      :cta-to="browseHref"
      :guest-email="confirmation.guestEmail"
    >
      <template #title>
        {{ confirmation.status === 'cancelled' ? t('site.experience_cancel.cancelled_title') : copy.thankYouLabel(confirmation.guestName) }}
      </template>
      <template #subtitle>
        {{ receiptDescription }}
      </template>
      <template #actions>
        <TenantButton v-if="confirmation.status !== 'cancelled'" variant="soft" @click="share">
          <TenantIcon name="share" class="mr-1.5 size-4" />
          {{ t(justCopied ? 'social_posts.link_copied' : 'social_posts.share') }}
        </TenantButton>
        <TenantButton v-if="confirmation.contactPhone" :href="`tel:${confirmation.contactPhone}`" variant="outline">
          {{ copy.callUsLabel(formatPhone(confirmation.contactPhone)) }}
        </TenantButton>
        <TenantButton v-if="confirmation.cancelUrl" :to="confirmation.cancelUrl" color="error" variant="ghost">
          {{ t('site.experience_cancel.title') }}
        </TenantButton>
      </template>
    </BookingConfirmation>

    <div v-else class="mx-auto max-w-xl px-4 pt-24 pb-24 text-center sm:px-6 lg:px-8">
      <TenantIcon name="exclamation-triangle" class="mx-auto size-12 text-error" />
      <h2 class="mt-6 text-xl font-bold">{{ t(loadError ? 'booking.receipt_failed' : 'booking.receipt_missing') }}</h2>
      <p class="mt-2 text-muted">{{ loadError ?? t('booking.receipt_missing_description') }}</p>
      <TenantButton :to="browseHref" variant="soft" class="mt-10">{{ browseLabel }}</TenantButton>
    </div>
  </div>
  </NuxtLayout>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import { loadBookingConfirmation, type BookingConfirmation as BookingConfirmationData } from '~/composables/useBookingHandoff'
import BookingConfirmation from '~/components/booking/BookingConfirmation.vue'
import { formatTimestamp } from '~/utils/timezone'
import { paymentMoney } from '~/shared/payment-display'
import { presentationForProduct } from '~/utils/product-presentation'
import type { RenderedBookingPolicySummaryItem } from '~/server/utils/reservations'

definePageMeta({ layout: false })

const { locale, localePath, t } = useI18n()
const route = useRoute()
const justCopied = ref(false)
const { organization } = useTenantOrganization()
const { id: organizationId, template } = organization

const confirmation = ref<BookingConfirmationData | null>(null)
const pending = ref(true)
const loadError = ref<string | null>(null)
const copy = computed(() => getVerticalCopy((organization as { vertical?: string | null } | null)?.vertical, locale.value))
const presentation = computed(() => confirmation.value?.productKind ? presentationForProduct(organization.vertical, { kind: confirmation.value.productKind }) : null)
// Back to where the guest booked from: this location's own catalogue when the
// booking names one, otherwise the site's.
const browseHref = computed(() => {
  if (!presentation.value) return localePath('/')
  if (!confirmation.value?.locationId && (isLegalPractice(organization.vertical) || confirmation.value?.productKind === 'service')) return localePath('/schedule')
  const locationSlug = confirmation.value?.locationSlug
  return localePath(locationSlug
    ? `/locations/${locationSlug}/${presentation.value.locationCollectionSegment}`
    : presentation.value.collectionPath)
})
const browseLabel = computed(() => confirmation.value?.productKind === 'experience'
  ? t('site.header.experiences')
  : !confirmation.value?.locationId && (isLegalPractice(organization.vertical) || confirmation.value?.productKind === 'service')
    ? t('site_pages.schedule')
    : copy.value.reservationExploreLabel)
const receiptTitle = computed(() => t(confirmation.value?.status === 'cancelled' ? 'site.experience_cancel.cancelled_title' : confirmation.value?.status === 'pending' ? 'booking.request_received' : 'booking.confirmed'))
const receiptDescription = computed(() => confirmation.value?.status === 'cancelled'
  ? t('site.experience_cancel.cancelled_desc', { date: readableDate.value })
  : t(confirmation.value?.status === 'pending' ? 'booking.pending_message' : 'booking.confirmed_message'))

onMounted(async () => {
  try {
    if (organizationId) confirmation.value = await loadBookingConfirmation(organizationId, 'booking', String((organization as ApiValue)?.name ?? ''), {
      id: typeof route.query.id === 'string' ? route.query.id : '', token: route.hash.slice(1),
    }, { locale: locale.value, localePath, t })
  } catch (cause) {
    loadError.value = getErrorMessage(cause, t('booking.receipt_failed'))
  } finally {
    pending.value = false
  }
})

// One instant plus one zone, formatted where the booking happens — the guest
// reads the venue's clock, not their browser's.
const readableDate = computed(() => confirmation.value
  ? formatTimestamp(confirmation.value.startsAt, locale.value, confirmation.value.timezone, { dateStyle: 'full' })
  : '')
const readableTime = computed(() => confirmation.value
  ? formatTimestamp(confirmation.value.startsAt, locale.value, confirmation.value.timezone, { timeStyle: 'short' })
  : '')

const organizationName = String((organization as ApiValue)?.name ?? '')
// Where it happens, under what was booked: the place, or online.
const itemSubtitle = computed(() => !confirmation.value ? '' : !confirmation.value.locationId ? t('booking.online') : confirmation.value.locationName ?? '')
const receiptRows = computed(() => {
  if (!confirmation.value) return []
  const rows: Array<{ label: string; value: string; wide?: boolean }> = []
  rows.push({ label: copy.value.dateLabel, value: readableDate.value })
  rows.push({ label: copy.value.timeLabel, value: readableTime.value })
  if (!confirmation.value.locationId) rows.push({ label: t('booking.timezone'), value: confirmation.value.timezone })
  if ((organization as { vertical?: string | null } | null)?.vertical !== 'service') {
    rows.push({ label: copy.value.guestsLabel, value: String(confirmation.value.guests) })
  }
  if (confirmation.value.requests) rows.push({ label: copy.value.specialRequestsLabel, value: confirmation.value.requests, wide: true })
  if (confirmation.value.paid) rows.push({ label: t('payment.paid'), value: paymentMoney(confirmation.value.paid.amount, confirmation.value.paid.currency) })
  return rows
})

/**
 * The policy the guest agreed to, from the booking that carries it.
 *
 * One source. This used to try the snapshot, then a per-experience policy,
 * then a site default — so a guest could be shown terms that were never the
 * ones their booking was made under. If the snapshot is absent, no terms are
 * shown rather than someone else's.
 */
const resolvedPolicySummary = computed(() =>
  (confirmation.value?.policySummary as ApiRecord | undefined) ?? null)

const policyLines = computed(() => (resolvedPolicySummary.value?.items ?? []).map((item: RenderedBookingPolicySummaryItem) => String(item.text ?? '')))

async function share() {
  if (!confirmation.value || confirmation.value.status === 'cancelled') return
  const text = [receiptTitle.value, confirmation.value.title ?? confirmation.value.organizationName, readableDate.value, readableTime.value].join(' · ')
  if (import.meta.client && navigator.share) {
    try {
      await navigator.share({ title: receiptTitle.value, text, url: window.location.origin + localePath('/') })
      return
    } catch (error) {
      // Cancelling the native share sheet falls through to the clipboard.
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
    }
  }
  if (import.meta.client && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    justCopied.value = true
    setTimeout(() => { justCopied.value = false }, 2000)
  }
}

useSocialMetadata(() => ({
  path: localePath('/bookings/confirmed'),
  title: receiptTitle.value,
  description: receiptDescription.value,
  socialImage: null,
  discoverability: 'private',
}))
</script>
