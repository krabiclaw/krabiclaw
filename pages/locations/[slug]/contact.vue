<template>
  <div class="min-h-screen bg-default text-default">

    <template v-if="pending">
      <div class="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div class="h-64 animate-pulse rounded-2xl bg-elevated" />
      </div>
    </template>

    <template v-else-if="location">
      <SayaSubNav :location-slug="slug" active="contact" />

      <!-- Page header -->
      <header class="mx-auto max-w-7xl px-4 pt-14 pb-10 sm:px-6 lg:px-8">
        <NuxtLink :to="localePath(`/locations/${slug}`)" class="saya-kicker mb-8 inline-block text-muted no-underline hover:text-default">
          ← {{ t('saya.location.back_to', { title: location.title }) }}
        </NuxtLink>
        <h1 class="saya-display-md text-default mt-6">
          <em class="saya-italic">{{ t('saya.location.plan_a_visit') }}</em>
        </h1>
        <p v-if="location.short_description" class="mt-4 text-sm text-muted">{{ location.short_description }}</p>
      </header>

      <!-- Two-column cards: Hours | Address + Map -->
      <div class="mx-auto grid max-w-7xl gap-6 px-4 pb-6 sm:px-6 lg:grid-cols-2 lg:px-8">

        <!-- HOURS CARD -->
        <section class="border border-default bg-default p-9">
          <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.hours') }}</p>
          <h2 class="saya-display saya-italic flex flex-wrap items-center gap-3 text-3xl text-default leading-none">
            <span :class="isOpenNow === true ? 'size-2.5 rounded-full bg-green-400' : 'size-2.5 rounded-full bg-zinc-400'" />
            {{ isOpenNow === true ? t('saya.location.open_now') : isOpenNow === false ? t('saya.location.closed') : t('saya.location.hours') }}
            <span v-if="todayHours" class="text-base font-normal not-italic tracking-normal text-muted">· {{ todayHours }}</span>
          </h2>

          <table class="mt-8 w-full border-collapse">
            <tbody>
              <tr
                v-for="day in weekHours"
                :key="day.day"
                :class="day.today ? 'font-semibold' : ''"
              >
                <td class="border-b border-default py-3 text-sm" :class="day.today ? 'text-default' : 'text-muted'">
                  <span class="flex items-center gap-2">
                    {{ day.day }}
                    <span v-if="day.today" class="rounded-full bg-inverted px-2 py-0.5 text-[9px] uppercase tracking-widest text-inverted">{{ t('saya.location.today') }}</span>
                  </span>
                </td>
                <td class="border-b border-default py-3 text-right text-sm tabular-nums" :class="day.today ? 'text-default' : 'text-muted'">{{ day.hours }}</td>
              </tr>
              <tr v-if="!weekHours.length">
                <td colspan="2" class="py-4 text-sm text-muted">
                  {{ t('saya.location.contact_us_for_hours') }}
                  <a v-if="location.phone" :href="`tel:${location.phone}`" class="ml-2 text-default underline-offset-2 hover:underline">{{ location.phone }}</a>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- ADDRESS + MAP CARD -->
        <section class="border border-default bg-default p-9">
          <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.find_us') }}</p>
          <h2 class="saya-display saya-italic text-3xl text-default leading-none">{{ addressPlaceName(location.address as PostalAddress | null) || location.title }}</h2>

          <!-- Map embed (16/10) -->
          <div class="mt-7 aspect-[16/10] overflow-hidden border border-default bg-muted">
            <iframe
              v-if="mapEmbedSrc"
              :src="mapEmbedSrc"
              :title="location.title ? t('saya.location.map_for', { title: location.title }) : t('saya.location.location_map')"
              width="100%"
              height="100%"
              style="border:0;filter:grayscale(0.12)"
              allowfullscreen
              loading="lazy"
              referrerpolicy="no-referrer-when-downgrade"
            />
            <div v-else class="flex h-full w-full flex-col items-center justify-center gap-3">
              <SayaIcon name="map-pin" class="size-8 text-muted" />
              <span class="text-sm text-muted">{{ t('saya.location.map_synced') }}</span>
            </div>
          </div>

          <!-- Address -->
          <p class="mt-6 text-sm leading-relaxed text-default">{{ formattedAddress }}</p>

          <!-- Directions buttons -->
          <div class="mt-4 flex flex-wrap gap-2">
            <a
              v-if="location.maps_url"
              :href="location.maps_url"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 rounded-full bg-inverted px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-inverted no-underline transition hover:opacity-80"
            >
              <SayaIcon name="map-pin" class="size-3.5" />
              {{ t('saya.location.get_directions') }}
            </a>
            <a
              v-if="location.maps_url"
              :href="`https://maps.apple.com/?q=${encodeURIComponent(formattedAddress)}`"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center rounded-full border border-default px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-default no-underline transition hover:bg-muted"
            >
              {{ t('saya.location.apple_maps') }}
            </a>
          </div>

          <!-- Phone + email -->
          <div v-if="location.phone || location.email" class="mt-7 grid grid-cols-2 gap-6 border-t border-default pt-7">
            <div v-if="location.phone">
              <p class="saya-eyebrow mb-2 text-muted">{{ t('saya.location.phone') }}</p>
              <a :href="`tel:${location.phone}`" class="border-b border-default pb-0.5 text-sm text-default no-underline hover:opacity-70">{{ location.phone }}</a>
            </div>
            <div v-if="location.email">
              <p class="saya-eyebrow mb-2 text-muted">{{ t('saya.location.email') }}</p>
              <a :href="`mailto:${location.email}`" class="border-b border-default pb-0.5 text-sm text-default no-underline hover:opacity-70 break-all">{{ location.email }}</a>
            </div>
          </div>
        </section>
      </div>

      <!-- Good to know (parking.info + extra.notes from CMS) -->
      <section v-if="sanitizedParkingInfo || sanitizedExtraNotes" class="mt-16 bg-elevated">
        <div class="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div class="mb-12 max-w-2xl">
            <p class="saya-kicker mb-6">{{ t('saya.location.good_to_know') }}</p>
            <h2 class="saya-display-md text-default">{{ t('saya.location.before_you_come') }}</h2>
          </div>
          <div class="grid gap-6 sm:grid-cols-2">
            <!-- eslint-disable vue/no-v-html -->
            <div v-if="sanitizedParkingInfo" class="border border-default bg-default p-8">
              <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.parking') }}</p>
              <div class="prose prose-sm max-w-none text-default" v-html="sanitizedParkingInfo" />
            </div>
            <div v-if="sanitizedExtraNotes" class="border border-default bg-default p-8">
              <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.additional_notes') }}</p>
              <div class="prose prose-sm max-w-none text-default" v-html="sanitizedExtraNotes" />
            </div>
            <!-- eslint-enable vue/no-v-html -->
          </div>
        </div>
      </section>

      <!-- CTA strip -->
      <section class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-8 px-4 py-24 sm:px-6 lg:px-8">
        <h3 class="saya-display-md saya-italic text-default">{{ t('saya.location.see_you_soon') }}</h3>
        <div class="flex flex-wrap gap-3">
          <SayaButton :to="localePath(locationCopy.ctaRoute)" size="lg">{{ locationCopy.reserveCta }}</SayaButton>
          <a
            v-if="location.phone"
            :href="`tel:${location.phone}`"
            class="inline-flex items-center rounded-full border border-default px-6 py-2.5 text-xs font-medium uppercase tracking-widest text-default no-underline transition hover:bg-muted"
          >
            {{ t('saya.location.call_us') }}
          </a>
        </div>
      </section>
    </template>

    <div v-else class="mx-auto max-w-xl px-4 py-24 text-center">
      <SayaIcon name="map-pin" class="mx-auto mb-4 size-12 text-muted" />
      <h1 class="saya-display-sm text-default">{{ t('saya.location.not_found') }}</h1>
      <SayaButton to="/locations" class="mt-8">{{ t('saya.location.view_all_locations') }}</SayaButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatOpeningHours, getIsOpenNow } from '~/utils/formatters'
