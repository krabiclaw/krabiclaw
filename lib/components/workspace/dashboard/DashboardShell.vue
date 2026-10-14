<template>
  <UApp>
    <div class="platform-theme" data-surface="dashboard">
    <div v-if="impersonatedBy" class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 sm:left-1/2 sm:right-auto sm:w-1/3 sm:-translate-x-1/2 sm:px-0">
      <div class="pointer-events-auto flex w-full max-w-full flex-wrap items-center justify-center gap-3 rounded-t-2xl border border-warning/40 border-b-0 bg-default px-6 py-4 shadow-[0_-4px_24px_rgba(0,0,0,0.15)]">
        <span class="relative flex size-2 shrink-0">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
          <span class="relative inline-flex size-2 rounded-full bg-warning" />
        </span>
        <span class="min-w-0 truncate text-sm font-medium text-highlighted">
          Impersonating <span class="font-semibold">{{ sessionData?.user?.email }}</span>
        </span>
        <span v-if="impersonationError" class="text-xs text-error font-medium">{{ impersonationError }}</span>
        <UButton size="xs" color="warning" variant="soft" :loading="stoppingImpersonation" @click="stopImpersonating">
          Stop impersonating
        </UButton>
      </div>
    </div>

    <div
      v-if="shellError"
      class="flex min-h-screen items-center justify-center bg-default px-6"
      data-testid="dashboard-context-error"
    >
      <UCard class="w-full max-w-xl">
        <h1 class="text-xl font-semibold text-highlighted">Dashboard context could not be loaded</h1>
        <p class="mt-3 text-sm text-muted">{{ dashboardContextErrorMessage }}</p>
        <p v-if="dashboardContextRequestId" class="mt-2 text-xs text-dimmed">
          Request ID: {{ dashboardContextRequestId }}
        </p>
        <UButton class="mt-6" @click="retryDashboardContext">
          Try again
        </UButton>
      </UCard>
    </div>

    <div v-else>
    <DashboardTopNav
      :items="showNavChrome ? primaryNavItems : []"
      :home-to="topNavHomeTo"
      :menu-active="isMenuPageActive"
      @menu="menuOpen = true"
    />

    <!--
      The group sits above the nav chrome, not below it. UDashboardGroup is
      `position: fixed`, which makes it a stacking context, so anything inside it
      composites at the group's level no matter how high its own z-index is. With
      the navs at z-40 a leaf sheet at z-50 still painted underneath them. The
      group's box is inset away from both navs, so nothing overlaps in the normal
      case; only an element that deliberately spans the viewport reaches them.
    -->
    <UDashboardGroup
      :ui="{ base: ['z-40', showNavChrome ? 'md:top-(--kc-dashboard-top-nav)' : 'top-(--kc-dashboard-top-nav)', showBottomNav ? 'max-md:bottom-(--kc-dashboard-bottom-nav)' : ''].join(' ') }"
    >
      <UDashboardSearch
        v-model:open="dashboardSearchOpen"
        v-model:search-term="dashboardSearchTerm"
        title="Search"
        description="Search this organization"
        placeholder="Search…"
        size="lg"
        :fullscreen="isPhoneWidth"
        :groups="dashboardSearchGroups"
        :loading="dashboardSearchLoading"
        :color-mode="false"
      >
        <template v-if="dashboardSearchError" #footer>
          <p class="text-sm text-error" role="alert" data-testid="dashboard-search-error">{{ dashboardSearchError }}</p>
        </template>
      </UDashboardSearch>

      <slot />
    </UDashboardGroup>

    <nav
      v-if="showBottomNav"
      class="fixed inset-x-0 bottom-0 z-30 flex h-(--kc-dashboard-bottom-nav) items-stretch border-t border-default bg-default pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="Dashboard"
      data-testid="dashboard-mobile-nav"
    >
      <NuxtLink
        v-for="item in primaryNavItems"
        :key="item.key"
        :to="item.to"
        class="flex flex-1 flex-col items-center justify-center gap-1 px-1 py-2 no-underline transition-colors"
        :class="item.active ? 'text-primary' : 'text-dimmed hover:text-highlighted'"
        :aria-current="item.active ? 'page' : undefined"
      >
        <UIcon :name="item.icon" class="size-6 shrink-0" />
        <span class="text-[10px] leading-tight font-medium">{{ item.label }}</span>
      </NuxtLink>
      <NuxtLink
        :to="menuPageTo"
        class="flex flex-1 flex-col items-center justify-center gap-1 px-1 py-2 no-underline transition-colors"
        :class="isMenuPageActive ? 'text-primary' : 'text-dimmed hover:text-highlighted'"
        :aria-current="isMenuPageActive ? 'page' : undefined"
        data-testid="dashboard-mobile-nav-menu-link"
      >
        <UIcon name="i-lucide-menu" class="size-6 shrink-0" />
        <span class="text-[10px] leading-tight font-medium">Menu</span>
      </NuxtLink>
    </nav>
    </div>

    <!-- A failed background refetch leaves the shell on what it had and says so. -->
    <UAlert
      v-if="shellRefetchError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      class="fixed inset-x-4 top-4 z-50 mx-auto max-w-md"
      :description="shellRefetchError"
      :actions="[{ label: 'Try again', onClick: () => void retryDashboardContext() }]"
      data-testid="dashboard-refetch-error"
    />

    <!-- A refused organization switch stays on screen: the session did not move. -->
    <UAlert
      v-if="organizationSwitchError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      class="fixed inset-x-4 top-4 z-50 mx-auto max-w-md"
      :description="organizationSwitchError"
      :close="{ onClick: () => (organizationSwitchError = null) }"
    />

    <DashboardMenuSlideover v-model:open="menuOpen" />

    <BillingServiceUpsellModal />
    </div>
  </UApp>
