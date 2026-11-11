import { useLocationEditor, type LocationEditorKey } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

/** The calendar's settings leaves edit the location the calendar is showing, named by `location_id` in the query. */
export async function useCalendarLocationEditor(key: LocationEditorKey | null) {
  const route = useRoute()
  const organizationId = useDashboardOrganizationId()
  const locationId = computed(() => typeof route.query.location_id === 'string' ? route.query.location_id : null)
  return useLocationEditor(organizationId, locationId, key)
}
