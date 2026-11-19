import type { DashboardLocation } from '~/composables/useDashboardOrganization'
import { dashboardFetch } from '~/composables/dashboardFetch'

/** The shared location resource also consumes the product editor's authorized batch. */
export async function useOrganizationLocations(options: { includeInactive?: boolean; initial?: DashboardLocation[]; enabled?: MaybeRefOrGetter<boolean> } = {}) {
  const route = useRoute()
  const orgSlug = computed(() => String(route.params.org_slug || ''))
  const load = useAsyncData(
    () => `dashboard-org-locations:${orgSlug.value}${options.includeInactive ? ':all' : ''}`,
    () => dashboardFetch<{ success: true; locations: DashboardLocation[] }>('/api/dashboard/locations', { orgSlug: orgSlug.value }, {
      query: { organization: 'true', status: options.includeInactive ? 'all' : undefined },
      validate: (value): value is { success: true; locations: DashboardLocation[] } =>
        isRecord(value) && value.success === true && Array.isArray(value.locations),
    }),
    {
      immediate: options.initial === undefined,
      enabled: options.enabled,
      watch: [orgSlug],
      getCachedData(cacheKey, nuxtApp) {
        const hydrated = nuxtApp.payload.data[cacheKey] as { success: true; locations: DashboardLocation[] } | undefined
        if (nuxtApp.isHydrating && hydrated !== undefined) return hydrated
      },
    },
  )
  if (options.initial !== undefined) {
    load.clear()
    load.data.value = { success: true, locations: options.includeInactive ? options.initial : options.initial.filter(location => location.status === 'active') }
    load.status.value = 'success'
  }
  const { data, error, pending } = await load
  const locations = computed(() => data.value?.locations ?? [])
  return { locations, error, pending }
}
