<template>
  <div class="space-y-6">

    <!--
      Airbnb's hosting Menu leads with two square cards — Earnings and Insights,
      each a title, a subline and one figure. The account's Menu carries Past
      activity the same way, as its profile carries Past trips.
    -->
    <UAlert v-if="cardsError" color="error" variant="soft" :title="cardsError" data-testid="dashboard-menu-error" />

    <div v-if="cards.length" class="grid grid-cols-2 gap-4">
      <UCard
        v-for="card in cards"
        :key="card.testId"
        :as="NuxtLink"
        :to="card.to"
        variant="subtle"
        class="flex aspect-square flex-col transition-colors hover:bg-elevated"
        :ui="{ body: 'flex flex-1 flex-col' }"
        :data-testid="card.testId"
      >
        <p class="text-base font-semibold text-highlighted">{{ card.label }}</p>
        <p class="mt-1 text-sm text-muted">{{ card.subline }}</p>
        <p v-if="card.figure" class="mt-auto text-4xl font-semibold tracking-tight text-highlighted">{{ card.figure }}</p>
        <!-- Airbnb stacks the listings' photos in the card's corner; the organization's places, or the account's past visits. -->
        <span v-else-if="card.photos.length" class="mt-auto flex items-center">
          <img v-for="(photo, index) in card.photos.slice(0, 3)" :key="photo" :src="photo" alt="" class="size-12 rounded-xl border-2 border-elevated object-cover" :class="index ? '-ml-3' : ''">
          <span v-if="card.photos.length > 3" class="-ml-3 flex size-12 items-center justify-center rounded-xl border-2 border-elevated bg-default text-sm font-semibold text-highlighted">+{{ card.photos.length - 3 }}</span>
        </span>
        <UIcon v-else :name="card.icon" class="mt-auto size-7 text-muted" />
      </UCard>
    </div>

    <!-- Airbnb's "Create a new listing": the first thing the plan lacks, offered once, to someone who can take it. -->
    <OfferCard v-if="offer" :offer="offer" />

    <EditorNavigationList :groups="groups" :active-item="activeItem" @act="onAct" />
  </div>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { planOffers } from '~/shared/offers'
import { dashboardFetch } from '~/composables/dashboardFetch'
import type { DashboardLocation } from '~/composables/useDashboardOrganization'
import { earningsFigure, isEarningsSummary, type EarningsSummary } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'
import { isAccountActivityResponse, type AccountActivityResponse } from '~/shared/account-activity'

