<template>
  <!--
    The location: one card per thing a guest sees on its page, in the order the
    page shows it, each stating what it holds now. Every card is a level below
    this one; the gear opens the settings that a guest never sees.
  -->
  <DashboardIndexPanel id="location-index" :title="location?.title || 'Location'" :auto-open="cards[0]?.to ?? null">
    <template #right>
      <UButton
        :to="`${level.path.value}/settings`"
        icon="i-lucide-settings"
        color="neutral"
        variant="ghost"
        square
        aria-label="Location settings"
      />
    </template>

    <UAlert
      v-if="overviewError"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      :description="getErrorMessage(overviewError, 'Failed to load location overview')"
    />

    <!-- The same rows every other index draws, so a location reads like the rest of the dashboard. -->
    <EditorNavigationList v-else-if="location" :groups="navigationGroups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { resolveCmsCapabilities, type ProductFeature } from '~/config/cms-registry'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { getTodayHoursLabel, type OpeningHours } from '~/shared/reservation-hours'
import { normalizeVertical, type OrganizationVertical } from '~/utils/vertical-copy'
import { catalogLabel, catalogSummary, type CatalogCounts } from '~/utils/product-presentation'
import { formatPostalAddress } from '~/utils/postal-address'
import type { LocationReservationConfig } from '~/server/utils/reservations'

// A location is a tile on Locations, a row on Menu; Locations is its pane and its Back.
definePageMeta({ layout: 'dashboard' })

interface LocationOverview {
  id: string
  title: string
  status: string
  short_description: string | null
  description: string | null
  phone: string | null
  email: string | null
  address: PostalAddress | null
  rating: number | null
  google_place_id: string | null
  timezone: string
  opening_hours?: OpeningHours
}

interface LocationContentCounts {
  photos: number
  posts: number
  qa: number
  reviews: number
  organizationQa: number
}
interface LocationOverviewResource {
  location: { success: boolean; location: LocationOverview }
  catalog: CatalogCounts
  reservationConfig: LocationReservationConfig | null
  counts: LocationContentCounts
}

const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const dashboardLocation = useDashboardLocation()
// The level runs while setup is still synchronous: it injects the record the
// `<RouterView>` above rendered, and an `await` before it would bind nothing.
const level = useRouteLevel()
const locationPath = level.path

const organizationId = await useDashboardOrganizationId()

const locationId = computed(() => dashboardLocation.currentLocationId.value)

const location = computed(() => overview.value?.location.location ?? null)

const dashboardLocationRow = computed(() => dashboard.locations.value.find(candidate => candidate.id === locationId.value) ?? null)
const locationImage = computed(() => dashboardLocationRow.value?.social_image?.url ?? '')
const addressSummary = computed(() => formatPostalAddress(location.value?.address ?? null) || 'Add the address')

const capabilities = computed(() => {
  const vertical = dashboard.organization.value?.vertical
  if (!vertical) throw createError({ statusCode: 500, statusMessage: 'Organization vertical is not configured' })
  // Deliberately unguarded: swallowing a capability error left the index with an
  // empty feature set, which removes every content and reservation row and
  // leaves a location that looks like it holds nothing.
  return resolveCmsCapabilities(normalizeVertical(vertical) as OrganizationVertical, resolvePublicTemplate({ themeId: dashboard.organization.value?.theme_id, vertical }).slug)
})
const featureSet = computed(() => new Set<ProductFeature>([
  ...(capabilities.value?.pages.map(page => page.feature) ?? []),
  ...(capabilities.value?.managers.map(manager => manager.id) ?? []),
]))
const hasFeature = (feature: ProductFeature) => featureSet.value.has(feature)
const includeProducts = computed(() => hasFeature('products'))

const currentOpeningState = computed(() => {
  const hours = location.value?.opening_hours
  if (!hours) return 'Set your hours'
  return getTodayHoursLabel(hours, 'Closed today', location.value?.timezone) || 'Set your hours'
})

// What this branch's catalogue is called: a studio's classes are experiences, a
// restaurant's dishes are its menu, and a restaurant that also takes bookings
// holds both — which is a catalog, not a menu with experiences filed inside it.
const catalogLabelText = (catalog: CatalogCounts) => catalogLabel(dashboard.organization.value?.vertical, catalog)
// One count per surface, each in its own words: "24 dishes · 3 experiences".
// Plurals are each presentation's own ("Dish" → "Dishes"); appending an "s" is
// how "dishs" reaches a merchant's screen.
const catalogSummaryText = (catalog: CatalogCounts) => catalogSummary(dashboard.organization.value?.vertical, catalog)

function countSummary(total: number, noun: string, empty: string): string {
  if (!total) return empty
  return `${total} ${total === 1 ? noun : `${noun}s`}`
}

