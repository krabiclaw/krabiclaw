<template>
  <div class="min-h-screen bg-default text-default">
    <header class="mx-auto flex max-w-7xl flex-col items-center px-4 pt-16 pb-14 text-center sm:px-6 lg:px-8 lg:pt-20 lg:pb-18">
      <p class="saya-kicker mb-6 inline-flex items-center justify-center rounded-full border border-default/10 bg-default/3 px-5 py-2 text-center">
        {{ resCopy.reservationPageKicker }}
      </p>
      <h1 v-if="heroTitle" class="saya-display-md max-w-5xl text-default">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span v-html="formatTitleItalics(heroTitle)" />
      </h1>
      <p v-if="heroSubtitle" class="mt-5 max-w-3xl text-balance text-sm leading-relaxed text-muted sm:text-base">
        {{ heroSubtitle }}
      </p>
      
    </header>

    <!-- Location cards -->
    <section v-if="locations.length > 0" class="mx-auto max-w-5xl px-4 pb-20 sm:px-6 lg:px-8">
      <div class="grid gap-8 grid-cols-1 sm:grid-cols-2">
        <article
          v-for="loc in locations"
          :key="loc.id"
          class="overflow-hidden border border-default bg-default"
        >
          <div class="relative aspect-video bg-muted">
            <video
              v-if="getLocationMediaUrl(loc) && getLocationMediaKind(loc) === 'video'"
              :src="getLocationMediaUrl(loc) ?? undefined"
              :poster="getLocationPoster(loc) ?? undefined"
              autoplay
              muted
              loop
              playsinline
              preload="metadata"
              class="h-full w-full object-cover"
            />
            <img
              v-else-if="getLocationMediaUrl(loc)"
              :src="getLocationMediaUrl(loc) ?? undefined"
              :alt="loc.title"
              loading="lazy"
              class="h-full w-full object-cover"
            />
            <div v-else class="flex h-full w-full items-center justify-center" aria-hidden="true">
              <svg viewBox="0 0 24 24" class="size-10 text-muted" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><g><path d="M15 10.5a3 3 0 1 1-6 0a3 3 0 0 1 6 0"/><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0"/></g></svg>
            </div>
            <ClientOnly>
              <div
                v-if="getTodayHoursLabel(loc.opening_hours, resCopy.closedLabel, loc.timezone, new Date(), loc.special_hours, locale)"
                class="absolute bottom-4 left-4 inline-flex items-center gap-2 rounded-full bg-default/95 px-4 py-2 text-xs font-medium uppercase tracking-wide text-default"
              >
                <span class="size-1.5 rounded-full" :class="isOpenNow(loc.opening_hours, loc.timezone, new Date(), loc.special_hours) ? 'bg-green-500' : 'bg-zinc-400'" />
                {{ isOpenNow(loc.opening_hours, loc.timezone, new Date(), loc.special_hours) ? resCopy.openNowLabel : resCopy.closedLabel }} · {{ getTodayHoursLabel(loc.opening_hours, resCopy.closedLabel, loc.timezone, new Date(), loc.special_hours, locale) }}
              </div>
            </ClientOnly>
          </div>

          <div class="flex flex-col items-start p-6 text-left sm:p-8">
            <p v-if="getLocationLabel(loc)" class="saya-eyebrow mb-3 text-muted">{{ getLocationLabel(loc) }}</p>
            <h3 class="saya-display saya-italic text-3xl text-default leading-none sm:text-4xl">{{ loc.title }}</h3>
            <p v-if="loc.short_description" class="mt-3 max-w-md text-sm leading-relaxed text-muted">{{ loc.short_description }}</p>

            <div class="mt-6 flex flex-wrap items-center gap-3">
              <SayaButton control-id="reservation-booking-toggle" @click="openBookingModal(loc)">{{ resCopy.reservationRequestButton }}</SayaButton>
              <SayaButton v-if="loc.phone" :href="`tel:${loc.phone.replace(/\s/g, '')}`" variant="outline">
                {{ loc.phone }}
              </SayaButton>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section v-if="activeReservationPolicySummary" class="bg-muted">
        <div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div class="mb-10 max-w-xl">
            <p class="saya-kicker mb-4">{{ resCopy.goodToKnowKicker }}</p>
            <h2 class="saya-display-sm text-default">{{ activeReservationPolicySummary.heading }}</h2>
          </div>
          <div v-if="activeReservationPolicySummary.items.length > 0" class="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div v-for="item in activeReservationPolicySummary.items" :key="item.id" class="border-t border-default pt-5">
              <p class="text-sm leading-relaxed text-muted">{{ item.text }}</p>
            </div>
          </div>
          <div v-if="activeReservationPolicySummary.additional_notes_html" class="mt-8 max-w-2xl text-sm leading-relaxed text-muted">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-html="activeReservationPolicySummary.additional_notes_html" />
          </div>
        </div>
      </section>

    <!-- Booking Modal Flow -->
    <BookingModal
      v-model="isBookingModalOpen"
      target-id="reservation-booking"
      :title="modalTitle"
      :can-go-back="bookingStep > startStep && !submitting"
      @back="prevStep"
    >
      <!-- STEP: LOCATION (only if multiple locations and not pre-selected from a card) -->
      <div v-if="bookingStep === 1" class="flex-1 overflow-y-auto">
        <BookingLocationStep
          v-model="reservationForm.location_id"
          :locations="bookingLocations"
          @next="nextStep"
        />

        <div v-if="submitError" role="alert" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
          {{ submitError }}
        </div>
      </div>

      <!-- STEP: TIME (party size + day-grouped availability, single scrollable surface) -->
      <div v-if="bookingStep === 2" class="flex flex-1 flex-col min-h-0">
        <BookingTimeStep
          v-model="timeSelection"
          :dates="availabilityDates"
          :loading="availabilityLoading || !isHydrated"
          :guests="guests"
          :guests-label="resCopy.guestsLabel"
          :guest-singular="resCopy.guestLabel"
          :guest-plural="resCopy.guestsLabelPlural"
          @update:guests="guests = $event"
          @next="nextStep"
        />
        <div v-if="submitError" role="alert" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
          {{ submitError }}
        </div>
      </div>

      <!-- STEP: CONTACT -->
      <div v-if="bookingStep === 3" class="flex-1 overflow-y-auto">
        <BookingRecap
          v-if="timeSelection"
          :main-line="`${timeSelection.label.split(',')[0]} · ${formatTime(timeSelection.time, locale)}`"
          :meta-line="`${guests >= 8 ? '8+' : guests} ${guests === 1 ? resCopy.guestLabel : resCopy.guestsLabelPlural}`"
          @edit="bookingStep = 2"
        />
        <BookingContactForm
          :initial-state="{ name: reservationForm.name, email: reservationForm.email, phone: reservationForm.phone, notes: reservationForm.requests }"
          :loading="submitting"
          :submit-text="resCopy.reservationRequestButton"
          phone-required
          @submit="handleContactSubmit"
        />
        <div v-if="submitError" role="alert" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
          {{ submitError }}
        </div>
      </div>
    </BookingModal>
  </div>
