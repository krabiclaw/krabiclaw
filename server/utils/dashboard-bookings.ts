import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { d1JsonStringSet, queryAll, queryFirst } from '~/server/db'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assignedMemberSql, memberAccessPrincipal } from '~/server/utils/member-access'
import { BOOKING_RECORDS_SQL, getGuestRequest, getThreadOperationalRecord, requestActions } from '~/server/domain/requests'
import { guestReplyDestination } from '~/server/domain/guest-threads/operations'
import { getStay, listStays, readStayCalendar, readStayCalendars, stayAccessFor } from '~/server/domain/stays'
import { readPlacesCalendar } from '~/server/domain/places'
import { loadDashboardBookingDetails } from '~/server/utils/dashboard-booking-details'
import { isChannelManagedStay } from '~/shared/bookings'
import { addLocalDays, isValidCalendarDate, localDateAt } from '~/utils/timezone'

export function nightBooking<T extends { id: string }>({ id, ...record }: T) {
  return { ...record, booking_id: id, unit: 'nights' as const }
}

async function dashboardBookingsContext(event: H3Event) {
  const context = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(context.organization, { env: context.env, event })
  const access = await stayAccessFor(principal)
  return { ...context, principal, access }
}

export async function dashboardBookingContext(event: H3Event) {
  const context = await dashboardBookingsContext(event)
  const bookingId = getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const booking = await queryFirst<{ unit: 'slot' | 'nights'; conversation_id: string }>(context.db, `
    SELECT b.unit, c.id AS conversation_id FROM ${BOOKING_RECORDS_SQL} b
      JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
      WHERE b.organization_id = ? AND b.id = ?
        ${context.access.manage ? '' : `AND ${assignedMemberSql('b')}`}
  `, [context.organization.id, bookingId, ...(context.access.manage ? [] : [context.userId])])
  if (!booking) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  return { ...context, bookingId, booking }
}

export async function dashboardBookingDetails(event: H3Event) {
  const { access, db, organization, bookingId, booking } = await dashboardBookingContext(event)
  if (booking.unit === 'slot') {
    return { booking: await loadDashboardBookingDetails(event, { type: 'booking', bookingId, lookup: 'booking' }), manage: access.manage }
  }
  if (!access.manage) return { booking: nightBooking(await getStay(db, access, bookingId)), manage: false }
  const stay = await getStay(db, access, bookingId)
  const conversation = await getGuestRequest(db, booking.conversation_id, organization.id, 'booking')
  if (!conversation) throw new Error('The booking has no guest conversation')
  const [destination, record] = await Promise.all([guestReplyDestination(db, conversation), getThreadOperationalRecord(db, conversation.id)])
  if (!record) throw new Error('The conversation has no booking')
  const channelOwned = isChannelManagedStay(stay)
  const actions = requestActions(record, new Date().toISOString())
  const available_actions = stay.request_status ? actions : [
    ...actions.filter(action => action === 'no_show' && !channelOwned),
    ...(stay.status === 'cancelled' ? [] : ['move', ...(!channelOwned ? ['edit', 'cancel'] : [])]),
  ]
  return { booking: { ...nightBooking(stay), available_actions }, manage: true, can_message_guest: destination.channel !== null && !conversation.blocked_at }
}

interface BookingListQuery { unit?: unknown; from?: unknown; to?: unknown; product_id?: unknown; include_cancelled?: unknown }

function bookingListWindow(query: BookingListQuery) {
  const { unit, from, to, product_id: productId } = query
  if (unit !== undefined && unit !== 'slot' && unit !== 'nights') throw new HTTPError({ statusCode: 422, message: 'Invalid booking unit' })
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || to <= from || to > addLocalDays(from, 62)) {
    throw new HTTPError({ statusCode: 422, message: 'Choose a booking date range of at most 62 days' })
  }
  if (productId !== undefined && (typeof productId !== 'string' || !productId)) throw new HTTPError({ statusCode: 422, message: 'Invalid product ID' })
  return { unit, from, to, productId, includeCancelled: query.include_cancelled === 'true' }
}

