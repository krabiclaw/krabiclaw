<template>
  <!--
    Every home, or every place, on one screen, as Airbnb's multi-calendar: rows
    are homes (nights are columns, a stay is a bar across the nights it holds,
    a free night shows its price) or places (restaurant locations, experiences
    and consultations; a day shows its reservations or sessions). Dragging (or
    clicking a first and a last day) selects the same days on every row
    crossed, and the night inspector edits them in place: nights take prices
    and stay rules, places take open or block.
  -->
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- On a phone the filters and the window share one row each, so the rows start higher. -->
    <div class="mb-4 flex items-center gap-3 sm:flex-wrap">
      <USelect v-if="homesView" :model-value="city" :items="cityItems" icon="i-lucide-building-2" aria-label="City" class="min-w-0 flex-1 sm:min-w-44 sm:flex-none" :ui="{ base: 'rounded-full' }" @update:model-value="setQuery({ city: $event === ALL_CITIES ? undefined : String($event) })" />
      <UButton :label="words.free" :aria-pressed="freeOnly" color="neutral" :variant="freeOnly ? 'solid' : 'outline'" class="shrink-0 rounded-full" @click="setQuery({ free: freeOnly ? undefined : '1' })" />
    </div>
    <div class="min-h-0 flex-1" :class="selection && pane ? 'grid grid-cols-[minmax(0,1fr)_24rem] grid-rows-[minmax(0,1fr)] gap-6' : 'flex flex-col'">
      <div class="flex min-h-0 min-w-0 flex-col">
        <header class="flex items-center justify-between gap-3 py-2">
          <h2 class="min-w-0 truncate text-base font-semibold text-highlighted">{{ windowLabel }}</h2>
          <div class="flex items-center gap-1">
            <UButton icon="i-lucide-chevrons-left" color="neutral" variant="ghost" square class="hidden size-10 justify-center rounded-full sm:inline-flex" aria-label="Previous month" @click="step(-30)" />
            <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" square class="size-10 justify-center rounded-full" aria-label="Previous week" @click="step(-7)" />
            <UButton label="Today" color="neutral" variant="ghost" class="h-10 rounded-full px-4" @click="goToToday" />
            <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" square class="size-10 justify-center rounded-full" aria-label="Next week" @click="step(7)" />
            <UButton icon="i-lucide-chevrons-right" color="neutral" variant="ghost" square class="hidden size-10 justify-center rounded-full sm:inline-flex" aria-label="Next month" @click="step(30)" />
          </div>
        </header>
        <UAlert v-if="error" color="error" variant="soft" :title="words.loadError" :description="getErrorMessage(error, 'Calendar request failed')" :actions="[{ label: 'Try again', color: 'neutral', variant: 'soft', onClick: () => refresh() }]" />
        <div v-else-if="status === 'pending' && !data" class="overflow-x-auto rounded-xl shadow-sm ring ring-default animate-pulse" role="status" aria-label="Loading calendar...">
          <div class="p-6 space-y-4">
            <div class="h-6 w-48 rounded bg-elevated/80" />
            <div class="space-y-3">
              <div v-for="i in 3" :key="i" class="flex gap-4">
                <div class="h-12 w-36 rounded bg-elevated/60 shrink-0" />
                <div class="h-12 flex-1 rounded bg-elevated/30" />
              </div>
            </div>
          </div>
        </div>
        <p v-else-if="data && !rows.length" class="py-10 text-center text-sm text-muted">{{ search || freeOnly || city !== ALL_CITIES ? words.noMatch : words.none }}</p>
        <!-- The grid is its own scroller on both axes: the day header pins to its top and the home column to its left, the corner over both. -->
        <div v-else-if="data" class="min-h-0 overflow-auto rounded-xl shadow-sm ring ring-default" :aria-busy="status === 'pending'" :data-testid="`${words.testId}-grid`">
          <div
            ref="gridElement"
            class="grid w-max select-none [--home-column:8rem] sm:[--home-column:14rem]"
            role="grid"
            :aria-label="words.gridLabel"
            :aria-multiselectable="true"
            :style="{ gridTemplateColumns: `var(--home-column) repeat(${dates.length}, 4rem)` }"
            @pointermove="dragTo"
          >
            <div role="row" class="contents">
              <div role="columnheader" class="sticky left-0 top-0 z-30 border-b border-r border-default bg-default" />
              <div v-for="day in dates" :key="day" role="columnheader" class="sticky top-0 z-20 border-b border-default px-1 py-1 text-center text-xs sm:py-2" :class="day === todayKey ? 'bg-primary/10' : 'bg-default'">
                <span class="block text-muted">{{ day.endsWith('-01') || day === dates[0] ? formatCalendarDate(day, 'en', { month: 'short' }) : formatCalendarDate(day, 'en', { weekday: 'short' }) }}</span>
                <span class="block font-semibold" :class="day === todayKey ? 'text-primary' : 'text-highlighted'">{{ Number(day.slice(-2)) }}</span>
              </div>
            </div>
            <div v-for="(row, rowIndex) in rows" :key="row.id" role="row" class="contents">
              <div role="rowheader" class="sticky left-0 z-20 flex min-w-0 items-center gap-2 border-b border-r border-default bg-default px-2 py-1 sm:px-3 sm:py-2" :class="selectedRow(row.id) ? 'shadow-[inset_3px_0_0_var(--ui-primary)]' : undefined">
                <UCheckbox v-if="selection" :model-value="selectedRow(row.id)" :aria-label="`Include ${row.name}`" :disabled="editor.busy.value" @update:model-value="includeRow(row.id, Boolean($event))" />
                <NuxtLink :to="row.to" class="flex min-w-0 flex-col hover:underline" :data-home="row.home?.product_id" :data-place="row.place ? `${row.place.kind}:${row.place.id}` : undefined">
                  <span class="line-clamp-2 text-sm font-medium text-highlighted">{{ row.name }}</span>
                  <span class="hidden truncate text-xs text-muted sm:block">{{ row.detail }}</span>
                </NuxtLink>
              </div>
              <div class="relative grid border-b border-default" :data-row-index="rowIndex" :style="{ gridColumn: `2 / span ${dates.length}`, gridTemplateColumns: `repeat(${dates.length}, 4rem)` }">
                <button
                  v-for="(cell, index) in row.cells"
                  :key="cell.date"
                  type="button"
                  role="gridcell"
                  :aria-selected="inSelection(rowIndex, index)"
                  :aria-label="cell.title"
                  :tabindex="cursor.row === rowIndex && cursor.day === index ? 0 : -1"
                  class="relative flex h-16 flex-col justify-end border-r border-default px-1.5 py-1 text-left text-xs leading-4 tabular-nums sm:h-18 outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-inverted"
                  :class="[cell.open ? 'bg-default text-highlighted' : 'bg-elevated/60 text-muted', inSelection(rowIndex, index) && !chosenWeekday(cell.date) ? 'text-dimmed' : '']"
                  :style="{ gridRow: 1, gridColumn: index + 1 }"
                  :title="cell.title"
                  :data-night="cell.date"
                  @pointerdown="startDrag($event, rowIndex, index)"
                  @click="choose(rowIndex, index)"
                  @keydown="keydown($event, rowIndex, index)"
                  @focus="cursor = { row: rowIndex, day: index }"
                >
                  <UIcon v-if="cell.mark" :name="CHANNEL_MARKS[cell.mark]" class="absolute right-1 top-1 size-3" :class="cell.mark === 'pending' ? 'text-muted' : 'text-warning'" :data-testid="`stay-homes-channel-${cell.mark}`" aria-hidden="true" />
                  <span v-if="cell.label" class="truncate" :class="cell.strike ? 'line-through' : ''">{{ cell.label }}</span>
                </button>
                <div
                  v-for="(piece, pieceIndex) in pills(rowIndex)"
                  :key="piece.column"
                  class="pointer-events-none z-[5] mx-0.5 mt-1 flex h-5 min-w-0 items-center self-start rounded-full sm:mt-1.5 sm:h-7 bg-accented px-2.5 text-xs font-semibold text-highlighted ring-2 ring-inset ring-inverted"
                  :style="{ gridRow: 1, gridColumn: `${piece.column} / span ${piece.span}` }"
                  :data-testid="`${words.testId}-selection`"
                  aria-hidden="true"
                >
                  <span v-if="pieceIndex === 0" class="truncate">{{ piece.label }}</span>
                </div>
                <NuxtLink
                  v-for="bar in row.bars"
                  :key="bar.key"
                  :to="bar.to"
                  class="z-10 mx-0.5 mt-1 flex h-5 min-w-0 items-center gap-1.5 self-start rounded-full px-2.5 text-xs font-medium text-white sm:mt-1.5 sm:h-7"
                  :style="{ gridRow: 1, gridColumn: `${bar.column} / span ${bar.span}`, backgroundColor: CHANNEL_BARS[bar.channel ?? 'direct'].color }"
                  :title="bar.title"
                  :data-stay="bar.stayId"
                  :data-channel="bar.channel"
                  :data-booked="bar.date"
                >
                  <img v-if="bar.channel === 'direct'" src="/platform/krabiclaw-symbol.svg" alt="" class="size-3.5 shrink-0">
                  <UIcon v-else-if="bar.channel === 'airbnb'" name="i-simple-icons-airbnb" class="size-3.5 shrink-0" />
                  <span v-else-if="bar.channel" class="shrink-0 font-bold" aria-hidden="true">{{ CHANNEL_BARS[bar.channel].mark }}</span>
                  <span class="truncate">{{ bar.label }}</span>
                </NuxtLink>
              </div>
            </div>
          </div>
        </div>
      </div>
      <aside v-if="selection && pane && targets.length" class="max-h-full self-start overflow-y-auto rounded-2xl p-5 ring ring-default">
        <StayNightInspector v-bind="inspectorProps" v-on="editor.listeners" @clear="clearSelection" @weekdays="setWeekdays" @blocker="fixBlocker" />
      </aside>
    </div>
    <div v-if="selection && !pane && !drawerOpen" class="fixed inset-x-3 bottom-20 z-30 flex items-center justify-between gap-3 rounded-xl bg-inverted px-4 py-3 text-sm font-medium text-inverted shadow-lg" :data-testid="`${words.testId}-hint`">
      <span class="min-w-0 truncate">{{ awaitingEnd ? `${formatCalendarDate(selection.from, 'en', { weekday: 'short', month: 'short', day: 'numeric' })} · tap the last ${words.unit}` : `${selectionLabel} · ${scopeLabel}` }}</span>
      <div class="flex shrink-0 items-center gap-1">
        <UButton label="Edit" color="neutral" variant="solid" class="bg-default text-highlighted hover:bg-elevated" @click="drawerOpen = true" />
        <UButton label="Cancel" color="neutral" variant="link" class="text-inverted" @click="clearSelection" />
      </div>
    </div>
    <UDrawer
      v-if="selection && !pane && targets.length"
      :open="drawerOpen"
      :title="`Selected ${words.units}`"
      :description="`${selectionLabel} · ${scopeLabel}`"
      :dismissible="!editor.busy.value"
      no-body-styles
      handle-only
      :ui="{ content: 'max-h-[85dvh] rounded-t-3xl', body: 'overflow-y-auto' }"
      @update:open="closeDrawer"
    >
      <template #body>
        <StayNightInspector v-bind="inspectorProps" v-on="editor.listeners" @clear="clearSelection" @weekdays="setWeekdays" @blocker="fixBlocker" />
      </template>
    </UDrawer>
  </div>
