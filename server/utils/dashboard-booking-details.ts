import { MEMBER_NAME_SQL, RESERVATION_HOST_SQL, type PublicProvider } from '~/shared/member-scheduling'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getGuestRequest, timedBookingActions } from '~/server/domain/requests'
import { CURRENT_GUEST_SQL, GUEST_NOTE_EVENT, type MessageRow } from '~/server/domain/conversations'
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertAssignedBookingAccess, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { formatBookingPolicySummary, parseBookingPolicy, type FormattedBookingPolicySummary } from '~/server/utils/booking-policy-summary'
import { freeCancellationUntil, outsideNotice } from '~/shared/availability-settings'
import type { ProductKind } from '~/shared/product-details'
import { sourceLocaleFromRows, sourceLocaleQuery } from '~/server/utils/localization'
import { loadOwnerPictures, ownerPicturesFromRows } from '~/server/notifications/hero'
import { groupMediaPlacements, mediaPlacementsQuery, type StoredMediaPlacementItem } from '~/server/utils/media-asset-manager'
import { mediaStillUrl, resolveOwnerPicture, uniqueMediaAssets } from '~/shared/media-placement-contract'
import { addLocalDays, isValidCalendarDate, localDateTimeToInstant, localPartsAt } from '~/utils/timezone'
import { listBookableSessions } from '~/server/utils/availability'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { calculateMapUrl, coordinatesFailure } from '~/utils/location-map'
import { pendingBookingChangeView } from '~/server/domain/guest-threads/booking-changes'
import { isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { paymentReceiptsFromRows, paymentReceiptsQuery, readPaymentReceipts } from '~/server/domain/payments'
import { formAnswerSnapshotsSchema, type FormAnswerSnapshot } from '~/shared/form-questions'
import { canRetryGuestVisitRefund } from '~/server/domain/payments/visit-refund'
import { historicalNoShowAtSql } from '~/server/utils/review-requests'
import { paymentStateLabel, type PaymentDisplay, type PaymentRefundDisplay } from '~/shared/payment-display'

export type DashboardBookingType = 'booking'
/** What the record screen can show: a visit, or a payment whose visit is gone. */
export type DashboardRecordType = DashboardBookingType | 'payment'

interface BookingChangeTerms {
  when_label: string
  location_title: string
  party_size: number
  assigned_member_name: string | null
}

interface BookingRow {
  assigned_member_id: string | null
  assigned_member_name: string | null
  host_json: string | null
  booking_id: string
  version: number
  organization_id: string
  organization_name: string
  vertical: string
  location_id: string | null
  location_slug: string | null
  location_title: string | null
  location_address: string | null
  location_latitude: number | null
  location_longitude: number | null
  location_maps_url: string | null
  contact_phone: string | null
  guest_name: string
  guest_email: string
  guest_phone: string | null
  guest_image_url: string | null
  party_size: number
  /** The occurrence itself, in its own zone: one instant, not a date and a time. */
  starts_at: string
  ends_at: string
  timezone: string
  status: string
  notes: string | null
  product_id: string
  name: string
  product_session_id: string
  conversation_id: string
  answers_json: string
  cancellation_used_at: string | null
  created_at: string
  updated_at: string
  policy_json: string
  product_kind: ProductKind
  private_notes: string | null
  no_show_at: string | null
}


export interface DashboardBookingDetails {
  payment_id: string | null
  assigned_member_id: string | null
  assigned_member_name: string | null
  host: PublicProvider | null
  /** A future provider occurrence the caller may reassign through Better Auth. */
  updated_at: string
  booking_id: string | null
  version: number | null
  unit: 'slot' | null
  available_actions: string[]
  type: DashboardRecordType
  /** What was booked: a table reads as a reservation. Null for a purchase. */
  product_kind: ProductKind | null
  organization_id: string
  organization_name: string
  vertical: string
  location_id: string | null
  location_slug: string | null
  location_title: string
  location_address: string | null
  location_pin: { latitude: number; longitude: number } | null
  location_maps_url: string | null
  name: string
  resource_photo_urls: string[]
  /** Null for a purchase made without an account. */
  guest_name: string | null
  guest_email: string | null
  guest_phone: string | null
  guest_image_url: string | null
  /** Null for a purchase, which has no party. */
  party_size: number | null
  /** The visit's local day, or the day a purchase was made. */
  booking_date: string
  /** Null for a purchase. */
  booking_time: string | null
  /** Null for a purchase. */
  booking_end_time: string | null
  /** The local day the visit ends, or null for a purchase. */
  booking_end_date: string | null
  starts_at: string | null
  ends_at: string | null
  timezone: string
  status: string
  /** Derived, never stored: confirmed and its end has passed. */
  complete: boolean
  notes: string | null
  product_id: string | null
  /**
   * The session a booking holds seats in. A change to a booking names the
   * session it moves to, so the screen has to know which one it is on now.
   * Null for a purchase.
   */
  product_session_id: string | null
  conversation_id: string | null
  created_at: string
  policy: FormattedBookingPolicySummary | null
  /** The team's private note on the booking (bookings.private_notes), never shown to the guest; null when there is none or the reader is the guest. */
  private_notes: string | null
  no_show_at: string | null
  /** The guest's answers to the business's own questions, in the wording they answered. A request made before questions has none. */
  answers: FormAnswerSnapshot[]
  /** A change the business proposed that the guest has not answered; Airbnb's "Change requested". */
  pending_change: { message_id: string; before: BookingChangeTerms; after: BookingChangeTerms } | null
  locations: Array<{ id: string; title: string; image_url: string | null }>
  payments: Array<{payment:PaymentDisplay;refunds:PaymentRefundDisplay[]}> | null
  /** The guest's own self-service cancellation is still open. */
  guest_can_cancel: boolean
  /** An interrupted deposit refund can resume the already-recorded guest cancellation. */
  guest_can_retry_cancellation: boolean
  guest_cancel_refunds: boolean
  /** The business's phone for this booking, as the guest reaches it. */
  contact_phone: string | null
  /** When staff recorded the guest did not come. */
  /** Where the visit's review invitation stands, for the team; null before one is sent. */
  review_invitation: { state: 'sent' | 'submitted' | 'revoked' | 'expired'; at: string } | null
}

interface BookingAccessContext {
  env: Awaited<ReturnType<typeof getDashboardMemberContext>>['env']
  db: DbClient
  userId: string
  organization: NonNullable<Awaited<ReturnType<typeof getDashboardMemberContext>>['organization']>
}



async function bookingContext(event: H3Event, organizationSlug?: string | null): Promise<BookingAccessContext> {
  const context = await getDashboardMemberContext(event, {
        organizationSlug,
  })
  if (!context.organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  return {
    env: context.env,
    db: context.db,
    userId: context.userId,
    organization: context.organization,
  }
}

/** Whose booking: the business that hosts it, or the account that currently owns it. */
type BookingScope = { organizationId: string; buyerUserId?: undefined } | { buyerUserId: string; organizationId?: undefined }

async function loadBookingRow(
  db: DbClient,
  scope: BookingScope,
  type: DashboardBookingType,
  bookingId: string,
  lookup: 'booking' | 'conversation' = 'conversation',
): Promise<BookingRow | null> {
  // When, for how many and against what all live on the booking the thread
  // refers to, not on the thread. The thread carries the conversation and the
  // guest.
  return queryFirst<BookingRow>(db, `SELECT record.id AS booking_id, record.version, r.organization_id, s.name AS organization_name, s.vertical,
    record.assigned_member_id, record.policy_json, record.product_kind, record.location_id,
    l.slug AS location_slug, l.title AS location_title, l.address AS location_address,
    l.latitude AS location_latitude, l.longitude AS location_longitude, l.maps_url AS location_maps_url,
    CASE WHEN record.location_id IS NULL THEN s.contact_phone WHEN l.status = 'active' THEN l.phone END AS contact_phone,
    ${scope.buyerUserId ? 'NULL' : MEMBER_NAME_SQL} AS assigned_member_name,
    ${RESERVATION_HOST_SQL} AS host_json,
    json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email, json_extract(r.payload_json, '$.guest.phone') AS guest_phone,
    (SELECT u.image FROM user u WHERE u.id = r.user_id) AS guest_image_url, record.party_size, record.starts_at, record.ends_at, record.timezone, record.status,
    (SELECT m.body FROM messages m WHERE m.conversation_id = r.id AND m.event_name = '${GUEST_NOTE_EVENT}' ORDER BY m.sequence LIMIT 1) AS notes,
    record.product_id, record.name, record.product_session_id,
    r.id AS conversation_id, record.answers AS answers_json, json_extract(r.payload_json, '$.cancellation.used_at') AS cancellation_used_at, record.created_at, record.updated_at, ${historicalNoShowAtSql('r')} AS no_show_at, record.private_notes
    FROM conversations r
    JOIN organization s ON s.id = r.organization_id
    JOIN (
      SELECT b.id, b.version, b.organization_id, b.status, b.party_size, b.starts_at, b.ends_at, b.timezone, b.location_id, b.product_id, p.name, b.product_session_id, cfg.assigned_member_id, b.created_at, b.updated_at, b.policy_json, p.kind AS product_kind, b.answers, b.private_notes
        FROM bookings b JOIN products p ON p.id = b.product_id
        LEFT JOIN product_booking_configs cfg ON cfg.product_id = b.product_id AND cfg.organization_id = b.organization_id
    ) record ON record.id = r.booking_id AND record.organization_id = r.organization_id
    LEFT JOIN business_locations l ON l.id = record.location_id AND l.organization_id = record.organization_id
    LEFT JOIN member_scheduling ms ON ms.organization_id = record.organization_id AND ms.member_id = record.assigned_member_id
    LEFT JOIN member host_member ON host_member.organizationId = record.organization_id AND host_member.id = record.assigned_member_id
    LEFT JOIN user u ON u.id = host_member.userId
    WHERE ${lookup === 'booking' ? 'record.id' : 'r.id'} = ? AND record.product_session_id IS NOT NULL AND r.kind = ? AND ${scope.buyerUserId ? `r.user_id = ? AND ${CURRENT_GUEST_SQL('r')}` : 'r.organization_id = ?'}`, [bookingId, type, scope.buyerUserId ?? scope.organizationId])
}

async function assertBookingAccess(context: BookingAccessContext, row: BookingRow, action: 'read' | 'update' = 'read') {
  await assertAssignedBookingAccess(context.db, { ...memberAccessPrincipal(context.organization, { env: context.env }), bookingId: row.booking_id, action })
}

function localDateOf(row: Pick<BookingRow, 'starts_at' | 'timezone'>): string {
  const parts = localPartsAt(new Date(row.starts_at), row.timezone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function localTimeOf(row: Pick<BookingRow, 'starts_at' | 'timezone'>): string {
  const parts = localPartsAt(new Date(row.starts_at), row.timezone)
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

/** The latest proposal on the thread with no acceptance or decline answering it. */
async function pendingBookingChange(db: DbClient, threadId: string, row?: MessageRow): Promise<DashboardBookingDetails['pending_change']> {
  if (!row) return null
  const thread = await getGuestRequest(db, threadId)
  if (!thread) return null
  const proposal = await pendingBookingChangeView(db, thread, row)
  if (!proposal) return null
  const terms = ({ when_label, party_size, assigned_member_name }: Omit<BookingChangeTerms, 'location_title'>, location_title: string): BookingChangeTerms => ({
    when_label, party_size, assigned_member_name, location_title,
  })
  return {
    message_id: row.id,
    before: terms(proposal.before, proposal.original_location_title),
    after: terms(proposal.after, proposal.location_title),
  }
}

export async function loadDashboardPurchaseDetails(event: H3Event, paymentId: string): Promise<DashboardBookingDetails> {
  const { db, env, organization } = await bookingContext(event)
  if (!await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['read'] } })) {
    throw new HTTPError({ statusCode: 403, message: 'Payments access is required' })
  }
  return composePurchaseDetails(db, env, { organizationId: organization.id }, paymentId)
}

export async function loadStaffBookingDetails(context: BookingAccessContext, bookingId: string): Promise<DashboardBookingDetails> {
  const { db, env, organization } = context
  const row = await loadBookingRow(db, { organizationId: organization.id }, 'booking', bookingId, 'booking')
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  await assertBookingAccess(context, row)
  const canReadPayments = await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['read'] } })
  return composeBookingDetails(db, row, 'booking', { env, canReadPayments })
}