type BookingWindow = ReturnType<typeof bookingListWindow>
type DashboardBookingsContext = Awaited<ReturnType<typeof dashboardBookingsContext>>

function listTimedBookings({ db, access, organization, userId }: DashboardBookingsContext, { productId, from, to, includeCancelled }: BookingWindow) {
  type Row = { booking_id: string; unit: 'slot'; product_id: string; product_kind: 'table' | 'service' | 'experience'; name: string; location_title: string | null; guest_name: string | null; status: string; starts_at: string; ends_at: string; timezone: string }
  return queryAll<Row>(db, `
    SELECT b.id AS booking_id, b.unit, b.product_id, b.product_kind, b.product_name AS name, l.title AS location_title,
           json_extract(c.payload_json, '$.guest.name') AS guest_name, b.status, b.starts_at, b.ends_at, b.timezone
      FROM ${BOOKING_RECORDS_SQL} b JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
      LEFT JOIN business_locations l ON l.id=b.location_id AND l.organization_id=b.organization_id
      WHERE b.organization_id = ? AND b.unit = 'slot' AND b.starts_at >= ? AND b.starts_at < ?
        AND (? IS NULL OR b.product_id = ?)
        ${includeCancelled ? '' : "AND b.status <> 'cancelled'"}
        ${access.manage ? '' : `AND ${assignedMemberSql('b')}`}
      ORDER BY b.starts_at, b.id
  `, [organization.id, addLocalDays(from, -1), addLocalDays(to, 1), productId ?? null, productId ?? null, ...(access.manage ? [] : [userId])])
    .then(rows => rows.filter(row => {
      const day = localDateAt(new Date(row.starts_at), row.timezone)
      return day >= from && day < to
    }))
}

export async function dashboardBookingList(event: H3Event, query: BookingListQuery) {
  const window = bookingListWindow(query)
  const context = await dashboardBookingsContext(event)
  const [timed, stays] = await Promise.all([
    window.unit === 'nights' ? [] : listTimedBookings(context, window),
    window.unit === 'slot' ? [] : listStays(context.db, context.access, window),
  ])
  const homeIds = [...new Set(stays.map(stay => stay.product_id))]
  const homes = homeIds.length ? await queryAll<{ product_id: string; internal_name: string }>(context.db,
    'SELECT product_id, internal_name FROM product_stay_configs WHERE organization_id=? AND product_id IN (SELECT value FROM json_each(?))',
    [context.organization.id, d1JsonStringSet(homeIds)]) : []
  const names = new Map(homes.map(home => [home.product_id, home.internal_name]))
  const nights = stays.map(stay => {
    const name = names.get(stay.product_id)
    if (!name) throw new Error('Booking home has no internal name')
    return { ...nightBooking(stay), name }
  })
  return { bookings: [...timed, ...nights], manage: context.access.manage }
}

export async function dashboardBookingCalendar(event: H3Event, query: BookingListQuery) {
  const window = bookingListWindow(query)
  const context = await dashboardBookingsContext(event)
  const { db, access, principal } = context
  const { unit, from, to, productId } = window
  const nights = async () => {
    if (unit === 'slot') return { homes: [], stays: [] }
    if (!productId) return readStayCalendars(db, access, { from, to })
    const { home, nights, stays } = await readStayCalendar(db, access, { productId, from, to })
    return { homes: [{ home, nights }], stays }
  }
  const [timed, nightCalendar, placeCalendar] = await Promise.all([
    unit === 'nights' ? [] : listTimedBookings(context, window),
    nights(),
    unit === 'slot' ? readPlacesCalendar(db, principal, { from, to }) : { places: [], manage: false },
  ])
  return { from, to, bookings: [...timed, ...nightCalendar.stays.map(nightBooking)], homes: nightCalendar.homes, places: placeCalendar.places, manage: unit === 'slot' ? placeCalendar.manage : access.manage }
}
