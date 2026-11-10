import { openingMessageQueries } from '~/server/domain/guest-threads/opening'
import { z } from 'zod'
import { HTTPError } from 'nitro'
import { guestVisitRefundQueries, guestVisitRefundKey } from '~/server/domain/payments/visit-refund'
import { executeRefund, requirePayment } from '~/server/domain/payments'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import type { CloudflareEnv } from '~/server/utils/auth'
import { recordBookingCancelled } from '~/server/domain/booking-analytics'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { isValidInstant, isValidTimezone, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { noticeDuration, outsideNotice } from '~/shared/availability-settings'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { formAnswerSnapshotsSchema } from '~/shared/form-questions'
import type { ProductKind } from '~/shared/product-details'

/**
 * The inbox.
 *
 * A request is one conversation thread with a guest and its workflow state.
 * It is NOT the booking: the booked record is a `bookings` row of any kind (a
 * class, a consultation, a table or a stay at a home), which links back here
 * through `request_id`. Every booking has its conversation.
 *
 * A contact thread has none and is not forced into the booking model.
 */

const guest = z.object({ name: z.string(), email: z.string(), phone: z.string().nullable(), locale: z.string().optional() })
const cancellation = z.object({ token_hash: z.string().nullable(), expires_at: z.string().nullable(), used_at: z.string().nullable() })

/**
 * What a booking's thread itself owns.
 *
 * `guest` is how the guest gave their contact for this booking: a site or
 * operator booking always has an email; a stay the host entered may have only a
 * phone, and one imported from elsewhere may have only a name. A channel's
 * conversation (`participant`) is titled by its channel and may name no one.
 * A channel booking that names no guest opens its own conversation with a `participant` and no `channel_threads` row.
 * `cancellation` is the emailed self-service token: the thread's capability,
 * not the booking's state. Whether the booking is cancelled is
 * `bookings.status`; `used_at` only records that this token was spent.
 */
const threadPayload = z.object({
  provenance: z.object({ source: z.string(), external_reference: z.string().nullable(), actor_user_id: z.string().nullable(), idempotency_key: z.string(), fingerprint: z.string(), guest_acknowledgement: z.boolean(), creation_kind: z.enum(['ordinary', 'checkout']), creation_status: z.enum(['pending', 'confirmed']), followups_completed: z.boolean() }).optional(),
  guest: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), locale: z.string().optional() }),
  participant: z.object({ kind: z.literal('channel'), title: z.string().trim().min(1) }).strict().optional(),
  notes: z.string().nullable(),
  ip_hash: z.string().nullable(),
  cancellation,
}).refine(payload => payload.participant !== undefined || payload.guest.name !== null, 'A booking conversation names its guest or its channel')

const threadScope = z.object({
  id: z.string(), organization_id: z.string(),  location_id: z.string().nullable(),
  user_id: z.string().nullable(), review_id: z.string().nullable(),
  archived_at: z.string().nullable(), archived_by_user_id: z.string().nullable(), blocked_at: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
})

export const guestRequestSchema = z.discriminatedUnion('kind', [
  threadScope.extend({ kind: z.literal('contact'), payload: z.object({
    guest, subject: z.string().nullable(), message: z.string(), consent_at: z.string().nullable(), ip_hash: z.string().nullable(),
    // Where the message came from, when a form or ChatGPT escalation says so.
    source: z.string().nullable().optional(), route_context: z.string().nullable().optional(),
    suggested_summary: z.string().nullable().optional(), agent_metadata: z.unknown().optional(),
    // Answers to the organization's inquiry questions; a message may be empty when they say it all.
    answers: formAnswerSnapshotsSchema.default([]),
    // A keyed submission's replay record: the same key and details return this thread.
    submission: z.object({ idempotency_key: z.string(), fingerprint: z.string(), actor_user_id: z.string().nullable(), source: z.string(), followups_completed: z.boolean() }).optional(),
  }) }),
  threadScope.extend({ kind: z.literal('booking'), payload: threadPayload }),
])
export type GuestRequest = z.infer<typeof guestRequestSchema>
export type BookingRequest = Extract<GuestRequest, { kind: 'booking' }>
export type GuestRequestKind = GuestRequest['kind']
export type ThreadPayload = z.infer<typeof threadPayload>

