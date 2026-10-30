import type { MaybeRefOrGetter } from 'vue'
import type { PublicProduct } from '~/server/types/products'
import type { PublicProductLocation } from '~/server/utils/public-products'
import type { PublicStayCalendar, PublicStayNight, StayQuote } from '~/server/domain/stays'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { stayNightlyGroups } from '~/shared/stay-listing'
import { MAX_STAY_NIGHTS, STAY_CALENDAR_DAYS } from '~/shared/bookings'
import { addLocalDays, formatCalendarDate, isValidCalendarDate, isValidInstant, localDateAt } from '~/utils/timezone'
import { getPhoneCountry } from '~/utils/phone'
import { isRecord, normalizeApiError, publicApiMutation, publicApiRequest } from '~/utils/api-clients'
import type { ContactFormState } from '~/components/booking/BookingContactForm.vue'

export interface StayBookingContext {
  product: PublicProduct
  location: PublicProductLocation | null
  /** Whether the stay is paid for on the site; without it the chosen dates go to the host as an enquiry. */
  checkout: boolean
}

/**
 * Booking a place to stay on the site: the guest picks check-in and checkout
 * on the home's public nights, sets the party, sees the server's quote, gives
 * their contact details and pays the full amount on the site's pay page. The
 * nights come from the home's own calendar and the price from the server's
 * quote; nothing here prices or validates a stay on its own.
 */