</template>

<script setup lang="ts">
import type { SubmissionMeasurement } from '~/composables/useOrganizationConversionTracking'
import { isRecord, publicApiMutation, publicApiRequest, normalizeApiError } from '~/utils/api-clients'
import BookingContactForm from '@/components/booking/BookingContactForm.vue'
import BookingLocationStep from '@/components/booking/BookingLocationStep.vue'
import BookingModal from '@/components/booking/BookingModal.vue'
import BookingRecap from '@/components/booking/BookingRecap.vue'
import BookingTimeStep, { type RawDateAvailability, type TimeSlotSelection } from '@/components/booking/BookingTimeStep.vue'
import { getTodayHoursLabel, isOpenNow, schemaOpeningHours } from '~/shared/reservation-hours'
import { formatTime, localDateAt, isValidInstant, isValidTimezone } from '~/utils/timezone'
import { setBookingConfirmation } from '~/composables/useBookingHandoff'
import { addressPlaceName, formatPostalAddress, schemaPostalAddress, type PostalAddress } from '~/utils/postal-address'
import { mediaStillUrl, type MediaPresentation } from '~/shared/media-placement-contract'

function formatTitleItalics(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\*(.*?)\*/g, '<em class="saya-italic">$1</em>')
}

definePageMeta({ layout: 'saya' })

// The tenant is the organization; `site` is only the shape this composable
// still returns it under.
const { organization } = useTenantOrganization()
const { id: organizationId } = organization
const { locale, localePath, t } = useI18n()
const resCopy = computed(() => getVerticalCopy((organization as ApiValue)?.vertical, locale.value))
const { locations, config, getField, reservationPolicyByLocation } = await usePublicPageData()
// A site whose locations take no reservations has no reservations page, the
// same fact the header uses to offer one.
if (!Object.values(reservationPolicyByLocation.value).some(policy => policy !== null)) {
  throw createError({ statusCode: 404, statusMessage: 'This site does not take reservations' })
}

// The first location card's hero is this route's LCP element.
useHeroLcpPreload(computed(() => {
  const first = locations.value[0]
  return first ? getLocationPoster(first) : null
}))

