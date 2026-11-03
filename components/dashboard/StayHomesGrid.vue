<template>
  <!--
    Every home on one screen, as Airbnb's multi-calendar: homes are rows, nights
    are columns. A stay is a bar across the nights it holds; a free night shows
    its price. Dragging (or clicking a first and a last night) selects the same
    nights on every home crossed, and the night inspector edits them in place.
  -->
  <div>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <USelect :model-value="city" :items="cityItems" icon="i-lucide-building-2" aria-label="City" class="min-w-44" :ui="{ base: 'rounded-full' }" @update:model-value="setQuery({ city: $event === ALL_CITIES ? undefined : String($event) })" />
      <UInput :model-value="search" icon="i-lucide-search" placeholder="Search homes" aria-label="Search homes" class="w-full sm:w-72" :ui="{ base: 'rounded-full' }" @update:model-value="setQuery({ q: String($event ?? '').trim() || undefined })" />
      <UButton label="No upcoming stays" :aria-pressed="freeOnly" color="neutral" :variant="freeOnly ? 'solid' : 'outline'" class="rounded-full" @click="setQuery({ free: freeOnly ? undefined : '1' })" />
    </div>
    <div :class="selection && pane ? 'grid grid-cols-[minmax(0,1fr)_24rem] items-start gap-6' : undefined">
      <div class="min-w-0">
        <header class="flex items-center justify-between py-2">
          <h2 class="text-base font-semibold text-highlighted">{{ windowLabel }}</h2>
          <div class="flex items-center gap-1">
            <UButton icon="i-lucide-chevrons-left" color="neutral" variant="ghost" square class="size-10 justify-center rounded-full" aria-label="Previous month" @click="step(-30)" />
            <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" square class="size-10 justify-center rounded-full" aria-label="Previous week" @click="step(-7)" />
            <UButton label="Today" color="neutral" variant="ghost" class="h-10 rounded-full px-4" @click="goToToday" />
            <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" square class="size-10 justify-center rounded-full" aria-label="Next week" @click="step(7)" />
            <UButton icon="i-lucide-chevrons-right" color="neutral" variant="ghost" square class="size-10 justify-center rounded-full" aria-label="Next month" @click="step(30)" />
          </div>
        </header>
        <UAlert v-if="error" color="error" variant="soft" title="The homes calendar could not be loaded" :description="getErrorMessage(error, 'Calendar request failed')" :actions="[{ label: 'Try again', color: 'neutral', variant: 'soft', onClick: () => refresh() }]" />
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
        <p v-else-if="data && !rows.length" class="py-10 text-center text-sm text-muted">{{ search || freeOnly || city !== ALL_CITIES ? 'No homes match these filters.' : 'No homes yet.' }}</p>
        <div v-else-if="data" class="overflow-x-auto rounded-xl shadow-sm ring ring-default" :aria-busy="status === 'pending'" data-testid="stay-homes-grid">
          <div
            ref="gridElement"
            class="grid w-max select-none [--home-column:8rem] sm:[--home-column:14rem]"
            role="grid"
            aria-label="Nights at every home"
            :aria-multiselectable="true"
            :style="{ gridTemplateColumns: `var(--home-column) repeat(${dates.length}, 4rem)` }"
            @pointermove="dragTo"
          >
            <div role="row" class="contents">
              <div role="columnheader" class="sticky left-0 z-20 border-b border-r border-default bg-default" />
              <div v-for="day in dates" :key="day" role="columnheader" class="border-b border-default px-1 py-2 text-center text-xs" :class="day === todayKey ? 'bg-primary/10' : 'bg-default'">
                <span class="block text-muted">{{ day.endsWith('-01') || day === dates[0] ? formatCalendarDate(day, 'en', { month: 'short' }) : formatCalendarDate(day, 'en', { weekday: 'short' }) }}</span>
                <span class="block font-semibold" :class="day === todayKey ? 'text-primary' : 'text-highlighted'">{{ Number(day.slice(-2)) }}</span>
              </div>
            </div>
            <div v-for="(row, rowIndex) in rows" :key="row.home.product_id" role="row" class="contents">
              <div role="rowheader" class="sticky left-0 z-20 flex min-w-0 items-center gap-2 border-b border-r border-default bg-default px-3 py-2" :class="selectedHome(row.home.product_id) ? 'shadow-[inset_3px_0_0_var(--ui-primary)]' : undefined">
                <UCheckbox v-if="selection" :model-value="selectedHome(row.home.product_id)" :aria-label="`Include ${row.home.name}`" :disabled="editor.busy.value" @update:model-value="includeHome(row.home.product_id, Boolean($event))" />
                <NuxtLink :to="homeTo(row.home.product_id)" class="flex min-w-0 flex-col hover:underline" :data-home="row.home.product_id">
                  <span class="truncate text-sm font-medium text-highlighted">{{ row.home.name }}</span>
                  <span class="truncate text-xs text-muted">{{ addressOf(row.home) }}</span>
                </NuxtLink>
              </div>
              <div class="relative grid border-b border-default" :data-row-index="rowIndex" :style="{ gridColumn: `2 / span ${dates.length}`, gridTemplateColumns: `repeat(${dates.length}, 4rem)` }">
                <button
                  v-for="(night, index) in row.nights"
                  :key="night.date"
                  type="button"
                  role="gridcell"
                  :aria-selected="inSelection(rowIndex, index)"
                  :aria-label="nightTitle(row.home, night)"
                  :tabindex="cursor.row === rowIndex && cursor.day === index ? 0 : -1"
                  class="relative flex h-14 flex-col justify-end border-r border-default px-1.5 py-1 text-left text-xs tabular-nums outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-inverted"
                  :class="[night.available ? 'bg-default text-highlighted' : 'bg-elevated/60 text-muted', inSelection(rowIndex, index) && !chosenWeekday(night.date) ? 'text-dimmed' : '']"
                  :style="{ gridRow: 1, gridColumn: index + 1 }"
                  :title="nightTitle(row.home, night)"
                  :data-night="night.date"
                  @pointerdown="startDrag($event, rowIndex, index)"
                  @click="choose(rowIndex, index)"
                  @keydown="keydown($event, rowIndex, index)"
                  @focus="cursor = { row: rowIndex, day: index }"
                >
                  <UIcon v-if="channelState(night)" :name="CHANNEL_MARKS[channelState(night)!]" class="absolute right-1 top-1 size-3" :class="channelState(night) === 'pending' ? 'text-muted' : 'text-warning'" :data-testid="`stay-homes-channel-${channelState(night)}`" aria-hidden="true" />
                  <span v-if="!isBookedNight(night) || night.held_until" class="truncate" :class="night.closed ? 'line-through' : ''">{{ freeLabel(row.home, night) }}</span>
                </button>
                <div
                  v-for="(piece, pieceIndex) in pills(rowIndex)"
                  :key="piece.column"
                  class="pointer-events-none z-[5] mx-0.5 mt-1.5 flex h-7 min-w-0 items-center self-start rounded-full bg-accented px-2.5 text-xs font-semibold text-highlighted ring-2 ring-inset ring-inverted"
                  :style="{ gridRow: 1, gridColumn: `${piece.column} / span ${piece.span}` }"
                  data-testid="stay-homes-selection"
                  aria-hidden="true"
                >
                  <span v-if="pieceIndex === 0" class="truncate">{{ piece.label }}</span>
                </div>
                <NuxtLink
                  v-for="bar in row.bars"
                  :key="bar.key"
                  :to="bar.to"
                  class="z-10 mx-0.5 mt-1.5 flex h-7 min-w-0 items-center gap-1.5 self-start rounded-full px-2.5 text-xs font-medium text-white"
                  :style="{ gridRow: 1, gridColumn: `${bar.column} / span ${bar.span}`, backgroundColor: CHANNEL_BARS[bar.channel ?? 'direct'].color }"
                  :title="bar.title"
                  :data-stay="bar.stayId"
                  :data-channel="bar.channel"
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
      <aside v-if="selection && pane && targets.length" class="sticky top-4 rounded-2xl p-5 ring ring-default">
        <StayNightInspector v-bind="inspectorProps" v-on="editor.listeners" @clear="clearSelection" @weekdays="setWeekdays" />
      </aside>
    </div>
    <div v-if="selection && !pane && !drawerOpen" class="fixed inset-x-3 bottom-20 z-30 flex items-center justify-between gap-3 rounded-xl bg-inverted px-4 py-3 text-sm font-medium text-inverted shadow-lg" data-testid="stay-homes-hint">
      <span class="min-w-0 truncate">{{ awaitingEnd ? `${formatCalendarDate(selection.from, 'en', { weekday: 'short', month: 'short', day: 'numeric' })} · tap the last night` : `${selectionLabel} · ${scopeLabel}` }}</span>
      <div class="flex shrink-0 items-center gap-1">
        <UButton label="Edit" color="neutral" variant="solid" class="bg-default text-highlighted hover:bg-elevated" @click="drawerOpen = true" />
        <UButton label="Cancel" color="neutral" variant="link" class="text-inverted" @click="clearSelection" />
      </div>
    </div>
    <UDrawer
      v-if="selection && !pane && targets.length"
      :open="drawerOpen"
      title="Selected nights"
      :description="`${selectionLabel} · ${scopeLabel}`"
      :dismissible="!editor.busy.value"
      no-body-styles
      handle-only
      :ui="{ content: 'max-h-[85dvh] rounded-t-3xl', body: 'overflow-y-auto' }"
      @update:open="closeDrawer"
    >
      <template #body>
        <StayNightInspector v-bind="inspectorProps" v-on="editor.listeners" @clear="clearSelection" @weekdays="setWeekdays" />
      </template>
    </UDrawer>
  </div>
