<template>
  <TenantPhoneBar v-if="phone" :phone="phone" />
  <header
    ref="headerRef"
    data-tenant-critical-header
    class="sticky top-0 z-50 border-b border-default bg-elevated/90 backdrop-blur-md"
  >
    <div
      data-tenant-critical-header-inner
      class="tenant-container flex min-h-16 items-center justify-between gap-4 py-2 lg:grid lg:grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)]"
    >
      <NuxtLink :to="localePath('/')" class="block min-w-0 no-underline leading-none" :aria-label="`${brandName} home`">
        <SiteLogo :alt="brandName" size="lg" loading="eager">
          <span class="tenant-display block truncate text-lg text-highlighted sm:text-xl">{{ brandName }}</span>
        </SiteLogo>
      </NuxtLink>

      <nav data-tenant-critical-nav class="hidden min-w-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap font-semibold uppercase lg:flex" :aria-label="navAriaLabel">
        <NuxtLink
          v-for="item in navItems"
          :key="item.path"
          :to="localePath(item.path)"
          class="max-w-48 truncate rounded-full px-3 py-2 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
          :title="item.title"
        >
          {{ item.title }}
        </NuxtLink>
      </nav>

      <div class="flex items-center justify-end gap-2">
        <TenantButton v-if="primaryAction" :to="localePath(primaryAction.path)" size="sm" @click="primaryAction.consultation && trackConsultation()">
          {{ primaryAction.label }}
        </TenantButton>

        <details ref="mobileNavDetails" class="relative lg:hidden" @toggle="syncMobileNavState">
          <summary
            class="inline-flex size-8 list-none items-center justify-center rounded-full text-muted transition hover:bg-muted hover:text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
            :aria-label="t('site.header.toggle_navigation')"
            :aria-expanded="mobileMenuOpen"
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
            <nav class="grid gap-1" :aria-label="t('site.header.mobile_nav_aria')">
              <NuxtLink v-for="item in navItems" :key="item.path" :to="localePath(item.path)" class="rounded-full px-4 py-2.5 text-sm font-semibold text-default hover:bg-muted" @click="closeMobileNav">
                {{ item.title }}
              </NuxtLink>
            </nav>
          </div>
        </details>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue'
import type { PublicPageLink, PublicConsultationSettings } from '~/types/public-site'
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
  pageLinks?: PublicPageLink[]
}>(), {
  locations: () => [],
  sections: null,
  consultation: null,
  canSchedule: false,
  pageLinks: () => [],
})

const route = useRoute()
const { locale, localePath, t } = useI18n()
const navAriaLabel = computed(() => t('site.header.nav_aria'))

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

// Header height CSS variable sync
const headerRef = shallowRef<Element | null>(null)
let headerResizeObserver: ResizeObserver | null = null

function syncHeaderHeight() {
  if (!headerRef.value) return
  const h = `${headerRef.value.getBoundingClientRect().height}px`
  document.documentElement.style.setProperty('--tenant-header-height', h)
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
// The site's own pages, in the order a visitor reads a practice or venue by.
const headerOrder = ['/services', '/experiences', '/pricing', '/about', '/blog', '/donate']
const catalogLinks = computed(() => (props.organization?.vertical
  ? catalogNavigation(props.organization.vertical as string, props.sections)
  : []))
const showLocations = computed(() => (props.locations || []).filter(location => !location.home_slug).length > 1)
const navItems = computed(() => {
  // A published page names its own link; a catalog surface with no page of its own uses the catalog's word.
  const byPath = new Map(props.pageLinks.map(item => [item.path, item]))
  const items: Array<{ path: string; title: string }> = catalogLinks.value.map(item => ({ path: item.path, title: byPath.get(item.path)?.title ?? t(item.labelKey) }))
  for (const path of headerOrder) {
    const page = byPath.get(path)
    if (page && !items.some(item => item.path === path)) items.push({ path, title: page.title })
  }
  if (props.sections?.reservations) items.push({ path: '/reservations', title: t('site.header.reservations') })
  if (showLocations.value) items.push({ path: '/locations', title: t('site.header.locations') })
  items.push({ path: '/contact', title: props.pageLinks.find(page => page.path === '/contact')?.title || t('site.header.contact') })
  return items
})

// One action: a legal practice's consultation, or the venue's own next step.
const primaryAction = computed(() => {
  if (props.consultation) {
    return props.canSchedule && props.consultation.schedule_path && props.consultation.cta_label
      ? { path: props.consultation.schedule_path, label: props.consultation.cta_label, consultation: true }
      : null
  }
  const path = verticalCopy.value.ctaRoute
  const available = path === '/reservations' ? props.sections?.reservations : path === '/experiences' ? props.sections?.experiences : Boolean(path)
  return available && verticalCopy.value.reserveCta ? { path, label: verticalCopy.value.reserveCta, consultation: false } : null
})

// Mobile Drawer State
const mobileMenuOpen = ref(false)
const articleNav = inject(articleNavKey, null)
const articleSearchLabel = computed(() => articleNav ? t('site.search.dialog_title', { surface: articleNav.value.indexLabel }) : '')
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
