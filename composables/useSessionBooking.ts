import type { MaybeRefOrGetter } from 'vue'
import type { PublicProduct } from '~/server/types/products'
import type { PublicProductLocation, PublicProductSession } from '~/server/utils/public-products'
import type { CurrencyCode } from '~/shared/currencies'
import { selectPrice } from '~/shared/prices'
import { formatProductMoney } from '~/utils/product-money'
import { isValidInstant, isValidTimezone, localDateAt, localPartsAt, TIMEZONE_OPTIONS } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { getPhoneCountry } from '~/utils/phone'
import { isRecord, normalizeApiError, publicApiRequest, publicApiMutation } from '~/utils/api-clients'
import { setBookingConfirmation } from '~/composables/useBookingHandoff'
import type { SubmissionMeasurement } from '~/composables/useOrganizationConversionTracking'
import type { ConversionValue } from '~/utils/organization-conversion-events'
import type { ContactFormState } from '~/components/booking/BookingContactForm.vue'
import type { RawDateAvailability, TimeSlotSelection } from '~/components/booking/BookingTimeStep.vue'

export interface SessionBookingContext {
  organizationId: string
  organizationName: string
  product: PublicProduct
  currency: CurrencyCode
  location: PublicProductLocation | null
  sessions: PublicProductSession[]
  showPartySize?: boolean
}