</template>

<script setup lang="ts">
import DashboardTopNav from '~/lib/components/workspace/dashboard/DashboardTopNav.vue'
import DashboardMenuSlideover from '~/lib/components/workspace/dashboard/DashboardMenuSlideover.vue'
import type { DashboardScopeHeaderModel } from '~/lib/components/workspace/dashboard/DashboardScopeHeader.vue'
import { dashboardScopeHeaderModelKey } from '~/lib/components/workspace/dashboard/dashboardScopeHeaderContext'
import { authClient } from '~/lib/auth-client'
import { reconcileAnalyticsConsent } from '~/composables/useAnalyticsConsentReconciliation'
import { useAnalytics } from '~/composables/useAnalytics'
import '~/assets/css/dashboard.css'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { useMediaQuery } from '@vueuse/core'

// ─────────────────────────────────────────────────────────────────────────
// Dashboard shell architecture.
//
// The sidebar this layout used to carry is gone, along with the scope-grouped
// manager nav that issue #316 designed. That nav had already stopped rendering
// before it was removed — its groups were declared, underscore-prefixed to
// silence the unused-vars rule, and referenced by nothing. Everything beyond
// the bottom-bar tabs lives in the Menu tab, the organization's settings level
// (see useDashboardMenu).
//
// Invariants that must hold no matter what gets added later:
// - One layout, one nav source. mobileNavItems feeds both the top nav and the
//   bottom bar; never build a second list for one of them.
// - `scope` is derived ONLY from explicit route params (locationSlug >
//   orgSlug), never from route.path regexes, residual dashboard-context state,
//   or a "last visited" fallback — those misclassify scope at ancestor routes
//   once state has been populated from a deeper page in the same session.
// - New verticals/templates need zero changes here: capabilities come from
//   resolveCmsCapabilities, and the only thing this layout reads from them is
//   locationVocabulary, for the children label.
// ─────────────────────────────────────────────────────────────────────────

interface AuthOrganization {
  id: string
  name: string
  slug: string
}

