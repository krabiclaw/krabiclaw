import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import { memberBusyIntervals } from '~/server/domain/member-scheduling'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getGuestRequest, getThreadOperationalRecord, requestActions } from '~/server/domain/requests'
import { CURRENT_GUEST_SQL, GUEST_NOTE_EVENT, type MessageRow } from '~/server/domain/conversations'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertAssignedBookingAccess, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { formatBookingPolicySummary, parseBookingPolicy, type FormattedBookingPolicySummary } from '~/server/utils/booking-policy-summary'
import { freeCancellationUntil, outsideNotice } from '~/shared/availability-settings'
import type { ProductKind } from '~/shared/product-details'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { addLocalDays, isValidCalendarDate, localDateTimeToInstant, localPartsAt } from '~/utils/timezone'
import { listBookableSessions } from '~/server/utils/availability'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { pendingBookingChangeView } from '~/server/domain/guest-threads/booking-changes'
import { isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { readPaymentDetails } from '~/server/domain/payments'
import { formAnswerSnapshotsSchema, type FormAnswerSnapshot } from '~/shared/form-questions'
import { canRetryGuestVisitRefund } from '~/server/domain/payments/visit-refund'
import {paymentStateLabel,paymentDisplay,paymentRefundsDisplay,paymentOrderDisplay,type PaymentDisplay,type PaymentRefundDisplay,type PaymentOrderDisplay} from '~/shared/payment-display'

export type DashboardBookingType = 'booking'
/** What the record screen can show: a visit, or a purchase that stands on its own (an order, or a payment whose visit is gone). */
export type DashboardRecordType = DashboardBookingType | 'order' | 'payment'

interface BookingChangeTerms {
  when_label: string
  location_title: string
  party_size: number
  assigned_member_name: string | null
}

interface BookingRow {
  assigned_member_id: string | null
  booking_id: string
  version: number
  organization_id: string
  organization_name: string
  vertical: string
  location_id: string | null
  location_slug: string | null
  location_title: string | null
  location_address: string | null
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
  /** The offering's advance notice, which also closes the guest's own cancellation; null is no notice. */
  advance_notice_minutes: number | null
  no_show_at: string | null
  review_id: string | null
  private_notes: string | null
}


export interface DashboardBookingDetails {
  payment_id: string | null
  assigned_member_id: string | null
  assigned_member_name: string | null
  provider_conflict: boolean
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
  name: string
  resource_image_url: string | null
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
  /** The guest's answers to the business's own questions, in the wording they answered. A request made before questions has none. */
  answers: FormAnswerSnapshot[]
  /** A change the business proposed that the guest has not answered; Airbnb's "Change requested". */
  pending_change: { message_id: string; before: BookingChangeTerms; after: BookingChangeTerms } | null
  locations: Array<{ id: string; title: string; image_url: string | null }>
  payments: Array<{payment:PaymentDisplay;refunds:PaymentRefundDisplay[];order:PaymentOrderDisplay|null}> | null
  /** The guest's own self-service cancellation is still open. */
  guest_can_cancel: boolean
  /** An interrupted deposit refund can resume the already-recorded guest cancellation. */
  guest_can_retry_cancellation: boolean
  guest_cancel_refunds: boolean
  /** The business's phone for this booking, as the guest reaches it. */
  contact_phone: string | null
  /** When staff recorded the guest did not come. */
  no_show_at: string | null
  /** The team may still record a no-show: confirmed, begun, and not reviewed. */
  can_mark_no_show: boolean
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
    record.assigned_member_id, record.policy_json, record.product_kind, record.advance_notice_minutes, record.location_id, l.slug AS location_slug, l.title AS location_title, l.address AS location_address,
    json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email, json_extract(r.payload_json, '$.guest.phone') AS guest_phone,
    (SELECT u.image FROM user u WHERE u.id = r.user_id) AS guest_image_url, record.party_size, record.starts_at, record.ends_at, record.timezone, record.status,
    (SELECT m.body FROM messages m WHERE m.conversation_id = r.id AND m.event_name = '${GUEST_NOTE_EVENT}' ORDER BY m.sequence LIMIT 1) AS notes,
    record.product_id, record.name, record.product_session_id,
    r.id AS conversation_id, record.answers AS answers_json, json_extract(r.payload_json, '$.cancellation.used_at') AS cancellation_used_at, record.created_at, record.updated_at, record.no_show_at, (SELECT rv.id FROM reviews rv WHERE rv.organization_id = record.organization_id AND rv.booking_id = record.id ORDER BY rv.created_at LIMIT 1) AS review_id, record.private_notes
    FROM conversations r
    JOIN organization s ON s.id = r.organization_id
    JOIN (
      SELECT b.id, b.version, b.organization_id, b.status, b.party_size, b.starts_at, b.ends_at, b.timezone, b.location_id, b.product_id, p.name, b.product_session_id, cfg.assigned_member_id, b.created_at, b.updated_at, b.policy_json, p.kind AS product_kind, cfg.advance_notice_minutes, b.no_show_at, b.answers, b.private_notes
        FROM bookings b JOIN products p ON p.id = b.product_id
        LEFT JOIN product_booking_configs cfg ON cfg.product_id = b.product_id AND cfg.organization_id = b.organization_id
    ) record ON record.id = r.booking_id AND record.organization_id = r.organization_id
    LEFT JOIN business_locations l ON l.id = record.location_id
    WHERE ${lookup === 'booking' ? 'record.id' : 'r.id'} = ? AND record.product_session_id IS NOT NULL AND r.kind = ? AND ${scope.buyerUserId ? `r.user_id = ? AND ${CURRENT_GUEST_SQL('r')}` : 'r.organization_id = ?'}`, [bookingId, type, scope.buyerUserId ?? scope.organizationId])
}

async function assertBookingAccess(context: BookingAccessContext, row: BookingRow) {
  await assertAssignedBookingAccess(context.db, { ...memberAccessPrincipal(context.organization, { env: context.env }), bookingId: row.booking_id })
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
async function pendingBookingChange(db: DbClient, threadId: string | null): Promise<DashboardBookingDetails['pending_change']> {
  if (!threadId) return null
  const row = await queryFirst<MessageRow>(db, "SELECT * FROM messages WHERE conversation_id=? AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1", [threadId])
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

export async function loadDashboardBookingDetails(
  event: H3Event,
  input: { type: DashboardRecordType; bookingId: string; organizationSlug?: string | null; lookup?: 'booking' | 'conversation' },
): Promise<DashboardBookingDetails> {
  const context = await bookingContext(event, input.organizationSlug)
  if (input.type === 'order' || input.type === 'payment') {
    if (!await roleAllows({ organizationId: context.organization.id, role: context.organization.role, permissions: { payments: ['read'] } })) throw new HTTPError({ statusCode: 403, message: 'Payments access is required' })
    return composePurchaseDetails(context.db, context.env, { organizationId: context.organization.id }, input.bookingId)
  }
  const row = await loadBookingRow(context.db, { organizationId: context.organization.id }, input.type, input.bookingId, input.lookup)
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  await assertBookingAccess(context, row)
  const canReadPayments=await roleAllows({organizationId:context.organization.id,role:context.organization.role,permissions:{payments:['read']}})
  return composeBookingDetails(context.db, row, input.type, { env: context.env, canReadPayments })
}

/**
 * The same record as the account that booked it reads it: ownership is the
 * request's current buyer, the team's private notes and scheduling stay with
 * the team, and the payments are the ones this account made.
 */
// A booking shows its offering's picture and a table its location's. Organization artwork never stands in.
async function loadResourceImage(db: DbClient, row: BookingRow) {
  const [ownerType, ownerId] = row.product_kind === 'table'
    ? ['business_location' as const, row.location_id]
    : ['product' as const, row.product_id]
  if (!ownerId) return null
  return (await loadOwnerPictures(db, row.organization_id, ownerType, [ownerId], { organizationFallback: false })).get(ownerId)?.imageUrl ?? null
}

export async function loadBuyerBookingDetails(
  db: DbClient,
  env: CloudflareEnv,
  userId: string,
  type: DashboardRecordType,
  bookingId: string,
  lookup: 'booking' | 'conversation' = 'conversation',
): Promise<DashboardBookingDetails> {
  if (type === 'order' || type === 'payment') return composePurchaseDetails(db, env, { buyerUserId: userId }, bookingId)
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

  // A table may move to the business's tables at any of its locations; anything else stays where it is.
  const visibleLocations = await queryAll<{ id: string; title: string }>(db, row.product_kind === 'table'
    ? `SELECT DISTINCT l.id, l.title FROM business_locations l JOIN product_locations pl ON pl.organization_id = l.organization_id AND pl.location_id = l.id
        JOIN products p ON p.id = pl.product_id AND p.organization_id = pl.organization_id AND p.kind = 'table'
        JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
       WHERE l.organization_id = ? ORDER BY l.title`
    : 'SELECT id, title FROM business_locations WHERE organization_id = ? AND id IS ? ORDER BY title', row.product_kind === 'table' ? [row.organization_id] : [row.organization_id, row.location_id])
  const locationPictures = await loadOwnerPictures(db, row.organization_id, 'business_location', visibleLocations.map(location => location.id))
  const policy = parseBookingPolicy(row.policy_json)
  const [policyLocale, contact] = await Promise.all([
    getSourceLocale(db,row.organization_id),
    row.location_id
      ? resolveLocationContact(db, row.organization_id, row.location_id)
      : queryFirst<{ contactPhone: string | null }>(db, 'SELECT contact_phone AS contactPhone FROM organization WHERE id = ?', [row.organization_id]),
  ])

  const provider=!reader.buyerUserId&&row.assigned_member_id?await queryFirst<{name:string|null}>(db,`SELECT ${MEMBER_NAME_SQL} name FROM member m LEFT JOIN user u ON u.id=m.userId LEFT JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE m.id=? AND m.organizationId=?`,[row.assigned_member_id,row.organization_id]):null
  const now = new Date().toISOString()
  const complete = isBookingComplete({ status: row.status as BookingStatus, ends_at: row.ends_at }, now)
  // A live booking's provider calendar is asked about its time when the team reads it; a past or cancelled one has nothing to conflict with.
  const providerConflict=!reader.buyerUserId && row.assigned_member_id && !complete && row.status!=='cancelled'
    ? (await memberBusyIntervals(db,reader.env,row.organization_id,row.assigned_member_id,{from:row.starts_at,until:row.ends_at})).some(busy=>busy.start<row.ends_at&&busy.end>row.starts_at)
    : false
  const paymentIds=reader.buyerUserId
    ?await queryAll<{id:string}>(db,"SELECT id FROM payments WHERE organization_id=? AND subject_type='booking' AND subject_id=? AND buyer_user_id=? ORDER BY created_at,id",[row.organization_id,row.booking_id,reader.buyerUserId])
    :reader.canReadPayments?await queryAll<{id:string}>(db,"SELECT id FROM payments WHERE organization_id=? AND subject_type='booking' AND subject_id=? ORDER BY created_at,id",[row.organization_id,row.booking_id]):[]
  const payments=await Promise.all(paymentIds.map(async ({id})=>{
    const detail=await readPaymentDetails(db,reader.env,row.organization_id,id)
    return {payment:paymentDisplay(detail.payment),refunds:paymentRefundsDisplay(detail.refunds),order:paymentOrderDisplay(detail.order)}
  }))
  const guestCanRetryCancellation = Boolean(reader.buyerUserId && row.status === 'cancelled' && row.cancellation_used_at
    && await canRetryGuestVisitRefund(db, { organizationId: row.organization_id, bookingId: row.booking_id, requestId: row.conversation_id, buyerUserId: reader.buyerUserId }))
  const { policy_json: _policy, location_address, answers_json, cancellation_used_at: _cancellation, advance_notice_minutes: _notice,
    review_id: _review, private_notes, location_title, ...booking } = row
  return {
    ...booking,
    unit: 'slot',
    available_actions: reader.buyerUserId ? [] : [
      'edit',
      ...requestActions(await getThreadOperationalRecord(db, row.conversation_id), now).map(action => action === 'change' ? 'move' : action),
    ],
    payment_id: null,
    assigned_member_name: provider?.name ?? null,
    provider_conflict: providerConflict,
    type,
    location_title: row.location_id === null ? 'Online' : location_title!,
    location_address: location_address ? formatPostalAddress(parsePostalAddress(location_address)) || null : null,
    resource_image_url: await loadResourceImage(db, row),
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
    pending_change: await pendingBookingChange(db, row.conversation_id),
    locations: visibleLocations.map(location => ({ ...location, image_url: locationPictures.get(location.id)?.imageUrl ?? null })),
    payments:reader.buyerUserId||reader.canReadPayments?payments:null,
    // The same rule the public cancel route applies, read here so the screen
    // does not offer a cancellation the write would refuse.
    guest_can_cancel: ['pending', 'confirmed'].includes(row.status) && row.ends_at > now && !complete && !row.cancellation_used_at && (policy.advance_notice_minutes === null || outsideNotice(row.starts_at, policy.advance_notice_minutes, Date.parse(now))),
    guest_can_retry_cancellation: guestCanRetryCancellation,
    guest_cancel_refunds: now <= freeCancellationUntil(row.starts_at, policy.advance_notice_minutes),
    contact_phone: contact?.contactPhone ?? null,
    can_mark_no_show: !reader.buyerUserId && row.status === 'confirmed' && row.no_show_at === null && row.review_id === null && row.starts_at <= now,
    review_invitation: reader.buyerUserId ? null : await reviewInvitationState(db, row.booking_id, now),
  }
}

/** The latest invitation minted for the visit, as the team reads it. */
async function reviewInvitationState(db: DbClient, bookingId: string, now: string): Promise<DashboardBookingDetails['review_invitation']> {
  const request = await queryFirst<{ first_sent_at: string | null; submitted_at: string | null; revoked_at: string | null; expires_at: string }>(db,
    'SELECT first_sent_at, submitted_at, revoked_at, expires_at FROM review_requests WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [bookingId])
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
  await assertBookingAccess(context, row)
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
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || to <= from || to > addLocalDays(from, 31)) {
    throw new HTTPError({ statusCode: 422, message: 'Request up to 31 calendar days' })
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
  return isDashboardBookingType(value) || value === 'order' || value === 'payment'
}

/**
 * A purchase on the same screen as a visit: an order, or a payment whose visit
 * no longer exists, read by the business that took it or the account that paid.
 * It has no party, time, policy or conversation, and nothing left to decide —
 * what remains is what was bought, when, from whom, and the money.
 */
async function composePurchaseDetails(db: DbClient, env: CloudflareEnv, scope: BookingScope, paymentId: string): Promise<DashboardBookingDetails> {
  const payment = await queryFirst<{ organization_id: string; buyer_user_id: string | null; location_id: string | null; created_at: string; updated_at: string; organization_name: string; vertical: string; contact_phone: string | null; buyer_name: string | null; buyer_email: string | null; buyer_image: string | null; location_slug: string | null; location_title: string | null }>(db, `
    SELECT p.organization_id, p.buyer_user_id, p.location_id, p.created_at, p.updated_at, s.name AS organization_name, s.vertical, s.contact_phone,
           u.name AS buyer_name, u.email AS buyer_email, u.image AS buyer_image, l.slug AS location_slug, l.title AS location_title
    FROM payments p
    JOIN organization s ON s.id = p.organization_id
    LEFT JOIN user u ON u.id = p.buyer_user_id
    LEFT JOIN business_locations l ON l.id = p.location_id AND l.organization_id = p.organization_id
    WHERE p.id = ? AND ${scope.buyerUserId ? 'p.buyer_user_id = ?' : 'p.organization_id = ?'}`, [paymentId, scope.buyerUserId ?? scope.organizationId])
  if (!payment) throw new HTTPError({ statusCode: 404, message: 'Purchase not found' })
  const detail = await readPaymentDetails(db, env, payment.organization_id, paymentId)
  const snapshot: unknown = JSON.parse(detail.payment.price_snapshot_json)
  const line = detail.order ? await queryFirst<{ product_id: string | null }>(db, 'SELECT product_id FROM payment_order_lines WHERE order_id = ? ORDER BY rowid LIMIT 1', [detail.order.id]) : null
  // A purchase keeps the item's own photo or the place it was sold.
  const resourceImageUrl = (line?.product_id ? (await loadOwnerPictures(db, payment.organization_id, 'product', [line.product_id], { organizationFallback: false })).get(line.product_id)?.imageUrl : null)
    ?? (payment.location_id ? (await loadOwnerPictures(db, payment.organization_id, 'business_location', [payment.location_id], { organizationFallback: false })).get(payment.location_id)?.imageUrl : null)
    ?? null
  if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error('Purchase has no immutable title')
  const contact = payment.location_id ? await resolveLocationContact(db, payment.organization_id, payment.location_id) : { contactPhone: payment.contact_phone }
  return {
    assigned_member_id: null, assigned_member_name: null, provider_conflict: false,
    // A purchase asks no questions.
    answers: [],
    payment_id: paymentId,
    booking_id: null,
    version: null,
    unit: null,
    available_actions: [],
    type: detail.order ? 'order' : 'payment',
    organization_id: payment.organization_id,
    organization_name: payment.organization_name,
    vertical: payment.vertical,
    location_id: payment.location_id,
    location_slug: payment.location_slug,
    location_title: payment.location_id === null ? 'Online' : payment.location_title ?? 'Online',
    location_address: null,
    product_kind: null,
    resource_image_url: resourceImageUrl,
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
    status: paymentStateLabel(detail.payment),
    complete: true,
    notes: null,
    product_id: null,
    product_session_id: null,
    conversation_id: null,
    created_at: payment.created_at,
    updated_at: payment.updated_at,
    policy: null,
    private_notes: null,
    pending_change: null,
    locations: [],
    payments: [{ payment: paymentDisplay(detail.payment), refunds: paymentRefundsDisplay(detail.refunds), order: paymentOrderDisplay(detail.order) }],
    guest_can_cancel: false,
    guest_can_retry_cancellation: false,
    guest_cancel_refunds: false,
    no_show_at: null,
    can_mark_no_show: false,
    review_invitation: null,
    contact_phone: contact?.contactPhone ?? null,
  }
}
