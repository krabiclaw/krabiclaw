<template>
  <TenantPhoneBar v-if="phone" :phone="phone" />
  <header
    ref="headerRef"
    data-tenant-critical-header
    data-saya-critical-header
    data-blawby-critical-header
    class="sticky top-0 z-50 border-b border-default bg-elevated/90 backdrop-blur-md"
  >
    <div
      data-tenant-critical-header-inner
      data-saya-critical-header-inner
      class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8"
    >
      <!-- Brand logo / monogram / name -->
      <div class="flex shrink-0 items-center">
        <NuxtLink :to="localePath('/')" data-saya-critical-logo-link class="no-underline flex items-center gap-3" :aria-label="`${brandName} home`">
          <SiteLogo :alt="brandName" size="sm" loading="eager">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-on-primary">
              {{ brandName ? brandName.charAt(0).toUpperCase() : 'K' }}
            </div>
          </SiteLogo>
          <span v-if="brandName" class="tenant-display truncate text-lg font-bold text-highlighted sm:text-xl">
            {{ brandName }}
          </span>
        </NuxtLink>
      </div>

      <!-- Desktop nav -->
      <nav data-tenant-critical-nav data-saya-critical-nav class="hidden items-center gap-1 font-semibold uppercase lg:flex" :aria-label="t('blawby.navigation.main')">
        <!-- Page links (if authored page links exist) -->
        <NuxtLink
          v-for="item in headerItems"
          :key="item.id"
          :to="localePath(item.path)"
          class="rounded-lg px-3 py-2 text-sm text-muted no-underline transition hover:text-highlighted"
        >
          {{ item.title }}
        </NuxtLink>

        <!-- Catalog navigation links (menu, experiences, products) -->
        <NuxtLink
          v-for="item in catalogLinks"
          :key="item.surface"
          :to="localePath(item.path)"
          class="rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          {{ t(item.labelKey) }}
        </NuxtLink>

        <!-- Reservations link -->
        <NuxtLink
          v-if="sections?.reservations"
          :to="localePath('/reservations')"
          class="rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          {{ t('saya.header.reservations') }}
        </NuxtLink>

        <!-- Locations link -->
        <NuxtLink
          v-if="showLocations"
          :to="localePath('/locations')"
          class="rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          {{ t('saya.header.locations') }}
        </NuxtLink>
      </nav>

      <!-- Actions: CTA & Mobile Hamburger -->
      <div class="flex items-center gap-2">
        <TenantButton
          v-if="canSchedule && consultation?.schedule_path && headerCtaLabel"
          :to="localePath(consultation.schedule_path)"
          size="sm"
          data-saya-critical-cta
          @click="trackConsultation"
        >
          <svg class="-ml-0.5 mr-1.5 size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" />
          </svg>
          <span>{{ headerCtaLabel }}</span>
        </TenantButton>
        <TenantButton
          v-else-if="primaryCtaPath && primaryCtaLabel"
          :to="localePath(primaryCtaPath)"
          size="sm"
          data-saya-critical-cta
        >
          {{ primaryCtaLabel }}
        </TenantButton>

        <!-- Mobile menu toggle -->
        <details ref="mobileNavDetails" class="relative lg:hidden" @toggle="syncMobileNavState">
          <summary
            data-saya-critical-menu
            class="inline-flex size-8 list-none items-center justify-center rounded-full text-muted transition hover:bg-muted hover:text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
            :aria-label="mobileMenuOpen ? t('saya.header.close_navigation') : t('saya.header.open_navigation')"
          >
            <svg class="size-4 overflow-visible stroke-current" viewBox="0 0 14 14" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path :class="mobileMenuOpen ? 'scale-90 opacity-0' : ''" class="origin-center transition" d="M0 1H14M0 7H14M0 13H14" />
              <path :class="mobileMenuOpen ? '' : 'scale-90 opacity-0'" class="origin-center transition" d="M2 2L12 12M12 2L2 12" />
            </svg>
          </summary>
          <div class="absolute right-0 top-full mt-3 max-h-[calc(100vh-5rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-default bg-elevated p-4 text-base normal-case text-default shadow-xl ring-1 ring-default">
            <!-- Article search trigger & sidebar if inside article -->
            <PlatformCommandSearchTrigger
              v-if="articleNav?.search"
              :surface="articleNav.search.surface"
              :variant="articleNav.search.variant"
              :label="articleSearchLabel"
              :aria-label="articleSearchLabel"
              class="mb-3 text-base"
              @click="closeMobileNav"
            />
            <ArticleSidebar v-if="articleNav" :nav="articleNav" class="mb-3 border-b border-default pb-3" @navigate="closeMobileNav" />

            <!-- Page links -->
            <NuxtLink
              v-for="item in headerItems"
              :key="item.id"
              :to="localePath(item.path)"
              class="block w-full rounded-lg px-2 py-1.5 text-muted no-underline transition hover:bg-muted hover:text-default"
              @click="closeMobileNav"
            >
              {{ item.title }}
            </NuxtLink>

            <!-- Catalog links -->
            <NuxtLink
              v-for="item in catalogLinks"
              :key="item.surface"
              :to="localePath(item.path)"
              class="block w-full rounded-lg px-2 py-1.5 text-muted no-underline transition hover:bg-muted hover:text-default"
              @click="closeMobileNav"
            >
              {{ t(item.labelKey) }}
            </NuxtLink>

            <NuxtLink
              v-if="sections?.reservations"
              :to="localePath('/reservations')"
              class="block w-full rounded-lg px-2 py-1.5 text-muted no-underline transition hover:bg-muted hover:text-default"
              @click="closeMobileNav"
            >
              {{ t('saya.header.reservations') }}
            </NuxtLink>

            <NuxtLink
              v-if="showLocations"
              :to="localePath('/locations')"
              class="block w-full rounded-lg px-2 py-1.5 text-muted no-underline transition hover:bg-muted hover:text-default"
              @click="closeMobileNav"
            >
              {{ t('saya.header.locations') }}
            </NuxtLink>
          </div>
        </details>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue'