/** The public Product booking flow, shared by location pages and online consultations. */
export function useSessionBooking(input: MaybeRefOrGetter<SessionBookingContext>) {
  const context = computed(() => toValue(input))
  const { locale, localePath, t } = useI18n()
  const { trackCheckoutStart, mirrorSubmission, pageEventId } = useOrganizationConversionTracking()
  const sellableVariants = computed(() => context.value.product.variants.filter(variant => variant.active))
  const bookingOpen = ref(false)
  const bookingStep = ref(1)
  const contactForm = ref<ContactFormState>({ name: '', email: '', phone: '', notes: '' })
  const defaultPhoneCountry = computed(() => getPhoneCountry(context.value.location?.address?.regionCode)?.code)
  const showPartySize = computed(() => context.value.showPartySize !== false)
  const selectedPartySize = ref(1)
  const partySize = computed({
    get: () => showPartySize.value ? selectedPartySize.value : 1,
    set: (value: number) => { selectedPartySize.value = showPartySize.value ? value : 1 },
  })
  /** The options a customer can actually choose — what is priced, and what is booked. */
  const selectedVariantId = ref<string | null>(sellableVariants.value.length === 1 ? sellableVariants.value[0]!.id : null)
  const variantPrice = (variant: PublicProduct['variants'][number]) => selectPrice(variant.prices, { currency: context.value.currency, location_id: context.value.location?.id ?? null, at: new Date().toISOString() })
  /** The price of the variant being booked: it decides whether the guest pays before the booking is made. */
  const selectedPrice = computed(() => {
    const variant = sellableVariants.value.find(candidate => candidate.id === selectedVariantId.value)
    return variant ? variantPrice(variant) : null
  })
  function variantPriceLabel(variant: PublicProduct['variants'][number]) {
    const price = variantPrice(variant)
    return !showPartySize.value && price?.unit_amount === 0 ? t('booking.free') : formatProductMoney(price)
  }
  const timeSelection = ref<TimeSlotSelection | null>(null)
  const submitting = ref(false)
  const checkoutRequestKey = ref<string | null>(null)
  let checkoutFingerprint: string | null = null
  const bookingError = ref('')
  /**
   * The occurrences, as the page was served with them.
   *
   * They arrive from the payload rather than from a fetch after hydration, so
   * the dates are in the HTML. The client refresh below replaces them; it does
   * not supply them, because the first reader may be a crawler that runs nothing.
   */
  const sessions = ref<PublicProductSession[]>([...context.value.sessions])
  const sessionsPending = ref(false)
  const allowTimezoneSelection = computed(() => !showPartySize.value && context.value.location === null)
  const guestTimezone = ref<string | null>(null)
  const bookingTimezone = computed(() => allowTimezoneSelection.value && guestTimezone.value
    ? guestTimezone.value : sessions.value[0]?.timezone ?? null)
  const timezoneOptions = computed(() => [...new Set(['UTC', sessions.value[0]?.timezone, bookingTimezone.value, ...TIMEZONE_OPTIONS].filter((zone): zone is string => Boolean(zone)))].sort())
  onMounted(() => {
    if (allowTimezoneSelection.value) guestTimezone.value = new Intl.DateTimeFormat().resolvedOptions().timeZone
  })
  watch(bookingTimezone, () => { timeSelection.value = null })
  const referenceDate = computed(() => bookingTimezone.value ? localDateAt(new Date(), bookingTimezone.value) : undefined)

  function localDateOf(session: PublicProductSession) {
    const parts = localPartsAt(new Date(session.starts_at), allowTimezoneSelection.value ? bookingTimezone.value! : session.timezone)
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  }
  function localTimeOf(session: PublicProductSession) {
    const parts = localPartsAt(new Date(session.starts_at), allowTimezoneSelection.value ? bookingTimezone.value! : session.timezone)
    return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  }

  // A party books one provider; places from different providers cannot be combined.
  const offeredTimes = computed(() => {
    const times = new Map<string, PublicProductSession>()
    for (const session of sessions.value) {
      const key = `${session.starts_at}:${session.ends_at}`
      const current = times.get(key)
      if (!current || (current.is_full && !session.is_full) || (current.is_full === session.is_full && (session.remaining ?? Infinity) > (current.remaining ?? Infinity))) times.set(key, session)
    }
    return [...times.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  })

  // The calendar speaks in the session's own zone, so a 10:00 class is 10:00 for
  // every guest reading the page from anywhere.
  const availabilityDates = computed<RawDateAvailability[]>(() => {
    const byDate = new Map<string, RawDateAvailability>()
    for (const session of offeredTimes.value) {
      const date = localDateOf(session)
      const entry = byDate.get(date) ?? { date, slots: [] }
      entry.slots.push({
        session_id: session.id,
        time_slot: localTimeOf(session),
        capacity: session.remaining === null ? null : session.remaining,
        remaining: session.remaining,
        is_closed: false,
        is_full: session.is_full,
      })
      byDate.set(date, entry)
    }
    return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
  })

  /**
   * The largest party the calendar can take.
   *
   * Seats live on the session, not on the product: `default_capacity` is what
   * generating an occurrence starts from, and the sessions already on the
   * calendar keep whatever capacity they were given. Reading the product default
   * here capped a twelve-seat session at four, and a product with no default at
   * an unrelated eight.
   *
   * Once a time is chosen it is that session's remaining seats; before then it is
   * the most any session on the calendar has left. A session with no capacity at
   * all takes any party the endpoint accepts.
   */
  const MAX_PARTY_SIZE = 99
  const guestsMax = computed(() => {
    const pool = selectedSession.value ? [selectedSession.value] : sessions.value
    if (!pool.length) return 1
    if (pool.some(session => session.remaining === null)) return MAX_PARTY_SIZE
    return Math.max(1, ...pool.map(session => session.remaining ?? 0))
  })

  const selectedSession = computed<PublicProductSession | null>(() => {
    const selection = timeSelection.value
    if (!selection) return null
    if (selection.sessionId) return sessions.value.find(session => session.id === selection.sessionId) ?? null
    return sessions.value.find(session => localDateOf(session) === selection.day && localTimeOf(session) === selection.time) ?? null
  })

  watch([sessions, partySize], () => {
    const chosen = selectedSession.value
    if (!chosen) { timeSelection.value = null; return }
    if (!chosen.is_full && (chosen.remaining === null || chosen.remaining >= partySize.value)) return
    const replacement = offeredTimes.value.find(session => session.starts_at === chosen.starts_at && session.ends_at === chosen.ends_at && !session.is_full && (session.remaining === null || session.remaining >= partySize.value))
    timeSelection.value = replacement ? { ...timeSelection.value!, sessionId: replacement.id } : null
  })

  /**
   * Load what the form needs. Opening is the checkbox's job.
   *
   * The control is a label for the modal's checkbox, so pressing it toggles that
   * checkbox and the modal reports the new state back through v-model. Setting
   * `bookingOpen` here as well raced the label's own activation: the state said
   * open, the checkbox had been flipped back, and the dialog stayed hidden with
   * its sessions loaded behind it.
   */
  /**
   * Re-read the occurrences, for a reader who has been on the page a while.
   *
   * This refreshes what the page was served with; it is not the only source of
   * it. A failure leaves the rendered sessions standing and says the load
   * failed — it does not claim there is nothing to book, which is a different
   * fact and the one this page used to state wrongly.
   */
  async function loadSessions() {
    if (sessionsPending.value) return
    sessionsPending.value = true
    try {
      const response = await publicApiRequest<{ success: true; sessions: PublicProductSession[] }>(
        // This page is one branch's page, so it asks for that branch's
        // occurrences. Two branches running the same class at the same hour
        // would otherwise be indistinguishable by date and time alone.
        `/api/public/products/${encodeURIComponent(context.value.product.slug)}/sessions?location_id=${encodeURIComponent(context.value.location?.id ?? 'online')}`,
        {
          validate: (value): value is { success: true; sessions: PublicProductSession[] } =>
            isRecord(value) && value.success === true && Array.isArray(value.sessions),
        },
      )
      sessions.value = response.sessions
    } catch (error) {
      bookingError.value = getErrorMessage(error, t('booking.sessions_failed'))
    } finally {
      sessionsPending.value = false
    }
  }

  async function openBooking() {
    bookingStep.value = 1
    bookingError.value = ''
    await loadSessions()
  }

  watch(bookingOpen, (open) => {
    // Observe the modal's canonical state, including an opening before hydration.
    // The option and its price are not chosen yet, so none is claimed here.
    if (open) trackCheckoutStart(context.value.product.id, context.value.location?.id ?? null, { products: [{ product_id: context.value.product.id, name: context.value.product.name, quantity: 1 }] }, selectedVariantId.value)
  })

  /** A guest pressing a time on the page arrives in the form with it chosen. */
  async function openBookingAt(session: PublicProductSession) {
    timeSelection.value = { sessionId: session.id, day: localDateOf(session), time: localTimeOf(session), label: sessionDayLabel(session) }
    await openBooking()
  }

  const upcomingSessions = computed(() => {
    const now = Date.now()
    return offeredTimes.value
      .filter(session => !session.is_full && Date.parse(session.starts_at) > now)
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
      .slice(0, 4)
  })

  function sessionDayLabel(session: PublicProductSession): string {
    return new Intl.DateTimeFormat(locale.value, { weekday: 'short', day: 'numeric', month: 'short', timeZone: allowTimezoneSelection.value ? bookingTimezone.value! : session.timezone }).format(new Date(session.starts_at))
  }
  function sessionTimeLabel(session: PublicProductSession): string {
    const format = new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit', timeZone: allowTimezoneSelection.value ? bookingTimezone.value! : session.timezone })
    return `${format.format(new Date(session.starts_at))} – ${format.format(new Date(session.ends_at))}`
  }


  async function submitBooking(contact: ContactFormState) {
    const session = selectedSession.value
    if (submitting.value) return
    if (!session) {
      bookingError.value = t('site.experience_detail.choose_time')
      bookingStep.value = 1
      return
    }
    if (!selectedVariantId.value) {
      bookingError.value = t('site.product_detail.choose_option')
      bookingStep.value = 1
      return
    }
    submitting.value = true
    bookingError.value = ''
    try {
      const fingerprint = JSON.stringify({
        organizationId: context.value.organizationId, productId: context.value.product.id,
        sessionId: session.id, variantId: selectedVariantId.value, partySize: partySize.value,
        name: contact.name.trim(), email: contact.email.trim(),
        phone: contact.phone?.trim() || null, notes: contact.notes?.trim() || null,
      })
      if (fingerprint !== checkoutFingerprint) {
        checkoutRequestKey.value = crypto.randomUUID()
        checkoutFingerprint = fingerprint
      }
      checkoutRequestKey.value ??= crypto.randomUUID()
      type CheckoutResponse = { success: true; status: 'checkout'; payment_id: string; pay_path: string; purchase_claim: string; expires_at: string }
      type BookingResponse = { success: true; status: 'pending' | 'confirmed'; operational_booking_id: string; request_id: string; booking_id: string; cancellation_token: string; starts_at: string; ends_at: string; timezone: string; message: string; quoted_value?: ConversionValue | null; measurement?: SubmissionMeasurement; policy_summary?: ApiRecord | null }
      const response = await publicApiMutation<CheckoutResponse | BookingResponse>(
        `/api/public/products/${encodeURIComponent(context.value.product.slug)}/book`,
        {
          method: 'POST',
          body: {
            idempotency_key: checkoutRequestKey.value,
            session_id: session.id,
            variant_id: selectedVariantId.value,
            party_size: partySize.value,
            guest_name: contact.name,
            guest_email: contact.email,
            guest_phone: contact.phone || null,
            notes: contact.notes || null,
            locale: locale.value,
            page_event_id: await pageEventId(),
          },
          validate: (value): value is CheckoutResponse | BookingResponse =>
            isRecord(value) && value.success === true && ((value.status === 'checkout' && typeof value.pay_path === 'string' && value.pay_path.startsWith('/pay/') && typeof value.purchase_claim === 'string' && typeof value.payment_id === 'string' && isValidInstant(value.expires_at))
              || (typeof value.booking_id === 'string' && typeof value.cancellation_token === 'string' && typeof value.operational_booking_id === 'string' && typeof value.request_id === 'string'
                && (value.status === 'pending' || value.status === 'confirmed') && typeof value.message === 'string' && isValidInstant(value.starts_at) && isValidInstant(value.ends_at) && typeof value.timezone === 'string' && isValidTimezone(value.timezone))),
        },
      )
      if (response.status === 'checkout') {
        // The site's own pay page; the claim rides in the fragment, which never leaves the browser.
        await navigateTo({ path: response.pay_path, hash: `#${response.purchase_claim}` })
        return
      }
      mirrorSubmission('booking_submit', response.measurement, context.value.location?.id ?? null, response.quoted_value)
      setBookingConfirmation({
        type: 'booking', status: response.status, operationalBookingId: response.operational_booking_id, requestId: response.request_id,
        locale: locale.value,
        organizationId: context.value.organizationId,
        organizationName: context.value.location?.title ?? context.value.organizationName,
        guestName: contact.name,
        guestEmail: contact.email,
        startsAt: response.starts_at,
        timezone: allowTimezoneSelection.value ? bookingTimezone.value! : response.timezone,
        guests: partySize.value,
        productId: context.value.product.id,
        productKind: context.value.product.kind,
        title: context.value.product.name,
        requests: contact.notes || null,
        message: response.message,
        cancelUrl: `${localePath('/bookings/cancel')}?id=${encodeURIComponent(response.booking_id)}#${response.cancellation_token}`,
        policySummary: response.policy_summary ? { ...response.policy_summary, additional_notes_html: context.value.product.details.cancellation_policy ?? null } : null,
        locationId: context.value.location?.id ?? null,
        locationName: context.value.location?.title ?? context.value.organizationName,
        locationSlug: context.value.location?.slug ?? null,
      })
      bookingOpen.value = false
      await navigateTo({ path: localePath('/bookings/confirmed'), query: { id: response.request_id }, hash: `#${response.cancellation_token}` })
      checkoutRequestKey.value = null
      checkoutFingerprint = null
    } catch (error) {
      const failure = normalizeApiError(error)
      if (failure.code === 'checkout_expired' || failure.code === 'checkout_failed') {
        checkoutRequestKey.value = null
        checkoutFingerprint = null
      }
      bookingError.value = failure.message
    } finally {
      submitting.value = false
    }
  }

    return { bookingOpen, bookingStep, contactForm, defaultPhoneCountry, partySize, showPartySize, allowTimezoneSelection, guestTimezone, bookingTimezone, timezoneOptions, selectedVariantId, selectedPrice, sellableVariants, variantPriceLabel,
      timeSelection, submitting, bookingError, sessions, sessionsPending, availabilityDates, referenceDate, guestsMax,
      selectedSession, loadSessions, openBooking, openBookingAt, upcomingSessions,
      sessionDayLabel, sessionTimeLabel, submitBooking }
}
export type SessionBookingController = ReturnType<typeof useSessionBooking>
