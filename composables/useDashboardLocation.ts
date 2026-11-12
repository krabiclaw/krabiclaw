// Which location the current route addresses.
//
// This used to also export `routeLocationSlug`, `inLocationWorkspace`,
// `routeLocation` (a pure alias of `currentLocation`), `buildLocationWorkspacePath`
// and `selectLocation`. Nothing consumed any of them — every caller takes the
// composable whole and reads only the three below. The path builder among them
// fell back to `?? locationIdOrSlug` when a lookup missed, so an unknown id
// produced a real-looking URL to a location that does not exist, while
// `selectLocation` right beside it fast-failed on the same lookup. Two answers to
// one question, neither reachable.
export function useDashboardLocation() {
  const dashboard = useDashboardOrganization()
  const route = useRoute()

  const routeLocationSlug = computed(() => {
    const slug = route.params.location_slug
    return typeof slug === 'string' ? slug : null
  })

  const currentLocation = computed(() => {
    if (!routeLocationSlug.value) return null
    return dashboard.locations.value.find(location => location.slug === routeLocationSlug.value) ?? null
  })

  const currentLocationId = computed(() => currentLocation.value?.id ?? null)

  // Falls back to the route's own slug because the URL is what names the
  // location, whether or not the site's locations have loaded yet. This is not
  // standing in for a missing record: an unknown slug yields no `currentLocation`
  // and no `currentLocationId`, which is what callers check before acting.
  const currentLocationSlug = computed(() => currentLocation.value?.slug ?? routeLocationSlug.value ?? null)

  return {
    currentLocation,
    currentLocationId,
    currentLocationSlug,
  }
}