</template>

<script setup lang="ts">
import { getLocalTimeZone, parseDate, today } from '@internationalized/date'
import { useEventListener } from '@vueuse/core'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import type { Stay, StayHome, StayNight, StayTurnover } from '~/server/domain/stays'
import type { Place, PlaceDay } from '~/server/domain/places'
import { MAX_STAY_NIGHTS, STAY_CHANNEL_LABELS, parseStayCalendarRules, type StayChannel } from '~/shared/bookings'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'
import { addLocalDays, formatCalendarDate, isValidCalendarDate, isValidTimezone } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { CHANNEL_MARKS, channelNote, isBookedNight, isPlaceDay, isStayNight, nightWeekday, placeDaySource, stayNightSource, useStayNightEditor } from '~/composables/useStayNightEditor'
import StayNightInspector from './StayNightInspector.vue'

type Home = Pick<StayHome, 'product_id' | 'name' | 'internal_name' | 'timezone' | 'currency' | 'base_price_minor' | 'min_nights' | 'calendar_rules' | 'address'>
// A manager reads each stay's channel; a member's turnover has none.
type GridStay = Pick<StayTurnover, 'id' | 'product_id' | 'guest_name' | 'adults' | 'children' | 'check_in_date' | 'check_out_date'> & Partial<Pick<Stay, 'channel'>>
interface HomesPayload { from: string; to: string; homes: { home: Home; nights: StayNight[] }[]; stays: GridStay[]; manage: boolean }
interface PlacesPayload { from: string; to: string; places: { place: Place; days: PlaceDay[] }[]; manage: boolean }
interface GridBar { key: string; date: string; column: number; span: number; label: string; title: string; to: RouteLocationRaw; stayId: string | null; channel: StayChannel | null }
/** One day on one row as the grid draws it: its label, whether it reads open, and what holds it. */
interface GridCell { date: string; open: boolean; held: boolean; label: string; strike: boolean; mark: 'pending' | 'needs_review' | null; title: string }
interface GridRow { id: string; name: string; detail: string; to: RouteLocationRaw; cells: GridCell[]; bars: GridBar[]; gaps: Map<number, { text: string; start: number; end: number }>; home?: Home; place?: Place; nights?: StayNight[]; days?: PlaceDay[] }

