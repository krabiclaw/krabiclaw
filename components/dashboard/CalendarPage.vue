<template>
  <!--
    The calendar, built on Tailwind Plus's Month and Year views. One month (or
    year) at a time with ‹ Today › controls, as Airbnb's host calendar pages;
    the month draws the guests in each cell at desktop width and dots on a
    phone. A day is a level of its own below this one, for both readers.
  -->
  <DashboardIndexPanel
    :id="personalScope ? 'account-calendar' : 'org-calendar'"
    title="Calendar"
    column="wide"
  >
    <template #right>
      <div class="flex items-center gap-1">
        <UButton
          v-if="!personalScope && chosenLocation && !selecting && view === 'month'"
          label="Select dates"
          color="neutral"
          variant="outline"
          class="mr-1"
          @click="startSelecting"
        />
        <AgendaFilters v-if="!personalScope" :kinds="availableKinds" :organization-id="organizationId" />
        <!-- List, Month, Year behind one icon, as Airbnb's view menu. -->
        <UDropdownMenu :items="viewItems" :content="{ align: 'end' }" :ui="{ content: 'w-44' }">
          <UButton :icon="VIEWS[view].icon" color="neutral" variant="soft" square :aria-label="`View: ${VIEWS[view].label}`" />
        </UDropdownMenu>
        <!-- The gear opens this location's reservation settings, as Airbnb's opens the listing's. -->
        <UButton
          v-if="!personalScope && chosenLocation"
          icon="i-lucide-settings"
          color="neutral"
          variant="soft"
          square
          aria-label="Settings"
          :to="{ path: `${level.path.value}/settings`, query: route.query }"
        />
      </div>
    </template>

    <div>
      <!-- Which location the calendar is, the same pill Catalog narrows by. An account has no branch to choose. -->
      <div v-if="!personalScope" class="mb-8 flex">
        <DashboardLocationFilter v-model="filters.locationId" :items="locationItems" />
      </div>
      <UAlert
        v-if="locationError"
        class="mb-6"
        color="error"
        variant="soft"
        title="The location could not be loaded"
        :description="getErrorMessage(locationError, 'Location request failed')"
      />

      <!-- Where in time: the period's name and the three controls Tailwind's header carries. -->
      <header class="flex items-center justify-between py-2">
        <h2 class="text-base font-semibold text-highlighted">
          <time :datetime="view === 'year' ? String(shownYear) : monthKey">{{ periodLabel }}</time>
        </h2>
        <div class="flex items-center rounded-md ring ring-default">
          <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" square :aria-label="view === 'year' ? 'Previous year' : 'Previous month'" @click="step(-1)" />
          <UButton label="Today" color="neutral" variant="ghost" class="hidden md:block" @click="goToToday" />
          <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" square :aria-label="view === 'year' ? 'Next year' : 'Next month'" @click="step(1)" />
        </div>
      </header>

      <template v-if="view !== 'year'">
        <USkeleton v-if="month.status === 'loading'" class="h-96 w-full" />
        <UAlert
          v-else-if="month.status === 'error'"
          color="error"
          variant="soft"
          :title="`${periodLabel} could not be loaded`"
          :description="getErrorMessage(month.cause, 'Calendar request failed')"
          :actions="[{ label: 'Try again', color: 'neutral', variant: 'soft', onClick: () => loadMonth(monthKey) }]"
        />

        <!-- Month: Tailwind's grid. Each cell is the day; at desktop width it lists who is coming, on a phone it shows dots. -->
        <div v-else-if="view === 'month'" class="overflow-hidden rounded-xl shadow-sm ring ring-default lg:flex lg:flex-auto lg:flex-col">
          <div class="grid grid-cols-7 gap-px border-b border-default bg-border text-center text-xs/6 font-semibold text-muted">
            <div v-for="label in WEEKDAYS" :key="label.long" class="flex justify-center bg-default py-2">
              <span>{{ label.short }}</span>
              <span class="sr-only sm:not-sr-only">{{ label.rest }}</span>
            </div>
          </div>
          <div class="flex bg-border text-xs/6 text-muted">
            <div class="hidden w-full lg:grid lg:grid-cols-7 lg:grid-rows-6 lg:gap-px">
              <div
                v-for="day in days"
                :key="day.key"
                class="group relative min-h-28 px-3 py-2"
                :class="[day.inMonth ? 'bg-default text-highlighted' : 'bg-elevated/60 text-muted', isUnavailableKey(day.key) ? 'bg-elevated/40' : '', inSelection(day.key) ? 'bg-primary/15' : '', isSelectionEdge(day.key) ? 'ring-2 ring-inset ring-primary' : '', day.key === openDay ? 'ring-2 ring-inset ring-primary' : '']"
                :data-day="day.key"
              >
                <component
                  :is="selecting ? 'button' : NuxtLink"
                  :type="selecting ? 'button' : undefined"
                  :to="selecting ? undefined : dayTo(day.key)"
                  class="flex size-7 items-center justify-center rounded-full text-sm font-medium hover:bg-elevated"
                  :class="[day.key === todayKey ? 'bg-primary font-semibold text-inverted hover:bg-primary' : '', isUnavailableKey(day.key) ? 'text-muted line-through' : '']"
                  :aria-label="formatCalendarDate(day.key, 'en', { weekday: 'long', month: 'long', day: 'numeric' })"
                  @click="selecting ? extendSelection(day.key) : undefined"
                >{{ day.number }}</component>
                <ol v-if="itemsOn(day.key).length" class="mt-2 space-y-0.5">
                  <li v-for="item in itemsOn(day.key).slice(0, 2)" :key="item.id">
                    <NuxtLink :to="item.to" class="group/item flex" :class="item.status === 'cancelled' ? 'text-muted line-through' : ''">
                      <p class="flex-auto truncate font-medium" :class="item.status === 'cancelled' ? '' : 'text-highlighted group-hover/item:text-primary'">{{ item.title }}</p>
                      <time :datetime="item.startsAt" class="ml-3 hidden flex-none text-muted xl:block">{{ timeOf(item) }}</time>
                    </NuxtLink>
                  </li>
                  <li v-if="itemsOn(day.key).length > 2" class="text-muted">
                    <NuxtLink :to="dayTo(day.key)">+ {{ itemsOn(day.key).length - 2 }} more</NuxtLink>
                  </li>
                </ol>
              </div>
            </div>
            <div class="isolate grid w-full grid-cols-7 grid-rows-6 gap-px lg:hidden">
              <button
                v-for="day in days"
                :key="day.key"
                type="button"
                class="group relative flex h-14 flex-col px-3 py-2 focus:z-10"
                :class="[day.inMonth ? 'bg-default text-highlighted hover:bg-elevated' : 'bg-elevated/60 text-muted', inSelection(day.key) ? 'bg-primary/15' : '', isSelectionEdge(day.key) ? 'ring-2 ring-inset ring-primary' : '', day.key === openDay ? 'ring-2 ring-inset ring-primary' : '']"
                :data-day="day.key"
                :aria-label="formatCalendarDate(day.key, 'en', { weekday: 'long', month: 'long', day: 'numeric' })"
                @click="selecting ? extendSelection(day.key) : openDayAt(day.key)"
              >
                <time
                  :datetime="day.key"
                  class="ml-auto flex size-6 items-center justify-center rounded-full"
                  :class="[day.key === todayKey ? 'bg-primary font-semibold text-inverted' : '', isUnavailableKey(day.key) ? 'line-through' : '']"
                >{{ day.number }}</time>
                <span class="sr-only">{{ countFor(day.key) }} bookings</span>
                <span v-if="itemsOn(day.key).length" class="-mx-0.5 mt-auto flex flex-wrap-reverse">
                  <span v-for="item in itemsOn(day.key)" :key="item.id" class="mx-0.5 mb-1 size-1.5 rounded-full" :class="item.status === 'cancelled' ? 'bg-dimmed' : 'bg-primary'" />
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- List: the days of the month that have something, Airbnb's agenda, with the rows the day leaf draws. -->
        <p v-else-if="!scheduledDays.length" class="py-10 text-center text-sm text-muted">Nothing scheduled in {{ periodLabel }}.</p>
        <div v-else class="divide-y divide-default border-y border-default">
          <div v-for="dayKey in scheduledDays" :key="dayKey" class="grid grid-cols-[3.5rem_1fr] gap-3 py-3" :data-day="dayKey">
            <NuxtLink :to="dayTo(dayKey)" class="pt-1 text-center">
              <span
                class="mx-auto flex size-7 items-center justify-center rounded-full text-sm font-medium"
                :class="dayKey === todayKey ? 'bg-primary font-semibold text-inverted' : isUnavailableKey(dayKey) ? 'text-muted line-through' : 'text-highlighted'"
              >{{ Number(dayKey.slice(-2)) }}</span>
              <span class="block text-xs text-muted">{{ formatCalendarDate(dayKey, 'en', { weekday: 'short' }) }}</span>
            </NuxtLink>
            <div class="min-w-0">
              <AgendaRow v-for="item in itemsOn(dayKey)" :key="item.id" :item="item" :to="personalScope ? undefined : `${level.path.value}/${dayKey}/${item.kind}/${encodeURIComponent(item.stayId ?? item.id.slice(item.kind.length + 1))}`" />
            </div>
          </div>
        </div>
      </template>

      <!-- Year: Tailwind's twelve small months; a dot where the day has something. -->
      <div v-else class="grid grid-cols-1 gap-x-8 gap-y-12 py-4 sm:grid-cols-2 xl:grid-cols-3">
        <section v-for="block in yearMonths" :key="block.key" class="text-center" :data-month="block.key">
          <button type="button" class="text-sm font-semibold text-highlighted hover:text-primary" @click="openMonth(block.key)">{{ block.label }}</button>
          <USkeleton v-if="block.status === 'loading'" class="mt-6 h-40 w-full" />
          <UAlert
            v-else-if="block.status === 'error'"
            class="mt-6"
            color="error"
            variant="soft"
            :description="getErrorMessage(block.cause, 'Calendar request failed')"
            :actions="[{ label: 'Try again', color: 'neutral', variant: 'soft', onClick: () => loadMonth(block.key) }]"
          />
          <template v-else>
            <div class="mt-6 grid grid-cols-7 text-xs/6 text-muted">
              <div v-for="label in WEEKDAYS" :key="label.long">{{ label.short }}</div>
            </div>
            <div class="isolate mt-2 grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-border text-sm shadow-sm ring ring-default">
              <button
                v-for="day in block.days"
                :key="day.key"
                type="button"
                class="relative py-1.5 hover:bg-elevated focus:z-10"
                :class="day.inMonth ? 'bg-default text-highlighted' : 'bg-elevated/60 text-muted'"
                :data-day="day.key"
                :aria-label="formatCalendarDate(day.key, 'en', { weekday: 'long', month: 'long', day: 'numeric' })"
                @click="openDayAt(day.key)"
              >
                <time
                  :datetime="day.key"
                  class="mx-auto flex size-7 items-center justify-center rounded-full"
                  :class="[day.key === todayKey ? 'bg-primary font-semibold text-inverted' : '', isUnavailableKey(day.key) ? 'line-through' : '']"
                >{{ day.number }}</time>
                <span class="mx-auto mt-0.5 block size-1 rounded-full" :class="countFor(day.key) ? 'bg-primary' : 'bg-transparent'" />
              </button>
            </div>
          </template>
        </section>
      </div>
    </div>

    <template v-if="selecting" #footer>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-highlighted">{{ selectionLabel }}</p>
          <p class="text-xs text-muted">{{ selectionHint }}</p>
        </div>
        <div class="flex items-center gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="stopSelecting" />
          <UButton :label="selectionRange ? `Open ${selectionCountLabel}` : 'Open'" color="neutral" variant="soft" :disabled="!selectionRange" :loading="writing === 'open'" @click="writeSelection('open')" />
          <UButton :label="selectionRange ? `Block ${selectionCountLabel}` : 'Block'" :disabled="!selectionRange" :loading="writing === 'block'" @click="writeSelection('block')" />
        </div>
      </div>
    </template>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { InjectionKey, Ref } from 'vue'