const route = useRoute()
const router = useRouter()
const session = authClient.useSession()
const sessionData = computed(() => session.value.data)
const refreshSession = () => session.value.refetch()
const { trackDashboardVisited, setUserId } = useAnalytics()
const impersonationError = ref<string | null>(null)
const stoppingImpersonation = ref(false)
const { searchTerm: dashboardSearchTerm, loading: dashboardSearchLoading, error: dashboardSearchError, groups: dashboardSearchGroups } = useDashboardSearch()
// The Menu's Search row and a list's search icon open the same palette ⌘K does.
// Registered for this layout's lifetime only: a hook left behind by an earlier
// mount toggled the palette a second time and cancelled the first.
const dashboardSearchOpen = ref(false)
// On a phone the palette is the screen, like every other sheet here; on a wide screen it is a card.
const isPhoneWidth = useMediaQuery('(max-width: 767px)')
const nuxtApp = useNuxtApp()
let unhookSearchToggle: (() => void) | null = null
onMounted(() => {
  // Billing resumes signed in: honor the analytics choice made while signed out.
  void reconcileAnalyticsConsent().catch(error => nuxtApp.callHook('vue:error', error, null, 'analytics-consent-reconciliation'))
  unhookSearchToggle = nuxtApp.hooks.hook('dashboard:search:toggle', () => { dashboardSearchOpen.value = !dashboardSearchOpen.value })
})
onBeforeUnmount(() => { unhookSearchToggle?.(); unhookSearchToggle = null })
// The dashboard-context middleware has loaded the route's organization context
// before the route arrives here, so a scope change keeps the previous screen
// until the new one can render, and this layout never waits on it.
const dashboard = useDashboardOrganization()
const organizationsState = authClient.useListOrganizations()
// The shell's scope is Better Auth's session and organizations: until both have
// answered once, no tabs are drawn rather than Personal's for a moment.
const shellScopeKnown = computed(() => !session.value.isPending && !unref(organizationsState).isPending)
// What the shell could not load replaces it only when there is nothing to show.
// Better Auth keeps the session and organizations it already had when a
// background refetch fails, so that failure is reported over the shell instead.
const shellError = computed(() =>
  dashboard.error.value
  ?? (session.value.data ? null : session.value.error)
  ?? (unref(organizationsState).data ? null : unref(organizationsState).error)
  ?? null)
const shellRefetchError = computed(() => {
  if (shellError.value) return null
  const error = session.value.error ?? unref(organizationsState).error
  return error ? getErrorMessage(error, 'Your account could not be refreshed') : null
})
const platformTheme = usePlatformTheme()

if (import.meta.client) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemThemeChange = () => platformTheme.sync()

  onMounted(() => platformTheme.restore())
  prefersDark.addEventListener('change', onSystemThemeChange)
  const stopThemeWatch = watch(platformTheme.preference, platformTheme.sync)

  onBeforeUnmount(() => {
    prefersDark.removeEventListener('change', onSystemThemeChange)
    stopThemeWatch()
  })
}

watch(
  () => sessionData.value?.user?.id ?? null,
  userId => setUserId(userId),
  { immediate: true },
)


const dashboardContextErrorMessage = computed(() =>
  getErrorMessage(shellError.value, 'Dashboard context request failed'),
)
const dashboardContextRequestId = computed(() =>
  shellError.value instanceof ApiClientError
    ? shellError.value.requestId
    : null,
)

async function retryDashboardContext() {
  await Promise.all([dashboard.refresh(), session.value.refetch(), unref(organizationsState).refetch()])
}

const organization = dashboard.organization

const organizations = computed<readonly AuthOrganization[]>(() => unref(organizationsState)?.data ?? [])
// The shell's scope — the switcher, the tabs, Menu — is read in one place
// (useDashboardMenu): the organization the route names, otherwise Better Auth's
// active organization. Personal is neither. Account settings opened from inside
// an organization stays in that organization.
//
// Setting the active organization belongs to `/api/post-login` and to explicit
// selection in the scope switcher, never to a side effect of visiting a route.
const { menuPageTo, personal, organization: scopeOrganization, activeOrganizationId } = useDashboardMenu()

const impersonatedBy = computed(() => {
  const session = sessionData.value?.session as { impersonatedBy?: string } | undefined
  return session?.impersonatedBy
})

const realtimeOrganizationSlug = computed(() => {
  const slug = router.currentRoute.value.params.orgSlug
  return !stoppingImpersonation.value && typeof slug === 'string' ? slug : null
})
provideDashboardInvalidations(realtimeOrganizationSlug)

