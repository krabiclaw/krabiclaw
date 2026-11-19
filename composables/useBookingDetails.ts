import { resolveBookingPresentation, type BookingPresentation } from '~/utils/booking-presentation'
import { paymentStateLabel } from '~/shared/payment-display'
import type { DashboardBookingDetails, DashboardRecordType } from '~/server/utils/dashboard-booking-details'
import type { AccountNightBooking, DashboardBooking } from '~/composables/useDashboardBooking'

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
  // The account reads its own booking from the account API; the business reads the organization's.
  const dashboardApi = personalScope ? applicationFetch : useDashboardApi()
  const orgSlug = computed(() => personalScope ? 'account' : String(route.params.org_slug || ''))
  const purchase = bookingType === 'payment'
  const dashboardRecord = !personalScope && !purchase
  const request = dashboardRecord ? useDashboardReservation({ orgSlug: orgSlug.value }, bookingId)
    : useAsyncData<AccountNightBooking | { booking: DashboardBookingDetails }>(`dashboard-booking:${orgSlug.value}:${bookingType}:${bookingId}`, (_app, { signal }) => {
    if (!purchase) return applicationFetch(`/api/account/bookings/${encodeURIComponent(bookingId)}?lookup=conversation`, {
      signal,
      validate: (value): value is AccountNightBooking | { booking: DashboardBookingDetails } => isAccountNightBooking(value) || isBookingDetailsResponse(value),
    })
    return dashboardApi(`/api/${personalScope ? 'account' : 'dashboard'}/bookings/${bookingType}/${encodeURIComponent(bookingId)}`, { signal, validate: isBookingDetailsResponse })
  })
  const { data: result, error, refresh: reread, clear } = await request
  const data: Ref<DashboardBooking | AccountNightBooking | { booking: DashboardBookingDetails } | undefined> = result
  const booking = computed(() => isBookingDetailsResponse(data.value) ? data.value.booking : null)

  // The one vocabulary. `resolveBookingPresentation` refuses a missing vertical
  // rather than guessing, so it is only asked once the booking has loaded.
  const presentation = computed(() => booking.value
    ? booking.value.product_kind === null ? PURCHASE : resolveBookingPresentation(booking.value.product_kind, booking.value.vertical)
    : null)
  const noun = computed(() => presentation.value?.noun ?? '')

  const pageTitle = computed(() => booking.value?.payments?.[0]
    ? paymentStateLabel(booking.value.payments[0].payment) : 'Purchase')

  /** A writer's re-read; a failed one fails the write that asked for it. */
  async function refresh() {
    await reread()
    if (error.value) throw error.value
  }

  return { data, booking, error, presentation, noun, pageTitle, orgSlug, purchase, refresh, clear }
}
