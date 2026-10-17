<template>
  <footer class="border-t border-default bg-elevated text-default" aria-labelledby="tenant-footer-heading">
    <h2 id="tenant-footer-heading" class="sr-only">{{ t('blawby.footer.label') }}</h2>
    <!-- Professional Services / Blawby Footer Layout -->
    <div v-if="isService" class="mx-auto max-w-7xl px-6 pb-8 pt-8 sm:pt-12 lg:px-8 lg:pt-16">
      <div class="xl:grid xl:grid-cols-3 xl:gap-8">
        <div class="space-y-8">
          <NuxtLink v-if="brandName" :to="localePath('/')" class="inline-flex no-underline" :aria-label="`${brandName} home`">
            <SiteLogo :alt="brandName" size="lg" loading="lazy">
              <span class="tenant-display text-2xl font-bold text-highlighted">{{ brandName }}</span>
            </SiteLogo>
          </NuxtLink>
          <p v-if="description" class="blawby-footer-copy max-w-xl text-sm leading-6 text-muted">
            {{ description }}
          </p>
          <ul v-if="documents.length" class="flex flex-wrap gap-x-4 gap-y-2 text-sm" role="list">
            <li v-for="document in documents" :key="document.asset_id">
              <a :href="document.public_url!" class="text-sm text-muted underline hover:text-highlighted" target="_blank" rel="noopener">
                {{ document.alt_text || document.file_name || t('blawby.footer.document') }}
              </a>
            </li>
          </ul>
        </div>

        <div class="mt-16 grid grid-cols-2 gap-8 md:grid-cols-4 xl:col-span-2 xl:mt-0">
          <div v-for="group in footerGroups" :key="group.label" v-show="group.items.length">
            <h3 class="text-sm font-semibold leading-6 text-highlighted">{{ group.label }}</h3>
            <ul class="mt-6 space-y-4" role="list">
              <li v-for="item in group.items" :key="item.id">
                <NuxtLink :to="localePath(item.path)" class="text-sm leading-6 text-muted no-underline transition hover:text-highlighted">{{ item.title }}</NuxtLink>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <SiteFooterBar :name="compliance?.entity_name || brandName" color-mode class="mt-16 border-t border-default pt-8 leading-5 text-muted sm:mt-20 lg:mt-24" />
    </div>

    <!-- Hospitality / Saya Footer Layout -->
    <div v-else class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-20 pb-8">
      <!-- Top section: brand + locations grid -->
      <div class="grid gap-16 border-b border-default pb-14 lg:grid-cols-[1fr_1.4fr]">
        <!-- Brand column -->
        <div>
          <NuxtLink :to="localePath('/')" class="block no-underline leading-none" :aria-label="`${brandName} home`">
            <SiteLogo :alt="brandName" size="md" loading="lazy">
              <div class="flex size-14 items-center justify-center rounded-full bg-accented text-highlighted font-bold text-2xl">
                {{ brandName ? brandName.charAt(0).toUpperCase() : 'K' }}
              </div>
            </SiteLogo>
          </NuxtLink>
          <p v-if="description" class="mt-4 max-w-xs text-sm leading-relaxed text-muted">
            {{ description }}
          </p>
        </div>

        <!-- Locations grid -->
        <div
          v-if="error"
          class="rounded-xl border border-default bg-default p-6 text-sm text-muted"
          role="status"
          aria-live="polite"
        >
          {{ t('saya.footer.locations_error') }}
        </div>
        <div
          v-else-if="locations.length"
          :class="[
            'grid gap-8',
            locations.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
          ]"
        >
          <div v-for="loc in formattedLocations" :key="loc.id">
            <div class="tenant-display text-xl font-normal text-highlighted leading-none">{{ loc.title }}</div>
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

      <!-- Navigation links: Experience, Discover, Connect -->
      <div class="grid gap-8 border-b border-default py-12 sm:grid-cols-3">
        <div>
          <h4 class="tenant-eyebrow mb-5 text-dimmed">{{ t('saya.footer.heading_experience') }}</h4>
          <ul class="space-y-3 text-sm">
            <li v-for="item in catalogLinks" :key="item.surface">
              <NuxtLink :to="localePath(item.path)" class="text-muted no-underline transition hover:text-highlighted">{{ t(item.labelKey) }}</NuxtLink>
            </li>
            <li v-if="sections?.reservations">
              <NuxtLink :to="localePath('/reservations')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.header.reservations') }}</NuxtLink>
            </li>
            <li v-if="sections?.photos">
              <NuxtLink :to="localePath('/photos')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.gallery') }}</NuxtLink>
            </li>
            <li>
              <NuxtLink :to="localePath('/about')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.our_story') }}</NuxtLink>
            </li>
          </ul>
        </div>
        <div v-if="discoverLinks.length">
          <h4 class="tenant-eyebrow mb-5 text-dimmed">{{ t('saya.footer.heading_discover') }}</h4>
          <ul class="space-y-3 text-sm">
            <li v-for="item in discoverLinks" :key="item.path">
              <NuxtLink :to="localePath(item.path)" class="text-muted no-underline transition hover:text-highlighted">{{ t(item.labelKey) }}</NuxtLink>
            </li>
          </ul>
        </div>
        <div>
          <h4 class="tenant-eyebrow mb-5 text-dimmed">{{ t('saya.footer.heading_connect') }}</h4>
          <ul class="space-y-3 text-sm">
            <li v-if="showLocations">
              <NuxtLink :to="localePath('/locations')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.all_locations') }}</NuxtLink>
            </li>
            <li>
              <NuxtLink :to="localePath('/contact')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.contact_us') }}</NuxtLink>
            </li>
          </ul>
        </div>
      </div>

      <!-- Bottom bar -->
      <SiteFooterBar :name="brandName" color-mode class="pt-6 text-muted" />
    </div>
  </footer>