/** The authenticated business operation that created a guest commitment. */
export interface BookingOperator {
  userId: string
  idempotencyKey: string
  source: string
  externalReference: string | null
  guestAcknowledgement: boolean
}

/**
 * The booking a thread links to, when it has one.
 *
 * `unit` is what it holds: a session's seats ('slot') or a home's nights
 * ('nights'). Its starts_at/ends_at are instants, except that a nights booking
 * at a home with no check-in or checkout time stores that end's local day
 * (YYYY-MM-DD) alone; bookedRecordWindow reads both.
 */
export interface ThreadOperationalRecord {
  assigned_member_id: string | null
  unit: 'slot' | 'nights'
  id: string
  status: BookingStatus
  party_size: number
  /** The guest said "this many or more". */
  party_size_is_minimum: boolean
  starts_at: string
  ends_at: string
  timezone: string
  location_id: string | null
  product_id: string
  /** What was booked: an experience, a consultation, a table, or a stay's home. */
  product_kind: ProductKind
  product_name: string
  product_internal_name: string | null
  organization_id: string
  user_id: string | null
  /** Staff recorded the guest did not come. */
  no_show_at: string | null
  /** The review the thread's guest submitted, if any. */
  review_id: string | null
  /** The advance notice the booking was made under (its frozen policy), which closes the guest's own cancellation; null for no notice. */
  advance_notice_minutes: number | null
}

/** Whether a stored booking end is a local day alone (its home had no time for it). */
export function isBookingDay(value: string): boolean {
  return value.length === 10
}

/** The local day a stored booking end falls on, in the booking's timezone. */
export function bookingDay(value: string, timezone: string): string {
  return isBookingDay(value) ? value : localDateAt(new Date(value), timezone)
}

/**
 * A nights booking's stored end: the day at the home's time when the home has
 * one (or the arrival time the host recorded), else the day alone.
 */
export function nightsBoundary(date: string, time: string | null, timezone: string): string {
  return time === null ? date : localDateTimeToInstant(date, time, timezone, 'earlier').toISOString()
}

/** A booking's end as an instant to compare, as BOOKING_ENDS_SQL says it to the database. */
export function bookingEndsInstant(value: string): string {
  return isBookingDay(value) ? `${new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T12:00:00.000Z` : value
}

/** A booking's end as an instant SQL can compare, an end stored as a day reads as that day's last possible moment anywhere. */
export const BOOKING_ENDS_SQL = (alias: string) => `CASE WHEN length(${alias}.ends_at) = 10 THEN date(${alias}.ends_at, '+1 day') || 'T12:00:00.000Z' ELSE ${alias}.ends_at END`
/** A booking's start as an instant SQL can compare, a start stored as a day reads as that day's first possible moment anywhere. */
export const BOOKING_STARTS_SQL = (alias: string) => `CASE WHEN length(${alias}.starts_at) = 10 THEN date(${alias}.starts_at, '-1 day') || 'T10:00:00.000Z' ELSE ${alias}.starts_at END`

export function parseGuestRequest(row: Record<string, unknown>): GuestRequest {
  if (typeof row.payload_json !== 'string') throw new Error('Request payload is missing')
  return guestRequestSchema.parse({ ...row, payload: JSON.parse(row.payload_json) })
}

/** A provider's conversation title is a label, never a replacement guest identity. */
export function participantLabel(request: GuestRequest): string {
  if (request.kind === 'booking' && request.payload.participant) return request.payload.participant.title
  if (request.payload.guest.name === null) throw new HTTPError({ statusCode: 500, message: 'A contact participant requires its recorded guest name', data: { code: 'REQUEST_PARTICIPANT_INVALID', field: 'guest.name' } })
  return request.payload.guest.name
}

