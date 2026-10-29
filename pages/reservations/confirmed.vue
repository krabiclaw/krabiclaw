<template>
  <div class="min-h-screen bg-default text-default">
    <template v-if="pending">
      <div class="flex min-h-screen items-center justify-center">
        <TenantIcon name="arrow-path" class="size-12 animate-spin text-muted" />
      </div>
    </template>

    <BookingConfirmation
      v-else-if="confirmation"
      :kicker="receiptTitle"
      :cancelled="confirmation.status === 'cancelled'"
      :item-title="confirmation.locationName || confirmation.organizationName"
      :item-subtitle="confirmation.locationName ? confirmation.organizationName : ''"
      :image-url="confirmation.imageUrl"
      :receipt-rows="receiptRows"
      :next-steps-kicker="resolvedPolicySummary?.heading ?? resCopy.reservationPoliciesHeading"
      :next-steps="policyLines"
      :next-steps-notes-html="resolvedPolicySummary?.additional_notes_html ?? ''"
      :cta-label="resCopy.reservationExploreLabel"
      :cta-to="menuCtaTo"
      :guest-email="confirmation.guestEmail"
    >
      <template #title>
        {{ confirmation.status === 'cancelled' ? t('site.reservation_cancel.cancelled_title') : resCopy.thankYouLabel(confirmation.guestName) }}
      </template>
      <template #subtitle>
        {{ confirmation.status === 'cancelled' ? t('site.reservation_cancel.cancelled_desc', { date: readableDate }) : resCopy.confirmationMessage(
          confirmation.guests,
          Number(confirmation.guests) === 1 ? resCopy.guestLabel : resCopy.guestsLabelPlural,
          readableDate,
          readableTime
        ) }}
      </template>
      <template #actions>
        <TenantButton v-if="confirmation.manageUrl" :href="confirmation.manageUrl" variant="outline">{{ t('booking.manage_account') }}</TenantButton>
        <TenantButton v-if="confirmation.status !== 'cancelled'" variant="soft" @click="share">
          <TenantIcon name="share" class="mr-1.5 size-4" />
          {{ t(justCopied ? 'social_posts.link_copied' : 'social_posts.share') }}
        </TenantButton>
        <TenantButton v-if="confirmation.contactPhone" :href="`tel:${confirmation.contactPhone}`" variant="outline">
          {{ resCopy.callUsLabel(formatPhone(confirmation.contactPhone)) }}
        </TenantButton>
        <TenantButton v-if="confirmation.cancelUrl" :to="confirmation.cancelUrl" color="error" variant="ghost">
          {{ resCopy.cancelLabel(resCopy.reservationWord) }}
        </TenantButton>
        <p v-if="confirmation.manageUrl" class="w-full text-sm text-muted">{{ t('booking.manage_account_help') }}</p>
      </template>
    </BookingConfirmation>

    <div v-else class="mx-auto max-w-xl px-4 pt-24 pb-24 text-center sm:px-6 lg:px-8">
      <TenantIcon name="exclamation-triangle" class="mx-auto size-12 text-error" />
      <h2 class="mt-6 text-xl font-bold">{{ t(loadError ? 'booking.receipt_failed' : 'booking.receipt_missing') }}</h2>
      <p class="mt-2 text-muted">{{ loadError ?? t('booking.receipt_missing_description') }}</p>
      <TenantButton :to="localePath('/reservations')" variant="soft" class="mt-10">{{ resCopy.selectTimeLabel }}</TenantButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import { loadBookingConfirmation, type BookingConfirmation as BookingConfirmationData } from '~/composables/useBookingHandoff'
import BookingConfirmation from '~/components/booking/BookingConfirmation.vue'
import { formatTimestamp } from '~/utils/timezone'
import { paymentMoney } from '~/shared/payment-display'
import { resolveProductPresentation } from '~/utils/product-presentation'
import type { RenderedBookingPolicySummaryItem } from '~/server/utils/reservations'

