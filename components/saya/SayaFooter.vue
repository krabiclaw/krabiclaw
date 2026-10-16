<template>
  <footer class="border-t border-default bg-elevated text-default">
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-20 pb-8">

      <!-- Top section: brand + locations grid -->
      <div class="grid gap-16 border-b border-default pb-14 lg:grid-cols-[1fr_1.4fr]">
        <!-- Brand column -->
        <div>
          <NuxtLink :to="localePath('/')" class="block no-underline leading-none">
            <SiteLogo :alt="restaurantName" size="md" loading="lazy">
              <div class="flex size-14 items-center justify-center rounded-full bg-accented text-highlighted font-bold text-2xl">
                {{ restaurantName.charAt(0).toUpperCase() }}
              </div>
            </SiteLogo>
          </NuxtLink>
          <p class="mt-4 max-w-xs text-sm leading-relaxed text-muted">
            {{ tagline }}
          </p>

        </div>

        <!-- Locations grid -->
        <div
          v-if="locationsError"
          class="rounded-xl border border-default bg-default p-6 text-sm text-muted"
          role="status"
          aria-live="polite"
        >
          {{ t('saya.footer.locations_error') }}
        </div>
        <div
          v-else
          :class="[
            'grid gap-8',
            locations.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
          ]"
        >
          <div v-for="loc in locations" :key="loc.id">
            <div class="saya-display text-xl text-highlighted leading-none">{{ loc.title }}</div>
            <div class="mt-2 text-sm leading-relaxed text-muted">{{ formatLocAddress(loc) }}</div>
            <div v-if="loc.phone" class="mt-1 text-sm text-muted">{{ loc.phone }}</div>
            <div v-if="loc.hoursToday" class="mt-2 text-xs text-highlighted/40">{{ loc.hoursToday }}</div>
            <NuxtLink
              :to="localePath(publicLocationPath(loc))"
              class="mt-3 inline-block border-b border-current pb-0.5 text-xs uppercase tracking-widest text-highlighted transition hover:opacity-70"
            >
              {{ t('saya.footer.visit_page') }}
            </NuxtLink>
          </div>
        </div>
      </div>

      <!-- Navigation links -->
      <div class="grid gap-8 border-b border-default py-12 sm:grid-cols-3">
        <div>
          <h4 class="saya-eyebrow mb-5 text-dimmed">{{ t('saya.footer.heading_experience') }}</h4>
          <ul class="space-y-3 text-sm">
            <li v-for="item in catalogLinks" :key="item.surface"><NuxtLink :to="localePath(item.path)" class="text-muted no-underline transition hover:text-highlighted">{{ t(item.labelKey) }}</NuxtLink></li>
            <li v-if="sections?.reservations"><NuxtLink :to="localePath('/reservations')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.header.reservations') }}</NuxtLink></li>
            <li v-if="sections?.photos"><NuxtLink :to="localePath('/photos')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.gallery') }}</NuxtLink></li>
            <li><NuxtLink :to="localePath('/about')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.our_story') }}</NuxtLink></li>
          </ul>
        </div>
        <div v-if="discoverLinks.length">
          <h4 class="saya-eyebrow mb-5 text-dimmed">{{ t('saya.footer.heading_discover') }}</h4>
          <ul class="space-y-3 text-sm">
            <li v-for="item in discoverLinks" :key="item.path"><NuxtLink :to="localePath(item.path)" class="text-muted no-underline transition hover:text-highlighted">{{ t(item.labelKey) }}</NuxtLink></li>
          </ul>
        </div>
        <div>
          <h4 class="saya-eyebrow mb-5 text-dimmed">{{ t('saya.footer.heading_connect') }}</h4>
          <ul class="space-y-3 text-sm">
            <li v-if="showLocations"><NuxtLink :to="localePath('/locations')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.all_locations') }}</NuxtLink></li>
            <li><NuxtLink :to="localePath('/contact')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.contact_us') }}</NuxtLink></li>
          </ul>
        </div>
      </div>

      <SiteFooterBar :name="restaurantName" color-mode class="pt-6 text-muted" />
    </div>
  </footer>
</template>

<script setup lang="ts">
import { getActiveSpecialClosure } from '~/utils/formatters'
import { getTodayHoursLabel, type OpeningHours, type SpecialHours } from '~/shared/reservation-hours'
import { catalogNavigation, publicLocationPath } from '~/utils/product-presentation'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'
import { formatPostalAddress, type PostalAddress } from '~/utils/postal-address'

interface Organization {
  name?: string | null
  brand_description?: string | null
  media?: Array<{ slot?: string; public_url?: string | null }>
  vertical?: string | null
  config?: { phone?: string | null } | null
}

interface PublicLocation {
  id: string
  slug: string
  home_slug: string | null
  title: string
  address?: PostalAddress | null
  phone?: string | null
  email?: string | null
  googleMapsHours?: ApiValue
  opening_hours?: OpeningHours
  special_hours?: SpecialHours
  timezone?: string | null
}

// Data comes from layouts/saya.vue, which already owns the single shared
// bootstrap/tenant-site fetch — footer is presentation-only, not a fetcher.
const props = defineProps<{
  organization: Organization | null
  locations: PublicLocation[]
  error: unknown
  sections: PublicShellPayload['sections'] | null
}>()

const { t, locale, localePath } = useI18n()
const locationsError = computed(() => props.error)

// Every link is to a section the site has something on.
const catalogLinks = computed(() => catalogNavigation(props.organization?.vertical, props.sections))
const discoverLinks = computed(() => [
  { section: 'blog', path: '/blog', labelKey: 'saya.footer.blog' },
  { section: 'reviews', path: '/reviews', labelKey: 'saya.footer.reviews' },
  { section: 'posts', path: '/posts', labelKey: 'saya.footer.latest_updates' },
  { section: 'qa', path: '/qa', labelKey: 'saya.footer.qa' },
].filter(item => props.sections?.[item.section as keyof PublicShellPayload['sections']] === true))
// A home is reached as itself, so the index is offered for locations with pages of their own.
const showLocations = computed(() => props.locations.some(location => !location.home_slug))
const restaurantName = computed(() => props.organization?.name?.trim() || '')
const tagline = computed(() => props.organization?.brand_description?.trim() || '')

const locations = computed(() =>
  props.locations.map((loc: PublicLocation) => {
    const closure = getActiveSpecialClosure(loc.special_hours ?? null, loc.timezone)
    return {
      ...loc,
      hoursToday: closure
        ? t('saya.footer.temporarily_closed')
        : getTodayHoursLabel(loc.opening_hours ?? null, t('saya.location.closed'), loc.timezone, new Date(), loc.special_hours ?? null, locale.value),
    }
  })
)

function formatLocAddress(loc: PublicLocation) {
  return formatPostalAddress(loc.address ?? null)
}


</script>
