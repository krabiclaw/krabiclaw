<template>
  <DashboardIndexPanel id="stay-night-calendar" title="Calendar" fill>
    <template #right>
      <div class="flex w-[calc(100vw-2rem)] flex-wrap items-center gap-2 sm:w-auto">
        <UDropdownMenu :items="homes.map(home => ({ label: home.name, to: { path: level.path.value, query: { product_id: home.product_id } } }))" :content="{ align: 'end' }">
          <UButton :label="homeOption?.name || 'Choose a home'" :title="homeOption?.name" trailing-icon="i-lucide-chevron-down" color="neutral" variant="outline" class="max-w-[calc(100vw-9rem)] sm:max-w-80" />
        </UDropdownMenu>
        <UButton label="Agenda" color="neutral" variant="soft" :to="{ path: level.path.value, query: {} }" />
        <UButton v-if="data && level.mode.value === 'index'" label="Select nights" color="neutral" variant="outline" class="hidden sm:inline-flex" :disabled="busy" @click="openDates" />
      </div>
    </template>
    <UAlert v-if="initialError" class="m-6" color="error" variant="soft" title="The nightly calendar could not be loaded" :description="initialError" />
    <div v-else class="min-h-0 flex-1" :class="level.mode.value === 'index' ? 'lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)]' : undefined">
      <div class="min-w-0 overflow-y-auto px-4 pb-24 sm:px-6 lg:pb-8" :aria-busy="status === 'pending'">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p class="w-full text-sm text-muted sm:w-auto">{{ data?.home.timezone }} · {{ data?.home.currency }}</p>
          <div class="flex gap-2">
            <UButton v-if="data && level.mode.value === 'index'" label="Select nights" color="neutral" variant="outline" class="sm:hidden" :disabled="busy" @click="openDates" />
            <UButton label="Today" color="neutral" variant="outline" :disabled="busy" @click="goToToday" />
          </div>
        </div>
        <UAlert v-if="error" class="mb-4" color="error" variant="soft" :description="getErrorMessage(error, 'Calendar request failed')" />
        <UAlert v-if="writeError && !selectedNights.length" class="mb-4" color="error" variant="soft" :description="writeError" />
        <UCalendar
          v-model="selection"
          :placeholder="placeholder"
          range
          :min-value="currentDay ?? undefined"
          :maximum-days="500"
          :year-controls="false"
          :view-control="false"
          :week-starts-on="0"
          weekday-format="short"
          color="neutral"
          :disabled="busy || status === 'pending'"
          :ui="calendarUi"
          class="w-full"
          @update:placeholder="changeMonth"
        >
          <template #heading="{ value }"><span class="block text-left text-3xl font-semibold text-highlighted">{{ value }}</span></template>
          <template #day="{ day }">
            <span
              class="flex size-full flex-col justify-between overflow-hidden rounded-2xl p-1 sm:p-3"
              :class="selected(day) ? 'bg-inverted text-inverted' : night(day)?.available === false ? 'bg-muted text-muted' : 'bg-default text-highlighted'"
              :data-testid="`stay-night-${day.toString()}`"
              :title="nightTitle(day)"
            >
              <span class="block text-sm sm:text-base" :class="night(day)?.available === false ? 'line-through' : ''">{{ day.day }}</span>
              <span v-if="night(day)?.stay_id || night(day)?.held_until" class="hidden truncate text-xs sm:block">{{ night(day)?.stay_id ? 'Reserved' : 'Checkout hold' }}</span>
              <span class="block break-all text-[10px] leading-tight tabular-nums sm:hidden">{{ night(day) ? night(day)!.price_minor === null ? 'No price' : compactMoney(night(day)!.price_minor!) : '…' }}</span>
              <span class="hidden truncate text-sm sm:block">{{ night(day) ? night(day)!.price_minor === null ? 'No price' : money(night(day)!.price_minor!) : '…' }}</span>
            </span>
          </template>
        </UCalendar>
        <p v-if="selection.start && !selection.end" class="mt-4 text-sm text-muted">Choose an end date to select more nights, or edit this night.</p>
      </div>
      <aside v-if="pane && level.mode.value === 'index'" class="min-w-0 overflow-y-auto border-l border-default p-6 xl:p-8">
        <StayNightInspector v-if="selectedNights.length && data" v-bind="inspectorProps" @dates="openDates" @clear="clearSelection" @edit="edit" @cancel="cancelConcern" @field="setField" @patch="write" @save="save" />
        <EditorNavigationList v-else-if="data" :groups="overviewGroups" />
      </aside>
    </div>
    <template v-if="!pane && level.mode.value === 'index' && selectedNights.length" #footer>
      <UButton :label="`Edit ${dateLabel}`" color="neutral" block :disabled="busy" @click="drawerOpen = true" />
    </template>
  </DashboardIndexPanel>
  <UDrawer
    v-if="!pane && level.mode.value === 'index' && data && selectedNights.length"
    :open="drawerOpen"
    title="Selected nights"
    :description="dateLabel"
    :dismissible="!busy"
    no-body-styles
    handle-only
    :ui="{ content: 'max-h-[85dvh] rounded-t-3xl', body: 'overflow-y-auto' }"
    @update:open="closeDrawer"
  >
    <template #body>
      <StayNightInspector v-bind="inspectorProps" @dates="openDates" @clear="clearSelection" @edit="edit" @cancel="cancelConcern" @field="setField" @patch="write" @save="save" />
    </template>
  </UDrawer>
  <UModal v-model:open="datesOpen" title="Select nights">
    <template #body>
      <UAlert v-if="dateError" class="mb-4" color="error" variant="soft" :description="dateError" />
      <div class="grid gap-5 sm:grid-cols-2">
        <UFormField label="Start night"><UInput v-model="dateDraft.start" type="date" :min="currentDay?.toString()" class="w-full" /></UFormField>
        <UFormField label="End night (optional)"><UInput v-model="dateDraft.end" type="date" :min="currentDay?.toString()" class="w-full" /></UFormField>
      </div>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="link" @click="datesOpen = false" />
      <UButton label="Edit selected nights" color="neutral" @click="chooseDates" />
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { parseDate, today, type DateValue } from '@internationalized/date'
import type { DateRange } from 'reka-ui'
import type { StayHome, StayNight } from '~/server/domain/stays'
import StayNightInspector, { type NightConcern, type NightDraft, type NightEditField } from './StayNightInspector.vue'
import EditorNavigationList from './EditorNavigationList.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { isChannelPush, type ChannelPush } from '~/shared/channel-push'
import { STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES } from '~/shared/stay-listing'
import { addLocalDays, formatCalendarDate, isValidCalendarDate, isValidInstant, isValidTimezone } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

