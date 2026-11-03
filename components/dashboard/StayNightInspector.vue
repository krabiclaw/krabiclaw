<template>
  <div data-testid="stay-night-inspector" class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <UButton v-if="selectDates" color="neutral" class="rounded-full px-4 py-2" :label="dateLabel" aria-label="Select nights" :disabled="busy" @click="$emit('dates')" />
      <span v-else class="rounded-full bg-inverted px-4 py-2 text-sm font-medium text-inverted">{{ dateLabel }}</span>
      <UButton icon="i-lucide-x" aria-label="Clear selected nights" color="neutral" variant="soft" square class="rounded-full" :disabled="busy" @click="$emit('clear')" />
    </div>
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted">{{ scope }}</p>
      <ULink v-if="calendarTo" :to="calendarTo" class="text-xs font-medium text-highlighted underline">Open calendar</ULink>
    </div>
    <div v-if="rangeWeekdays.length > 1">
      <p class="mb-2 text-sm font-medium text-highlighted">Apply to</p>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Apply to weekdays">
        <UButton
          v-for="day in WEEK"
          :key="day"
          :label="WEEKDAY_LABELS[day]"
          :aria-label="WEEKDAY_NAMES[day]"
          :aria-pressed="applies(day)"
          color="neutral"
          :variant="applies(day) ? 'solid' : 'outline'"
          class="rounded-full px-3"
          :disabled="busy || !rangeWeekdays.includes(day) || applies(day) && chosenDays.length === 1"
          @click="toggleWeekday(day)"
        />
      </div>
      <p class="mt-2 text-sm text-muted">The change applies only to the chosen weekdays within these dates.</p>
      <p v-if="weekdays" class="mt-1 text-sm text-muted" data-testid="stay-night-weekdays">{{ weekdaySummary }}</p>
    </div>
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
    <UAlert v-if="notice" color="warning" variant="soft" :description="notice" />
    <p v-if="result && concern === 'summary'" class="text-sm text-highlighted" data-testid="stay-night-result">{{ result }}</p>
    <UAlert v-if="blocker && concern === 'summary'" color="neutral" variant="soft" :description="blocker" data-testid="stay-night-blocker" :actions="manage ? [{ label: 'Change minimum nights', color: 'neutral', variant: 'solid', onClick: () => $emit('blocker') }] : undefined" />
    <template v-if="concern === 'summary'">
      <UCard class="rounded-3xl bg-inverted text-inverted" :ui="{ body: 'p-5' }">
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm">{{ availabilityLabel }}</p>
          <USwitch v-if="nights.length && closed !== 'mixed'" :model-value="!closed" aria-label="Open selected nights" color="neutral" :disabled="busy || !manage" @update:model-value="$emit('patch', { closed: !$event })" />
        </div>
        <div v-if="nights.length && closed === 'mixed' && manage && pendingClosed === null" class="mt-4 flex gap-2">
          <UButton label="Open dates" color="neutral" variant="outline" :disabled="busy" @click="pendingClosed = false" />
          <UButton label="Block nights" color="neutral" variant="outline" :disabled="busy" @click="pendingClosed = true" />
        </div>
        <div v-if="pendingClosed !== null" class="mt-4 space-y-3" data-testid="stay-night-confirm">
          <p class="text-sm">Some selected nights are open and some are blocked. {{ pendingClosed ? 'Block' : 'Open' }} all {{ nights.length }} {{ nights.length === 1 ? 'night' : 'nights' }}?</p>
          <div class="flex gap-2">
            <UButton :label="pendingClosed ? 'Block all nights' : 'Open all nights'" color="neutral" variant="solid" class="bg-default text-highlighted" :disabled="busy" @click="confirmClosed" />
            <UButton :label="pendingClosed ? 'Keep dates open' : 'Keep dates blocked'" color="neutral" variant="link" class="text-inverted" :disabled="busy" @click="pendingClosed = null" />
          </div>
        </div>
        <UButton v-if="nights.length && closed === true && manage" label="Open dates" color="neutral" variant="outline" class="mt-4" :disabled="busy" @click="$emit('patch', { closed: false })" />
        <p v-if="!nights.length" class="mt-3 text-sm" data-testid="stay-night-held">{{ heldExplanation }}</p>
        <p v-if="booked.length && nights.length" class="mt-3 text-sm" data-testid="stay-night-booked">{{ booked.length }} booked {{ booked.length === 1 ? 'night is' : 'nights are' }} left out. Reservations, checkout holds and linked-calendar nights keep their settings.</p>
        <p v-for="expiry in holdExpiries" :key="expiry.at" class="mt-3 text-sm">Checkout hold expires {{ formatTimestamp(expiry.at, 'en', expiry.timezone) }} ({{ expiry.timezone }}).</p>
        <UButton v-for="id in stayIds" :key="id" :to="{ path: `/dashboard/${orgSlug}/calendar/stay/${encodeURIComponent(id)}`, query: route.query }" label="View stay" color="neutral" variant="outline" class="mt-3" />
      </UCard>
      <UButton label="Nightly price" color="neutral" class="w-full flex-col items-start rounded-3xl p-6 text-left" :disabled="busy || !manage || !nights.length" @click="$emit('edit', 'price')">
        <span class="block text-sm font-normal">Nightly price</span>
        <span class="mt-4 block text-3xl font-semibold">{{ priceLabel }}</span>
      </UButton>
      <UButton label="Minimum nights" color="neutral" variant="soft" class="w-full flex-col items-start rounded-3xl p-6 text-left" :disabled="busy || !manage || !nights.length" @click="$emit('edit', 'minimum')">
        <span class="block text-sm font-normal">Minimum nights</span>
        <span class="mt-4 block text-3xl font-semibold">{{ minimumLabel }}</span>
        <span class="mt-1 block text-sm font-normal text-muted">{{ defaultMinimumLabel }}</span>
      </UButton>
      <UButton v-if="manage" label="Custom settings" trailing-icon="i-lucide-plus" color="neutral" class="w-full justify-between rounded-3xl p-6" :disabled="busy || !nights.length" @click="$emit('edit', 'custom')" />
      <p v-else class="text-sm text-muted">Only owners and admins can change these nights.</p>
    </template>
    <template v-else-if="concern === 'custom'">
      <h2 class="text-xl font-semibold text-highlighted">Custom settings</h2>
      <UButton v-for="item in settingItems" :key="item.concern" :label="item.label" trailing-icon="i-lucide-chevron-right" color="neutral" variant="outline" class="w-full justify-between py-4" :disabled="busy" @click="$emit('edit', item.concern)" />
      <UButton label="Reset all night settings" color="neutral" variant="link" class="px-0" :disabled="busy" @click="$emit('edit', 'reset')" />
      <UButton label="Done" color="neutral" class="w-full" @click="$emit('cancel')" />
    </template>
    <template v-else>
      <h2 class="text-xl font-semibold text-highlighted">{{ concernTitle }}</h2>
      <template v-if="concern === 'price'">
        <div class="flex gap-1 rounded-full bg-elevated p-1" role="group" aria-label="Price change">
          <UButton v-for="mode in PRICE_MODES" :key="mode.value" :label="mode.label" :aria-pressed="priceMode === mode.value" color="neutral" :variant="priceMode === mode.value ? 'solid' : 'ghost'" class="flex-1 justify-center rounded-full" :disabled="busy || mode.value === 'set' && !currency" @click="$emit('priceMode', mode.value)" />
        </div>
        <template v-if="priceMode === 'set'">
          <UFormField :label="currency ? `Nightly price (${currency})` : 'Nightly price'">
            <UInput :model-value="draft.price_minor" :placeholder="price === 'mixed' ? 'Mixed prices' : 'Use listing price'" inputmode="decimal" class="w-full" :ui="{ base: 'py-6 text-center text-3xl font-semibold' }" :disabled="busy || !currency" @update:model-value="$emit('field', 'price_minor', String($event))" />
          </UFormField>
          <p class="text-sm text-muted">{{ basePriceLabel }}</p>
        </template>
        <template v-else>
          <UFormField label="Adjust by percentage">
            <UInput :model-value="draft.price_change_percent" type="number" :min="-NIGHT_PRICE_CHANGE_PERCENT" :max="NIGHT_PRICE_CHANGE_PERCENT" step="1" placeholder="0" class="w-full" :ui="{ base: 'py-6 text-center text-3xl font-semibold', trailing: 'pe-6' }" :disabled="busy" @update:model-value="$emit('field', 'price_change_percent', $event == null ? '' : String($event))">
              <template #trailing><span class="text-2xl text-muted">%</span></template>
            </UInput>
          </UFormField>
          <p class="text-sm text-muted">{{ currency ? percentLabel : `Homes use different currencies. Use Adjust by percentage. ${percentLabel}` }}</p>
        </template>
        <UButton label="Restore listing price" color="neutral" variant="link" class="px-0" :disabled="busy" @click="$emit('patch', { price_minor: null })" />
        <p v-if="booked.length" class="text-sm text-muted">Existing bookings keep the price they were booked at.</p>
      </template>
      <template v-else-if="concern === 'minimum'">
        <div class="flex flex-wrap gap-1.5" role="group" aria-label="Minimum nights presets">
          <UButton v-for="preset in minimumPresets" :key="preset.label" :label="preset.label" :aria-pressed="presetChosen(preset.value)" color="neutral" :variant="presetChosen(preset.value) ? 'solid' : 'outline'" class="rounded-full px-3" :disabled="busy" @click="$emit('field', 'min_stay_arrival', preset.value)" />
        </div>
        <UFormField label="Minimum nights on arrival">
          <UInput :model-value="draft.min_stay_arrival" type="number" min="1" :max="MAX_STAY_NIGHTS" step="1" :placeholder="common('min_stay_arrival') === 'mixed' ? 'Mixed settings' : 'Use home default'" class="w-full" :disabled="busy" @update:model-value="$emit('field', 'min_stay_arrival', $event == null ? '' : String($event))" />
        </UFormField>
        <p v-if="booked.length" class="text-sm text-muted">Existing bookings keep the stay rules they were booked with.</p>
        <p class="text-sm text-muted">Set a minimum stay for specific dates. It applies to arrivals on the selected nights. {{ homes.length > 1 ? 'Each home’s default stays on every other night.' : `The home default of ${homes[0]?.min_nights} ${homes[0]?.min_nights === 1 ? 'night' : 'nights'} stays on every other night.` }}</p>
      </template>
      <template v-else-if="concern === 'maximum'">
        <p class="text-sm text-muted">Clear this override to remove the night’s maximum.</p>
        <UFormField label="Maximum nights">
          <UInput :model-value="draft.max_stay" type="number" min="1" :max="MAX_STAY_NIGHTS" step="1" :placeholder="common('max_stay') === 'mixed' ? 'Mixed settings' : 'Use default'" class="w-full" :disabled="busy" @update:model-value="$emit('field', 'max_stay', $event == null ? '' : String($event))" />
        </UFormField>
      </template>
      <template v-else-if="concern === 'arrival'">
        <UFormField v-for="field in arrivalFields" :key="field.key" :label="field.label" :description="common(field.key) === 'mixed' ? 'Mixed across the selected nights.' : undefined">
          <USelect :model-value="draft[field.key]" :items="permissionItems" class="w-full" :disabled="busy" @update:model-value="$emit('field', field.key, String($event))" />
        </UFormField>
      </template>
      <p v-else-if="concern === 'reset'" class="text-sm text-muted">Remove all selected nights’ custom prices, closures and stay rules. The listing’s settings apply again. Existing reservations and checkout holds remain.</p>
      <div class="flex items-center justify-between gap-4 border-t border-default pt-5">
        <UButton label="Cancel" color="neutral" variant="link" :disabled="busy" @click="$emit('cancel')" />
        <UButton :label="concern === 'reset' ? 'Reset all night settings' : 'Save'" color="neutral" :loading="busy" :disabled="concern !== 'reset' && !dirty" @click="$emit('save')" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { StayNight } from '~/server/domain/stays'
