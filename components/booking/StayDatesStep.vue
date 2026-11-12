<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-start justify-between gap-6 pb-5" :class="vertical ? 'pt-10' : undefined">
      <div class="min-w-0">
        <h2 class="text-default font-semibold" :class="inline ? 'text-2xl' : 'text-xl'">{{ heading }}</h2>
        <p class="mt-2 text-sm text-muted" :class="!inline && desktop ? 'min-h-10' : 'min-h-5'">{{ subheading }}</p>
      </div>
      <button v-if="vertical" type="button" class="absolute right-6 top-5 text-sm font-semibold underline underline-offset-4" @click="clearDates">{{ t('stay.clear_dates') }}</button>
      <div v-if="!inline && desktop && calendar" class="grid w-80 shrink-0 grid-cols-2 overflow-hidden rounded-xl border border-default">
        <label v-for="field in dateFields" :key="field.key" class="relative px-3 py-2 first:border-r first:border-default" :class="dateField === field.key ? 'ring-2 ring-inset ring-inverted rounded-xl' : undefined">
          <span class="block text-[10px] font-bold uppercase text-default">{{ field.label }}</span>
          <input type="date" class="peer stay-date-input w-full bg-transparent pr-5 text-sm text-default outline-none" :class="field.value ? undefined : 'opacity-0 focus:opacity-100'" :aria-label="field.label" :value="field.value ?? ''" :min="field.key === 'checkIn' ? today : earliestCheckOut ?? undefined" :max="lastDate ?? undefined" :disabled="field.key === 'checkOut' && !checkIn" @focus="dateField = field.key" @change="field.key === 'checkIn' ? typeCheckIn($event) : typeCheckOut($event)">
          <span v-if="!field.value" class="pointer-events-none absolute bottom-2 left-3 text-sm text-muted peer-focus:hidden">{{ t('stay.add_date') }}</span>
          <button v-if="field.value" type="button" class="absolute right-2 bottom-2 flex size-5 items-center justify-center" :aria-label="t(field.key === 'checkIn' ? 'stay.clear_check_in' : 'stay.clear_check_out')" @click="field.key === 'checkIn' ? clearDates() : clearCheckOut()"><span aria-hidden="true">×</span></button>
        </label>
      </div>
    </div>
    <div class="flex min-h-0 flex-1 flex-col">
      <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
      <div v-if="calendarPending && !calendar" class="grid grid-cols-7 gap-2">
        <div v-for="i in 35" :key="i" class="size-10 animate-pulse rounded-full bg-muted" />
      </div>
      <p v-if="calendarError" role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ calendarError }}</p>
      <template v-if="calendar">
        <p v-if="!calendarPending && !firstCheckIn && !checkIn" class="pb-4 text-sm text-muted">
          {{ t('stay.no_dates', 1) }}
          <NuxtLink :to="enquiryPath" class="font-semibold text-default underline underline-offset-4">{{ t('stay.ask_host') }}</NuxtLink>
        </p>
        <!-- Reka owns the month grid, paging and keyboard focus; the booking controller owns which endpoint a date can change. -->
        <TooltipProvider :delay-duration="0" disable-closing-trigger disable-hoverable-content>
        <CalendarRoot
          v-if="calendarPlaceholder"
          v-slot="{ grid, weekDays }"
          v-model:placeholder="calendarPlaceholder"
          :model-value="[]"
          multiple
          :locale="locale"
          :number-of-months="monthCount"
          :min-value="parseDate(calendar.home.today)"
          :max-value="lastDate ? parseDate(lastDate) : undefined"
          :is-date-disabled="isDateDisabled"
          :week-starts-on="0"
          weekday-format="narrow"
          data-stay-calendar
          class="flex min-h-0 flex-1 flex-col"
          @update:model-value="selectCalendarDate"
          @mouseleave="hoveredDate = null"
        >
          <div v-if="vertical" class="grid shrink-0 grid-cols-7 border-b border-default pb-3 text-center text-xs text-muted"><span v-for="(day, index) in weekDays" :key="index">{{ day }}</span></div>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain" :class="vertical ? 'space-y-8 py-5' : 'grid gap-8 grid-cols-[repeat(var(--stay-months),minmax(0,1fr))]'" :style="{ '--stay-months': monthCount }">
          <CalendarPrev v-if="vertical" as-child><button type="button" class="mb-6 w-full rounded-xl bg-muted py-3 text-sm font-semibold disabled:hidden" :aria-label="t('stay.previous_month')" @click="hoveredDate = null">{{ t('stay.load_dates') }}</button></CalendarPrev>
          <div v-for="(month, index) in grid" :key="month.value.toString()">
            <div class="mb-4 flex items-center" :class="vertical ? 'justify-start' : 'justify-between'">
              <CalendarPrev v-if="!vertical" as-child :class="index > 0 ? 'invisible' : undefined">
                <button type="button" class="flex size-9 items-center justify-center rounded-full border border-default disabled:opacity-30" :aria-label="t('stay.previous_month')" @click="hoveredDate = null">
                  <TenantIcon name="chevron-left" class="size-4" />
                </button>
              </CalendarPrev>
              <span class="text-base font-semibold">{{ formatCalendarDate(month.value.toString(), locale, { month: 'long', year: 'numeric' }) }}</span>
              <CalendarNext v-if="!vertical" as-child :class="index < grid.length - 1 ? 'invisible' : undefined">
                <button type="button" class="flex size-9 items-center justify-center rounded-full border border-default disabled:opacity-30" :aria-label="t('stay.next_month')" @click="hoveredDate = null">
                  <TenantIcon name="chevron-right" class="size-4" />
                </button>
              </CalendarNext>
            </div>
            <CalendarGrid class="w-full table-fixed border-collapse" :aria-label="formatCalendarDate(month.value.toString(), locale, { month: 'long', year: 'numeric' })">
              <CalendarGridHead :class="vertical ? 'sr-only' : undefined">
                <CalendarGridRow>
                  <CalendarHeadCell v-for="(day, dayIndex) in weekDays" :key="dayIndex" class="pb-3 text-xs font-normal text-muted">{{ day }}</CalendarHeadCell>
                </CalendarGridRow>
              </CalendarGridHead>
              <CalendarGridBody>
                <CalendarGridRow v-for="(week, weekIndex) in month.rows" :key="weekIndex">
                  <CalendarCell v-for="day in week" :key="day.toString()" :date="day" :aria-selected="!!rangePosition(day.toString()) || day.toString() === checkIn || day.toString() === checkOut" class="relative h-12 p-0 text-center" :class="day.month !== month.value.month ? 'invisible' : undefined" :data-stay-range="rangePosition(day.toString()) ? previewEnd ? 'preview' : 'selected' : undefined" @pointerenter="hoveredDate = day.toString()" @pointerleave="hoveredDate = null" @pointerdown="hoveredDate = day.toString()">
                    <span
                      v-if="rangePosition(day.toString())"
                      aria-hidden="true"
                      class="absolute inset-y-0.5 bg-muted"
                      :class="rangePosition(day.toString()) === 'start' ? 'left-1/2 right-0' : rangePosition(day.toString()) === 'end' ? 'left-0 right-1/2' : 'inset-x-0'"
                    />
                    <TooltipRoot :open="day.month === month.value.month && hoveredDate === day.toString() && !!dayHint(day.toString())" @update:open="open => { if (!open && hoveredDate === day.toString()) hoveredDate = null }">
                    <TooltipTrigger as-child>
                    <CalendarCellTrigger :day="day" :month="month.value" as-child>
                      <button
                        type="button"
                        class="relative mx-auto flex size-10 items-center justify-center rounded-full text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted"
                        :class="dayClasses(day.toString())"
                        :disabled="isDateDisabled(day) || day.month !== month.value.month"
                        :aria-pressed="day.toString() === checkIn || day.toString() === checkOut"
                        :aria-label="dayLabel(day.toString())"
                        @mouseenter="hoveredDate = day.toString()"
                        @focus="hoveredDate = day.toString()"
                        @blur="hoveredDate = null"
                      >
                        {{ day.day }}
                      </button>
                    </CalendarCellTrigger>
                    </TooltipTrigger>
                    <TooltipPortal to="#tenant-portal-root"><TooltipContent side="bottom" :side-offset="6" class="z-[70] rounded border border-default bg-default px-2 py-1 text-xs text-default shadow-md">{{ dayHint(day.toString()) }}</TooltipContent></TooltipPortal>
                    </TooltipRoot>
                  </CalendarCell>
                </CalendarGridRow>
              </CalendarGridBody>
            </CalendarGrid>
          </div>
          <CalendarNext v-if="vertical" as-child><button type="button" class="mt-6 w-full rounded-xl bg-muted py-3 text-sm font-semibold disabled:hidden" :aria-label="t('stay.next_month')" @click="hoveredDate = null">{{ t('stay.load_dates') }}</button></CalendarNext>
          </div>
        </CalendarRoot>
        </TooltipProvider>
      </template>

      <button v-if="inline" type="button" class="mt-4 text-sm font-semibold text-default underline underline-offset-4" @click="clearDates">{{ t('stay.clear_dates') }}</button>

    </div>

    <div v-if="!inline" class="flex min-h-16 shrink-0 items-center justify-between gap-4 border-t border-default pt-4">
      <div v-if="vertical" class="min-w-0 text-sm" :aria-busy="quotePending">
        <StayPriceSummary v-if="quotePending || quote" :controller="controller" />
        <span v-else>{{ t('stay.add_dates_for_prices') }}</span>
      </div>
      <button v-else type="button" class="text-sm font-semibold underline underline-offset-4" @click="clearDates">{{ t('stay.clear_dates') }}</button>
      <TenantButton class="shrink-0" :disabled="vertical && (!checkIn || !checkOut)" @click="$emit('done')">{{ t(vertical ? 'stay.save_dates' : 'stay.close_dates') }}</TenantButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { parseDate, type DateValue } from '@internationalized/date'
