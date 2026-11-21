import type { DashboardLocation } from '~/composables/useDashboardOrganization'
import { businessChanged } from '~/composables/useDashboardInvalidations'
import { dashboardFetch } from '~/composables/dashboardFetch'

/** The shared location resource also consumes the product editor's authorized batch. */
export async function useOrganizationLocations(options: { includeInactive?: boolean; initial?: DashboardLocation[]; organization_id?: string; enabled?: MaybeRefOrGetter<boolean> } = {}) {
  const route = useRoute()
  const orgSlug = computed(() => String(route.params.org_slug || ''))
  const dashboard = useDashboardOrganization()
  const realtime = useDashboardInvalidations()
  const enabled = computed(() => options.enabled === undefined || toValue(options.enabled))
  const baseKey = computed(() => `dashboard-org-locations:${orgSlug.value}${options.includeInactive ? ':all' : ''}`)
  const key = computed(() => `${baseKey.value}${enabled.value ? '' : ':closed'}`)
  const load = useWebsiteIndexData(key, signal => dashboardFetch<{ success: true; locations: DashboardLocation[] }>('/api/dashboard/locations', { orgSlug: orgSlug.value }, {
    query: { organization: 'true', status: options.includeInactive ? 'all' : undefined }, signal,
    validate: (value): value is { success: true; locations: DashboardLocation[] } =>
      isRecord(value) && value.success === true && Array.isArray(value.locations),
  }), { immediate: options.initial === undefined, enabled })
  if (options.initial !== undefined) {
    if (options.organization_id !== dashboard.organizationId.value) throw createError({ statusCode: 409, statusMessage: 'The workspace changed while its locations were loading' })
    load.clear()
    load.data.value = { success: true, locations: options.includeInactive ? options.initial : options.initial.filter(location => location.status === 'active') }
    load.status.value = 'success'
    const held = realtime.held.begin(`website:${baseKey.value}`, businessChanged)
    realtime.held.hold(held, load.data.value, Date.now() + 30_000, 16)
  }
  const { data, error, pending } = await load
  const locations = computed(() => data.value?.locations ?? [])
  return { locations, error, pending }
}
