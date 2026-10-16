<template>
  <div>
    <header ref="headerRef" data-saya-critical-header class="sticky top-0 z-50 border-b border-default bg-default/80 backdrop-blur-md">
      <div data-saya-critical-header-inner class="mx-auto grid h-16 max-w-7xl grid-cols-[1fr_auto_1fr] items-center px-4 sm:px-6 lg:px-8">
        <!-- Brand logo / name -->
          <NuxtLink :to="localePath('/')" data-saya-critical-logo-link class="w-fit shrink-0 justify-self-start no-underline">
          <SiteLogo :alt="restaurantName" size="sm" loading="eager">
            <!-- No logo asset: a monogram of the tenant's own name, in the
                 tenant's own action color. It used to be --kc-navy, which put
                 KrabiClaw's platform navy on every tenant site that had not
                 uploaded a logo. -->
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-on-primary">
              {{ restaurantName.charAt(0).toUpperCase() }}
            </div>
          </SiteLogo>
        </NuxtLink>

        <!-- Desktop nav -->
        <nav data-saya-critical-nav class="hidden items-center gap-1 lg:flex" :aria-label="t('saya.header.nav_aria')">
          <NuxtLink
            v-for="item in catalogLinks"
            :key="item.surface"
            :to="localePath(item.path)"
            class="rounded-full px-3 py-2 text-sm text-muted transition hover:bg-muted hover:text-default"
          >
            {{ t(item.labelKey) }}
          </NuxtLink>

          <NuxtLink
            v-if="sections?.reservations"
            :to="localePath('/reservations')"
            class="rounded-full px-3 py-2 text-sm text-muted transition hover:bg-muted hover:text-default"
          >
            {{ t('saya.header.reservations') }}
          </NuxtLink>
          <NuxtLink
            v-if="showLocations"
            :to="localePath('/locations')"
            class="rounded-full px-3 py-2 text-sm text-muted transition hover:bg-muted hover:text-default"
          >
            {{ t('saya.header.locations') }}
          </NuxtLink>
        </nav>

        <div class="flex items-center justify-end gap-2 col-start-3">
          <NuxtLink
            v-if="primaryCtaPath"
            :to="localePath(primaryCtaPath)"
            data-saya-critical-cta
            class="inline-flex items-center justify-center rounded-full bg-primary px-3 py-1.5 text-xs sm:text-sm font-medium text-on-primary no-underline transition hover:opacity-90"
          >
            {{ primaryCtaLabel }}
          </NuxtLink>

          <!-- Mobile menu toggle -->
          <details ref="mobileNavDetails" class="lg:hidden" @toggle="syncMobileNavState">
            <summary
              data-saya-critical-menu
              class="inline-flex size-8 list-none items-center justify-center rounded-full text-muted transition hover:bg-muted hover:text-default [&::-webkit-details-marker]:hidden"
              :aria-label="mobileMenuOpen ? t('saya.header.close_navigation') : t('saya.header.open_navigation')"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" class="size-5"><path fill-rule="evenodd" d="M2.75 5.75a.75.75 0 01.75-.75h13a.75.75 0 010 1.5h-13a.75.75 0 01-.75-.75zM2.75 10a.75.75 0 01.75-.75h13a.75.75 0 010 1.5h-13A.75.75 0 012.75 10zM2.75 14.25a.75.75 0 01.75-.75h13a.75.75 0 010 1.5h-13a.75.75 0 01-.75-.75z" clip-rule="evenodd" /></svg>
            </summary>
            <div class="absolute inset-x-0 top-16 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-default bg-default p-4 shadow-sm lg:hidden">
              <!-- On a blog page, its articles come first: this menu is the page's one navigation. -->
              <PlatformCommandSearchTrigger
                v-if="articleNav?.search"
                :surface="articleNav.search.surface"
                :variant="articleNav.search.variant"
                :label="articleSearchLabel"
                :aria-label="articleSearchLabel"
                class="mb-3"
                @click="closeMobileNav"
              />
              <ArticleSidebar v-if="articleNav" :nav="articleNav" class="mb-3 border-b border-default pb-3" @navigate="closeMobileNav" />
              <nav class="grid gap-1" :aria-label="t('saya.header.mobile_nav_aria')">
                <NuxtLink v-for="item in catalogLinks" :key="item.surface" :to="localePath(item.path)" class="rounded-full px-4 py-3 text-sm font-semibold text-default hover:bg-muted" @click="closeMobileNav">
                  {{ t(item.labelKey) }}
                </NuxtLink>
                <NuxtLink v-if="showLocations" :to="localePath('/locations')" class="rounded-full px-4 py-3 text-sm text-default hover:bg-muted" @click="closeMobileNav">
                  {{ t('saya.header.locations') }}
                </NuxtLink>
                <div class="my-1 border-t border-default" />
                <NuxtLink v-if="sections?.reservations" :to="localePath('/reservations')" class="rounded-full px-4 py-3 text-sm text-default hover:bg-muted" @click="closeMobileNav">
                  {{ t('saya.header.reservations') }}
                </NuxtLink>
                <NuxtLink :to="localePath('/contact')" class="rounded-full px-4 py-3 text-sm text-default hover:bg-muted" @click="closeMobileNav">
                  {{ t('saya.header.contact') }}
                </NuxtLink>
              </nav>
            </div>
          </details>
        </div>
      </div>

    </header>
  </div>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue'