import { useMediaQuery } from '@vueuse/core'
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger, CalendarCell, CalendarCellTrigger, CalendarGrid, CalendarGridBody, CalendarGridHead, CalendarGridRow, CalendarHeadCell, CalendarNext, CalendarPrev, CalendarRoot } from 'reka-ui'
import type { StayBookingController } from '~/composables/useStayBooking'
import { formatCalendarDate } from '~/utils/timezone'
import { AVAILABILITY_PAGE_DAYS, MAX_STAY_NIGHTS } from '~/shared/bookings'
import StayPriceSummary from './StayPriceSummary.vue'

const props = defineProps<{ controller: StayBookingController; /** On the page beside the listing rather than in the booking dialog: no party or total. */ inline?: boolean; place?: string }>()
defineEmits<{ done: [] }>()
const { calendar, calendarPending, calendarError, checkIn, checkOut, dateField, quote, quotePending, bookingError,
  nightCount, rangeLabel, canCheckIn, canCheckOut, checkInHint, checkOutHint, firstCheckIn, earliestCheckOut, night, selectDay, setCheckIn, setCheckOut, clearDates, clearCheckOut, nightsLabel, enquiryPath } = props.controller
const { t, locale } = useI18n()
// The nights are read once the calendar is on screen: inline on the page, and in the dialog however it opened, including a press made before hydration.
onMounted(() => { if (!calendar.value && !calendarPending.value) void props.controller.openCalendar() })

