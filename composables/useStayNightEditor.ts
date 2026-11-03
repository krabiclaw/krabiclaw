import type { StayHome, StayNight } from '~/server/domain/stays'
import { MAX_STAY_NIGHTS, NIGHT_PRICE_CHANGE_PERCENT, changeNightPrice, resolveStayNightPolicy } from '~/shared/bookings'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { addLocalDays, isValidCalendarDate, isValidInstant } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

export type NightConcern = 'summary' | 'price' | 'custom' | 'minimum' | 'maximum' | 'arrival' | 'reset'
export type NightEditField = 'price_minor' | 'price_change_percent' | 'min_stay_arrival' | 'max_stay' | 'closed_to_arrival' | 'closed_to_departure'
export type NightDraft = Record<NightEditField, string>
export type NightPriceMode = 'set' | 'percent'
export type NightEditorHome = Pick<StayHome, 'product_id' | 'name' | 'timezone' | 'currency' | 'base_price_minor' | 'min_nights' | 'calendar_rules'>
/** One home's part of a selection: every selected night as last read, before weekdays narrow them and booked nights drop out. */
export interface NightEditorTarget { home: NightEditorHome; nights: StayNight[] }

const nullableAmount = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableRule = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const nullableText = (value: unknown) => value === null || typeof value === 'string'

/** A night as both calendars and the nights write return it. */
export function isStayNight(item: unknown): item is StayNight {
  return isRecord(item) && isValidCalendarDate(item.date)
    && typeof item.available === 'boolean' && typeof item.closed === 'boolean' && nullableText(item.stay_id) && nullableAmount(item.price_minor)
    && (item.calendar === null || item.calendar === 'vrbo')
    && typeof item.min_stay_arrival === 'number' && nullableRule(item.min_stay_arrival) && nullableRule(item.max_stay)
    && typeof item.closed_to_arrival === 'boolean' && typeof item.closed_to_departure === 'boolean'
    && [null, 'host', 'import'].includes(item.source as string | null) && (item.held_until === null || isValidInstant(item.held_until))
    && (item.channel === null || isRecord(item.channel) && ['pending', 'pushed', 'needs_review'].includes(String(item.channel.state)) && nullableText(item.channel.detail))
}

/** A night a guest or another calendar holds: a stay, a checkout hold or a linked-calendar night. A selection never writes one. */
export const isBookedNight = (night: StayNight) => Boolean(night.stay_id || night.held_until || night.calendar)

/** 0 Sunday to 6 Saturday, as the nights write reads weekdays. */
export const nightWeekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/** The mark a night carries while the channel has not confirmed it: sending, or refused and needing review. Received nights carry none. */
export const CHANNEL_MARKS = { pending: 'i-lucide-arrow-up', needs_review: 'i-lucide-triangle-alert' } as const

/** A night the channel has not confirmed: still queued for it, or refused and needing review. */
export const channelNote = (night: StayNight) => night.channel?.state === 'needs_review' ? night.channel.detail
  : night.channel?.state === 'pending' ? `Not on the channel yet. ${night.channel.detail ?? 'Waiting to be sent.'}` : null

const SETTINGS = ['closed', 'price_minor', 'min_stay_arrival', 'max_stay', 'closed_to_arrival', 'closed_to_departure'] as const

/**
 * The night inspector's model, one for every calendar that edits nights: a
 * home's own calendar selects nights at one home, the multi-calendar the same
 * nights at several. Each home is one nights write per run of nights, so each
 * home's change and its channel push succeed or fail on their own.
 */
