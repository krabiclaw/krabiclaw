import { dashboardFetch, type DashboardRequestScope } from '~/composables/dashboardFetch'
import { ALL_VERTICALS, type OrganizationVertical } from '~/utils/vertical-copy'
import { organizationRoles } from '~/utils/organization-access'
import { STAY_MAP_SHARING_MODES, type StayMapSharing } from '~/shared/stay-listing'

/**
 * The tenant, as the dashboard reads it.
 *
 * Identity, role and configuration arrive on one object because they are one
 * row. There used to be a `site` beside this carrying the configuration, and a
 * `sites` list to switch between: a business is its organization, so the
 * switcher and the second scope are gone.
 */
export interface DashboardOrganization {
  id: string
  name: string
  slug: string
  role: string
  theme_id: string
  vertical: OrganizationVertical | null
  subdomain: string | null
  custom_domain: string | null
  public_url: string | null
  status: string
  onboarding_status: string
  effective_plan: string
  default_currency: string
  media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string | null }>
}

export interface DashboardLocation {
  id: string
  slug: string
  title: string
  stay_map_sharing: StayMapSharing
  status: string
  timezone: string
  city: string | null
  address: PostalAddress | null
  media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string | null }>
  picture_url: string | null
  social_image: { url: string; width?: number; height?: number; type?: string } | null
}


interface DashboardContextResponse {
  success: boolean
  organization: DashboardOrganization
  locations: DashboardLocation[]
}

const isSocialImage = (value: unknown): value is { url: string } | null =>
  value === null || (isRecord(value) && typeof value.url === 'string')

const isMediaList = (value: unknown): boolean =>
  Array.isArray(value)
  && value.every(item =>
    isRecord(item)
    && typeof item.asset_id === 'string'
    && typeof item.slot === 'string'
    && (item.public_url === null || typeof item.public_url === 'string')
    && (item.thumbnail_url === null || typeof item.thumbnail_url === 'string')
    && (item.kind === null || typeof item.kind === 'string')
  )

const isDashboardOrganization = (value: unknown): value is DashboardOrganization =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.name === 'string'
  && typeof value.slug === 'string'
  && typeof value.role === 'string'
  && typeof value.theme_id === 'string'
  && (value.vertical === null || ALL_VERTICALS.some(vertical => vertical === value.vertical))
  && (value.subdomain === null || typeof value.subdomain === 'string')
  && (value.public_url === null || typeof value.public_url === 'string')
  && typeof value.status === 'string'
  && typeof value.onboarding_status === 'string'
  && typeof value.default_currency === 'string'
  && isMediaList(value.media)

const isDashboardLocation = (value: unknown): value is DashboardLocation =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.slug === 'string'
  && typeof value.title === 'string'
  && STAY_MAP_SHARING_MODES.includes(value.stay_map_sharing as StayMapSharing)
  && typeof value.status === 'string'
  && typeof value.timezone === 'string'
  && isSocialImage(value.social_image)
  && (value.picture_url === null || typeof value.picture_url === 'string')
  && isMediaList(value.media)

const isDashboardContextResponse = (value: unknown): value is DashboardContextResponse =>
  isRecord(value)
  && value.success === true
  && isDashboardOrganization(value.organization)
  && Array.isArray(value.locations)
  && value.locations.every(isDashboardLocation)

// The dashboard org scope is sent as an explicit `org` query param (see
// dashboardFetch in composables/dashboardFetch.ts) rather than a header —
// callers must go through dashboardFetch rather than spreading a bespoke
// transport into individual pages or composables.
// `overrides` lets a caller set additional headers (e.g. a cache-control hint)
// without losing whatever cookie forwarding is already on the returned Headers
// instance (spreading a Headers object with `{ ...headers }` silently drops
// its entries).
export function buildDashboardRequestHeaders(
  overrides?: Record<string, string>,
): Headers {
  const headers = new Headers(import.meta.server ? useRequestHeaders(['cookie']) : undefined)
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) headers.set(key, value)
  }
  return headers
}

export function buildDashboardRequestQuery(scope: DashboardRequestScope): Record<string, string> {
  return { org: scope.orgSlug }
}

/** The key a scope's context is stored under. Empty on an unscoped route. */
function dashboardContextKey(scope: DashboardRequestScope | null) {
  return scope ? `dashboard:context:${scope.orgSlug}` : 'dashboard:context:unscoped'
}

/**
 * The context request for one organization, keyed by it. The dashboard-context
 * route middleware is the only caller: it awaits this before a navigation into
 * an organization's dashboard completes, so the screen being left stays up
 * until the new organization's context has answered, and nothing in the new
 * scope ever renders with the previous organization's context or none.
 */
export function useDashboardContext(scope: DashboardRequestScope) {
  return useAsyncData<DashboardContextResponse>(
    dashboardContextKey(scope),
    async (_nuxtApp, { signal }) => dashboardFetch('/api/dashboard/context', scope, { signal, validate: isDashboardContextResponse }),
    { dedupe: 'defer' },
  )
}

/**
 * Reads the context the middleware already fetched for the route's
 * organization. Starts no request, registers no async data and holds no state
 * of its own, so mounting a hundred consumers costs nothing.
 */
export function useDashboardOrganization() {
  const nuxtApp = useNuxtApp()
  const scope = useDashboardRouteScope()
  const contextKey = computed(() => dashboardContextKey(scope.value))

  const state = computed<DashboardContextResponse | null>(() =>
    scope.value ? (nuxtApp.payload.data[contextKey.value] as DashboardContextResponse | undefined) ?? null : null)
  /** Why the route's context could not be loaded, as Nuxt recorded it. */
  const error = computed(() => scope.value ? nuxtApp.payload._errors[contextKey.value] ?? null : null)

  const organization = computed(() => state.value?.organization ?? null)
  const organizationId = computed(() => organization.value?.id ?? null)
  const locations = computed(() => state.value?.locations ?? [])
  /** Whether the signed-in member's role may change the plan, by the same rule the billing endpoints enforce. */
  const canUpdateBilling = computed(() => {
    const role = organization.value?.role
    return !!role && role in organizationRoles && organizationRoles[role as keyof typeof organizationRoles].authorize({ billing: ['update'] }).success
  })

  const organizationPaths = computed(() => {
    const organizationSlug = scope.value?.orgSlug
    if (!organizationSlug) return null
    const base = `/dashboard/${encodeURIComponent(organizationSlug)}`
    return {
      catalog: `${base}/products`,
      newLocation: `${base}/locations/new`,
      posts: `${base}/website/posts`,
      pages: `${base}/website/pages`,
      blog: `${base}/website/blog`,
      qa: `${base}/website/qa`,
    }
  })

  return {
    state,
    error,
    scope,
    contextKey,
    organization,
    organizationId,
    locations,
    canUpdateBilling,
    organizationPaths,
    /** Re-runs the context request. For an explicit reload after a mutation. */
    refresh: () => refreshNuxtData(contextKey.value),
  }
}

/** The tenant id, or a thrown error when the context has not loaded. */
export async function useDashboardOrganizationId() {
  const dashboard = useDashboardOrganization()
  if (!dashboard.state.value) throw createError({ statusCode: 503, message: 'Dashboard context not loaded' })
  const organizationId = dashboard.organizationId.value
  if (!organizationId) throw createError({ statusCode: 404, message: 'Organization not found' })
  return organizationId
}
