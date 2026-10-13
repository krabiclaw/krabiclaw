<template>
  <div class="min-h-screen bg-default text-default">

    <!-- Page header -->
    <header class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <p class="saya-kicker mb-6">{{ locationsCopy.findUsKicker }}</p>
      <h1 class="saya-display-md text-default">
        {{ locationsCopy.locationGroupLine(locations.length) }}
      </h1>
    </header>

    <!-- Loading -->
    <div v-if="pending" class="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
      <div :class="['grid gap-8', 'md:grid-cols-2']">
        <div v-for="i in 2" :key="i" class="overflow-hidden border border-default">
          <div class="aspect-16/10 animate-[sayaPulse_1.6s_ease-in-out_infinite] bg-muted" />
          <div class="p-8 space-y-3">
            <div class="h-8 w-48 animate-pulse rounded bg-elevated" />
            <div class="h-4 w-28 animate-pulse rounded bg-elevated" />
            <div class="mt-4 h-3 w-full animate-pulse rounded bg-elevated" />
            <div class="h-3 w-2/3 animate-pulse rounded bg-elevated" />
          </div>
        </div>
      </div>
    </div>

    <!-- Locations grid -->
    <div v-else class="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
      <div
        v-if="locations.length"
        :class="['grid gap-8', locations.length === 1 ? '' : 'md:grid-cols-2']"
      >
        <NuxtLink
          v-for="loc in locations"
          :key="loc.id"
          :to="localePath(`/locations/${loc.slug}`)"
          class="group block overflow-hidden border border-default text-default no-underline transition-colors hover:border-muted"
        >
          <!-- Photo -->
          <div class="aspect-16/10 overflow-hidden bg-muted">
            <video
              v-if="locationMedia(loc)?.public_url && locationMedia(loc)?.kind === 'video'"
              :src="locationMedia(loc)?.public_url"
              autoplay
              muted
              loop
              playsinline
              class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            <img
              v-else-if="locationMedia(loc)?.public_url"
              :src="locationMedia(loc)?.public_url"
              :alt="loc.title"
              class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            >
            <div v-else class="flex h-full w-full items-center justify-center">
              <SayaIcon name="map-pin" class="size-10 text-muted" />
            </div>
          </div>

          <!-- Body -->
          <div class="p-8 pb-9">
            <!-- Open now meta -->
            <div class="saya-eyebrow mb-5 flex items-center gap-2 text-muted">
              <template v-if="loc.isOpenNow !== undefined">
                <span class="size-1.5 rounded-full" :class="loc.isOpenNow ? 'bg-green-400' : 'bg-zinc-300'" />
                {{ loc.isOpenNow ? locationsCopy.openNowLabel : locationsCopy.closedLabel }}
              </template>
              <template v-if="todayHours(loc)">· {{ todayHours(loc) }}</template>
            </div>

            <!-- Location name -->
            <div class="saya-display saya-italic text-4xl text-default leading-none">{{ loc.title }}</div>
            <p v-if="addressPlaceName(loc.address as PostalAddress | null)" class="mt-1.5 text-sm text-muted">{{ addressPlaceName(loc.address as PostalAddress | null) }}</p>

            <!-- Address -->
            <p class="mt-5 text-sm leading-relaxed text-muted">{{ locationAddress(loc) }}</p>

            <!-- CTA -->
            <div class="mt-6 border-t border-default pt-5">
              <span class="saya-eyebrow text-muted">{{ locationsCopy.visitLocationCta }}</span>
            </div>
          </div>
        </NuxtLink>
      </div>

      <!-- Empty state -->
      <div v-else>
        <div class="border border-dashed border-default px-8 py-16 text-center">
          <SayaIcon name="map-pin" class="mx-auto size-10 text-muted" />
          <p class="mt-4 text-sm text-muted">{{ locale === 'en' ? 'No locations are published yet.' : t('saya.common.temporarily_unavailable') }}</p>
        </div>
        <div v-if="isAuthenticated" class="mt-8 text-center">
          <SayaButton to="/dashboard">
            {{ locationsCopy.connectGoogleLocationsCta }}
          </SayaButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { getTodayHoursLabel } from '~/shared/reservation-hours'
import { addressPlaceName, formatPostalAddress, type PostalAddress } from '~/utils/postal-address'

definePageMeta({ layout: 'saya' })

const { organization } = useTenantOrganization()
const session = authClient.useSession()
const isAuthenticated = computed(() => Boolean(session.value.data?.user))
const { locale, localePath, t } = useI18n()
const locationsCopy = computed(() => getVerticalCopy(unref(organization)?.vertical, locale.value))

const { locations: publishedLocations, pending } = await usePublicPageData()
const locations = computed(() => publishedLocations.value.map(location => ({
  ...location,
  isOpenNow: getIsOpenNow(location.opening_hours, location.timezone, location.special_hours),
})))
const locationMedia = (location: ApiRecord) => Array.isArray(location.media)
  ? (location.media as ApiRecord[]).find(item => item.slot === 'hero') ?? null
  : null

// The first card's hero is this route's LCP element. A video hero has no poster
// here, so there is no image to hint and it is left to normal discovery.
useHeroLcpPreload(computed(() => {
  const media = locations.value[0] ? locationMedia(locations.value[0] as ApiRecord) : null
  if (!media || media.kind === 'video') return null
  return String(media.public_url ?? '') || null
}))
function locationAddress(location: ApiRecord): string {
  return formatPostalAddress(location.address as PostalAddress | null)
}

function todayHours(location: ApiRecord): string {
  return getTodayHoursLabel(location.opening_hours, t('saya.location.closed'), location.timezone, new Date(), location.special_hours, locale.value) ?? ''
}

const organizationName = computed(() => unref(organization)?.name || '')

// A page about the business: its image is the organization's.
useSocialMetadata(() => ({
  path: '/locations',
  socialImage: organization.social_image,
  title: t('saya.locations.collection_title', { organization: organizationName.value }),
  description: t('saya.locations.meta_description'),
  breadcrumbs: [
    { name: t('saya.header.locations'), url: '/locations' },
  ],
}))
</script>