const desktop = useMediaQuery('(min-width: 768px)')
const wideInline = useMediaQuery('(min-width: 1024px)')
const vertical = computed(() => !props.inline && !desktop.value)
const monthCount = computed(() => props.inline && !wideInline.value ? 1 : 2)
const today = computed(() => calendar.value?.home.today)
const calendarPlaceholder = shallowRef<DateValue>()
watch(calendar, (value) => {
  if (value && !calendarPlaceholder.value) calendarPlaceholder.value = parseDate(checkIn.value ?? value.home.today)
}, { immediate: true })
const lastDate = props.controller.horizon
watch([calendarPlaceholder, monthCount], ([value, count]) => {
  if (!value) return
  const start = value.set({ day: 1 })
  void props.controller.loadCalendar(start.toString(), start.add({ months: count }).toString())
}, { immediate: true })
watch(checkIn, (value) => {
  if (!value || vertical.value || !calendarPlaceholder.value) return
  const date = parseDate(value)
  const start = calendarPlaceholder.value.set({ day: 1 })
  if (date.compare(start) < 0 || date.compare(start.add({ months: monthCount.value })) >= 0) calendarPlaceholder.value = date
})
// The booking controller owns the two endpoints; CalendarRoot owns only the grid and keyboard navigation.
function selectCalendarDate(value: DateValue | DateValue[] | undefined) {
  const date = (Array.isArray(value) ? value.at(-1) : value)?.toString()
  if (date && !(dateField.value === 'checkOut' && date === checkIn.value)) selectDay(date)
}

