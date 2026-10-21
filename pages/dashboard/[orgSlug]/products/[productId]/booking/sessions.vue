<template>
  <DashboardIndexPanel id="product-sessions" title="Availability">
    <template #right>
      <UButton v-if="route.query.location_id !== 'online'" icon="i-lucide-plus" label="Add availability" :to="canCreate ? to('new') : undefined" :disabled="!canCreate" />
      <UButton v-else-if="p.product.value?.booking" icon="i-lucide-clock" label="Bookable times" :to="p.product.value.booking.assigned_member_id ? `/dashboard/${route.params.orgSlug}/team/${p.product.value.booking.assigned_member_id}/hours` : `/dashboard/${route.params.orgSlug}/team`" />
    </template>
    <UAlert v-if="error || p.loadError.value || p.organizationLocationsError.value" class="mb-6" color="error" :description="p.loadError.value || p.organizationLocationsError.value || getErrorMessage(error, 'Availability could not be loaded')" />
    <template v-if="!p.loadError.value && !p.organizationLocationsError.value">
      <EditorNavigationList v-if="!p.locationId.value && route.query.location_id !== 'online' && scopeGroups[0]?.items.length" class="mb-8" :groups="scopeGroups" />
      <UEmpty v-else-if="!p.locationId.value && route.query.location_id !== 'online'" class="mb-8" title="No physical locations" description="Add this offering to a location before adding availability." :actions="[{ label: 'Locations', to: p.sectionPath('locations'), color: 'neutral' }]" />
      <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <UButton v-if="p.locationId.value" :to="chooseLocationPath" :label="p.location.value?.title" trailing-icon="i-lucide-chevron-down" color="neutral" variant="outline" />
          <span class="text-sm text-muted">{{ p.location.value?.timezone ?? (route.query.location_id === 'online' ? 'Online · Times use the saved session’s timezone' : 'All locations · Times use each location’s timezone') }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton v-if="p.locationId.value" :to="p.sectionPath('booking/schedule')" label="Repeating times" color="neutral" variant="outline" />
          <UButton label="Today" color="neutral" variant="outline" :disabled="Boolean(level.child.value)" @click="goToToday" />
          <UButton v-if="selected" label="Show month" color="neutral" variant="ghost" :disabled="Boolean(level.child.value)" @click="showMonth" />
        </div>
      </div>
      <UCalendar :model-value="selected" :range="false" :multiple="false" :placeholder="placeholder" :year-controls="false" :view-control="false" :week-starts-on="0" weekday-format="short" color="neutral" prevent-deselect :disabled="pending || Boolean(level.child.value)" :ui="calendarUi" class="w-full" @update:placeholder="changeMonth" @update:model-value="chooseDay">
        <template #heading="{ value }"><span class="block text-left text-xl font-semibold text-highlighted">{{ value }}</span></template>
        <template #day="{ day }">
          <span class="flex size-full min-w-0 flex-col items-start gap-1 overflow-hidden p-1 sm:p-2" :data-testid="`availability-day-${day.toString()}`">
            <span class="text-sm">{{ day.day }}</span>
            <span v-if="sessionsOn(day.toString()).length" class="size-1.5 rounded-full bg-current sm:hidden" />
            <span v-for="session in sessionsOn(day.toString()).slice(0, 2)" :key="session.id" class="hidden w-full truncate text-left text-xs sm:block" :class="session.status === 'cancelled' ? 'line-through opacity-60' : undefined">{{ sessionTime(session) }}</span>
            <span v-if="sessionsOn(day.toString()).length > 2" class="hidden text-xs sm:block">+{{ sessionsOn(day.toString()).length - 2 }} more</span>
          </span>
        </template>
      </UCalendar>
      <p v-if="pending" role="status" class="mt-6 text-muted">Loading availability…</p>
      <template v-else-if="!error">
        <h2 class="mb-2 mt-8 text-lg font-semibold text-highlighted">{{ selected ? selected.toDate('UTC').toLocaleDateString('en', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }) : 'Scheduled times' }}</h2>
        <EditorNavigationList v-if="groups[0]?.items.length" :groups="groups" :active-item="level.child.value" />
        <p v-else class="text-muted">{{ selected ? 'No times scheduled for this date.' : 'No times scheduled this month.' }}</p>
      </template>
    </template>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { InjectionKey } from 'vue'

/** The mounted calendar owns the occurrence readback before its editor closes. */
export const productSessionsKey = Symbol('product-sessions') as InjectionKey<{ refresh: (date: string) => Promise<void> }>
</script>

