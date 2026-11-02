import { useLocationEditor, type LocationEditorKey } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

/** The calendar's settings leaves edit the location the calendar is showing, named by `locationId` in the query. */
export async function useCalendarLocationEditor(key: LocationEditorKey | null) {
  const route = useRoute()
  const organizationId = useDashboardOrganizationId()
  const locationId = computed(() => typeof route.query.locationId === 'string' ? route.query.locationId : null)
  return useLocationEditor(organizationId, locationId, key)
}
