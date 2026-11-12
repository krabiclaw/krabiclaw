import { isRecord } from '~/utils/api-clients'
import { localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation, type BookingPresentation } from '~/utils/booking-presentation'
import { paymentStateLabel } from '~/shared/payment-display'
import type { DashboardBookingDetails, DashboardRecordType } from '~/server/utils/dashboard-booking-details'

/**
 * One booking record, loaded once per route.
 *
 * The record is drawn in two places — its own screen under Today, and the
 * detail column of the guest thread it belongs to — and the screen that draws
 * the chrome needs the same title the body does. Both call this; the shared
 * `useAsyncData` key means that is one request, not two.
 */
export function isBookingDetailsResponse(value: unknown): value is { booking: DashboardBookingDetails } {
  return isRecord(value)
    && isRecord(value.booking)
    && (value.booking.type === 'booking'
      ? typeof value.booking.conversation_id === 'string' && typeof value.booking.booking_id === 'string' && value.booking.payment_id === null
      : (value.booking.type === 'order' || value.booking.type === 'payment') && typeof value.booking.payment_id === 'string'
        && value.booking.conversation_id === null && value.booking.booking_id === null)
    && typeof value.booking.organization_id === 'string'
    && (value.booking.guest_name === null || typeof value.booking.guest_name === 'string')
    && (value.booking.notes === null || typeof value.booking.notes === 'string')
    && Array.isArray(value.booking.answers)
    && (value.booking.policy === null || isRecord(value.booking.policy))
}

// A purchase is not a booking of anything; its one word is the same for every vertical.
const PURCHASE: BookingPresentation = {
  noun: 'purchase',
  nounPlural: 'purchases',
  label: 'Purchase',
  labelPlural: 'Purchases',
  counterpartyNoun: 'buyer',
  counterpartyLabel: 'Buyer',
  partyLabel: 'Items',
  formatCount: count => String(count),
}

export async function useBookingDetails(bookingType: DashboardRecordType, bookingId: string, personalScope = false) {
  const route = useRoute()
  // The heading follows the clock while the page stays open.
  const now = ref(new Date())
  let clock: ReturnType<typeof setInterval> | undefined
  onMounted(() => { clock = setInterval(() => { now.value = new Date() }, 60_000) })
  onBeforeUnmount(() => clearInterval(clock))
  // The account reads its own booking from the account API; the business reads the organization's.
  const dashboardApi = personalScope ? applicationFetch : useDashboardApi()
  const endpoint = `/api/${personalScope ? 'account' : 'dashboard'}/bookings/${bookingType}/${encodeURIComponent(bookingId)}`
  const orgSlug = computed(() => personalScope ? 'account' : String(route.params.org_slug || ''))

  const key = computed(() => `dashboard-booking:${orgSlug.value}:${bookingType}:${bookingId}`)
  const { data: resource, error, refresh: reread } = await useAsyncData<{ booking: DashboardBookingDetails }>(
    key,
    () => dashboardApi(endpoint, { validate: isBookingDetailsResponse }),
  )

  const booking = computed(() => resource.value?.booking ?? null)

  // The one vocabulary. `resolveBookingPresentation` refuses a missing vertical
  // rather than guessing, so it is only asked once the booking has loaded.
  const purchase = bookingType === 'order' || bookingType === 'payment'
  const presentation = computed(() => booking.value
    ? booking.value.product_kind === null ? PURCHASE : resolveBookingPresentation(booking.value.product_kind, booking.value.vertical)
    : null)
  const noun = computed(() => presentation.value?.noun ?? '')

  const referenceDay = computed(() => booking.value ? localDateAt(now.value, booking.value.timezone) : '')
  const pageTitle = computed(() => {
    if (!booking.value) return purchase ? 'Purchase' : 'Booking details'
    // A purchase's state is the money's: Paid, Refunded, Pending — as the visit's is Coming up or Cancelled.
    if (purchase) return booking.value.payments?.[0] ? paymentStateLabel(booking.value.payments[0].payment) : 'Purchase'
    if (booking.value.status === 'pending') return 'Awaiting review'
    if (booking.value.status === 'cancelled') return 'Cancelled'
    // Under way by the instant, so a visit past midnight is still being hosted.
    const instant = now.value.toISOString()
    const underway = booking.value.starts_at !== null && booking.value.ends_at !== null && booking.value.starts_at <= instant && instant < booking.value.ends_at
    if (underway && !booking.value.no_show_at && !personalScope && booking.value.vertical !== 'service') return 'Currently hosting'
    if (booking.value.booking_date === referenceDay.value) return 'Today'
    if (booking.value.booking_date > referenceDay.value) return 'Coming up'
    return `Past ${noun.value}`
  })

  /** A writer's re-read; a failed one fails the write that asked for it. */
  async function refresh() {
    await reread()
    if (error.value) throw error.value
  }

  return { resource, booking, error, presentation, noun, pageTitle, orgSlug, purchase, refresh }
}