</template>

<script setup lang="ts">
import type { PublicBlawbyPageLink, PublicCompliance } from '~/types/blawby'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'
import { catalogNavigation } from '~/utils/product-presentation'
import { getActiveSpecialClosure } from '~/utils/formatters'
import { getTodayHoursLabel, type OpeningHours, type SpecialHours } from '~/shared/reservation-hours'

const props = withDefaults(defineProps<{
  organization: ApiRecord | null
  locations?: ApiRecord[]
  error?: unknown
  sections?: PublicShellPayload['sections'] | null
  compliance?: PublicCompliance | null
  pageLinks?: PublicBlawbyPageLink[]
}>(), {
  locations: () => [],
  sections: null,
  compliance: null,
  pageLinks: () => [],
})

const { locale, localePath, t } = useI18n()

const brandName = computed(() => (props.organization?.name as string)?.trim() || props.compliance?.entity_name || '')
const description = computed(() => props.compliance?.footer_disclaimer || (props.organization?.brand_description as string) || (props.organization?.tagline as string) || '')
const documents = computed(() => props.compliance?.media.filter(item => item.slot === 'document' && item.public_url) ?? [])

const isService = computed(() => props.organization?.vertical === 'service' || props.compliance !== null)

const catalogLinks = computed(() => (props.organization?.vertical
  ? catalogNavigation(props.organization.vertical as string, props.sections)
  : []))

const discoverLinks = computed(() => [
  { section: 'blog', path: '/blog', labelKey: 'saya.footer.blog' },
  { section: 'reviews', path: '/reviews', labelKey: 'saya.footer.reviews' },
  { section: 'posts', path: '/posts', labelKey: 'saya.footer.latest_updates' },
  { section: 'qa', path: '/qa', labelKey: 'saya.footer.qa' },
].filter(item => props.sections?.[item.section as keyof PublicShellPayload['sections']] === true))

const showLocations = computed(() => (props.locations || []).some(location => !location.home_slug))

const formattedLocations = computed(() =>
  (props.locations || []).map((loc: ApiRecord) => {
    const closure = getActiveSpecialClosure((loc.special_hours as SpecialHours) ?? null, loc.timezone as string | undefined)
    return {
      ...loc,
      hoursToday: closure
        ? t('saya.footer.temporarily_closed')
        : getTodayHoursLabel((loc.opening_hours as OpeningHours) ?? null, t('saya.location.closed'), loc.timezone as string | undefined, new Date(), (loc.special_hours as SpecialHours) ?? null, locale.value),
    }
  })
)

function linksFor(paths: string[]) {
  const byPath = new Map(props.pageLinks.map(item => [item.path, item]))
  return paths.flatMap(path => {
    const item = byPath.get(path)
    return item ? [item] : []
  })
}

const serviceLinks = computed(() => props.pageLinks.filter(item => item.path.startsWith('/services/') || item.path === '/experiences'))
const footerGroups = computed(() => [
  { label: t('blawby.footer.services'), items: serviceLinks.value.length ? serviceLinks.value : linksFor(['/services', '/experiences', '/pricing']) },
  { label: t('blawby.footer.support'), items: linksFor(['/schedule', '/contact', '/pricing']) },
  { label: t('blawby.footer.company'), items: linksFor(['/about', '/donate', '/blog']) },
  { label: t('blawby.footer.legal'), items: linksFor(['/third-party-notices', '/disclaimer', '/policies/privacy', '/privacy', '/policies/terms', '/terms']) },
])

function formatLocAddress(loc: ApiRecord): string {
  const address = loc.address as { street?: string; city?: string; region?: string; postal_code?: string } | undefined
  if (!address) return ''
  const parts = [address.street, address.city, address.region, address.postal_code].filter(Boolean)
  return parts.join(', ')
}

function publicLocationPath(loc: ApiRecord): string {
  return `/locations/${loc.slug || loc.id}`
}
</script>