// The two views: homes (nights at every home) and places (days at every restaurant location, experience and consultation).
const props = defineProps<{ view: 'homes' | 'places' }>()
const homesView = props.view === 'homes'
const words = homesView
  ? { rows: 'homes', span: 'nights', unit: 'night', units: 'nights', free: 'No upcoming stays', none: 'No homes yet.', noMatch: 'No homes match these filters.', gridLabel: 'Nights at every home', loadError: 'The homes calendar could not be loaded', testId: 'stay-homes' }
  : { rows: 'places', span: 'dates', unit: 'date', units: 'dates', free: 'No upcoming bookings', none: 'No places yet.', noMatch: 'No places match these filters.', gridLabel: 'Days at every place', loadError: 'The places calendar could not be loaded', testId: 'places' }

// Today and thirty days after it, paged by a week or a month; the URL keeps where you were and what is selected.
const SPAN = 31
const route = useRoute()
const router = useRouter()
const orgSlug = String(route.params.orgSlug)
const api = useDashboardApi()
const pane = useDashboardPane()
const todayKey = today(getLocalTimeZone()).toString()
if (Object.hasOwn(route.query, 'from') && (typeof route.query.from !== 'string' || !isValidCalendarDate(route.query.from))) throw createError({ statusCode: 400, statusMessage: `Choose a valid first ${words.unit}.` })
const from = computed(() => typeof route.query.from === 'string' ? route.query.from : todayKey)
const to = computed(() => parseDate(from.value).add({ days: SPAN }).toString())
const dates = computed(() => Array.from({ length: SPAN }, (_, index) => parseDate(from.value).add({ days: index }).toString()))
const search = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const freeOnly = computed(() => route.query.free === '1')
// The page's search narrows the rows, but not under a save that is reading back the homes it wrote.
const appliedSearch = ref(search.value)
// A city from the homes' addresses; NO_CITY is the homes without one.
const ALL_CITIES = '*'
const NO_CITY = '-'
const city = computed(() => homesView && typeof route.query.city === 'string' && route.query.city ? route.query.city : ALL_CITIES)

