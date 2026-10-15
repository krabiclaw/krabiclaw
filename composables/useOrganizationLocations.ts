import type { DashboardLocation } from '~/composables/useDashboardOrganization'
import { dashboardFetch } from '~/composables/dashboardFetch'

/**
 * Every location the organization has, read once and shared by key: Locations
 * lists them, Catalog scopes by them, and a product names where it is offered.
 * The dashboard context carries no locations outside a location's own route,
 * so they are read for the whole organization here.
 */
export async function useOrganizationLocations(options: { includeInactive?: boolean } = {}) {
  const route = useRoute()
  const orgSlug = computed(() => String(route.params.orgSlug || ''))
  const { data, error, pending } = await useAsyncData(() => `dashboard-org-locations:${orgSlug.value}${options.includeInactive ? ':all' : ''}`, () =>
    dashboardFetch<{ success: true; locations: DashboardLocation[] }>('/api/dashboard/locations', { orgSlug: orgSlug.value }, {
      query: { organization: 'true', status: options.includeInactive ? 'all' : undefined },
      validate: (value): value is { success: true; locations: DashboardLocation[] } =>
        isRecord(value) && value.success === true && Array.isArray(value.locations),
    }), { watch: [orgSlug] })
  const locations = computed(() => data.value?.locations ?? [])
  return { locations, error, pending }
}