/** Resource ownership belongs to the current request and the booking linked to it. */
export const REQUEST_CURRENT_BUYER_SQL = `r.user_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.request_id=r.id AND (b.user_id IS NULL OR b.user_id<>r.user_id OR b.organization_id<>r.organization_id OR r.kind<>'booking'))`

export async function getGuestRequest(db: DbClient, id: string, organizationId?: string, kind?: GuestRequestKind, buyerUserId?:string): Promise<GuestRequest | null> {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT r.* FROM requests r WHERE r.id = ? AND r.kind IN ('contact', 'booking')${organizationId ? ' AND r.organization_id = ?' : ''}${kind ? ' AND r.kind = ?' : ''}${buyerUserId?` AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL}`:''}`, [id, ...(organizationId ? [organizationId] : []), ...(kind ? [kind] : []),...(buyerUserId?[buyerUserId]:[])])
  if (!row) return null
  const request = parseGuestRequest(row)
  if (request.kind === 'booking' && request.payload.participant) {
    const mapped = await queryFirst(db, `SELECT ct.request_id FROM channel_threads ct
      JOIN product_stay_configs c ON c.organization_id = ct.organization_id AND c.product_id = ct.product_id
      WHERE ct.request_id = ? AND ct.organization_id = ? AND c.location_id = ?`, [request.id, request.organization_id, request.location_id])
    if (!mapped) throw new HTTPError({ statusCode: 500, message: 'Channel conversation has no matching home mapping', data: { code: 'CHANNEL_THREAD_MAPPING_INVALID', field: 'request_id' } })
  }
  return request
}

/**
 * Every booking with what it booked, one row each: its product, who handles
 * it, its unit, and a fingerprint of every fact a plan made from it depends
 * on, for guarded writes. offering_id is the product a business offers.
 */
export const BOOKING_RECORDS_SQL = `(
    SELECT b.id, b.request_id, b.organization_id, b.status, b.party_size, b.party_size_is_minimum, b.starts_at, b.ends_at, b.timezone,
           b.location_id, b.product_id, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit,
           p.kind AS product_kind, b.product_id AS offering_id, p.name AS product_name, sc.internal_name AS product_internal_name, c.assigned_member_id, b.user_id,
           b.no_show_at, b.created_at, b.received_at, b.updated_at, b.version,
           json_extract(b.policy_json, '$.advance_notice_minutes') AS advance_notice_minutes,
           json_array(b.version, b.status, b.request_id, b.product_id, b.product_session_id, b.starts_at, b.ends_at, b.timezone, b.updated_at) AS fingerprint
      FROM bookings b
      JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      LEFT JOIN product_booking_configs c ON c.product_id = b.product_id AND c.organization_id = b.organization_id
      LEFT JOIN product_stay_configs sc ON sc.product_id = b.product_id AND sc.organization_id = b.organization_id
  )`

/** One row of BOOKING_RECORDS_SQL. received_at is null for a booking imported or known before KrabiClaw received it. */
export interface BookedRecord extends Omit<ThreadOperationalRecord, 'review_id'> {
  request_id: string | null
  offering_id: string
  created_at: string
  received_at: string | null
  updated_at: string
  version: number
  fingerprint: string
}

/**
 * When a booking starts and ends, as its own clock reads it: each end's local
 * day, and its instant when one is stored (a nights booking at a home with no
 * check-in or checkout time has the day alone).
 */
export function bookedRecordWindow(record: Pick<BookedRecord, 'id' | 'timezone' | 'starts_at' | 'ends_at'>):
  { start: { date: string; instant: string | null }; end: { date: string; instant: string | null } } {
  if (!isValidTimezone(record.timezone) || /^[+-]/.test(record.timezone)) throw new HTTPError({ statusCode: 500, message: `The booking ${record.id} has no IANA timezone`, data: { code: 'INVALID_HOME_TIMEZONE', field: 'timezone' } })
  const at = (value: string) => {
    if (isBookingDay(value)) return { date: value, instant: null }
    if (!isValidInstant(value)) throw new HTTPError({ statusCode: 500, message: `The booking ${record.id} has an invalid start or end time`, data: { code: 'INVALID_BOOKING_TIME', field: 'startsAt' } })
    return { date: localDateAt(new Date(value), record.timezone), instant: value }
  }
  return { start: at(record.starts_at), end: at(record.ends_at) }
}

export async function readBookedRecord(db: DbClient, organizationId: string, id: string): Promise<BookedRecord | null> {
  return await queryFirst<BookedRecord>(db, `SELECT br.* FROM ${BOOKING_RECORDS_SQL} br WHERE br.organization_id = ? AND br.id = ?`, [organizationId, id]) ?? null
}

/** The record still has every fact a plan was made from. */
export function bookedRecordGuard(record: Pick<BookedRecord, 'organization_id' | 'id' | 'fingerprint'>): { query: string; params: unknown[] } {
  return { query: `EXISTS (SELECT 1 FROM ${BOOKING_RECORDS_SQL} br WHERE br.organization_id = ? AND br.id = ? AND br.fingerprint = ?)`, params: [record.organization_id, record.id, record.fingerprint] }
}

export async function getThreadOperationalRecord(db: DbClient, requestId: string): Promise<ThreadOperationalRecord | null> {
  const record = await queryFirst<Omit<ThreadOperationalRecord, 'party_size_is_minimum'> & { party_size_is_minimum: number }>(db, `
    SELECT br.unit, br.id, br.status, br.party_size, br.party_size_is_minimum, br.starts_at, br.ends_at, br.timezone, br.location_id, br.product_id, br.product_kind, br.product_name, br.product_internal_name,
           br.assigned_member_id, br.organization_id, br.user_id, br.no_show_at, owner.review_id, br.advance_notice_minutes
      FROM ${BOOKING_RECORDS_SQL} br
      JOIN requests owner ON owner.id = br.request_id AND owner.kind = 'booking' AND owner.organization_id = br.organization_id
     WHERE br.request_id = ?
     LIMIT 1
  `, [requestId])
  if (record) return { ...record, party_size_is_minimum: Number(record.party_size_is_minimum) === 1 }
  const request = await queryFirst<{ kind: GuestRequestKind; uncaptured_checkout: number | null }>(db, `
    SELECT r.kind,
      (json_extract(r.payload_json, '$.provenance.creation_kind') = 'checkout'
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = r.id)
       AND EXISTS (
         SELECT 1 FROM payment_checkout_holds h
         JOIN payments p ON p.id = h.payment_id AND p.organization_id = h.organization_id AND p.subject_type = 'booking'
         WHERE h.request_id = r.id AND h.organization_id = r.organization_id
           AND h.status IN ('active', 'released') AND h.converted_booking_id IS NULL
           AND p.captured_amount = 0 AND p.subject_id IS NULL
           AND p.idempotency_key = 'checkout:' || r.organization_id || ':' || json_extract(r.payload_json, '$.provenance.idempotency_key')
       )) AS uncaptured_checkout
    FROM requests r WHERE r.id = ?
  `, [requestId])
  if (request?.uncaptured_checkout === 1) return null
  // A channel's conversation before its guest booked (an Airbnb inquiry) has no booking yet.
  if (request?.kind === 'booking' && await queryFirst(db, 'SELECT request_id FROM channel_threads WHERE request_id = ?', [requestId])) return null
  if (request && request.kind !== 'contact') throw new HTTPError({ statusCode: 404, message: 'The conversation has no matching booking', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: requestId } })
  return null
}

/**
 * The thread and the activity entry that opens it.
 *
 * `claimedBy` is the row whose existence this thread depends on — the booking
 * written earlier in the same batch. A conditional claim that
 * finds no room inserts zero rows WITHOUT raising, so a thread written before
 * it would commit anyway and leave a conversation about a seat nobody holds.
 * Carrying the claim's existence into this insert is what ties them together.
 *
 * A new thread has not been archived or blocked by anyone, so it carries neither state.
 */
/**
 * A guest thread and its submission, and, for a booking, the
 * messages that open its conversation: the booking's own sentence (`opening`,
 * from `openingSentence`) and the guest's note.
 */
export function requestInsertQueries(request: Omit<GuestRequest, 'archived_at' | 'archived_by_user_id' | 'blocked_at'>, claimedBy?: BatchQuery, opening?: { body: string }): BatchQuery[] {
  const provenance = request.kind === 'booking' && 'provenance' in request.payload ? request.payload.provenance : undefined
  const values = [request.id, request.kind, request.organization_id, request.location_id, request.user_id, request.review_id,
    JSON.stringify(request.payload), request.created_at, request.updated_at]
  return [{
    query: claimedBy
      ? `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, payload_json, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${claimedBy.query})`
      : `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: claimedBy ? [...values, ...(claimedBy.params ?? [])] : values,
  }, {
    query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, id, 'submission', 'request', ?, ?, ?, json_object('kind', kind), ?, 1, created_at, created_at FROM requests WHERE id = ? AND changes() = 1`,
    params: [crypto.randomUUID(), provenance?.actor_user_id ? 'member' : 'guest', provenance?.actor_user_id ?? request.user_id, provenance?.actor_user_id ? 'system' : 'web', `request:${request.id}:submission`, request.id],
  }, ...(opening ? openingMessageQueries({ target: { requestId: request.id }, body: opening.body, note: 'notes' in request.payload ? request.payload.notes : null, guestUserId: request.user_id, at: request.created_at }) : []),
  publicResourceCacheInvalidationQuery(request.organization_id, 'guest-thread-create')]
}

/**
 * A booking's conversation, written in the booking's own batch and only where
 * the booking landed (`claimedBy`): every booking has one. The host who took
 * it, the channel it came from, or the guest who booked it opens it. Its guest
 * contact is what the booking was made with; the conversation belongs to the
 * booking's guest account.
 */
export function bookingConversationQueries(input: {
  organizationId: string; bookingId: string; requestId: string; locationId: string | null; userId: string; now: string
  guest: { name: string | null; email: string | null; phone: string | null }
  participant?: { kind: 'channel'; title: string }
  openedBy: { userId: string } | 'channel' | 'guest'
}): BatchQuery[] {
  const host = typeof input.openedBy === 'object' ? input.openedBy.userId : null
  const payload: ThreadPayload = { guest: input.guest, ...(input.participant ? { participant: input.participant } : {}), notes: null, ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }
  threadPayload.parse(payload)
  return [{
    query: `INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, payload_json, created_at, updated_at)
      SELECT ?, 'booking', ?, ?, ?, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ? AND request_id IS NULL)`,
    params: [input.requestId, input.organizationId, input.locationId, input.userId, JSON.stringify(payload), input.now, input.now, input.organizationId, input.bookingId],
  }, {
    query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, id, 'submission', 'request', ?, ?, 'system', json_object('kind', kind, 'booking_id', ?), ?, 1, created_at, created_at FROM requests WHERE id = ? AND changes() = 1`,
    params: [crypto.randomUUID(), host ? 'member' : input.openedBy === 'guest' ? 'guest' : 'system', host, input.bookingId, `request:${input.requestId}:submission`, input.requestId],
  }, {
    query: 'UPDATE bookings SET request_id = ? WHERE id = ? AND organization_id = ? AND request_id IS NULL AND EXISTS (SELECT 1 FROM requests WHERE id = ?)',
    params: [input.requestId, input.bookingId, input.organizationId, input.requestId],
  }, publicResourceCacheInvalidationQuery(input.organizationId, 'guest-thread-create')]
}