import type { CurrencyCode } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'
import { MAX_STAY_NIGHTS, NIGHT_PRICE_CHANGE_PERCENT, STAY_CHANNEL_LABELS, changeNightPrice } from '~/shared/bookings'
import { formatTimestamp } from '~/utils/timezone'
import type { NightConcern, NightDraft, NightEditField, NightEditorHome, NightPriceMode } from '~/composables/useStayNightEditor'

const props = defineProps<{
  orgSlug: string
  homes: NightEditorHome[]
  /** The homes' one currency; null when they differ. */
  currency: CurrencyCode | null
  /** The selected nights a save writes: the weekdays' nights, without booked ones, at every home. */
  nights: StayNight[]
  /** The selected nights that are booked: shown, never written. */
  booked: StayNight[]
  /** Every selected date, at any home. */
  dates: string[]
  /** The line under the dates: the homes and nights, or the one home's own details. */
  scope: string
  /** Why the selected free nights cannot be booked, when a minimum blocks them. */
  blocker?: string | null
  /** The weekdays the selected range covers, 0 Sunday to 6 Saturday. */
  rangeWeekdays: number[]
  /** The weekdays chosen; null is every weekday. */
  weekdays: number[] | null
  dateLabel: string
  selectDates?: boolean
  /** The one selected home's own calendar on the first selected night. */
  calendarTo?: { path: string; query: Record<string, string> }
  manage: boolean
  busy: boolean
  error: string
  notice: string
  result: string
  concern: NightConcern
  draft: NightDraft
  priceMode: NightPriceMode
  dirty: boolean
}>()
const route = useRoute()
const emit = defineEmits<{
  clear: []
  dates: []
  blocker: []
  weekdays: [weekdays: number[] | null]
  edit: [concern: NightConcern]
  cancel: []
  save: []
  field: [field: NightEditField, value: string]
  priceMode: [mode: NightPriceMode]
  patch: [patch: Record<string, boolean | number | null>]
}>()
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const PRICE_MODES = [{ value: 'set', label: 'Set price' }, { value: 'percent', label: 'Adjust by percentage' }] as const
const chosenDays = computed<number[]>(() => props.weekdays ?? props.rangeWeekdays)
const applies = (day: number) => chosenDays.value.includes(day)
function toggleWeekday(day: number) {
  const next = applies(day) ? chosenDays.value.filter(value => value !== day) : [...chosenDays.value, day].sort()
  emit('weekdays', props.rangeWeekdays.every(value => next.includes(value)) ? null : next)
}
const list = (words: string[]) => words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
const weekdaySummary = computed(() => `${list(WEEK.filter(applies).map(day => WEEKDAY_NAMES[day]!))} · ${props.dates.filter(date => applies(new Date(`${date}T00:00:00Z`).getUTCDay())).length} of ${props.dates.length} nights`)
function common<K extends keyof StayNight>(field: K): StayNight[K] | 'mixed' {
  const first = props.nights[0]?.[field]
  return props.nights.length && props.nights.every(night => night[field] === first) ? first as StayNight[K] : 'mixed'
}
const money = (value: number) => props.currency ? formatMinorAmount(value, props.currency) : String(value)
const closed = computed(() => common('closed'))
/** A confirmed choice of one state for a selection that is partly open and partly blocked. */
const pendingClosed = ref<boolean | null>(null)
function confirmClosed() {
  emit('patch', { closed: pendingClosed.value! })
  pendingClosed.value = null
}
watch(() => props.nights, () => { pendingClosed.value = null })
// What holds nights a selection cannot change: a reservation is managed from its stay, a linked calendar from its channel, a hold by its guest's checkout.
const heldExplanation = computed(() => props.booked.some(night => night.stay_id)
  ? 'Booked nights belong to their reservations. Open the stay to manage it.'
  : props.booked.some(night => night.calendar)
    ? `${STAY_CHANNEL_LABELS[props.booked.find(night => night.calendar)!.calendar!]}'s calendar holds these nights. Change them there.`
    : 'A guest is checking out these nights. The hold ends on its own if they do not pay.')