</template>

<script setup lang="ts">
import { getLocalTimeZone, parseDate, today } from '@internationalized/date'
import { useEventListener } from '@vueuse/core'
import type { LocationQueryRaw } from 'vue-router'
import type { Stay, StayHome, StayNight, StayTurnover } from '~/server/domain/stays'
import { MAX_STAY_NIGHTS, STAY_CHANNEL_LABELS, parseStayCalendarRules, type StayChannel } from '~/shared/bookings'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'
import { addLocalDays, formatCalendarDate, isValidCalendarDate, isValidTimezone } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { CHANNEL_MARKS, channelNote, isBookedNight, isStayNight, nightWeekday, useStayNightEditor } from '~/composables/useStayNightEditor'
import StayNightInspector from './StayNightInspector.vue'

type Home = Pick<StayHome, 'product_id' | 'name' | 'timezone' | 'currency' | 'base_price_minor' | 'min_nights' | 'calendar_rules' | 'address'>
// A manager reads each stay's surname and channel; a member's turnover has neither.
type GridStay = Pick<StayTurnover, 'id' | 'product_id' | 'guest_name' | 'adults' | 'children' | 'check_in_date' | 'check_out_date'> & Partial<Pick<Stay, 'guest_surname' | 'channel'>>
interface Payload { from: string; to: string; homes: { home: Home; nights: StayNight[] }[]; stays: GridStay[]; manage: boolean }

