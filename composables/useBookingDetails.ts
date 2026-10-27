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
    && typeof value.booking.id === 'string'
    && typeof value.booking.organizationId === 'string'
    && (value.booking.guestName === null || typeof value.booking.guestName === 'string')
    && Array.isArray(value.booking.notes)
    && (value.booking.policy === null || isRecord(value.booking.policy))
}

// A purchase is not a booking of anything; its one word is the same for every vertical.
const PURCHASE: BookingPresentation = { noun: 'purchase', nounPlural: 'purchases', label: 'Purchase', labelPlural: 'Purchases' }

export async function useBookingDetails(bookingType: DashboardRecordType, bookingId: string, personalScope = false) {
  const route = useRoute()
  // The account reads its own booking from the account API; the business reads the organization's.
  const dashboardApi = personalScope ? applicationFetch : useDashboardApi()
  const endpoint = `/api/${personalScope ? 'account' : 'dashboard'}/bookings/${bookingType}/${encodeURIComponent(bookingId)}`
  const orgSlug = computed(() => personalScope ? 'account' : String(route.params.orgSlug || ''))

  const key = computed(() => `dashboard-booking:${orgSlug.value}:${bookingType}:${bookingId}`)
  const { data: resource, error, refresh: reread } = await useAsyncData<{ booking: DashboardBookingDetails }>(
    key,
    () => dashboardApi(endpoint, {
      validate: isBookingDetailsResponse,
    }),
  )

  const booking = computed(() => resource.value?.booking ?? null)

  // The one vocabulary. `resolveBookingPresentation` refuses a missing vertical
  // rather than guessing, so it is only asked once the booking has loaded.
  const purchase = bookingType === 'order' || bookingType === 'payment'
  const presentation = computed(() => booking.value
    ? purchase ? PURCHASE : resolveBookingPresentation(booking.value.type as 'reservation' | 'booking', booking.value.vertical)
    : null)
  const noun = computed(() => presentation.value?.noun ?? '')

  const referenceDay = computed(() => booking.value ? localDateAt(new Date(), booking.value.timeZone) : '')
  const pageTitle = computed(() => {
    if (!booking.value) return purchase ? 'Purchase' : 'Booking details'
    // A purchase's state is the money's: Paid, Refunded, Pending — as the visit's is Coming up or Cancelled.
    if (purchase) return booking.value.payments?.[0] ? paymentStateLabel(booking.value.payments[0].payment) : 'Purchase'
    if (booking.value.status === 'pending') return 'Awaiting review'
    if (booking.value.status === 'cancelled') return 'Cancelled'
    if (booking.value.bookingDate === referenceDay.value) return personalScope || booking.value.vertical === 'service' ? 'Today' : 'Currently hosting'
    if (booking.value.bookingDate > referenceDay.value) return 'Coming up'
    return `Past ${noun.value}`
  })

  /** A writer's re-read; a failed one fails the write that asked for it. */
  async function refresh() {
    await reread()
    if (error.value) throw error.value
  }

  return { resource, booking, error, presentation, noun, pageTitle, orgSlug, purchase, refresh }
}
