<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- What to choose next, and the nights chosen so far. -->
    <div class="flex shrink-0 items-start justify-between gap-4 px-1 pb-3" :class="inline ? undefined : 'border-b border-default'">
      <div class="min-w-0">
        <p class="tenant-display text-default" :class="inline ? 'text-2xl sm:text-3xl' : 'text-xl'">{{ heading }}</p>
        <p class="mt-0.5 text-muted" :class="inline ? 'text-sm' : 'text-xs'">{{ subheading }}</p>
      </div>
      <button v-if="checkIn && !inline" type="button" class="shrink-0 text-[11px] font-medium uppercase tracking-[0.2em] text-primary" @click="clearDates">{{ t('stay.clear_dates') }}</button>
    </div>

    <!-- The dates can be typed as well as pressed: a long stay's checkout is months of paging away. -->
    <div v-if="calendar" class="mt-3 grid shrink-0 grid-cols-2 overflow-hidden rounded-xl border border-default" :class="inline ? 'max-w-md' : undefined">
      <label class="border-r border-default px-3 py-2" :class="dateField === 'checkIn' ? 'bg-muted ring-1 ring-inset ring-inverted' : undefined">
        <span class="block text-[10px] font-bold uppercase tracking-wider text-default">{{ t('stay.check_in') }}</span>
        <input type="date" class="w-full bg-transparent text-sm text-default outline-none" :value="checkIn ?? ''" :min="today" :max="lastDate" @focus="dateField = 'checkIn'" @change="typeCheckIn">
      </label>
      <label class="px-3 py-2" :class="dateField === 'checkOut' ? 'bg-muted ring-1 ring-inset ring-inverted' : undefined">
        <span class="block text-[10px] font-bold uppercase tracking-wider text-default">{{ t('stay.check_out') }}</span>
        <input type="date" class="w-full bg-transparent text-sm text-default outline-none disabled:opacity-50" :value="checkOut ?? ''" :min="earliestCheckOut ?? undefined" :max="lastDate" :disabled="!checkIn" @focus="dateField = 'checkOut'" @change="typeCheckOut">
      </label>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto py-4">
      <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
      <div v-if="calendarPending && !calendar" class="grid grid-cols-7 gap-2">
        <div v-for="i in 35" :key="i" class="size-10 animate-pulse rounded-full bg-muted" />
      </div>
      <p v-else-if="calendarError" role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ calendarError }}</p>
      <!-- Nothing on the calendar can start a stay: say so instead of a month of struck days. -->
      <div v-else-if="calendar && !checkIn && !firstCheckIn" class="rounded-xl border border-default px-4 py-6 text-center">
        <p class="text-sm text-default">{{ t('stay.no_dates') }}</p>
        <NuxtLink :to="enquiryPath" class="mt-2 inline-block text-sm font-semibold text-default underline underline-offset-4">{{ t('stay.ask_host') }}</NuxtLink>
      </div>
      <template v-else-if="calendar">
        <!-- Reka owns the month grid, paging and keyboard focus; the booking controller owns which endpoint a date can change. -->
        <CalendarRoot
          v-if="calendarPlaceholder"
          v-slot="{ grid, weekDays }"
          v-model:placeholder="calendarPlaceholder"
          :model-value="selectedDates"
          multiple
          :locale="locale"
          :number-of-months="desktop ? 2 : 1"
          :min-value="parseDate(calendar.home.today)"
          :max-value="lastDate ? parseDate(lastDate) : undefined"
          :is-date-disabled="isDateDisabled"
          :week-starts-on="0"
          weekday-format="narrow"
          data-stay-calendar
          class="grid gap-8 md:grid-cols-2"
          @update:model-value="selectCalendarDate"
          @mouseleave="hoveredDate = null"
        >
          <div v-for="(month, index) in grid" :key="month.value.toString()">
            <div class="mb-3 flex items-center justify-between">
              <CalendarPrev as-child :class="index > 0 ? 'invisible' : undefined">
                <button type="button" class="flex size-9 items-center justify-center rounded-full border border-default disabled:opacity-30" :aria-label="t('stay.previous_month')" @click="hoveredDate = null">
                  <TenantIcon name="chevron-left" class="size-4" />
                </button>
              </CalendarPrev>
              <span class="tenant-display text-lg">{{ formatCalendarDate(month.value.toString(), locale, { month: 'long', year: 'numeric' }) }}</span>
              <CalendarNext as-child :class="index < grid.length - 1 ? 'invisible' : undefined">
                <button type="button" class="flex size-9 items-center justify-center rounded-full border border-default disabled:opacity-30" :aria-label="t('stay.next_month')" @click="hoveredDate = null">
                  <TenantIcon name="chevron-right" class="size-4" />
                </button>
              </CalendarNext>
            </div>
            <CalendarGrid class="w-full table-fixed border-collapse" :aria-label="formatCalendarDate(month.value.toString(), locale, { month: 'long', year: 'numeric' })">
              <CalendarGridHead>
                <CalendarGridRow>
                  <CalendarHeadCell v-for="(day, dayIndex) in weekDays" :key="dayIndex" class="pb-2 text-[10px] font-normal uppercase tracking-[0.2em] text-muted">{{ day }}</CalendarHeadCell>
                </CalendarGridRow>
              </CalendarGridHead>
              <CalendarGridBody>
                <CalendarGridRow v-for="(week, weekIndex) in month.rows" :key="weekIndex">
                  <CalendarCell v-for="day in week" :key="day.toString()" :date="day" class="relative h-11 p-0 text-center" :class="day.month !== month.value.month ? 'invisible' : undefined" :data-stay-range="rangePosition(day.toString()) ? previewEnd ? 'preview' : 'selected' : undefined" @pointerenter="hoveredDate = day.toString()" @pointerdown="hoveredDate = day.toString()">
                    <span
                      v-if="rangePosition(day.toString())"
                      aria-hidden="true"
                      class="absolute inset-y-0.5 bg-muted"
                      :class="rangePosition(day.toString()) === 'start' ? 'left-1/2 right-0' : rangePosition(day.toString()) === 'end' ? 'left-0 right-1/2' : 'inset-x-0'"
                    />
                    <CalendarCellTrigger :day="day" :month="month.value" as-child>
                      <button
                        type="button"
                        class="relative mx-auto flex size-10 items-center justify-center rounded-full text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted"
                        :class="dayClasses(day.toString())"
                        :disabled="isDateDisabled(day) || day.month !== month.value.month"
                        :aria-pressed="day.toString() === checkIn || day.toString() === checkOut"
                        :aria-label="dayLabel(day.toString())"
                        :title="dayHint(day.toString()) || undefined"
                        @mouseenter="hoveredDate = day.toString()"
                        @focus="hoveredDate = day.toString()"
                        @blur="hoveredDate = null"
                      >
                        {{ day.day }}
                      </button>
                    </CalendarCellTrigger>
                  </CalendarCell>
                </CalendarGridRow>
              </CalendarGridBody>
            </CalendarGrid>
          </div>
        </CalendarRoot>
        <p v-if="hoveredDate && dayHint(hoveredDate)" role="status" class="mt-3 text-sm text-muted">{{ dayHint(hoveredDate) }}</p>
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
            <button type="button" class="flex size-8 items-center justify-center rounded-full border border-default disabled:opacity-30" :disabled="row.max !== null && row.value.value >= row.max" :aria-label="`${row.label} +`" @click="row.value.value++">
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
    </div>

    <div v-if="!inline" class="flex shrink-0 items-center justify-between gap-4 border-t border-default px-1 py-4">
      <div class="min-w-0">
        <div v-if="quotePending" role="status" class="text-sm text-muted">{{ t('stay.updating_price') }}</div>
        <div v-else-if="quote" class="tenant-display tenant-italic text-xl">{{ money(quote.total_minor) }} <span class="font-sans text-xs not-italic text-muted">{{ t('stay.total') }}</span></div>
        <div v-if="quote" class="mt-0.5 truncate text-xs text-muted">{{ rangeLabel }}</div>
        <div class="mt-0.5 text-xs text-muted">{{ quote ? `${nightsLabel(quote.nights)} · ${guestsLabel}` : quotePending ? '' : checkout ? t('stay.charged_in_full') : t('stay.enquiry_note') }}</div>
      </div>
      <TenantButton v-if="checkout" size="lg" class="shrink-0" :disabled="!quote || quotePending" @click="$emit('next')">{{ t('stay.reserve') }}</TenantButton>
      <TenantButton v-else size="lg" class="shrink-0" :to="enquiryPath">{{ t('stay.send_enquiry') }}</TenantButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { parseDate, type DateValue } from '@internationalized/date'
