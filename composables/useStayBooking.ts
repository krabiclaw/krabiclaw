import type { MaybeRefOrGetter } from 'vue'
import type { PublicProduct } from '~/server/types/products'
import type { PublicStayCalendar, PublicStayNight, StayQuote } from '~/server/domain/stays'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { addLocalDays, formatCalendarDate, isValidInstant } from '~/utils/timezone'
import { isRecord, normalizeApiError, publicApiMutation, publicApiRequest } from '~/utils/api-clients'
import type { ContactFormState } from '~/components/booking/BookingContactForm.vue'

export interface StayBookingContext {
  product: PublicProduct
}

/** Months a guest can page through, and how many nights are read at once. */
const WINDOW_DAYS = 400

/**
 * Booking a place to stay on the site: the guest picks check-in and checkout
 * on the home's public nights, sets the party, sees the server's quote, gives
 * their contact details and pays the full amount on the site's pay page. The
 * nights come from the home's own calendar and the price from the server's
 * quote; nothing here prices or validates a stay on its own.
 */
export function useStayBooking(input: MaybeRefOrGetter<StayBookingContext>) {
  const context = computed(() => toValue(input))
  const { locale, t } = useI18n()
  const bookingOpen = ref(false)
  const bookingStep = ref(1)
  const calendar = ref<PublicStayCalendar | null>(null)
  const calendarPending = ref(false)
  const calendarError = ref('')
  const checkIn = ref<string | null>(null)
  const checkOut = ref<string | null>(null)
  const adults = ref(1)
  const children = ref(0)
  const infants = ref(0)
  const quote = ref<StayQuote | null>(null)
  const quotePending = ref(false)
  const bookingError = ref('')
  const submitting = ref(false)
  let requestKey: string | null = null
  let requestFingerprint: string | null = null

  const nightsByDate = computed(() => new Map((calendar.value?.nights ?? []).map(night => [night.date, night])))
  const maxGuests = computed(() => calendar.value?.home.max_guests ?? context.value.product.stay?.max_guests ?? 1)
  const currency = computed(() => {
    const code = calendar.value?.home.currency
    return code && isCurrencyCode(code) ? code : null
  })

  async function loadCalendar() {
    if (calendarPending.value) return
    calendarPending.value = true
    calendarError.value = ''
    try {
      // The window starts today where the guest is; the server reports today where the home is.
      const from = new Date().toISOString().slice(0, 10)
      calendar.value = await publicApiRequest<PublicStayCalendar>(`/api/public/products/${encodeURIComponent(context.value.product.slug)}/nights`, {
        query: { from: addLocalDays(from, -1), to: addLocalDays(from, WINDOW_DAYS - 1) },
        validate: (value): value is PublicStayCalendar => isRecord(value) && isRecord(value.home) && Array.isArray(value.nights),
      })
    } catch (error) {
      calendarError.value = normalizeApiError(error).message
    } finally {
      calendarPending.value = false
    }
  }

  function night(date: string): PublicStayNight | null {
    return nightsByDate.value.get(date) ?? null
  }

  /** A night can start a stay when it is free, priced and open to arrival. */
  function canCheckIn(date: string): boolean {
    const value = night(date)
    return Boolean(value?.available && !value.closed_to_arrival)
  }

  /**
   * A day can end the stay that starts at check-in when every night between is
   * free and the day itself is open to departure. The stay rules beyond that
   * (minimum and maximum nights) are the server's to state, with the reason.
   */
  function canCheckOut(date: string): boolean {
    if (!checkIn.value || date <= checkIn.value) return false
    for (let day = checkIn.value; day < date; day = addLocalDays(day, 1)) if (!night(day)?.available) return false
    return !night(date)?.closed_to_departure
  }

  function selectDay(date: string) {
    bookingError.value = ''
    if (!checkIn.value || checkOut.value || date <= checkIn.value || !canCheckOut(date)) {
      if (!canCheckIn(date)) return
      checkIn.value = date
      checkOut.value = null
      quote.value = null
      return
    }
    checkOut.value = date
  }

  function clearDates() {
    checkIn.value = null
    checkOut.value = null
    quote.value = null
    bookingError.value = ''
  }

  /** The guest-facing words for a refusal the server named by its code. */
  function refusal(error: unknown): string {
    const failure = normalizeApiError(error)
    // The refusal's detail (the rule's limit) travels beside its code.
    const data = isRecord(failure.data.data) ? failure.data.data : failure.data
    const count = typeof data.min_nights === 'number' ? data.min_nights : typeof data.max_nights === 'number' ? data.max_nights : typeof data.max_guests === 'number' ? data.max_guests : null
    switch (failure.code) {
      case 'STAY_NIGHTS_UNAVAILABLE': return t('stay.error_unavailable')
      case 'STAY_MIN_NIGHTS':
      case 'STAY_MIN_NIGHTS_THROUGH': return count === null ? failure.message : t('stay.error_min_nights', { count })
      case 'STAY_MAX_NIGHTS': return count === null ? failure.message : t('stay.error_max_nights', { count })
      case 'STAY_CLOSED_TO_ARRIVAL': return t('stay.error_no_check_in')
      case 'STAY_CLOSED_TO_DEPARTURE': return t('stay.error_no_check_out')
      case 'STAY_TOO_MANY_GUESTS': return count === null ? failure.message : t('stay.max_guests', { count })
      default: return failure.message
    }
  }

  async function refreshQuote() {
    quote.value = null
    if (!checkIn.value || !checkOut.value) return
    const asked = [checkIn.value, checkOut.value, adults.value, children.value, infants.value].join('|')
    quotePending.value = true
    bookingError.value = ''
    try {
      const response = await publicApiRequest<{ quote: StayQuote }>(`/api/public/products/${encodeURIComponent(context.value.product.slug)}/quote`, {
        query: { check_in_date: checkIn.value, check_out_date: checkOut.value, adults: adults.value, children: children.value, infants: infants.value },
        validate: (value): value is { quote: StayQuote } => isRecord(value) && isRecord(value.quote) && Number.isSafeInteger(value.quote.total_minor) && Array.isArray(value.quote.nightly),
      })
      // A later choice replaced this one while it was in flight.
      if (asked === [checkIn.value, checkOut.value, adults.value, children.value, infants.value].join('|')) quote.value = response.quote
    } catch (error) {
      bookingError.value = refusal(error)
    } finally {
      quotePending.value = false
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
    return `${guests} ${t(guests === 1 ? 'saya.experience_detail.guest' : 'saya.experience_detail.guests')}`
  })
  /** The quote's nights grouped by price, the way a receipt reads: "$120 × 3 nights". */
  const breakdown = computed(() => {
    if (!quote.value) return []
    const groups = new Map<number, number>()
    for (const entry of quote.value.nightly) groups.set(entry.price_minor, (groups.get(entry.price_minor) ?? 0) + 1)
    return [...groups].map(([price, count]) => ({ label: t('stay.nightly_line', { price: money(price), nights: nightsLabel(count) }), amount: money(price * count) }))
  })

  function openBooking() {
    bookingOpen.value = true
    bookingStep.value = 1
    if (!calendar.value) void loadCalendar()
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
      const fingerprint = JSON.stringify([context.value.product.id, checkIn.value, checkOut.value, adults.value, children.value, infants.value, contact.name.trim(), contact.email.trim(), contact.phone?.trim() || null, contact.notes?.trim() || null])
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
          guest_name: contact.name, guest_email: contact.email, guest_phone: contact.phone || null, notes: contact.notes || null, locale: locale.value,
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

  return {
    bookingOpen, bookingStep, calendar, calendarPending, calendarError, checkIn, checkOut, adults, children, infants, maxGuests,
    quote, quotePending, bookingError, submitting, breakdown, rangeLabel, guestsLabel,
    loadCalendar, night, canCheckIn, canCheckOut, selectDay, clearDates, openBooking, submitBooking, money, nightsLabel, dateLabel,
  }
}
export type StayBookingController = ReturnType<typeof useStayBooking>
