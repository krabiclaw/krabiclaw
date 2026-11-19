import { authClient } from '~/lib/auth-client'
import type { DashboardBookingDetails } from '~/server/utils/dashboard-booking-details'
import type { GuestStay, StayDetail, StayTurnover } from '~/server/domain/stays'
import type { BookingHome, TurnoverBookingHome } from '~/server/utils/dashboard-bookings'
import type { pendingStayChanges } from '~/server/domain/guest-threads/stay-change-requests'
import { isGuestStay, isStayCheckInMethod } from '~/shared/stay-arrival'
import { isPublicProvider } from '~/shared/member-scheduling'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'
import type { DashboardRequestScope } from '~/composables/dashboardFetch'
import { coordinatesFailure } from '~/utils/location-map'

type NightBooking<T> = Omit<T, 'id'> & { booking_id: string; unit: 'nights' }
type StayChange = Awaited<ReturnType<typeof pendingStayChanges>>[number]
type ManagedNightBooking = NightBooking<StayDetail> & { available_actions: string[]; pending_changes: StayChange[] }
export type DashboardNightBooking =
  | { booking: ManagedNightBooking; manage: true; can_message_guest: boolean; home: BookingHome }
  | { booking: NightBooking<StayTurnover>; manage: false; home: TurnoverBookingHome }
export type DashboardBooking = DashboardNightBooking | { booking: DashboardBookingDetails & { unit: 'slot' }; manage: boolean }
export type AccountNightBooking = Omit<GuestStay, 'stay'> & { booking: NightBooking<StayDetail> }

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
      : value.booking.type === 'payment' && typeof value.booking.payment_id === 'string'
        && value.booking.conversation_id === null && value.booking.booking_id === null)
    && typeof value.booking.organization_id === 'string'
    && (value.booking.guest_name === null || typeof value.booking.guest_name === 'string')
    && (value.booking.notes === null || typeof value.booking.notes === 'string')
    && Array.isArray(value.booking.resource_photo_urls) && value.booking.resource_photo_urls.every(url => typeof url === 'string')
    && (value.booking.host === null || isPublicProvider(value.booking.host))
    && (value.booking.location_pin === null || (isRecord(value.booking.location_pin)
      && typeof value.booking.location_pin.latitude === 'number' && typeof value.booking.location_pin.longitude === 'number'
      && !coordinatesFailure({ latitude: value.booking.location_pin.latitude, longitude: value.booking.location_pin.longitude })))
    && (value.booking.location_maps_url === null || typeof value.booking.location_maps_url === 'string')
    && Array.isArray(value.booking.answers)
    && (value.booking.policy === null || isRecord(value.booking.policy))
}

export function isDashboardBooking(value: unknown): value is DashboardBooking {
  if (!isRecord(value) || !isRecord(value.booking) || typeof value.manage !== 'boolean' || typeof value.booking.booking_id !== 'string') return false
  if (value.booking.unit === 'nights') {
    const home = value.home
    if (!isRecord(home) || typeof home.name !== 'string' || typeof home.internal_name !== 'string' || !home.internal_name.trim()
      || ![home.check_in_time, home.check_in_end_time, home.check_out_time].every(field => field === null || typeof field === 'string')) return false
    if (!value.manage) {
      return (home.check_in_method === null || isStayCheckInMethod(home.check_in_method))
        && (home.check_in_instructions === null || typeof home.check_in_instructions === 'string')
        && (home.image_url === null || typeof home.image_url === 'string')
    }
    if (!Array.isArray(home.photo_urls) || !home.photo_urls.every(url => typeof url === 'string')
      || !Array.isArray(home.house_rules) || !Array.isArray(home.safety)
      || (home.host !== null && !isPublicProvider(home.host)) || !Array.isArray(home.co_hosts) || !home.co_hosts.every(isPublicProvider)) return false
    const isTerms = (terms: unknown) => isRecord(terms) && typeof terms.dates === 'string' && Number.isInteger(terms.guests) && typeof terms.total === 'string'
    return typeof value.can_message_guest === 'boolean'
      && Array.isArray(value.booking.available_actions) && value.booking.available_actions.every(action => typeof action === 'string')
      && Array.isArray(value.booking.pending_changes) && value.booking.pending_changes.every(change => isRecord(change) && typeof change.id === 'string'
        && (change.requested_by === 'guest' || change.requested_by === 'host') && isTerms(change.before) && isTerms(change.after))
      && isNightBooking(value)
  }
  return value.booking.unit === 'slot' && isBookingDetailsResponse(value)
}