const activeReservationPolicySummary = computed(() => {
  const locationId = selectedLocation.value?.id ? String(selectedLocation.value.id) : null
  if (!locationId) return null
  if (!Object.prototype.hasOwnProperty.call(reservationPolicyByLocation.value, locationId)) {
    throw createError({ statusCode: 500, statusMessage: 'Reservation policy contract is missing the selected location' })
  }
  return reservationPolicyByLocation.value[locationId]
})

// ── Form state ────────────────────────────────────────────────────────────
const reservationForm = ref({ name: '', email: '', phone: '', location_id: '', date: '', time: '', guests: '', requests: '' })

// ── Contact & Locations ───────────────────────────────────────────────────
const hasMultipleLocations = computed(() => locations.value.length > 1)
const selectedLocation = computed(() =>
  locations.value.find(location => typeof location.id === 'string' && location.id === reservationForm.value.location_id),
)



/**
 * The zone the chosen slot is stated in.
 *
 * A reservation is a wall-clock time at a place, so the place's zone is the
 * only one that can turn it into an instant. A location without one cannot
 * take reservations, and saying so loudly beats booking the wrong hour.
 */
const reservationTimezone = computed(() => {
  const timezone = selectedLocation.value?.timezone
  if (typeof timezone !== 'string' || !timezone) {
    throw createError({ statusCode: 500, statusMessage: 'This location has no timezone set, so a reservation time cannot be read.' })
  }
  return timezone
})

const bookingLocations = computed(() => locations.value.map(location => ({
  ...location,
  todayHours: getTodayHoursLabel(location.opening_hours, resCopy.value.closedLabel, location.timezone, new Date(), location.special_hours, locale.value),
})))


function getLocationLabel(location: ApiRecord): string | null {
  return addressPlaceName(location.address as PostalAddress | null) || null
}

function getLocationMediaKind(location: ApiRecord): 'image' | 'video' | null {
  const media = getLocationMedia(location)
  return media?.kind === 'video' ? 'video' : media?.public_url ? 'image' : null
}

function getLocationMediaUrl(location: ApiRecord): string | null {
  const media = getLocationMedia(location)
  return String(media?.public_url ?? media?.thumbnail_url ?? '') || null
}

function getLocationPoster(location: ApiRecord): string | null {
  const media = getLocationMedia(location)
  return mediaStillUrl(media as MediaPresentation | null)
}

function getLocationMedia(location: ApiRecord): ApiRecord | null {
  return Array.isArray(location.media)
    ? (location.media as ApiRecord[]).find(item => item.slot === 'hero') ?? null
    : null
}

const heroTitle = computed(() => String(getField('hero.title') ?? '').trim())
const heroSubtitle = computed(() => String(getField('hero.subtitle') ?? '').trim())

const contactPhone = computed(() =>
  String(
    selectedLocation.value?.phone
    ?? getField('contact.phone', config.value.contact_phone || '')
    ?? '',
  ),
)
const contactEmail = computed(() =>
  String(
    selectedLocation.value?.email
    ?? getField('contact.email', config.value.contact_email || '')
    ?? '',
  ),
)

// ── Modal State ───────────────────────────────────────────────────────────
const isBookingModalOpen = ref(false)
const isHydrated = ref(false)
onMounted(() => { isHydrated.value = true })
// Skipped when opened from a location card (location is already pre-selected)
// or when the site only has one location to begin with.
const skipLocationStep = ref(false)
const startStep = computed(() => (hasMultipleLocations.value && !skipLocationStep.value) ? 1 : 2)
const bookingStep = ref(startStep.value)
const modalTitle = computed(() => {
  if (bookingStep.value === 1) return resCopy.value.selectLocationLabel
  if (bookingStep.value === 2) return resCopy.value.selectTimeLabel
  return t('saya.experience_detail.your_details')
})

function openBookingModal(loc?: ApiRecord) {
  skipLocationStep.value = Boolean(loc)
  if (loc) reservationForm.value.location_id = String(loc.id ?? '')
  bookingStep.value = startStep.value
}

function nextStep() {
  submitError.value = null
  bookingStep.value++
}

function prevStep() {
  submitError.value = null
  if (bookingStep.value > startStep.value) {
    bookingStep.value--
  } else {
    isBookingModalOpen.value = false
  }
}

// ── Guests & time slot ────────────────────────────────────────────────────
const guests = ref(2)
const timeSelection = ref<TimeSlotSelection | null>(null)