/** The location the calendar is showing, owned by this level and read by the day leaf below it. */
export interface CalendarLocation {
  id: string
  status: string
  updated_at: string
  opening_hours: unknown
  special_hours: unknown
}
export const calendarLocationKey = Symbol('calendar-location') as InjectionKey<{
  location: Ref<CalendarLocation | null | undefined>
  refresh: () => Promise<void>
}>
</script>

<script setup lang="ts">
import { NuxtLink } from '#components'
import { CalendarDate, getDayOfWeek, getLocalTimeZone, parseDate, today } from '@internationalized/date'
import AgendaRow from '~/lib/components/workspace/dashboard/AgendaRow.vue'
import AgendaFilters from './AgendaFilters.vue'
import { closeDates, closureOnDate, getDateIntervals, openDates, parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
import { formatCalendarDate, formatTimestamp } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import type { AgendaItem, AgendaKind, AgendaLocation, AgendaPayload } from '~/server/utils/dashboard-agenda'

useSeoMeta({ title: 'Calendar | KrabiClaw', robots: 'noindex, nofollow' })

// One calendar for both readers. Personal scope reads the account agenda,
// has no branch to filter, block or configure, and opens a day the same way.
const props = defineProps<{ personalScope?: boolean }>()

// Named here rather than imported: the agenda module is the server's, and a value import would bundle it.
const AGENDA_KINDS = ['reservation', 'booking', 'post', 'stay'] as const satisfies readonly AgendaKind[]
// Weeks start on Sunday, as Airbnb's do.
const WEEKDAYS = [
  { short: 'S', rest: 'un', long: 'Sunday' }, { short: 'M', rest: 'on', long: 'Monday' }, { short: 'T', rest: 'ue', long: 'Tuesday' },
  { short: 'W', rest: 'ed', long: 'Wednesday' }, { short: 'T', rest: 'hu', long: 'Thursday' }, { short: 'F', rest: 'ri', long: 'Friday' }, { short: 'S', rest: 'at', long: 'Saturday' },
]
const route = useRoute()
const router = useRouter()
const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const apiBase = props.personalScope ? '/api/account' : '/api/dashboard'
const realtime = props.personalScope ? null : useDashboardInvalidations()
const { filters, signature: filterSignature, query: filterQuery } = useAgendaFilters()

const timeZone = getLocalTimeZone()
const todayDate = today(timeZone)
const todayKey = todayDate.toString()

// The three views of Airbnb's calendar; the URL carries which, and which month, so a reload lands where you were.
type CalendarView = 'list' | 'month' | 'year'
const VIEWS: Record<CalendarView, { label: string; icon: string }> = {
  list: { label: 'List', icon: 'i-lucide-list' },
  month: { label: 'Month', icon: 'i-lucide-layout-grid' },
  year: { label: 'Year', icon: 'i-lucide-grid-3x3' },
}
const view = ref<CalendarView>(route.query.view === 'list' || route.query.view === 'year' ? route.query.view : 'month')
const routeMonth = typeof route.query.month === 'string' && /^\d{4}-\d{2}$/.test(route.query.month) ? route.query.month : null
const shownMonth = shallowRef<CalendarDate>(routeMonth ? firstOf(routeMonth) : todayDate.set({ day: 1 }))
const shownYear = ref(shownMonth.value.year)
const monthKey = computed(() => monthKeyOf(shownMonth.value))

const viewItems = computed(() => [
  (Object.keys(VIEWS) as CalendarView[]).map(key => ({
    label: VIEWS[key].label,
    icon: VIEWS[key].icon,
    type: 'checkbox' as const,
    checked: view.value === key,
    onSelect: () => { view.value = key },
  })),
])
const locationItems = computed(() => locationOptions.value.map(option => ({ label: option.label, value: option.value, ...(option.imageUrl ? { avatar: { src: option.imageUrl } } : {}) })))

type MonthBlock = { key: string; items: AgendaItem[] } & (
  | { status: 'loading' | 'ready' }
  | { status: 'error'; cause: unknown }
)
const EMPTY_MONTH: MonthBlock = { key: '', status: 'loading', items: [] }

const monthData = shallowRef(new Map<string, MonthBlock>())
const locations = ref<AgendaLocation[]>([])
const availableKinds = ref<AgendaKind[]>([])
const generation = ref(0)
const month = computed<MonthBlock>(() => monthData.value.get(monthKey.value) ?? EMPTY_MONTH)

// With one location chosen the tiles say which days it cannot take — its own
// closures and the weekdays its hours never open. Across every location there
// is no one answer, so nothing is struck.
const isLocationHours = (value: unknown): value is { location: CalendarLocation } =>
  isRecord(value) && isRecord(value.location) && typeof value.location.id === 'string' && typeof value.location.status === 'string'
  && typeof value.location.updated_at === 'string' && 'opening_hours' in value.location && 'special_hours' in value.location
const organizationId = props.personalScope ? null : await useDashboardOrganizationId()

const { data: chosenLocation, error: locationError, refresh: refreshLocation } = await useAsyncData(
  () => `calendar-location:${organizationId}:${filters.locationId}`,
  async () => filters.locationId === AGENDA_FILTER_ALL || !organizationId
    ? null
    : (await dashboardApi<{ location: CalendarLocation }>(`/api/organizations/${organizationId}/locations/${filters.locationId}`, { validate: isLocationHours })).location,
  { watch: [() => filters.locationId] },
)
provide(calendarLocationKey, { location: chosenLocation, refresh: async () => { await refreshLocation() } })
function isUnavailableKey(key: string): boolean {
  const record = chosenLocation.value
  if (!record) return false
  if (record.status !== 'active') return true
  const special = parseSpecialHours(record.special_hours)
  if (closureOnDate(special, key)) return true
  const intervals = getDateIntervals(parseOpeningHours(record.opening_hours), special, key)
  return intervals !== null && intervals.length === 0
}

function putMonth(block: MonthBlock): void {
  monthData.value = new Map(monthData.value).set(block.key, block)
}
function monthKeyOf(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}`
}
function firstOf(key: string): CalendarDate {
  const [year, monthNumber] = key.split('-').map(Number)
  return new CalendarDate(year!, monthNumber!, 1)
}
const periodLabel = computed(() => view.value === 'year'
  ? String(shownYear.value)
  : formatCalendarDate(shownMonth.value.toString(), 'en', { month: 'long', year: 'numeric' }))

/** Tailwind's 42 cells: the month, padded to whole weeks from Sunday. */
function cellsOf(first: CalendarDate): Array<{ key: string; number: number; inMonth: boolean }> {
  const start = first.subtract({ days: getDayOfWeek(first, 'en-US') })
  return Array.from({ length: 42 }, (_, index) => {
    const date = start.add({ days: index })
    return { key: date.toString(), number: date.day, inMonth: date.month === first.month }
  })
}
const days = computed(() => cellsOf(shownMonth.value))
const monthDays = computed(() => {
  const count = shownMonth.value.add({ months: 1 }).subtract({ days: 1 }).day
  return Array.from({ length: count }, (_, index) => shownMonth.value.add({ days: index }).toString())
})
const scheduledDays = computed(() => monthDays.value.filter(dayKey => itemsOn(dayKey).length))
const yearKeys = computed(() => Array.from({ length: 12 }, (_, index) => `${shownYear.value}-${String(index + 1).padStart(2, '0')}`))
const yearMonths = computed(() => yearKeys.value.map((key) => {
  const first = firstOf(key)
  const block = monthData.value.get(key) ?? { ...EMPTY_MONTH, key }
  return { ...block, label: formatCalendarDate(first.toString(), 'en', { month: 'long' }), days: cellsOf(first) }
}))

const isAgendaItem = (value: unknown): value is AgendaItem =>
  isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string'
  && typeof value.startsAt === 'string' && typeof value.dayKey === 'string'
  && typeof value.timeZone === 'string' && typeof value.title === 'string'
  && typeof value.status === 'string' && typeof value.to === 'string'
const isLocation = (value: unknown): value is AgendaLocation => isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string'
const isAgendaPayload = (value: unknown): value is AgendaPayload =>
  isRecord(value) && Array.isArray(value.items) && value.items.every(isAgendaItem)
  && Array.isArray(value.availableKinds) && value.availableKinds.every(kind => AGENDA_KINDS.includes(kind as AgendaKind))
  && Array.isArray(value.locations) && value.locations.every(isLocation)

async function loadMonth(key: string): Promise<void> {
  const first = firstOf(key)
  const last = first.add({ months: 1 }).subtract({ days: 1 })
  const requested = generation.value
  putMonth({ key, status: 'loading', items: [] })
  try {
    const payload = await dashboardApi<AgendaPayload>(`${apiBase}/agenda`, {
      query: { from: first.toString(), to: last.toString(), ...filterQuery.value },
      validate: isAgendaPayload,
    })
    if (requested !== generation.value) return
    locations.value = payload.locations
    availableKinds.value = payload.availableKinds
    putMonth({ key, status: 'ready', items: payload.items })
  } catch (cause) {
    if (requested !== generation.value) return
    putMonth({ key, status: 'error', cause, items: [] })
  }
}

// A month that is there and not failed is left alone; a failed one is asked for again.
async function ensureLoaded(keys: string[]): Promise<void> {
  await Promise.all(keys.filter(key => monthData.value.get(key)?.status !== 'ready' && monthData.value.get(key)?.status !== 'loading').map(loadMonth))
}
function neededKeys(): string[] {
  return view.value === 'year' ? yearKeys.value : [monthKey.value]
}
async function resetMonths(): Promise<void> {
  generation.value += 1
  monthData.value = new Map()
  await ensureLoaded(neededKeys())
}

const itemsByDay = computed(() => {
  const groups = new Map<string, AgendaItem[]>()
  for (const block of monthData.value.values()) {
    for (const item of block.items) groups.set(item.dayKey, [...(groups.get(item.dayKey) ?? []), item])
  }
  return groups
})
function itemsOn(dayKey: string): AgendaItem[] {
  return itemsByDay.value.get(dayKey) ?? []
}
// A tile counts what is still happening; a cancelled booking is listed on its
// day, marked, and not counted.
function countFor(dayKey: string): number {
  return itemsOn(dayKey).filter(item => item.status !== 'cancelled').length
}
function timeOf(item: AgendaItem): string {
  return formatTimestamp(item.startsAt, 'en', item.timeZone, { hour: 'numeric', minute: '2-digit' })
}

// The open day is the route below this level, so a reload and a deep link ring
// the same tile, and Back from the leaf clears it.
const level = useRouteLevel()
const openDay = computed(() => typeof route.params.day === 'string' ? route.params.day : null)
function dayTo(dayKey: string) {
  return { path: `${level.path.value}/${dayKey}`, query: route.query }
}
function openDayAt(dayKey: string): void {
  void navigateTo(dayTo(dayKey))
}

function step(direction: 1 | -1): void {
  if (view.value === 'year') {
    shownYear.value += direction
    return
  }
  shownMonth.value = shownMonth.value.add({ months: direction })
}
function goToToday(): void {
  shownMonth.value = todayDate.set({ day: 1 })
  shownYear.value = todayDate.year
}
// A month chosen from the year opens the month view on it.
function openMonth(key: string): void {
  shownMonth.value = firstOf(key)
  view.value = 'month'
}

// Select dates — Airbnb's Select nights. A first tap starts the range, a
// second ends it (either order), a third starts over.
const selecting = ref(false)
const selection = reactive<{ start: string | null; end: string | null }>({ start: null, end: null })
const writing = ref<'block' | 'open' | null>(null)
const writeError = ref<unknown>(null)

function startSelecting(): void {
  selecting.value = true
  selection.start = null
  selection.end = null
  writeError.value = null
  if (typeof route.params.day === 'string') void navigateTo({ path: level.path.value, query: route.query })
}
function stopSelecting(): void {
  selecting.value = false
  selection.start = null
  selection.end = null
}
function extendSelection(day: string): void {
  if (!selection.start || selection.end) {
    selection.start = day
    selection.end = null
    return
  }
  if (day < selection.start) {
    selection.end = selection.start
    selection.start = day
  } else {
    selection.end = day
  }
}
const selectionRange = computed(() => selection.start ? { from: selection.start, to: selection.end ?? selection.start } : null)
const selectionDays = computed(() => {
  const range = selectionRange.value
  if (!range) return 0
  return parseDate(range.to).compare(parseDate(range.from)) + 1
})
const selectionCountLabel = computed(() => selectionDays.value === 1 ? '1 day' : `${selectionDays.value} days`)
const selectionLabel = computed(() => {
  const range = selectionRange.value
  if (!range) return 'Choose a start date'
  const from = formatCalendarDate(range.from, 'en', { month: 'short', day: 'numeric' })
  if (!selection.end) return `${from} — choose an end date, or block this day`
  return `${from} – ${formatCalendarDate(range.to, 'en', { month: 'short', day: 'numeric' })}`
})
const selectionHint = computed(() => writeError.value
  ? getErrorMessage(writeError.value, 'The dates were not saved')
  : selectionRange.value ? `${selectionCountLabel.value} selected` : 'Tap a day to start')

function inSelection(dayKey: string): boolean {
  const range = selectionRange.value
  return !!range && dayKey >= range.from && dayKey <= range.to
}
function isSelectionEdge(dayKey: string): boolean {
  const range = selectionRange.value
  return !!range && (dayKey === range.from || dayKey === range.to)
}

async function writeSelection(action: 'block' | 'open'): Promise<void> {
  const record = chosenLocation.value
  const range = selectionRange.value
  if (!record || !range) return
  const special = parseSpecialHours(record.special_hours)
  writing.value = action
  writeError.value = null
  try {
    await dashboardApi(`/api/organizations/${organizationId}/locations/${record.id}`, {
      method: 'PATCH',
      body: { special_hours: action === 'block' ? closeDates(special, range.from, range.to) : openDates(special, range.from, range.to), expected_updated_at: record.updated_at },
      validate: isLocationHours,
    })
    await refreshLocation()
    stopSelecting()
  } catch (cause) {
    // A refusal means the location moved under us; the next attempt starts
    // from what is there now.
    writeError.value = cause
    await refreshLocation()
  } finally {
    writing.value = null
  }
}

const locationOptions = computed(() => [{ label: 'All locations', value: AGENDA_FILTER_ALL, imageUrl: null as string | null }, ...locations.value.map(location => ({ label: location.title, value: location.id, imageUrl: location.imageUrl }))])

// The period on screen is read before the level renders; others as they are shown.
await ensureLoaded(neededKeys())

// The URL says which view and which month; the data follows the period.
watch([view, monthKey, shownYear], () => {
  if (selecting.value) stopSelecting()
  void router.replace({ query: { ...route.query, view: view.value === 'month' ? undefined : view.value, month: monthKey.value === monthKeyOf(todayDate) ? undefined : monthKey.value } })
  void ensureLoaded(neededKeys())
})

// The filters own their place in the URL; the months reload for the new answer.
watch(filterSignature, () => {
  void resetMonths()
})
if (realtime) {
  watch(realtime.event, event => {
    if (event?.type === 'stay.changed' || event?.type === 'nights.changed') void resetMonths()
  })
  watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void resetMonths() })
}
</script>