// Today and thirty nights after it, paged by a week or a month; the URL keeps where you were and what is selected.
const SPAN = 31
const route = useRoute()
const router = useRouter()
const orgSlug = String(route.params.orgSlug)
const api = useDashboardApi()
const pane = useDashboardPane()
const todayKey = today(getLocalTimeZone()).toString()
if (Object.hasOwn(route.query, 'from') && (typeof route.query.from !== 'string' || !isValidCalendarDate(route.query.from))) throw createError({ statusCode: 400, statusMessage: 'Choose a valid first night.' })
const from = computed(() => typeof route.query.from === 'string' ? route.query.from : todayKey)
const to = computed(() => parseDate(from.value).add({ days: SPAN }).toString())
const dates = computed(() => Array.from({ length: SPAN }, (_, index) => parseDate(from.value).add({ days: index }).toString()))
const search = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const freeOnly = computed(() => route.query.free === '1')
// A city from the homes' addresses; NO_CITY is the homes without one.
const ALL_CITIES = '*'
const NO_CITY = '-'
const city = computed(() => typeof route.query.city === 'string' && route.query.city ? route.query.city : ALL_CITIES)

/** The selection: the same nights, [from, to), at each named home, narrowed to weekdays when any are named. */
const selection = computed(() => {
  const { homes, nights } = route.query
  if (homes === undefined && nights === undefined) return null
  const [first, checkout] = typeof nights === 'string' ? nights.split('..') : []
  const ids = typeof homes === 'string' ? homes.split(',').filter(Boolean) : []
  if (!ids.length || !first || !checkout || !isValidCalendarDate(first) || !isValidCalendarDate(checkout) || checkout <= first) throw createError({ statusCode: 400, statusMessage: 'Choose valid homes and nights.' })
  return { homes: ids, from: first, to: checkout }
})
const weekdays = computed<number[] | null>(() => {
  const value = route.query.weekdays
  if (value === undefined) return null
  const days = typeof value === 'string' ? value.split(',').map(Number) : []
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw createError({ statusCode: 400, statusMessage: 'Choose valid weekdays.' })
  return days
})