// ── Availability (day-grouped, capacity-aware — server/utils/reservations.ts) ──
const availabilityDates = ref<RawDateAvailability[]>([])
const availabilityLoading = ref(false)
const submitError = ref<string | null>(null)

let availabilityRequestId = 0

async function loadAvailability() {
  if (!organizationId || !reservationForm.value.location_id) {
    availabilityDates.value = []
    return
  }
  const requestId = ++availabilityRequestId
  const locationId = reservationForm.value.location_id
  availabilityLoading.value = true
  try {
    const dateStr = localDateAt(new Date(), reservationTimezone.value)
    const res = await publicApiRequest(`/api/public/reservations/availability`, {
      query: { location_id: locationId, date: dateStr, days: 14 },
      validate: (value): value is { dates: RawDateAvailability[] } => isRecord(value) && Array.isArray(value.dates)
        && value.dates.every(day => isRecord(day) && typeof day.date === 'string' && Array.isArray(day.slots)
          && day.slots.every(slot => isRecord(slot) && typeof slot.time_slot === 'string' && (slot.capacity === null || Number.isSafeInteger(slot.capacity))
            && (slot.remaining === null || Number.isSafeInteger(slot.remaining)) && typeof slot.is_closed === 'boolean' && typeof slot.is_full === 'boolean')),
    })
    // Ignore stale responses from a location that was changed away from before this resolved
    if (requestId !== availabilityRequestId || locationId !== reservationForm.value.location_id) return
    availabilityDates.value = res.dates
  } catch (error) {
    if (requestId !== availabilityRequestId || locationId !== reservationForm.value.location_id) return
    availabilityDates.value = []
    submitError.value = error instanceof Error ? error.message : 'Failed to load availability'
  } finally {
    if (requestId === availabilityRequestId) availabilityLoading.value = false
  }
}

watch(() => reservationForm.value.location_id, (id) => {
  if (id && import.meta.client) {
    timeSelection.value = null
    loadAvailability()
  }
}, { immediate: true })

// ── Submission ────────────────────────────────────────────────────────────
const submitting = ref(false)
let reservationRequestKey: string | null = null
let reservationFingerprint: string | null = null
const { mirrorSubmission, pageEventId, trackCheckoutStart } = useOrganizationConversionTracking()
let checkoutStarted = false
watch([isBookingModalOpen, () => reservationForm.value.location_id], ([open, locationId]) => {
  if (!open) { checkoutStarted = false; return }
  if (locationId && !checkoutStarted) {
    checkoutStarted = true
    trackCheckoutStart(null, locationId, null)
  }
}, { immediate: true })

async function handleContactSubmit(contactState: { name: string, email: string, phone?: string, notes?: string }) {
  reservationForm.value.name = contactState.name
  reservationForm.value.email = contactState.email
  reservationForm.value.phone = contactState.phone ?? ''
  reservationForm.value.requests = contactState.notes ?? ''

  await handleReservation()
}

