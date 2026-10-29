<template>
  <!--
    Every home on one screen, as Airbnb's multi-calendar: homes are rows, nights
    are columns. A stay is a bar across the nights it holds; a free night shows
    its price. Any night opens that home's own calendar on that date.
  -->
  <div>
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
    <p v-else-if="data && !rows.length" class="py-10 text-center text-sm text-muted">No homes at this location.</p>
    <div v-else-if="data" class="overflow-x-auto rounded-xl shadow-sm ring ring-default" :aria-busy="status === 'pending'" data-testid="stay-homes-grid">
      <div class="grid w-max [--home-column:8rem] sm:[--home-column:14rem]" :style="{ gridTemplateColumns: `var(--home-column) repeat(${dates.length}, 4rem)` }">
        <div class="sticky left-0 z-20 border-b border-r border-default bg-default" />
        <div v-for="day in dates" :key="day" class="border-b border-default px-1 py-2 text-center text-xs" :class="day === todayKey ? 'bg-primary/10' : 'bg-default'">
          <span class="block text-muted">{{ day.endsWith('-01') || day === dates[0] ? formatCalendarDate(day, 'en', { month: 'short' }) : formatCalendarDate(day, 'en', { weekday: 'short' }) }}</span>
          <span class="block font-semibold" :class="day === todayKey ? 'text-primary' : 'text-highlighted'">{{ Number(day.slice(-2)) }}</span>
        </div>
        <template v-for="row in rows" :key="row.home.product_id">
          <NuxtLink :to="homeTo(row.home.product_id)" class="sticky left-0 z-20 flex min-w-0 flex-col justify-center border-b border-r border-default bg-default px-3 py-2 hover:bg-elevated" :data-home="row.home.product_id">
            <span class="truncate text-sm font-medium text-highlighted">{{ row.home.name }}</span>
            <span class="truncate text-xs text-muted">{{ addressOf(row.home) }}</span>
          </NuxtLink>
          <div class="relative grid border-b border-default" :style="{ gridColumn: `2 / span ${dates.length}`, gridTemplateColumns: `repeat(${dates.length}, 4rem)` }">
            <NuxtLink
              v-for="(night, index) in row.nights"
              :key="night.date"
              :to="homeTo(row.home.product_id, night.date)"
              class="flex h-14 flex-col justify-end border-r border-default px-1.5 py-1 text-xs tabular-nums hover:bg-elevated"
              :class="night.available ? 'bg-default text-highlighted' : 'bg-elevated/60 text-muted'"
              :style="{ gridRow: 1, gridColumn: index + 1 }"
              :title="nightTitle(row.home, night)"
              :data-night="night.date"
            >
              <span v-if="night.stay_id === null" class="truncate" :class="night.closed ? 'line-through' : ''">{{ freeLabel(row.home, night) }}</span>
            </NuxtLink>
            <NuxtLink
              v-for="bar in row.bars"
              :key="bar.key"
              :to="homeTo(row.home.product_id, bar.date)"
              class="z-10 mx-0.5 mt-1.5 flex h-7 min-w-0 items-center self-start rounded-full bg-inverted px-2.5 text-xs font-medium text-inverted"
              :style="{ gridRow: 1, gridColumn: `${bar.column} / span ${bar.span}` }"
              :title="bar.title"
              :data-stay="bar.stayId"
            >
              <span class="truncate">{{ bar.label }}</span>
            </NuxtLink>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getLocalTimeZone, parseDate, today } from '@internationalized/date'
import type { Stay, StayHome, StayNight, StayTurnover } from '~/server/domain/stays'
import { STAY_CHANNEL_LABELS } from '~/shared/bookings'
import { isCurrencyCode } from '~/shared/currencies'
import { minorAmountToMajor } from '~/shared/prices'
import { formatCalendarDate, isValidCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ locationId: string | null }>()

type Home = Pick<StayHome, 'product_id' | 'name' | 'location_id' | 'currency' | 'address'>
// A manager reads each stay's surname and channel; a member's turnover has neither.
type GridStay = Pick<StayTurnover, 'id' | 'product_id' | 'guest_name' | 'check_in_date' | 'check_out_date'> & Partial<Pick<Stay, 'guest_surname' | 'channel'>>
type Night = Pick<StayNight, 'date' | 'available' | 'stay_id' | 'closed' | 'price_minor' | 'held_until' | 'calendar'>
interface Payload { from: string; to: string; homes: { home: Home; nights: Night[] }[]; stays: GridStay[]; manage: boolean }

// Today and thirty nights after it, paged by a week or a month; the URL keeps where you were.
const SPAN = 31
const route = useRoute()
const router = useRouter()
const api = useDashboardApi()
const todayKey = today(getLocalTimeZone()).toString()
if (Object.hasOwn(route.query, 'from') && (typeof route.query.from !== 'string' || !isValidCalendarDate(route.query.from))) throw createError({ statusCode: 400, statusMessage: 'Choose a valid first night.' })
const from = computed(() => typeof route.query.from === 'string' ? route.query.from : todayKey)
const to = computed(() => parseDate(from.value).add({ days: SPAN }).toString())
const dates = computed(() => Array.from({ length: SPAN }, (_, index) => parseDate(from.value).add({ days: index }).toString()))