/**
 * The same record as the account that booked it reads it: ownership is the
 * request's current buyer, the team's private notes and scheduling stay with
 * the team, and the payments are the ones this account made.
 */
// A reservation shows its offering's photos, or the location's photos for a table.
function resourcePhotoUrls(kind: ProductKind, photos: StoredMediaPlacementItem[]): string[] {
  const gallery = photos.filter(photo => photo.slot === 'gallery')
  if (kind !== 'table') return uniqueMediaAssets([...photos.filter(photo => photo.slot === 'image'), ...gallery])
    .map(mediaStillUrl).filter((url): url is string => url !== null)
  return [...new Set([resolveOwnerPicture('business_location', photos, []), ...gallery]
    .map(mediaStillUrl).filter((url): url is string => url !== null))]
}

export async function loadBuyerBookingDetails(
  db: DbClient,
  env: CloudflareEnv,
  userId: string,
  type: DashboardRecordType,
  bookingId: string,
  lookup: 'booking' | 'conversation' = 'conversation',
): Promise<DashboardBookingDetails> {
  if (type === 'payment') return composePurchaseDetails(db, env, { buyerUserId: userId }, bookingId)
  const row = await loadBookingRow(db, { buyerUserId: userId }, type, bookingId, lookup)
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  return composeBookingDetails(db, row, type, { env, buyerUserId: userId })
}