/** The selection: the same days, [from, to), at each named row, narrowed to weekdays when any are named. */
const selection = computed(() => {
  const rowsQuery = route.query[words.rows]
  const spanQuery = route.query[words.span]
  if (rowsQuery === undefined && spanQuery === undefined) return null
  const [first, end] = typeof spanQuery === 'string' ? spanQuery.split('..') : []
  const ids = typeof rowsQuery === 'string' ? rowsQuery.split(',').filter(Boolean) : []
  if (!ids.length || !first || !end || !isValidCalendarDate(first) || !isValidCalendarDate(end) || end <= first) throw createError({ statusCode: 400, statusMessage: `Choose valid ${words.rows} and ${words.units}.` })
  return { rows: ids, from: first, to: end }
})
const weekdays = computed<number[] | null>(() => {
  const value = route.query.weekdays
  if (value === undefined) return null
  const days = typeof value === 'string' ? value.split(',').map(part => part ? Number(part) : NaN) : []
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length) throw createError({ statusCode: 400, statusMessage: 'Choose valid weekdays.' })
  return [...days].sort()
})

const isText = (value: unknown) => value === null || typeof value === 'string'
const isCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isAmount = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function isHome(value: unknown): value is Home {
  if (!isRecord(value) || typeof value.product_id !== 'string' || typeof value.name !== 'string' || typeof value.internal_name !== 'string' || typeof value.timezone !== 'string' || !isValidTimezone(value.timezone)
    || !isCurrencyCode(value.currency) || !isAmount(value.base_price_minor) || typeof value.min_nights !== 'number' || !Number.isInteger(value.min_nights) || value.min_nights < 1 || value.min_nights > MAX_STAY_NIGHTS
    || !(value.address === null || isRecord(value.address))) return false
  parseStayCalendarRules(value.calendar_rules)
  return true
}
const isPlace = (value: unknown): value is Place => isRecord(value) && (value.kind === 'location' || value.kind === 'offering') && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.detail === 'string'
  && isText(value.slug) && typeof value.timezone === 'string' && isValidTimezone(value.timezone) && isText(value.updated_at)
  && (value.provider === null || isRecord(value.provider) && typeof value.provider.member_id === 'string' && typeof value.provider.name === 'string')
const isWindow = (value: unknown): value is Record<string, unknown> & { manage: boolean } => isRecord(value) && value.from === from.value && value.to === to.value && typeof value.manage === 'boolean'
const isHomesPayload = (value: unknown): value is HomesPayload => isWindow(value) && Array.isArray(value.homes) && Array.isArray(value.stays)
  && value.homes.every(entry => isRecord(entry) && isHome(entry.home) && Array.isArray(entry.nights) && entry.nights.length === SPAN
    && entry.nights.every((night, index) => isStayNight(night) && night.date === dates.value[index]))
  && value.stays.every(stay => isRecord(stay) && typeof stay.id === 'string' && typeof stay.product_id === 'string' && isText(stay.guest_name) && isCount(stay.adults) && isCount(stay.children)
    && (value.manage ? Object.hasOwn(STAY_CHANNEL_LABELS, String(stay.channel)) : !('channel' in stay)) && isValidCalendarDate(stay.check_in_date) && isValidCalendarDate(stay.check_out_date))
const isPlacesPayload = (value: unknown): value is PlacesPayload => isWindow(value) && Array.isArray(value.places)
  && value.places.every(entry => isRecord(entry) && isPlace(entry.place) && Array.isArray(entry.days) && entry.days.length === SPAN && entry.days.every((day, index) => isPlaceDay(day) && day.date === dates.value[index]))

const cacheKey = () => `${words.testId}-grid:${orgSlug}:${from.value}`
const { data, error, status, refresh } = await useAsyncData<HomesPayload | PlacesPayload>(
  cacheKey,
  (_nuxtApp, { signal }) => homesView
    ? api('/api/dashboard/stay-homes/calendar', { query: { from: from.value, to: to.value }, validate: isHomesPayload, signal })
    : api('/api/dashboard/places/calendar', { query: { from: from.value, to: to.value }, validate: isPlacesPayload, signal }),
  {
    getCachedData(key, nuxtApp, ctx) {
      if (ctx?.cause === 'refresh:manual' || ctx?.cause === 'refresh:hook') return undefined
      return nuxtApp.payload.data[key] as HomesPayload | PlacesPayload | undefined
    },
  },
)
const homesData = computed(() => data.value && 'homes' in data.value ? data.value : null)
const placesData = computed(() => data.value && 'places' in data.value ? data.value : null)

if (import.meta.client) {
  onMounted(() => {
    if (useNuxtApp().payload.data[cacheKey()]) void refresh()
  })
}

