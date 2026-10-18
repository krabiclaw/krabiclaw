<template>
  <!--
    The gear's list: what a guest never sees about this location, one row per
    setting, each a leaf below. Languages is a row that opens the sheet.
  -->
  <DashboardIndexPanel id="location-settings" title="Settings" :auto-open="editor.navigationGroups.value[0]?.items.find(item => item.to)?.to ?? null">
    <UAlert v-if="editor.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editor.error.value" />
    <EditorNavigationList v-else-if="editor.location.value" :groups="editor.navigationGroups.value" :active-item="level.child.value" />
  </DashboardIndexPanel>

  <DashboardResourceLocalization
    v-if="editor.location.value"
    row-trigger
    :organization-id="organizationId"
    resource-type="business_location"
    :resource-id="editor.location.value.id"
    resource-label="location"
    :fields="editor.locationLocalizationFields.value"
    :route-path="editor.localizedLocationPath"
    :language-settings-path="editor.organizationLocalizationSettingsPath.value"
  />
</template>

<script lang="ts">
import type { LocationHoursForm } from '~/lib/components/workspace/location/hours'
import { parseOpeningHours, parseSpecialHours, type OpeningHours, type SpecialHours } from '~/shared/reservation-hours'

import type { Ref } from 'vue'
import type { LocationReservationConfig, LocationReservationConfigPatch } from '~/server/utils/reservations'
import { getErrorMessage } from '~/utils/errors'
import { postalAddressFromAnswers, type PostalAddress } from '~/utils/postal-address'


export interface BusinessLocation {
  id: string
  slug: string
  title: string
  address: PostalAddress | null
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
  assigned_member_id: string | null
  assigned_team_id: string | null
}

/**
 * The editors a guest sees the result of — name, description, hours, address,
 * contact, the reservation policy — open from the location index's cards. The
 * rest are the gear's.
 */
export const HUB_KEYS = ['name', 'description', 'hours', 'address', 'contact', 'reservations'] as const
export const SETTINGS_KEYS = ['assignment', 'status'] as const
export type LocationEditorKey = typeof HUB_KEYS[number] | typeof SETTINGS_KEYS[number]

/** `/locations/new`: the location record before it exists. */
export const NEW_LOCATION_SLUG = 'new'
/** What creating a location will not go without: what names it, and the clock its sessions run on. */
export const NEW_LOCATION_SECTIONS = ['name', 'hours'] as const
export type NewLocationSection = typeof NEW_LOCATION_SECTIONS[number]

function blankLocationDraft() {
  return { title: '', hours: { timezone: '', hours: null, specialHours: null } as LocationHoursForm }
}

/**
 * The new location's draft and its create walk (DESIGN.md, Creating). The draft
 * outlives the walk between its sections, which remount the level, so it is
 * `useState` keyed to the record. The commit creates the location and opens it.
 */
