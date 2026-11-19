import { listingGrantSql } from '~/server/domain/listing-access'
import { assignedOperationsRoles, roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { executeBatch, queryFirst, type BatchQuery } from '~/server/db'
import { dashboardMemberQuery, dashboardOrgQueryParam, getDashboardMemberContext, getDashboardSession } from '~/server/utils/dashboard-context'
import { cloudflareEnv, readRequiredBody } from '~/server/utils/api-response'
import { assignedMemberSql, BATCH_VIEWER, joinedMemberPrincipal, memberAccessPrincipal, membershipBySlugQuery, roleAllows, withViewer } from '~/server/utils/member-access'
import { bookedRecordsInRange, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { BOOKING_RECORDS_SQL, guestRequestMappingQuery, guestRequestQuery, requestActions, threadOperationalRecordFromRow, threadOperationalRecordQuery, validateGuestRequest, type BookedRecord } from '~/server/domain/requests'
import { guestReplyAccountQuery, guestReplyDestination, type GuestReplyAccount } from '~/server/domain/guest-threads/operations'
import { pendingStayChangesFromRows, pendingStayChangesQuery } from '~/server/domain/guest-threads/stay-change-requests'
import { calendarStays, canReleaseStayNights, dashboardStayEditQueries, prepareStayReservationHome, stayAccessFor, stayCalendarOf, stayCalendarQueries, stayDetailFrom, stayDetailQuery, stayDetailSelection, type StayHome, type StayNight, type StayReservationHome } from '~/server/domain/stays'
import { guestThreadChannelQuery, parseGuestThreadChannel, type GuestThreadChannelRow } from '~/server/domain/guest-threads/channel-messages'
import { sourceLocaleFromRows, sourceLocaleQuery } from '~/server/utils/localization'
import { placesCalendarOf, placesCalendarQueries, placesPresenceQuery, placesWindow } from '~/server/domain/places'
import { prepareStaffBookingDetails } from '~/server/utils/dashboard-booking-details'
import { isChannelManagedStay } from '~/shared/bookings'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { productPhotosFromPlacements } from '~/server/utils/media-placement'
import { isValidCalendarDate, localDateAt } from '~/utils/timezone'
import { oncePerRequest } from '~/server/utils/request-scope'

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

export async function dashboardBookingContext(event: H3Event, action: 'read' | 'update' = 'read', readPatch?: true, record?: { orgSlug: string; bookingId: string }, preloaded?: D1Result[]) {
  const { env, db, session, userId, membership, organizationFrom } = await dashboardMemberQuery(event, record?.orgSlug)
  const bookingId = record?.bookingId ?? getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const patch = readPatch ? await readRequiredBody<Record<string, unknown>>(event).then(
    body => ({ body }), (error: unknown) => ({ error }),
  ) : null
  const patchBody = patch && 'body' in patch ? patch.body : undefined
  const changesStay = patchBody ? bookingPatchChangesStay(patchBody) : false
  const stayQueries = changesStay ? dashboardStayEditQueries({ query: BATCH_VIEWER.organization }, bookingId, patchBody?.check_in_date) : []
  const [memberResult, bookingResult, stayResult, homeResult] = preloaded ?? await executeBatch(db, [
    membership, withViewer(membership, bookingAccessQuery(bookingId)), ...stayQueries.map(query => withViewer(membership, query)),
  ], { operation: 'Read dashboard booking access' })
  const organization = organizationFrom(memberResult?.results[0])
  const principal = memberAccessPrincipal(organization, { env, event })
  const workspace = await stayAccessFor(principal)
  const booking = bookingResult?.results[0] as Pick<BookedRecord, 'unit' | 'status' | 'respond_by' | 'product_id' | 'location_id' | 'product_kind'>
    & { conversation_id: string; conversation_location_id: string | null; assigned: number; granted: number; operates: number } | undefined
  const hasReadAccess = booking?.granted || booking?.assigned || workspace.manage
  const hasUpdateAccess = booking?.operates || booking?.assigned || workspace.manage
  if (!booking || (action === 'read' ? !hasReadAccess : !hasUpdateAccess || (readPatch && !changesStay && !hasReadAccess))) {
    throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  }
  const access = !workspace.manage && booking.operates
    ? { ...workspace, manage: true as const, listingId: booking.product_id, operationalOnly: true }
    : workspace
  if (patch && 'error' in patch) throw patch.error
  const stayEdit = changesStay ? { current: stayResult?.results[0], home: homeResult?.results[0] } : undefined
  return { db, env, session, userId, organization, principal, access, bookingId, booking, patchBody, stayEdit }
}

function bookingAccessQuery(bookingId: string): BatchQuery {
  return {
    query: `SELECT b.id AS booking_id, b.organization_id, b.unit,
        ${BATCH_VIEWER.organizationWide} AS manages,
        ${roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))} AS can_read_payments, c.id AS conversation_id, c.location_id AS conversation_location_id, b.status, b.respond_by, b.product_id, b.location_id, b.product_kind,
        (${roleMatchesSql(BATCH_VIEWER.role!, assignedOperationsRoles)} AND ${assignedMemberSql('b', BATCH_VIEWER.user)}) AS assigned,
        ${listingGrantSql('b.organization_id', 'b.product_id', BATCH_VIEWER.member, 'details', BATCH_VIEWER.role)} AS granted,
        ${listingGrantSql('b.organization_id', 'b.product_id', BATCH_VIEWER.member, 'update', BATCH_VIEWER.role)} AS operates
      FROM ${BOOKING_RECORDS_SQL} b
      JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
      WHERE b.organization_id = ${BATCH_VIEWER.organization} AND b.id = ?`,
    params: [bookingId],
  }
}

export function prepareDashboardBookingRead(membership: BatchQuery, bookingId: string) {
  const booking = bookingAccessQuery(bookingId)
  const access = withViewer(membership, booking)
  const timed = prepareStaffBookingDetails(bookingId, {
    query: `SELECT * FROM (${access.query}) target WHERE unit = 'slot' AND (manages = 1 OR assigned = 1 OR granted = 1)`,
    params: access.params,
  })
  // Only a readable, managed stay supplies an organization, conversation and home.
  const managed = `SELECT * FROM (${booking.query}) target
    WHERE unit = 'nights' AND (manages = 1 OR (operates = 1 AND (assigned = 1 OR granted = 1)))`
  const organizationId = { sql: '(SELECT organization_id FROM reservation)' }
  const conversationId = { sql: '(SELECT conversation_id FROM reservation)' }
  const home = prepareStayReservationHome({
    organizationId, productId: { sql: '(SELECT product_id FROM reservation)' }, showLocation: true, showArrival: true,
  })
  const stayQueries = [
    stayDetailSelection({ query: organizationId.sql }, bookingId, true),
    guestRequestQuery(conversationId, organizationId, 'booking'),
    guestRequestMappingQuery(conversationId, organizationId),
    guestThreadChannelQuery(conversationId, organizationId),
    guestReplyAccountQuery({ query: `SELECT user_id FROM conversations WHERE id = ${conversationId.sql} AND organization_id = ${organizationId.sql}` }),
    threadOperationalRecordQuery(conversationId),
    pendingStayChangesQuery({ bookingId, conversationId, organizationId, userId: { sql: BATCH_VIEWER.user } }),
    sourceLocaleQuery(organizationId),
    ...home.queries,
  ].map(query => withViewer(membership, {
    query: `WITH reservation AS (${managed}) ${query.query}`,
    params: [...booking.params ?? [], ...query.params ?? []],
  }))
  return { queries: [access, ...timed.queries, ...stayQueries], timed, home, stayOffset: 2 + timed.queries.length }
}

export function readDashboardBookingDocument(event: H3Event, record: { orgSlug: string; bookingId: string }, preloaded?: D1Result[]) {
  return oncePerRequest(event, `dashboard-reservation-data:${record.orgSlug}:${record.bookingId}`, () =>
    dashboardBookingDetails(event, record, preloaded))
}

export async function dashboardBookingDetails(event: H3Event, record?: { orgSlug: string; bookingId: string }, preloaded?: D1Result[]) {
  const { env, db, membership } = await dashboardMemberQuery(event, record?.orgSlug)
  const bookingId = record?.bookingId ?? getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const plan = prepareDashboardBookingRead(membership, bookingId)
  const rows = preloaded ?? await executeBatch(db, [membership, ...plan.queries], { operation: 'Read the staff reservation' })
  const { access, organization, booking } = await dashboardBookingContext(event, 'read', undefined, record, rows)
  if (booking.unit === 'slot') {
    const facts = rows.slice(2, plan.stayOffset)
    const canReadPayments = await roleAllows({ ...organization, permissions: { payments: ['read'] } })
    return { booking: await plan.timed.read(db, env, facts, canReadPayments), manage: access.manage }
  }
  if (!access.manage) {
    const [stayRows, houseRows, media] = await executeBatch(db, [
      stayDetailQuery(access, bookingId),
      { query: `SELECT p.name, c.internal_name, b.check_in_time, b.check_in_end_time, b.check_out_time,
        c.check_in_method, c.check_in_instructions
        FROM product_stay_configs c
        JOIN products p ON p.organization_id=c.organization_id AND p.id=c.product_id
        JOIN product_booking_configs b ON b.organization_id=c.organization_id AND b.product_id=c.product_id
        WHERE c.organization_id=? AND c.product_id=?`, params: [organization.id, booking.product_id] },
      mediaPlacementsQuery({ organizationId: organization.id, ownerType: 'product', owners: [booking.product_id] }),
    ], { operation: 'Read turnover reservation and home' })
    const stay = stayDetailFrom(access, stayRows!.results[0])
    const house = houseRows!.results[0] as Omit<TurnoverBookingHome, 'image_url'> | undefined
    const photos = productPhotosFromPlacements(groupMediaPlacements(media!.results, [booking.product_id]))
    if (!house) throw new Error('The booking has no home')
    const home = { ...house, image_url: mediaStillUrl(photos.get(booking.product_id)?.[0]) }
    return { booking: nightBooking(stay), manage: false as const, home }
  }
  const [stayRows, threadRows, mapping, channelRows, accountRows, operations, changes, locale, ...homeRows] = rows.slice(plan.stayOffset)
  const stay = stayDetailFrom(access, stayRows!.results[0])
  const home = plan.home.read(homeRows)
  const threadRow = threadRows!.results[0] as Record<string, unknown> | undefined
  if (!threadRow) throw new Error('The booking has no guest conversation')
  const thread = await validateGuestRequest(db, threadRow, Boolean(mapping!.results.length))
  if (thread.booking_id !== bookingId) throw new Error('The booking has no guest conversation')
  const channel = channelRows!.results[0] as GuestThreadChannelRow | undefined
  const account = (accountRows!.results[0] as GuestReplyAccount | undefined) ?? null
  const canMessageGuest = !thread.blocked_at && (await guestReplyDestination(db, thread, channel ? parseGuestThreadChannel(channel) : null, account)).channel !== null

  const channelOwned = isChannelManagedStay(stay)
  const releaseNights = canReleaseStayNights(stay)
  const operationalRecord = stay.request_status && !releaseNights ? threadOperationalRecordFromRow(operations!.results[0]) : null
  if (stay.request_status && !releaseNights && !operationalRecord) throw new Error('The conversation has no booking')
  const available_actions = releaseNights ? ['release_nights'] : operationalRecord ? requestActions(operationalRecord, new Date().toISOString())
    : stay.status === 'cancelled' || channelOwned ? [] : ['edit', 'cancel']
  const pending_changes = stay.channel === 'airbnb' && channelOwned && changes!.results.length
    ? pendingStayChangesFromRows(changes!.results, bookingId, sourceLocaleFromRows(organization.id, locale!.results).locale)
    : []
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
async function dashboardPlacesCalendar(event: H3Event, window: BookingWindow, orgSlug?: string) {
  const env = cloudflareEnv(event)
  const session = await getDashboardSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
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
async function dashboardHomesCalendar(event: H3Event, window: BookingWindow, orgSlug?: string) {
  const env = cloudflareEnv(event)
  const session = await getDashboardSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
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

export async function dashboardBookingCalendar(event: H3Event, query: BookingListQuery, orgSlug?: string) {
  const window = bookingListWindow(query)
  if (window.unit === 'slot') return dashboardPlacesCalendar(event, window, orgSlug)
  if (window.unit === 'nights') return dashboardHomesCalendar(event, window, orgSlug)
  // Without a unit: the homes calendar, and the timed bookings beside its stays.
  const [homes, timed] = await Promise.all([dashboardHomesCalendar(event, window), dashboardBookingsContext(event).then(async context => timedBookings(await readBookedRecords(context, window), window))])
  return { ...homes, bookings: [...timed, ...homes.bookings] }
}

export async function readCalendarPlacePresence(event: H3Event, orgSlug?: string) {
  const { db, env, organization, userId } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
  await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const preloaded = event.context.dashboardCalendarPresence as { slug: string; has_places: boolean } | undefined
  if (preloaded?.slug === organization.slug) return { has_places: preloaded.has_places }
  const { query, params } = placesPresenceQuery({ query: '?', params: [organization.id] }, userId)
  const row = await queryFirst<{ has_places: number }>(db, query, params)
  if (!row) throw new Error('Calendar places could not be read')
  return { has_places: row.has_places === 1 }
}
