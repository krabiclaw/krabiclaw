<template>
  <TenantPhoneBar v-if="phone" :phone="phone" />
  <header
    ref="headerRef"
    data-tenant-critical-header
    data-saya-critical-header
    data-blawby-critical-header
    class="sticky top-0 z-50 border-b border-default"
    :class="isService ? 'bg-elevated' : 'bg-elevated/90 backdrop-blur-md'"
  >
    <!-- Hospitality / Saya Header: 3-column grid (Left logo monogram, center nav, right CTA) -->
    <div
      v-if="!isService"
      data-tenant-critical-header-inner
      data-saya-critical-header-inner
      class="mx-auto grid h-16 max-w-7xl grid-cols-3 items-center px-4 sm:px-6 lg:px-8"
    >
      <!-- Brand logo monogram -->
      <div class="flex items-center">
        <NuxtLink :to="localePath('/')" data-saya-critical-logo-link class="block no-underline leading-none" :aria-label="`${brandName} home`">
          <SiteLogo :alt="brandName" size="sm" loading="eager">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-on-primary">
              {{ brandName ? brandName.charAt(0).toUpperCase() : 'K' }}
            </div>
          </SiteLogo>
        </NuxtLink>
      </div>

      <!-- Desktop nav (centered) -->
      <nav data-tenant-critical-nav data-saya-critical-nav class="hidden items-center justify-center gap-1 font-semibold uppercase lg:flex" :aria-label="navAriaLabel">
        <NuxtLink
          v-for="item in catalogLinks"
          :key="item.surface"
          :to="localePath(item.path)"
          class="rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          {{ t(item.labelKey) }}
        </NuxtLink>

        <NuxtLink
          v-if="sections?.reservations"
          :to="localePath('/reservations')"
          class="rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          {{ t('saya.header.reservations') }}
        </NuxtLink>

        <NuxtLink
          v-if="showLocations"
          :to="localePath('/locations')"
          class="rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          {{ t('saya.header.locations') }}
        </NuxtLink>
      </nav>

      <!-- Actions (right) -->
      <div class="flex items-center justify-end gap-2 col-start-3">
        <NuxtLink
          v-if="primaryCtaPath && primaryCtaLabel"
          :to="localePath(primaryCtaPath)"
          data-saya-critical-cta
          class="inline-flex items-center justify-center rounded-full bg-primary px-3 py-1.5 text-xs sm:text-sm font-medium text-on-primary no-underline transition hover:opacity-90"
        >
          {{ primaryCtaLabel }}
        </NuxtLink>

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
            <PlatformCommandSearchTrigger
              v-if="articleNav?.search"
              :surface="articleNav.search.surface"
              :variant="articleNav.search.variant"
              :label="articleSearchLabel"
              :aria-label="articleSearchLabel"
              class="mb-3 text-sm"
              @click="closeMobileNav"
            />
            <ArticleSidebar v-if="articleNav" :nav="articleNav" class="mb-3 border-b border-default pb-3" @navigate="closeMobileNav" />
            <nav class="grid gap-1" :aria-label="t('saya.header.mobile_nav_aria')">
              <NuxtLink v-for="item in catalogLinks" :key="item.surface" :to="localePath(item.path)" class="rounded-full px-4 py-2.5 text-sm font-semibold text-default hover:bg-muted" @click="closeMobileNav">
                {{ t(item.labelKey) }}
              </NuxtLink>
              <NuxtLink v-if="showLocations" :to="localePath('/locations')" class="rounded-full px-4 py-2.5 text-sm text-default hover:bg-muted" @click="closeMobileNav">
                {{ t('saya.header.locations') }}
              </NuxtLink>
              <div class="my-1 border-t border-default" />
              <NuxtLink v-if="sections?.reservations" :to="localePath('/reservations')" class="rounded-full px-4 py-2.5 text-sm text-default hover:bg-muted" @click="closeMobileNav">
                {{ t('saya.header.reservations') }}
              </NuxtLink>
              <NuxtLink :to="localePath('/contact')" class="rounded-full px-4 py-2.5 text-sm text-default hover:bg-muted" @click="closeMobileNav">
                {{ t('saya.header.contact') }}
              </NuxtLink>
            </nav>
          </div>
        </details>
      </div>
    </div>

    <!-- Professional Services / Blawby Header: blawby-container with py-2 flex items-center justify-between -->
    <div
      v-else
      class="blawby-container"
    >
      <nav class="relative z-50 flex items-center justify-between gap-4 py-2" :aria-label="navAriaLabel">
        <div class="flex shrink-0 items-center">
          <NuxtLink :to="localePath('/')" class="no-underline" :aria-label="`${brandName} home`">
            <SiteLogo :alt="brandName" size="lg" loading="eager">
              <span class="blawby-display truncate text-lg text-[var(--blawby-primary)] sm:text-xl">
                {{ brandName }}
              </span>
            </SiteLogo>
          </NuxtLink>
        </div>

        <div class="flex min-w-0 items-center gap-x-3 font-semibold uppercase">
          <div class="hidden items-center whitespace-nowrap text-[var(--blawby-primary)] lg:flex">
            <NuxtLink
              v-for="item in serviceNavItems"
              :key="item.path"
              :to="localePath(item.path)"
              class="inline-block rounded-lg px-2 py-1 text-sm no-underline transition hover:text-[var(--blawby-accent-strong)]"
            >
              {{ item.title }}
            </NuxtLink>
          </div>

          <TenantButton
            v-if="canSchedule && consultation?.schedule_path && headerCtaLabel"
            :to="localePath(consultation.schedule_path)"
            @click="trackConsultation"
          >
            <svg class="-ml-0.5 mr-2 size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" />
            </svg>
            <span>{{ headerCtaLabel }}</span>
          </TenantButton>

          <details ref="mobileNavDetails" class="relative -mr-1 shrink-0 lg:hidden" @toggle="syncMobileNavState">
            <summary
              class="relative z-10 flex size-8 list-none items-center justify-center text-[var(--blawby-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-primary)] [&::-webkit-details-marker]:hidden"
              :aria-label="t('blawby.navigation.toggle')"
              :aria-expanded="mobileMenuOpen"
            >
              <svg class="size-4 overflow-visible stroke-current" viewBox="0 0 14 14" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path :class="mobileMenuOpen ? 'scale-90 opacity-0' : ''" class="origin-center transition" d="M0 1H14M0 7H14M0 13H14" />
                <path :class="mobileMenuOpen ? '' : 'scale-90 opacity-0'" class="origin-center transition" d="M2 2L12 12M12 2L2 12" />
              </svg>
            </summary>
            <div class="absolute right-0 top-full mt-4 max-h-[calc(100vh-6rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl bg-elevated p-4 text-lg normal-case text-[var(--blawby-primary)] shadow-xl ring-1 ring-default">
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
              <NuxtLink
                v-for="item in serviceNavItems"
                :key="item.path"
                :to="localePath(item.path)"
                class="block w-full p-2 no-underline hover:text-[var(--blawby-accent-strong)]"
                @click="closeMobileNav"
              >
                {{ item.title }}
              </NuxtLink>
            </div>
          </details>
      </div>
      </nav>
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
const navAriaLabel = computed(() => t('saya.header.nav_aria'))

const { trackConsultationClick } = useOrganizationConversionTracking(() => props.consultation)

const brandName = computed(() => (props.organization?.name as string)?.trim() || '')
const phone = computed(() => {
  const org = props.organization
  const orgConfig = org && typeof org.config === 'object' && org.config !== null ? (org.config as Record<string, unknown>) : null
  const candidates = [org?.phone, orgConfig?.phone, props.locations?.[0]?.phone]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return null
})
const isService = computed(() => props.organization?.vertical === 'service' || Boolean(props.consultation?.mode) || props.pageLinks.some(l => l.path === '/services'))

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
const serviceNavItems = computed(() => {
  if (headerItems.value.length > 0) {
    return headerItems.value
  }
  return catalogLinks.value.map(item => ({ path: item.path, title: t(item.labelKey) }))
})
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