const stayIds = computed(() => [...new Set(props.booked.flatMap(night => night.stay_id ? [night.stay_id] : []))])
const holdExpiries = computed(() => props.homes.length === 1
  ? [...new Set(props.booked.flatMap(night => night.held_until ? [night.held_until] : []))].sort().map(at => ({ at, timezone: props.homes[0]!.timezone }))
  : [])
// The nights a save changes decide the label; a selection of booked nights alone says what holds them.
const availabilityLabel = computed(() => {
  const states = new Set((props.nights.length ? props.nights : props.booked).map(night => night.stay_id ? 'Reserved' : night.held_until ? 'Checkout hold' : night.calendar ? `Unavailable from ${STAY_CHANNEL_LABELS[night.calendar]}` : night.closed ? 'Blocked by you' : 'Available'))
  return states.size === 1 ? [...states][0] : 'Mixed availability'
})
const price = computed(() => props.currency ? common('price_minor') : 'mixed')
const priceLabel = computed(() => price.value === 'mixed' ? 'Mixed prices' : price.value === null ? 'No price set' : money(price.value))
const basePriceLabel = computed(() => props.homes.length === 1
  ? `Base nightly price: ${props.homes[0]!.base_price_minor === null ? 'Not set' : money(props.homes[0]!.base_price_minor)}.`
  : 'Each home keeps its own listing price when restored.')
