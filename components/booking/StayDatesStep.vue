<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- What to choose next, and the nights chosen so far. -->
    <div class="flex shrink-0 items-start justify-between gap-4 px-1 pb-3" :class="inline ? undefined : 'border-b border-default'">
      <div class="min-w-0">
        <p class="saya-display text-default" :class="inline ? 'text-2xl sm:text-3xl' : 'text-xl'">{{ heading }}</p>
        <p class="mt-0.5 text-muted" :class="inline ? 'text-sm' : 'text-xs'">{{ subheading }}</p>
      </div>
      <button v-if="checkIn && !inline" type="button" class="shrink-0 text-[11px] font-medium uppercase tracking-[0.2em] text-primary" @click="clearDates">{{ t('stay.clear_dates') }}</button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto py-4">
      <div v-if="calendarPending && !calendar" class="grid grid-cols-7 gap-2">
        <div v-for="i in 35" :key="i" class="size-10 animate-pulse rounded-full bg-muted" />
      </div>
      <p v-else-if="calendarError" role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ calendarError }}</p>
      <template v-else-if="calendar">
        <!-- On the page, Airbnb shows two months side by side; the dialog shows one. -->
        <div class="grid gap-8" :class="inline ? 'md:grid-cols-2' : undefined">
          <div v-for="(month, index) in months" :key="month.first" :class="index > 0 ? 'hidden md:block' : undefined">
            <div class="mb-3 flex items-center justify-between">
              <button type="button" class="flex size-9 items-center justify-center rounded-full border border-default disabled:opacity-30" :class="index > 0 ? 'invisible' : undefined" :disabled="monthOffset === 0" :aria-label="t('stay.previous_month')" @click="monthOffset--">
                <TenantIcon name="chevron-left" class="size-4" />
              </button>
              <span class="saya-display text-lg">{{ month.label }}</span>
              <button type="button" class="flex size-9 items-center justify-center rounded-full border border-default disabled:opacity-30" :class="index < months.length - 1 ? 'md:invisible' : undefined" :disabled="monthOffset + index >= lastMonthOffset" :aria-label="t('stay.next_month')" @click="monthOffset++">
                <TenantIcon name="chevron-right" class="size-4" />
              </button>
            </div>
            <div class="grid grid-cols-7 justify-items-center gap-y-1">
              <span v-for="day in weekdayLabels" :key="day" class="pb-1.5 text-[10px] uppercase tracking-[0.2em] text-muted">{{ day }}</span>
              <span v-for="n in month.leadingBlanks" :key="`blank-${n}`" />
              <button
                v-for="day in month.days"
                :key="day.date"
                type="button"
                class="relative flex size-10 items-center justify-center text-sm transition-colors"
                :class="[
                  day.inRange ? 'bg-muted' : '',
                  day.edge ? 'rounded-full bg-inverted text-inverted' : 'rounded-full',
                  day.selectable ? 'cursor-pointer text-default hover:border hover:border-inverted' : 'cursor-default text-muted/50 line-through',
                ]"
                :disabled="!day.selectable"
                :aria-pressed="day.edge"
                :aria-label="day.ariaLabel"
                :title="day.hint || undefined"
                @click="selectDay(day.date)"
              >
                {{ day.number }}
              </button>
            </div>
          </div>
        </div>
        <p v-if="checkIn && !checkOut && minNights > 1" class="mt-4 text-xs text-muted">{{ t('stay.min_nights', { count: minNights }) }}</p>
      </template>

      <button v-if="inline && checkIn" type="button" class="mt-4 text-sm font-semibold text-default underline underline-offset-4" @click="clearDates">{{ t('stay.clear_dates') }}</button>

      <!-- The party. Infants stay with their family and do not count toward the home's guests. -->
      <template v-if="!inline">
      <div class="mt-6 divide-y divide-default border-y border-default">
        <div v-for="row in guestRows" :key="row.key" class="flex items-center justify-between gap-4 py-3">
          <div>
            <div class="text-sm font-medium text-default">{{ row.label }}</div>
            <div class="text-xs text-muted">{{ row.hint }}</div>
          </div>
          <div class="flex shrink-0 items-center gap-3">
            <button type="button" class="flex size-8 items-center justify-center rounded-full border border-default disabled:opacity-30" :disabled="row.value.value <= row.min" :aria-label="`${row.label} −`" @click="row.value.value--">
              <TenantIcon name="minus" class="size-3.5" />
            </button>
            <span class="min-w-6 text-center tabular-nums">{{ row.value.value }}</span>
            <button type="button" class="flex size-8 items-center justify-center rounded-full border border-default disabled:opacity-30" :disabled="row.value.value >= row.max" :aria-label="`${row.label} +`" @click="row.value.value++">
              <TenantIcon name="plus" class="size-3.5" />
            </button>
          </div>
        </div>
      </div>
      <p class="mt-2 text-xs text-muted">{{ t('stay.max_guests', { count: maxGuests }) }}</p>

      <dl v-if="quote" class="mt-6 space-y-2 text-sm">
        <div v-for="line in breakdown" :key="line.label" class="flex justify-between gap-4">
          <dt class="text-muted underline decoration-dotted underline-offset-4">{{ line.label }}</dt>
          <dd class="tabular-nums text-default">{{ line.amount }}</dd>
        </div>
        <div class="flex justify-between gap-4 border-t border-default pt-3 font-semibold">
          <dt>{{ t('stay.total') }}</dt>
          <dd class="tabular-nums">{{ money(quote.total_minor) }}</dd>
        </div>
      </dl>
      </template>
      <p v-if="bookingError" role="alert" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
    </div>

    <div v-if="!inline" class="flex shrink-0 items-center justify-between gap-4 border-t border-default px-1 py-4">
      <div class="min-w-0">
        <div v-if="quote" class="saya-display saya-italic truncate text-lg">{{ rangeLabel }}</div>
        <div class="mt-0.5 text-xs text-muted">{{ quote ? `${nightsLabel(quote.nights)} · ${guestsLabel}` : checkout ? t('stay.charged_in_full') : t('stay.enquiry_note') }}</div>
      </div>
      <TenantButton v-if="checkout" size="lg" class="shrink-0" :disabled="!quote || quotePending" @click="$emit('next')">{{ t('stay.reserve') }}</TenantButton>
      <TenantButton v-else size="lg" class="shrink-0" :to="enquiryPath">{{ t('stay.send_enquiry') }}</TenantButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { StayBookingController } from '~/composables/useStayBooking'
