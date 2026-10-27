<template>
  <!-- One field of the staged request. Done keeps the edit in the draft; nothing is sent from here. -->
  <DashboardLeafPanel v-if="field" id="booking-change-field" :title="`Change ${field === 'session' ? 'date and time' : field === 'guests' ? copy?.guestsLabelPlural : field}`" :lead="`Nothing is sent yet. Your ${copy?.guestLabel} sees every change at once when you send the request.`" save-label="Done" @cancel="b.cancelChangeField(field)" @save="navigateTo(level.to.value ?? '/dashboard')">
    <div v-if="b.booking.value">
      <UFormField v-if="field === 'date'" label="Date">
        <UInput v-model="b.changeDraft.value.bookingDate" type="date" autofocus class="w-full" />
      </UFormField>
      <UFormField v-else-if="field === 'time'" label="Time">
        <UInput v-model="b.changeDraft.value.bookingTime" type="time" autofocus class="w-full" />
      </UFormField>
      <UFormField v-else-if="field === 'guests'" :label="b.changeFields.value.find(item => item.key === field)?.label">
        <UInputNumber v-model="b.changeDraft.value.partySize" :min="1" :max="99" class="w-full" />
      </UFormField>
      <UFormField v-else-if="field === 'location'" label="Location">
        <USelect v-model="b.changeDraft.value.locationId" :items="b.booking.value.locations.map(location => ({ label: location.title, value: location.id }))" class="w-full" />
      </UFormField>
      <!-- A consultation moves to another open time of its service; the list is the service's own sessions with a place left. -->
      <UFormField v-else-if="field === 'session'" label="Date and time" :hint="`${sessionItems.length} open times`">
        <USelect v-model="b.changeDraft.value.sessionId" :items="sessionItems" class="w-full" @update:model-value="rememberSessionLabel" />
      </UFormField>
      <UAlert v-if="sessionsError" class="mt-4" color="error" variant="soft" :description="getErrorMessage(sessionsError, 'Open times could not be loaded')" />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey, type BookingChangeField } from '~/components/dashboard/BookingDetails.vue'
import { formatTimestamp } from '~/utils/timezone'
import { getVerticalCopy } from '~/utils/vertical-copy'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const api = useDashboardApi()
const b = inject(bookingEditorKey)!
const copy = computed(() => b.booking.value ? getVerticalCopy(b.booking.value.vertical) : null)
const value = String(route.params.field ?? '')
const field = (['date', 'time', 'guests', 'location', 'session'].includes(value) ? value : null) as BookingChangeField | null
// Raised, not thrown: the dashboard renders on the client, where a throw in a nested page's setup leaves a blank screen (DESIGN.md).
if (!field) showError(createError({ statusCode: 404, statusMessage: 'Editor not found' }))
else b.beginChangeField(field)

type SessionRow = { id: string; starts_at: string; ends_at: string; timezone: string; remaining: number | null; status: string }
const isSessionList = (value: unknown): value is { sessions: SessionRow[] } => isRecord(value) && Array.isArray(value.sessions)
  && value.sessions.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.starts_at === 'string' && typeof row.timezone === 'string' && (row.remaining === null || typeof row.remaining === 'number'))
const { data: sessionData, error: sessionsError } = await useAsyncData(
  () => `booking-change-sessions:${b.booking.value?.experienceId ?? ''}`,
  () => field === 'session' && b.booking.value?.experienceId && b.booking.value.organizationId
    ? api<{ sessions: SessionRow[] }>(`/api/editor/organizations/${b.booking.value.organizationId}/products/${b.booking.value.experienceId}/sessions`, { query: { status: 'scheduled' }, validate: isSessionList })
    : Promise.resolve(null),
)
const sessionItems = computed(() => (sessionData.value?.sessions ?? [])
  .filter(row => row.id === b.booking.value?.sessionId || row.remaining === null || row.remaining > 0)
  .map(row => ({ value: row.id, label: `${formatTimestamp(row.starts_at, 'en', row.timezone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${row.id === b.booking.value?.sessionId ? ' · Current' : ''}` })))
function rememberSessionLabel(id: unknown) {
  const item = sessionItems.value.find(row => row.value === id)
  b.changeDraft.value.sessionLabel = item && id !== b.booking.value?.sessionId ? item.label : ''
}
</script>