/** Each channel's bar colour and, where the build has no official mark, the mark it reads. */
const CHANNEL_BARS: Record<StayChannel, { color: string; mark: string }> = {
  airbnb: { color: '#FF385C', mark: '' }, vrbo: { color: '#245ABC', mark: 'V' }, booking_com: { color: '#003580', mark: 'B.' }, direct: { color: 'var(--kc-navy)', mark: '' },
}
const guestName = (stay: GridStay) => stay.guest_name || 'Guest name not provided'
// Adults and children count as guests; infants do not, as Airbnb counts them.
const guestCount = (stay: GridStay) => `${stay.adults + stay.children} ${stay.adults + stay.children === 1 ? 'guest' : 'guests'}`
const addressOf = (home: Home) => home.address ? [home.address.address, home.address.city].filter(Boolean).join(', ') : 'No address'
const cityOf = (home: Home) => home.address?.city?.trim() || null
const cityItems = computed(() => {
  const homes = homesData.value?.homes ?? []
  const counts = new Map<string, number>()
  for (const { home } of homes) counts.set(cityOf(home) ?? NO_CITY, (counts.get(cityOf(home) ?? NO_CITY) ?? 0) + 1)
  return [
    { label: `All cities (${homes.length})`, value: ALL_CITIES },
    ...[...counts].filter(([name]) => name !== NO_CITY).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ label: `${name} (${count})`, value: name })),
    ...(counts.has(NO_CITY) ? [{ label: `No city (${counts.get(NO_CITY)})`, value: NO_CITY }] : []),
  ]
})
const matches = (name: string, detail: string) => !appliedSearch.value || `${name} ${detail}`.toLowerCase().includes(appliedSearch.value.toLowerCase())
// A stay's bar spans the run of nights it holds on screen; a run cut by the window's edge still names its guest.
// A linked calendar's nights are a bar of their own, named for the channel.
const homeRows = computed<GridRow[]>(() => {
  const stays = new Map((homesData.value?.stays ?? []).map(stay => [stay.id, stay]))
  return (homesData.value?.homes ?? [])
    .filter(entry => (city.value === ALL_CITIES || (cityOf(entry.home) ?? NO_CITY) === city.value) && matches(entry.home.internal_name, addressOf(entry.home)) && (!freeOnly.value || !entry.nights.some(isBookedNight)))
    .map(({ home, nights }) => {
      const bars: GridBar[] = []
      nights.forEach((night, index) => {
        const holder = night.booking_id ?? (night.calendar ? `calendar:${night.calendar}` : null)
        if (!holder) return
        const last = bars.at(-1)
        if (last?.key.startsWith(`${holder}:`) && last.column + last.span === index + 1) { last.span += 1; return }
        if (!night.booking_id) {
          const label = STAY_CHANNEL_LABELS[night.calendar!]
          bars.push({ key: `${holder}:${night.date}`, date: night.date, stayId: null, channel: night.calendar, column: index + 1, span: 1, label, title: `Unavailable from ${label}`, to: homeTo(home.product_id, night.date) })
          return
        }
        const stay = stays.get(night.booking_id)
        const label = stay ? `${guestName(stay)} · ${guestCount(stay)}` : 'Reserved'
        bars.push({ key: `${holder}:${night.date}`, date: night.date, stayId: night.booking_id, channel: stay?.channel ?? null, column: index + 1, span: 1, label,
          to: { path: `/dashboard/${orgSlug}/calendar/stay/${encodeURIComponent(night.booking_id)}`, query: route.query },
          title: stay ? `${[label, ...(stay.channel ? [STAY_CHANNEL_LABELS[stay.channel]] : [])].join(' · ')} · ${formatCalendarDate(stay.check_in_date, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(stay.check_out_date, 'en', { month: 'short', day: 'numeric' })}` : label })
      })
      const gaps = unbookableGaps(nights)
      const cells = nights.map((night, index): GridCell => ({
        date: night.date, open: night.available, held: isBookedNight(night), strike: night.closed, mark: channelState(night),
        label: !isBookedNight(night) || night.held_until ? freeLabel(home, night) : '', title: nightTitle(home, night, gaps.get(index)?.text),
      }))
      return { id: home.product_id, name: home.internal_name, detail: addressOf(home), to: homeTo(home.product_id), cells, bars, gaps, home, nights }
    })
})
// A place's day: its reservations or booked sessions as a bar that opens the day; what is free, blocked or closed in the cell.
const placeRows = computed<GridRow[]>(() => (placesData.value?.places ?? [])
  .filter(entry => matches(entry.place.name, entry.place.detail) && (!freeOnly.value || !entry.days.some(day => day.booked > 0)))
  .map(({ place, days }) => {
    const id = `${place.kind}:${place.id}`
    const scope = place.kind === 'location' ? { location_id: place.id } : { product_id: place.id }
    const bars = days.flatMap((day, index): GridBar[] => day.booked ? [{ key: `${id}:${day.date}`, date: day.date, stayId: null, channel: null, column: index + 1, span: 1, label: `${day.booked} booked`, title: day.held?.kind === 'booked' ? day.held.text : `${day.booked} booked`, to: { path: `/dashboard/${orgSlug}/calendar/${day.date}`, query: scope } }] : [])
    const cells = days.map((day): GridCell => {
      const label = day.held?.kind === 'hours' || day.held?.kind === 'inactive' ? 'Closed' : day.closed ? 'Blocked' : day.free ? `${day.free} free` : ''
      return { date: day.date, open: !day.closed && day.held?.kind !== 'unscheduled', held: day.held !== null, strike: day.closed && !day.held, mark: null, label,
        title: `${place.name} · ${formatCalendarDate(day.date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })} · ${day.held ? day.held.text : day.closed ? 'Blocked' : 'Available'}${day.free ? ` · ${day.free} free` : ''}` }
    })
    return { id, name: place.name, detail: place.detail, to: { path: `/dashboard/${orgSlug}/calendar`, query: scope }, cells, bars, gaps: new Map(), place, days }
  }))
