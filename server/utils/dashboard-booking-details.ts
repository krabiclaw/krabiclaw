import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'
import { readMemberScheduling, refreshMemberBusy } from '~/server/domain/member-scheduling'
import { getGuestRequest, REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertResourceAccess, assertAssignedBookingAccess, isOrganizationWideRole, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { productPolicySummarySource, renderBookingPolicySummary, type RenderedBookingPolicySummary } from '~/server/utils/reservations'
import type { BookingPolicySummarySource } from '~/server/utils/booking-policy-summary'
import { assertProductKind, validateProductDetails, type ProductKind } from '~/shared/product-details'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { localPartsAt } from '~/utils/timezone'
import { appendEntry, getEntryById, GuestThreadEntryDedupeConflictError } from '~/server/domain/guest-threads/entries'
import { moveBooking, requestBookingChange } from '~/server/domain/guest-threads/booking-changes'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { readPaymentDetails } from '~/server/domain/payments'
import { canRetryGuestReservationRefund } from '~/server/domain/payments/visit-refund'
import {paymentDisplay,paymentRefundsDisplay,paymentOrderDisplay,type PaymentDisplay,type PaymentRefundDisplay,type PaymentOrderDisplay} from '~/shared/payment-display'

export type DashboardBookingType = 'reservation' | 'booking'
/** What the record screen can show: a visit, or a purchase that stands on its own (an order, or a payment whose visit is gone). */
export type DashboardRecordType = DashboardBookingType | 'order' | 'payment'

interface BookingRow {
  id: string
  assigned_member_id: string | null
  operational_updated_at: string
  operational_id: string
  organization_id: string
  organization_name: string
  vertical: string
  location_id: string | null
  location_slug: string | null
  location_title: string | null
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
  requests: string | null
  experience_id: string | null
  experience_title: string | null
  session_id: string | null
  scheduling_mode: string | null
  session_status: string | null
  request_id: string | null
  cancellation_used_at: string | null
  created_at: string
  updated_at: string
  policy_json: string | null
  product_kind: string | null
  product_details_json: string | null
}

export interface DashboardBookingNote {
  id: string
  revisionId: string
  body: string
  createdAt: string
}

export interface DashboardBookingDetails {
  id: string
  assignedMemberId: string | null
  assignedMemberName: string | null
  providerConflict: boolean
  providerCalendarStatus: string | null
  /** A future provider occurrence the caller may reassign through Better Auth. */
  canReassignProvider: boolean
  operationalUpdatedAt: string
  operationalBookingId: string
  type: DashboardRecordType
  organizationId: string
  organizationName: string
  vertical: string
  locationId: string | null
  locationSlug: string | null
  locationTitle: string
  resourceTitle: string
  /** Null for a purchase made without an account. */
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  guestImageUrl: string | null
  /** Null for a purchase, which has no party. */
  partySize: number | null
  /** The visit's local day, or the day a purchase was made. */
  bookingDate: string
  /** Null for a purchase. */
  bookingTime: string | null
  timeZone: string
  status: string
  /** Derived, never stored: confirmed and its end has passed. */
  complete: boolean
  requests: string | null
  experienceId: string | null
  /**
   * The session a booking holds seats in. Null for a reservation, which has no
   * occurrence row. A change to a booking names the session it moves to, so the
   * screen has to know which one it is on now.
   */
  sessionId: string | null
  threadId: string | null
  createdAt: string
  updatedAt: string
  policy: RenderedBookingPolicySummary | null
  notes: DashboardBookingNote[]
  /** A change the business proposed that the guest has not answered; Airbnb's "Change requested". */
  pendingChange: { requestId: string; requestedAt: string; afterLabel: string; partySize: number } | null
  locations: Array<{ id: string; title: string; imageUrl: string | null }>
  payments: Array<{payment:PaymentDisplay;refunds:PaymentRefundDisplay[];order:PaymentOrderDisplay|null}> | null
  /** The guest's own self-service cancellation is still open. */
  guestCanCancel: boolean
  /** An interrupted deposit refund can resume the already-recorded guest cancellation. */
  guestCanRetryCancellation: boolean
  /** The business's phone for this booking, as the guest reaches it. */
  contactPhone: string | null
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
): Promise<BookingRow | null> {
  // When, for how many and against what all live on the record the thread
  // refers to — a reservation or a booking — not on the thread. The thread
  // carries the conversation and the guest.
  return queryFirst<BookingRow>(db, `SELECT r.id, record.id AS operational_id, r.organization_id, s.name AS organization_name, s.vertical,
    record.assigned_member_id, record.operational_updated_at, record.policy_json, record.product_kind, record.product_details_json, record.scheduling_mode, record.session_status, record.location_id, l.slug AS location_slug, l.title AS location_title,
    json_extract(r.payload_json, '$.guest.name') AS guest_name, json_extract(r.payload_json, '$.guest.email') AS guest_email, json_extract(r.payload_json, '$.guest.phone') AS guest_phone,
    (SELECT u.image FROM user u WHERE u.id = r.user_id) AS guest_image_url, record.party_size, record.starts_at, record.ends_at, record.timezone, record.status, json_extract(r.payload_json, '$.notes') AS requests,
    record.product_id AS experience_id, record.product_name AS experience_title, record.product_session_id AS session_id,
    r.id AS request_id, json_extract(r.payload_json, '$.cancellation.used_at') AS cancellation_used_at, r.created_at, r.updated_at
    FROM requests r
    JOIN organization s ON s.id = r.organization_id
    JOIN (
      SELECT b.id, b.request_id, b.status, b.party_size, ps.starts_at, ps.ends_at, ps.timezone, ps.location_id, b.product_id, p.name AS product_name, ps.id AS product_session_id, b.assigned_member_id, b.updated_at AS operational_updated_at, NULL AS policy_json, p.kind AS product_kind, p.details_json AS product_details_json, cfg.scheduling_mode, ps.status AS session_status
        FROM bookings b JOIN product_sessions ps ON ps.id = b.product_session_id JOIN products p ON p.id = b.product_id
        LEFT JOIN product_booking_configs cfg ON cfg.product_id = b.product_id AND cfg.organization_id = b.organization_id
      UNION ALL
      SELECT res.id, res.request_id, res.status, res.party_size, res.starts_at, res.ends_at, res.timezone, res.location_id, NULL, NULL, NULL, NULL, res.updated_at, res.policy_json, NULL, NULL, NULL, NULL FROM reservations res
    ) record ON record.request_id = r.id
    LEFT JOIN business_locations l ON l.id = record.location_id
    WHERE r.id = ? AND r.kind = ? AND ${scope.buyerUserId ? `r.user_id = ? AND ${REQUEST_CURRENT_BUYER_SQL}` : 'r.organization_id = ?'}`, [bookingId, type, scope.buyerUserId ?? scope.organizationId])
}

async function assertBookingAccess(context: BookingAccessContext, row: BookingRow) {
  if (row.experience_id) return assertAssignedBookingAccess(context.db, { ...memberAccessPrincipal(context.organization, { env: context.env }), bookingId: row.operational_id })
  await assertResourceAccess(context.db, {
    ...memberAccessPrincipal(context.organization, { env: context.env}),
    resourceLocationId: row.location_id,
  })
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
async function pendingBookingChange(db: DbClient, threadId: string | null): Promise<DashboardBookingDetails['pendingChange']> {
  if (!threadId) return null
  const row = await queryFirst<{ id: string; created_at: string; payload_json: string | null }>(db, `
    SELECT e.id, e.created_at, e.payload_json FROM activity_entries e
     WHERE e.request_id = ? AND e.event_name = 'booking_change.requested'
       AND NOT EXISTS (SELECT 1 FROM activity_entries r WHERE r.request_id = e.request_id
                         AND ((r.event_name IN ('booking_change.accepted', 'booking_change.declined') AND json_extract(r.payload_json, '$.requestId') = e.id)
                           -- A move after the proposal supersedes it: the guest's answer would be refused as stale.
                           OR (r.event_name = 'booking_change.moved' AND r.sequence > e.sequence)))
     ORDER BY e.created_at DESC LIMIT 1`, [threadId])
  if (!row) return null
  const proposal: unknown = JSON.parse(row.payload_json || '{}')
  if (!isRecord(proposal) || typeof proposal.afterLabel !== 'string' || !isRecord(proposal.after) || typeof proposal.after.partySize !== 'number') throw new Error('Booking change proposal has invalid required state')
  return { requestId: row.id, requestedAt: row.created_at, afterLabel: proposal.afterLabel, partySize: proposal.after.partySize }
}

async function listInternalNotes(db: DbClient, threadId: string | null): Promise<DashboardBookingNote[]> {
  if (!threadId) return []
  const rows = await queryAll<{ id: string; revisionId: string; body: string; occurred_at: string }>(db, `
    SELECT note_id AS id, id AS revisionId, body, occurred_at FROM (
      SELECT *, COALESCE(json_extract(payload_json, '$.noteId'), id) AS note_id,
        ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(payload_json, '$.noteId'), id) ORDER BY sequence DESC) AS revision
      FROM activity_entries WHERE request_id = ? AND kind = 'operation'
        AND event_name IN ('internal_note.added', 'internal_note.updated') AND body IS NOT NULL
    ) WHERE revision = 1 ORDER BY sequence DESC
  `, [threadId])
  return rows.map(note => ({ id: note.id, revisionId: note.revisionId, body: note.body, createdAt: note.occurred_at }))
}

export async function loadDashboardBookingDetails(
  event: H3Event,
  input: { type: DashboardRecordType; bookingId: string; organizationSlug?: string | null },
): Promise<DashboardBookingDetails> {
  const context = await bookingContext(event, input.organizationSlug)
  if (input.type === 'order' || input.type === 'payment') {
    if (!await roleAllows({ organizationId: context.organization.id, role: context.organization.role, permissions: { payments: ['read'] } })) throw new HTTPError({ statusCode: 403, message: 'Payments access is required' })
    return composePurchaseDetails(context.db, { organizationId: context.organization.id }, input.bookingId)
  }
  const row = await loadBookingRow(context.db, { organizationId: context.organization.id }, input.type, input.bookingId)
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  await assertBookingAccess(context, row)
  // The provider's busy status is read after the same refresh public
  // availability performs; a failed refresh is stored as its busy_error.
  if (row.assigned_member_id) await refreshMemberBusy(context.db, context.env, row.assigned_member_id)
  const canReadPayments=await roleAllows({organizationId:context.organization.id,role:context.organization.role,permissions:{payments:['read']}})
  const canReassignProvider = input.type === 'booking' && row.scheduling_mode === 'provider' && row.session_status === 'scheduled'
    && ['pending', 'confirmed'].includes(row.status) && row.starts_at > new Date().toISOString() && isOrganizationWideRole(context.organization.role)
    && await roleAllows({ organizationId: context.organization.id, role: context.organization.role, permissions: { members: ['update'] } })
  return composeBookingDetails(context.db, row, input.type, { canReadPayments, canReassignProvider })
}

/**
 * The same record as the account that booked it reads it: ownership is the
 * request's current buyer, the team's private notes and scheduling stay with
 * the team, and the payments are the ones this account made.
 */
export async function loadBuyerBookingDetails(
  db: DbClient,
  userId: string,
  type: DashboardRecordType,
  bookingId: string,
): Promise<DashboardBookingDetails> {
  if (type === 'order' || type === 'payment') return composePurchaseDetails(db, { buyerUserId: userId }, bookingId)
  const row = await loadBookingRow(db, { buyerUserId: userId }, type, bookingId)
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  return composeBookingDetails(db, row, type, { buyerUserId: userId })
}

async function composeBookingDetails(
  db: DbClient,
  row: BookingRow,
  type: DashboardBookingType,
  reader: { canReadPayments: boolean; canReassignProvider: boolean; buyerUserId?: undefined } | { buyerUserId: string; canReadPayments?: undefined; canReassignProvider?: undefined },
): Promise<DashboardBookingDetails> {
  if (row.location_id !== null && !row.location_title) throw new HTTPError({ statusCode: 500, message: 'The booking location is missing its title' })

  const locations = await queryAll<{ id: string; title: string }>(db, 'SELECT id, title FROM business_locations WHERE organization_id = ? ORDER BY title', [row.organization_id])
  const visibleLocations = locations.filter(location => type === 'reservation' || location.id === row.location_id)
  const locationPictures = await loadOwnerPictures(db, row.organization_id, 'business_location', visibleLocations.map(location => location.id))

  let policy = row.policy_json ? JSON.parse(row.policy_json) as BookingPolicySummarySource : null
  let productKind: ProductKind | undefined
  if (type === 'booking') {
    productKind = assertProductKind(row.product_kind)
    policy = productPolicySummarySource(validateProductDetails(productKind, JSON.parse(row.product_details_json!)))
  }
  const [policyLocale, notes, timeZone, contact] = await Promise.all([
    policy ? getSourceLocale(db,row.organization_id) : Promise.resolve(null),
    reader.buyerUserId ? Promise.resolve([]) : listInternalNotes(db, row.request_id),
    Promise.resolve(row.timezone),
    row.location_id
      ? resolveLocationContact(db, row.organization_id, row.location_id)
      : queryFirst<{ contactPhone: string | null }>(db, 'SELECT contact_phone AS contactPhone FROM organization WHERE id = ?', [row.organization_id]),
  ])

  const provider=!reader.buyerUserId&&row.assigned_member_id?await queryFirst<{name:string|null;busy_error:string|null;busy_checked_at:string|null;conflict:number}>(db,`SELECT ${MEMBER_NAME_SQL} name,ms.busy_error,ms.busy_checked_at,EXISTS(SELECT 1 FROM json_each(ms.busy_json) busy WHERE json_extract(busy.value,'$.start')<? AND json_extract(busy.value,'$.end')>?) conflict FROM member m LEFT JOIN user u ON u.id=m.userId LEFT JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE m.id=? AND m.organizationId=?`,[row.ends_at,row.starts_at,row.assigned_member_id,row.organization_id]):null
  const scheduling=!reader.buyerUserId&&row.assigned_member_id ? await readMemberScheduling(db,row.organization_id,row.assigned_member_id) : null
  const paymentIds=reader.buyerUserId
    ?await queryAll<{id:string}>(db,'SELECT id FROM payments WHERE organization_id=? AND subject_type=? AND subject_id=? AND buyer_user_id=? ORDER BY created_at,id',[row.organization_id,type,row.operational_id,reader.buyerUserId])
    :reader.canReadPayments?await queryAll<{id:string}>(db,'SELECT id FROM payments WHERE organization_id=? AND subject_type=? AND subject_id=? ORDER BY created_at,id',[row.organization_id,type,row.operational_id]):[]
  const payments=await Promise.all(paymentIds.map(async ({id})=>{
    const detail=await readPaymentDetails(db,row.organization_id,id)
    return {payment:paymentDisplay(detail.payment),refunds:paymentRefundsDisplay(detail.refunds),order:paymentOrderDisplay(detail.order)}
  }))
  const now = new Date().toISOString()
  const complete = isBookingComplete({ status: row.status as BookingStatus, ends_at: row.ends_at }, now)
  const guestCanRetryCancellation = Boolean(reader.buyerUserId && type === 'reservation' && row.status === 'cancelled' && row.cancellation_used_at
    && await canRetryGuestReservationRefund(db, { organizationId: row.organization_id, reservationId: row.operational_id, requestId: row.id, buyerUserId: reader.buyerUserId }))
  return {
    assignedMemberId: row.assigned_member_id, assignedMemberName:provider?.name??null,providerConflict:Boolean(provider?.conflict),providerCalendarStatus: scheduling?.calendar_ids.length && scheduling.calendar_status !== 'ready' ? scheduling.busy_error || `Busy-calendar status: ${scheduling.calendar_status}` : null,operationalUpdatedAt:row.operational_updated_at,
    canReassignProvider: reader.canReassignProvider === true,
    id: row.id,
    operationalBookingId: row.operational_id,
    type,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    vertical: row.vertical,
    locationId: row.location_id,
    locationSlug: row.location_slug,
    locationTitle: row.location_id === null ? 'Online' : row.location_title!,
    resourceTitle: row.experience_title || (row.location_id === null ? 'Online' : row.location_title!),
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    // The picture is the buyer's own account picture when they booked signed in; an emailed guest has none.
    guestImageUrl: row.guest_image_url,
    partySize: row.party_size,
    // The screen shows a local date and time; the record holds one instant and
    // the zone it belongs to, so these are read off it rather than stored
    // alongside it and kept in step.
    bookingDate: localDateOf(row),
    bookingTime: localTimeOf(row),
    timeZone,
    status: row.status,
    complete,
    requests: row.requests,
    experienceId: row.experience_id,
    sessionId: row.session_id,
    threadId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Products state their current terms; reservations keep their captured location policy.
    policy: policy && policyLocale ? renderBookingPolicySummary(policy, policyLocale, productKind) : null,
    notes,
    pendingChange: await pendingBookingChange(db, row.request_id),
    locations: visibleLocations.map(location => ({ ...location, imageUrl: locationPictures.get(location.id)?.imageUrl ?? null })),
    payments:reader.buyerUserId||reader.canReadPayments?payments:null,
    // The same rule the public cancel route applies, read here so the screen
    // does not offer a cancellation the write would refuse.
    guestCanCancel: ['pending', 'confirmed'].includes(row.status) && row.ends_at > now && !complete && !row.cancellation_used_at,
    guestCanRetryCancellation,
    contactPhone: contact?.contactPhone ?? null,
  }
}

export async function requestDashboardBookingChange(
  event: H3Event,
  input: { type: DashboardBookingType; bookingId: string; body: unknown },
): Promise<DashboardBookingDetails> {
  const context = await bookingContext(event)
  const row = await loadBookingRow(context.db, { organizationId: context.organization.id }, input.type, input.bookingId)
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  await assertBookingAccess(context, row)
  if (!input.body || typeof input.body !== 'object' || !('idempotencyKey' in input.body) || typeof input.body.idempotencyKey !== 'string' || !input.body.idempotencyKey || input.body.idempotencyKey.length > 100) throw new HTTPError({ statusCode: 400, message: 'Request key is required' })
  const threadId = row.id
  const thread = await getGuestRequest(context.db, row.id, row.organization_id, input.type)
  if (!thread) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  if (input.type === 'booking') await assertAssignedBookingAccess(context.db, { ...memberAccessPrincipal(context.organization, { env: context.env }), bookingId: row.operational_id, sessionId: 'sessionId' in input.body && typeof input.body.sessionId === 'string' ? input.body.sessionId : undefined })
  // `apply` moves it now and tells the guest; otherwise the guest is asked first.
  if ('apply' in input.body && input.body.apply === true) await moveBooking(context.db, context.env, thread, { userId: context.userId }, input.body, input.body.idempotencyKey)
  else await requestBookingChange(context.db, context.env, thread, context.userId, input.body, input.body.idempotencyKey)
  await publishGuestInboxThreadEvent(context.env, context.db, { threadId: threadId, type: 'thread.changed' })
  return await loadDashboardBookingDetails(event, { type: input.type, bookingId: row.id })
}

export async function addDashboardBookingNote(
  event: H3Event,
  input: { type: DashboardBookingType; bookingId: string; body: unknown },
): Promise<DashboardBookingDetails> {
  const context = await bookingContext(event)
  const row = await loadBookingRow(context.db, { organizationId: context.organization.id }, input.type, input.bookingId)
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  await assertBookingAccess(context, row)
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    throw new HTTPError({ statusCode: 400, message: 'Note is required' })
  }
  const payload = input.body as Record<string, unknown>
  const note = typeof payload.note === 'string' ? payload.note.trim() : ''
  const idempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.trim() : ''
  if (!note || note.length > 2000) throw new HTTPError({ statusCode: 400, message: 'Note must be between 1 and 2000 characters' })
  if (!idempotencyKey || idempotencyKey.length > 100) throw new HTTPError({ statusCode: 400, message: 'idempotencyKey is required' })

  const threadId = row.id
  const noteId = typeof payload.noteId === 'string' ? payload.noteId : null
  const revisionId = typeof payload.revisionId === 'string' ? payload.revisionId : null
  if (noteId) {
    const original = await getEntryById(context.db, noteId)
    const revision = revisionId ? await getEntryById(context.db, revisionId) : null
    if (!original || original.request_id !== threadId || original.event_name !== 'internal_note.added' || !revision || revision.request_id !== threadId || !['internal_note.added', 'internal_note.updated'].includes(revision.event_name || '') || (revision.id !== noteId && JSON.parse(revision.payload_json || '{}').noteId !== noteId)) throw new HTTPError({ statusCode: 404, message: 'Note not found' })
  }
  await appendEntry(context.db, {
    threadId: threadId,
    kind: 'operation',
    actorKind: 'member',
    actorUserId: context.userId,
    channel: 'system',
    body: note,
    eventName: noteId ? 'internal_note.updated' : 'internal_note.added',
    payloadJson: { private: true, ...(noteId ? { noteId, revisionId, idempotencyKey } : {}) },
    dedupeKey: noteId ? `dashboard-booking-note-revision:${threadId}:${revisionId}` : `dashboard-booking-note:${threadId}:${idempotencyKey}`,
  }).catch((error: unknown) => {
    if (noteId && error instanceof GuestThreadEntryDedupeConflictError) throw new HTTPError({ statusCode: 409, message: 'This note was edited elsewhere. Reload and try again.' })
    throw error
  })
  await publishGuestInboxThreadEvent(context.env, context.db, { threadId: threadId, type: 'thread.changed' })
  return await loadDashboardBookingDetails(event, { type: input.type, bookingId: row.id })
}

export function isDashboardBookingType(value: string | undefined): value is DashboardBookingType {
  return value === 'reservation' || value === 'booking'
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
async function composePurchaseDetails(db: DbClient, scope: BookingScope, paymentId: string): Promise<DashboardBookingDetails> {
  const payment = await queryFirst<{ organization_id: string; buyer_user_id: string | null; location_id: string | null; created_at: string; updated_at: string; organization_name: string; vertical: string; contact_phone: string | null; buyer_name: string | null; buyer_email: string | null; buyer_image: string | null; location_slug: string | null; location_title: string | null }>(db, `
    SELECT p.organization_id, p.buyer_user_id, p.location_id, p.created_at, p.updated_at, s.name AS organization_name, s.vertical, s.contact_phone,
           u.name AS buyer_name, u.email AS buyer_email, u.image AS buyer_image, l.slug AS location_slug, l.title AS location_title
    FROM payments p
    JOIN organization s ON s.id = p.organization_id
    LEFT JOIN user u ON u.id = p.buyer_user_id
    LEFT JOIN business_locations l ON l.id = p.location_id AND l.organization_id = p.organization_id
    WHERE p.id = ? AND ${scope.buyerUserId ? 'p.buyer_user_id = ?' : 'p.organization_id = ?'}`, [paymentId, scope.buyerUserId ?? scope.organizationId])
  if (!payment) throw new HTTPError({ statusCode: 404, message: 'Purchase not found' })
  const detail = await readPaymentDetails(db, payment.organization_id, paymentId)
  const snapshot: unknown = JSON.parse(detail.payment.price_snapshot_json)
  if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error('Purchase has no immutable title')
  const contact = payment.location_id ? await resolveLocationContact(db, payment.organization_id, payment.location_id) : { contactPhone: payment.contact_phone }
  return {
    assignedMemberId: null, assignedMemberName: null, providerConflict: false, providerCalendarStatus: null, operationalUpdatedAt: payment.updated_at,
    canReassignProvider: false,
    id: paymentId,
    operationalBookingId: detail.order?.id ?? paymentId,
    type: detail.order ? 'order' : 'payment',
    organizationId: payment.organization_id,
    organizationName: payment.organization_name,
    vertical: payment.vertical,
    locationId: payment.location_id,
    locationSlug: payment.location_slug,
    locationTitle: payment.location_id === null ? 'Online' : payment.location_title ?? 'Online',
    resourceTitle: snapshot.title,
    guestName: payment.buyer_name,
    guestEmail: payment.buyer_email,
    guestPhone: null,
    guestImageUrl: payment.buyer_image,
    partySize: null,
    bookingDate: localDateOf({ starts_at: payment.created_at, timezone: 'UTC' }),
    bookingTime: null,
    timeZone: 'UTC',
    status: detail.payment.state,
    complete: true,
    requests: null,
    experienceId: null,
    sessionId: null,
    threadId: null,
    createdAt: payment.created_at,
    updatedAt: payment.updated_at,
    policy: null,
    notes: [],
    pendingChange: null,
    locations: [],
    payments: [{ payment: paymentDisplay(detail.payment), refunds: paymentRefundsDisplay(detail.refunds), order: paymentOrderDisplay(detail.order) }],
    guestCanCancel: false,
    guestCanRetryCancellation: false,
    contactPhone: contact?.contactPhone ?? null,
  }
}
