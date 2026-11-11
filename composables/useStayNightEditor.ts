import type { StayHome, StayNight } from '~/server/domain/stays'
import type { PlaceDay, PlaceKind } from '~/server/domain/places'
import type { CurrencyCode } from '~/shared/currencies'
import { MAX_STAY_NIGHTS, NIGHT_PRICE_CHANGE_PERCENT, STAY_CHANNEL_LABELS, changeNightPrice, resolveStayNightPolicy } from '~/shared/bookings'
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { addLocalDays, isValidCalendarDate, isValidInstant } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

export type NightConcern = 'summary' | 'price' | 'custom' | 'minimum' | 'maximum' | 'arrival' | 'reset'
export type NightEditField = 'price_minor' | 'price_change_percent' | 'min_stay_arrival' | 'max_stay' | 'closed_to_arrival' | 'closed_to_departure'
export type NightDraft = Record<NightEditField, string>
export type NightPriceMode = 'set' | 'percent'
export type NightPatch = Record<string, boolean | number | null>
export type NightEditorHome = Pick<StayHome, 'product_id' | 'name' | 'internal_name' | 'timezone' | 'currency' | 'base_price_minor' | 'min_nights' | 'calendar_rules'>

/** One unit a calendar selection edits: a night at a home, or a day at a restaurant location or an offering. */
export interface CalendarSlot { date: string; closed: boolean }
/** One row's part of a selection: every selected slot as last read, before weekdays narrow them and held slots drop out. */
export interface EditorTarget<R extends { name: string }, S extends CalendarSlot> { home: R; nights: S[] }
/** The rows' names for the panel: "4 nights" at "homes", or "4 dates" at "places". */
export interface EditorNouns { unit: string; units: string; row: string; rows: string }

/**
 * What a row source is: how to tell its rows apart, which slots a guest or
 * the hours hold, what one write changes and what each slot reads after it.
 * Nights at homes take prices and stay rules; days at places take only open or block.
 */
export interface EditorSource<R extends { name: string }, S extends CalendarSlot> {
  id: (row: R) => string
  /** A slot held by a guest, another calendar or the hours: shown, never written. */
  held: (slot: S) => boolean
  /** What a slot reads as: "Reserved", "Blocked by you", "Available". */
  label: (slot: S) => string
  /** Why the selected held slots cannot change, when nothing else is selected. */
  heldExplanation: (booked: S[]) => string
  /** The line under a write's reach: what the held slots keep. */
  heldLine: (booked: S[]) => string
  /** One write for one run of slots at one row; the server narrows it to the weekdays. */
  write: (row: R, range: { from: string; to: string }, weekdays: number[] | null, patch: NightPatch) => Promise<void>
  /** What a chosen slot reads after the patch; the refresh is checked against it. */
  expected: (row: R, before: S, patch: NightPatch) => Partial<S>
  nouns: EditorNouns
  pricing: boolean
}

const nullableAmount = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableRule = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const nullableText = (value: unknown) => value === null || typeof value === 'string'

/** A night as both calendars and the nights write return it. */
export function isStayNight(item: unknown): item is StayNight {
  return isRecord(item) && isValidCalendarDate(item.date)
    && typeof item.available === 'boolean' && typeof item.closed === 'boolean' && nullableText(item.booking_id) && nullableAmount(item.price_minor)
    && (item.calendar === null || item.calendar === 'vrbo')
    && typeof item.min_stay_arrival === 'number' && nullableRule(item.min_stay_arrival) && nullableRule(item.max_stay)
    && typeof item.closed_to_arrival === 'boolean' && typeof item.closed_to_departure === 'boolean'
    && [null, 'host', 'import'].includes(item.source as string | null) && (item.held_until === null || isValidInstant(item.held_until))
    && (item.channel === null || isRecord(item.channel) && ['pending', 'pushed', 'needs_review'].includes(String(item.channel.state)) && nullableText(item.channel.detail))
}

/** A place's day as the places calendar and the dates write return it. */
export function isPlaceDay(item: unknown): item is PlaceDay {
  return isRecord(item) && isValidCalendarDate(item.date) && typeof item.closed === 'boolean'
    && (item.held === null || isRecord(item.held) && ['booked', 'hours', 'inactive', 'unscheduled'].includes(String(item.held.kind)) && typeof item.held.text === 'string')
    && typeof item.booked === 'number' && Number.isInteger(item.booked) && item.booked >= 0
    && (item.free === null || typeof item.free === 'number' && Number.isInteger(item.free) && item.free >= 0)
}

/** A night a guest or another calendar holds: a stay, a checkout hold or a linked-calendar night. A selection never writes one. */
export const isBookedNight = (night: StayNight) => Boolean(night.booking_id || night.held_until || night.calendar)

