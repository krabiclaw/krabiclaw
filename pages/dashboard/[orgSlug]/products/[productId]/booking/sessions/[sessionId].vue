<template>
  <DashboardLeafPanel id="product-session" :title="isNew ? 'Add a session' : 'Edit session'" :lead="timezone ? `Times are in ${timezone}.` : 'Choose a location first; online times come from the provider\'s working hours.'" :saving="saving" :disabled="pending || !valid || (!isNew && !dirty)" :error="saveError ?? p.loadError.value ?? (error ? getErrorMessage(error, 'Session could not be loaded') : '')" :save-label="isNew ? 'Add session' : 'Save'" @cancel="reset" @save="save">
    <div class="space-y-6">
      <UFormField label="Starts" required><UInput v-model="startsAt" type="datetime-local" step="60" class="w-full" :disabled="hasGuests" /></UFormField>
      <UFormField label="Ends" required><UInput v-model="endsAt" type="datetime-local" step="60" class="w-full" :disabled="hasGuests" /></UFormField>
      <UFormField label="Guest limit" hint="Blank means no limit"><UInputNumber v-model="capacity" :min="data?.session.claimed ?? 0" class="w-full" /></UFormField>
      <URadioGroup v-if="!isNew" v-model="sessionStatus" :items="[{ label: 'Scheduled', value: 'scheduled' }, { label: 'Cancelled', value: 'cancelled' }]" :disabled="hasGuests" variant="card" />
      <p v-if="hasGuests" class="text-sm text-muted">This session has guests or active checkouts. Manage their bookings before changing its time or cancelling it.</p>
    </div>
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
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const sessionId = computed(() => String(route.params.sessionId))
const isNew = computed(() => sessionId.value === 'new')
const endpoint = computed(() => `/api/editor/organizations/${p.organizationId}/products/${route.params.productId}/sessions`)
const { data, error, pending } = await useAsyncData(
  () => `product-session:${p.organizationId}:${route.params.productId}:${sessionId.value}`,
  async () => isNew.value ? null : dashboardApi(`${endpoint.value}/${sessionId.value}`, { validate: isSessionResponse }),
)
const timezone = computed(() => data.value?.session.timezone ?? p.location.value?.timezone)
const startsAt = ref('')
const endsAt = ref('')
const capacity = ref<number | undefined>()
const sessionStatus = ref<ProductSessionStatus>('scheduled')
const saving = ref(false)
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
watch([data, p.product, sessionId], reset, { immediate: true })
function instant(value: string, original?: string): string {
  if (original && timezone.value && value === localInput(original, timezone.value)) return original
  const [date, time] = value.split('T')
  if (!date || !time || !isValidTimezone(timezone.value)) throw new Error('Choose valid start and end times in the offering’s time zone')
  return localDateTimeToInstant(date, time, timezone.value).toISOString()
}
const valid = computed(() => {
  try { return Boolean(p.product.value?.booking) && !error.value && instant(endsAt.value, data.value?.session.ends_at) > instant(startsAt.value, data.value?.session.starts_at) && (capacity.value === undefined || (Number.isSafeInteger(capacity.value) && capacity.value >= (data.value?.session.claimed ?? 0))) }
  catch { return false }
})
const dirty = computed(() => {
  const session = data.value?.session
  return !session || startsAt.value !== localInput(session.starts_at, session.timezone) || endsAt.value !== localInput(session.ends_at, session.timezone) || (capacity.value ?? null) !== session.capacity || sessionStatus.value !== session.status
})
async function save() {
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
    await refreshNuxtData(`product-sessions:${p.organizationId}:${p.product.value?.id}:${p.locationId.value ?? 'all'}`)
    await navigateTo(level.to.value ?? p.sectionPath('booking/sessions'))
    if (creating) creationIntent.value = { key: crypto.randomUUID(), fingerprint: '' }
  } catch (failure) { saveError.value = getErrorMessage(failure, 'Session could not be saved') }
  finally { saving.value = false }
}
</script>