<script setup lang="ts">
import { CalendarDate, getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import type { SessionAvailability } from '~/server/utils/availability'
import { isSessionsResponse } from '~/utils/session-contract'
import { localNow } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard', dashboardFrame: true })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
function readDate(value: unknown, month = false): CalendarDate | undefined {
  if (value === undefined) return undefined
  try {
    if (typeof value !== 'string' || !(month ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)) throw new Error('Invalid calendar date')
    return parseDate(month ? `${value}-01` : value)
  } catch { throw createError({ statusCode: 400, statusMessage: 'Choose a valid availability date.', fatal: true }) }
}
const currentDay = () => today(p.location.value?.timezone ?? getLocalTimeZone())
const initialMonth = readDate(route.query.month, true)
const selected = shallowRef<DateValue | undefined>(readDate(route.query.date))
const placeholder = shallowRef<DateValue>(selected.value ?? initialMonth ?? currentDay())
watch(() => [route.query.date, route.query.month], () => {
  const month = readDate(route.query.month, true)
  selected.value = readDate(route.query.date)
  placeholder.value = selected.value ?? month ?? currentDay()
})
const month = computed(() => new CalendarDate(placeholder.value.year, placeholder.value.month, 1))
const range = computed(() => {
  // Session timezones are saved facts and can differ from a Location's current zone.
  // Pad the UTC month, then group/filter in each session's own saved timezone.
  return { from: month.value.subtract({ days: 1 }).toDate('UTC').toISOString(), to: month.value.add({ months: 1, days: 1 }).toDate('UTC').toISOString() }
})
const { data, error, pending, refresh } = await useAsyncData(
  () => `product-sessions:${p.organizationId}:${route.params.productId}:${route.query.location_id === 'online' ? 'online' : p.locationId.value ?? 'all'}:${range.value.from}:${range.value.to}`,
  async () => p.product.value?.booking
    ? dashboardApi(`/api/editor/organizations/${p.organizationId}/products/${route.params.productId}/sessions`, { query: range.value, validate: isSessionsResponse })
    : null,
)
provide(productSessionsKey, { refresh: async (date) => {
  selected.value = parseDate(date)
  placeholder.value = selected.value
  await nextTick()
  await refresh()
  if (error.value) throw error.value
} })
const to = (id: string, date = selected.value?.toString()) => router.resolve({ path: `${level.path.value}/${id}`, query: { ...route.query, date } }).fullPath
const chooseLocationPath = computed(() => router.resolve({ path: level.path.value, query: { ...route.query, location_id: undefined, date: selected.value?.toString() } }).fullPath)
const canCreate = computed(() => Boolean(p.product.value?.booking && p.location.value?.status === 'active' && !p.loadError.value && !p.organizationLocationsError.value && !error.value))
const scopeGroups = computed<EditorNavigationGroup[]>(() => [{ id: 'locations', items: (p.product.value?.locations ?? []).map(placement => {
  const location = p.allOrganizationLocations.value.find(entry => entry.id === placement.location_id)
  if (!location) throw new Error('A saved offering location could not be loaded')
  return {
    id: location.id, label: location.title, icon: 'i-lucide-map-pin',
    summary: [location.status === 'active' ? 'Choose to add availability here' : 'Location inactive', placement.published ? 'Visible at this location' : 'Hidden at this location', placement.active ? 'Accepting bookings' : 'Bookings paused'].join(' · '),
    ...(location.status === 'active' ? { to: router.resolve({ path: level.path.value, query: { ...route.query, location_id: location.id } }).fullPath } : {}),
  }
}) }])
const sessionDate = (session: SessionAvailability) => localNow(session.timezone, new Date(session.starts_at)).date
const sessionTime = (session: SessionAvailability) => new Intl.DateTimeFormat('en', { timeZone: session.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(session.starts_at))
const visibleSessions = computed(() => (data.value?.sessions ?? []).filter(session => {
  const date = sessionDate(session)
  return (route.query.location_id === 'online' ? session.location_id === null : !p.locationId.value || session.location_id === p.locationId.value)
    && date >= month.value.toString() && date < month.value.add({ months: 1 }).toString()
}))
const sessionsByDate = computed(() => {
  const days = new Map<string, SessionAvailability[]>()
  for (const session of visibleSessions.value) {
    const date = sessionDate(session)
    const existing = days.get(date)
    if (existing) existing.push(session)
    else days.set(date, [session])
  }
  return days
})
const sessionsOn = (date: string) => sessionsByDate.value.get(date) ?? []
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'sessions', items: visibleSessions.value.filter(session => !selected.value || sessionDate(session) === selected.value.toString()).map(session => ({
  id: session.id,
  label: new Intl.DateTimeFormat('en', { timeZone: session.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.starts_at)),
  summary: `${session.location_id ? p.allOrganizationLocations.value.find(location => location.id === session.location_id)?.title ?? session.location_id : 'Online'} · ${session.status === 'cancelled' ? 'Cancelled' : `${session.claimed} places reserved`}${session.capacity === null ? '' : ` · ${session.capacity} places`} · ${session.timezone}`,
  to: router.resolve({ path: `${level.path.value}/${session.id}`, query: { ...route.query, month: undefined, date: sessionDate(session), location_id: session.location_id ?? (p.product.value?.kind === 'experience' ? 'online' : undefined) } }).fullPath,
})) }])
function changeMonth(date: DateValue) {
  if (date.year === placeholder.value.year && date.month === placeholder.value.month) return
  selected.value = undefined
  placeholder.value = date
  return showMonth()
}
function chooseDay(date: DateValue | undefined) {
  if (!date) return
  selected.value = date
  placeholder.value = date
  return navigateTo({ path: level.path.value, query: { ...route.query, month: undefined, date: date.toString() } }, { replace: true })
}
function goToToday() { return chooseDay(currentDay()) }
function showMonth() {
  selected.value = undefined
  return navigateTo({ path: level.path.value, query: { ...route.query, date: undefined, month: month.value.toString().slice(0, 7) } }, { replace: true })
}
const calendarUi = {
  gridRow: 'grid-cols-7 place-items-stretch',
  cell: 'min-w-0 border border-default',
  cellTrigger: 'm-0 h-12 w-full rounded-none justify-start sm:h-24 data-outside-view:opacity-35 data-selected:bg-inverted data-selected:text-inverted',
  heading: 'text-left',
}
</script>