async function handleReservation() {
  if (submitting.value || !organizationId || !timeSelection.value) return
  reservationForm.value.date = timeSelection.value.day
  reservationForm.value.time = timeSelection.value.time
  reservationForm.value.guests = guests.value >= 8 ? '8+' : String(guests.value)

  submitting.value = true
  submitError.value = null
  try {
    const details = { ...reservationForm.value, name: reservationForm.value.name.trim(), email: reservationForm.value.email.trim(), phone: reservationForm.value.phone.trim(), requests: reservationForm.value.requests.trim() }
    const fingerprint = JSON.stringify(details)
    if (fingerprint !== reservationFingerprint) {
      reservationRequestKey = crypto.randomUUID()
      reservationFingerprint = fingerprint
    }
    reservationRequestKey ??= crypto.randomUUID()
    type ReservationReceipt = { success: true; status: 'confirmed'; id: string; request_id: string; operational_reservation_id: string; starts_at: string; ends_at: string; timezone: string; cancellationToken: string; policy_summary?: ApiRecord | null; measurement?: SubmissionMeasurement }
      | { success: true; status: 'checkout'; payment_id: string; checkout_url: string; expires_at: string }
    const res = await publicApiMutation(`/api/public/reservations`, {
      method: 'POST',
      body: { ...details, idempotency_key: reservationRequestKey, locale: locale.value, page_event_id: await pageEventId() },
      validate: (value): value is ReservationReceipt => isRecord(value) && value.success === true && (
        value.status === 'checkout' ? typeof value.payment_id === 'string' && typeof value.checkout_url === 'string' && /^https:\/\/checkout\.stripe\.com\//.test(value.checkout_url) && isValidInstant(value.expires_at)
        : value.status === 'confirmed' && typeof value.id === 'string' && typeof value.request_id === 'string' && typeof value.operational_reservation_id === 'string' && typeof value.cancellationToken === 'string'
          && isValidInstant(value.starts_at) && isValidInstant(value.ends_at) && typeof value.timezone === 'string' && isValidTimezone(value.timezone)),
    })
    if (res.status === 'checkout') {
      await navigateTo(res.checkout_url, { external: true })
      return
    }
    setBookingConfirmation({
      type: 'reservation',
      locale: locale.value,
      organizationId,
      organizationName: brandName.value,
      guestName: reservationForm.value.name,
      guestEmail: reservationForm.value.email,
      operationalBookingId: res.operational_reservation_id,
      requestId: res.request_id,
      startsAt: res.starts_at,
      timezone: res.timezone,
      guests: reservationForm.value.guests,
      requests: reservationForm.value.requests || null,
      cancelUrl: res?.id && res?.cancellationToken ? `${localePath('/reservations/cancel')}?id=${encodeURIComponent(res.id)}#${res.cancellationToken}` : null,
      contactPhone: contactPhone.value || null,
      contactEmail: contactEmail.value || null,
      policySummary: res.policy_summary ? { ...res.policy_summary, additional_notes_html: activeReservationPolicySummary.value?.additional_notes_html ?? null } : null,
      locationId: selectedLocation.value?.id ? String(selectedLocation.value.id) : null,
      locationName: selectedLocation.value?.title ?? null,
      locationAddress: formatPostalAddress((selectedLocation.value?.address ?? null) as PostalAddress | null) || null,
      locationSlug: typeof selectedLocation.value?.slug === 'string' ? selectedLocation.value.slug : null,
    })
    mirrorSubmission('reservation_submit', res.measurement, selectedLocation.value?.id ? String(selectedLocation.value.id) : null)
    await navigateTo({ path: localePath('/reservations/confirmed'), query: { id: res.request_id }, hash: `#${res.cancellationToken}` })
    reservationRequestKey = null
    reservationFingerprint = null
  } catch (err) {
    const error = normalizeApiError(err)
    if (error.statusCode === 409 && error.code === 'capacity_unavailable') {
      // Conflict (slot filled or capacity exceeded) — revert to time selection and reload availability
      bookingStep.value = 2
      timeSelection.value = null
      submitError.value = error.message
      await loadAvailability()
    } else {
      submitError.value = error.message
    }
  } finally {
    submitting.value = false
  }
}

// ── SEO ───────────────────────────────────────────────────────────────────
const requestUrl = useRequestURL()

const brandName = computed(() => String((organization as ApiValue)?.name ?? '').trim())
// A page about the business: its image is the organization's.
useSocialMetadata(() => ({
  path: '/reservations',
  socialImage: organization.social_image,
  title: `${brandName.value} | ${resCopy.value.reserveCta}`,
  description: resCopy.value.seoReservationDescription(brandName.value),
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Reservations', url: '/reservations' },
  ],
  discoverability: 'listed',
}))

/**
 * The business, and the places it takes reservations at.
 *
 * `acceptsReservations` is the machine-readable form of what this whole page
 * is: without it a parser reads a reservation form and a ReserveAction and
 * still has nowhere to learn that the restaurant takes bookings.
 *
 * Hours and addresses belong to a branch, not to the brand — two branches keep
 * two of each — so each one states its own rather than one node averaging them
 * into a claim that is true of neither.
 */
useSchemaOrg(computed(() => [
  {
    '@context': 'https://schema.org',
    '@type': getBusinessSchemaTypes((organization as ApiValue)?.vertical),
    name: brandName.value,
    url: requestUrl.origin,
    acceptsReservations: true,
    reservationUrl: `${requestUrl.origin}/reservations`,
    potentialAction: {
      '@type': 'ReserveAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${requestUrl.origin}/reservations` },
      result: { '@type': 'Reservation' }
    }
  },
  ...locations.value.map(location => ({
    '@context': 'https://schema.org',
    '@type': getBusinessSchemaTypes((organization as ApiValue)?.vertical),
    name: `${brandName.value} — ${String(location.title ?? '')}`,
    address: schemaPostalAddress((location.address ?? null) as PostalAddress | null),
    telephone: location.phone,
    hasMap: location.maps_url,
    acceptsReservations: true,
    reservationUrl: `${requestUrl.origin}/reservations`,
    openingHoursSpecification: schemaOpeningHours(location.opening_hours ?? null),
    ...(location.latitude && location.longitude
      ? { geo: { '@type': 'GeoCoordinates', latitude: location.latitude, longitude: location.longitude } }
      : {}),
  })),
]))
</script>
