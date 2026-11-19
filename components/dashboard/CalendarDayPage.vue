<template>
  <DashboardIndexPanel :id="personalScope ? 'account-calendar-day' : 'calendar-day'" :title="title" column="leaf">
    <template v-if="sessionProduct" #right>
      <UButton v-if="!calendarSessions?.providerHours.value && calendarSessions?.canCreate.value" label="Add availability" icon="i-lucide-plus" :to="calendarSessions.addTo(day)" />
      <UButton v-else-if="calendarSessions?.providerHours.value && sessionProduct.booking" label="Bookable times" icon="i-lucide-clock" :to="sessionProduct.booking.assigned_member_id ? `/dashboard/${route.params.org_slug}/team/${sessionProduct.booking.assigned_member_id}/hours` : `/dashboard/${route.params.org_slug}/team`" />
    </template>
    <div class="space-y-6">
      <UAlert v-if="errorMessage" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="errorMessage" />
      <p v-if="calendarSessions?.creationUnavailable.value" data-testid="calendar-availability-state" class="text-sm text-muted">
        {{ calendarSessions.creationUnavailable.value.message }}
        <NuxtLink :to="calendarSessions.creationUnavailable.value.to" class="font-medium text-highlighted underline">{{ calendarSessions.creationUnavailable.value.label }}</NuxtLink>
      </p>
      <!--
        Airbnb's day sheet leads with the date's state and why, and the one
        action that flips it. A closure is the tenant's whole day, written to
        the location's special hours — the same thing its hours leaf edits.
      -->
      <UCard v-if="!sessionProduct && location" variant="subtle">
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
          :to="{ path: `/dashboard/${route.params.org_slug}/calendar/settings/availability/hours`, query: route.query }"
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
      </UCard>
      <p v-else-if="!sessionProduct && !personalScope" class="text-sm text-muted">Choose a location to manage this day's availability.</p>

      <p v-if="status === 'loading'" role="status" class="text-sm text-muted">Loading scheduled times…</p>

      <div v-if="items.length" class="divide-y divide-default border-y border-default">
        <AgendaRow v-for="item in items" :key="item.id" :item="item" />
      </div>
      <div v-else-if="!errorMessage && status === 'ready'" class="py-6 text-center">
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
import { closureOnDate, datedHours, getDateIntervals, parseOpeningHours, parseSpecialHours, type SpecialHours } from '~/shared/reservation-hours'
import { addLocalDays, formatCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { calendarDayKey, calendarSessionsKey } from './CalendarPage.vue'

// The business's day can be blocked or opened; the account's day only lists its visits.
const props = defineProps<{ personalScope?: boolean }>()

const route = useRoute()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const calendarSessions = inject(calendarSessionsKey, null)
const { organization } = useDashboardOrganization()
const sessionProduct = computed(() => calendarSessions?.product.value)
const day = computed(() => String(route.params.day ?? ''))
const title = computed(() => formatCalendarDate(day.value, 'en', { weekday: 'long', month: 'long', day: 'numeric' }))

const isPlaceDates = (value: unknown): value is { place: { id: string } } =>
  isRecord(value) && isRecord(value.place) && typeof value.place.id === 'string' && Array.isArray(value.days)
const calendar = inject(calendarDayKey)!
const location = computed(() => calendar.location.value ?? null)
const agenda = computed(() => calendar.read(day.value))
const items = computed(() => agenda.value.items)
const status = computed(() => agenda.value.status)
const saveError = ref<unknown>(null)
const errorMessage = computed(() => {
  const cause = saveError.value ?? agenda.value.error
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
  const party = getVerticalCopy(organization.value?.vertical).guestsLabelPlural
  return { open: true, reason: `${party.charAt(0).toUpperCase()}${party.slice(1)} can book this date.`, action: 'block' }
})

const saving = ref(false)

async function toggleClosure(): Promise<void> {
  const record = location.value
  if (!record || !availability.value.action || availability.value.action === 'hours') return
  saving.value = true
  saveError.value = null
  try {
    // The one dates write every calendar uses: the place's closures, read back.
    await dashboardApi(`/api/dashboard/places/location/${record.id}/dates`, {
      method: 'PUT',
      body: { from: day.value, to: addLocalDays(day.value, 1), closed: availability.value.action === 'block', updated_at: record.updated_at },
      validate: isPlaceDates,
    })
    await calendar.refreshLocation()
  } catch (cause) {
    saveError.value = cause
    await calendar.refreshLocation()
  } finally {
    saving.value = false
  }
}
</script>
