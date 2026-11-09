<template>
  <DashboardLeafPanel id="stay-move" title="Move guest" :lead="lead" save-label="Move guest" :saving="saving" :disabled="!chosen" :error="error || (loadError ? getErrorMessage(loadError, 'Your other homes could not be loaded.') : '')" @cancel="selected = ''" @save="save">
    <URadioGroup v-if="items.length" v-model="selected" :items="items" variant="card" />
    <p v-else-if="data" class="text-base text-muted">You have no other homes to move this guest to.</p>
    <p v-if="data?.stay.channel !== 'direct' && data" class="mt-4 text-sm text-muted">The reservation stays where it was booked. We’ll block these nights on the new home, send the cleaning there, and message the guest the new address, entry details and check-in time.</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

interface MoveOption { product_id: string; internal_name: string; same_address: boolean; distance_meters: number | null; taken: Array<{ from: string; to: string }>; has_instructions: boolean }
interface MoveStayRecord { id: string; version: number; channel: string; guest_name: string | null; product_id: string; booked_product_id: string | null }

const route = useRoute()
const level = useRouteLevel()
const api = useDashboardApi()
const toast = useToast()
const stayId = String(route.params.bookingId ?? '')
if (route.params.bookingType !== 'stay') throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })

const isOptions = (value: unknown): value is { options: MoveOption[] } => isRecord(value) && Array.isArray(value.options)
const isManagedStay = (value: unknown): value is { stay: MoveStayRecord; manage: true } => isRecord(value) && value.manage === true && isRecord(value.stay) && typeof value.stay.version === 'number'
const { data, error: loadError } = await useAsyncData(`stay-move:${stayId}`, async () => {
  const path = `/api/dashboard/stays/${encodeURIComponent(stayId)}`
  const [{ stay }, { options }] = await Promise.all([api(path, { validate: isManagedStay }), api(`${path}/move-options`, { validate: isOptions })])
  return { stay, options }
})

const selected = ref('')
const saving = ref(false)
const error = ref('')
const lead = computed(() => data.value?.stay.guest_name ? `Choose where ${data.value.stay.guest_name} will stay instead.` : 'Choose where this guest will stay instead.')
const place = (option: MoveOption) => option.same_address ? 'Same building' : option.distance_meters === null ? null : option.distance_meters < 200 ? 'Next door' : `${(option.distance_meters / 1609.34).toFixed(1)} mi away`
const availability = (option: MoveOption) => {
  if (option.taken.length) return `Taken ${option.taken.map(range => `${formatCalendarDate(range.from, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(range.to, 'en', { month: 'short', day: 'numeric' })}`).join(', ')}`
  return option.has_instructions ? 'Free for every night' : 'Free, but needs check-in instructions first'
}
const items = computed(() => (data.value?.options ?? []).map(option => ({
  label: option.product_id === data.value!.stay.booked_product_id ? `${option.internal_name} (booked listing)` : option.internal_name,
  value: option.product_id, description: [place(option), availability(option)].filter(Boolean).join(' · '),
  disabled: option.taken.length > 0 || !option.has_instructions,
})))
const chosen = computed(() => items.value.find(item => item.value === selected.value && !item.disabled) ?? null)

async function save() {
  const stay = data.value?.stay
  if (!stay || !chosen.value) return
  saving.value = true
  error.value = ''
  try {
    const moved = await api(`/api/dashboard/stays/${encodeURIComponent(stayId)}/move`, {
      method: 'POST', body: { expected_version: stay.version, product_id: selected.value },
      validate: (value: unknown): value is { stay: { guest_notified: boolean } } => isRecord(value) && isRecord(value.stay) && typeof value.stay.guest_notified === 'boolean',
    })
    if (!moved.stay.guest_notified) toast.add({ color: 'warning', title: 'Guest not messaged', description: 'This stay has no conversation here yet. Send the new address and entry details on the booking site.' })
    await refreshNuxtData(`${String(route.params.orgSlug)}-stay:${stayId}`)
    await navigateTo(level.to.value ?? `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/bookings/stay/${encodeURIComponent(stayId)}`)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The guest could not be moved.')
  } finally {
    saving.value = false
  }
}
</script>