// Rendered by both the desktop slideover and the mobile menu page, off one
// model, so the two surfaces cannot show different menus.
const { scopeModel, logOut, personal, organization } = useDashboardMenu()
const dashboard = useDashboardOrganization()
// Only the routed organization's plan is loaded here; the active one reached from Account settings is not offered anything.
const offer = computed(() => dashboard.organization.value && dashboard.canUpdateBilling.value ? planOffers(dashboard.entitlements.value)[0] ?? null : null)
// The shell's organization, whichever route it is drawn on — Account settings included.
const orgBase = computed(() => organization.value ? `/dashboard/${encodeURIComponent(organization.value.slug)}` : null)
const inOrganization = computed(() => Boolean(orgBase.value))
const monthLabel = formatCalendarDate(new Date().toISOString().slice(0, 10), 'en', { month: 'long', year: 'numeric' })
const organizationSettings = useOrganizationSettingsNavigation(organization, scopeModel)
const { groups, activeItem } = organizationSettings
await organizationSettings.ready
// Only the actual Menu loads Earnings. Search reuses its navigation and
// permission checks without reading the payments summary.
const { data: earnings, error: earningsError } = await useAsyncData(
  () => `menu-earnings:${organizationSettings.permissions.value?.userId ?? ''}:${organization.value?.id ?? ''}`,
  async (_app, { signal }) => {
    const target = organization.value
    const permissions = organizationSettings.permissions.value
    if (!target || !permissions?.payments) return null
    const now = new Date()
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
    return {
      ...await dashboardFetch<EarningsSummary>('/api/dashboard/payments', { orgSlug: target.slug }, { query: { from, to }, signal, validate: isEarningsSummary }),
      organizationId: target.id,
      userId: permissions.userId,
    }
  },
  { watch: [organizationSettings.permissions] },
)
const currentEarnings = computed(() => {
  const loaded = earnings.value
  const permissions = organizationSettings.permissions.value
  return permissions?.payments && loaded?.organizationId === permissions.organizationId && loaded?.userId === permissions.userId ? loaded : null
})
// The pictures in the cards' corners: the organization's places, or the visits the account has made.
type LocationPhotos = { success: true; locations: DashboardLocation[] }
const isLocationPhotos = (value: unknown): value is LocationPhotos => isRecord(value) && value.success === true && Array.isArray(value.locations) && value.locations.every(row => isRecord(row) && typeof row.id === 'string' && (row.picture_url === null || typeof row.picture_url === 'string'))
const { data: places, error: placesError } = await useAsyncData(
  () => `menu-places:${orgBase.value}`,
  async (_app, { signal }) => {
    const target = organization.value
    if (!target) return null
    const response = await dashboardFetch<LocationPhotos>('/api/dashboard/locations', { orgSlug: target.slug }, { query: { organization: 'true' }, signal, validate: isLocationPhotos })
    return { ...response, organizationId: target.id }
  },
)
const { data: activity, error: activityError } = await useAsyncData(
  () => `menu-activity:${personal.value}`,
  async () => personal.value ? await applicationFetch<AccountActivityResponse>('/api/account', { validate: isAccountActivityResponse }) : null,
)
// A card whose figure or photos could not be read says so, never an empty card standing in for one.
const cardsError = computed(() => {
  const error = organizationSettings.error.value ?? earningsError.value ?? placesError.value ?? activityError.value
  return error ? getErrorMessage(error, 'The Menu could not be loaded.') : null
})
const placePhotos = computed(() => places.value?.organizationId === organization.value?.id ? places.value?.locations.map(row => row.picture_url).filter((url): url is string => !!url) ?? [] : [])
const visitPhotos = computed(() => (activity.value?.activities ?? []).filter(item => item.imageUrl && (item.status === 'cancelled' || (item.endsAt && Date.parse(item.endsAt) < Date.now()) || item.kind === 'order' || item.kind === 'payment')).map(item => item.imageUrl as string))
const cards = computed(() => personal.value
  ? [
      { to: '/dashboard/account/activity', label: 'Past activity', subline: 'Visits and purchases', icon: 'i-lucide-history', figure: '', photos: visitPhotos.value, testId: 'dashboard-menu-past-activity' },
      { to: '/dashboard/account/profile/payments', label: 'Payments', subline: 'Payments and refunds', icon: 'i-lucide-credit-card', figure: '', photos: [] as string[], testId: 'dashboard-menu-payments' },
    ]
  : inOrganization.value
    ? [
        ...(currentEarnings.value ? [{ to: `${orgBase.value}/earnings`, label: 'Earnings', subline: monthLabel, icon: 'i-lucide-banknote', figure: earningsFigure(currentEarnings.value), photos: [] as string[], testId: 'dashboard-menu-earnings' }] : []),
        { to: `${orgBase.value}/insights`, label: 'Insights', subline: 'Views and reviews', icon: 'i-lucide-chart-no-axes-column', figure: '', photos: placePhotos.value, testId: 'dashboard-menu-insights' },
      ]
    : [])

// Airbnb's "Switch to hosting" / "Switch to travelling" is a row above Log out, not a picker.
function onAct(id: string) {
  if (id === 'log-out') void logOut()
  // Personal is the one peer without an organization id.
  if (id === 'switch-personal') scopeModel.value?.peers.find(peer => !peer.id)?.onSelect?.()
  if (id === 'switch-organization') scopeModel.value?.peers.find(peer => peer.id)?.onSelect?.()
}


</script>
