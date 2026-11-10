<template>
  <!--
    Airbnb's change request: one sheet, the reservation's details edited in
    place, sent once. Nothing moves until the guest accepts.
  -->
  <DashboardLeafPanel
    id="booking-change"
    title="What do you want to change?"
    :lead="booking ? `Nothing changes until ${b.firstName(booking.guestName ?? '')} accepts.` : undefined"
    save-label="Send request"
    desktop-cancel
    :saving="saving"
    :disabled="!booking || !valid || !dirty"
    :error="error ?? ''"
    @save="send"
  >
    <div v-if="booking" class="space-y-8">
      <div class="flex items-center gap-4">
        <img v-if="recordImage" :src="recordImage" alt="" class="size-14 shrink-0 rounded-xl object-cover">
        <p class="min-w-0 flex-1 text-base font-medium text-highlighted">{{ booking.resourceTitle }}</p>
      </div>

      <section class="space-y-6 border-t border-default pt-6">
        <h2 class="text-lg font-semibold text-highlighted">{{ b.noun.value.replace(/^./u, letter => letter.toUpperCase()) }} details</h2>

        <template v-if="b.bookingType === 'reservation'">
          <UFormField v-if="booking.locations.length > 1" label="Location">
            <USelect v-model="draft.locationId" :items="booking.locations.map(location => ({ label: location.title, value: location.id }))" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-2 gap-4">
            <UFormField label="Date">
              <UInput v-model="draft.date" type="date" class="w-full" />
            </UFormField>
            <UFormField label="Time">
              <UInput v-model="draft.time" type="time" class="w-full" />
            </UFormField>
          </div>
        </template>

        <template v-else>
          <UFormField label="Date">
            <UInput v-model="draft.date" type="date" class="w-full" />
          </UFormField>
          <UFormField label="Time">
            <p v-if="sessionsStatus === 'pending'" class="text-sm text-muted">Loading open times…</p>
            <UAlert v-else-if="sessionsError" color="error" variant="soft" :description="getErrorMessage(sessionsError, 'Open times could not be loaded')" />
            <p v-else-if="!times.length" class="text-sm text-muted">No open times on this day.</p>
            <!-- The guest picker's times: a grid of pills, the chosen one filled. -->
            <div v-else class="grid grid-cols-3 gap-2 sm:grid-cols-4">
              <button
                v-for="slot in times"
                :key="slot.id"
                type="button"
                :disabled="slot.disabled"
                :aria-pressed="draft.sessionId === slot.id"
                class="flex min-h-11 items-center justify-center rounded-lg border px-2 py-2 text-sm font-medium transition-colors"
                :class="draft.sessionId === slot.id ? 'border-inverted bg-inverted text-inverted' : slot.disabled ? 'cursor-default border-default text-muted line-through' : 'cursor-pointer border-default text-default hover:border-inverted'"
                @click="draft.sessionId = slot.id"
              >
                {{ slot.label }}
              </button>
            </div>
          </UFormField>
        </template>

        <UFormField :label="guestsLabel">
          <UInputNumber v-model="draft.partySize" :min="1" :max="99" class="w-full" @input="typeGuests" @update:model-value="guestsTypedInvalid = false" @blur="guestsTypedInvalid = false" />
        </UFormField>
      </section>

      <p v-if="policyLine" class="border-t border-default pt-6 text-sm text-muted">{{ policyLine }}</p>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import type { DashboardBookingDetails } from '~/server/utils/dashboard-booking-details'
import { formatTimestamp } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { getVerticalCopy } from '~/utils/vertical-copy'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const api = useDashboardApi()
const b = inject(bookingEditorKey)!
const booking = computed(() => b.booking.value)
const copy = computed(() => booking.value ? getVerticalCopy(booking.value.vertical) : null)
const guestsLabel = computed(() => copy.value?.guestsLabelPlural.replace(/^./u, letter => letter.toUpperCase()) ?? 'Guests')
const recordImage = computed(() => booking.value?.resourceImageUrl ?? booking.value?.locations.find(location => location.id === booking.value?.locationId)?.imageUrl ?? null)
// The booked terms, as the guest read them: one line, not a setting here.
const policyLine = computed(() => booking.value?.policy?.items.find(item => item.id === 'cancellation')?.text ?? null)