async function composeBookingDetails(
  db: DbClient,
  row: BookingRow,
  type: DashboardBookingType,
  reader: { env: CloudflareEnv; canReadPayments: boolean; buyerUserId?: undefined } | { buyerUserId: string; env: CloudflareEnv; canReadPayments?: undefined },
): Promise<DashboardBookingDetails> {
  if (row.location_id !== null && !row.location_title) throw new HTTPError({ statusCode: 500, message: 'The booking location is missing its title' })
  const { location_latitude: latitude, location_longitude: longitude, location_maps_url, location_address, location_title,
    policy_json: _policy, answers_json, cancellation_used_at: _cancellation, private_notes, host_json, ...booking } = row
  const address = parsePostalAddress(location_address)
  const pinFailure = coordinatesFailure({ latitude, longitude })
  if (pinFailure) throw new HTTPError({ statusCode: 500, message: pinFailure.error, data: { code: 'INVALID_STORED_LOCATION', field: pinFailure.field } })

  // A table may move to the business's tables at any of its locations; anything else stays where it is.
  const locationSelection = row.product_kind === 'table' ? {
    query: `SELECT DISTINCT l.id, l.title
         FROM business_locations l JOIN product_locations pl ON pl.organization_id = l.organization_id AND pl.location_id = l.id
         JOIN products p ON p.id = pl.product_id AND p.organization_id = l.organization_id AND p.kind = 'table'
         JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
        WHERE l.organization_id = ? ORDER BY l.title`, params: [row.organization_id],
  } : { query: 'SELECT ? AS id, ? AS title WHERE ? IS NOT NULL', params: [row.location_id, location_title, row.location_id] }
  const resourceId = row.product_kind === 'table' ? row.location_id : row.product_id
  const canReadPayments = Boolean(reader.buyerUserId || reader.canReadPayments)
  const [places, placeMedia, photos, locale, proposal, review, receipt] = await executeBatch(db, [
    locationSelection,
    mediaPlacementsQuery({ organizationId: row.organization_id, ownerType: 'business_location', includeOrganizationFallback: true,
      owners: { sql: `SELECT id FROM (${locationSelection.query})`, params: locationSelection.params } }),
    mediaPlacementsQuery({ organizationId: row.organization_id, ownerType: row.product_kind === 'table' ? 'business_location' : 'product',
      owners: resourceId ? [resourceId] : [] }),
    sourceLocaleQuery(row.organization_id),
    { query: "SELECT * FROM messages WHERE conversation_id=? AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1", params: [row.conversation_id] },
    { query: 'SELECT first_sent_at, submitted_at, revoked_at, expires_at FROM review_requests WHERE booking_id = ? AND ? = 1 ORDER BY created_at DESC LIMIT 1',
      params: [row.booking_id, Number(!reader.buyerUserId)] },
    ...(canReadPayments ? [paymentReceiptsQuery(row.organization_id, { bookingId: row.booking_id }, reader.buyerUserId)] : []),
  ], { operation: 'Read reservation locations, media and display facts' })
  const visibleLocations = places!.results as { id: string; title: string }[]
  const locationPictures = ownerPicturesFromRows(row.organization_id, 'business_location', visibleLocations.map(location => location.id), placeMedia!.results)
  const resourcePhotos = resourcePhotoUrls(row.product_kind, resourceId ? groupMediaPlacements(photos!.results).get(resourceId) ?? [] : [])
  const policy = parseBookingPolicy(row.policy_json)
  const policyLocale = sourceLocaleFromRows(row.organization_id, locale!.results).locale
  const now = new Date().toISOString()
  const complete = isBookingComplete({ status: row.status as BookingStatus, ends_at: row.ends_at }, now)
  const [payments, pendingChange] = await Promise.all([
    receipt ? paymentReceiptsFromRows(reader.env, receipt.results) : null,
    pendingBookingChange(db, row.conversation_id, proposal!.results[0] as MessageRow | undefined),
  ])
  const guestCanRetryCancellation = Boolean(reader.buyerUserId && row.status === 'cancelled' && row.cancellation_used_at
    && await canRetryGuestVisitRefund(db, { organizationId: row.organization_id, bookingId: row.booking_id, requestId: row.conversation_id, buyerUserId: reader.buyerUserId }))
  return {
    ...booking,
    unit: 'slot',
    available_actions: reader.buyerUserId ? [] : [
      'edit',
      ...timedBookingActions(row, now).map(action => action === 'change' ? 'move' : action),
    ],
    payment_id: null,
    host: host_json === null ? null : JSON.parse(host_json) as PublicProvider,
    type,
    location_title: row.location_id === null ? 'Online' : location_title!,
    location_address: formatPostalAddress(address) || null,
    location_pin: latitude === null || longitude === null ? null : { latitude, longitude },
    location_maps_url: calculateMapUrl({ title: location_title ?? '', address, latitude, longitude, maps_url: location_maps_url }),
    resource_photo_urls: resourcePhotos,
    // The picture is the buyer's own account picture when they booked signed in; an emailed guest has none.
    // The screen shows a local date and time; the record holds one instant and
    // the zone it belongs to, so these are read off it rather than stored
    // alongside it and kept in step.
    booking_date: localDateOf(row),
    booking_time: localTimeOf(row),
    booking_end_time: localTimeOf({ starts_at: row.ends_at, timezone: row.timezone }),
    booking_end_date: localDateOf({ starts_at: row.ends_at, timezone: row.timezone }),
    complete,
    policy: formatBookingPolicySummary(policy, policyLocale, row.product_kind),
    private_notes: reader.buyerUserId ? null : private_notes,
    answers: formAnswerSnapshotsSchema.parse(JSON.parse(answers_json)),
    pending_change: pendingChange,
    locations: visibleLocations.map(location => ({ ...location, image_url: locationPictures.get(location.id)?.imageUrl ?? null })),
    payments,
    // The same rule the public cancel route applies, read here so the screen
    // does not offer a cancellation the write would refuse.
    guest_can_cancel: ['pending', 'confirmed'].includes(row.status) && row.ends_at > now && !complete && !row.cancellation_used_at && (policy.advance_notice_minutes === null || outsideNotice(row.starts_at, policy.advance_notice_minutes, Date.parse(now))),
    guest_can_retry_cancellation: guestCanRetryCancellation,
    guest_cancel_refunds: now <= freeCancellationUntil(row.starts_at, policy.advance_notice_minutes),
    review_invitation: reviewInvitationState(review!.results[0] as ReviewInvitationRow | undefined, now),
  }
}