/**
 * The guest contact a host or a channel revision gave a booking, on its
 * conversation, and the place it is at. Guarded by the version and the
 * updated_at the same batch's write gave the booking: a write that lost its
 * race left neither, so its contact changes nothing (the version alone is the
 * winner's too). A channel's conversation keeps its participant title as history.
 */
export function bookingContactQuery(input: { organizationId: string; bookingId: string; version: number; updatedAt: string; locationId: string | null; guest: { name: string | null; email: string | null; phone: string | null } }): BatchQuery {
  return {
    query: `UPDATE requests SET location_id = ?, payload_json = json_set(payload_json, '$.guest.name', ?, '$.guest.email', ?, '$.guest.phone', ?)
      WHERE kind = 'booking' AND (json_type(payload_json, '$.participant') IS 'object' OR ? IS NOT NULL)
        AND id = (SELECT request_id FROM bookings WHERE organization_id = ? AND id = ? AND version = ? AND updated_at = ?)`,
    params: [input.locationId, input.guest.name, input.guest.email, input.guest.phone, input.guest.name, input.organizationId, input.bookingId, input.version, input.updatedAt],
  }
}

interface GuestThreadInput { name: string; email: string; phone?: string | null; locale?: string; notes?: string | null; ipHash?: string | null }
/** A site or operator booking's thread: its guest gave a name and an email. */
export type GuestThreadPayload = ThreadPayload & { guest: { name: string; email: string } }
export function threadPayloadForGuest(input: GuestThreadInput): GuestThreadPayload {
  return {
    guest: { name: input.name, email: input.email, phone: input.phone ?? null, ...(input.locale === undefined ? {} : { locale: input.locale }) },
    notes: input.notes ?? null, ip_hash: input.ipHash ?? null,
    cancellation: { token_hash: null, expires_at: null, used_at: null },
  }
}