// The page's own draft, seeded from the record each time it is opened.
const draft = reactive({ date: '', time: '', partySize: 1, locationId: '', sessionId: '' })
// Reka's number field commits a typed value only on blur, so a click on Send
// right after typing would land on a still-disabled button. Each keystroke that
// forms a valid count is taken at once.
// Text that is not yet a valid count holds Send until the field settles it.
const guestsTypedInvalid = ref(false)
function typeGuests(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  guestsTypedInvalid.value = !(Number.isInteger(value) && value >= 1 && value <= 99)
  if (!guestsTypedInvalid.value) draft.partySize = value
}
function seed(record: DashboardBookingDetails | null) {
  if (!record) return
  draft.date = record.bookingDate
  draft.time = (record.bookingTime ?? '').slice(0, 5)
  draft.partySize = record.partySize ?? 1
  draft.locationId = record.locationId ?? ''
  draft.sessionId = record.sessionId ?? ''
}
watch(() => booking.value?.updatedAt, () => seed(booking.value), { immediate: true })

type SessionRow = { id: string; starts_at: string; timezone: string; remaining: number | null; assigned_member_id: string | null }
const isSessionList = (value: unknown): value is { sessions: SessionRow[] } => isRecord(value) && Array.isArray(value.sessions)
  && value.sessions.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.starts_at === 'string' && typeof row.timezone === 'string' && (row.remaining === null || typeof row.remaining === 'number'))
// The chosen day's sessions, read for that day alone, so the current one is always among them.
const { data: sessionData, error: sessionsError, status: sessionsStatus } = await useAsyncData(
  () => `booking-change-sessions:${booking.value?.experienceId ?? ''}:${draft.date}`,
  () => {
    const record = booking.value
    if (!record || b.bookingType === 'reservation' || !record.experienceId || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return Promise.resolve(null)
    return api<{ sessions: SessionRow[] }>(`/api/dashboard/bookings/booking/${encodeURIComponent(String(route.params.bookingId))}/sessions`, { query: { date: draft.date }, validate: isSessionList })
  },
  { watch: [() => draft.date] },
)
// One button per start time; the booked attorney's session is preferred at each.
const times = computed(() => {
  const record = booking.value
  const byStart = new Map<string, SessionRow>()
  for (const row of sessionData.value?.sessions ?? []) {
    const current = byStart.get(row.starts_at)
    if (!current || row.id === record?.sessionId || (current.id !== record?.sessionId && row.assigned_member_id === record?.assignedMemberId)) byStart.set(row.starts_at, row)
  }
  return [...byStart.values()].map(row => ({
    id: row.id,
    label: formatTimestamp(row.starts_at, 'en', row.timezone, { hour: 'numeric', minute: '2-digit' }),
    disabled: row.id !== record?.sessionId && row.remaining !== null && row.remaining < draft.partySize,
  }))
})

const dirty = computed(() => {
  const record = booking.value
  if (!record) return false
  if (draft.partySize !== (record.partySize ?? 1)) return true
  if (b.bookingType !== 'reservation') return draft.sessionId !== (record.sessionId ?? '')
  return draft.date !== record.bookingDate || draft.time !== (record.bookingTime ?? '').slice(0, 5) || draft.locationId !== record.locationId
})
const valid = computed(() => !guestsTypedInvalid.value && Number.isInteger(draft.partySize) && draft.partySize > 0 && (b.bookingType === 'reservation'
  ? Boolean(draft.date && draft.time && draft.locationId)
  // Keeping the booked session needs no list of times: a guests-only change is valid whether or not they load.
  : draft.sessionId === (booking.value?.sessionId ?? '') ? Boolean(draft.sessionId) : times.value.some(slot => slot.id === draft.sessionId && !slot.disabled)))

const saving = ref(false)
const error = ref<string | null>(null)
// One key per attempted request, so a retry of the same request is one proposal.
let attempt: { draft: string; key: string } | null = null
async function send() {
  const record = booking.value
  if (!record || !valid.value || !dirty.value || saving.value) return
  const proposal = b.bookingType === 'reservation'
    ? { kind: 'reservation' as const, bookingDate: draft.date, bookingTime: draft.time, partySize: draft.partySize, locationId: draft.locationId }
    : { kind: 'booking' as const, sessionId: draft.sessionId, partySize: draft.partySize }
  const signature = JSON.stringify(proposal)
  if (attempt?.draft !== signature) attempt = { draft: signature, key: crypto.randomUUID() }
  saving.value = true
  error.value = null
  try {
    await api(`/api/dashboard/bookings/${b.bookingType}/${encodeURIComponent(String(route.params.bookingId))}/changes`, {
      method: 'POST',
      body: { ...proposal, expectedUpdatedAt: record.updatedAt, idempotencyKey: attempt.key },
      validate: isRecord,
    })
    await b.refresh()
    await navigateTo(level.to.value ?? '/dashboard')
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Change request could not be sent')
  } finally {
    saving.value = false
  }
}
</script>