const isText = (value: unknown) => value === null || typeof value === 'string'
const isCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isAmount = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function isHome(value: unknown): value is Home {
  if (!isRecord(value) || typeof value.product_id !== 'string' || typeof value.name !== 'string' || typeof value.timezone !== 'string' || !isValidTimezone(value.timezone)
    || !isCurrencyCode(value.currency) || !isAmount(value.base_price_minor) || typeof value.min_nights !== 'number' || !Number.isInteger(value.min_nights) || value.min_nights < 1 || value.min_nights > MAX_STAY_NIGHTS
    || !(value.address === null || isRecord(value.address))) return false
  parseStayCalendarRules(value.calendar_rules)
  return true
}
const isPayload = (value: unknown): value is Payload => isRecord(value) && value.from === from.value && value.to === to.value && Array.isArray(value.homes) && Array.isArray(value.stays) && typeof value.manage === 'boolean'
  && value.homes.every(entry => isRecord(entry) && isHome(entry.home) && Array.isArray(entry.nights) && entry.nights.length === SPAN
    && entry.nights.every((night, index) => isStayNight(night) && night.date === dates.value[index]))
  && value.stays.every(stay => isRecord(stay) && typeof stay.id === 'string' && typeof stay.product_id === 'string' && isText(stay.guest_name) && isCount(stay.adults) && isCount(stay.children)
    && (value.manage ? isText(stay.guest_surname) && Object.hasOwn(STAY_CHANNEL_LABELS, String(stay.channel)) : !('guest_surname' in stay) && !('channel' in stay)) && isValidCalendarDate(stay.check_in_date) && isValidCalendarDate(stay.check_out_date))

const { data, error, status, refresh } = await useAsyncData(
  () => `stay-homes-grid:${orgSlug}:${from.value}`,
  (_nuxtApp, { signal }) => api('/api/dashboard/stay-homes/calendar', { query: { from: from.value, to: to.value }, validate: isPayload, signal }),
  {
    getCachedData(cacheKey, nuxtApp, ctx) {
      if (ctx?.cause === 'refresh:manual' || ctx?.cause === 'refresh:hook') return undefined
      return nuxtApp.payload.data[cacheKey] as Payload | undefined
    },
  },
)