import { getTodayHoursLabel, schemaOpeningHours } from '~/shared/reservation-hours'
import { addressPlaceName, formatPostalAddress, schemaPostalAddress, type PostalAddress } from '~/utils/postal-address'
import { loadDomPurify } from '~/utils/dom-purify-loader'
import { sanitizeHtmlForSsr } from '~/utils/markdown'

const DOMPurify = import.meta.client ? await loadDomPurify() : { sanitize: sanitizeHtmlForSsr }

definePageMeta({ layout: 'saya' })

const { locale, localePath, t } = useI18n()

const route = useRoute()
const { organizationId, organization } = useTenantOrganization()
const locationCopy = computed(() => getVerticalCopy((organization as ApiValue)?.vertical, locale.value))
if (!organizationId) throw createError({ statusCode: 404 })

const slug = computed(() => String(route.params.slug))

// Bootstrap: location data + page content (parking/notes) — 1 SSR call
const { location, getField: getContentField, pending } = await usePublicPageData()
// A slug naming no location is a URL that does not exist. Rendering the page
// around a null location answered 200 with an empty shell — a soft 404 a
// crawler indexes. The sibling menu and product indexes already refuse it.
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })


const formattedAddress = computed(() => formatPostalAddress((location.value?.address ?? null) as PostalAddress | null))

const weekHours = computed(() => formatOpeningHours(location.value?.opening_hours ?? null, locale.value, t('saya.location.closed'), location.value?.timezone))
const todayHours = computed(() => getTodayHoursLabel(location.value?.opening_hours ?? null, t('saya.location.closed'), location.value?.timezone, new Date(), location.value?.special_hours ?? null, locale.value))
const isOpenNow = computed(() => getIsOpenNow(location.value?.opening_hours ?? null, location.value?.timezone, location.value?.special_hours ?? null))

const mapEmbedSrc = computed(() => (location.value as ApiValue)?.map_embed_url || null)

const parkingInfo = computed(() => getContentField('parking.info', '') ?? '')
const extraNotes = computed(() => getContentField('extra.notes', '') ?? '')
const sanitizedParkingInfo = computed(() => DOMPurify.sanitize(parkingInfo.value))
const sanitizedExtraNotes = computed(() => DOMPurify.sanitize(extraNotes.value))

const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

useSocialMetadata(() => ({
  path: `/locations/${slug.value}/contact`,
  title: `Plan a visit · ${location.value?.title || slug.value}`,
  description: `Hours, address and directions for ${location.value?.title || slug.value}.`,
  socialImage: location.value?.social_image ?? null,
  brand: {
    organizationName: organizationName.value,
  },
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
    { name: 'Visit', url: `/locations/${slug.value}/contact` },
  ],
}))

useSchemaOrg([
  computed(() => {
    const loc = location.value
    if (!loc) return {}
    return {
      '@type': getBusinessSchemaTypes((organization as ApiValue)?.vertical),
      name: `${organizationName.value} — ${loc.title}`,
      address: schemaPostalAddress((location.value?.address ?? null) as PostalAddress | null),
      telephone: loc.phone,
      email: loc.email,
      hasMap: loc.maps_url,
      openingHoursSpecification: schemaOpeningHours(loc.opening_hours ?? null),
      ...(loc.latitude && loc.longitude ? { geo: { '@type': 'GeoCoordinates', latitude: loc.latitude, longitude: loc.longitude } } : {})
    }
  }),
])
</script>
