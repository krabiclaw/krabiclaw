<template>
  <DashboardLeafPanel id="product-session" :title="isNew ? newSession.title : 'Edit session'" :lead="timezone ? `Times are in ${timezone}.` : 'Choose a location first; online times come from the provider\'s working hours.'" :saving="saving" :disabled="pending || !valid || (!isNew && !form?.dirty && !saveError)" :error="saveError ?? p.loadError.value ?? scopeError ?? (error ? getErrorMessage(error, 'Session could not be loaded') : '')" :save-label="isNew ? newSession.action : 'Save'" @cancel="reset(); revision += 1" @save="form?.submit()">
    <UButton v-if="scopeError" :to="chooseLocationPath" color="neutral" variant="outline">Dated sessions</UButton>
    <UForm v-else ref="form" :key="revision" :state="{ startsAt, endsAt, capacity, sessionStatus }" class="space-y-6" @submit="save">
      <UFormField name="startsAt" label="Starts" required><UInput v-model="startsAt" type="datetime-local" step="60" class="w-full" :disabled="hasGuests" /></UFormField>
      <UFormField name="endsAt" label="Ends" required><UInput v-model="endsAt" type="datetime-local" step="60" class="w-full" :disabled="hasGuests" /></UFormField>
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
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { isSessionResponse, isSessionsResponse } from '~/utils/session-contract'
import { isValidTimezone, localDateTimeToInstant, localNow } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import type { ProductSessionStatus } from '~/shared/bookings'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const chooseLocationPath = computed(() => router.resolve({ path: router.resolve(p.sectionPath('booking/sessions')).path, query: { ...route.query, location_id: undefined } }).fullPath)
const dashboardApi = useDashboardApi()
const sessionId = computed(() => String(route.params.sessionId))
const isNew = computed(() => sessionId.value === 'new')
const newSession = newRecordLabels('session')
const endpoint = computed(() => `/api/editor/organizations/${p.organizationId}/products/${route.params.productId}/sessions`)
const { data, error, pending, refresh: refreshSession } = await useAsyncData(
  () => `product-session:${p.organizationId}:${route.params.productId}:${sessionId.value}`,
  async () => isNew.value ? null : dashboardApi(`${endpoint.value}/${sessionId.value}`, { validate: isSessionResponse }),
)
// The mounted list owns this keyed request; Nuxt shares its data, refresh and failure state.
const sessions = await useAsyncData(
  () => `product-sessions:${p.organizationId}:${p.product.value?.id}:${route.query.location_id === 'online' ? 'online' : p.locationId.value ?? 'all'}`,
  async () => p.product.value?.booking
    ? dashboardApi(`/api/editor/organizations/${p.organizationId}/products/${p.product.value.id}/sessions`, { validate: isSessionsResponse })
    : null,
)
const timezone = computed(() => data.value?.session.timezone ?? p.location.value?.timezone)
const scopeError = computed(() => {
  if (isNew.value) return p.location.value?.status === 'active' ? null : 'Choose an active physical location in Dated sessions before adding a session. Online times follow the host’s working hours.'
  const session = data.value?.session
  return session && (p.locationId.value && session.location_id !== p.locationId.value || route.query.location_id === 'online' && session.location_id !== null)
    ? 'This session does not belong to the location in this address.' : null
})
const startsAt = ref('')
const endsAt = ref('')
const capacity = ref<number | undefined>()
const sessionStatus = ref<ProductSessionStatus>('scheduled')
const saving = ref(false)
const recovering = ref(false)
const saveError = ref<string | null>(null)
const creationIntent = useState(`session-create:${p.organizationId}:${route.params.productId}:${p.locationId.value ?? 'online'}`, () => ({ key: crypto.randomUUID(), fingerprint: '' }))
const hasGuests = computed(() => (data.value?.session.claimed ?? 0) > 0)
function localInput(instant: string, zone: string): string {
  const local = localNow(zone, new Date(instant))
  return `${local.date}T${local.time}`
}
function reset() {
  const session = data.value?.session
  startsAt.value = session ? localInput(session.starts_at, session.timezone) : ''
  endsAt.value = session ? localInput(session.ends_at, session.timezone) : ''
  capacity.value = session ? session.capacity ?? undefined : p.product.value?.booking?.default_capacity ?? undefined
  sessionStatus.value = session?.status ?? 'scheduled'
  saveError.value = null
}
watch([data, error, p.product, sessionId, p.locationId], ([,,, nextId, nextLocation], [,,, previousId, previousLocation]) => {
  if (nextId !== previousId || nextLocation !== previousLocation || !saving.value && !recovering.value && !saveError.value && !error.value) reset()
}, { immediate: true })
function instant(value: string, original?: string): string {
  if (original && timezone.value && value === localInput(original, timezone.value)) return original
  const [date, time] = value.split('T')
  if (!date || !time || !isValidTimezone(timezone.value)) throw new Error('Choose valid start and end times in the offering’s time zone')
  return localDateTimeToInstant(date, time, timezone.value).toISOString()
}
const valid = computed(() => {
  try { return Boolean(p.product.value?.booking) && !scopeError.value && !error.value && instant(endsAt.value, data.value?.session.ends_at) > instant(startsAt.value, data.value?.session.starts_at) && (capacity.value === undefined || (Number.isSafeInteger(capacity.value) && capacity.value >= (data.value?.session.claimed ?? 0))) }
  catch { return false }
})
const form = useTemplateRef('form')
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
  if (!valid.value) return
  const creating = isNew.value
  saving.value = true
  saveError.value = null
  try {
    const times = { starts_at: instant(startsAt.value, data.value?.session.starts_at), ends_at: instant(endsAt.value, data.value?.session.ends_at), capacity: capacity.value ?? null }
    if (isNew.value) {
      const fingerprint = JSON.stringify({ ...times, location_id: p.locationId.value })
      if (creationIntent.value.fingerprint && creationIntent.value.fingerprint !== fingerprint) creationIntent.value.key = crypto.randomUUID()
      creationIntent.value.fingerprint = fingerprint
    }
    if (creating) await dashboardApi(endpoint.value, {
      method: 'POST', body: { ...times, location_id: p.locationId.value, idempotency_key: creationIntent.value.key }, validate: isSessionsResponse,
    })
    else await dashboardApi(`${endpoint.value}/${sessionId.value}`, {
      method: 'PATCH', body: { ...times, status: sessionStatus.value, expected_updated_at: data.value!.session.updated_at }, validate: isSessionResponse,
    })
    await sessions.refresh()
    if (sessions.error.value) throw sessions.error.value
    await navigateTo(level.to.value ?? p.sectionPath('booking/sessions'))
    if (creating) creationIntent.value = { key: crypto.randomUUID(), fingerprint: '' }
  } catch (failure) { saveError.value = getErrorMessage(failure, 'Session could not be saved') }
  finally { saving.value = false }
}
</script>