import type { PublicBlawbyPageLink, PublicConsultationSettings } from '~/types/blawby'
import ArticleSidebar from '~/components/blog/ArticleSidebar.vue'
import PlatformCommandSearchTrigger from '~/components/platform/search/PlatformCommandSearchTrigger.vue'
import { articleNavKey } from '~/composables/useArticleNav'
import { catalogNavigation } from '~/utils/product-presentation'
import { getVerticalCopy } from '~/utils/vertical-copy'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'

const props = withDefaults(defineProps<{
  organization: ApiRecord | null
  locations?: ApiRecord[]
  sections?: PublicShellPayload['sections'] | null
  consultation?: PublicConsultationSettings | null
  canSchedule?: boolean
  pageLinks?: PublicBlawbyPageLink[]
}>(), {
  locations: () => [],
  sections: null,
  consultation: null,
  canSchedule: false,
  pageLinks: () => [],
})

const route = useRoute()
const { locale, localePath, t } = useI18n()

const { trackConsultationClick } = useOrganizationConversionTracking(() => props.consultation)

const brandName = computed(() => (props.organization?.name as string)?.trim() || '')
const phone = computed(() => (props.organization?.phone as string) || null)

// Header height CSS variable sync
const headerRef = shallowRef<Element | null>(null)
let headerResizeObserver: ResizeObserver | null = null

function syncHeaderHeight() {
  if (!headerRef.value) return
  const h = `${headerRef.value.getBoundingClientRect().height}px`
  document.documentElement.style.setProperty('--tenant-header-height', h)
  document.documentElement.style.setProperty('--saya-header-height', h)
}

onMounted(() => {
  syncHeaderHeight()
  headerResizeObserver = new ResizeObserver(syncHeaderHeight)
  if (headerRef.value) headerResizeObserver.observe(headerRef.value)
  window.addEventListener('resize', syncHeaderHeight)
})

onUnmounted(() => {
  headerResizeObserver?.disconnect()
  window.removeEventListener('resize', syncHeaderHeight)
})

// Navigation & Actions
const verticalCopy = computed(() => (props.organization?.vertical
  ? getVerticalCopy(props.organization.vertical as string, locale.value)
  : { ctaRoute: '', reserveCta: '' }))
const headerCtaLabel = computed(() => props.consultation?.cta_label)
const headerOrder = ['/services', '/experiences', '/pricing', '/about', '/contact', '/blog', '/donate']
const headerItems = computed(() => {
  const byPath = new Map(props.pageLinks.map(item => [item.path, item]))
  return headerOrder.flatMap(path => {
    const item = byPath.get(path)
    return item ? [item] : []
  })
})

const catalogLinks = computed(() => (props.organization?.vertical
  ? catalogNavigation(props.organization.vertical as string, props.sections)
  : []))
const showLocations = computed(() => (props.locations || []).filter(location => !location.home_slug).length > 1)

const primaryCtaPath = computed(() => {
  const path = verticalCopy.value.ctaRoute
  return path === '/reservations' ? (props.sections?.reservations ? path : '')
    : path === '/experiences' ? (props.sections?.experiences ? path : '') : path
})
const primaryCtaLabel = computed(() => verticalCopy.value.reserveCta)

// Mobile Drawer State
const mobileMenuOpen = ref(false)
const articleNav = inject(articleNavKey, null)
const articleSearchLabel = computed(() => articleNav ? t('saya.search.dialog_title', { surface: articleNav.value.indexLabel }) : '')
const mobileNavDetails = ref<HTMLDetailsElement | null>(null)

function syncMobileNavState(event: Event) {
  mobileMenuOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

function closeMobileNav() {
  mobileMenuOpen.value = false
  if (mobileNavDetails.value) mobileNavDetails.value.open = false
}

function trackConsultation() {
  if (props.consultation?.schedule_path) {
    trackConsultationClick('header', route.path, props.consultation.schedule_path)
  }
}
</script>