definePageMeta({ layout: 'tenant' })

const { organization } = useTenantOrganization()
const { id: organizationId } = organization
const { locale, localePath, t } = useI18n()
const resCopy = computed(() => getVerticalCopy((organization as ApiValue)?.vertical, locale.value))
const route = useRoute()
const justCopied = ref(false)

const confirmation = ref<BookingConfirmationData | null>(null)
const pending = ref(true)
const loadError = ref<string | null>(null)
const receiptTitle = computed(() => t(confirmation.value?.status === 'cancelled' ? 'site.reservation_cancel.cancelled_title' : 'reservations.confirmed'))

// One instant plus one zone, read in the location's own zone — the guest sees
// the hour the table is held, wherever they open the page.
const readableDate = computed(() => confirmation.value
  ? formatTimestamp(confirmation.value.startsAt, locale.value, confirmation.value.timezone, { dateStyle: 'full' })
  : '')
const readableTime = computed(() => confirmation.value
  ? formatTimestamp(confirmation.value.startsAt, locale.value, confirmation.value.timezone, { timeStyle: 'short' })
  : '')

const receiptRows = computed(() => {
  if (!confirmation.value) return []
  const rows: Array<{ label: string; value: string; wide?: boolean }> = []
  rows.push({ label: resCopy.value.dateLabel, value: readableDate.value })
  rows.push({ label: resCopy.value.timeLabel, value: readableTime.value })
  rows.push({
    label: resCopy.value.guestsLabel,
    value: `${confirmation.value.guests} ${Number(confirmation.value.guests) === 1 ? resCopy.value.guestLabel : resCopy.value.guestsLabelPlural}`,
  })
  rows.push({ label: resCopy.value.nameLabel, value: confirmation.value.guestName })
  if (confirmation.value.requests) rows.push({ label: resCopy.value.specialRequestsLabel, value: confirmation.value.requests, wide: true })
  if (confirmation.value.paid) rows.push({ label: t('payment.paid'), value: paymentMoney(confirmation.value.paid.amount, confirmation.value.paid.currency) })
  return rows
})

const resolvedPolicySummary = computed(() => confirmation.value?.policySummary ?? null)

const policyLines = computed(() => (resolvedPolicySummary.value?.items ?? []).map((item: RenderedBookingPolicySummaryItem) => String(item.text ?? '')))

// Back to the catalogue the guest reserved against: this location's own when
// the reservation names one, otherwise the site's.
const presentation = computed(() => resolveProductPresentation((organization as { vertical?: string | null } | null)?.vertical))
const menuCtaTo = computed(() => {
  const slug = confirmation.value?.locationSlug
  if (slug && presentation.value) return localePath(`/locations/${slug}/${presentation.value.locationCollectionSegment}`)
  return localePath(resCopy.value.reservationExploreRoute)
})

onMounted(async () => {
  if (!organizationId) {
    pending.value = false
    return
  }

  try {
    confirmation.value = await loadBookingConfirmation(organizationId, 'reservation', String((organization as ApiValue)?.name ?? ''), {
      id: typeof route.query.id === 'string' ? route.query.id : '', token: route.hash.slice(1),
    }, { locale: locale.value, localePath, t })
  } catch (cause) {
    loadError.value = getErrorMessage(cause, t('booking.receipt_failed'))
  }
  pending.value = false
})

async function share() {
  if (!confirmation.value || confirmation.value.status === 'cancelled') return
  const text = [receiptTitle.value, confirmation.value.organizationName, readableDate.value, readableTime.value].join(' · ')
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
  path: localePath('/reservations/confirmed'),
  title: receiptTitle.value,
  description: confirmation.value?.status === 'cancelled' ? t('site.reservation_cancel.cancelled_desc', { date: readableDate.value }) : t('booking.confirmed_message'),
  socialImage: null,
  discoverability: 'private',
}))
</script>