const rows = computed(() => homesView ? homeRows.value : placeRows.value)
/**
 * Free nights between two booked ones that no arrival can fill, because every
 * night's minimum stay is longer than the nights left before the next booking:
 * Airbnb's calendar blocker, explained the way its shortExplanation does.
 */
function unbookableGaps(nights: StayNight[]) {
  const gaps = new Map<number, { text: string; start: number; end: number }>()
  let start = -1
  nights.forEach((night, index) => {
    if (!isBookedNight(night)) { if (start === -1) start = index; return }
    if (start > 0 && isBookedNight(nights[start - 1]!) && nights.slice(start, index).every((free, offset) => free.min_stay_arrival > index - start - offset)) {
      const text = `${index - start} free ${index - start === 1 ? 'night' : 'nights'}; minimum is ${nights[start]!.min_stay_arrival}`
      for (let gap = start; gap < index; gap++) gaps.set(gap, { text, start, end: index })
    }
    start = -1
  })
  return gaps
}

const windowLabel = computed(() => `${formatCalendarDate(from.value, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(dates.value.at(-1)!, 'en', { month: 'short', day: 'numeric', year: 'numeric' })}`)
// Each home's own currency, as the night inspector shows it: a Krabi villa and a
// Santa Monica studio sit in the same grid, so a bare number would mislead.
const price = (home: Home, night: StayNight) => night.price_minor === null ? 'No price' : formatMinorAmount(night.price_minor, home.currency).replace(/\.00$/, '')
function freeLabel(home: Home, night: StayNight) {
  if (night.held_until) return 'Hold'
  if (night.calendar) return STAY_CHANNEL_LABELS[night.calendar]
  return price(home, night)
}
/** A night the channel has not confirmed: still queued for it, or refused and needing review. */
const channelState = (night: StayNight) => night.channel?.state === 'pending' || night.channel?.state === 'needs_review' ? night.channel.state : null
function nightTitle(home: Home, night: StayNight, gap?: string) {
  const state = night.booking_id ? 'Booked' : night.held_until ? 'Checkout hold' : night.calendar ? `Unavailable from ${STAY_CHANNEL_LABELS[night.calendar]}` : night.closed ? 'Blocked' : 'Available'
  const note = channelNote(night)
  return `${home.internal_name} · ${formatCalendarDate(night.date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })} · ${state} · ${price(home, night)}${gap ? ` · ${gap}` : ''}${note ? ` · ${note}` : night.channel?.state === 'pushed' ? ' · On Airbnb' : ''}`
}
function homeTo(productId: string, date?: string) {
  return { path: `/dashboard/${orgSlug}/calendar`, query: { product_id: productId, ...(date ? { month: date.slice(0, 7), date } : {}) } }
}
/** One place's own calendar on a date: the month narrowed to the location, or the offering's calendar. */
function placeTo(place: Place, date: string) {
  return { path: `/dashboard/${orgSlug}/calendar`, query: { ...(place.kind === 'location' ? { location_id: place.id } : { product_id: place.id, date }), month: date.slice(0, 7) } }
}
// Nothing moves the selection or the rows while a save runs: its read-back compares the rows it wrote.
function setQuery(changes: LocationQueryRaw) {
  if (editor.busy.value) return
  void router.replace({ query: { ...route.query, ...changes } })
}
function moveTo(day: string) {
  setQuery({ from: day === todayKey ? undefined : day, [words.rows]: undefined, [words.span]: undefined, weekdays: undefined })
}
function step(count: number) { moveTo(parseDate(from.value).add({ days: count }).toString()) }
function goToToday() { moveTo(todayKey) }

