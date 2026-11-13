import type { DashboardBookingDetails } from '~/server/utils/dashboard-booking-details'
import type { StayDetail, StayTurnover } from '~/server/domain/stays'
import type { pendingStayChanges } from '~/server/domain/guest-threads/stay-change-requests'
import { isRecord } from '~/utils/api-clients'

type NightBooking<T> = Omit<T, 'id'> & { booking_id: string; unit: 'nights' }
type StayChange = Awaited<ReturnType<typeof pendingStayChanges>>[number]
export type DashboardNightBooking =
  | { booking: NightBooking<StayDetail> & { pending_changes: StayChange[] }; manage: true; can_message_guest: boolean }
  | { booking: NightBooking<StayTurnover>; manage: false }
export type DashboardBooking = DashboardNightBooking | { booking: DashboardBookingDetails & { unit: 'slot' }; manage: boolean }

export const dashboardBookingPath = (bookingId: string) => `/api/dashboard/bookings/${encodeURIComponent(bookingId)}`
export const dashboardBookingKey = (organizationSlug: string, bookingId: string) => `dashboard-booking:${organizationSlug}:${bookingId}`

export function isNightBooking(value: unknown): value is { booking: NightBooking<StayDetail> } {
  return isRecord(value) && isRecord(value.booking) && value.booking.unit === 'nights' && typeof value.booking.booking_id === 'string'
    && (value.booking.guest_image_url === null || typeof value.booking.guest_image_url === 'string')
}

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

export function isDashboardBooking(value: unknown): value is DashboardBooking {
  if (!isRecord(value) || !isRecord(value.booking) || typeof value.manage !== 'boolean' || typeof value.booking.booking_id !== 'string') return false
  if (value.booking.unit === 'nights') {
    if (!value.manage) return true
    const isTerms = (terms: unknown) => isRecord(terms) && typeof terms.dates === 'string' && Number.isInteger(terms.guests) && typeof terms.total === 'string'
    return typeof value.can_message_guest === 'boolean'
      && Array.isArray(value.booking.pending_changes) && value.booking.pending_changes.every(change => isRecord(change) && typeof change.id === 'string'
        && (change.requested_by === 'guest' || change.requested_by === 'host') && isTerms(change.before) && isTerms(change.after))
      && isNightBooking(value)
  }
  return value.booking.unit === 'slot' && isBookingDetailsResponse(value)
}

export function useDashboardBooking(bookingId: string) {
  const route = useRoute()
  const api = useDashboardApi()
  return useAsyncData(dashboardBookingKey(String(route.params.org_slug), bookingId),
    () => api(dashboardBookingPath(bookingId), { validate: isDashboardBooking }))
}
