<template>
  <DashboardLeafPanel id="stay-move" title="Move guest" :lead="lead" save-label="Move guest" :saving="saving" :disabled="!chosen" :error="error || (loadError ? getErrorMessage(loadError, 'Your other homes could not be loaded.') : '')" @cancel="selected = ''" @save="save">
    <URadioGroup v-if="items.length" v-model="selected" :items="items" variant="card" />
    <p v-else-if="data" class="text-base text-muted">You have no other homes to move this guest to.</p>
    <p v-if="stay && stay.channel !== 'direct'" class="mt-4 text-sm text-muted">The reservation stays where it was booked. We’ll block these nights on the new home, send the cleaning there, and message the guest the new address, entry details and check-in time.</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { STAY_MOVE_MESSAGE_QUEUED, isMovedStayResponse } from '~/shared/stay-move'
import { getErrorMessage } from '~/utils/errors'
import { ApiClientError } from '~/utils/api-clients'
import type { DashboardBooking, DashboardNightBooking } from '~/composables/useDashboardBooking'

definePageMeta({ layout: 'dashboard' })

interface MoveOption { product_id: string; internal_name: string; same_address: boolean; distance_meters: number | null; taken: Array<{ from: string; to: string }>; has_instructions: boolean }

const route = useRoute()
const level = useRouteLevel()
const api = useDashboardApi()
const toast = useToast()
const stayId = String(route.params.record_id ?? '')
const bookingKey = dashboardBookingKey(String(route.params.org_slug), stayId)
const moveKey = `stay-move:${String(route.params.org_slug)}:${stayId}`
const { data: booking } = useNuxtData<DashboardBooking>(bookingKey)
const stay = computed(() => booking.value?.booking.unit === 'nights' && booking.value.manage
  ? (booking.value as Extract<DashboardNightBooking, { manage: true }>).booking : null)

const isOptions = (value: unknown): value is { options: MoveOption[] } => isRecord(value) && Array.isArray(value.options)
const { data, error: loadError } = await useAsyncData(moveKey, () => api(`${dashboardBookingPath(stayId)}/move-options`, { validate: isOptions }))

const selected = ref('')
const saving = ref(false)
const error = ref('')
const lead = computed(() => stay.value?.guest_name ? `Choose where ${stay.value.guest_name} will stay instead.` : 'Choose where this guest will stay instead.')
const place = (option: MoveOption) => option.same_address ? 'Same building' : option.distance_meters === null ? null : option.distance_meters < 200 ? 'Next door' : `${(option.distance_meters / 1609.34).toFixed(1)} mi away`
const availability = (option: MoveOption) => {
  if (option.taken.length) return `Taken ${option.taken.map(range => `${formatCalendarDate(range.from, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(range.to, 'en', { month: 'short', day: 'numeric' })}`).join(', ')}`
  return option.has_instructions ? 'Free for every night' : 'Free, but needs check-in instructions first'
}
const items = computed(() => (data.value?.options ?? []).map(option => ({
  label: option.product_id === stay.value?.booked_product_id ? `${option.internal_name} (booked listing)` : option.internal_name,
  value: option.product_id, description: [place(option), availability(option)].filter(Boolean).join(' · '),
  disabled: option.taken.length > 0 || !option.has_instructions,
})))
const chosen = computed(() => items.value.find(item => item.value === selected.value && !item.disabled) ?? null)

async function save() {
  if (!stay.value || !chosen.value) return
  saving.value = true
  error.value = ''
  try {
    await api(`${dashboardBookingPath(stayId)}/move`, {
      method: 'POST', body: { version: stay.value.version, product_id: selected.value },
      validate: isMovedStayResponse,
    })
    toast.add(STAY_MOVE_MESSAGE_QUEUED)
    await refreshNuxtData(bookingKey)
    await navigateTo(level.to.value ?? `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/${encodeURIComponent(stayId)}`)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The guest could not be moved.')
    // The move is saved when its channel push or publication fails: the stay and its options are reloaded so the next attempt is not a version conflict.
    if (cause instanceof ApiClientError && (cause.data.committed === true || (isRecord(cause.data.data) && cause.data.data.committed === true))) {
      await Promise.all([refreshNuxtData(moveKey), refreshNuxtData(bookingKey)])
    }
  } finally {
    saving.value = false
  }
}
</script>