interface Organization {
  name?: string | null
  media?: Array<{ slot?: string; public_url?: string | null }>
  plan?: string
  vertical?: string | null
}

interface I18nComposable {
  locale: Ref<string>
  locales: Ref<Array<{ code: string; name: string }>>
  setLocale: (_code: string) => void
  localePath: (_path: string) => string
  t: (_key: string, _named?: Record<string, unknown>) => string
}


import { getVerticalCopy } from '~/utils/vertical-copy'
import ArticleSidebar from '~/components/blog/ArticleSidebar.vue'
import PlatformCommandSearchTrigger from '~/components/platform/search/PlatformCommandSearchTrigger.vue'
import { articleNavKey } from '~/composables/useArticleNav'
import { catalogNavigation } from '~/utils/product-presentation'
import type { PublicShellPayload } from '~/utils/public-resource-contracts'

// Data comes from layouts/saya.vue, which already owns the single shared
// bootstrap/tenant-site fetch — header is presentation-only, not a fetcher.
const props = defineProps<{
  organization: Organization | null
  locations: ApiRecord[]
  sections: PublicShellPayload['sections'] | null
}>()

const i18n = useI18n() as ApiValue as I18nComposable
const { locale, localePath, t } = i18n
const verticalCopy = computed(() => getVerticalCopy(props.organization?.vertical, locale.value))
const mobileMenuOpen = ref(false)
const articleNav = inject(articleNavKey, null)
const articleSearchLabel = computed(() => articleNav ? t('saya.search.dialog_title', { surface: articleNav.value.indexLabel }) : '')
const mobileNavDetails = ref<HTMLDetailsElement | null>(null)
const headerRef = shallowRef<Element | null>(null)
let headerResizeObserver: ResizeObserver | null = null

function syncMobileNavState(event: Event) {
  mobileMenuOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

function closeMobileNav() {
  mobileMenuOpen.value = false
  if (mobileNavDetails.value) mobileNavDetails.value.open = false
}

function syncHeaderHeight() {
  if (!headerRef.value) return
  document.documentElement.style.setProperty('--saya-header-height', `${headerRef.value.getBoundingClientRect().height}px`)
}

onMounted(() => {
  mobileMenuOpen.value = mobileNavDetails.value?.open ?? false
  syncHeaderHeight()
  headerResizeObserver = new ResizeObserver(syncHeaderHeight)
  if (headerRef.value) headerResizeObserver.observe(headerRef.value)
  window.addEventListener('resize', syncHeaderHeight)
})

onUnmounted(() => {
  headerResizeObserver?.disconnect()
  window.removeEventListener('resize', syncHeaderHeight)
})

const restaurantName = computed(() => props.organization?.name?.trim() || '')

// Each section is offered only when the site has something on it.
const catalogLinks = computed(() => catalogNavigation(props.organization?.vertical, props.sections))
// A location that is one home is reached as that home, so the index of
// locations is offered only when more than one location has a page of its own.
const showLocations = computed(() => props.locations.filter(location => !location.home_slug).length > 1)
const primaryCtaPath = computed(() => {
  const path = verticalCopy.value.ctaRoute
  return path === '/reservations' ? (props.sections?.reservations ? path : '')
    : path === '/experiences' ? (props.sections?.experiences ? path : '') : path
})
const primaryCtaLabel = computed(() => verticalCopy.value.reserveCta)

</script>