export function useStayBooking(input: MaybeRefOrGetter<StayBookingContext>) {
  const context = computed(() => toValue(input))
  const { locale, t, localePath } = useI18n()
  const route = useRoute()
  const bookingOpen = ref(false)
  const bookingStep = ref(1)
  const contactForm = ref<ContactFormState>({ name: '', email: '', phone: '', notes: '' })
  const defaultPhoneCountry = computed(() => getPhoneCountry(context.value.location?.address?.regionCode)?.code)
  const calendar = ref<PublicStayCalendar | null>(null)
  const calendarPending = ref(false)
  const calendarError = ref('')
  const checkIn = ref<string | null>(null)
  const checkOut = ref<string | null>(null)
  const dateField = ref<'checkIn' | 'checkOut'>('checkIn')
  const adults = ref(1)
  const children = ref(0)
  const infants = ref(0)
  const quote = ref<StayQuote | null>(null)
  const quotePending = ref(false)
  const bookingError = ref('')
  const submitting = ref(false)
  let requestKey: string | null = null
  let requestFingerprint: string | null = null
  let restoredSelection = false

  const nightsByDate = computed(() => new Map((calendar.value?.nights ?? []).map(night => [night.date, night])))
  const maxGuests = computed(() => {
    const capacity = calendar.value?.home.max_guests ?? context.value.product.stay?.max_guests
    if (capacity === undefined) throw new Error('The home has no guest capacity')
    return capacity
  })
  const currency = computed(() => {
    const code = calendar.value?.home.currency
    return code && isCurrencyCode(code) ? code : null
  })

  async function loadCalendar() {
    if (calendarPending.value) return
    calendarPending.value = true
    calendarError.value = ''
    try {
      const timeZone = context.value.location?.timezone
      if (!timeZone) throw new Error('The home has no timezone')
      const from = localDateAt(new Date(), timeZone)
      calendar.value = await publicApiRequest<PublicStayCalendar>(`/api/public/products/${encodeURIComponent(context.value.product.slug)}/nights`, {
        query: { from, to: addLocalDays(from, STAY_CALENDAR_DAYS) },
        validate: (value): value is PublicStayCalendar => isRecord(value) && isRecord(value.home) && Array.isArray(value.nights),
      })
      restoreSelection()
    } catch (error) {
      calendarError.value = normalizeApiError(error).message
    } finally {
      calendarPending.value = false
    }
  }

  /** A canceled pay-page purchase returns its actual choices; the fresh quote still decides whether they can be booked. */
  function restoreSelection() {
    if (restoredSelection || !['dates', 'guests'].includes(String(route.query.stay_edit))) return
    restoredSelection = true
    bookingOpen.value = true
    bookingStep.value = 1
    const query = route.query
    const party = ['adults', 'children', 'infants'].map(key => typeof query[key] === 'string' && /^(0|[1-9]\d*)$/u.test(query[key]) ? Number(query[key]) : NaN)
    if (!isValidCalendarDate(query.check_in_date) || !isValidCalendarDate(query.check_out_date) || query.check_out_date <= query.check_in_date
      || party.some(value => !Number.isSafeInteger(value)) || party[0]! < 1) {
      bookingError.value = t('stay.error_booking_link')
      return
    }
    checkIn.value = query.check_in_date
    checkOut.value = query.check_out_date
    adults.value = party[0]!
    children.value = party[1]!
    infants.value = party[2]!
    dateField.value = 'checkIn'
  }

  function night(date: string): PublicStayNight | null {
    return nightsByDate.value.get(date) ?? null
  }

  /**
   * The days that can end a stay arriving on `from`: every night between is
   * free, the stay meets the arrival night's minimum and maximum, and the
   * day itself is open to departure.
   * The calendar only greys out what the nights already say; the server's quote
   * still decides, and names its reason when it refuses.
   */
  function* checkOuts(from: string) {
    const arrival = night(from)
    if (!arrival) return
    const minimum = arrival.min_stay_arrival
    let nights = 0
    for (let day = from; night(day)?.available; day = addLocalDays(day, 1)) {
      nights++
      if (nights > MAX_STAY_NIGHTS || (arrival.max_stay !== null && nights > arrival.max_stay)) return
      const end = addLocalDays(day, 1)
      const departure = night(end)
      if (nights >= minimum && departure && !departure.closed_to_departure) yield end
    }
  }

  /** A night can start a stay when it is not past, free, open to arrival and some day can end the stay. */
  function canCheckIn(date: string): boolean {
    const value = night(date)
    return Boolean(calendar.value && date >= calendar.value.home.today && value?.available && !value.closed_to_arrival && !checkOuts(date).next().done)
  }

  /** The first night a stay can start, or null when no stay fits the calendar's open nights. */
  const firstCheckIn = computed(() => calendar.value?.nights.find(value => canCheckIn(value.date))?.date ?? null)

  const checkOutDates = computed(() => [...(checkIn.value ? checkOuts(checkIn.value) : [])])
  const earliestCheckOut = computed(() => checkOutDates.value[0] ?? null)
  function canCheckOut(date: string): boolean {
    return checkOutDates.value.includes(date)
  }

  /** Nights between check-in and checkout, read from the dates themselves. */
  const nightCount = computed(() => {
    if (!checkIn.value || !checkOut.value) return 0
    let nights = 0
    for (let day = checkIn.value; day < checkOut.value; day = addLocalDays(day, 1)) nights++
    return nights
  })

  /** Calendar clicks edit the field the guest chose, including a completed range. */
  function selectDay(date: string) {
    if (dateField.value === 'checkOut') setCheckOut(date)
    else setCheckIn(date)
  }

  /** A typed or pressed check-in; one that cannot start a stay says why and changes nothing. */
  function setCheckIn(date: string) {
    bookingError.value = ''
    if (!canCheckIn(date)) {
      bookingError.value = checkInHint(date)
      return
    }
    const previousCheckOut = checkOut.value
    checkIn.value = date
    const keepsCheckOut = previousCheckOut !== null && [...checkOuts(date)].includes(previousCheckOut)
    checkOut.value = keepsCheckOut ? previousCheckOut : null
    dateField.value = keepsCheckOut ? 'checkIn' : 'checkOut'
  }

  /** A typed or pressed checkout for the chosen check-in; one that cannot end the stay says why. */
  function setCheckOut(date: string) {
    bookingError.value = ''
    if (canCheckOut(date)) {
      checkOut.value = date
      dateField.value = 'checkOut'
      return
    }
    bookingError.value = checkOutHint(date)
  }

  function checkInHint(date: string): string {
    const arrival = night(date)
    if (!calendar.value || date < calendar.value.home.today || !arrival?.available) return t('dates.date_unavailable')
    if (!canCheckIn(date)) return t('stay.error_no_check_in')
    return ''
  }

  /** Name the restriction, rather than presenting every disabled checkout as a minimum stay. */
  function checkOutHint(date: string): string {
    if (!checkIn.value) return t('stay.select_check_in')
    const arrival = night(checkIn.value)
    const departure = night(date)
    if (date <= checkIn.value || !departure || !arrival) return t('stay.error_no_check_out')
    let nights = 0
    const minimum = arrival.min_stay_arrival
    for (let day = checkIn.value; day < date; day = addLocalDays(day, 1)) {
      const stayed = night(day)
      if (!stayed?.available) return t('stay.error_unavailable')
      nights++
    }
    if (nights < minimum) return t('stay.error_min_nights', { count: minimum })
    if (arrival.max_stay !== null && nights > arrival.max_stay) return t('stay.error_max_nights', { count: arrival.max_stay })
    if (nights > MAX_STAY_NIGHTS) return t('stay.error_max_nights', { count: MAX_STAY_NIGHTS })
    if (departure.closed_to_departure) return t('stay.error_no_check_out')
    return ''
  }

  function clearCheckOut() {
    checkOut.value = null
    bookingError.value = ''
    dateField.value = 'checkOut'
  }

  function clearDates() {
    checkIn.value = null
    checkOut.value = null
    bookingError.value = ''
    dateField.value = 'checkIn'
  }

  /** The guest-facing words for a refusal the server named by its code. */
  function refusal(error: unknown): string {
    const failure = normalizeApiError(error)
    // The refusal's detail (the rule's limit) travels beside its code.
    const data = isRecord(failure.data.data) ? failure.data.data : failure.data
    const count = typeof data.min_nights === 'number' ? data.min_nights : typeof data.max_nights === 'number' ? data.max_nights : typeof data.max_guests === 'number' ? data.max_guests : null
    switch (failure.code) {
      case 'STAY_NIGHTS_UNAVAILABLE': return t('stay.error_unavailable')
      case 'STAY_MIN_NIGHTS': return count === null ? failure.message : t('stay.error_min_nights', { count })
      case 'STAY_MAX_NIGHTS': return count === null ? failure.message : t('stay.error_max_nights', { count })
      case 'STAY_CLOSED_TO_ARRIVAL': return t('stay.error_no_check_in')
      case 'STAY_CLOSED_TO_DEPARTURE': return t('stay.error_no_check_out')
      case 'STAY_TOO_MANY_GUESTS': return count === null ? failure.message : t('stay.max_guests', { count })
      default: return failure.message
    }
  }

  let quoteRun = 0
  async function refreshQuote() {
    quote.value = null
    quotePending.value = false
    // Counted before the dates are checked, so clearing them retires a request in flight.
    const run = ++quoteRun
    if (!checkIn.value || !checkOut.value) return
    quotePending.value = true
    bookingError.value = ''
    try {
      const response = await publicApiRequest<{ quote: StayQuote }>(`/api/public/products/${encodeURIComponent(context.value.product.slug)}/quote`, {
        query: { check_in_date: checkIn.value, check_out_date: checkOut.value, adults: adults.value, children: children.value, infants: infants.value },
        validate: (value): value is { quote: StayQuote } => isRecord(value) && isRecord(value.quote) && Number.isSafeInteger(value.quote.total_minor) && Array.isArray(value.quote.nightly),
      })
      // A later choice replaced this one while it was in flight.
      if (run === quoteRun) quote.value = response.quote
    } catch (error) {
      if (run === quoteRun) bookingError.value = refusal(error)
    } finally {
      if (run === quoteRun) quotePending.value = false
    }
  }
  watch([checkIn, checkOut, adults, children, infants], () => { void refreshQuote() })

  function money(minor: number): string {
    if (!currency.value) throw new Error('The home has no currency')
    return formatMinorAmount(minor, currency.value, locale.value)
  }
  const nightsLabel = (count: number) => count === 1 ? t('stay.one_night') : t('stay.nights_count', { count })
  const dateLabel = (date: string) => formatCalendarDate(date, locale.value, { weekday: 'short', month: 'short', day: 'numeric' })
  const rangeLabel = computed(() => checkIn.value && checkOut.value ? `${dateLabel(checkIn.value)} – ${dateLabel(checkOut.value)}` : '')
  const guestsLabel = computed(() => {
    const guests = adults.value + children.value
    return `${guests} ${t(guests === 1 ? 'site.experience_detail.guest' : 'site.experience_detail.guests')}`
  })
  const breakdown = computed(() => quote.value
    ? stayNightlyGroups(quote.value.nightly.map(entry => entry.price_minor)).map(({ price, nights }) => ({ label: t('stay.nightly_line', { price: money(price), nights: nightsLabel(nights) }), amount: money(price * nights) }))
    : [])

  /**
   * Choose where the dialog opens. Opening is the modal checkbox's job: the
   * controls are labels for it, and setting `bookingOpen` here as well raced the
   * label's own activation and flipped the checkbox shut again.
   */
  function openBooking(step: 1 | 2 = quote.value && checkout.value ? 2 : 1) {
    bookingStep.value = step
  }


  async function submitBooking(contact: ContactFormState) {
    if (submitting.value) return
    if (!quote.value || !checkIn.value || !checkOut.value) {
      bookingStep.value = 1
      return
    }
    submitting.value = true
    bookingError.value = ''
    try {
      const guest = { name: contact.name.trim(), email: contact.email.trim(), phone: contact.phone?.trim() || null, notes: contact.notes?.trim() || null }
      const fingerprint = JSON.stringify([context.value.product.id, checkIn.value, checkOut.value, adults.value, children.value, infants.value, guest.name, guest.email, guest.phone, guest.notes])
      if (fingerprint !== requestFingerprint) {
        requestKey = crypto.randomUUID()
        requestFingerprint = fingerprint
      }
      type CheckoutResponse = { success: true; status: 'checkout'; payment_id: string; pay_path: string; purchase_claim: string; expires_at: string }
      const response = await publicApiMutation<CheckoutResponse>(`/api/public/products/${encodeURIComponent(context.value.product.slug)}/book`, {
        method: 'POST',
        body: {
          idempotency_key: requestKey, check_in_date: checkIn.value, check_out_date: checkOut.value,
          adults: adults.value, children: children.value, infants: infants.value,
          guest_name: guest.name, guest_email: guest.email, guest_phone: guest.phone, notes: guest.notes, locale: locale.value,
        },
        validate: (value): value is CheckoutResponse => isRecord(value) && value.success === true && value.status === 'checkout' && typeof value.pay_path === 'string' && value.pay_path.startsWith('/pay/')
          && typeof value.purchase_claim === 'string' && typeof value.payment_id === 'string' && isValidInstant(value.expires_at),
      })
      // The site's own pay page; the claim rides in the fragment, which never leaves the browser.
      await navigateTo({ path: response.pay_path, hash: `#${response.purchase_claim}` })
    } catch (error) {
      const failure = normalizeApiError(error)
      if (failure.code === 'checkout_expired' || failure.code === 'checkout_failed') requestFingerprint = null
      bookingError.value = refusal(error)
      if (failure.code.startsWith('STAY_')) {
        bookingStep.value = 1
        void loadCalendar()
      }
    } finally {
      submitting.value = false
    }
  }

  const checkout = computed(() => context.value.checkout)
  /** The contact form, told which home, which nights and how many guests the enquiry is about. */
  const enquiryPath = computed(() => {
    const about = [context.value.product.name, rangeLabel.value, quote.value ? guestsLabel.value : ''].filter(Boolean).join(' · ')
    return `${localePath('/contact')}?about=${encodeURIComponent(about)}`
  })

  return {
    checkout, enquiryPath,
    bookingOpen, bookingStep, contactForm, defaultPhoneCountry, calendar, calendarPending, calendarError, checkIn, checkOut, dateField, adults, children, infants, maxGuests,
    quote, quotePending, bookingError, submitting, breakdown, rangeLabel, guestsLabel, nightCount,
    loadCalendar, night, canCheckIn, canCheckOut, checkInHint, checkOutHint, firstCheckIn, earliestCheckOut, selectDay, setCheckIn, setCheckOut, clearDates, clearCheckOut, openBooking, submitBooking, money, nightsLabel, dateLabel,
  }
}
export type StayBookingController = ReturnType<typeof useStayBooking>