/** 0 Sunday to 6 Saturday, as the nights write reads weekdays. */
export const nightWeekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/** The mark a night carries while the channel has not confirmed it: sending, or refused and needing review. Received nights carry none. */
export const CHANNEL_MARKS = { pending: 'i-lucide-arrow-up', needs_review: 'i-lucide-triangle-alert' } as const

/** A night the channel has not confirmed: still queued for it, or refused and needing review. */
export const channelNote = (night: StayNight) => night.channel?.state === 'needs_review' ? night.channel.detail
  : night.channel?.state === 'pending' ? `Not on the channel yet. ${night.channel.detail ?? 'Waiting to be sent.'}` : null

const SETTINGS = ['closed', 'price_minor', 'min_stay_arrival', 'max_stay', 'closed_to_arrival', 'closed_to_departure'] as const
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Nights at homes: the one nights write per run, which also pushes to the channel. */
export function stayNightSource(api: ReturnType<typeof useDashboardApi>, signal: AbortSignal): EditorSource<NightEditorHome, StayNight> {
  return {
    id: home => home.product_id,
    held: isBookedNight,
    label: night => night.booking_id ? 'Reserved' : night.held_until ? 'Checkout hold' : night.calendar ? `Unavailable from ${STAY_CHANNEL_LABELS[night.calendar]}` : night.closed ? 'Blocked by you' : 'Available',
    // What holds nights a selection cannot change: a reservation is managed from its stay, a linked calendar from its channel, a hold by its guest's checkout.
    heldExplanation: booked => booked.some(night => night.booking_id)
      ? 'Booked nights belong to their reservations. Open the stay to manage it.'
      : booked.some(night => night.calendar)
        ? `${STAY_CHANNEL_LABELS[booked.find(night => night.calendar)!.calendar!]}'s calendar holds these nights. Change them there.`
        : 'A guest is checking out these nights. The hold ends on its own if they do not pay.',
    heldLine: booked => `${booked.length} booked ${booked.length === 1 ? 'night is' : 'nights are'} left out. Reservations, checkout holds and linked-calendar nights keep their settings.`,
    async write(home, range, weekdays, patch) {
      await api(`/api/dashboard/stay-homes/${encodeURIComponent(home.product_id)}/nights`, {
        method: 'PUT', body: { ...range, ...(weekdays ? { weekdays } : {}), ...patch }, signal,
        validate: (value): value is { nights: StayNight[]; channel_push: unknown } => isRecord(value) && isRecord(value.home) && value.home.product_id === home.product_id
          && Array.isArray(value.nights) && value.nights.every(isStayNight) && Object.hasOwn(value, 'channel_push'),
      })
    },
    expected(home, before, patch) {
      const listing = resolveStayNightPolicy(home, before.date)
      if (patch.reset) return { source: null, closed: false, ...listing, max_stay: null, closed_to_arrival: false, closed_to_departure: false }
      const { price_change_percent: percent, ...settings } = patch
      return {
        ...settings,
        ...(settings.price_minor === null ? { price_minor: listing.price_minor } : {}),
        ...(settings.min_stay_arrival === null ? { min_stay_arrival: listing.min_stay_arrival } : {}),
        ...(typeof percent === 'number' && before.price_minor !== null ? { price_minor: changeNightPrice(before.price_minor, percent) } : {}),
      }
    },
    nouns: { unit: 'night', units: 'nights', row: 'home', rows: 'homes' },
    pricing: true,
  }
}

export type PlaceRow = { kind: PlaceKind; id: string; name: string }

/** Days at places: the one dates write per run, which blocks a location's days or an offering's unclaimed sessions. */
export function placeDaySource(api: ReturnType<typeof useDashboardApi>, signal: AbortSignal): EditorSource<PlaceRow, PlaceDay> {
  return {
    id: place => `${place.kind}:${place.id}`,
    held: day => day.held !== null,
    label: day => day.held?.kind === 'booked' ? 'Booked' : day.held ? day.held.text : day.closed ? 'Blocked by you' : 'Available',
    heldExplanation: booked => booked.some(day => day.held?.kind === 'booked')
      ? 'Booked dates belong to their reservations and bookings. Open the day to manage them.'
      : `${booked.find(day => day.held)?.held?.text ?? 'These dates'}. Change the hours to open them.`,
    heldLine: booked => `${count(booked.length, 'booked date is', 'booked dates are')} left out. Reservations and bookings keep their dates.`,
    async write(place, range, weekdays, patch) {
      if (typeof patch.closed !== 'boolean' || Object.keys(patch).length !== 1) throw new Error('Places take only open or block.')
      await api(`/api/dashboard/places/${place.kind}/${encodeURIComponent(place.id)}/dates`, {
        method: 'PUT', body: { ...range, ...(weekdays ? { weekdays } : {}), closed: patch.closed }, signal,
        validate: (value): value is { place: PlaceRow; days: PlaceDay[] } => isRecord(value) && isRecord(value.place) && value.place.id === place.id && value.place.kind === place.kind && Array.isArray(value.days) && value.days.every(isPlaceDay),
      })
    },
    expected: (_place, _before, patch) => ({ closed: patch.closed === true }),
    nouns: { unit: 'date', units: 'dates', row: 'place', rows: 'places' },
    pricing: false,
  }
}