/** "5 questions · 18 reviews · 110 site-wide", or what to do when there are none. */
function trustSummary(qa: number, reviews: number, organizationQa: number): string {
  const parts = [
    qa ? countSummary(qa, 'question', '') : '',
    reviews ? countSummary(reviews, 'review', '') : '',
    organizationQa ? `${organizationQa} organization-wide` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Answer your first question'
}

interface HubCard { id: string; title: string; description: string; to: string; image?: string }

const router = useRouter()
const organizationLinks = dashboard.organizationPaths
/** One of the organization's managers, scoped to this location by its id. */
function scopedToLocation(path: string | undefined): string {
  if (!path || !locationId.value) return locationPath.value
  return router.resolve({ path, query: { location_id: locationId.value } }).fullPath
}

const cards = computed<HubCard[]>(() => {
  const resource = overview.value
  if (!resource) return []
  const loc = resource.location.location
  const counts = resource.counts
  const contact = [loc.phone, loc.email].filter((value): value is string => Boolean(value?.trim())).join(' · ')
  const policy = resource.reservationConfig
  return [
    { id: 'photos', title: 'Photos', description: countSummary(counts.photos, 'photo', 'Add photos'), to: `${locationPath.value}/photos`, image: locationImage.value || undefined, visible: hasFeature('photos') },
    { id: 'name', title: 'Name', description: loc.title, to: `${locationPath.value}/name`, visible: true },
    { id: 'description', title: 'Description', description: loc.short_description?.trim() || loc.description?.trim() || 'Describe this location', to: `${locationPath.value}/description`, visible: true },
    { id: 'hours', title: 'Hours', description: currentOpeningState.value, to: `${locationPath.value}/hours`, visible: true },
    { id: 'address', title: 'Address', description: addressSummary.value, to: `${locationPath.value}/address`, visible: true },
    { id: 'contact', title: 'Contact', description: contact || 'Add a phone or email', to: `${locationPath.value}/contact`, visible: true },
    // What this location offers, its posts and its Q&A each have one manager,
    // shared with the whole organization; these rows open it scoped to here.
    // Built only when this site carries a catalogue at all: a vertical with no
    // product presentation has no word for one, and asking for it throws.
    ...(hasFeature('products')
      ? [{ id: 'products', title: catalogLabelText(resource.catalog), description: catalogSummaryText(resource.catalog), to: scopedToLocation(organizationLinks.value?.catalog), visible: true }]
      : []),
    { id: 'posts', title: 'Posts', description: countSummary(counts.posts, 'published post', 'Write your first post'), to: scopedToLocation(organizationLinks.value?.posts), visible: hasFeature('posts') },
    { id: 'qa', title: 'Reviews and Q&A', description: trustSummary(counts.qa, counts.reviews, counts.organizationQa), to: scopedToLocation(organizationLinks.value?.qa), visible: hasFeature('qa') },
    {
      id: 'reservations',
      title: 'Reservations',
      description: !policy ? 'Not taking reservations' : policy.slot_capacity === null ? 'Open, no seat limit' : `Open, ${policy.slot_capacity} guests per slot`,
      to: `${locationPath.value}/reservations`,
      visible: hasFeature('reservations'),
    },
  ].filter(card => card.visible).map(({ visible: _visible, ...card }) => card)
})

/** One group, because a location's things are one list in the order its page shows them. */
const navigationGroups = computed<EditorNavigationGroup[]>(() => [{
  id: 'location',
  items: cards.value.map(card => ({
    id: card.id,
    label: card.title,
    summary: card.description,
    to: card.to,
    image: card.image ?? null,
  })),
}])

const isOverviewResponse = (value: unknown): value is LocationOverviewResource =>
  isRecord(value)
  && isRecord(value.location) && isRecord(value.location.location)
  && isRecord(value.catalog) && typeof value.catalog.total === 'number' && typeof value.catalog.experiences === 'number' && typeof value.catalog.dishes === 'number'
  && (value.reservationConfig === null || isRecord(value.reservationConfig))
  && isRecord(value.counts) && typeof value.counts.photos === 'number'

const overviewKey = computed(() => `dashboard-location-overview:${organizationId}:${locationId.value}`)
const { data: overview, error: overviewError } = await useAsyncData<LocationOverviewResource>(overviewKey, async () => {
  const requestedLocationId = locationId.value
  if (!requestedLocationId) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
  const shouldIncludeProducts = includeProducts.value
  return await dashboardApi<LocationOverviewResource>(
    `/api/dashboard/organizations/${organizationId}/locations/${requestedLocationId}/overview`,
    { query: { includeProducts: String(shouldIncludeProducts) }, validate: isOverviewResponse },
  )
})

useSeoMeta({ title: () => `${location.value?.title || 'Location'} | Krabiclaw`, robots: 'noindex, nofollow' })
</script>
