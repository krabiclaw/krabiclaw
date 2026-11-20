import type { CatalogRow } from '~/shared/catalog-screen'
import type { CatalogCounts } from '~/utils/product-presentation'
import type { LocationContentCounts } from '~/server/utils/dashboard-editor-resources'
import type { OpeningHours, SpecialHours } from '~/shared/reservation-hours'
import type { PostalAddress } from '~/utils/postal-address'
import { coordinatesFailure } from '~/utils/location-map'
import { STAY_MAP_SHARING_MODES, type StayMapSharing } from '~/shared/stay-listing'

export interface BusinessLocation {
  id: string
  slug: string
  updated_at: string
  title: string
  address: PostalAddress | null
  stay_map_sharing: StayMapSharing
  latitude: number | null
  longitude: number | null
  phone: string | null
  email: string | null
  maps_url: string | null
  google_review_url: string | null
  description: string | null
  short_description: string | null
  price_level: string | null
  google_place_id: string | null
  opening_hours: OpeningHours
  special_hours: SpecialHours
  rating: number | null
  review_count: number | null
  status: string
  last_synced_at: string | null
  timezone: string
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
export const isBusinessLocation = (value: unknown): value is BusinessLocation => {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.slug === 'string'
    && typeof value.updated_at === 'string'
    && typeof value.title === 'string'
    && typeof value.status === 'string'
    && STAY_MAP_SHARING_MODES.includes(value.stay_map_sharing as StayMapSharing)
    && (value.latitude === null || typeof value.latitude === 'number')
    && (value.longitude === null || typeof value.longitude === 'number')
    && !coordinatesFailure({ latitude: value.latitude, longitude: value.longitude })
    && (value.address === null || isRecord(value.address))
    && isNullableString(value.phone)
    && isNullableString(value.google_place_id)
  }

export interface DashboardLocationEditorResource {
  location: { success: true; location: BusinessLocation }
  rows: CatalogRow[]
  settings: CatalogRow
  catalog: CatalogCounts
  counts: LocationContentCounts
}

export function isDashboardLocationEditorResource(value: unknown): value is DashboardLocationEditorResource {
  return isRecord(value) && isRecord(value.location) && value.location.success === true && isBusinessLocation(value.location.location)
    && Array.isArray(value.rows) && isRecord(value.settings) && isRecord(value.catalog) && isRecord(value.counts)
}

/** One route resource owns the location, its index and all of its editable concerns. */
export function useDashboardLocation() {
  const route = useRoute()
  const organizationId = useDashboardOrganizationId()
  const api = useDashboardApi()
  const slug = computed(() => typeof route.params.location_slug === 'string' ? route.params.location_slug : null)
  const key = computed(() => `dashboard-location:${organizationId}:${slug.value ?? ''}`)
  const read = useWebsiteIndexData<DashboardLocationEditorResource | null>(key, signal => {
    if (!slug.value || slug.value === 'new') return Promise.resolve(null)
    return api('/api/dashboard/locations', { query: { view: 'editor', location_slug: slug.value }, signal, validate: isDashboardLocationEditorResource })
  })
  const currentLocation = computed(() => read.data.value?.location.location ?? null)
  return { ready: read, key, resource: read.data, error: read.error, refresh: read.refresh,
    currentLocation, currentLocationId: computed(() => currentLocation.value?.id ?? null),
    currentLocationSlug: computed(() => currentLocation.value?.slug ?? slug.value) }
}
