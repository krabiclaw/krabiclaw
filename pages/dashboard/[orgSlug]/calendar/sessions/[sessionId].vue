<template>
  <DashboardLeafPanel id="product-session" :title="isNew ? 'Add availability' : 'Edit availability'" :lead="timezone ? `Times are in ${timezone}.` : p.product.value?.kind === 'service' ? 'Choose the office for this consultation.' : 'Choose where this experience takes place.'" :saving="saving" :disabled="pending || !valid || (!isNew && !form?.dirty && !saveError)" :error="saveError ?? scopeError ?? (error ? getErrorMessage(error, 'Session could not be loaded') : '')" :save-label="isNew ? 'Add to calendar' : 'Save'" @cancel="reset(); revision += 1" @save="form?.submit()">
    <UForm v-if="!scopeError" ref="form" :key="revision" :state="{ location: p.locationId.value, startDate, startsAt, endsAt, capacity, sessionStatus }" :validate="() => validation.errors" class="space-y-6" @submit="save">
      <UFormField v-if="isNew" name="location" label="Location" required><USelect :model-value="p.locationId.value ?? undefined" :items="locationItems" placeholder="Choose a location" class="w-full" @update:model-value="chooseLocation" /></UFormField>
      <p v-else class="text-sm text-muted">{{ savedLocation?.title ?? 'Online' }}</p>
      <UFormField v-if="isNew" name="startDate" label="Date" required eager-validation><UInput v-model="startDate" type="date" class="w-full" /></UFormField>
      <UFormField name="startsAt" label="Starts" required eager-validation><UInput v-if="isNew" v-model="startTime" type="time" step="60" class="w-full" :disabled="!canCreate" /><UInput v-else v-model="startsAt" type="datetime-local" step="60" class="w-full" :disabled="hasGuests" /></UFormField>
      <UFormField name="endsAt" label="Ends" required eager-validation><UInput v-model="endsAt" type="datetime-local" step="60" class="w-full" :disabled="hasGuests || isNew && !canCreate" /></UFormField>
      <UFormField name="capacity" label="Guest limit" hint="Blank means no limit"><UInputNumber v-model="capacity" :min="data?.session.claimed ?? 0" class="w-full" /></UFormField>
      <UFormField v-if="!isNew" name="sessionStatus">
        <URadioGroup v-model="sessionStatus" :items="[{ label: 'Scheduled', value: 'scheduled' }, { label: 'Cancelled', value: 'cancelled' }]" :disabled="hasGuests" variant="card" />
      </UFormField>
      <p v-if="hasGuests" class="text-sm text-muted">This session has guests or active checkouts. Manage their bookings before changing its time or cancelling it.</p>
    </UForm>
    <UButton v-if="saveError && !isNew" class="mt-6" color="neutral" variant="outline" @click="useSavedSession">Use saved values</UButton>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import { calendarSessionsKey } from '~/components/dashboard/CalendarPage.vue'
import { isSessionResponse, isSessionsResponse } from '~/utils/session-contract'
import { isValidCalendarDate, isValidTimezone, localDateTimeToInstant, localNow } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import type { ProductSessionStatus } from '~/shared/bookings'

