<template>
  <div class="booking-time-step flex min-h-0 flex-1 flex-col">
    <!-- Party size — pinned above the scroll -->
    <div v-if="showPartySize" class="flex shrink-0 items-center justify-between gap-4 border-y border-default px-1 py-3">
      <div>
        <div class="text-[11px] font-medium uppercase tracking-[0.2em] text-default">{{ resolvedGuestsLabel }}</div>
        <div v-if="guestsHint" class="mt-0.5 text-xs text-muted">{{ guestsHint }}</div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <button
          type="button"
          class="flex size-9 items-center justify-center rounded-full border border-default text-default disabled:opacity-30"
          :disabled="guests <= guestsMin"
          :aria-label="t('site.experience_detail.fewer_guests')"
          @click="$emit('update:guests', Math.max(guestsMin, guests - 1))"
        >
          <svg class="size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15" /></svg>
        </button>
        <span class="tenant-display min-w-8 text-center text-2xl">{{ showMinimumAtLimit && guests >= guestsMax ? `${guestsMax}+` : guests }}</span>
        <button
          type="button"
          class="flex size-9 items-center justify-center rounded-full border border-default text-default disabled:opacity-30"
          :disabled="guests >= guestsMax"
          :aria-label="t('site.experience_detail.more_guests')"
          @click="$emit('update:guests', Math.min(guestsMax, guests + 1))"
        >
          <svg class="size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
        </button>
      </div>
    </div>

    <!-- Month bar + calendar toggle -->
    <div class="flex shrink-0 items-center justify-between gap-4 border-b border-default px-1 py-3">
      <div class="flex items-center gap-2">
        <button v-if="month" type="button" class="rounded-full p-2 disabled:opacity-30" :aria-label="t('stay.previous_month')" :disabled="!previousMonth || previousMonth < firstMonth" @click="previousMonth && emit('update:month', previousMonth)">
          <TenantIcon name="chevron-left" class="size-4" />
        </button>
        <span class="tenant-display text-lg">{{ monthLabel }}</span>
        <button v-if="month" type="button" class="rounded-full p-2 disabled:opacity-30" :aria-label="t('stay.next_month')" :disabled="!nextMonth || !lastMonth || nextMonth > lastMonth" @click="nextMonth && emit('update:month', nextMonth)">
          <TenantIcon name="chevron-right" class="size-4" />
        </button>
      </div>
      <button
        type="button"
        class="flex size-9 items-center justify-center rounded-full border border-default text-default transition-colors"
        :class="calOpen ? 'bg-inverted text-inverted border-inverted' : ''"
        :aria-label="calOpen ? t('site.experience_detail.show_list') : t('site.experience_detail.show_calendar')"
        @click="calOpen = !calOpen"
      >
        <svg class="size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><rect x="3" y="5" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M8 3v4M16 3v4M3 10h18"/></svg>
      </button>
    </div>

    <!-- Loading skeleton -->
    <div v-if="loading" class="flex flex-col gap-2 overflow-y-auto py-4">
      <div v-for="i in 4" :key="i" class="h-14 w-full shrink-0 animate-pulse rounded-lg bg-muted" />
    </div>

    <!-- Calendar view -->
    <div v-else-if="calOpen" class="flex-1 overflow-y-auto py-4">
      <div class="grid grid-cols-7 gap-y-2 justify-items-center">
        <span v-for="d in weekdayLabels" :key="d" class="pb-1.5 text-[10px] uppercase tracking-[0.2em] text-muted">{{ d }}</span>
        <span v-for="n in leadingBlanks" :key="`b-${n}`" />
        <button
          v-for="day in calendarDays"
          :key="day.key"
          type="button"
          class="flex size-11 items-center justify-center rounded-full text-sm transition-colors"
          :class="[
            day.hasSeats ? 'text-default cursor-pointer' : 'text-muted/40 cursor-default',
            day.key === selectedDayKey ? 'bg-inverted text-inverted' : '',
            day.isToday && day.key !== selectedDayKey ? 'border border-default' : '',
          ]"
          :disabled="!day.hasSeats"
          @click="jumpToDay(day.key)"
        >
          {{ day.dayNum }}
        </button>
      </div>
    </div>

    <!-- Day-grouped scrollable slot list -->
    <div v-else ref="scrollRef" class="min-h-0 flex-1 overflow-y-auto px-1 py-2">
      <p v-if="days.length === 0" class="py-6 text-sm text-muted">{{ t('stay.no_dates', 1) }}</p>
      <section v-for="day in days" :key="day.key" :ref="(el) => setDayRef(el, day.key)" class="pt-4 first:pt-0">
        <h3 class="tenant-display mb-3 text-lg">{{ day.label }}</h3>
        <!-- Airbnb's times: a grid of pills, the chosen one filled. -->
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <button
            v-for="slot in day.slots"
            :key="slot.product_session_id ?? slot.time_slot"
            type="button"
            :disabled="slot.disabled"
            :aria-label="`${formatTime(slot.time_slot, locale)} ${slot.availabilityLabel}`"
            :aria-pressed="isSelected(day, slot)"
            :title="slot.availabilityLabel"
            class="flex min-h-11 flex-col items-center justify-center rounded-lg border px-2 py-2 text-sm font-medium transition-colors"
            :class="[
              isSelected(day, slot) ? 'border-inverted bg-inverted text-inverted' : slot.disabled ? 'cursor-default border-default text-muted line-through' : 'cursor-pointer border-default text-default hover:border-inverted',
            ]"
            @click="selectSlot(day, slot)"
          >
            {{ formatTime(slot.time_slot, locale) }}
            <span v-if="slot.scarce && !slot.isClosedOrFull" class="text-[11px] font-normal" :class="isSelected(day, slot) ? undefined : 'text-primary'">{{ slot.availabilityLabel }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- Sticky footer -->
    <div class="flex shrink-0 items-center justify-between gap-4 border-t border-default px-1 py-4">
      <div class="min-w-0">
        <template v-if="modelValue">
          <div class="tenant-display tenant-italic truncate text-lg">{{ selectedSummary }}</div>
          <div v-if="showPartySize" class="mt-0.5 text-xs text-muted">{{ showMinimumAtLimit && guests >= guestsMax ? `${guestsMax}+` : guests }} {{ guests === 1 ? resolvedGuestSingular : resolvedGuestPlural }}</div>
        </template>
        <div v-else class="text-sm text-muted">{{ resolvedChooseSeatingLabel }}</div>
      </div>
      <TenantButton size="lg" :disabled="!modelValue" class="shrink-0" @click="$emit('next')">
        {{ resolvedContinueLabel }}
      </TenantButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { parseDate } from '@internationalized/date'
import { formatCalendarDate, formatTime, addLocalDays } from '~/utils/timezone'
export interface RawSlotAvailability {
  time_slot: string
  product_session_id?: string
  capacity: number | null
  remaining: number | null
  is_closed: boolean
  is_full: boolean
}

export interface RawDateAvailability {
  date: string
  slots: RawSlotAvailability[]
}

export interface TimeSlotSelection {
  sessionId?: string
  day: string
  label: string
  time: string
}

const props = withDefaults(defineProps<{
  dates: RawDateAvailability[]
  referenceDate?: string
  month?: string
  lastMonth?: string
  loading?: boolean
  modelValue?: TimeSlotSelection | null
  guests: number
  showPartySize?: boolean
  guestsMin?: number
  showMinimumAtLimit?: boolean
  guestsMax?: number
  guestsLabel?: string
  guestsHint?: string
  guestSingular?: string
  guestPlural?: string
  continueLabel?: string
  chooseSeatingLabel?: string
}>(), {
  showPartySize: true,
  loading: false,
  modelValue: null,
  showMinimumAtLimit: true,
  guestsMin: 1,
  guestsMax: 8,
  guestsHint: '',
})
const { locale, t } = useI18n()
const resolvedGuestsLabel = computed(() => props.guestsLabel || t('site.experience_detail.party_size'))
const resolvedGuestSingular = computed(() => props.guestSingular || t('site.experience_detail.guest'))
const resolvedGuestPlural = computed(() => props.guestPlural || t('site.experience_detail.guests'))
const resolvedContinueLabel = computed(() => props.continueLabel || t('site.experience_detail.continue'))
const resolvedChooseSeatingLabel = computed(() => props.chooseSeatingLabel || t('site.experience_detail.choose_time'))

const emit = defineEmits<{
  'update:modelValue': [value: TimeSlotSelection]
  'update:guests': [value: number]
  'update:month': [value: string]
  next: []
}>()

const calOpen = ref(false)
const scrollRef = ref<HTMLElement | null>(null)
const dayRefs: Record<string, HTMLElement | null> = {}
function setDayRef(el: unknown, key: string) {
  dayRefs[key] = el as HTMLElement | null
}

const referenceDate = computed(() => props.referenceDate ?? props.dates[0]?.date)

function dayLabelFor(dateStr: string): string {
  const formatted = formatCalendarDate(dateStr, locale.value, { day: 'numeric', month: 'long' })
  if (dateStr === referenceDate.value) return t('site.experience_detail.today_date', { date: formatted })
  if (referenceDate.value && dateStr === addLocalDays(referenceDate.value, 1)) return t('site.experience_detail.tomorrow_date', { date: formatted })
  return formatCalendarDate(dateStr, locale.value, { weekday: 'long', day: 'numeric', month: 'long' })
}

const days = computed(() => {
  return props.dates.map((d) => {
    const slots = d.slots.map((s) => {
      const isClosedOrFull = s.is_closed || s.is_full
      const tooSmall = !isClosedOrFull && s.remaining !== null && s.remaining < props.guests
      // A one-guest appointment is never "1 left": scarcity means places in a shared session.
      const scarce = !isClosedOrFull && !tooSmall && s.remaining !== null && s.remaining <= 3 && s.capacity !== null && s.capacity > 1
      const disabled = isClosedOrFull || tooSmall
      const availabilityLabel = s.is_closed
        ? t('site.location.closed')
        : s.is_full
          ? t('site.experience_detail.sold_out')
          : tooSmall
            ? t('site.experience_detail.only_left', { count: s.remaining })
            : scarce
              ? t('site.experience_detail.left', { count: s.remaining })
              : t('site.experience_detail.available')
      return { product_session_id: s.product_session_id, time_slot: s.time_slot, disabled, isClosedOrFull, scarce, availabilityLabel }
    })
    return { key: d.date, label: dayLabelFor(d.date), slots }
  }).filter((d) => d.slots.length > 0)
})

const firstMonth = computed(() => referenceDate.value ? `${referenceDate.value.slice(0, 7)}-01` : '')
const previousMonth = computed(() => props.month ? parseDate(props.month).subtract({ months: 1 }).toString() : null)
const nextMonth = computed(() => props.month ? parseDate(props.month).add({ months: 1 }).toString() : null)
const monthLabel = computed(() => {
  if (props.month) return formatCalendarDate(props.month, locale.value, { month: 'long', year: 'numeric' })
  if (props.dates.length === 0) return ''
  const first = props.dates[0]!.date
  const last = props.dates[props.dates.length - 1]!.date
  const f = formatCalendarDate(first, locale.value, { month: 'long', year: 'numeric' })
  const l = formatCalendarDate(last, locale.value, { month: 'long', year: 'numeric' })
  if (f === l) return f
  return first.slice(0, 4) === last.slice(0, 4)
    ? `${formatCalendarDate(first, locale.value, { month: 'long' })} – ${l}`
    : `${f} – ${l}`
})

const selectedDayKey = computed(() => props.modelValue?.day ?? null)

const selectedSummary = computed(() => {
  if (!props.modelValue) return ''
  const dayPart = props.modelValue.label.split(',')[0]
  return `${dayPart} · ${formatTime(props.modelValue.time, locale.value)}`
})

function isSelected(day: { key: string }, slot: { time_slot: string; product_session_id?: string }): boolean {
  const value = props.modelValue
  return Boolean(value && (slot.product_session_id ? value.sessionId === slot.product_session_id : value.day === day.key && value.time === slot.time_slot))
}

function selectSlot(day: { key: string; label: string }, slot: { time_slot: string; product_session_id?: string; disabled: boolean }) {
  if (slot.disabled) return
  emit('update:modelValue', { sessionId: slot.product_session_id, day: day.key, label: day.label, time: slot.time_slot })
}

function jumpToDay(key: string) {
  calOpen.value = false
  nextTick(() => {
    const el = dayRefs[key]
    const box = scrollRef.value
    if (el && box) box.scrollTop = el.offsetTop - box.offsetTop - 4
  })
}

// ── Calendar view ──────────────────────────────────────────────────────────
const weekdayLabels = computed(() => Array.from({ length: 7 }, (_, index) =>
  formatCalendarDate(addLocalDays('2024-01-07', index), locale.value, { weekday: 'narrow' }),
))

const calendarDays = computed(() => {
  if (!props.month && props.dates.length === 0) return []
  const byKey = Object.fromEntries(days.value.map((d) => [d.key, d]))
  const todayKey = referenceDate.value
  const first = props.month ?? props.dates[0]!.date
  const last = nextMonth.value ? addLocalDays(nextMonth.value, -1) : props.dates[props.dates.length - 1]!.date
  const out: Array<{ key: string; dayNum: number; hasSeats: boolean; isToday: boolean }> = []
  let cursor = first
  while (cursor <= last) {
    const key = cursor
    const day = byKey[key]
    // hasSeats should reflect actual bookable availability (any non-disabled slot), not just presence
    const hasSeats = day ? day.slots?.some((slot: { disabled?: boolean }) => !slot.disabled) : false
    out.push({ key, dayNum: Number(cursor.slice(8)), hasSeats, isToday: key === todayKey })
    cursor = addLocalDays(cursor, 1)
  }
  return out
})

const leadingBlanks = computed(() => {
  const first = props.month ?? props.dates[0]?.date
  return first ? new Date(`${first}T00:00:00Z`).getUTCDay() : 0
})
</script>