type Home = Pick<StayHome, 'product_id' | 'name' | 'timezone' | 'currency' | 'base_price_minor' | 'min_nights' | 'cancellation_policy' | 'long_term_cancellation_policy'>
interface CalendarPayload { home: Home; nights: StayNight[]; channel_push?: ChannelPush | null }
const props = defineProps<{ productId: string; homes: Pick<StayHome, 'product_id' | 'name' | 'timezone'>[]; manage: boolean; homeError: string }>()
const route = useRoute()
const level = useRouteLevel()
const router = useRouter()
const api = useDashboardApi()
const pane = useDashboardPane()
const homeOption = computed(() => props.homes.find(home => home.product_id === props.productId))
const initialError = computed(() => props.homeError || (!homeOption.value ? 'That place to stay is not available in this organization.' : ''))
const currentDay = computed(() => homeOption.value ? today(homeOption.value.timezone) : null)
const requestedMonth = typeof route.query.month === 'string' ? `${route.query.month}-01` : null
if (route.query.month !== undefined && (!requestedMonth || !isValidCalendarDate(requestedMonth))) throw createError({ statusCode: 400, statusMessage: 'Choose a valid calendar month.' })
const placeholder = shallowRef<DateValue | undefined>(requestedMonth ? parseDate(requestedMonth) : currentDay.value ?? undefined)
const selection = shallowRef<DateRange>({ start: undefined, end: undefined })
const selectedRange = computed(() => selection.value.start ? { from: selection.value.start.toString(), to: addLocalDays((selection.value.end ?? selection.value.start).toString(), 1) } : null)
const selectedCount = computed(() => selectedRange.value ? parseDate(selectedRange.value.to).compare(parseDate(selectedRange.value.from)) : 0)
const monthRange = computed(() => {
  const first = placeholder.value?.set({ day: 1 })
  return first ? { from: first.subtract({ days: 7 }).toString(), to: first.add({ months: 1, days: 7 }).toString() } : null
})
const readRanges = computed(() => {
  if (!monthRange.value) return []
  const ranges = [monthRange.value, ...(selectedRange.value ? [selectedRange.value] : [])].sort((a, b) => a.from.localeCompare(b.from))
  const [first, second] = ranges
  return second && second.from <= first!.to
    ? [{ from: first!.from, to: second.to > first!.to ? second.to : first!.to }]
    : ranges
})
const safeAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableAmount = (value: unknown) => value === null || safeAmount(value)
const nullableRule = (value: unknown, maximum = Number.MAX_SAFE_INTEGER) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum)
const nullableText = (value: unknown) => value === null || typeof value === 'string'
function isCalendar(value: unknown): value is CalendarPayload {
  if (!isRecord(value) || !isRecord(value.home) || !Array.isArray(value.nights)) return false
  const home = value.home
  if (home.product_id !== props.productId || typeof home.name !== 'string' || typeof home.timezone !== 'string' || !isCurrencyCode(home.currency)
    || !nullableAmount(home.base_price_minor) || !nullableRule(home.min_nights, 365) || home.min_nights === null
    || !(home.cancellation_policy === null || typeof home.cancellation_policy === 'string' && Object.hasOwn(STAY_CANCELLATION_POLICIES, home.cancellation_policy))
    || !(home.long_term_cancellation_policy === null || typeof home.long_term_cancellation_policy === 'string' && Object.hasOwn(STAY_LONG_TERM_CANCELLATION_POLICIES, home.long_term_cancellation_policy))) return false
  if (!isValidTimezone(home.timezone)) return false
  return (value.channel_push === undefined || isChannelPush(value.channel_push)) && value.nights.every(item => isRecord(item) && isValidCalendarDate(item.date)
    && typeof item.available === 'boolean' && typeof item.closed === 'boolean' && nullableText(item.stay_id) && nullableAmount(item.price_minor)
    && nullableRule(item.min_stay_arrival) && nullableRule(item.min_stay_through) && nullableRule(item.max_stay)
    && typeof item.closed_to_arrival === 'boolean' && typeof item.closed_to_departure === 'boolean'
    && [null, 'host', 'import'].includes(item.source as string | null) && (item.held_until === null || isValidInstant(item.held_until))
    && (item.channel === null || isRecord(item.channel) && ['pending', 'pushed', 'needs_review'].includes(String(item.channel.state)) && nullableText(item.channel.detail)))
}
const { data, error, status, refresh } = await useAsyncData(
  () => `stay-night-calendar:${String(route.params.orgSlug)}:${props.productId}:${readRanges.value.map(range => `${range.from}:${range.to}`).join('|')}`,
  async () => {
    const ranges = readRanges.value
    if (initialError.value || !ranges.length) return null
    const chunks: CalendarPayload[] = []
    for (const range of ranges) {
      for (let from = range.from; from < range.to;) {
        const limit = addLocalDays(from, 500)
        const to = limit < range.to ? limit : range.to
        const payload = await api(`/api/dashboard/stay-homes/${encodeURIComponent(props.productId)}/calendar`, { query: { from, to }, validate: isCalendar })
        if (payload.nights.length !== parseDate(to).compare(parseDate(from)) || payload.nights.some((night, index) => night.date !== addLocalDays(from, index))) throw new Error('The calendar did not return every requested night in order.')
        chunks.push(payload)
        from = to
      }
    }
    return { home: chunks[0]!.home, nights: chunks.flatMap(chunk => chunk.nights) }
  },
)
const nightsByDate = computed(() => new Map((data.value?.nights ?? []).map(night => [night.date, night])))
const night = (day: DateValue) => nightsByDate.value.get(day.toString())
const selectedNights = computed(() => selectedRange.value ? (data.value?.nights ?? []).filter(night => night.date >= selectedRange.value!.from && night.date < selectedRange.value!.to) : [])
const selected = (day: DateValue) => Boolean(selectedRange.value && day.toString() >= selectedRange.value.from && day.toString() < selectedRange.value.to)
const money = (value: number) => data.value ? formatMinorAmount(value, data.value.home.currency) : ''
const compactMoney = (value: number) => data.value ? minorAmountToMajor(value, data.value.home.currency).replace(/\.0+$/, '') : ''
function nightTitle(day: DateValue) {
  const value = night(day)
  return value ? `${day.toString()} · ${value.stay_id ? 'Reserved' : value.held_until ? 'Checkout hold' : value.closed ? 'Blocked' : 'Available'} · ${value.price_minor === null ? 'No price' : money(value.price_minor)}${value.channel?.state === 'needs_review' ? ` · ${value.channel.detail}` : ''}` : day.toString()
}
const dateLabel = computed(() => {
  const range = selectedRange.value
  if (!range) return ''
  const end = addLocalDays(range.to, -1)
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (range.from.slice(0, 4) !== String(placeholder.value?.year) || end.slice(0, 4) !== range.from.slice(0, 4)) options.year = 'numeric'
  return `${formatCalendarDate(range.from, 'en', options)}${selectedCount.value > 1 ? ` – ${formatCalendarDate(end, 'en', options)}` : ''}`
})
const concern = ref<NightConcern>('summary')
const drawerOpen = ref(false)
const busy = ref(false)
const writeError = ref('')
const notice = ref('')
const datesOpen = ref(false)
const dateDraft = reactive({ start: '', end: '' })
const dateError = ref('')
const draft = reactive<NightDraft>({ price_minor: '', min_stay_arrival: '', min_stay_through: '', max_stay: '', closed_to_arrival: 'keep', closed_to_departure: 'keep' })
const dirtyFields = ref<NightEditField[]>([])
const inspectorProps = computed(() => ({ orgSlug: String(route.params.orgSlug), home: data.value!.home, nights: selectedNights.value, dateLabel: dateLabel.value, manage: props.manage, busy: busy.value || status.value === 'pending', error: writeError.value, notice: notice.value || [...new Set(selectedNights.value.flatMap(night => night.channel?.state === 'needs_review' && night.channel.detail ? [night.channel.detail] : []))].join(' '), concern: concern.value, draft, dirty: dirtyFields.value.length > 0 }))
const overviewGroups = computed(() => [{ id: 'home', items: [
  { id: 'price', label: 'Pricing', summary: data.value?.home.base_price_minor == null ? 'No base nightly price set' : `${money(data.value.home.base_price_minor)} per night`, to: `/dashboard/${String(route.params.orgSlug)}/products/${props.productId}/price` },
  { id: 'availability', label: 'Availability', summary: `${data.value?.home.min_nights} night minimum`, to: `/dashboard/${String(route.params.orgSlug)}/products/${props.productId}/availability` },
  { id: 'cancellation', label: 'Cancellations', summary: [data.value?.home.cancellation_policy ? STAY_CANCELLATION_POLICIES[data.value.home.cancellation_policy].label : 'Short-term policy not set', data.value?.home.long_term_cancellation_policy ? STAY_LONG_TERM_CANCELLATION_POLICIES[data.value.home.long_term_cancellation_policy].label : 'Long-term policy not set'].join(' · '), to: `/dashboard/${String(route.params.orgSlug)}/products/${props.productId}/cancellation` },
] }])
function edit(value: NightConcern) {
  concern.value = value
  dirtyFields.value = []
  for (const field of Object.keys(draft) as NightEditField[]) {
    const first = selectedNights.value[0]?.[field]
    const same = selectedNights.value.every(night => night[field] === first)
    draft[field] = field === 'closed_to_arrival' || field === 'closed_to_departure' ? 'keep'
      : same && typeof first === 'number' ? field === 'price_minor' ? minorAmountToMajor(first, data.value!.home.currency) : String(first) : ''
  }
  writeError.value = ''
}
function setField(field: NightEditField, value: string) {
  draft[field] = value
  if (!dirtyFields.value.includes(field)) dirtyFields.value.push(field)
}
function cancelConcern() { edit('summary') }
function clearSelection() {
  if (busy.value) return
  selection.value = { start: undefined, end: undefined }
  drawerOpen.value = false
  edit('summary')
  notice.value = ''
}
function closeDrawer(open: boolean) {
  if (busy.value) return
  drawerOpen.value = open
  if (!open) cancelConcern()
}
function openDates() {
  if (!currentDay.value) return
  dateDraft.start = selectedRange.value?.from ?? currentDay.value.toString()
  dateDraft.end = selectedRange.value && selectedCount.value > 1 ? addLocalDays(selectedRange.value.to, -1) : ''
  dateError.value = ''
  datesOpen.value = true
}
async function chooseDates() {
  if (!isValidCalendarDate(dateDraft.start) || dateDraft.end && !isValidCalendarDate(dateDraft.end)) { dateError.value = 'Choose valid start and end nights.'; return }
  const start = parseDate(dateDraft.start)
  const end = parseDate(dateDraft.end || dateDraft.start)
  if (!currentDay.value || start.compare(currentDay.value) < 0) { dateError.value = 'Choose today or a future night in the home’s timezone.'; return }
  if (end.compare(start) < 0 || end.compare(start) >= 500) { dateError.value = 'Choose an end night on or after the start, with at most 500 nights.'; return }
  if (!await changeMonth(start)) { dateError.value = writeError.value; return }
  selection.value = { start, end }
  datesOpen.value = false
  if (!pane.value) drawerOpen.value = true
}
async function changeMonth(value: DateValue) {
  if (busy.value) return false
  placeholder.value = value
  const month = value.toString().slice(0, 7)
  try {
    await router.replace({ query: { ...route.query, month } })
    return true
  } catch (cause) {
    writeError.value = getErrorMessage(cause, 'The month could not be opened')
    return false
  }
}
function goToToday() { if (currentDay.value) void changeMonth(currentDay.value) }
async function write(patch: Record<string, boolean | number | null>) {
  if (busy.value || !props.manage || !selectedRange.value) return
  if (selectedCount.value > 500 || selectedNights.value.length !== selectedCount.value) { writeError.value = 'Choose at most 500 loaded nights.'; return }
  busy.value = true
  writeError.value = ''
  notice.value = ''
  try {
    const response = await api(`/api/dashboard/stay-homes/${encodeURIComponent(props.productId)}/nights`, { method: 'PUT', body: { ...selectedRange.value, ...patch }, validate: isCalendar })
    if (!Object.hasOwn(response, 'channel_push')) throw new Error('The saved nights did not report their channel outcome.')
    await refresh()
    if (error.value) throw error.value
    notice.value = response.channel_push?.state === 'needs_review' ? response.channel_push.detail : ''
    edit('summary')
  } catch (cause) {
    writeError.value = getErrorMessage(cause, 'The nights could not be saved')
    await refresh()
    if (error.value) writeError.value += ` ${getErrorMessage(error.value, 'The saved calendar could not be read back')}`
  } finally { busy.value = false }
}
async function save() {
  if (concern.value === 'reset') { await write({ reset: true }); return }
  const patch: Record<string, boolean | number | null> = {}
  try {
    for (const field of dirtyFields.value) {
      const value = draft[field].trim()
      if (field === 'closed_to_arrival' || field === 'closed_to_departure') {
        if (value !== 'keep') patch[field] = value === 'block'
      } else if (!value) patch[field] = null
      else if (field === 'price_minor') patch[field] = majorAmountToMinor(value, data.value!.home.currency)
      else {
        const count = Number(value)
        if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error('Nightly stay overrides must be whole numbers from 1 to 99.')
        patch[field] = count
      }
    }
    if (!Object.keys(patch).length) { writeError.value = 'Choose a setting to change.'; return }
    await write(patch)
  } catch (cause) { writeError.value = getErrorMessage(cause, 'Check the night settings') }
}
watch(selection, (value) => {
  edit('summary')
  notice.value = ''
  if (value.end && !pane.value) drawerOpen.value = true
})
const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  if ((event?.type === 'stay.changed' || event?.type === 'nights.changed') && event.productId === props.productId && !busy.value) void refresh()
})
watch(realtime.connectionEpoch, epoch => { if (epoch > 0 && !busy.value) void refresh() })
const calendarUi = {
  header: 'gap-3 pb-6', heading: 'text-left', body: 'pt-0', grid: 'w-full',
  gridWeekDaysRow: 'mb-2 grid-cols-7 gap-1 sm:gap-2', headCell: 'py-3 text-xs font-normal text-muted',
  gridBody: 'gap-1 sm:gap-2', gridRow: 'grid-cols-7 place-items-stretch gap-1 sm:gap-2', cell: 'min-w-0 w-full',
  cellTrigger: 'group m-0 block h-24 w-full rounded-2xl border border-default p-0 text-left sm:h-28 xl:h-32 data-outside-view:invisible data-selected:bg-inverted data-highlighted:bg-inverted data-highlighted:text-inverted',
}
</script>