// Read straight off the route for navigation and routing purposes
const routeLocationSlug = computed(() => typeof route.params.locationSlug === 'string' ? route.params.locationSlug : null)
// The organization's mark is its `logo` media placement, loaded with the
// dashboard context of the route's organization. There is no second source: a
// route with no organization context renders no avatar rather than another
// organization's image or a generic icon standing in for one.
const scopeOrganizationAvatar = computed(() =>
  mediaStillUrl(organization.value?.media.find(item => item.slot === 'logo')) ?? undefined)

// Progressive drill-in: exactly one scope is active per route, and the sidebar's
// single ContextSwitcher (this dropdown) and NavigationGroups both key off it —
// there is no separate sidebar shell per scope, only scope-driven content inside
// the one stable header/nav slots (see issue #316's "one stable sidebar" rule).
//
// The drill-in is organization → location.
const scope = computed<'organization' | 'location'>(() => routeLocationSlug.value ? 'location' : 'organization')

// One reusable scope-header model feeds both the desktop sidebar and the mobile
// navbar leading control. Detail pages may override it with an explicit index
// parent, but scope navigation never infers a parent from browser history.
const scopeHeaderModel = computed<DashboardScopeHeaderModel>(() => {
  return {
    current: {
      label: personal.value ? 'Personal' : scopeOrganization.value?.name ?? 'Organization',
      avatar: personal.value ? sessionData.value?.user?.image ?? undefined : scopeOrganizationAvatar.value,
    },
    parent: null,
    // Peers carry no mark. `organization.logo` is Better Auth's column and
    // nothing here writes it, and the dashboard context loads media for the
    // active organization only — drawing anything for a peer would claim
    // "no logo" where the truth is "not loaded".
    peers: [{ label: 'Personal', active: personal.value, onSelect: () => void selectOrganization(null) }, ...organizations.value.map((org) => ({
      id: org.id,
      label: org.name,
      active: org.id === scopeOrganization.value?.id,
      // Which one is a plain link is the *session's* question, not the route's.
      // A route can be open in an organization the session is not active in,
      // and that peer must tell Better Auth before it navigates.
      ...(org.id === activeOrganizationId.value
        ? { to: `/dashboard/${encodeURIComponent(org.slug)}` }
        : { onSelect: () => void selectOrganization(org) }),
    }))],
    createAction: { label: 'New organization', to: '/dashboard/onboarding' }
  }
})



/**
 * Explicit selection updates Better Auth's active organization first, then
 * navigates. Personal clears it through the same native operation.
 */
const organizationSwitchError = ref<string | null>(null)
// One activation at a time. Two quick presses raced: both called `setActive`,
// and whichever resolved last decided the session while the other was already
// navigating — the dashboard could open an organization the session left.
const switchingOrganization = ref(false)
async function selectOrganization(org: { id: string, slug: string } | null) {
  if (switchingOrganization.value) return
  switchingOrganization.value = true
  organizationSwitchError.value = null
  try {
    await activateOrganization(org)
  } finally {
    switchingOrganization.value = false
  }
}

async function activateOrganization(org: { id: string, slug: string } | null) {
  const { error } = await authClient.organization.setActive({ organizationId: org?.id ?? null })
  if (error) {
    // Staying put is the honest outcome: the session is still in the old
    // organization, so entering the new one would show a dashboard the session
    // is not actually in.
    organizationSwitchError.value = error.message || 'Could not switch view'
    return
  }
  await session.value.refetch()
  await navigateTo(org ? `/dashboard/${encodeURIComponent(org.slug)}` : '/dashboard/account')
}

provide(dashboardScopeHeaderModelKey, scopeHeaderModel)

interface DashboardMobileNavItem {
  key: string
  label: string
  icon: string
  to?: string
  active?: boolean
}

/**
 * The tab a screen belongs to is declared by its destination root as
 * `definePageMeta({ tab })` — Today, Calendar, Catalog, Messages or Menu. It
 * is read, never inferred: not from the URL, not from where Back leads. A
 * screen that declares none lights no tab rather than borrowing one.
 */
const activeTab = computed(() => {
  const tab = route.matched[0]?.meta.tab
  return typeof tab === 'string' ? tab : null
})