function isDateDisabled(value: DateValue): boolean {
  const date = value.toString()
  // The selected arrival stays keyboard-focusable while the guest chooses a departure.
  if (dateField.value === 'checkOut' && date === checkIn.value) return false
  return dateField.value === 'checkOut' ? !canCheckOut(date) : !canCheckIn(date)
}

const typedDate = (event: Event) => (event.target as HTMLInputElement).value
async function typeCheckIn(event: Event) {
  const date = typedDate(event)
  if (date && lastDate.value && date < lastDate.value) {
    const first = parseDate(date)
    await props.controller.loadCalendar(date, first.add({ days: AVAILABILITY_PAGE_DAYS }).toString())
    setCheckIn(date)
  }
  else if (!date) clearDates()
  // An empty checkout gives Reka no selected date to bring the typed arrival into view.
  if (date && checkIn.value === date && !vertical.value) calendarPlaceholder.value = parseDate(date)
  // A refused date must not remain in the native input beside a quote for the previous dates.
  ;(event.target as HTMLInputElement).value = checkIn.value ?? ''
}
async function typeCheckOut(event: Event) {
  const date = typedDate(event)
  if (date) {
    if (checkIn.value && date <= parseDate(checkIn.value).add({ days: MAX_STAY_NIGHTS }).toString()) await props.controller.loadCalendar(checkIn.value, date)
    setCheckOut(date)
  } else clearCheckOut()
  if (date && checkOut.value === date && !vertical.value) calendarPlaceholder.value = parseDate(date)
  ;(event.target as HTMLInputElement).value = checkOut.value ?? ''
}

const dateFields = computed(() => [
  { key: 'checkIn' as const, label: t('stay.check_in'), value: checkIn.value },
  { key: 'checkOut' as const, label: t('stay.check_out'), value: checkOut.value },
])
const hoveredDate = ref<string | null>(null)
const previewEnd = computed(() => dateField.value === 'checkOut' && hoveredDate.value && hoveredDate.value !== checkOut.value && canCheckOut(hoveredDate.value) ? hoveredDate.value : null)
function rangePosition(date: string): 'start' | 'end' | 'between' | null {
  const end = previewEnd.value ?? checkOut.value
  if (!checkIn.value || !end || date < checkIn.value || date > end) return null
  return date === checkIn.value ? 'start' : date === end ? 'end' : 'between'
}

function dayHint(date: string): string {
  if (date === checkIn.value) return !checkOut.value && minNights.value != null && minNights.value > 1 ? t('stay.min_nights', { count: minNights.value }) : t('stay.check_in_day')
  if (date === checkOut.value) return t('stay.check_out_day')
  if (dateField.value === 'checkOut') {
    if (checkIn.value && earliestCheckOut.value && date > checkIn.value && date < earliestCheckOut.value && night(date)?.available && minNights.value != null) return t('stay.min_nights', { count: minNights.value })
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
const heading = computed(() => {
  if (checkIn.value && checkOut.value) return props.inline && props.place
    ? t('stay.nights_in', { nights: nightsLabel(nightCount.value), place: props.place }) : nightsLabel(nightCount.value)
  if (!props.inline && desktop.value) return t('stay.select_dates')
  return checkIn.value ? t('stay.select_check_out') : t('stay.select_check_in')
})
const subheading = computed(() => checkIn.value && checkOut.value ? rangeLabel.value
  : minNights.value != null && minNights.value > 1 ? t('stay.minimum_stay_note', { count: minNights.value }) : t('stay.exact_pricing'))
</script>

<style scoped>
.stay-date-input::-webkit-calendar-picker-indicator { display: none; }
</style>