import { useMediaQuery } from '@vueuse/core'
import { CalendarCell, CalendarCellTrigger, CalendarGrid, CalendarGridBody, CalendarGridHead, CalendarGridRow, CalendarHeadCell, CalendarNext, CalendarPrev, CalendarRoot } from 'reka-ui'
import type { StayBookingController } from '~/composables/useStayBooking'
import { formatCalendarDate } from '~/utils/timezone'

const props = defineProps<{ controller: StayBookingController; /** On the page beside the listing rather than in the booking dialog: no party or total. */ inline?: boolean; place?: string }>()
defineEmits<{ next: [] }>()
const { calendar, calendarPending, calendarError, checkIn, checkOut, dateField, adults, children, infants, maxGuests, quote, quotePending, bookingError,
  nightCount, breakdown, rangeLabel, guestsLabel, canCheckIn, canCheckOut, checkInHint, checkOutHint, firstCheckIn, earliestCheckOut, night, selectDay, setCheckIn, setCheckOut, clearDates, clearCheckOut, money, nightsLabel, dateLabel, checkout, enquiryPath } = props.controller
const { t, locale } = useI18n()
// The nights are read once the calendar is on screen: inline on the page, and in the dialog however it opened, including a press made before hydration.
onMounted(() => { if (!calendar.value) void props.controller.loadCalendar() })