if (import.meta.client) {
  onMounted(() => {
    if (useNuxtApp().payload.data[`stay-homes-grid:${orgSlug}:${from.value}`]) void refresh()
  })
}

/** Each channel's bar colour and, where the build has no official mark, the mark it reads. */
const CHANNEL_BARS: Record<StayChannel, { color: string; mark: string }> = {
  airbnb: { color: '#FF385C', mark: '' }, vrbo: { color: '#245ABC', mark: 'V' }, booking_com: { color: '#003580', mark: 'B.' }, direct: { color: 'var(--kc-navy)', mark: '' },
}
const guestName = (stay: GridStay) => [stay.guest_name, stay.guest_surname].filter(Boolean).join(' ') || 'Guest name not provided'
// Adults and children count as guests; infants do not, as Airbnb counts them.
const guestCount = (stay: GridStay) => `${stay.adults + stay.children} ${stay.adults + stay.children === 1 ? 'guest' : 'guests'}`
const addressOf = (home: Home) => home.address ? [home.address.address, home.address.city].filter(Boolean).join(', ') : 'No address'
const cityOf = (home: Home) => home.address?.city?.trim() || null
const cityItems = computed(() => {
  const homes = data.value?.homes ?? []
  const counts = new Map<string, number>()
  for (const { home } of homes) counts.set(cityOf(home) ?? NO_CITY, (counts.get(cityOf(home) ?? NO_CITY) ?? 0) + 1)
  return [
    { label: `All cities (${homes.length})`, value: ALL_CITIES },
    ...[...counts].filter(([name]) => name !== NO_CITY).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ label: `${name} (${count})`, value: name })),
    ...(counts.has(NO_CITY) ? [{ label: `No city (${counts.get(NO_CITY)})`, value: NO_CITY }] : []),
  ]
})
// A stay's bar spans the run of nights it holds on screen; a run cut by the window's edge still names its guest.
// A linked calendar's nights are a bar of their own, named for the channel.
const rows = computed(() => {
  const stays = new Map((data.value?.stays ?? []).map(stay => [stay.id, stay]))
  const query = search.value.toLowerCase()
  return (data.value?.homes ?? [])
    .filter(entry => (city.value === ALL_CITIES || (cityOf(entry.home) ?? NO_CITY) === city.value)
      && (!query || `${entry.home.name} ${addressOf(entry.home)}`.toLowerCase().includes(query))
      && (!freeOnly.value || !entry.nights.some(isBookedNight)))
    .map(({ home, nights }) => {
      const bars: { key: string; stayId: string | null; channel: StayChannel | null; column: number; span: number; label: string; title: string; to: { path: string; query: LocationQueryRaw } }[] = []
      nights.forEach((night, index) => {
        const holder = night.stay_id ?? (night.calendar ? `calendar:${night.calendar}` : null)
        if (!holder) return
        const last = bars.at(-1)
        if (last?.key.startsWith(`${holder}:`) && last.column + last.span === index + 1) { last.span += 1; return }
        if (!night.stay_id) {
          const label = STAY_CHANNEL_LABELS[night.calendar!]
          bars.push({ key: `${holder}:${night.date}`, stayId: null, channel: night.calendar, column: index + 1, span: 1, label, title: `Unavailable from ${label}`, to: homeTo(home.product_id, night.date) })
          return
        }
        const stay = stays.get(night.stay_id)
        const label = stay ? `${guestName(stay)} · ${guestCount(stay)}` : 'Reserved'
        bars.push({ key: `${holder}:${night.date}`, stayId: night.stay_id, channel: stay?.channel ?? null, column: index + 1, span: 1, label,
          to: { path: `/dashboard/${orgSlug}/calendar/stay/${encodeURIComponent(night.stay_id)}`, query: route.query },
          title: stay ? `${[label, ...(stay.channel ? [STAY_CHANNEL_LABELS[stay.channel]] : [])].join(' · ')} · ${formatCalendarDate(stay.check_in_date, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(stay.check_out_date, 'en', { month: 'short', day: 'numeric' })}` : label })
      })
      return { home, nights, bars }
    })
})

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
function nightTitle(home: Home, night: StayNight) {
  const state = night.stay_id ? 'Booked' : night.held_until ? 'Checkout hold' : night.calendar ? `Unavailable from ${STAY_CHANNEL_LABELS[night.calendar]}` : night.closed ? 'Blocked' : 'Available'
  const note = channelNote(night)
  return `${home.name} · ${formatCalendarDate(night.date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })} · ${state} · ${price(home, night)}${note ? ` · ${note}` : night.channel?.state === 'pushed' ? ' · On Airbnb' : ''}`
}
function homeTo(productId: string, date?: string) {
  return { path: `/dashboard/${orgSlug}/calendar`, query: { product_id: productId, ...(date ? { month: date.slice(0, 7), date } : {}) } }
}
function setQuery(changes: LocationQueryRaw) {
  void router.replace({ query: { ...route.query, ...changes } })
}
function moveTo(day: string) {
  setQuery({ from: day === todayKey ? undefined : day, homes: undefined, nights: undefined, weekdays: undefined })
}
function step(count: number) { moveTo(parseDate(from.value).add({ days: count }).toString()) }
function goToToday() { moveTo(todayKey) }