// Selecting: a first day anchors the selection; a second day, a drag or Shift with an arrow spans every row and day between them.
const anchor = ref<{ row: string; day: number } | null>(null)
const cursor = ref({ row: 0, day: 0 })
const drawerOpen = ref(false)
const gridElement = useTemplateRef<HTMLElement>('gridElement')
const drag = ref<{ row: number; day: number; moved: boolean } | null>(null)
let suppressClick = false
const selectedRow = (id: string) => Boolean(selection.value?.rows.includes(id))
const span = computed(() => {
  const value = selection.value
  // A selection outside the window on screen (a link kept past its dates) selects nothing here.
  if (!value || value.to <= from.value || value.from >= to.value) return null
  const start = Math.max(0, dates.value.indexOf(value.from) === -1 ? (value.from < from.value ? 0 : SPAN) : dates.value.indexOf(value.from))
  const end = value.to > to.value ? SPAN : dates.value.indexOf(value.to) === -1 ? SPAN : dates.value.indexOf(value.to)
  return end > start ? { start, end } : null
})
const inSelection = (row: number, day: number) => Boolean(span.value && selectedRow(rows.value[row]!.id) && day >= span.value.start && day < span.value.end)
const chosenWeekday = (date: string) => !weekdays.value || weekdays.value.includes(nightWeekday(date))
const awaitingEnd = computed(() => Boolean(anchor.value && selection.value?.rows.length === 1 && span.value && span.value.end - span.value.start === 1))
function select(rowA: number, dayA: number, rowB: number, dayB: number) {
  const [top, bottom] = rowA <= rowB ? [rowA, rowB] : [rowB, rowA]
  const [first, last] = dayA <= dayB ? [dayA, dayB] : [dayB, dayA]
  setQuery({ [words.rows]: rows.value.slice(top, bottom + 1).map(row => row.id).join(','), [words.span]: `${dates.value[first]}..${addLocalDays(dates.value[last]!, 1)}`, weekdays: undefined })
}
function choose(row: number, day: number) {
  if (suppressClick) { suppressClick = false; return }
  const start = anchor.value && rows.value.findIndex(entry => entry.id === anchor.value!.row)
  if (anchor.value && awaitingEnd.value && typeof start === 'number' && start >= 0 && !(start === row && anchor.value.day === day)) {
    select(start, anchor.value.day, row, day)
    anchor.value = null
    drawerOpen.value = true
    return
  }
  anchor.value = { row: rows.value[row]!.id, day }
  select(row, day, row, day)
}
function startDrag(event: PointerEvent, row: number, day: number) {
  suppressClick = false
  if (event.button !== 0 || event.pointerType === 'touch' || editor.busy.value) return
  drag.value = { row, day, moved: false }
}
function cellAt(event: PointerEvent) {
  const element = document.elementsFromPoint(event.clientX, event.clientY).find((item): item is HTMLElement => item instanceof HTMLElement && item.dataset.rowIndex !== undefined)
  if (!element) return null
  const box = element.getBoundingClientRect()
  return { row: Number(element.dataset.rowIndex), day: Math.min(SPAN - 1, Math.max(0, Math.floor((event.clientX - box.left) / (box.width / SPAN)))) }
}
function dragTo(event: PointerEvent) {
  const origin = drag.value
  const cell = origin && cellAt(event)
  if (!origin || !cell || (!origin.moved && cell.row === origin.row && cell.day === origin.day)) return
  origin.moved = true
  select(origin.row, origin.day, cell.row, cell.day)
}
function endDrag() {
  if (drag.value?.moved) {
    suppressClick = true
    anchor.value = null
    drawerOpen.value = true
  }
  drag.value = null
}
// A drag ends wherever the pointer is let go, on the grid or off it.
const pointerTarget = computed(() => import.meta.client ? window : undefined)
useEventListener(pointerTarget, 'pointerup', endDrag)
useEventListener(pointerTarget, 'pointercancel', () => { drag.value = null })
function keydown(event: KeyboardEvent, row: number, day: number) {
  const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }
  if (event.key === 'Escape') { clearSelection(); return }
  const move = moves[event.key]
  if (!move) return
  event.preventDefault()
  const next = { row: Math.min(rows.value.length - 1, Math.max(0, row + move[0])), day: Math.min(SPAN - 1, Math.max(0, day + move[1])) }
  cursor.value = next
  void nextTick(() => gridElement.value?.querySelector<HTMLElement>(`[data-row-index="${next.row}"] [data-night="${dates.value[next.day]}"]`)?.focus())
  if (!event.shiftKey) return
  if (!anchor.value) anchor.value = { row: rows.value[row]!.id, day }
  const start = rows.value.findIndex(entry => entry.id === anchor.value!.row)
  if (start >= 0) select(start, anchor.value.day, next.row, next.day)
}
function includeRow(id: string, include: boolean) {
  const ids = (selection.value?.rows ?? []).filter(entry => entry !== id)
  if (include) ids.push(id)
  if (!ids.length) { clearSelection(); return }
  setQuery({ [words.rows]: rows.value.map(row => row.id).filter(entry => ids.includes(entry)).join(',') })
}
function setWeekdays(days: number[] | null) { setQuery({ weekdays: days?.join(',') }) }
function clearSelection() {
  if (editor.busy.value) return
  anchor.value = null
  drawerOpen.value = false
  setQuery({ [words.rows]: undefined, [words.span]: undefined, weekdays: undefined })
}
function closeDrawer(open: boolean) {
  if (editor.busy.value) return
  drawerOpen.value = open
  if (!open) editor.edit('summary')
}

const selectedRows = computed(() => span.value ? rows.value.filter(row => selectedRow(row.id)) : [])
const slice = <T,>(items: T[]) => items.slice(span.value!.start, span.value!.end)
const homeTargets = computed(() => selectedRows.value.flatMap(row => row.home ? [{ home: row.home, nights: slice(row.nights!) }] : []))
const placeTargets = computed(() => selectedRows.value.flatMap(row => row.place ? [{ home: row.place, nights: slice(row.days!) }] : []))
const targets = computed(() => homesView ? homeTargets.value : placeTargets.value)
const editorOptions = {
  orgSlug,
  weekdays,
  manage: () => Boolean(data.value?.manage),
  loading: () => status.value === 'pending',
  refresh: async () => {
    await refresh()
    if (error.value) throw error.value
  },
}
const editor = homesView
  ? useStayNightEditor<Home, StayNight>({ ...editorOptions, source: stayNightSource, targets: homeTargets })
  : useStayNightEditor<Place, PlaceDay>({ ...editorOptions, source: placeDaySource, targets: placeTargets })