/** The tabs themselves; which one is lit is answered after they are known. */
const navTargets = computed<DashboardMobileNavItem[]>(() => {
  // A flow that creates an organization, such as onboarding, declares it has no tabs.
  if (route.meta.tabs === false || !shellScopeKnown.value) return []
  if (personal.value) return [
    { key: 'today', label: 'Today', icon: 'i-lucide-bookmark', to: '/dashboard/account' },
    { key: 'calendar', label: 'Calendar', icon: 'i-lucide-calendar-days', to: '/dashboard/account/calendar' },
    { key: 'messages', label: 'Messages', icon: 'i-lucide-message-square', to: '/dashboard/account/messages' },
  ]
  if (!scopeOrganization.value) return []
  const organizationBase = `/dashboard/${encodeURIComponent(scopeOrganization.value.slug)}`
  return [
    { key: 'today', label: 'Today', icon: 'i-lucide-bookmark', to: organizationBase },
    { key: 'calendar', label: 'Calendar', icon: 'i-lucide-calendar-days', to: `${organizationBase}/calendar` },
    // Everything the organization offers, whatever its kind; Airbnb's Listings tab.
    { key: 'catalog', label: 'Catalog', icon: 'i-lucide-layout-grid', to: `${organizationBase}/products` },
    { key: 'messages', label: 'Messages', icon: 'i-lucide-message-square', to: `${organizationBase}/messages` },
  ]
})

// The top nav (tablet and desktop, md and up) and the bottom bar (mobile, below
// md) render this layout's navTargets — one nav source, two presentations.
// "Menu" opens the slideover at md and up and navigates to the menu page below
// it, because a slideover is the wrong control on a phone.
const menuOpen = ref(false)

const primaryNavItems = computed(() => navTargets.value.map(item => ({ ...item, active: item.key === activeTab.value })))
// A signed-in owner always gets the header: the wordmark and the account menu
// are user-scoped and need no organization. Only the nav links and the bottom
// bar wait for an organization, because Today, Calendar, Catalog and Messages do not
// exist until there is one. Gating both together is what left an owner who
// abandoned onboarding with no way to reach account settings or log out.
const showNavChrome = computed(() => primaryNavItems.value.length > 0)
// A leaf with Cancel/Save is a sheet on a phone: the tab bar is not there
// under it, the way Airbnb's editor leaves cover theirs.
const leafFooters = useDashboardLeafFooters()
const showBottomNav = computed(() => showNavChrome.value && leafFooters.value === 0)
const topNavHomeTo = computed(() => {
  if (personal.value) return '/dashboard/account'
  return scopeOrganization.value ? `/dashboard/${encodeURIComponent(scopeOrganization.value.slug)}` : '/dashboard'
})
const isMenuPageActive = computed(() => activeTab.value === 'menu')



onMounted(async () => {
  // Track dashboard visit
  const organizationId = organization.value?.id
  if (organizationId) {
    trackDashboardVisited(scope.value, organizationId)
  }
  // Which page and tab of an organization's dashboard was opened (Earnings, Transactions, a payout, the Payments tabs), on the same event.
  let lastSection = ''
  watch(() => [route.name, route.query.tab] as const, ([name, tab]) => {
    const id = organization.value?.id
    if (!id || typeof name !== 'string' || !name.startsWith('dashboard-orgSlug-')) return
    const section = `${name.slice('dashboard-orgSlug-'.length)}${typeof tab === 'string' && tab ? `:${tab}` : ''}`
    if (section === lastSection) return
    lastSection = section
    trackDashboardVisited(section, id)
  }, { immediate: true })
})

async function stopImpersonating() {
  impersonationError.value = null
  stoppingImpersonation.value = true
  try {
    const result = await authClient.admin.stopImpersonating()
    if (result.error) throw new Error(result.error.message)
    await refreshSession()
    await navigateTo('/dashboard')
  } catch (error) {
    console.error('Failed to stop impersonation:', error)
    impersonationError.value = 'Failed to stop impersonation'
  } finally {
    stoppingImpersonation.value = false
  }
}

</script>
