<template>
  <header
    class="fixed inset-x-0 top-(--kc-dashboard-banner) z-30 h-(--kc-dashboard-top-nav) items-center gap-4 border-b border-default bg-default px-4 sm:px-6"
    :class="items.length
      ? 'hidden md:grid md:grid-cols-[1fr_auto_1fr]'
      : 'grid grid-cols-[1fr_auto]'"
    data-testid="dashboard-top-nav"
  >
    <NuxtLink :to="homeTo" class="group flex w-fit shrink-0 items-center gap-2.5 no-underline">
      <img
        src="/platform/krabiclaw-symbol.svg"
        alt="KrabiClaw"
        width="36"
        height="36"
        class="size-8 rounded-[9px] transition-transform duration-200 group-hover:rotate-12"
      >
      <span class="kc-wordmark hidden text-xl lg:inline">
        <span class="kc-wordmark__krabi">krabi</span><span class="kc-wordmark__claw">claw</span>
      </span>
    </NuxtLink>

    <nav v-if="items.length" class="flex items-center justify-center gap-6" aria-label="Dashboard">
      <NuxtLink
        v-for="item in items"
        :key="item.key"
        :to="item.to"
        class="px-4 py-2 text-sm font-medium no-underline transition-colors"
        :class="item.active
          ? 'text-highlighted underline decoration-2 underline-offset-8'
          : 'text-muted hover:text-highlighted'"
        :aria-current="item.active ? 'page' : undefined"
      >
        {{ item.label }}
      </NuxtLink>
    </nav>

    <div class="flex items-center justify-end gap-3">
      <!-- Page-level controls sit to the left of the account menu. A page
           registers one with useDashboardTopNavAction(); see that composable
           for why a slot cannot reach here. -->
      <ClientOnly>
        <UButton
          v-for="action in topNavActions"
          :key="action.key"
          :icon="action.icon"
          :aria-label="action.ariaLabel"
          :class="[action.class, 'rounded-full']"
          color="neutral"
          variant="soft"
          square
          @click="action.onSelect()"
        />
      </ClientOnly>
      <!--
        Where there is a bottom nav to carry Menu — and Menu carries the account
        row — this is `md` and up only: Airbnb's `/hosting` draws no header and
        no avatar at all on a phone (measured at 390, 2026-09-22), and an avatar
        beside the Menu route linked to the page the reader was already on.

        On an unscoped route there are no nav items, no bottom nav, and this
        header is the only chrome there is, so the avatar stays at every width.
      -->
      <DashboardAccountMenu :class="items.length ? 'hidden md:inline-flex' : undefined" />
      <!-- Lit like a tab when the screen's tab is Menu, the same declaration the bottom bar reads. -->
      <UButton
        v-if="items.length"
        :color="menuActive ? 'primary' : 'neutral'"
        variant="soft"
        square
        class="rounded-full"
        icon="i-lucide-menu"
        aria-label="Open menu"
        :aria-current="menuActive ? 'page' : undefined"
        data-testid="dashboard-top-nav-menu-button"
        @click="$emit('menu')"
      />
    </div>
  </header>
</template>

<script setup lang="ts">
// Below md the bar is normally hidden, because navigation lives in the bottom
// bar on a phone. With no navigation items there is no bottom bar either, so
// the bar shows at every width as identity only — wordmark and account. That is
// the sole way out of onboarding on a phone.
import DashboardAccountMenu from './DashboardAccountMenu.vue'
import { useDashboardTopNavActions } from '~/composables/useDashboardTopNavActions'

const topNavActions = useDashboardTopNavActions()

export interface DashboardTopNavItem {
  key: string
  label: string
  to?: string
  active?: boolean
}

defineProps<{
  items: readonly DashboardTopNavItem[]
  homeTo: string
  /** The screen's declared tab is Menu. */
  menuActive?: boolean
}>()

defineEmits<{ menu: [] }>()
</script>