// Selecting: a first night anchors the selection; a second night, a drag or Shift with an arrow spans every home and night between them.
const anchor = ref<{ home: string; day: number } | null>(null)
const cursor = ref({ row: 0, day: 0 })
const drawerOpen = ref(false)
const gridElement = useTemplateRef<HTMLElement>('gridElement')
const drag = ref<{ row: number; day: number; moved: boolean } | null>(null)
let suppressClick = false
const selectedHome = (productId: string) => Boolean(selection.value?.homes.includes(productId))
const span = computed(() => {
  const value = selection.value
  if (!value) return null
  const start = Math.max(0, dates.value.indexOf(value.from) === -1 ? (value.from < from.value ? 0 : SPAN) : dates.value.indexOf(value.from))
  const end = value.to > to.value ? SPAN : dates.value.indexOf(value.to) === -1 ? SPAN : dates.value.indexOf(value.to)
  return end > start ? { start, end } : null
})
const inSelection = (row: number, day: number) => Boolean(span.value && selectedHome(rows.value[row]!.home.product_id) && day >= span.value.start && day < span.value.end)
const chosenWeekday = (date: string) => !weekdays.value || weekdays.value.includes(nightWeekday(date))
const awaitingEnd = computed(() => Boolean(anchor.value && selection.value?.homes.length === 1 && span.value && span.value.end - span.value.start === 1))
function select(rowA: number, dayA: number, rowB: number, dayB: number) {
  const [top, bottom] = rowA <= rowB ? [rowA, rowB] : [rowB, rowA]
  const [first, last] = dayA <= dayB ? [dayA, dayB] : [dayB, dayA]
  setQuery({ homes: rows.value.slice(top, bottom + 1).map(row => row.home.product_id).join(','), nights: `${dates.value[first]}..${addLocalDays(dates.value[last]!, 1)}`, weekdays: undefined })
}
function choose(row: number, day: number) {
  if (suppressClick) { suppressClick = false; return }
  const start = anchor.value && rows.value.findIndex(entry => entry.home.product_id === anchor.value!.home)
  if (anchor.value && awaitingEnd.value && typeof start === 'number' && start >= 0 && !(start === row && anchor.value.day === day)) {
    select(start, anchor.value.day, row, day)
    anchor.value = null
    drawerOpen.value = true
    return
  }
  anchor.value = { home: rows.value[row]!.home.product_id, day }
  select(row, day, row, day)
}
function startDrag(event: PointerEvent, row: number, day: number) {
  suppressClick = false
  if (event.button !== 0 || event.pointerType === 'touch') return
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
  if (!anchor.value) anchor.value = { home: rows.value[row]!.home.product_id, day }
  const start = rows.value.findIndex(entry => entry.home.product_id === anchor.value!.home)
  if (start >= 0) select(start, anchor.value.day, next.row, next.day)
}
function includeHome(productId: string, include: boolean) {
  const homes = (selection.value?.homes ?? []).filter(id => id !== productId)
  if (include) homes.push(productId)
  if (!homes.length) { clearSelection(); return }
  setQuery({ homes: rows.value.map(row => row.home.product_id).filter(id => homes.includes(id)).join(',') })
}
function setWeekdays(days: number[] | null) { setQuery({ weekdays: days?.join(',') }) }
function clearSelection() {
  if (editor.busy.value) return
  anchor.value = null
  drawerOpen.value = false
  setQuery({ homes: undefined, nights: undefined, weekdays: undefined })
}
function closeDrawer(open: boolean) {
  if (editor.busy.value) return
  drawerOpen.value = open
  if (!open) editor.edit('summary')
}