const isText = (value: unknown) => value === null || typeof value === 'string'
const isPayload = (value: unknown): value is Payload => isRecord(value) && value.from === from.value && value.to === to.value && Array.isArray(value.homes) && Array.isArray(value.stays) && typeof value.manage === 'boolean'
  && value.homes.every(entry => isRecord(entry) && isRecord(entry.home) && typeof entry.home.product_id === 'string' && typeof entry.home.name === 'string' && typeof entry.home.location_id === 'string'
    && isCurrencyCode(entry.home.currency) && (entry.home.address === null || isRecord(entry.home.address)) && Array.isArray(entry.nights) && entry.nights.length === SPAN
    && entry.nights.every((night, index) => isRecord(night) && night.date === dates.value[index] && typeof night.available === 'boolean' && typeof night.closed === 'boolean' && isText(night.stay_id)
      && (night.price_minor === null || typeof night.price_minor === 'number') && isText(night.held_until) && isText(night.calendar)))
  && value.stays.every(stay => isRecord(stay) && typeof stay.id === 'string' && typeof stay.product_id === 'string' && isText(stay.guest_name)
    && (value.manage ? isText(stay.guest_surname) && Object.hasOwn(STAY_CHANNEL_LABELS, String(stay.channel)) : !('guest_surname' in stay) && !('channel' in stay)) && isValidCalendarDate(stay.check_in_date) && isValidCalendarDate(stay.check_out_date))

const { data, error, status, refresh } = await useAsyncData(
  () => `stay-homes-grid:${String(route.params.orgSlug)}:${from.value}`,
  (_nuxtApp, { signal }) => api('/api/dashboard/stay-homes/calendar', { query: { from: from.value, to: to.value }, validate: isPayload, signal }),
)

const guestName = (stay: GridStay) => [stay.guest_name, stay.guest_surname].filter(Boolean).join(' ') || 'Guest name not provided'
// A stay's bar spans the run of nights it holds on screen; a run cut by the window's edge still names its guest.
const rows = computed(() => {
  const stays = new Map((data.value?.stays ?? []).map(stay => [stay.id, stay]))
  return (data.value?.homes ?? []).filter(entry => !props.locationId || entry.home.location_id === props.locationId).map(({ home, nights }) => {
    const bars: { key: string; stayId: string; column: number; span: number; date: string; label: string; title: string }[] = []
    nights.forEach((night, index) => {
      if (!night.stay_id) return
      const last = bars.at(-1)
      if (last?.stayId === night.stay_id && last.column + last.span === index + 1) { last.span += 1; return }
      const stay = stays.get(night.stay_id)
      const label = stay ? guestName(stay) : 'Reserved'
      bars.push({ key: `${night.stay_id}:${night.date}`, stayId: night.stay_id, column: index + 1, span: 1, date: night.date, label,
        title: stay ? `${[label, ...(stay.channel ? [STAY_CHANNEL_LABELS[stay.channel]] : [])].join(' · ')} · ${formatCalendarDate(stay.check_in_date, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(stay.check_out_date, 'en', { month: 'short', day: 'numeric' })}` : label })
    })
    return { home, nights, bars }
  })
})

const windowLabel = computed(() => `${formatCalendarDate(from.value, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(dates.value.at(-1)!, 'en', { month: 'short', day: 'numeric', year: 'numeric' })}`)
const addressOf = (home: Home) => home.address ? [home.address.address, home.address.city].filter(Boolean).join(', ') : 'No address'
const price = (home: Home, night: Night) => night.price_minor === null ? 'No price' : minorAmountToMajor(night.price_minor, home.currency).replace(/\.0+$/, '')
function freeLabel(home: Home, night: Night) {
  if (night.held_until) return 'Hold'
  if (night.calendar) return STAY_CHANNEL_LABELS[night.calendar]
  return price(home, night)
}
function nightTitle(home: Home, night: Night) {
  const state = night.stay_id ? 'Booked' : night.held_until ? 'Checkout hold' : night.calendar ? `Unavailable from ${STAY_CHANNEL_LABELS[night.calendar]}` : night.closed ? 'Blocked' : 'Available'
  return `${home.name} · ${formatCalendarDate(night.date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })} · ${state} · ${price(home, night)}`
}
function homeTo(productId: string, date?: string) {
  return { path: `/dashboard/${String(route.params.orgSlug)}/calendar`, query: { product_id: productId, ...(date ? { month: date.slice(0, 7), date } : {}) } }
}
function moveTo(day: string) {
  void router.replace({ query: { ...route.query, from: day === todayKey ? undefined : day } })
}
function step(count: number) { moveTo(parseDate(from.value).add({ days: count }).toString()) }
function goToToday() { moveTo(todayKey) }

const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  if (event?.type === 'stay.changed' || event?.type === 'nights.changed') void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0) void refresh() })
</script>