/**
 * The night inspector's model, one for every calendar that edits slots: a
 * home's own calendar selects nights at one home, the multi-calendar the same
 * nights at several homes, and the places grid the same days at several
 * places. Each row is one write per run of slots, so each row's change
 * succeeds or fails on its own.
 */
export function useStayNightEditor<R extends { name: string }, S extends CalendarSlot>(options: {
  source: (api: ReturnType<typeof useDashboardApi>, signal: AbortSignal) => EditorSource<R, S>
  targets: ComputedRef<EditorTarget<R, S>[]>
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
  const source = options.source(api, mutation.signal)
  const concern = ref<NightConcern>('summary')
  const busy = ref(false)
  const error = ref('')
  const result = ref('')
  const priceMode = ref<NightPriceMode>('set')
  const draft = reactive<NightDraft>({ price_minor: '', price_change_percent: '', min_stay_arrival: '', max_stay: '', closed_to_arrival: 'keep', closed_to_departure: 'keep' })
  const dirtyFields = ref<NightEditField[]>([])

  const onWeekday = (date: string) => !options.weekdays.value || options.weekdays.value.includes(nightWeekday(date))
  const chosen = (slot: S) => onWeekday(slot.date) && !source.held(slot)
  /** The slots a save writes; held slots and other weekdays are left out. */
  const nights = computed(() => options.targets.value.flatMap(target => target.nights.filter(chosen)))
  /** The selected slots that are held, which the inspector shows and never writes. */
  const booked = computed(() => options.targets.value.flatMap(target => target.nights.filter(slot => onWeekday(slot.date) && source.held(slot))))
  /** Every selected date, at any row. */
  const dates = computed(() => [...new Set(options.targets.value.flatMap(target => target.nights.map(slot => slot.date)))].sort())
  const rangeWeekdays = computed(() => [...new Set(options.targets.value.flatMap(target => target.nights.map(slot => nightWeekday(slot.date))))].sort())
  const homes = computed(() => options.targets.value.map(target => target.home))
  const stayNights = computed(() => nights.value.filter((slot): slot is S & StayNight => isStayNight(slot)))
  const stayHomes = computed(() => homes.value.filter((home): home is R & NightEditorHome => source.pricing && isRecord(home) && 'currency' in home))
  const currency = computed<CurrencyCode | null>(() => source.pricing && stayHomes.value.every(home => home.currency === stayHomes.value[0]?.currency) ? stayHomes.value[0]?.currency ?? null : null)
  const notice = computed(() => [...new Set(stayNights.value.flatMap(night => channelNote(night) ?? []))].join(' '))

  function edit(value: NightConcern) {
    concern.value = value
    dirtyFields.value = []
    priceMode.value = currency.value ? 'set' : 'percent'
    result.value = ''
    for (const field of Object.keys(draft) as NightEditField[]) {
      const first = field === 'price_change_percent' ? undefined : stayNights.value[0]?.[field]
      const same = stayNights.value.length === nights.value.length && stayNights.value.every(night => field !== 'price_change_percent' && night[field] === first)
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

  /** What each slot reads after the patch: a chosen slot takes it, every other slot keeps what it had. */
  function expected(home: R, before: S, patch: NightPatch): Partial<S> {
    if (!chosen(before)) return Object.fromEntries(SETTINGS.filter(field => field in before).map(field => [field, before[field as keyof S]])) as Partial<S>
    return source.expected(home, before, patch)
  }

  /** Each row's runs of free slots in date order: one write each, with the weekdays narrowing it on the server. */
  function runs(target: EditorTarget<R, S>) {
    const free = target.nights.filter(slot => !source.held(slot)).map(slot => slot.date).sort()
    const ranges: { from: string; to: string }[] = []
    for (const date of free) {
      const last = ranges.at(-1)
      if (last?.to === date) last.to = addLocalDays(date, 1)
      else ranges.push({ from: date, to: addLocalDays(date, 1) })
    }
    return ranges.filter(range => target.nights.some(slot => slot.date >= range.from && slot.date < range.to && chosen(slot)))
  }

  /** Every row is written, one after another; a row that fails does not stop the others. */
  async function write(patch: NightPatch) {
    const targets = options.targets.value
    if (busy.value || !options.manage() || !nights.value.length) return
    busy.value = true
    error.value = ''
    result.value = ''
    const failures: { home: R; message: string }[] = []
    const saved: EditorTarget<R, S>[] = []
    let savedSlots = 0
    const attempted = targets.flatMap(target => runs(target).length ? [{ target, ranges: runs(target) }] : [])
    for (const { target, ranges } of attempted) {
      try {
        for (const range of ranges) {
          await source.write(target.home, range, options.weekdays.value, patch)
          savedSlots += target.nights.filter(slot => slot.date >= range.from && slot.date < range.to && chosen(slot)).length
        }
        saved.push({ home: target.home, nights: target.nights })
      } catch (cause) {
        if (mutation.signal.aborted) return
        failures.push({ home: target.home, message: getErrorMessage(cause, `The ${source.nouns.units} could not be saved`) })
      }
    }
    try {
      await options.refresh()
      const after = new Map(options.targets.value.map(target => [source.id(target.home), new Map(target.nights.map(slot => [slot.date, slot]))]))
      for (const { home, nights: previous } of saved) {
        const mismatch = previous.some((slot) => {
          const read = after.get(source.id(home))?.get(slot.date)
          return !read || Object.entries(expected(home, slot, patch)).some(([field, value]) => read[field as keyof S] !== value)
        })
        if (mismatch) failures.push({ home, message: `The saved calendar does not match the selected ${source.nouns.unit} settings. Review the calendar before making another change.` })
      }
    } catch (readError) {
      const message = getErrorMessage(readError, 'The saved calendar could not be read back')
      for (const { home } of saved) failures.push({ home, message })
    }
    const rows = attempted.length
    if (!failures.length) edit('summary')
    const synced = failures.length ? [] : stayNights.value.filter(night => night.channel)
    if (synced.length) {
      const state = (value: 'pending' | 'needs_review') => synced.filter(night => night.channel!.state === value).length
      result.value = [`Airbnb: ${synced.filter(night => night.channel!.state === 'pushed').length} received`, ...(state('pending') ? [`${state('pending')} sending`] : []), ...(state('needs_review') ? [`${state('needs_review')} needs review`] : [])].join(' · ')
    }
    if (failures.length && 'price_change_percent' in patch) {
      // A failed home may still have committed its nights (a refused channel push), so the percent is not offered again.
      dirtyFields.value = dirtyFields.value.filter(field => field !== 'price_change_percent')
      draft.price_change_percent = ''
    }
    if (failures.length) {
      error.value = rows > 1
        ? `${rows - new Set(failures.map(failure => source.id(failure.home))).size} of ${rows} ${source.nouns.rows} saved. ${failures.map(failure => `${'internal_name' in failure.home ? failure.home.internal_name : failure.home.name}: ${failure.message}`).join(' ')}`
        : `${savedSlots ? `${savedSlots} of ${nights.value.length} ${source.nouns.units} saved. ` : ''}${failures.map(failure => failure.message).join(' ')}`
    }
    busy.value = false
  }

  async function save() {
    if (concern.value === 'reset') { await write({ reset: true }); return }
    const patch: NightPatch = {}
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
          if (!currency.value) throw new Error('Homes use different currencies. Use Adjust by percentage.')
          patch[field] = majorAmountToMinor(value, currency.value)
        } else {
          const count = Number(value)
          if (field === 'min_stay_arrival' && (!Number.isInteger(count) || count < 1)) throw new Error('Minimum nights must be at least 1.')
          if (!Number.isInteger(count) || count < 1 || count > MAX_STAY_NIGHTS) throw new Error(`Nightly stay overrides must be whole numbers from 1 to ${MAX_STAY_NIGHTS}.`)
          patch[field] = count
        }
      }
      if (!Object.keys(patch).length) { error.value = 'Choose a setting to change.'; return }
      await write(patch)
    } catch (cause) { error.value = getErrorMessage(cause, 'Check the night settings') }
  }

  const inspector = computed(() => ({
    orgSlug: options.orgSlug, homes: stayHomes.value, currency: currency.value, nights: nights.value, booked: booked.value, dates: dates.value, rangeWeekdays: rangeWeekdays.value, weekdays: options.weekdays.value,
    manage: options.manage(), busy: busy.value || options.loading(), error: error.value, notice: notice.value, result: result.value,
    concern: concern.value, draft, priceMode: priceMode.value, dirty: dirtyFields.value.length > 0,
    nouns: source.nouns, pricing: source.pricing,
    labels: nights.value.length ? nights.value.map(source.label) : booked.value.map(source.label),
    heldExplanation: nights.value.length ? '' : source.heldExplanation(booked.value),
    heldLine: booked.value.length && nights.value.length ? source.heldLine(booked.value) : '',
  }))
  const listeners = { edit, cancel: () => edit('summary'), field: setField, priceMode: setPriceMode, patch: write, save }
  return { concern, busy, error, result, nights, booked, inspector, listeners, edit, write }
}
