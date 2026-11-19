import { listingGrantSql } from '~/server/domain/listing-access'
import { assignedOperationsRoles, roleMatchesSql } from '~/utils/organization-access'
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { executeBatch, queryFirst } from '~/server/db'
import { dashboardMemberQuery, dashboardOrgQueryParam, getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { cloudflareEnv, readRequiredBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { assignedMemberSql, BATCH_VIEWER, joinedMemberPrincipal, memberAccessPrincipal, membershipBySlugQuery, withViewer } from '~/server/utils/member-access'
import { bookedRecordsInRange, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { BOOKING_RECORDS_SQL, getGuestRequest, getThreadOperationalRecord, requestActions, type BookedRecord } from '~/server/domain/requests'
import { guestReplyDestination } from '~/server/domain/guest-threads/operations'
import { pendingStayChanges } from '~/server/domain/guest-threads/stay-change-requests'
import { calendarStays, dashboardStayEditQueries, getStay, stayAccessFor, stayCalendarOf, stayCalendarQueries, readStayReservationHome, type StayHome, type StayNight, type StayReservationHome } from '~/server/domain/stays'
import { placesCalendarOf, placesCalendarQueries, placesWindow } from '~/server/domain/places'
import { loadStaffBookingDetails } from '~/server/utils/dashboard-booking-details'
import { isChannelManagedStay } from '~/shared/bookings'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { readProductPhotos } from '~/server/utils/media-placement'
import { isValidCalendarDate, localDateAt } from '~/utils/timezone'

export type BookingHome = StayReservationHome
export type TurnoverBookingHome = Pick<StayHome, 'name' | 'internal_name' | 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'check_in_method' | 'check_in_instructions'>
  & { image_url: string | null }

export function nightBooking<T extends { id: string }>({ id, ...record }: T) {
  return { ...record, booking_id: id, unit: 'nights' as const }
}

/** Released native decoders require both keys. No checkout or linked calendar owns nights now. */
export function dashboardCalendarNight(night: StayNight) {
  return { ...night, held_until: null, calendar: null }
}

async function dashboardBookingsContext(event: H3Event) {
  const context = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(context.organization, { env: context.env, event })
  const access = await stayAccessFor(principal)
  return { ...context, principal, access }
}

function bookingPatchChangesStay(body: Record<string, unknown>) {
  return Object.keys(body).some(field => field !== 'version' && field !== 'private_notes')
}

export async function dashboardBookingContext(event: H3Event, action: 'read' | 'update' = 'read', readPatch?: true) {
  const { env, db, session, userId, membership, organizationFrom } = await dashboardMemberQuery(event)
  const bookingId = getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const patch = readPatch ? await readRequiredBody<Record<string, unknown>>(event).then(
    body => ({ body }), (error: unknown) => ({ error }),
  ) : null
  const patchBody = patch && 'body' in patch ? patch.body : undefined
  const changesStay = patchBody ? bookingPatchChangesStay(patchBody) : false
  const stayQueries = changesStay ? dashboardStayEditQueries({ query: BATCH_VIEWER.organization }, bookingId, patchBody?.check_in_date) : []
  const [memberResult, bookingResult, stayResult, homeResult] = await executeBatch(db, [membership, withViewer(membership, {
    query: `SELECT b.unit, c.id AS conversation_id, b.status, b.respond_by, b.product_id,
        (${roleMatchesSql(BATCH_VIEWER.role!, assignedOperationsRoles)} AND ${assignedMemberSql('b', BATCH_VIEWER.user)}) AS assigned,
        ${listingGrantSql('b.organization_id', 'b.product_id', BATCH_VIEWER.member, 'details', BATCH_VIEWER.role)} AS granted,
        ${listingGrantSql('b.organization_id', 'b.product_id', BATCH_VIEWER.member, 'update', BATCH_VIEWER.role)} AS operates
      FROM ${BOOKING_RECORDS_SQL} b
      JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
      WHERE b.organization_id = ${BATCH_VIEWER.organization} AND b.id = ?`,
    params: [bookingId],
  }), ...stayQueries.map(query => withViewer(membership, query))], { operation: 'Read dashboard booking access' })
  const organization = organizationFrom(memberResult?.results[0])
  const principal = memberAccessPrincipal(organization, { env, event })
  const workspace = await stayAccessFor(principal)
  const booking = bookingResult?.results[0] as Pick<BookedRecord, 'unit' | 'status' | 'respond_by' | 'product_id'>
    & { conversation_id: string; assigned: number; granted: number; operates: number } | undefined
  if (!booking || (!workspace.manage && !booking.assigned && !(action === 'update' ? booking.operates : booking.granted))) {
    throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  }
  const access = !workspace.manage && booking.operates
    ? { ...workspace, manage: true as const, listingId: booking.product_id, operationalOnly: true }
    : workspace
  if (patch && 'error' in patch) throw patch.error
  const stayEdit = changesStay ? { current: stayResult?.results[0], home: homeResult?.results[0] } : undefined
  return { db, env, session, userId, organization, principal, access, bookingId, booking, patchBody, stayEdit }
}

export async function dashboardBookingDetails(event: H3Event) {
  const context = await dashboardBookingContext(event)
  const { access, db, organization, userId, bookingId, booking } = context
  if (booking.unit === 'slot') {
    return { booking: await loadStaffBookingDetails(context, bookingId), manage: access.manage }
  }
  if (!access.manage) {
    const [stay, house, photos] = await Promise.all([
      getStay(db, access, bookingId),
      queryFirst<Omit<TurnoverBookingHome, 'image_url'>>(db, `SELECT p.name, c.internal_name, b.check_in_time, b.check_in_end_time, b.check_out_time,
        c.check_in_method, c.check_in_instructions
        FROM product_stay_configs c
        JOIN products p ON p.organization_id=c.organization_id AND p.id=c.product_id
        JOIN product_booking_configs b ON b.organization_id=c.organization_id AND b.product_id=c.product_id
        WHERE c.organization_id=? AND c.product_id=?`, [organization.id, booking.product_id]),
      readProductPhotos(db, { organizationId: organization.id, productIds: [booking.product_id] }),
    ])
    if (!house) throw new Error('The booking has no home')
    const home = { ...house, image_url: mediaStillUrl(photos.get(booking.product_id)?.[0]) }
    return { booking: nightBooking(stay), manage: false as const, home }
  }
  const conversation = getGuestRequest(db, booking.conversation_id, organization.id, 'booking').then(thread => {
    if (!thread || thread.booking_id !== bookingId) throw new Error('The booking has no guest conversation')
    return thread
  })
  const [stay, home, canMessageGuest] = await Promise.all([
    getStay(db, access, bookingId),
    readStayReservationHome(db, { organizationId: organization.id, productId: booking.product_id, showLocation: true, showArrival: true }),
    conversation.then(async thread => !thread.blocked_at && (await guestReplyDestination(db, thread)).channel !== null),
  ])
  const channelOwned = isChannelManagedStay(stay)
  const [available_actions, pending_changes] = await Promise.all([
    stay.request_status
      ? conversation.then(async thread => {
          const record = await getThreadOperationalRecord(db, thread.id, thread)
          if (!record) throw new Error('The conversation has no booking')
          return requestActions(record, new Date().toISOString())
        })
      : stay.status === 'cancelled' || channelOwned ? [] : ['edit', 'cancel'],
    stay.channel === 'airbnb' && channelOwned
      ? pendingStayChanges(db, { bookingId, conversationId: booking.conversation_id, organizationId: organization.id, userId })
      : [],
  ])
  return { booking: { ...nightBooking(stay), available_actions, pending_changes }, manage: true, home: { ...home, image_url: home.photo_urls[0] ?? null }, can_message_guest: canMessageGuest }
}

interface BookingListQuery { unit?: unknown; from?: unknown; to?: unknown; product_id?: unknown; include_cancelled?: unknown }

function bookingListWindow(query: BookingListQuery) {
  const { unit, from, to, product_id: productId } = query
  if (unit !== undefined && unit !== 'slot' && unit !== 'nights') throw new HTTPError({ statusCode: 422, message: 'Invalid booking unit' })
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || to <= from) {
    throw new HTTPError({ statusCode: 422, message: 'Choose calendar dates with to after from' })
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

/** The booked records of the window the caller may see, in one statement: a member's are those of the offerings and homes they are named on. */
async function readBookedRecords({ db, organization, userId }: DashboardBookingsContext, window: BookingWindow) {
  const [records] = await executeBatch(db, [withViewer(membershipBySlugQuery(organization.slug, userId), bookedRecordsInRange(BATCH_VIEWER, { ...window, cancelled: window.includeCancelled, includeAssignedStays: true }))], { operation: 'Read booked records' })
  return (records!.results as BookedRecordInRange[])
}

export async function dashboardBookingList(event: H3Event, query: BookingListQuery) {
  const window = bookingListWindow(query)
  const context = await dashboardBookingsContext(event)
  const records = await readBookedRecords(context, window)
  const stays = window.unit === 'slot' ? [] : calendarStays(records, context.access.manage, window, record => !window.productId || record.product_id === window.productId)
  return { bookings: [...(window.unit === 'nights' ? [] : timedBookings(records, window)), ...stays], manage: context.access.manage }
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
    withViewer(membership, bookedRecordsInRange(BATCH_VIEWER, { ...window, cancelled: window.includeCancelled, includeCalendarGrants: true })),
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
  const homes = calendar.homes.map(entry => ({ ...entry, nights: entry.nights.map(dashboardCalendarNight) }))
  return { from: window.from, to: window.to, bookings: calendar.stays, homes, places: [], manage: access.manage }
}

export async function dashboardBookingCalendar(event: H3Event, query: BookingListQuery) {
  const window = bookingListWindow(query)
  if (window.unit === 'slot') return dashboardPlacesCalendar(event, window)
  if (window.unit === 'nights') return dashboardHomesCalendar(event, window)
  // Without a unit: the homes calendar, and the timed bookings beside its stays.
  const [homes, timed] = await Promise.all([dashboardHomesCalendar(event, window), dashboardBookingsContext(event).then(async context => timedBookings(await readBookedRecords(context, window), window))])
  return { ...homes, bookings: [...timed, ...homes.bookings] }
}