const desktop = useMediaQuery('(min-width: 768px)')
const today = computed(() => calendar.value?.home.today)
const calendarPlaceholder = shallowRef<DateValue>()
watch(calendar, (value) => {
  if (value && !calendarPlaceholder.value) calendarPlaceholder.value = parseDate(checkIn.value ?? value.home.today)
}, { immediate: true })
const lastDate = computed(() => calendar.value?.nights.at(-1)?.date)
const selectedDates = computed(() => {
  const date = dateField.value === 'checkIn' ? checkIn.value : checkOut.value
  return date ? [parseDate(date)] : []
})

function selectCalendarDate(value: DateValue | DateValue[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  const current = selectedDates.value[0]?.toString()
  const date = values.find(value => value.toString() !== current)?.toString() ?? current
  if (!date || (dateField.value === 'checkOut' && date === checkIn.value)) return
  selectDay(date)
}

function isDateDisabled(value: DateValue): boolean {
  const date = value.toString()
  // The selected arrival stays keyboard-focusable while the guest chooses a departure.
  if (dateField.value === 'checkOut' && date === checkIn.value) return false
  return dateField.value === 'checkOut' ? !canCheckOut(date) : !canCheckIn(date)
}

const typedDate = (event: Event) => (event.target as HTMLInputElement).value
function typeCheckIn(event: Event) {
  const date = typedDate(event)
  if (date) setCheckIn(date)
  else clearDates()
  // A refused date must not remain in the native input beside a quote for the previous dates.
  ;(event.target as HTMLInputElement).value = checkIn.value ?? ''
}
function typeCheckOut(event: Event) {
  const date = typedDate(event)
  if (date) setCheckOut(date)
  else clearCheckOut()
  ;(event.target as HTMLInputElement).value = checkOut.value ?? ''
}

const hoveredDate = ref<string | null>(null)
const previewEnd = computed(() => dateField.value === 'checkOut' && hoveredDate.value && hoveredDate.value !== checkOut.value && canCheckOut(hoveredDate.value) ? hoveredDate.value : null)
function rangePosition(date: string): 'start' | 'end' | 'between' | null {
  const end = previewEnd.value ?? checkOut.value
  if (!checkIn.value || !end || date < checkIn.value || date > end) return null
  return date === checkIn.value ? 'start' : date === end ? 'end' : 'between'
}

function dayHint(date: string): string {
  if (dateField.value === 'checkOut') {
    if (date === checkIn.value) return t('stay.check_in')
    return canCheckOut(date) ? canCheckIn(date) ? '' : t('stay.checkout_only') : checkOutHint(date)
  }
  const reason = checkInHint(date)
  if (reason) return reason
  const minimum = night(date)?.min_stay_arrival
  return minimum !== undefined && minimum > 1 ? t('stay.min_nights', { count: minimum }) : ''
}

function dayLabel(date: string): string {
  const label = formatCalendarDate(date, locale.value, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const hint = dayHint(date)
  return hint ? `${label} · ${hint}` : label
}

function dayClasses(date: string): string[] {
  if (date === checkIn.value || (date === checkOut.value && !previewEnd.value)) return ['bg-inverted text-inverted']
  if (date === previewEnd.value) return ['border border-inverted bg-muted text-default']
  if (!isDateDisabled(parseDate(date))) return ['cursor-pointer text-default hover:ring-1 hover:ring-inset hover:ring-inverted']
  return !night(date)?.available ? ['cursor-default text-muted/50 line-through'] : ['cursor-default text-muted']
}

const minNights = computed(() => checkIn.value ? night(checkIn.value)?.min_stay_arrival : null)

// A dated minimum is shown only for the arrival the guest actually selected.
const heading = computed(() => checkIn.value && checkOut.value ? (props.inline && props.place ? t('stay.nights_in', { nights: nightsLabel(nightCount.value), place: props.place }) : nightsLabel(nightCount.value)) : checkIn.value ? t('stay.select_check_out') : t('stay.select_check_in'))
const subheading = computed(() => checkIn.value && checkOut.value
  ? rangeLabel.value
  : [checkIn.value ? `${t('stay.check_in')}: ${dateLabel(checkIn.value)}` : t('stay.add_dates'), minNights.value !== null && minNights.value !== undefined && minNights.value > 1 ? t('stay.min_nights', { count: minNights.value }) : ''].filter(Boolean).join(' · '))

const guestRows = computed(() => [
  { key: 'adults', label: t('stay.adults'), hint: t('stay.adults_hint'), value: adults, min: 1, max: maxGuests.value - children.value },
  { key: 'children', label: t('stay.children'), hint: t('stay.children_hint'), value: children, min: 0, max: maxGuests.value - adults.value },
  { key: 'infants', label: t('stay.infants'), hint: t('stay.infants_hint'), value: infants, min: 0, max: null },
])
</script>
