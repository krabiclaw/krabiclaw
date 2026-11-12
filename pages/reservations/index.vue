<template>
  <div class="min-h-screen bg-default text-default">
    <header class="tenant-container flex flex-col items-center pt-16 pb-14 text-center lg:pt-20 lg:pb-18">
      <p class="tenant-kicker mb-6 inline-flex items-center justify-center rounded-full border border-default/10 bg-default/3 px-5 py-2 text-center">
        {{ resCopy.reservationPageKicker }}
      </p>
      <h1 v-if="heroTitle" class="tenant-display-md max-w-5xl text-default">
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
            <MediaPreview
              v-if="getLocationMediaUrl(loc) && getLocationMediaKind(loc) === 'video'"
              :item="{ url: getLocationMediaUrl(loc)!, kind: 'video', poster: getLocationPoster(loc) || undefined, alt: String(loc.title) }"
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
            <p v-if="getLocationLabel(loc)" class="tenant-eyebrow mb-3 text-muted">{{ getLocationLabel(loc) }}</p>
            <h3 class="tenant-display tenant-italic text-3xl text-default leading-none sm:text-4xl">{{ loc.title }}</h3>
            <p v-if="loc.short_description" class="mt-3 max-w-md text-sm leading-relaxed text-muted">{{ loc.short_description }}</p>

            <div class="mt-6 flex flex-wrap items-center gap-3">
              <TenantButton v-if="tableAt(loc)" control-id="reservation-booking-toggle" @click="openBookingModal(loc)">{{ resCopy.reservationRequestButton }}</TenantButton>
              <TenantButton v-if="loc.phone" :href="`tel:${loc.phone}`" variant="outline">
                {{ formatPhone(loc.phone) }}
              </TenantButton>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section v-if="activeReservationPolicySummary" class="bg-muted">
        <div class="tenant-container py-16 lg:py-20">
          <div class="mb-10 max-w-xl">
            <p class="tenant-kicker mb-4">{{ resCopy.goodToKnowKicker }}</p>
            <h2 class="tenant-display-sm text-default">{{ activeReservationPolicySummary.heading }}</h2>
          </div>
          <div v-if="activeReservationPolicySummary.items.length > 0" class="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div v-for="item in activeReservationPolicySummary.items" :key="item.id" class="border-t border-default pt-5">
              <p class="text-sm leading-relaxed text-muted">{{ item.text }}</p>
            </div>
          </div>
        </div>
      </section>

    <!-- The table's booking: the same steps, times and form as every bookable offering. -->
    <BookingModal
      v-model="bookingOpen"
      target-id="reservation-booking"
      :title="selectedLocation?.title ?? resCopy.selectTimeLabel"
      :can-go-back="bookingStep > 1 && !submitting"
      @back="bookingStep = 1"
    >
      <ProductBookingSteps
        :controller="bookingController"
        :confirmation-mode="activeTable.booking!.confirmation_mode"
        :payment-required="paymentRequired"
        phone-required
      />
    </BookingModal>
  </div>
</template>

<script setup lang="ts">
import type { PublicProduct } from '~/server/types/products'
import BookingModal from '@/components/booking/BookingModal.vue'
import ProductBookingSteps from '~/components/booking/ProductBookingSteps.vue'
import { getTodayHoursLabel, isOpenNow, schemaOpeningHours } from '~/shared/reservation-hours'
import { isCurrencyCode } from '~/shared/currencies'
import { addressPlaceName, parsePostalAddress, schemaPostalAddress, type PostalAddress } from '~/utils/postal-address'
import { mediaStillUrl, type MediaPresentation } from '~/shared/media-placement-contract'
import { formatPhone } from '~/utils/phone'
import MediaPreview, { provideMediaPreviews } from '~/components/MediaPreview.vue'

function formatTitleItalics(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\*(.*?)\*/g, '<em class="tenant-italic">$1</em>')
}

definePageMeta({ layout: 'tenant' })

const { organization } = useTenantOrganization()
const { id: organizationId } = organization
const { locale } = useI18n()
const resCopy = computed(() => getVerticalCopy((organization as ApiValue)?.vertical, locale.value))
const { locations, config, getField, products, table_policy_summaries } = await usePublicPageData()

/**
 * A location takes reservations through its table product: published, on
 * sale and offered there. The reservations page books it like any offering.
 */
const tables = computed(() => (products.value as PublicProduct[]).filter(product => product.kind === 'table' && product.booking))
function tableAt(location: ApiRecord): PublicProduct | null {
  return tables.value.find(product => product.locations.some(entry => entry.location_id === location.id && entry.published && entry.active)) ?? null
}
// A site whose locations take no reservations has no reservations page, the
// same fact the header uses to offer one.
if (!locations.value.some(location => tableAt(location))) {
  throw createError({ statusCode: 404, statusMessage: 'This site does not take reservations' })
}

// The first location card's hero is this route's LCP element.
useHeroLcpPreload(computed(() => {
  const first = locations.value[0]
  return first ? getLocationPoster(first) : null
}))

const selectedLocationId = ref<string | null>(null)
const selectedLocation = computed(() => locations.value.find(location => location.id === selectedLocationId.value) ?? null)
const selectedTable = computed(() => selectedLocation.value ? tableAt(selectedLocation.value) : null)
/** The table the booking form is for: the chosen location's, before any is chosen the first. */
const activeTable = computed(() => selectedTable.value ?? tables.value[0]!)

/** The terms of the table being booked, or of the only one there is, as the booking will freeze them. */
const activeReservationPolicySummary = computed(() => {
  const table = selectedTable.value ?? (tables.value.length === 1 ? tables.value[0]! : null)
  if (!table) return null
  const summary = table_policy_summaries.value[table.id]
  if (!summary) throw createError({ statusCode: 500, statusMessage: 'Reservation terms are missing for this location' })
  return summary
})

const currency = config.value.default_currency
if (!isCurrencyCode(currency)) throw createError({ statusCode: 500, statusMessage: 'This business has no currency set' })
const brandName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

// One booking controller follows the chosen location's table.
const bookingController = useSessionBooking(() => {
  const location = selectedLocation.value
  return {
    organizationId, organizationName: brandName.value, product: activeTable.value, currency,
    location: location ? { id: String(location.id), slug: String(location.slug), title: String(location.title), address: parsePostalAddress(location.address) } : null,
    sessions: [], contactPhone: typeof location?.phone === 'string' ? location.phone : null,
  }
})
const { bookingOpen, bookingStep, submitting, partySize, selectedPrice, openBooking } = bookingController
provideMediaPreviews(bookingOpen)

/** A table's deposit is asked of the parties its terms name; a smaller party books without paying. */
const paymentRequired = computed(() => {
  const booking = activeTable.value.booking
  return Boolean(booking?.online_payment_required && (selectedPrice.value?.unit_amount ?? 0) > 0
    && (booking.payment_min_party_size === null || partySize.value >= booking.payment_min_party_size))
})

async function openBookingModal(location: ApiRecord) {
  selectedLocationId.value = String(location.id)
  await nextTick()
  await openBooking()
}

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

// ── SEO ───────────────────────────────────────────────────────────────────
const requestUrl = useRequestURL()

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
    acceptsReservations: Boolean(tableAt(location)),
    reservationUrl: `${requestUrl.origin}/reservations`,
    openingHoursSpecification: schemaOpeningHours(location.opening_hours ?? null),
    ...(location.latitude && location.longitude
      ? { geo: { '@type': 'GeoCoordinates', latitude: location.latitude, longitude: location.longitude } }
      : {}),
  })),
]))
</script>