/** The latest invitation minted for the visit, as the team reads it. */
type ReviewInvitationRow = { first_sent_at: string | null; submitted_at: string | null; revoked_at: string | null; expires_at: string }

function reviewInvitationState(request: ReviewInvitationRow | undefined, now: string): DashboardBookingDetails['review_invitation'] {
  if (!request?.first_sent_at) return null
  if (request.submitted_at) return { state: 'submitted', at: request.submitted_at }
  if (request.revoked_at) return { state: 'revoked', at: request.revoked_at }
  if (request.expires_at <= now) return { state: 'expired', at: request.expires_at }
  return { state: 'sent', at: request.first_sent_at }
}

/**
 * The scheduled sessions a booking can move to on one local day, for whoever
 * may change that booking: its booked provider reads them without product
 * access. They are its own offering's, or for a table, the business's tables
 * at the location named (its own when none is). The booking's current session
 * is among them when it is that day.
 */
export async function listDashboardBookingChangeSessions(event: H3Event, input: { bookingId: string; from?: unknown; to?: unknown; locationId?: unknown }) {
  if (input.locationId !== undefined && (typeof input.locationId !== 'string' || !input.locationId)) throw new HTTPError({ statusCode: 400, message: 'location_id must name a location' })
  const context = await bookingContext(event)
  const row = await loadBookingRow(context.db, { organizationId: context.organization.id }, 'booking', input.bookingId, 'booking')
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  await assertBookingAccess(context, row, 'update')
  const elsewhere = input.locationId !== undefined && input.locationId !== row.location_id
  if (elsewhere && row.product_kind !== 'table') throw new HTTPError({ statusCode: 409, message: 'Only a table booking can move to another location' })
  const target = elsewhere
    ? await queryFirst<{ product_id: string; timezone: string; location_title: string }>(context.db, `SELECT p.id AS product_id, l.timezone, l.title AS location_title FROM products p
        JOIN product_locations pl ON pl.organization_id = p.organization_id AND pl.product_id = p.id
        JOIN business_locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id
        JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
       WHERE p.organization_id = ? AND p.kind = 'table' AND p.active = 1 AND pl.active = 1 AND pl.location_id = ?`, [row.organization_id, input.locationId])
    : { product_id: row.product_id, timezone: row.timezone, location_title: row.location_title }
  if (!target) throw new HTTPError({ statusCode: 404, message: 'That location takes no table bookings' })
  const from = input.from ?? localDateOf(row)
  const to = input.to ?? (isValidCalendarDate(from) ? addLocalDays(from, 7) : null)
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || to <= from) {
    throw new HTTPError({ statusCode: 422, message: 'Choose calendar dates with to after from' })
  }
  const locationId = elsewhere ? input.locationId as string : row.location_id
  const sessions = await listBookableSessions(context.db, { env: context.env, organizationId: row.organization_id, productId: target.product_id, locationId,
    fromInstant: localDateTimeToInstant(from, '00:00', target.timezone, 'compatible').toISOString(),
    toInstant: localDateTimeToInstant(to, '00:00', target.timezone, 'compatible').toISOString() })
  return sessions.map(session => ({ ...session, product_session_id: session.id, location_title: target.location_title,
    remaining: session.id === row.product_session_id && session.remaining !== null ? session.remaining + row.party_size : session.remaining }))
}