definePageMeta({ layout: 'dashboard' })
const context = inject(calendarSessionsKey)
if (!context?.product.value) throw createError({ statusCode: 400, statusMessage: 'Choose the offering whose availability you want to edit.' })
const productId = context.product.value.id
const p = context
const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const sessionId = computed(() => String(route.params.sessionId))
const isNew = computed(() => sessionId.value === 'new')
const endpoint = `/api/editor/organizations/${p.organizationId}/products/${productId}/sessions`
const { data, error, pending, refresh: refreshSession } = await useAsyncData(
  () => `product-session:${p.organizationId}:${productId}:${sessionId.value}`,
  async () => isNew.value ? null : dashboardApi(`${endpoint}/${sessionId.value}`, { validate: isSessionResponse }),
)
const locationItems = computed(() => p.locations.value.map(location => ({ label: `${location.title}${location.status === 'active' ? '' : ` · ${location.status}`}`, value: location.id, disabled: location.status !== 'active' })))
function chooseLocation(value: string) {
  return router.replace({ query: { ...route.query, locationId: value } })
}
const canCreate = computed(() => p.location.value?.status === 'active')
const timezone = computed(() => data.value?.session.timezone ?? p.location.value?.timezone)
const savedLocation = computed(() => p.allLocations.value.find(location => location.id === data.value?.session.location_id))
const scopeError = computed(() => {
  if (Object.hasOwn(route.query, 'date') && (typeof route.query.date !== 'string' || !isValidCalendarDate(route.query.date))) return 'Choose a valid calendar date.'
  if (p.scope.value && p.scope.value !== 'online' && !p.location.value) return 'This offering is not assigned to the location in this address.'
  if (isNew.value) return p.scope.value === 'online' ? 'Online times follow the host’s working hours.' : p.location.value && !canCreate.value ? 'Choose an active location before adding availability.' : null
  const session = data.value?.session
  if (session?.location_id && !savedLocation.value) return 'This scheduled time’s saved location could not be loaded.'
  return session && (p.locationId.value && session.location_id !== p.locationId.value || p.scope.value === 'online' && session.location_id !== null)
    ? 'This session does not belong to the location in this address.' : null
})
const startsAt = ref('')
const startDate = computed({ get: () => startsAt.value.split('T')[0] ?? '', set: (date: string) => { startsAt.value = `${date}T${startTime.value}` } })
const startTime = computed({ get: () => startsAt.value.split('T')[1] ?? '', set: (time: string) => { startsAt.value = `${startDate.value}T${time}` } })
const endsAt = ref('')
const capacity = ref<number | undefined>()
const sessionStatus = ref<ProductSessionStatus>('scheduled')
const saving = ref(false)
const recovering = ref(false)
const saveError = ref<string | null>(null)
const creationIntent = useState(`session-create:${p.organizationId}:${productId}`, () => ({ key: crypto.randomUUID(), fingerprint: '' }))
const hasGuests = computed(() => (data.value?.session.claimed ?? 0) > 0)
function localInput(instant: string, zone: string): string {
  const local = localNow(zone, new Date(instant))
  return `${local.date}T${local.time}`
}
function reset() {
  const session = data.value?.session
  startsAt.value = session ? localInput(session.starts_at, session.timezone) : typeof route.query.date === 'string' ? `${route.query.date}T` : ''
  endsAt.value = session ? localInput(session.ends_at, session.timezone) : ''
  capacity.value = session ? session.capacity ?? undefined : p.product.value?.booking?.default_capacity ?? undefined
  sessionStatus.value = session?.status ?? 'scheduled'
  saveError.value = null
}
watch([data, error, p.product, sessionId], ([,,, nextId], [,,, previousId]) => {
  if (nextId !== previousId || !saving.value && !recovering.value && !saveError.value && !error.value) reset()
}, { immediate: true })
function instant(value: string, original?: string): string {
  if (original && timezone.value && value === localInput(original, timezone.value)) return original
  const [date, time] = value.split('T')
  if (!date || !time) throw new Error('Choose a complete date and time.')
  if (!isValidTimezone(timezone.value)) throw new Error('Choose a location with a valid time zone.')
  return localDateTimeToInstant(date, time, timezone.value).toISOString()
}
const validation = computed(() => {
  const errors: FormError[] = []
  const instants: Partial<Record<'startsAt' | 'endsAt', string>> = {}
  if (isNew.value && !p.locationId.value) errors.push({ name: 'location', message: 'Choose a location.' })
  if (isNew.value && !startDate.value) errors.push({ name: 'startDate', message: 'Choose a date.' })
  if (isNew.value ? !startTime.value : !startsAt.value) errors.push({ name: 'startsAt', message: isNew.value ? 'Choose a start time.' : 'Choose a start date and time.' })
  if (!endsAt.value) errors.push({ name: 'endsAt', message: 'Choose an end date and time.' })
  for (const [name, value, original] of [
    ['startsAt', startsAt.value, data.value?.session.starts_at],
    ['endsAt', endsAt.value, data.value?.session.ends_at],
  ] as const) {
    if (!value || name === 'startsAt' && isNew.value && (!startDate.value || !startTime.value)) continue
    try { instants[name] = instant(value, original) }
    catch (failure) {
      const cause = getErrorMessage(failure, 'This local time could not be converted.')
      const reason = cause === 'No such absolute time found' ? 'This time does not exist because the clocks move forward.'
        : cause === 'Multiple possible absolute times found' ? 'This time occurs twice because the clocks move back.' : cause
      errors.push({ name, message: `${reason} Choose another ${name === 'startsAt' ? 'start' : 'end'} time${timezone.value ? ` in ${timezone.value}` : ''}.` })
    }
  }
  if (instants.startsAt && instants.endsAt && instants.endsAt <= instants.startsAt) errors.push({ name: 'endsAt', message: 'End time must be after the start time.' })
  if (capacity.value !== undefined && (!Number.isSafeInteger(capacity.value) || capacity.value < (data.value?.session.claimed ?? 0))) {
    errors.push({ name: 'capacity', message: `Enter a whole guest limit of ${data.value?.session.claimed ?? 0} or more, or leave it blank for no limit.` })
  }
  return { errors, ...instants }
})
const suggestedEnd = computed(() => {
  const duration = p.product.value?.booking?.duration_minutes
  const start = validation.value.startsAt
  const zone = timezone.value
  return isNew.value && duration && start && zone ? localInput(new Date(Date.parse(start) + duration * 60_000).toISOString(), zone) : undefined
})
// Keep the last generated end through an invalid start; an authored end stays untouched.
let previousSuggestedEnd: string | undefined
watch(suggestedEnd, (next) => {
  if (!next) return
  if (!endsAt.value || endsAt.value === previousSuggestedEnd) endsAt.value = next
  previousSuggestedEnd = next
})
const valid = computed(() => Boolean(p.product.value?.booking) && (!isNew.value || canCreate.value) && !scopeError.value && !error.value && Boolean(validation.value.startsAt && validation.value.endsAt) && !validation.value.errors.length)
const form = useTemplateRef('form')
// Revalidate native touched/error fields when a suggestion or time zone changes.
// Untouched missing fields remain unmarked until their native input/blur or submit.
watch(validation, async () => {
  const current = form.value
  if (!current) return
  const names = new Set(current.getErrors().flatMap(({ name }) => name ? [name] : []))
  for (const name of current.touchedFields) names.add(String(name))
  if (startDate.value && startTime.value) names.add('startsAt')
  if (endsAt.value) names.add('endsAt')
  if (names.size) await current.validate({ name: [...names], silent: true })
}, { flush: 'post' })
// Cancel restores the draft; a new revision is a fresh form, so nothing reads as changed.
const revision = ref(0)
async function useSavedSession() {
  recovering.value = true
  try {
    await refreshSession()
    if (error.value) throw error.value
    reset()
    revision.value++
  } catch (failure) { saveError.value = getErrorMessage(failure, 'Session could not be loaded') }
  finally { recovering.value = false }
}
async function save() {
  const creating = isNew.value
  saving.value = true
  saveError.value = null
  try {
    const { startsAt: start, endsAt: end } = validation.value
    if (!valid.value || !start || !end) throw new Error(validation.value.errors[0]?.message ?? scopeError.value ?? (error.value ? getErrorMessage(error.value, 'Session could not be loaded') : 'Check the offering’s booking calendar and location before saving.'))
    const times = { starts_at: start, ends_at: end, capacity: capacity.value ?? null }
    if (isNew.value) {
      const fingerprint = JSON.stringify({ ...times, location_id: p.locationId.value })
      if (creationIntent.value.fingerprint && creationIntent.value.fingerprint !== fingerprint) creationIntent.value.key = crypto.randomUUID()
      creationIntent.value.fingerprint = fingerprint
    }
    const saved = creating ? (await dashboardApi(endpoint, {
      method: 'POST', body: { ...times, location_id: p.locationId.value, idempotency_key: creationIntent.value.key }, validate: isSessionsResponse,
    })).sessions : [(await dashboardApi(`${endpoint}/${sessionId.value}`, {
      method: 'PATCH', body: { ...times, status: sessionStatus.value, expected_updated_at: data.value!.session.updated_at }, validate: isSessionResponse,
    })).session]
    const dates = [...new Set(saved.map(session => localNow(session.timezone, new Date(session.starts_at)).date))]
    const [date] = dates
    if (dates.length !== 1 || !date) throw new Error('The saved availability did not identify one calendar date.')
    // Keep the saved version if the required calendar read fails; a retry must
    // compare against the write that succeeded, while retaining the draft.
    if (!creating) data.value = { session: saved[0]! }
    await p.refresh(date)
    await navigateTo({ path: `/dashboard/${route.params.orgSlug}/calendar`, query: { product_id: productId, locationId: p.scope.value ?? undefined, month: date.slice(0, 7), date } })
    if (creating) creationIntent.value = { key: crypto.randomUUID(), fingerprint: '' }
  } catch (failure) { saveError.value = getErrorMessage(failure, 'Session could not be saved') }
  finally { saving.value = false }
}
</script>