/**
 * What a tenant can still do. Nothing is approved and nothing is marked done:
 * a booking arrives confirmed, and one whose end has passed is complete
 * because the clock says so.
 */
export function requestActions(record: ThreadOperationalRecord | null, now: string): string[] {
  const noShow = canMarkNoShow(record, now) ? ['no_show'] : []
  // A stay is changed and cancelled from its own screen; its thread is the conversation.
  if (record?.unit === 'nights' || !canCancelBookingRequest(record, now)) return noShow
  return [...(record.status === 'pending' ? ['confirm', 'reject', 'change', 'cancel'] : ['change', 'cancel']), ...noShow]
}

/**
 * A confirmed visit that has begun can be recorded as a no-show, until the
 * guest has reviewed it. It is the one thing that stops a visit's review
 * invitation without cancelling the visit.
 */
export function canMarkNoShow(record: ThreadOperationalRecord | null, now: string): record is ThreadOperationalRecord {
  return Boolean(record && record.status === 'confirmed' && record.no_show_at === null && record.review_id === null && record.starts_at <= now)
}

export function canCancelBookingRequest(record: ThreadOperationalRecord | null, now: string): record is ThreadOperationalRecord {
  return Boolean(record && ['pending', 'confirmed'].includes(record.status) && record.ends_at > now && !isBookingComplete(record, now))
}