export function isDashboardBookingType(value: string | undefined): value is DashboardBookingType {
  return value === 'booking'
}

export function isDashboardRecordType(value: string | undefined): value is DashboardRecordType {
  return isDashboardBookingType(value) || value === 'payment'
}

/**
 * A purchase on the same screen as a visit: a payment whose visit no longer
 * exists, read by the business that took it or the account that paid.
 * It has no party, time, policy or conversation, and nothing left to decide —
 * what remains is what was bought, when, from whom, and the money.
 */
async function composePurchaseDetails(db: DbClient, env: CloudflareEnv, scope: BookingScope, paymentId: string): Promise<DashboardBookingDetails> {
  const payment = await queryFirst<{ organization_id: string; location_id: string | null; created_at: string; updated_at: string; price_snapshot_json: string; organization_name: string; vertical: string; contact_phone: string | null; buyer_name: string | null; buyer_email: string | null; buyer_image: string | null; location_slug: string | null; location_title: string | null }>(db, `
    SELECT p.organization_id, p.location_id, p.created_at, p.updated_at, p.price_snapshot_json, s.name AS organization_name, s.vertical,
           CASE WHEN p.location_id IS NULL THEN s.contact_phone WHEN l.status = 'active' THEN l.phone END AS contact_phone,
           u.name AS buyer_name, u.email AS buyer_email, u.image AS buyer_image, l.slug AS location_slug, l.title AS location_title
    FROM payments p
    JOIN organization s ON s.id = p.organization_id
    LEFT JOIN user u ON u.id = p.buyer_user_id
    LEFT JOIN business_locations l ON l.id = p.location_id AND l.organization_id = p.organization_id
    WHERE p.id = ? AND ${scope.buyerUserId ? 'p.buyer_user_id = ?' : 'p.organization_id = ?'}`, [paymentId, scope.buyerUserId ?? scope.organizationId])
  if (!payment) throw new HTTPError({ statusCode: 404, message: 'Purchase not found' })
  const [receipt] = await readPaymentReceipts(db, env, payment.organization_id, { paymentId }, scope.buyerUserId)
  if (!receipt) throw new HTTPError({ statusCode: 404, message: 'Purchase not found' })
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  // A purchase keeps the photo of the place it was sold.
  const resourceImageUrl = (payment.location_id ? (await loadOwnerPictures(db, payment.organization_id, 'business_location', [payment.location_id], { organizationFallback: false })).get(payment.location_id)?.imageUrl : null)
    ?? null
  if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error('Purchase has no immutable title')
  return {
    assigned_member_id: null, assigned_member_name: null, host: null,
    // A purchase asks no questions.
    answers: [],
    payment_id: paymentId,
    booking_id: null,
    version: null,
    unit: null,
    available_actions: [],
    type: 'payment',
    organization_id: payment.organization_id,
    organization_name: payment.organization_name,
    vertical: payment.vertical,
    location_id: payment.location_id,
    location_slug: payment.location_slug,
    location_title: payment.location_id === null ? 'Online' : payment.location_title ?? 'Online',
    location_address: null,
    location_pin: null,
    location_maps_url: null,
    product_kind: null,
    resource_photo_urls: resourceImageUrl ? [resourceImageUrl] : [],
    name: snapshot.title,
    guest_name: payment.buyer_name,
    guest_email: payment.buyer_email,
    guest_phone: null,
    guest_image_url: payment.buyer_image,
    party_size: null,
    booking_date: localDateOf({ starts_at: payment.created_at, timezone: 'UTC' }),
    booking_time: null,
    booking_end_time: null,
    booking_end_date: null,
    starts_at: null,
    ends_at: null,
    timezone: 'UTC',
    status: paymentStateLabel(receipt.payment),
    complete: true,
    notes: null,
    product_id: null,
    product_session_id: null,
    conversation_id: null,
    created_at: payment.created_at,
    updated_at: payment.updated_at,
    policy: null,
    private_notes: null,
    no_show_at: null,
    pending_change: null,
    locations: [],
    payments: [receipt],
    guest_can_cancel: false,
    guest_can_retry_cancellation: false,
    guest_cancel_refunds: false,
    review_invitation: null,
    contact_phone: payment.contact_phone,
  }
}
