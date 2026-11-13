import type { MaybeRefOrGetter } from 'vue'
import type { LodgingConfirmationMode } from '~/shared/lodging-booking'
import type { PublicProduct } from '~/server/types/products'
import type { PublicProductLocation } from '~/server/utils/public-products'
import type { PublicStayCalendar, PublicStayNight, StayQuote } from '~/server/domain/stays'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { AVAILABILITY_PAGE_DAYS, MAX_STAY_NIGHTS, STAY_CALENDAR_DAYS } from '~/shared/bookings'
import { addLocalDays, formatCalendarDate, isValidCalendarDate, isValidInstant, localDateAt } from '~/utils/timezone'
import { getPhoneCountry } from '~/utils/phone'
import { isRecord, normalizeApiError, publicApiMutation, publicApiRequest } from '~/utils/api-clients'
import type { ContactFormState } from '~/components/booking/BookingContactForm.vue'

export interface StayBookingContext {
  product: PublicProduct
  location: PublicProductLocation | null
  /** Whether the stay is paid for on the site; without it the chosen dates go to the host as an enquiry. */
  checkout: boolean
  confirmationMode: LodgingConfirmationMode | null
}

interface StayRequestReceipt {
  activity_path: string
  status: 'pending' | 'confirmed' | 'cancelled'
  request_status: 'awaiting_approval' | 'awaiting_payment' | null
}

/**
 * Booking a place to stay on the site: the guest picks check-in and checkout
 * on the home's public nights, sets the party, sees the server's quote, gives
 * their contact details and either pays or asks the host to approve their
 * request first. The nights come from the home's calendar and the price from the server's
 * quote; nothing here prices or validates a stay on its own.
 */