export function useNewLocation(organizationId: string, openKey: NewLocationSection | null) {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const dashboard = useDashboardOrganization()
  const draft = useState(`location-draft-${organizationId}-${NEW_LOCATION_SLUG}`, blankLocationDraft)
  const creating = ref(false)
  const createError = ref<string | null>(null)
  const isNew = computed(() => route.params.locationSlug === NEW_LOCATION_SLUG)
  const recordPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/locations/${NEW_LOCATION_SLUG}`)

  async function commit() {
    creating.value = true
    createError.value = null
    try {
      const response = await dashboardApi<{ success: true; location: { slug: string } }>('/api/dashboard/locations', {
        method: 'POST',
        body: {
          title: draft.value.title.trim(),
          timezone: draft.value.hours.timezone,
          opening_hours: parseOpeningHours(draft.value.hours.hours),
          special_hours: parseSpecialHours(draft.value.hours.specialHours),
        },
        validate: (value): value is { success: true; location: { slug: string } } =>
          isRecord(value) && value.success === true && isRecord(value.location) && typeof value.location.slug === 'string',
      }).catch((error: unknown) => {
        createError.value = getErrorMessage(error, 'The location could not be added')
        return null
      })
      if (!response) return
      draft.value = blankLocationDraft()
      await dashboard.refresh()
      await navigateTo(`/dashboard/${String(route.params.orgSlug)}/locations/${response.location.slug}`, { replace: true })
    } finally {
      creating.value = false
    }
  }

  const walk = useCreateWalk<NewLocationSection>({
    recordPath,
    isNew,
    openKey: computed(() => openKey ?? NEW_LOCATION_SECTIONS[0]),
    labels: { name: 'Name', hours: 'Hours' },
    order: NEW_LOCATION_SECTIONS,
    missing: key => key === 'name' ? !draft.value.title.trim() : !draft.value.hours.timezone,
    noun: 'location',
    saving: creating,
    commit,
  })
  return { isNew, draft, creating, createError, ...walk }
}

/**
 * One location's editable state and the save for one of its concerns. The
 * settings rail reads it with no key for its row summaries; a leaf reads it
 * with its own key so `saveDisabled`, `validationMessage` and `save` are about
 * that one concern. Loads share one `useAsyncData` key per location, so the
 * rail and the leaf beside it are one request.
 */
/**
 * `settingsPath` stays a source rather than a string: this component is reused
 * as the route moves between locations, so a path read once at setup froze
 * every row to the location that happened to be open first.
 */
export async function useLocationEditor(organizationId: string, locationId: Ref<string | null>, key: LocationEditorKey | null, settingsPath: MaybeRefOrGetter<string> = '') {
  // Captured before the first await: an await in setup leaves the active effect
  // scope, so a watcher created after one is bound to nothing and never stops.
  // Thirteen leaves call this, each leaving its watcher behind on unmount.
  const scope = getCurrentScope()
  const settingsBase = computed(() => toValue(settingsPath))
  const route = useRoute()
  // A leaf of the record that does not exist yet writes the draft and walks on.
  const newLocation = useNewLocation(organizationId, key === 'name' || key === 'hours' ? key : null)
  const isNew = newLocation.isNew
  const dashboardApi = useDashboardApi()
    const editorError = ref<string | null>(null)
  const dashboard = useDashboardOrganization()



  const originalSignature = ref('')

  const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
  const isBusinessLocation = (value: unknown): value is BusinessLocation => {
    if (!isRecord(value)) return false
    return typeof value.id === 'string'
      && typeof value.slug === 'string'
      && typeof value.title === 'string'
      && typeof value.status === 'string'
      && (value.address === null || isRecord(value.address))
      && isNullableString(value.phone)
      && isNullableString(value.google_place_id)
      && isNullableString(value.assigned_member_id)
      && isNullableString(value.assigned_team_id)
  }
  const isLocationResponse = (value: unknown): value is { success: true; location: BusinessLocation } =>
    isRecord(value) && value.success === true && isBusinessLocation(value.location)
  const detailsSaving = ref(false)

  // The reservation policy is its own row (location_reservation_configs), not a
  // column on the location, so it loads and saves through its own endpoint. A
  // null row means this location does not take reservations — the absence of the
  // capability, not an empty policy.
  const reservationForm = ref<LocationReservationConfigPatch>({})
  const reservationSaving = ref(false)
  const closingReservations = ref(false)
  const reservationConfigExists = computed(() => reservationConfig.value !== null)
  const isReservationConfigResponse = (value: unknown): value is { success: true; config: LocationReservationConfig | null } =>
    isRecord(value) && value.success === true && (value.config === null || isRecord(value.config))

  function reservationPatchFrom(config: LocationReservationConfig | null): LocationReservationConfigPatch {
    if (!config) return {}
    const { location_id: _locationId, organization_id: _organizationId, created_at: _createdAt, updated_at: _updatedAt, ...patch } = config
    return patch
  }

  /**
   * The address the form's fields make. The same mapping onboarding uses, so a
   * street with no country is refused here exactly as it is there.
   */
  function addressFromForm(): PostalAddress | null {
    const [streetAddress, ...rest] = detailsForm.addressLines.split('\n').map(line => line.trim()).filter(Boolean)
    return postalAddressFromAnswers({
      streetAddress: streetAddress ?? null,
      addressLine2: rest.join(', ') || null,
      city: detailsForm.locality,
      region: detailsForm.administrativeArea,
      postalCode: detailsForm.postalCode,
      country: detailsForm.regionCode,
      sublocality: detailsForm.sublocality,
    })
  }

  const detailsForm = reactive({
    title: '',
    slug: '',
    phone: '',
    email: '',
    price_level: '',
    addressLines: '',
    regionCode: '',
    locality: '',
    sublocality: '',
    administrativeArea: '',
    postalCode: '',
    short_description: '',
    description: '',
    status: 'active',
    assigned_member_id: null as string | null,
    assigned_team_id: null as string | null,
  })
  const organizationLocalizationSettingsPath = computed(() => `/dashboard/${route.params.orgSlug}/website/localization`)
  const locationLocalizationFields = computed(() => [
    { key: 'title', label: 'Name', source: location.value?.title },
    { key: 'short_description', label: 'Short description', source: location.value?.short_description },
    { key: 'description', label: 'Description', source: location.value?.description, multiline: true, rows: 6 },
    // The address localizes part by part, the way it is stored: a translator
    // writes the street lines and the place names, not one run-together line.
    { key: 'address.addressLines', label: 'Street', source: location.value?.address?.addressLines, kind: 'string-list' as const, rows: 3 },
    { key: 'address.sublocality', label: 'Neighbourhood', source: location.value?.address?.sublocality },
    { key: 'address.locality', label: 'City', source: location.value?.address?.locality },
    { key: 'address.administrativeArea', label: 'State or province', source: location.value?.address?.administrativeArea },
  ])
  function localizedLocationPath(locale: string): string {
    const slug = location.value?.slug
    if (!slug) throw new Error('The location slug is unavailable.')
    return `/${locale}/locations/${slug}`
  }


  const hoursForm = ref<LocationHoursForm>({ timezone: '', hours: null, specialHours: null })

  function fillDetailsForm(loc: BusinessLocation) {
    detailsForm.title = loc.title
    detailsForm.slug = loc.slug
    detailsForm.phone = loc.phone ?? ''
    detailsForm.email = loc.email ?? ''
    detailsForm.price_level = loc.price_level ?? ''
    detailsForm.addressLines = loc.address?.addressLines?.join('\n') ?? ''
    detailsForm.regionCode = loc.address?.regionCode ?? ''
    detailsForm.locality = loc.address?.locality ?? ''
    detailsForm.sublocality = loc.address?.sublocality ?? ''
    detailsForm.administrativeArea = loc.address?.administrativeArea ?? ''
    detailsForm.postalCode = loc.address?.postalCode ?? ''
    detailsForm.short_description = loc.short_description ?? ''
    detailsForm.description = loc.description ?? ''
    hoursForm.value = { timezone: loc.timezone, hours: parseOpeningHours(loc.opening_hours), specialHours: parseSpecialHours(loc.special_hours) }
    detailsForm.status = loc.status
    detailsForm.assigned_member_id = loc.assigned_member_id
    detailsForm.assigned_team_id = loc.assigned_team_id
  }

  const { data: schedulingMembers, error: schedulingMembersError } = await useMemberSchedulingList(() => organizationId)
  const assignmentSummary = computed(() => {
    if (!detailsForm.assigned_team_id && !detailsForm.assigned_member_id) return 'Administrators'
    if (schedulingMembersError.value) return 'Team members could not be loaded'
    if (!schedulingMembers.value) return 'Loading team members…'
    if (detailsForm.assigned_team_id) return schedulingMembers.value.teams.find(t => t.id === detailsForm.assigned_team_id)?.name ?? 'Assigned team'
    return schedulingMembers.value.members.find(m => m.id === detailsForm.assigned_member_id)?.name ?? 'Assigned member'
  })

  const statusSummary = computed(() => location.value?.status === 'active' ? 'Published' : 'Draft')
  const navigationGroups = computed(() => [{
    id: 'settings',
    items: [
      { id: 'assignment', label: 'Team assignment', summary: assignmentSummary.value, to: `${settingsBase.value}/assignment` },
      { id: 'status', label: 'Status', summary: statusSummary.value, to: `${settingsBase.value}/status` },
      { id: 'languages', label: 'Languages', summary: 'Translate the name, description and address', to: `${settingsBase.value}?editMode=translations` },
    ],
  }])

  // Every write this screen can be in the middle of, including the one that
  // stops reservations: Save stayed live during that delete, and a save landing
  // on top of it recreated the policy it had just removed.
  const saving = computed(() => detailsSaving.value || reservationSaving.value || closingReservations.value || newLocation.creating.value)

  function editorSignature(key: string | null): string {
    switch (key) {
      case 'name': return JSON.stringify(detailsForm.title)
      case 'address': return JSON.stringify([detailsForm.addressLines, detailsForm.regionCode, detailsForm.locality, detailsForm.sublocality, detailsForm.administrativeArea, detailsForm.postalCode])
      case 'contact': return JSON.stringify([detailsForm.phone, detailsForm.email])
      case 'assignment': return JSON.stringify([detailsForm.assigned_member_id, detailsForm.assigned_team_id])
      case 'status': return JSON.stringify(detailsForm.status)
      case 'hours': return JSON.stringify(hoursForm.value)
      case 'description': return JSON.stringify([detailsForm.short_description, detailsForm.description, detailsForm.price_level])
      case 'reservations': return JSON.stringify(reservationForm.value)
      default: return ''
    }
  }
  const validationMessage = computed(() => {
    if (key === 'name' && !detailsForm.title.trim()) return 'Enter a location name.'
    if (key === 'contact') {
      if (detailsForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(detailsForm.email)) return 'Enter a valid email address.'
    }
    if (key === 'hours') {
      if (!hoursForm.value.timezone) return 'Choose the location timezone.'
      try {
        parseOpeningHours(hoursForm.value.hours)
        parseSpecialHours(hoursForm.value.specialHours)
      } catch (error) { return error instanceof Error ? error.message : 'Invalid hours' }
    }
    return null
  })
  const dirty = computed(() => editorSignature(key) !== originalSignature.value)
  const saveDisabled = computed(() => isNew.value
    ? newLocation.saveDisabled.value || validationMessage.value !== null
    : !dirty.value || validationMessage.value !== null)


  function resetDraft() {
    editorError.value = null
    if (!location.value) return
    fillDetailsForm(location.value)
    reservationForm.value = reservationPatchFrom(reservationConfig.value)
    originalSignature.value = editorSignature(key)
  }

  async function patchLocation(body: Record<string, unknown>) {
    const requestedLocationId = locationId.value
    detailsSaving.value = true
    editorError.value = null
    try {
      const response = await dashboardApi<{ success: true; location: BusinessLocation }>(
        `/api/dashboard/locations/${requestedLocationId}`,
        { method: 'PATCH', body, validate: isLocationResponse },
      )
      if (locationId.value !== requestedLocationId) return
      const previousSlug = String(route.params.locationSlug)
      // Every editor of this location reads one shared resource; refreshing it
      // refills them all, so the index beside this leaf shows what was saved.
      await refreshLocationWorkspace()
      // The location's own index draws the same location from its own read.
      await refreshNuxtData(`dashboard-location-overview:${organizationId}:${requestedLocationId}`)
      if (response.location.slug !== previousSlug) {
        await dashboard.refresh()
        // The record moved: same level, its new address.
        await navigateTo(route.path.replace(`/locations/${previousSlug}`, `/locations/${response.location.slug}`), { replace: true })
      }
    } catch (error) {
      editorError.value = getErrorMessage(error, 'Failed to save location')
    } finally {
      detailsSaving.value = false
    }
  }

  async function saveReservationPolicy() {
    const requestedLocationId = locationId.value
    reservationSaving.value = true
    editorError.value = null
    try {
      await dashboardApi<{ success: true; config: LocationReservationConfig | null }>(
        `/api/editor/organizations/${organizationId}/locations/${requestedLocationId}/reservation-config`,
        { method: 'PUT', body: { ...reservationForm.value, expected_updated_at: reservationConfig.value?.updated_at ?? null }, validate: isReservationConfigResponse },
      )
      if (locationId.value !== requestedLocationId) return
      await refreshLocationWorkspace()
      await refreshNuxtData(`dashboard-location-overview:${organizationId}:${requestedLocationId}`)
    } catch (error) {
      editorError.value = getErrorMessage(error, 'Failed to save the reservation policy')
    } finally {
      reservationSaving.value = false
    }
  }

  async function closeReservations() {
    const requestedLocationId = locationId.value
    closingReservations.value = true
    editorError.value = null
    try {
      await dashboardApi<{ success: true }>(
        `/api/editor/organizations/${organizationId}/locations/${requestedLocationId}/reservation-config`,
        { method: 'DELETE', validate: (value: unknown): value is { success: true } => isRecord(value) && value.success === true },
      )
      if (locationId.value !== requestedLocationId) return
      await refreshLocationWorkspace()
      await refreshNuxtData(`dashboard-location-overview:${organizationId}:${requestedLocationId}`)
    } catch (error) {
      editorError.value = getErrorMessage(error, 'Failed to close reservations')
    } finally {
      closingReservations.value = false
    }
  }

  async function saveCurrentEditor() {
    if (saveDisabled.value) return
    if (key === 'reservations') {
      await saveReservationPolicy()
      return
    }
    if (key === 'name') {
      await patchLocation({ title: detailsForm.title.trim() })
      return
    }
    if (key === 'address') {
      await patchLocation({ address: addressFromForm() })
      return
    }
    if (key === 'contact') {
      await patchLocation({
        phone: detailsForm.phone.trim() || null,
        email: detailsForm.email.trim() || null,
      })
      return
    }
    if (key === 'assignment') {
      await patchLocation({
        assigned_member_id: detailsForm.assigned_member_id,
        assigned_team_id: detailsForm.assigned_team_id,
      })
      return
    }
    if (key === 'status') {
      await patchLocation({ status: detailsForm.status })
      return
    }
    if (key === 'hours') {
      await patchLocation({ opening_hours: parseOpeningHours(hoursForm.value.hours), special_hours: parseSpecialHours(hoursForm.value.specialHours), timezone: hoursForm.value.timezone })
      return
    }
    if (key === 'description') {
      await patchLocation({
        short_description: detailsForm.short_description.trim() || null,
        description: detailsForm.description.trim() || null,
        price_level: detailsForm.price_level.trim() || null,
      })
      return
    }
    throw new Error(`The ${key ?? 'location'} setting has nothing to save.`)
  }

  interface LocationSettingsResource {
    location: { success: true; location: BusinessLocation }
    reservationConfig: { success: true; config: LocationReservationConfig | null }
  }

  const locationSettingsKey = computed(() => `dashboard-location-settings-${organizationId}-${isNew.value ? NEW_LOCATION_SLUG : locationId.value}`)
  const {
    data: locationSettingsResource,
    error: locationSettingsError,
    refresh: refreshLocationWorkspace,
  } = await useAsyncData<LocationSettingsResource | null>(locationSettingsKey, async () => {
    if (isNew.value) return null
    const requestedLocationId = locationId.value
    if (!requestedLocationId) throw createError({ statusCode: 400, statusMessage: 'Location is required' })
    const [locationResponse, reservationResponse] = await Promise.all([
      dashboardApi<{ success: true; location: BusinessLocation }>(
        `/api/dashboard/locations/${requestedLocationId}`,
        { validate: isLocationResponse },
      ),
      dashboardApi<{ success: true; config: LocationReservationConfig | null }>(
        `/api/editor/organizations/${organizationId}/locations/${requestedLocationId}/reservation-config`,
        { validate: isReservationConfigResponse },
      ),
    ])
    return { location: locationResponse, reservationConfig: reservationResponse }
  }, {
    watch: [locationId],
  })

  // The location and its policy are what the request answered; only the drafts
  // are this editor's own, seeded from each answer.
  const location = computed(() => locationSettingsResource.value?.location.location ?? null)
  const reservationConfig = computed(() => locationSettingsResource.value?.reservationConfig.config ?? null)
  const error = computed(() => locationSettingsError.value ? getErrorMessage(locationSettingsError.value, 'Failed to load location') : null)
  const seedDrafts = () => watch(locationSettingsResource, (resource) => {
    if (!resource) return
    reservationForm.value = reservationPatchFrom(resource.reservationConfig.config)
    fillDetailsForm(resource.location.location)
    originalSignature.value = editorSignature(key)
  }, { immediate: true })
  // The new record's forms are its draft: seeded from it, and written back as typed.
  const bindNewDraft = () => {
    detailsForm.title = newLocation.draft.value.title
    hoursForm.value = structuredClone(toRaw(newLocation.draft.value.hours))
    watch(() => detailsForm.title, value => { newLocation.draft.value.title = value }, { flush: 'sync' })
    watch(hoursForm, value => { newLocation.draft.value.hours = structuredClone(toRaw(value)) }, { deep: true, flush: 'sync' })
  }
  const bind = isNew.value ? bindNewDraft : seedDrafts
  if (scope) scope.run(bind)
  else bind()

  return {
    error, location, saving, saveDisabled, validationMessage, dirty,
    editorError: computed(() => isNew.value ? newLocation.createError.value : editorError.value),
    saveLabel: newLocation.saveLabel,
    detailsForm, hoursForm, reservationForm, reservationConfigExists, closingReservations,
    navigationGroups, locationLocalizationFields, localizedLocationPath, organizationLocalizationSettingsPath,
    revert: resetDraft, save: () => isNew.value ? newLocation.save() : saveCurrentEditor(), closeReservations,
  }
}
</script>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'

const level = useRouteLevel()
const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, null, level.path)

useSeoMeta({ title: 'Settings | KrabiClaw', robots: 'noindex, nofollow' })
</script>