const dayCount = computed(() => span.value ? span.value.end - span.value.start : 0)
const selectionLabel = computed(() => {
  if (!span.value) return ''
  const first = dates.value[span.value.start]!
  const last = dates.value[span.value.end - 1]!
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  return `${formatCalendarDate(first, 'en', options)}${first === last ? '' : ` – ${formatCalendarDate(last, 'en', options)}`}`
})
const countLabel = (count: number) => `${count} ${count === 1 ? words.unit : words.units}`
const scopeLabel = computed(() => `${targets.value.length === 1 ? ('internal_name' in targets.value[0]!.home ? targets.value[0]!.home.internal_name : targets.value[0]!.home.name) : `${targets.value.length} ${words.rows}`} · ${countLabel(dayCount.value)}`)
/** What blocks the one selected row's days: a minimum's gap at a home (its action selects the run), or the hours at a place (its action opens them). */
const blocker = computed(() => {
  if (!span.value || selectedRows.value.length !== 1) return null
  const row = selectedRows.value[0]!
  if (row.home) {
    const gap = row.gaps.get(span.value.start)
    return gap && span.value.end <= gap.end ? { text: gap.text, gap, rowIndex: rows.value.indexOf(row), action: null } : null
  }
  const place = row.place!
  const held = slice(row.days!).find(day => day.held && day.held.kind !== 'booked')?.held
  if (!held) return null
  const action = place.kind === 'location'
    ? { label: 'Edit hours', to: `/dashboard/${orgSlug}/locations/${place.slug}/hours` }
    : place.provider
      ? { label: 'Bookable times', to: `/dashboard/${orgSlug}/team/${place.provider.member_id}/hours` }
      : { label: 'Repeating times', to: `/dashboard/${orgSlug}/products/${place.id}/booking/schedule` }
  return { text: held.text, gap: null, rowIndex: -1, action }
})
async function fixBlocker() {
  const value = blocker.value
  if (!value?.gap) return
  // The run's own nights, then its minimum: the selection change resets the inspector, so the leaf opens after it lands.
  await router.replace({ query: { ...route.query, [words.rows]: rows.value[value.rowIndex]!.id, [words.span]: `${dates.value[value.gap.start]}..${addLocalDays(dates.value[value.gap.end - 1]!, 1)}`, weekdays: undefined } })
  await nextTick()
  editor.edit('minimum')
}
const inspectorProps = computed(() => ({
  blocker: blocker.value?.text ?? null,
  blockerAction: blocker.value?.action ?? null,
  ...editor.inspector.value,
  dateLabel: selectionLabel.value,
  scope: scopeLabel.value,
  calendarTo: selectedRows.value.length === 1 && span.value ? selectedRows.value[0]!.home ? homeTo(selectedRows.value[0]!.home!.product_id, dates.value[span.value.start]) : placeTo(selectedRows.value[0]!.place!, dates.value[span.value.start]!) : undefined,
  addStayTo: addStayTo.value,
}))
/** One home's selected nights as a stay to record: the creation page, with the home, check-in and checkout filled in. A stay is every night in the span, so a weekday narrowing or a held night in it offers none. */
const addStayTo = computed(() => {
  const row = selectedRows.value.length === 1 && span.value && !weekdays.value && data.value?.manage ? selectedRows.value[0]! : undefined
  const home = row?.home
  if (!home || slice(row!.cells).some(cell => cell.held)) return undefined
  return { path: `/dashboard/${orgSlug}/bookings/stay/new`, query: { product_id: home.product_id, check_in_date: dates.value[span.value!.start]!, check_out_date: addLocalDays(dates.value[span.value!.end - 1]!, 1) } }
})
/** The selection on one row: a pill over each run of writable days, broken around held ones, the first piece counting what a save writes. */
function pills(row: number) {
  if (!span.value || !selectedRow(rows.value[row]!.id)) return []
  const pieces: { column: number; span: number; label: string }[] = []
  const cells = rows.value[row]!.cells
  for (let index = span.value.start; index < span.value.end; index++) {
    if (cells[index]!.held) continue
    const last = pieces.at(-1)
    if (last && last.column + last.span === index + 1) last.span += 1
    else pieces.push({ column: index + 1, span: 1, label: '' })
  }
  const free = slice(cells).filter(cell => !cell.held)
  const chosen = free.filter(cell => chosenWeekday(cell.date)).length
  if (pieces[0]) pieces[0].label = weekdays.value ? `${chosen} of ${countLabel(free.length)}` : countLabel(free.length)
  return pieces
}
// Filters can remove the row the keyboard cursor was on; keep one day in the tab order.
watch(() => rows.value.length, length => { if (cursor.value.row >= length) cursor.value = { row: Math.max(0, length - 1), day: cursor.value.day } })
watch([search, () => editor.busy.value], ([value, busy]) => { if (!busy) appliedSearch.value = value })
watch(() => route.query[words.rows] === undefined ? null : `${String(route.query[words.rows])}|${String(route.query[words.span])}`, () => editor.edit('summary'))

const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  if (homesView && (event?.type === 'stay.changed' || event?.type === 'nights.changed') && !editor.busy.value) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0 && !editor.busy.value) void refresh() })
</script>