export function useStayBooking(input: MaybeRefOrGetter<StayBookingContext>) {
  const context = computed(() => toValue(input))
  const { locale, t, localePath } = useI18n()
  const { pageEventId } = useOrganizationConversionTracking()
  const route = useRoute()
  const bookingOpen = ref(false)
  const bookingStep = ref(1)
  const submittedRequest = ref<StayRequestReceipt | null>(null)
  const contactForm = ref<ContactFormState>({ name: '', email: '', phone: '', notes: '', answers: {} })
  // The home's own questions, asked beside the guest's contact details.
  const formQuestions = useFormQuestionState(() => context.value.product.stay, computed({ get: () => contactForm.value.answers, set: (answers) => { contactForm.value.answers = answers } }))
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

  const calendarPages = new Map<string, Promise<PublicStayCalendar>>()
  const horizon = computed(() => calendar.value ? addLocalDays(calendar.value.home.today, STAY_CALENDAR_DAYS) : null)
  let pendingPages = 0

  async function loadCalendar(start?: string, end?: string, refresh = false) {
    try {
      const timeZone = context.value.location?.timezone
      if (!timeZone) throw new Error('The home has no timezone')
      const today = localDateAt(new Date(), timeZone)
      const last = addLocalDays(today, STAY_CALENDAR_DAYS)
      const from = start && start > today ? start : today
      const until = end && end < last ? end : last
      if (until <= from) return
      const slug = context.value.product.slug
      const pages: Promise<PublicStayCalendar>[] = []
      for (let cursor = from; cursor < until;) {
        const pageEnd = addLocalDays(cursor, AVAILABILITY_PAGE_DAYS)
        const to = pageEnd < until ? pageEnd : until
        const key = `${slug}:${cursor}:${to}`
        if (refresh) calendarPages.delete(key)
        let loaded = true
        for (let day = cursor; day <= to && loaded; day = addLocalDays(day, 1)) loaded = Boolean(night(day))
        if (refresh || !loaded) {
          let page = calendarPages.get(key)
          if (!page) {
            page = publicApiRequest<PublicStayCalendar>(`/api/public/products/${encodeURIComponent(slug)}/availability`, {
              query: { from: cursor, to },
              validate: (value): value is PublicStayCalendar => isRecord(value) && value.unit === 'nights' && isRecord(value.home) && Array.isArray(value.nights),
            }).finally(() => { calendarPages.delete(key) })
            calendarPages.set(key, page)
          }
          pages.push(page)
        }
        cursor = to
      }
      if (!pages.length) return
      calendarPending.value = true
      pendingPages++
      calendarError.value = ''
      try {
        const incoming = await Promise.all(pages)
        if (slug !== context.value.product.slug) return
        const nights = new Map(nightsByDate.value)
        for (const page of incoming) for (const night of page.nights) nights.set(night.date, night)
        calendar.value = { home: incoming[0]!.home, nights: [...nights.values()].sort((a, b) => a.date.localeCompare(b.date)) }
      } finally {
        pendingPages--
        calendarPending.value = pendingPages > 0
      }
    } catch (error) {
      calendarError.value = normalizeApiError(error).message
    }
  }

  async function openCalendar() {
    const { check_in_date: arrival, check_out_date: departure, stay_edit: mode } = route.query
    const timezone = context.value.location?.timezone
    if (!timezone) {
      calendarError.value = 'The home has no timezone'
      return
    }
    const today = localDateAt(new Date(), timezone)
    const returning = !restoredSelection && ['dates', 'guests'].includes(String(mode))
    if (returning && isValidCalendarDate(arrival) && isValidCalendarDate(departure)
      && arrival >= today && departure > arrival && departure <= addLocalDays(today, STAY_CALENDAR_DAYS)
      && departure <= addLocalDays(arrival, MAX_STAY_NIGHTS)) {
      await loadCalendar(arrival, departure)
    } else {
      await loadCalendar(today, addLocalDays(today, AVAILABILITY_PAGE_DAYS))
    }
    if (returning) restoreSelection()
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
      || !nightsByDate.value.has(query.check_in_date) || !nightsByDate.value.has(query.check_out_date)
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
    if (!calendar.value || !horizon.value || date < calendar.value.home.today || !value?.available || value.closed_to_arrival) return false
    if (!checkOuts(date).next().done) return true
    const earliest = addLocalDays(date, value.min_stay_arrival)
    if (earliest > horizon.value) return false
    for (let day = date; day <= earliest; day = addLocalDays(day, 1)) {
      const known = night(day)
      if (!known) return true
      if (day < earliest && !known.available) return false
    }
    return false
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
    if (dateField.value === 'checkOut') {
      setCheckOut(date)
      if (checkOut.value === date) dateField.value = 'checkIn'
    } else setCheckIn(date)
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
    const end = addLocalDays(date, Math.max(AVAILABILITY_PAGE_DAYS, night(date)!.min_stay_arrival + 1))
    if (!night(end)) void loadCalendar(date, end)
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
    if (nights < minimum) return t('stay.min_nights', { count: minimum })
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
        validate: (value): value is { quote: StayQuote } => isRecord(value) && isRecord(value.quote) && Number.isSafeInteger(value.quote.total_minor) && Array.isArray(value.quote.nightly)
          && Array.isArray(value.quote.nightly_groups) && isRecord(value.quote.price_summary) && ['stay', 'month'].includes(String(value.quote.price_summary.basis))
          && Number.isSafeInteger(value.quote.price_summary.amount_minor) && Number.isSafeInteger(value.quote.price_summary.display_amount_minor),
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

  function money(minor: number, whole = false): string {
    if (!currency.value) throw new Error('The home has no currency')
    return formatMinorAmount(minor, currency.value, locale.value, whole ? 0 : undefined)
  }
  const nightsLabel = (count: number) => count === 1 ? t('stay.one_night') : t('stay.nights_count', { count })
  const dateLabel = (date: string) => formatCalendarDate(date, locale.value, { weekday: 'short', month: 'short', day: 'numeric' })
  const rangeLabel = computed(() => checkIn.value && checkOut.value ? [checkIn.value, checkOut.value].map(date => formatCalendarDate(date, locale.value, { month: 'short', day: 'numeric', year: 'numeric' })).join(' - ') : '')
  const guestsLabel = computed(() => {
    const guests = adults.value + children.value
    return `${guests} ${t(guests === 1 ? 'site.experience_detail.guest' : 'site.experience_detail.guests')}`
  })
  const breakdown = computed(() => quote.value
    ? quote.value.nightly_groups.map(group => ({ label: t('stay.nightly_line', { price: money(group.price_minor), nights: nightsLabel(group.nights) }), amount: money(group.total_minor) }))
    : [])
  const priceSummary = computed(() => {
    const current = quote.value
    if (!current) return null
    const summary = current.price_summary
    const monthly = summary.basis === 'month'
    return { headline: money(summary.display_amount_minor, true), amount: money(summary.amount_minor), period: monthly ? t('stay.monthly') : t('stay.for_nights', { nights: nightsLabel(current.nights) }), monthly }
  })

  function openBooking(step: 1 | 2 = quote.value && checkout.value ? 2 : 1) {
    submittedRequest.value = null
    bookingStep.value = step
    if (step === 1) dateField.value = checkIn.value && !checkOut.value ? 'checkOut' : 'checkIn'
    bookingOpen.value = true
  }


  async function submitBooking(contact: ContactFormState) {
    if (submitting.value || submittedRequest.value) return
    if (!quote.value || !checkIn.value || !checkOut.value) {
      bookingStep.value = 1
      return
    }
    submitting.value = true
    bookingError.value = ''
    formQuestions.clear()
    try {
      const guest = { name: contact.name.trim(), email: contact.email.trim(), phone: contact.phone?.trim() || null, notes: contact.notes?.trim() || null }
      const confirmationMode = context.value.confirmationMode
      if (!confirmationMode) throw new Error('The home has no booking policy')
      const fingerprint = JSON.stringify([context.value.product.id, confirmationMode, checkIn.value, checkOut.value, adults.value, children.value, infants.value, guest.name, guest.email, guest.phone, guest.notes, formQuestions.submission()])
      if (fingerprint !== requestFingerprint) {
        requestKey = crypto.randomUUID()
        requestFingerprint = fingerprint
      }
      type CheckoutResponse = { success: true; status: 'checkout'; payment_id: string; pay_path: string; purchase_claim: string; expires_at: string }
        | (StayRequestReceipt & { success: true })
      const response = await publicApiMutation<CheckoutResponse>(`/api/public/products/${encodeURIComponent(context.value.product.slug)}/book`, {
        method: 'POST',
        body: {
          idempotency_key: requestKey, check_in_date: checkIn.value, check_out_date: checkOut.value,
          adults: adults.value, children: children.value, infants: infants.value,
          guest_name: guest.name, guest_email: guest.email, guest_phone: guest.phone, notes: guest.notes, ...formQuestions.submission(), locale: locale.value,
          confirmation_mode: confirmationMode,
          page_event_id: await pageEventId(),
        },
        validate: (value): value is CheckoutResponse => isRecord(value) && value.success === true
          && (value.status === 'checkout'
            ? typeof value.pay_path === 'string' && value.pay_path.startsWith('/pay/') && typeof value.purchase_claim === 'string'
              && typeof value.payment_id === 'string' && isValidInstant(value.expires_at)
            : typeof value.activity_path === 'string' && value.activity_path.startsWith('/dashboard/account/activity/stay/')
              && (value.status === 'pending' ? value.request_status === 'awaiting_approval' || value.request_status === 'awaiting_payment'
                : (value.status === 'confirmed' || value.status === 'cancelled') && value.request_status === null)),
      })
      if (response.status !== 'checkout') {
        submittedRequest.value = response
        return
      }
      // The site's own pay page; the claim rides in the fragment, which never leaves the browser.
      await navigateTo({ path: response.pay_path, hash: `#${response.purchase_claim}` })
    } catch (error) {
      const failure = normalizeApiError(error)
      if (failure.code === 'checkout_expired' || failure.code === 'checkout_failed') requestFingerprint = null
      // Changed questions are a review of what was entered, not a failure to retype.
      bookingError.value = formQuestions.handleRefusal(failure) && formQuestions.notice.value ? '' : refusal(error)
      if (failure.code.startsWith('STAY_')) {
        bookingStep.value = 1
        if (checkIn.value && checkOut.value) void loadCalendar(checkIn.value, checkOut.value, true)
        else void openCalendar()
      }
    } finally {
      submitting.value = false
    }
  }

  const checkout = computed(() => context.value.checkout)
  const needsApproval = computed(() => checkout.value && context.value.confirmationMode === 'review')
  const actionLabel = computed(() => t(!checkout.value ? 'stay.send_enquiry' : needsApproval.value ? 'stay.request_to_book' : 'stay.reserve'))
  /** The contact form, told which home, which nights and how many guests the enquiry is about. */
  const enquiryPath = computed(() => {
    const about = [context.value.product.name, rangeLabel.value, quote.value ? guestsLabel.value : ''].filter(Boolean).join(' · ')
    return `${localePath('/contact')}?about=${encodeURIComponent(about)}`
  })

  return {
    checkout, enquiryPath, needsApproval, actionLabel, submittedRequest,
    bookingOpen, bookingStep, contactForm, formQuestions, defaultPhoneCountry, calendar, calendarPending, calendarError, checkIn, checkOut, dateField, adults, children, infants, maxGuests,
    quote, quotePending, bookingError, submitting, breakdown, priceSummary, rangeLabel, guestsLabel, nightCount,
    openCalendar, loadCalendar, horizon, night, canCheckIn, canCheckOut, checkInHint, checkOutHint, firstCheckIn, earliestCheckOut, selectDay, setCheckIn, setCheckOut, clearDates, clearCheckOut, openBooking, submitBooking, money, nightsLabel, dateLabel,
  }
}
export type StayBookingController = ReturnType<typeof useStayBooking>