const percentLabel = computed(() => {
  const percent = Number(props.draft.price_change_percent)
  if (!Number.isInteger(percent) || percent === 0) return `Each night’s own price changes by this percent, from −${NIGHT_PRICE_CHANGE_PERCENT}% to +${NIGHT_PRICE_CHANGE_PERCENT}%.`
  const first = props.nights[0]?.price_minor
  if (props.currency && typeof first === 'number' && props.nights.every(night => night.price_minor === first)) return `${money(first)} → ${money(changeNightPrice(first, percent))} on ${props.nights.length} ${props.nights.length === 1 ? 'night' : 'nights'}`
  return `Each night’s price ${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`
})
const minimum = computed(() => common('min_stay_arrival'))
const minimumLabel = computed(() => minimum.value === 'mixed' ? 'Mixed' : `${minimum.value} ${minimum.value === 1 ? 'night' : 'nights'}`)
const homeDefault = computed(() => props.homes.every(home => home.min_nights === props.homes[0]?.min_nights) ? props.homes[0]?.min_nights ?? null : null)
const defaultMinimumLabel = computed(() => homeDefault.value === null ? 'Home defaults differ by home' : `Home default: ${homeDefault.value} ${homeDefault.value === 1 ? 'night' : 'nights'}`)
const minimumPresets = computed(() => [
  { label: '1 night', value: '1' }, { label: '3 nights', value: '3' }, { label: '1 week', value: '7' },
  { label: homeDefault.value === null ? 'Home default' : `Home default (${homeDefault.value})`, value: '' },
])
const presetChosen = (value: string) => props.draft.min_stay_arrival === value && (value !== '' || props.dirty)
const concernTitle = computed(() => ({ summary: '', custom: 'Custom settings', price: 'Nightly price', minimum: 'Minimum nights', maximum: 'Maximum nights', arrival: 'Check-in and checkout', reset: 'Reset all night settings' })[props.concern])
const settingItems = [{ concern: 'maximum', label: 'Maximum nights' }, { concern: 'arrival', label: 'Check-in and checkout' }] as const
const arrivalFields = [{ key: 'closed_to_arrival', label: 'Allow check-in' }, { key: 'closed_to_departure', label: 'Allow checkout' }] as const
const permissionItems = [{ label: 'Keep each night’s setting', value: 'keep' }, { label: 'Allowed', value: 'allow' }, { label: 'Not allowed', value: 'block' }]
</script>
