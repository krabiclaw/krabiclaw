<template>
  <!--
    A day is a level with children: the bookings on it open as leaves of the
    day, so Back from one is the day and the Calendar tab stays lit.
  -->
  <DashboardIndexPanel :id="personalScope ? 'account-calendar-day' : 'calendar-day'" :title="title" column>
    <div class="space-y-6">
      <UAlert v-if="errorMessage" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
      <!--
        Airbnb's day sheet leads with the date's state and why, and the one
        action that flips it. A closure is the tenant's whole day, written to
        the location's special hours — the same thing its hours leaf edits.
      -->
      <div v-if="location" class="rounded-xl bg-elevated/70 p-5">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm text-muted">{{ availability.open ? 'Available' : 'Unavailable' }}</p>
          <span v-if="!availability.open" class="size-2 rounded-full bg-primary" aria-hidden="true" />
        </div>
        <p class="mt-2 text-lg font-medium text-highlighted">{{ availability.reason }}</p>
        <UButton
          v-if="availability.action === 'hours'"
          class="mt-5 w-full justify-center"
          color="neutral"
          variant="soft"
          size="lg"
          label="Edit hours"
          :to="{ path: `/dashboard/${route.params.orgSlug}/calendar/settings/hours`, query: route.query }"
        />
        <UButton
          v-else-if="availability.action"
          class="mt-5 w-full justify-center"
          color="neutral"
          variant="soft"
          size="lg"
          :label="availability.action === 'open' ? 'Open date' : 'Block date'"
          :loading="saving"
          @click="toggleClosure"
        />
      </div>
      <p v-else-if="!personalScope" class="text-sm text-muted">Choose a location to manage this day's availability.</p>

      <div v-if="items.length" class="divide-y divide-default border-y border-default">
        <AgendaRow v-for="item in items" :key="item.id" :item="item" :to="openHere(item)" />
      </div>
      <div v-else-if="!errorMessage && status === 'success'" class="py-6 text-center">
        <img
          src="https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/e10ff26b-ab52-4f93-8f48-36e23828aa00/w=224"
          alt=""
          aria-hidden="true"
          width="112"
          height="112"
          class="mx-auto size-28 object-contain"
        >
        <p class="mt-4 text-sm text-muted">Nothing scheduled.</p>
      </div>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { closeDates, closureOnDate, datedHours, getDateIntervals, openDates, parseOpeningHours, parseSpecialHours, type SpecialHours } from '~/shared/reservation-hours'
import { formatCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import type { AgendaItem, AgendaPayload } from '~/server/utils/dashboard-agenda'
import { calendarLocationKey } from './CalendarPage.vue'

// The business's day can be blocked or opened; the account's day only lists its visits.
const props = defineProps<{ personalScope?: boolean }>()

const route = useRoute()
const level = useRouteLevel()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const apiBase = props.personalScope ? '/api/account' : '/api/dashboard'
const organizationId = props.personalScope ? null : await useDashboardOrganizationId()
const day = computed(() => String(route.params.day ?? ''))
const locationId = computed(() => typeof route.query.locationId === 'string' ? route.query.locationId : null)
const title = computed(() => formatCalendarDate(day.value, 'en', { weekday: 'long', month: 'long', day: 'numeric' }))

const isAgendaItem = (value: unknown): value is AgendaItem =>
  isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string'
  && typeof value.startsAt === 'string' && typeof value.dayKey === 'string'
  && typeof value.timeZone === 'string' && typeof value.title === 'string'
  && typeof value.status === 'string' && typeof value.to === 'string'
const isAgendaPayload = (value: unknown): value is AgendaPayload =>
  isRecord(value) && Array.isArray(value.items) && value.items.every(isAgendaItem)
const isLocationResponse = (value: unknown): value is { location: { id: string } } =>
  isRecord(value) && isRecord(value.location) && typeof value.location.id === 'string'
// The index owns the location; this leaf reads it and asks for it again after a write.
const calendarLocation = inject(calendarLocationKey)!
const location = computed(() => calendarLocation.location.value ?? null)
const refreshLocation = calendarLocation.refresh

const { data, error, status } = await useAsyncData(
  () => `calendar-day:${organizationId}:${day.value}:${locationId.value ?? ''}:${String(route.query.kinds ?? '')}`,
  async () => {
    const agenda = await dashboardApi<AgendaPayload>(`${apiBase}/agenda`, {
      query: { from: day.value, to: day.value, locationId: locationId.value ?? undefined, kinds: typeof route.query.kinds === 'string' ? route.query.kinds : undefined },
      validate: isAgendaPayload,
    })
    return { items: agenda.items }
  },
)

// A booking opens as a leaf of this day; a post keeps its own screen. The
// item id is `kind:record`, which is how the agenda names a row.
function openHere(item: AgendaItem): string | undefined {
  if (item.kind === 'post' || props.personalScope) return undefined
  return `${level.path.value}/${item.kind}/${encodeURIComponent(item.id.slice(item.kind.length + 1))}`
}
const items = computed(() => data.value?.items ?? [])
const saveError = ref<unknown>(null)
const errorMessage = computed(() => {
  const cause = saveError.value ?? error.value
  return cause ? getErrorMessage(cause, 'The day could not be loaded') : ''
})

const specialHours = computed<SpecialHours>(() => location.value ? parseSpecialHours(location.value.special_hours) : null)

// Unavailable says why, the way Airbnb's sheet does: the reason is the
// tenant's own closure and its note, an inactive location, or a weekday the
// hours never open. A closure is undone here; a weekday is the hours' to
// change, so the sheet leads there rather than ending.
const availability = computed<{ open: boolean; reason: string; action: 'open' | 'block' | 'hours' | null }>(() => {
  const record = location.value
  if (!record) return { open: false, reason: '', action: null }
  if (record.status !== 'active') return { open: false, reason: 'This location is not active.', action: null }
  const closure = closureOnDate(specialHours.value, day.value)
  if (closure) return { open: false, reason: closure.note || 'You blocked this date.', action: 'open' }
  const dated = datedHours(specialHours.value, day.value)
  if (dated?.kind === 'hours' && dated.periods.length === 0) return { open: false, reason: dated.note || 'You closed this date.', action: 'open' }
  const intervals = getDateIntervals(parseOpeningHours(record.opening_hours), specialHours.value, day.value)
  if (intervals !== null && intervals.length === 0) {
    return { open: false, reason: `Closed on ${formatCalendarDate(day.value, 'en', { weekday: 'long' })}s in your hours.`, action: 'hours' }
  }
  return { open: true, reason: 'Guests can book this date.', action: 'block' }
})

const saving = ref(false)

async function toggleClosure(): Promise<void> {
  const record = location.value
  if (!record || !availability.value.action || availability.value.action === 'hours') return
  const next: SpecialHours = availability.value.action === 'block'
    ? closeDates(specialHours.value, day.value, day.value)
    : openDates(specialHours.value, day.value, day.value)
  saving.value = true
  saveError.value = null
  try {
    await dashboardApi(`/api/organizations/${organizationId}/locations/${record.id}`, {
      method: 'PATCH',
      body: { special_hours: next, expected_updated_at: record.updated_at },
      validate: isLocationResponse,
    })
    await refreshLocation()
  } catch (cause) {
    saveError.value = cause
    await refreshLocation()
  } finally {
    saving.value = false
  }
}
</script>
