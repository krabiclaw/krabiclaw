<template>
  <footer class="border-t border-default bg-elevated text-default" aria-labelledby="tenant-footer-heading">
    <h2 id="tenant-footer-heading" class="sr-only">{{ t('site.footer.label') }}</h2>
    <div class="mx-auto max-w-7xl px-4 pb-8 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pt-20">
      <div class="grid gap-10 border-b border-default pb-10 sm:pb-14 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
        <div class="space-y-6">
          <NuxtLink :to="localePath('/')" class="inline-flex no-underline" :aria-label="`${brandName} home`">
            <SiteLogo :alt="brandName" size="md" loading="lazy">
              <span class="tenant-display text-2xl text-highlighted">{{ brandName }}</span>
            </SiteLogo>
          </NuxtLink>
          <TenantRichText v-if="description" :content="description" class="tenant-footer-copy max-w-md text-sm leading-6 text-muted" />
          <ul v-if="documents.length" class="flex flex-wrap gap-x-4 gap-y-2 text-sm" role="list">
            <li v-for="document in documents" :key="document.asset_id">
              <a :href="document.public_url!" class="text-muted transition hover:text-highlighted" target="_blank" rel="noopener">
                {{ document.alt_text || document.file_name || t('site.footer.document') }}
              </a>
            </li>
          </ul>
        </div>

        <div
          v-if="error"
          class="rounded-xl border border-default bg-default p-6 text-sm text-muted"
          role="status"
          aria-live="polite"
        >
          {{ t('site.footer.locations_error') }}
        </div>
        <div v-else-if="showAddresses && locations.length" class="grid gap-8 sm:grid-cols-2" :class="{ 'xl:grid-cols-3': locations.length > 2 }">
          <div v-for="loc in formattedLocations" :key="loc.id">
            <div class="tenant-display text-xl font-normal leading-none text-highlighted">{{ loc.title }}</div>
            <div class="mt-2 text-sm leading-relaxed text-muted">{{ formatLocAddress(loc) }}</div>
            <div v-if="loc.phone" class="mt-1 text-sm text-muted">{{ formatPhone(loc.phone) }}</div>
            <div v-if="loc.hoursToday" class="mt-2 text-xs text-highlighted/40">{{ loc.hoursToday }}</div>
            <NuxtLink
              :to="localePath(locationLink(loc))"
              class="mt-3 inline-block border-b border-current pb-0.5 text-xs uppercase tracking-widest text-highlighted transition hover:opacity-70"
            >
              {{ t('site.footer.visit_page') }}
            </NuxtLink>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-x-6 gap-y-10 border-b border-default py-10 sm:py-12 md:grid-cols-4">
        <div v-for="group in footerGroups" :key="group.label">
          <h3 class="tenant-eyebrow mb-5 text-dimmed">{{ group.label }}</h3>
          <ul class="space-y-3 text-sm" role="list">
            <li v-for="item in group.items" :key="item.path">
              <NuxtLink :to="localePath(item.path)" class="text-muted no-underline transition hover:text-highlighted">{{ item.title }}</NuxtLink>
            </li>
          </ul>
        </div>
      </div>

      <SiteFooterBar :name="compliance?.entity_name || brandName" color-mode class="pt-6 text-muted" />
    </div>
  </footer>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import type { PublicPageLink, PublicCompliance } from '~/types/public-site'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'
import { catalogNavigation, publicLocationPath } from '~/utils/product-presentation'
import { getActiveSpecialClosure } from '~/utils/formatters'
import { getTodayHoursLabel, type OpeningHours, type SpecialHours } from '~/shared/reservation-hours'
import { formatPostalAddress, type PostalAddress } from '~/utils/postal-address'
import { isLegalPractice } from '~/utils/template-registry'

const props = withDefaults(defineProps<{
  organization: ApiRecord | null
  locations?: ApiRecord[]
  error?: unknown
  sections?: PublicShellPayload['sections'] | null
  compliance?: PublicCompliance | null
  pageLinks?: PublicPageLink[]
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

// A legal practice states its office address only when it chooses to.
const showAddresses = computed(() => !props.compliance || props.compliance.address_visibility === 'visible')
const legalPractice = computed(() => isLegalPractice(props.organization?.vertical as string | undefined))

const catalogLinks = computed(() => (props.organization?.vertical
  ? catalogNavigation(props.organization.vertical as string, props.sections)
  : []))

function linksFor(paths: string[]) {
  const byPath = new Map(props.pageLinks.map(item => [item.path, item]))
  return paths.flatMap(path => {
    const item = byPath.get(path)
    return item ? [{ path, title: item.title }] : []
  })
}

function sectionLinks(entries: Array<{ section: keyof PublicShellPayload['sections']; path: string; labelKey: string }>) {
  return entries.filter(entry => props.sections?.[entry.section] === true).map(entry => ({ path: entry.path, title: t(entry.labelKey) }))
}

const footerGroups = computed(() => [
  {
    label: legalPractice.value ? t('site.footer.services') : t('site.footer.heading_experience'),
    items: [
      ...catalogLinks.value.map(item => ({ path: item.path, title: t(item.labelKey) })),
      ...props.pageLinks.filter(item => item.path.startsWith('/services/')).map(item => ({ path: item.path, title: item.title })),
      ...sectionLinks([{ section: 'reservations', path: '/reservations', labelKey: 'site.header.reservations' }, { section: 'photos', path: '/photos', labelKey: 'site.footer.gallery' }]),
    ],
  },
  {
    label: t('site.footer.heading_discover'),
    items: [
      ...linksFor(['/pricing', '/blog', '/donate']),
      ...sectionLinks([
        { section: 'reviews', path: '/reviews', labelKey: 'site.footer.reviews' },
        { section: 'posts', path: '/posts', labelKey: 'site.footer.latest_updates' },
        { section: 'qa', path: '/qa', labelKey: 'site.footer.qa' },
      ]),
    ].filter((item, index, all) => all.findIndex(other => other.path === item.path) === index),
  },
  {
    label: t('site.footer.heading_connect'),
    items: [
      ...linksFor(['/about', '/schedule', '/contact']),
      ...(!legalPractice.value && (props.locations || []).filter(location => !location.home_slug).length > 1 ? [{ path: '/locations', title: t('site.footer.all_locations') }] : []),
    ],
  },
  { label: t('site.footer.legal'), items: linksFor(['/third-party-notices', '/policies/privacy', '/policies/terms']) },
].filter(group => group.items.length))

const formattedLocations = computed(() =>
  (props.locations || []).map((loc: ApiRecord) => {
    const closure = getActiveSpecialClosure((loc.special_hours as SpecialHours) ?? null, loc.timezone as string | undefined)
    return {
      ...loc,
      hoursToday: closure
        ? t('site.footer.temporarily_closed')
        : getTodayHoursLabel((loc.opening_hours as OpeningHours) ?? null, t('site.location.closed'), loc.timezone as string | undefined, new Date(), (loc.special_hours as SpecialHours) ?? null, locale.value),
    }
  })
)

function formatLocAddress(loc: ApiRecord): string {
  return formatPostalAddress((loc.address as PostalAddress) ?? null)
}

// A legal practice's offices are on its contact page; a venue's on their own pages.
function locationLink(loc: ApiRecord): string {
  return legalPractice.value ? '/contact' : publicLocationPath(loc as { slug: string, home_slug?: string | null })
}
</script>