import { addLocalDays, formatCalendarDate } from '~/utils/timezone'

const props = defineProps<{ controller: StayBookingController; /** On the page beside the listing rather than in the booking dialog: two months, no party or total. */ inline?: boolean; place?: string }>()
defineEmits<{ next: [] }>()
const { calendar, calendarPending, calendarError, checkIn, checkOut, adults, children, infants, maxGuests, quote, quotePending, bookingError,
  nightCount, breakdown, rangeLabel, guestsLabel, canCheckIn, canCheckOut, selectDay, clearDates, money, nightsLabel, dateLabel, checkout, enquiryPath } = props.controller
const { t, locale } = useI18n()
// The nights are read once the calendar is on screen: inline on the page, and in the dialog however it opened, including a press made before hydration.
onMounted(() => { if (!calendar.value) void props.controller.loadCalendar() })

const today = computed(() => calendar.value?.home.today ?? new Date().toISOString().slice(0, 10))
const offsetForDate = (dateStr: string | null | undefined): number => {
  if (!dateStr) return 0
  const [fromYear, fromMonth] = today.value.split('-').map(Number) as [number, number]
  const [toYear, toMonth] = dateStr.split('-').map(Number) as [number, number]
  return Math.max(0, (toYear - fromYear) * 12 + (toMonth - fromMonth))
}
const monthOffset = ref(offsetForDate(checkIn.value))
watch(calendar, () => {
  if (checkIn.value && monthOffset.value === 0) {
    monthOffset.value = offsetForDate(checkIn.value)
  }
})
const firstOfMonth = (offset: number) => {
  const [year, month] = today.value.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10)
}
const lastMonthOffset = computed(() => {
  const last = calendar.value?.nights.at(-1)?.date
  if (!last) return 0
  const [fromYear, fromMonth] = today.value.split('-').map(Number) as [number, number]
  const [toYear, toMonth] = last.split('-').map(Number) as [number, number]
  return (toYear - fromYear) * 12 + (toMonth - fromMonth)
})
const weekdayLabels = computed(() => Array.from({ length: 7 }, (_, index) => formatCalendarDate(addLocalDays('2026-01-04', index), locale.value, { weekday: 'narrow' })))
const minNights = computed(() => (checkIn.value ? props.controller.night(checkIn.value)?.min_stay_arrival : null) ?? calendar.value?.home.min_nights ?? 1)

function monthDays(first: string) {
  const days = []
  const month = first.slice(0, 7)
  for (let date = first; date.startsWith(month); date = addLocalDays(date, 1)) {
    const choosingCheckOut = Boolean(checkIn.value && !checkOut.value)
    const checkout = choosingCheckOut && canCheckOut(date)
    // While checkout is being chosen, a later day is offered only if it can end this stay.
    const selectable = date >= today.value && (choosingCheckOut && date > checkIn.value! ? checkout : canCheckIn(date))
    const edge = date === checkIn.value || date === checkOut.value
    const inRange = Boolean(checkIn.value && checkOut.value && date > checkIn.value && date < checkOut.value)
    const checkoutOnly = checkout && !canCheckIn(date)
    days.push({ date, number: Number(date.slice(8)), selectable, edge, inRange, hint: checkoutOnly ? t('stay.checkout_only') : '', ariaLabel: `${dateLabel(date)}${checkoutOnly ? ` · ${t('stay.checkout_only')}` : ''}` })
  }
  return days
}
const months = computed(() => (props.inline ? [0, 1] : [0]).map((index) => {
  const first = firstOfMonth(monthOffset.value + index)
  return { first, label: formatCalendarDate(first, locale.value, { month: 'long', year: 'numeric' }), leadingBlanks: new Date(`${first}T00:00:00Z`).getUTCDay(), days: monthDays(first) }
}))

// Airbnb's page heading names the place: "3 nights in Santa Monica".
const heading = computed(() => checkIn.value && checkOut.value ? (props.inline && props.place ? t('stay.nights_in', { nights: nightsLabel(nightCount.value), place: props.place }) : nightsLabel(nightCount.value)) : checkIn.value ? t('stay.select_check_out') : t('stay.select_check_in'))
const subheading = computed(() => checkIn.value && checkOut.value ? rangeLabel.value : checkIn.value ? `${t('stay.check_in')}: ${dateLabel(checkIn.value)}` : t('stay.add_dates'))

const guestRows = computed(() => [
  { key: 'adults', label: t('stay.adults'), hint: t('stay.adults_hint'), value: adults, min: 1, max: maxGuests.value - children.value },
  { key: 'children', label: t('stay.children'), hint: t('stay.children_hint'), value: children, min: 0, max: maxGuests.value - adults.value },
  { key: 'infants', label: t('stay.infants'), hint: t('stay.infants_hint'), value: infants, min: 0, max: 5 },
])
</script>