/** A stay's nights and party, in the stay's own dates: "Mar 3 – Mar 6 · 2 guests". */
export function stayPreview(record: { starts_at: string; ends_at: string; timezone: string; party_size: number }): string {
  const day = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${bookingDay(value, record.timezone)}T00:00:00Z`))
  return `${day(record.starts_at)} – ${day(record.ends_at)} · ${record.party_size} ${record.party_size === 1 ? 'guest' : 'guests'}`
}

export async function requestSummary(db: DbClient, request: GuestRequest, knownRecord?: ThreadOperationalRecord | null) {
  const record = knownRecord === undefined ? await getThreadOperationalRecord(db, request.id) : knownRecord
  // A thread without a location belongs to the business itself; one with a location must find it.
  const location = request.location_id === null ? null
    : await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [request.location_id, request.organization_id])
  if (request.location_id !== null && !location) throw new HTTPError({ statusCode: 500, message: 'The conversation location does not exist', data: { code: 'INVALID_GUEST_THREAD', field: 'location_id', request_id: request.id } })
  return {
    guestName: request.payload.guest.name, participantLabel: participantLabel(request), guestEmail: request.payload.guest.email, guestPhone: request.payload.guest.phone,
    organizationId: request.organization_id, locationId: request.location_id,
    locationTitle: location?.title ?? null, productTitle: record?.product_name ?? null,
    createdAt: request.created_at,
    operationalStatus: record?.status ?? null,
  }
}

/**
 * Spend a guest's cancellation token and cancel what it refers to.
 *
 * Two writes, one batch: the token is marked used on the thread and the
 * booking moves to cancelled. Cancelling the operational
 * record is what releases the seats — the thread holds none.
 */
export async function cancelBookingRequest(db: DbClient, input: {
  id: string; organizationId: string; kind: BookingRequest['kind']; now: string; env: CloudflareEnv
} & ({ tokenHash: string; buyerUserId?: never } | { buyerUserId: string; tokenHash?: never })): Promise<{ request: BookingRequest; record: ThreadOperationalRecord; wasConfirmed: boolean; changed: boolean } | null> {
  const current = await getGuestRequest(db, input.id, input.organizationId, input.kind)
  if (!current || current.kind === 'contact') return null
  const record = await getThreadOperationalRecord(db, current.id)
  if (!record || record.organization_id !== input.organizationId || record.unit !== 'slot') return null
  if (input.buyerUserId && (current.user_id !== input.buyerUserId || record.user_id !== input.buyerUserId)) return null
  async function readCancelled(changed = false) {
    const request = await getGuestRequest(db, input.id, input.organizationId, input.kind)
    const cancelled = await getThreadOperationalRecord(db, input.id)
    if (!request || request.kind === 'contact' || !request.payload.cancellation.used_at || !cancelled || cancelled.status !== 'cancelled' || cancelled.organization_id !== input.organizationId) return null
    if (input.buyerUserId ? request.user_id !== input.buyerUserId || cancelled.user_id !== input.buyerUserId
      : request.payload.cancellation.token_hash !== input.tokenHash || !request.payload.cancellation.expires_at || request.payload.cancellation.expires_at <= input.now) return null
    const entry = await queryFirst<{ payload_json: string }>(db, 'SELECT payload_json FROM activity_entries WHERE request_id = ? AND dedupe_key = ?', [input.id, `booking:${cancelled.id}:guest-cancel`])
    if (!entry) return null
    const before = JSON.parse(entry.payload_json).beforeStatus
    if (!['pending', 'confirmed'].includes(before)) throw new Error('Cancellation audit has no valid prior status')
    await recordBookingCancelled(db, { organizationId: input.organizationId, bookingId: cancelled.id, cancelledBy: 'guest', actorUserId: input.buyerUserId ?? null })
    // A cancelled visit sends none of its pending automatic messages.
    await (await import('~/server/domain/scheduled-guest-messages')).planSourceMessages(db, input.organizationId, cancelled.id)
    const refund = await queryFirst<{ payment_id: string; idempotency_key: string }>(db, `SELECT r.payment_id,r.idempotency_key FROM payment_refunds r
      JOIN payments p ON p.id=r.payment_id WHERE p.organization_id=? AND p.subject_type='booking' AND p.subject_id=? AND r.idempotency_key=?`, [input.organizationId, cancelled.id, guestVisitRefundKey(cancelled.id)])
    if (refund) {
      const payment = await requirePayment(db, input.organizationId, refund.payment_id)
      await executeRefund(db, paymentsStripe(input.env, Boolean(payment.livemode)), payment, null, refund.idempotency_key, 'requested_by_customer', input.buyerUserId ?? null, input.env)
    }
    return { request, record: cancelled, wasConfirmed: before === 'confirmed', changed }
  }
  if (record.status === 'cancelled') return await readCancelled()
  if (!canCancelBookingRequest(record, input.now)) return null
  // The offering's advance notice closes the guest's own cancellation as it closes booking; the business can still cancel.
  if (record.advance_notice_minutes !== null && !outsideNotice(record.starts_at, record.advance_notice_minutes, Date.parse(input.now))) {
    throw new HTTPError({ statusCode: 409, message: `Online cancellation closed ${noticeDuration(record.advance_notice_minutes, 'en')} before the start. Contact the business to cancel.`, data: { code: 'cancellation_closed' } })
  }

  // Two writes, one batch, each carrying the other's condition: the token is
  // spent only while the record is still cancellable, and the record is
  // cancelled only where the token was spent. Separately, a record whose status
  // moved in between left the guest with a consumed token and a live booking
  // still holding its seats.
  const refund = await guestVisitRefundQueries(db, {
    organizationId: input.organizationId, bookingId: record.id, requestId: input.id, startsAt: record.starts_at, advanceNoticeMinutes: record.advance_notice_minutes, now: input.now, buyerUserId: input.buyerUserId,
  })
  const [consumed, released] = await executeBatch(db, [
    {
      query: `UPDATE requests SET
          payload_json = json_set(payload_json, '$.cancellation.used_at', ?), updated_at = ?
        WHERE id = ? AND organization_id = ? AND kind = ?
          AND ${input.buyerUserId ? 'user_id = ?' : "json_extract(payload_json, '$.cancellation.token_hash') = ? AND json_extract(payload_json, '$.cancellation.expires_at') > ?"}
          AND json_extract(payload_json, '$.cancellation.used_at') IS NULL AND (${refund.guard?.query ?? '1=1'})
          AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND organization_id = ? AND request_id = ? AND status = ?${input.buyerUserId ? ' AND user_id = ?' : ''}) RETURNING *`,
      params: [input.now, input.now, input.id, input.organizationId, input.kind, ...(input.buyerUserId ? [input.buyerUserId] : [input.tokenHash, input.now]), ...(refund.guard?.params ?? []), record.id, input.organizationId, input.id, record.status, ...(input.buyerUserId ? [input.buyerUserId] : [])],
    },
    {
      query: `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancellation_reason = 'guest_cancelled', version = version + 1, updated_at = ?
        WHERE id = ? AND organization_id = ? AND request_id = ? AND status = ?${input.buyerUserId ? ' AND user_id = ?' : ''}
          AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND organization_id = ?
            AND json_extract(payload_json, '$.cancellation.used_at') = ?)`,
      params: [input.now, input.now, record.id, input.organizationId, input.id, record.status, ...(input.buyerUserId ? [input.buyerUserId] : []), input.id, input.organizationId, input.now],
    },
    {
      query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
        SELECT ?, ?, 'operation', 'request', 'guest', ?, ?, ?,
          COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = ?), 0) + 1, ?, ?
        WHERE changes() = 1`,
      params: [crypto.randomUUID(), input.id, 'booking.cancel', JSON.stringify({ action: 'cancel', beforeStatus: record.status, afterStatus: 'cancelled', operational_booking_id: record.id, request_id: input.id, ...(input.buyerUserId ? { actor_user_id: input.buyerUserId } : {}) }), `booking:${record.id}:guest-cancel`, input.id, input.now, input.now],
    },
    ...refund.queries,
    ...(await import('~/server/domain/guest-threads/repository')).conversationTaskQueries(input.id, input.now),
  ], { operation: 'Cancel booking request' })

  const row = (consumed?.results?.[0] ?? null) as Record<string, unknown> | null
  if (!row) return await readCancelled()
  if ((released?.meta?.changes ?? 0) !== 1) throw new Error('Cancellation consumed the token without releasing the booking')

  return await readCancelled(true)
}