const targets = computed(() => {
  if (!span.value) return []
  return rows.value.filter(row => selectedHome(row.home.product_id)).map(row => ({ home: row.home, nights: row.nights.slice(span.value!.start, span.value!.end) }))
})
const editor = useStayNightEditor({
  orgSlug,
  targets,
  weekdays,
  manage: () => Boolean(data.value?.manage),
  loading: () => status.value === 'pending',
  refresh: async () => {
    await refresh()
    if (error.value) throw error.value
  },
})
const nightCount = computed(() => span.value ? span.value.end - span.value.start : 0)
const selectionLabel = computed(() => {
  if (!span.value) return ''
  const first = dates.value[span.value.start]!
  const last = dates.value[span.value.end - 1]!
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  return `${formatCalendarDate(first, 'en', options)}${first === last ? '' : ` – ${formatCalendarDate(last, 'en', options)}`}`
})
const nightsLabel = (count: number) => `${count} ${count === 1 ? 'night' : 'nights'}`
const scopeLabel = computed(() => `${targets.value.length === 1 ? targets.value[0]!.home.name : `${targets.value.length} homes`} · ${nightsLabel(nightCount.value)}`)
const inspectorProps = computed(() => ({
  ...editor.inspector.value,
  dateLabel: selectionLabel.value,
  scope: scopeLabel.value,
  calendarTo: targets.value.length === 1 && span.value ? homeTo(targets.value[0]!.home.product_id, dates.value[span.value.start]) : undefined,
}))
/** The selection on one row: a pill over each run of free nights, broken around booked ones, the first piece counting what a save writes. */
function pills(row: number) {
  if (!span.value || !selectedHome(rows.value[row]!.home.product_id)) return []
  const pieces: { column: number; span: number; label: string }[] = []
  const nights = rows.value[row]!.nights
  for (let index = span.value.start; index < span.value.end; index++) {
    if (isBookedNight(nights[index]!)) continue
    const last = pieces.at(-1)
    if (last && last.column + last.span === index + 1) last.span += 1
    else pieces.push({ column: index + 1, span: 1, label: '' })
  }
  const free = nights.slice(span.value.start, span.value.end).filter(night => !isBookedNight(night))
  const chosen = free.filter(night => chosenWeekday(night.date)).length
  if (pieces[0]) pieces[0].label = weekdays.value ? `${chosen} of ${nightsLabel(free.length)}` : nightsLabel(free.length)
  return pieces
}
watch(() => route.query.homes === undefined ? null : `${String(route.query.homes)}|${String(route.query.nights)}`, () => editor.edit('summary'))

const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  if ((event?.type === 'stay.changed' || event?.type === 'nights.changed') && !editor.busy.value) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0 && !editor.busy.value) void refresh() })
</script>