export function isAccountNightBooking(value: unknown): value is AccountNightBooking {
  return isRecord(value) && isNightBooking(value) && isGuestStay({ ...value, stay: { ...value.booking, id: value.booking.booking_id } })
}


function useDashboardReservationReads(scope: DashboardRequestScope) {
  const session = authClient.useSession()
  const realtime = useDashboardInvalidations()
  const reader = () => session.value.data?.user.id
  const key = (bookingId: string) => `reservation:${reader()}:${scope.orgSlug}:${bookingId}`

  const get = (bookingId: string) => reader() ? realtime.held.get(key(bookingId)) : undefined

  async function read(bookingId: string, signal?: AbortSignal): Promise<DashboardBooking> {
    const fetchBooking = () => dashboardFetch(dashboardBookingPath(bookingId), scope, { signal, validate: isDashboardBooking })
    if (!reader() || realtime.status.value !== 'open') return fetchBooking()
    const cacheKey = key(bookingId)
    const pending = realtime.held.pending(cacheKey)
    if (pending) {
      const value = await pending
      signal?.throwIfAborted()
      if (isDashboardBooking(value)) return value
    }
    const entry = realtime.held.begin(cacheKey, event =>
      event.type === 'access.changed' || event.type === 'CONVERSATION_LEAVE'
      || event.type === 'business.changed'
      || (event.type === 'stay.changed' && (event.booking_id === null || event.booking_id === bookingId))
      || ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.scheduled))
    const request = fetchBooking().then(value => {
      if (!realtime.held.current(entry)) return undefined
      realtime.held.hold(entry, value, Date.now() + 30_000, 5)
      return value
    }).finally(() => { delete entry.pending })
    entry.pending = request
    return await request ?? await fetchBooking()
  }

  watch(realtime.savedReservation, saved => {
    if (saved && reader()) realtime.held.take(key(saved.booking_id))
  }, { flush: 'sync' })

  return { get, read, canPrefetch: () => Boolean(reader()) && realtime.status.value === 'open' }
}

export function useDashboardReservationPrefetch() {
  const scope = useDashboardRouteScope()
  const reads = useDashboardReservationReads({ get orgSlug() { return scope.value?.orgSlug ?? '' } })
  const error = shallowRef<{ bookingId: string; message: string }>()
  function prefetch(bookingId: string | null) {
    if (!bookingId || !scope.value || !reads.canPrefetch() || reads.get(bookingId)) return
    void reads.read(bookingId).then(() => {
      if (error.value?.bookingId === bookingId) error.value = undefined
    }, cause => {
      error.value = { bookingId, message: getErrorMessage(cause, 'Reservation preview unavailable') }
    })
  }
  return { prefetch, error }
}

export function useDashboardReservation(scope: DashboardRequestScope, bookingId: string) {
  const reads = import.meta.client ? useDashboardReservationReads(scope) : undefined
  return useAsyncData(dashboardBookingKey(scope.orgSlug, bookingId), async (_app, { signal }) => {
    if (import.meta.server) {
      const provider = useRequestEvent()?.context.dashboardReservationProvider as {
        booking: (orgSlug: string, bookingId: string) => Promise<unknown>
      } | undefined
      const payload = await provider?.booking(scope.orgSlug, bookingId)
      if (!isDashboardBooking(payload)) throw createError({ statusCode: 502, statusMessage: 'Invalid dashboard reservation' })
      return payload
    }
    return reads!.read(bookingId, signal)
  }, {
    getCachedData(key, app, ctx) {
      if (import.meta.server || app.isHydrating) {
        const payload: unknown = app.payload.data[key]
        return isDashboardBooking(payload) ? payload : undefined
      }
      if (ctx.cause !== 'initial') return undefined
      const held = reads?.get(bookingId)
      return isDashboardBooking(held) ? held : undefined
    },
  })
}
