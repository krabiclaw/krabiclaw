<template>
  <footer class="border-t border-default bg-elevated text-default" aria-labelledby="tenant-footer-heading">
    <h2 id="tenant-footer-heading" class="sr-only">{{ t('blawby.footer.label') }}</h2>
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-16 pb-8">
      <!-- Top section: brand + locations or description -->
      <div class="grid gap-12 border-b border-default pb-12 lg:grid-cols-[1fr_1.5fr]">
        <!-- Brand column -->
        <div class="space-y-4">
          <NuxtLink :to="localePath('/')" class="inline-flex items-center gap-3 no-underline leading-none" :aria-label="`${brandName} home`">
            <SiteLogo :alt="brandName" size="md" loading="lazy">
              <div class="flex size-12 items-center justify-center rounded-full bg-accented text-highlighted font-bold text-xl">
                {{ brandName ? brandName.charAt(0).toUpperCase() : 'K' }}
              </div>
            </SiteLogo>
            <span v-if="brandName" class="tenant-display text-2xl font-bold text-highlighted">{{ brandName }}</span>
          </NuxtLink>
          <p v-if="description" class="max-w-md text-sm leading-relaxed text-muted">
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

        <!-- Locations grid (if locations exist) -->
        <div
          v-if="locations.length"
          :class="[
            'grid gap-8',
            locations.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
          ]"
        >
          <div v-for="loc in locations" :key="loc.id">
            <div class="tenant-display text-lg font-bold text-highlighted leading-snug">{{ loc.title }}</div>
            <div class="mt-2 text-sm leading-relaxed text-muted">{{ formatLocAddress(loc) }}</div>
            <div v-if="loc.phone" class="mt-1 text-sm text-muted">{{ loc.phone }}</div>
            <div v-if="loc.hoursToday" class="mt-1 text-xs text-highlighted/60">{{ loc.hoursToday }}</div>
            <NuxtLink
              :to="localePath(publicLocationPath(loc))"
              class="mt-3 inline-block border-b border-current pb-0.5 text-xs uppercase tracking-widest text-highlighted transition hover:opacity-70"
            >
              {{ t('saya.footer.visit_page') }}
            </NuxtLink>
          </div>
        </div>

        <!-- Custom footer page links (if services/pages groups exist) -->
        <div v-else-if="footerGroups.some(g => g.items.length)" class="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div v-for="group in footerGroups" :key="group.label" v-show="group.items.length">
            <h3 class="text-sm font-semibold leading-6 text-highlighted">{{ group.label }}</h3>
            <ul class="mt-4 space-y-3" role="list">
              <li v-for="item in group.items" :key="item.id">
                <NuxtLink :to="localePath(item.path)" class="text-sm text-muted no-underline transition hover:text-highlighted">{{ item.title }}</NuxtLink>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Navigation links (catalog / experiences / reservations / posts) -->
      <div v-if="catalogLinks.length || sections?.reservations || sections?.photos || sections?.posts" class="grid gap-8 border-b border-default py-8 sm:grid-cols-3">
        <div v-if="catalogLinks.length">
          <h4 class="mb-4 text-xs font-semibold uppercase tracking-widest text-dimmed">{{ t('saya.footer.heading_experience') }}</h4>
          <ul class="space-y-2 text-sm">
            <li v-for="item in catalogLinks" :key="item.surface">
              <NuxtLink :to="localePath(item.path)" class="text-muted no-underline transition hover:text-highlighted">{{ t(item.labelKey) }}</NuxtLink>
            </li>
            <li v-if="sections?.reservations">
              <NuxtLink :to="localePath('/reservations')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.header.reservations') }}</NuxtLink>
            </li>
          </ul>
        </div>
        <div v-if="sections?.photos || sections?.posts">
          <h4 class="mb-4 text-xs font-semibold uppercase tracking-widest text-dimmed">{{ t('saya.footer.heading_about') }}</h4>
          <ul class="space-y-2 text-sm">
            <li v-if="sections?.photos">
              <NuxtLink :to="localePath('/photos')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.gallery') }}</NuxtLink>
            </li>
            <li v-if="sections?.posts">
              <NuxtLink :to="localePath('/posts')" class="text-muted no-underline transition hover:text-highlighted">{{ t('saya.footer.posts') }}</NuxtLink>
            </li>
          </ul>
        </div>
      </div>

      <!-- Bottom bar -->
      <SiteFooterBar :name="compliance?.entity_name || brandName" color-mode class="mt-8 border-t border-default pt-8 leading-5 text-muted" />
    </div>
  </footer>
</template>

<script setup lang="ts">
import type { PublicBlawbyPageLink, PublicCompliance } from '~/types/blawby'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'
import { catalogNavigation } from '~/utils/product-presentation'

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

const { localePath, t } = useI18n()

const brandName = computed(() => (props.organization?.name as string)?.trim() || props.compliance?.entity_name || '')
const description = computed(() => props.compliance?.footer_disclaimer || (props.organization?.brand_description as string) || (props.organization?.tagline as string) || '')
const documents = computed(() => props.compliance?.media.filter(item => item.slot === 'document' && item.public_url) ?? [])

const catalogLinks = computed(() => catalogNavigation(props.organization?.vertical as string | undefined, props.sections))

function linksFor(paths: string[]) {
  const byPath = new Map(props.pageLinks.map(item => [item.path, item]))
  return paths.flatMap(path => {
    const item = byPath.get(path)
    return item ? [item] : []
  })
}

const footerGroups = computed(() => [
  { label: t('blawby.footer.practice_areas'), items: linksFor(['/services', '/experiences', '/pricing']) },
  { label: t('blawby.footer.firm'), items: linksFor(['/about', '/contact', '/blog', '/donate']) },
  { label: t('blawby.footer.legal'), items: linksFor(['/disclaimer', '/privacy', '/terms']) },
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
