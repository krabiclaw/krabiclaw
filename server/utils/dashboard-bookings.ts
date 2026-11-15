import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { d1JsonStringSet, executeBatch, queryAll, queryFirst } from '~/server/db'
import { dashboardOrgQueryParam, getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { assignedMemberSql, BATCH_VIEWER, joinedMemberPrincipal, memberAccessPrincipal, membershipBySlugQuery, withViewer } from '~/server/utils/member-access'
import { bookedRecordsInRange, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { BOOKING_RECORDS_SQL, getGuestRequest, getThreadOperationalRecord, requestActions, type BookedRecord } from '~/server/domain/requests'
import { guestReplyDestination } from '~/server/domain/guest-threads/operations'
import { pendingStayChanges } from '~/server/domain/guest-threads/stay-change-requests'
import { getStay, listStays, stayAccessFor, stayCalendarOf, stayCalendarQueries, type StayHome } from '~/server/domain/stays'
import { placesCalendarOf, placesCalendarQueries, placesWindow } from '~/server/domain/places'
import { loadDashboardBookingDetails } from '~/server/utils/dashboard-booking-details'
import { isChannelManagedStay } from '~/shared/bookings'
import { addLocalDays, isValidCalendarDate, localDateAt } from '~/utils/timezone'
import { readProductPhotos } from '~/server/utils/media-placement'
import { mediaStillUrl } from '~/shared/media-placement-contract'

export type BookingHome = Pick<StayHome, 'name' | 'internal_name' | 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'check_in_method' | 'check_in_instructions'> & { image_url: string | null }

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
  const booking = await queryFirst<Pick<BookedRecord, 'unit' | 'status' | 'respond_by' | 'product_id'> & { conversation_id: string }>(context.db, `
    SELECT b.unit, c.id AS conversation_id, b.status, b.respond_by, b.product_id FROM ${BOOKING_RECORDS_SQL} b
      JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
      WHERE b.organization_id = ? AND b.id = ?
        ${context.access.manage ? '' : `AND ${assignedMemberSql('b')}`}
  `, [context.organization.id, bookingId, ...(context.access.manage ? [] : [context.userId])])
  if (!booking) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  return { ...context, bookingId, booking }
}

export async function dashboardBookingDetails(event: H3Event) {
  const { access, db, organization, userId, bookingId, booking } = await dashboardBookingContext(event)
  if (booking.unit === 'slot') {
    return { booking: await loadDashboardBookingDetails(event, { type: 'booking', bookingId, lookup: 'booking' }), manage: access.manage }
  }
  const [stay, house, pictures] = await Promise.all([
    getStay(db, access, bookingId),
    queryFirst<Omit<BookingHome, 'image_url'>>(db, `SELECT p.name, s.internal_name, b.check_in_time, b.check_in_end_time, b.check_out_time,
      s.check_in_method, s.check_in_instructions FROM product_stay_configs s
      JOIN products p ON p.organization_id = s.organization_id AND p.id = s.product_id
      JOIN product_booking_configs b ON b.organization_id = s.organization_id AND b.product_id = s.product_id
      WHERE s.organization_id = ? AND s.product_id = ?`, [organization.id, booking.product_id]),
    readProductPhotos(db, { organizationId: organization.id, productIds: [booking.product_id] }),
  ])
  if (!house) throw new Error('The booking has no home')
  const home: BookingHome = { ...house, image_url: mediaStillUrl(pictures.get(booking.product_id)?.[0]) }
  if (!('payments' in stay)) return { booking: nightBooking(stay), manage: false, home }
  const conversation = await getGuestRequest(db, booking.conversation_id, organization.id, 'booking')
  if (!conversation) throw new Error('The booking has no guest conversation')
  const [destination, record, pending_changes] = await Promise.all([
    guestReplyDestination(db, conversation),
    getThreadOperationalRecord(db, conversation.id, conversation),
    stay.channel === 'airbnb' && isChannelManagedStay(stay)
      ? pendingStayChanges(db, { bookingId, conversationId: conversation.id, organizationId: organization.id, userId })
      : [],
  ])
  if (!record) throw new Error('The conversation has no booking')
  const channelOwned = isChannelManagedStay(stay)
  const actions = requestActions(record, new Date().toISOString())
  const available_actions = stay.request_status ? actions : [
    ...actions.filter(action => action === 'no_show' && !channelOwned),
    ...(stay.status === 'cancelled' ? [] : ['move', ...(!channelOwned ? ['edit', 'cancel'] : [])]),
  ]
  return { booking: { ...nightBooking(stay), available_actions, pending_changes }, manage: true, home, can_message_guest: destination.channel !== null && !conversation.blocked_at }
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

/** A visit's booking as the bookings list and the host Calendar show it, from the one read of booked records. */
function timedBookings(records: BookedRecordInRange[], { productId, from, to }: BookingWindow) {
  return records.flatMap((record) => {
    const day = localDateAt(new Date(record.starts_at), record.timezone)
    if (record.unit !== 'slot' || day < from || day >= to || (productId && record.product_id !== productId)) return []
    const { id, unit, product_id, product_kind, product_name, location_title, guest_name, status, starts_at, ends_at, timezone } = record
    return [{ booking_id: id, unit, product_id, product_kind, name: product_name, location_title, guest_name, status, starts_at, ends_at, timezone }]
  })
}

async function listTimedBookings({ db, organization, userId }: DashboardBookingsContext, window: BookingWindow) {
  const [records] = await executeBatch(db, [withViewer(membershipBySlugQuery(organization.slug, userId), bookedRecordsInRange(BATCH_VIEWER, { ...window, cancelled: window.includeCancelled }))], { operation: 'Read timed bookings' })
  return timedBookings(records!.results as BookedRecordInRange[], window)
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

/**
 * The host Calendar's places: one D1 round trip after the session, as
 * Messages reads its inbox. The batch's first statement is the membership,
 * read by the organization's slug, and every other statement names the
 * organization through that slug.
 */
async function dashboardPlacesCalendar(event: H3Event, window: BookingWindow) {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  const userId = session.user.id
  const organization = { query: '(SELECT id FROM organization WHERE slug = ?)', params: [slug] }
  const days = placesWindow(window)
  const membership = membershipBySlugQuery(slug, userId)
  const [memberResult, records, ...places] = await executeBatch(env.DB, [
    membership,
    withViewer(membership, bookedRecordsInRange(BATCH_VIEWER, { ...window, cancelled: window.includeCancelled })),
    ...placesCalendarQueries(organization, userId, days),
  ], { operation: 'Read host calendar' })
  const member = memberResult?.results[0] as { organization_id: string; member_id: string; role: string } | undefined
  if (!member) throw new HTTPError({ statusCode: 404, message: 'Not found or access denied', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  const principal = joinedMemberPrincipal({ organizationId: member.organization_id, memberId: member.member_id, role: member.role, userId }, { env, event })
  await stayAccessFor(principal)
  const calendar = await placesCalendarOf(principal, days, places)
  return { from: window.from, to: window.to, bookings: timedBookings(records!.results as BookedRecordInRange[], window), homes: [], places: calendar.places, manage: calendar.manage }
}

/**
 * The host Calendar's homes: one D1 round trip after the session, as its
 * places are. The membership leads the batch; homes, prices, stays and nights
 * follow, each reading the homes the viewer may see.
 */
async function dashboardHomesCalendar(event: H3Event, window: BookingWindow) {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  const userId = session.user.id
  const membership = membershipBySlugQuery(slug, userId)
  const [memberResult, ...rest] = await executeBatch(env.DB, [membership, ...stayCalendarQueries(membership, { from: window.from, to: window.to, productId: window.productId ?? null })], { operation: 'Read homes calendar' })
  const member = memberResult?.results[0] as { organization_id: string; member_id: string; role: string } | undefined
  if (!member) throw new HTTPError({ statusCode: 404, message: 'Not found or access denied', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  const access = await stayAccessFor(joinedMemberPrincipal({ organizationId: member.organization_id, memberId: member.member_id, role: member.role, userId }, { env, event }))
  const calendar = stayCalendarOf(rest, access.manage, window)
  if (window.productId && !calendar.homes.length) throw new HTTPError({ statusCode: 404, message: 'That place to stay is not in this organization', data: { code: 'HOME_NOT_FOUND' } })
  return { from: window.from, to: window.to, bookings: calendar.stays, homes: calendar.homes, places: [], manage: access.manage }
}

export async function dashboardBookingCalendar(event: H3Event, query: BookingListQuery) {
  const window = bookingListWindow(query)
  if (window.unit === 'slot') return dashboardPlacesCalendar(event, window)
  if (window.unit === 'nights') return dashboardHomesCalendar(event, window)
  // Without a unit: the homes calendar, and the timed bookings beside its stays.
  const [homes, timed] = await Promise.all([dashboardHomesCalendar(event, window), dashboardBookingsContext(event).then(context => listTimedBookings(context, window))])
  return { ...homes, bookings: [...timed, ...homes.bookings] }
}
