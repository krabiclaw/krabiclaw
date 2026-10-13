<template>
  <!--
    Menu: the business's own page, a tab root. Its rows are the site's lists
    and settings, each a level below.

    Search and the bell hang off it: the dashboard has one search and this is
    where it lives.

    The account is a row in the list below, not a control up here. Measured on
    Airbnb at 390 (2026-09-22): their `/hosting` draws no header and no avatar
    at all on a phone, and the account is reached as "Account settings" in the
    Menu tab's own list. The header carries the avatar from `md` up, where
    Airbnb's does too.
  -->
  <!-- A menu is a column, not the page: alone on a wide screen it keeps a phone's measure. -->
  <DashboardIndexPanel id="organization-settings" title="Menu" column="leaf">
    <template #right>
      <UButton
        icon="i-lucide-search"
        aria-label="Search"
        color="neutral"
        variant="ghost"
        square
        data-testid="dashboard-search"
        @click="openSearch"
      />
      <DashboardNotificationBell :to="notificationsTo" />
    </template>
    <DashboardMenuContent />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardMenuContent from '~/lib/components/workspace/dashboard/DashboardMenuContent.vue'
import DashboardNotificationBell from '~/lib/components/workspace/dashboard/DashboardNotificationBell.vue'

definePageMeta({ layout: 'dashboard', tab: 'menu' })
useSeoMeta({ title: 'Menu | Krabiclaw Dashboard', robots: 'noindex, nofollow' })

const nuxtApp = useNuxtApp()
const { notificationsTo } = useDashboardMenu()

function openSearch() {
  nuxtApp.hooks.callHook('dashboard:search:toggle')
}
</script>