export function useStayNightEditor(options: {
  targets: ComputedRef<NightEditorTarget[]>
  weekdays: Ref<number[] | null>
  manage: () => boolean
  loading: () => boolean
  /** Reads the calendar again; the targets then hold what was saved. */
  refresh: () => Promise<void>
  orgSlug: string
}) {
  const api = useDashboardApi(computed(() => ({ orgSlug: options.orgSlug })))
  const mutation = new AbortController()
  onScopeDispose(() => mutation.abort())
  const concern = ref<NightConcern>('summary')
  const busy = ref(false)
  const error = ref('')
  const result = ref('')
  const priceMode = ref<NightPriceMode>('set')
  const draft = reactive<NightDraft>({ price_minor: '', price_change_percent: '', min_stay_arrival: '', max_stay: '', closed_to_arrival: 'keep', closed_to_departure: 'keep' })
  const dirtyFields = ref<NightEditField[]>([])

  const onWeekday = (date: string) => !options.weekdays.value || options.weekdays.value.includes(nightWeekday(date))
  const chosen = (night: StayNight) => onWeekday(night.date) && !isBookedNight(night)
  /** The nights a save writes; booked nights and other weekdays are left out. */
  const nights = computed(() => options.targets.value.flatMap(target => target.nights.filter(chosen)))
  /** The selected nights that are booked, which the inspector shows and never writes. */
  const booked = computed(() => options.targets.value.flatMap(target => target.nights.filter(night => onWeekday(night.date) && isBookedNight(night))))
  /** Every selected date, at any home. */
  const dates = computed(() => [...new Set(options.targets.value.flatMap(target => target.nights.map(night => night.date)))].sort())
  const rangeWeekdays = computed(() => [...new Set(options.targets.value.flatMap(target => target.nights.map(night => nightWeekday(night.date))))].sort())
  const homes = computed(() => options.targets.value.map(target => target.home))
  const currency = computed(() => homes.value.every(home => home.currency === homes.value[0]?.currency) ? homes.value[0]?.currency ?? null : null)
  const notice = computed(() => [...new Set(nights.value.flatMap(night => channelNote(night) ?? []))].join(' '))

  function edit(value: NightConcern) {
    concern.value = value
    dirtyFields.value = []
    priceMode.value = currency.value ? 'set' : 'percent'
    result.value = ''
    for (const field of Object.keys(draft) as NightEditField[]) {
      const first = field === 'price_change_percent' ? undefined : nights.value[0]?.[field]
      const same = nights.value.every(night => field !== 'price_change_percent' && night[field] === first)
      draft[field] = field === 'closed_to_arrival' || field === 'closed_to_departure' ? 'keep'
        : same && typeof first === 'number' ? field === 'price_minor' ? currency.value ? minorAmountToMajor(first, currency.value) : '' : String(first) : ''
    }
    error.value = ''
  }
  function setField(field: NightEditField, value: string) {
    draft[field] = value
    if (!dirtyFields.value.includes(field)) dirtyFields.value.push(field)
  }
  function setPriceMode(mode: NightPriceMode) { priceMode.value = mode }

  /** What each night reads after the patch: a chosen night takes it, every other night keeps what it had. */
  function expected(home: NightEditorHome, before: StayNight, patch: Record<string, boolean | number | null>): Partial<StayNight> {
    if (!chosen(before)) return Object.fromEntries(SETTINGS.map(field => [field, before[field]]))
    const listing = resolveStayNightPolicy(home, before.date)
    if (patch.reset) return { source: null, closed: false, ...listing, max_stay: null, closed_to_arrival: false, closed_to_departure: false }
    const { price_change_percent: percent, ...settings } = patch
    return {
      ...settings,
      ...(settings.price_minor === null ? { price_minor: listing.price_minor } : {}),
      ...(settings.min_stay_arrival === null ? { min_stay_arrival: listing.min_stay_arrival } : {}),
      ...(typeof percent === 'number' && before.price_minor !== null ? { price_minor: changeNightPrice(before.price_minor, percent) } : {}),
    }
  }

  /** Each home's runs of free nights in date order: one nights write each, with the weekdays narrowing it on the server. */
  function runs(target: NightEditorTarget) {
    const free = target.nights.filter(night => !isBookedNight(night)).map(night => night.date).sort()
    const ranges: { from: string; to: string }[] = []
    for (const date of free) {
      const last = ranges.at(-1)
      if (last?.to === date) last.to = addLocalDays(date, 1)
      else ranges.push({ from: date, to: addLocalDays(date, 1) })
    }
    return ranges.filter(range => target.nights.some(night => night.date >= range.from && night.date < range.to && chosen(night)))
  }

  /** Every home is written, one after another; a home that fails does not stop the others. */
  async function write(patch: Record<string, boolean | number | null>) {
    const targets = options.targets.value
    if (busy.value || !options.manage() || !nights.value.length) return
    busy.value = true
    error.value = ''
    result.value = ''
    const failures: { home: NightEditorHome; message: string }[] = []
    const saved: { home: NightEditorHome; nights: StayNight[] }[] = []
    let savedNights = 0
    const attempted = targets.flatMap(target => runs(target).length ? [{ target, ranges: runs(target) }] : [])
    for (const { target, ranges } of attempted) {
      try {
        for (const range of ranges) {
          const response = await api(`/api/dashboard/stay-homes/${encodeURIComponent(target.home.product_id)}/nights`, {
            method: 'PUT', body: { ...range, ...(options.weekdays.value ? { weekdays: options.weekdays.value } : {}), ...patch }, signal: mutation.signal,
            validate: (value): value is { nights: StayNight[]; channel_push: unknown } => isRecord(value) && isRecord(value.home) && value.home.product_id === target.home.product_id
              && Array.isArray(value.nights) && value.nights.every(isStayNight) && Object.hasOwn(value, 'channel_push'),
          })
          savedNights += response.nights.filter(chosen).length
        }
        saved.push({ home: target.home, nights: target.nights })
      } catch (cause) {
        if (mutation.signal.aborted) return
        failures.push({ home: target.home, message: getErrorMessage(cause, 'The nights could not be saved') })
      }
    }
    try {
      await options.refresh()
      const after = new Map(options.targets.value.map(target => [target.home.product_id, new Map(target.nights.map(night => [night.date, night]))]))
      const mismatch = saved.find(({ home, nights: previous }) => previous.some((night) => {
        const read = after.get(home.product_id)?.get(night.date)
        return !read || Object.entries(expected(home, night, patch)).some(([field, value]) => read[field as keyof StayNight] !== value)
      }))
      if (mismatch) failures.push({ home: mismatch.home, message: 'The saved calendar does not match the selected night settings. Review the calendar before making another change.' })
    } catch (readError) {
      failures.push({ home: attempted[0]!.target.home, message: getErrorMessage(readError, 'The saved calendar could not be read back') })
    }
    const homes = attempted.length
    if (!failures.length) edit('summary')
    const synced = nights.value.filter(night => night.channel)
    if (synced.length) {
      const count = (state: 'pending' | 'needs_review') => synced.filter(night => night.channel!.state === state).length
      result.value = [`Airbnb: ${synced.filter(night => night.channel!.state === 'pushed').length} received`, ...(count('pending') ? [`${count('pending')} sending`] : []), ...(count('needs_review') ? [`${count('needs_review')} needs review`] : [])].join(' · ')
    }
    if (failures.length) {
      error.value = homes > 1
        ? `${homes - new Set(failures.map(failure => failure.home.product_id)).size} of ${homes} homes saved. ${failures.map(failure => `${failure.home.name}: ${failure.message}`).join(' ')}`
        : `${savedNights ? `${savedNights} of ${nights.value.length} nights saved. ` : ''}${failures.map(failure => failure.message).join(' ')}`
    }
    busy.value = false
  }

  async function save() {
    if (concern.value === 'reset') { await write({ reset: true }); return }
    const patch: Record<string, boolean | number | null> = {}
    try {
      for (const field of dirtyFields.value) {
        const value = draft[field].trim()
        if (field === 'price_minor' && priceMode.value === 'percent' || field === 'price_change_percent' && priceMode.value === 'set') continue
        if (field === 'closed_to_arrival' || field === 'closed_to_departure') {
          if (value !== 'keep') patch[field] = value === 'block'
        } else if (field === 'price_change_percent') {
          const percent = Number(value)
          if (!Number.isInteger(percent) || percent === 0 || Math.abs(percent) > NIGHT_PRICE_CHANGE_PERCENT) throw new Error(`Change prices by a whole percent from -${NIGHT_PRICE_CHANGE_PERCENT} to ${NIGHT_PRICE_CHANGE_PERCENT}, other than 0.`)
          patch[field] = percent
        } else if (!value) patch[field] = null
        else if (field === 'price_minor') {
          if (!currency.value) throw new Error('These homes use different currencies. Change their prices by a percent instead.')
          patch[field] = majorAmountToMinor(value, currency.value)
        } else {
          const count = Number(value)
          if (!Number.isInteger(count) || count < 1 || count > MAX_STAY_NIGHTS) throw new Error(`Nightly stay overrides must be whole numbers from 1 to ${MAX_STAY_NIGHTS}.`)
          patch[field] = count
        }
      }
      if (!Object.keys(patch).length) { error.value = 'Choose a setting to change.'; return }
      await write(patch)
    } catch (cause) { error.value = getErrorMessage(cause, 'Check the night settings') }
  }

  const inspector = computed(() => ({
    orgSlug: options.orgSlug, homes: homes.value, currency: currency.value, nights: nights.value, booked: booked.value, dates: dates.value, rangeWeekdays: rangeWeekdays.value, weekdays: options.weekdays.value,
    manage: options.manage(), busy: busy.value || options.loading(), error: error.value, notice: notice.value, result: result.value,
    concern: concern.value, draft, priceMode: priceMode.value, dirty: dirtyFields.value.length > 0,
  }))
  const listeners = { edit, cancel: () => edit('summary'), field: setField, priceMode: setPriceMode, patch: write, save }
  return { concern, busy, error, result, nights, booked, inspector, listeners, edit, write }
}
