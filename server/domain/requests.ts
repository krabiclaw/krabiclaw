import { openingMessageQueries } from '~/server/domain/guest-threads/opening'
import { bookingStatusQuery } from '~/server/domain/bookings'
import { CURRENT_GUEST_SQL, SUBMISSION_EVENT, messageQueries, type ConversationRow } from '~/server/domain/conversations'
import { z } from 'zod'
import { HTTPError } from 'nitro'
import { guestVisitRefundQueries, guestVisitRefundKey } from '~/server/domain/payments/visit-refund'
import { executeRefund, requirePayment } from '~/server/domain/payments'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import { ownedBuyerRequest } from '~/server/domain/payments/buyer'
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
 * A guest's conversation with the business (`conversations` of kind contact
 * or booking; server/domain/conversations.ts holds what every conversation
 * shares). It is NOT the booking: the booked record is a `bookings` row of any
 * kind (a class, a consultation, a table or a stay at a home), which the
 * conversation names in `booking_id`. Every booking has its conversation.
 *
 * A contact conversation has none and is not forced into the booking model.
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
  // The dates a channel's guest asked about before booking (an Airbnb inquiry), as the channel's live feed gave them.
  inquiry: z.object({ live_feed_event_id: z.string(), check_in_date: z.string(), check_out_date: z.string() }).passthrough().optional(),
  ip_hash: z.string().nullable(),
  cancellation,
}).refine(payload => payload.participant !== undefined || payload.guest.name !== null, 'A booking conversation names its guest or its channel')

const threadScope = z.object({
  id: z.string(), organization_id: z.string(),  location_id: z.string().nullable(), booking_id: z.string().nullable(),
  user_id: z.string().nullable(), blocked_at: z.string().nullable(),
  created_at: z.string(), last_message_at: z.string(),
})

export const guestRequestSchema = z.discriminatedUnion('kind', [
  threadScope.extend({ kind: z.literal('contact'), payload: z.object({
    // The guest's words are their first message in the conversation, not a copy here.
    guest, subject: z.string().nullable(), consent_at: z.string().nullable(), ip_hash: z.string().nullable(),
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
  version: number
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

export function parseGuestRequest(row: Record<string, unknown> | ConversationRow): GuestRequest {
  if (typeof row.payload_json !== 'string') throw new Error('Request payload is missing')
  return guestRequestSchema.parse({ ...row, payload: JSON.parse(row.payload_json) })
}

/** A provider's conversation title is a label, never a replacement guest identity. */
export function participantLabel(request: GuestRequest): string {
  if (request.kind === 'booking' && request.payload.participant) return request.payload.participant.title
  if (request.payload.guest.name === null) throw new HTTPError({ statusCode: 500, message: 'A contact participant requires its recorded guest name', data: { code: 'REQUEST_PARTICIPANT_INVALID', field: 'guest.name' } })
  return request.payload.guest.name
}

export async function getGuestRequest(db: DbClient, id: string, organizationId?: string, kind?: GuestRequestKind, buyerUserId?:string): Promise<GuestRequest | null> {
  const row = await queryFirst<Record<string, unknown>>(db, `SELECT r.* FROM conversations r WHERE r.id = ? AND r.kind IN ('contact', 'booking')${organizationId ? ' AND r.organization_id = ?' : ''}${kind ? ' AND r.kind = ?' : ''}${buyerUserId?` AND r.user_id=? AND ${CURRENT_GUEST_SQL('r')}`:''}`, [id, ...(organizationId ? [organizationId] : []), ...(kind ? [kind] : []),...(buyerUserId?[buyerUserId]:[])])
  return row ? validateGuestRequest(db, row) : null
}

/** Parse the conversation row already returned by a scoped read and validate its channel association. */
export async function validateGuestRequest(db: DbClient, row: Record<string, unknown> | ConversationRow): Promise<GuestRequest> {
  const request = parseGuestRequest(row)
  if (request.kind === 'booking' && request.payload.participant) {
    const mapped = await queryFirst(db, `SELECT 1 FROM conversations r
      LEFT JOIN bookings b ON b.id = r.booking_id AND b.organization_id = r.organization_id
      LEFT JOIN channel_threads ct ON ct.conversation_id = r.id AND ct.organization_id = r.organization_id
      LEFT JOIN product_stay_configs c ON c.organization_id = ct.organization_id AND c.product_id = ct.product_id
      WHERE r.id = ? AND r.organization_id = ? AND (
        (ct.conversation_id IS NULL AND b.owner = 'channel')
        OR (c.product_id IS NOT NULL AND (CASE WHEN b.id IS NULL THEN c.location_id = r.location_id
          ELSE ct.product_id = coalesce(b.booked_product_id, b.product_id) END))
      )`, [request.id, request.organization_id])
    if (!mapped) throw new HTTPError({ statusCode: 500, message: 'Channel conversation has no matching home mapping', data: { code: 'CHANNEL_THREAD_MAPPING_INVALID', field: 'conversation_id' } })
  }
  return request
}

/**
 * Every booking with what it booked, one row each: its product, who handles
 * it, its unit, its guest conversation (conversation_id), and a fingerprint of
 * every fact a plan made from it depends on, for guarded writes. offering_id is
 * the product a business offers.
 */
export const BOOKING_RECORDS_SQL = `(
    SELECT b.id, (SELECT conv.id FROM conversations conv WHERE conv.booking_id = b.id AND conv.kind = 'booking') AS conversation_id, b.organization_id, b.status, b.party_size, b.party_size_is_minimum, b.starts_at, b.ends_at, b.timezone,
           b.location_id, b.product_id, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit,
           p.kind AS product_kind, b.product_id AS offering_id, p.name AS product_name, sc.internal_name AS product_internal_name, c.assigned_member_id, b.user_id,
           b.no_show_at, b.created_at, b.received_at, b.updated_at, b.version,
           json_extract(b.policy_json, '$.advance_notice_minutes') AS advance_notice_minutes,
           json_array(b.version, b.status, b.product_id, b.product_session_id, b.starts_at, b.ends_at, b.timezone, b.updated_at) AS fingerprint
      FROM bookings b
      JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      LEFT JOIN product_booking_configs c ON c.product_id = b.product_id AND c.organization_id = b.organization_id
      LEFT JOIN product_stay_configs sc ON sc.product_id = b.product_id AND sc.organization_id = b.organization_id
  )`

/** One row of BOOKING_RECORDS_SQL. received_at is null for a booking imported or known before KrabiClaw received it. */
export interface BookedRecord extends Omit<ThreadOperationalRecord, 'review_id'> {
  conversation_id: string | null
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

export async function getThreadOperationalRecord(db: DbClient, requestId: string, authorized?: Pick<ConversationRow, 'kind' | 'booking_id' | 'organization_id'>): Promise<ThreadOperationalRecord | null> {
  if (authorized?.kind === 'contact') return null
  const record = authorized?.booking_id === null ? null : await queryFirst<Omit<ThreadOperationalRecord, 'party_size_is_minimum'> & { party_size_is_minimum: number }>(db, `
    SELECT br.unit, br.id, br.status, br.party_size, br.party_size_is_minimum, br.starts_at, br.ends_at, br.timezone, br.location_id, br.product_id, br.product_kind, br.product_name, br.product_internal_name,
           br.assigned_member_id, br.organization_id, br.user_id, br.no_show_at, br.version,
           (SELECT rv.id FROM reviews rv WHERE rv.organization_id = br.organization_id AND rv.booking_id = br.id ORDER BY rv.created_at LIMIT 1) AS review_id, br.advance_notice_minutes
      FROM ${authorized ? `${BOOKING_RECORDS_SQL} br` : `conversations owner JOIN ${BOOKING_RECORDS_SQL} br ON br.id = owner.booking_id AND br.organization_id = owner.organization_id`}
     WHERE ${authorized ? 'br.id = ? AND br.organization_id = ?' : "owner.id = ? AND owner.kind = 'booking'"}
     LIMIT 1
  `, authorized ? [authorized.booking_id, authorized.organization_id] : [requestId])
  if (record) return { ...record, party_size_is_minimum: Number(record.party_size_is_minimum) === 1 }
  const request = await queryFirst<{ kind: GuestRequestKind; uncaptured_checkout: number | null }>(db, `
    SELECT r.kind,
      (json_extract(r.payload_json, '$.provenance.creation_kind') = 'checkout'
       AND r.booking_id IS NULL
       AND EXISTS (
         SELECT 1 FROM payment_checkout_holds h
         JOIN payments p ON p.id = h.payment_id AND p.organization_id = h.organization_id AND p.subject_type = 'booking'
         WHERE h.conversation_id = r.id AND h.organization_id = r.organization_id
           AND h.status IN ('active', 'released') AND h.converted_booking_id IS NULL
           AND p.captured_amount = 0 AND p.subject_id IS NULL
           AND p.idempotency_key = 'checkout:' || r.organization_id || ':' || json_extract(r.payload_json, '$.provenance.idempotency_key')
       )) AS uncaptured_checkout
    FROM conversations r WHERE r.id = ?
  `, [requestId])
  if (request?.uncaptured_checkout === 1) return null
  // A channel's conversation before its guest booked (an Airbnb inquiry) has no booking yet.
  if (request?.kind === 'booking' && await queryFirst(db, 'SELECT conversation_id FROM channel_threads WHERE conversation_id = ?', [requestId])) return null
  if (request && request.kind !== 'contact') throw new HTTPError({ statusCode: 404, message: 'The conversation has no matching booking', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: requestId } })
  return null
}

/**
 * A guest conversation and the messages that open it: a contact's own words
 * (`words`, the guest's first message), or a booking's sentence (`opening`, from
 * `openingSentence`) and the guest's note.
 *
 * `claimedBy` is the row whose existence this conversation depends on — the
 * booking or the checkout hold written earlier in the same batch. A
 * conditional claim that finds no room inserts zero rows WITHOUT raising, so a
 * conversation written before it would commit anyway and leave a conversation
 * about a seat nobody holds. Carrying the claim's existence into this insert is
 * what ties them together. The messages are written only where the
 * conversation was.
 */
export function requestInsertQueries(request: Omit<GuestRequest, 'blocked_at' | 'last_message_at'>, claimedBy?: BatchQuery, first?: { opening: string; note: string | null } | { words: string }): BatchQuery[] {
  const provenance = request.kind === 'booking' && 'provenance' in request.payload ? request.payload.provenance : undefined
  const values = [request.id, request.kind, request.organization_id, request.location_id, request.booking_id, request.user_id,
    JSON.stringify(request.payload), request.created_at, request.created_at]
  const insert = `INSERT INTO conversations (id, kind, organization_id, location_id, booking_id, user_id, payload_json, last_message_at, created_at)`
  const written = { sql: 'c.created_at = ?', params: [request.created_at] }
  const messages: BatchQuery[] = !first ? [] : 'words' in first
    ? messageQueries({ conversationId: request.id, authorKind: 'guest', authorUserId: request.user_id, channel: 'web', body: first.words || null,
        eventName: SUBMISSION_EVENT, dedupeKey: `conversation:${request.id}:submission`, occurredAt: request.created_at, guard: written }).queries
    : openingMessageQueries({ conversationId: request.id, body: first.opening, note: first.note, guestUserId: request.user_id,
        openedByUserId: provenance?.actor_user_id ?? request.user_id, at: request.created_at })
  return [{
    query: claimedBy ? `${insert} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${claimedBy.query})` : `${insert} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: claimedBy ? [...values, ...(claimedBy.params ?? [])] : values,
  }, ...messages, publicResourceCacheInvalidationQuery(request.organization_id, 'guest-thread-create')]
}

/**
 * A booking's conversation, written in the booking's own batch and only where
 * the booking landed and has none yet: every booking has one. Its guest
 * contact is what the booking was made with; the conversation belongs to the
 * booking's guest account.
 */
export function bookingConversationQueries(input: {
  organizationId: string; bookingId: string; requestId: string; locationId: string | null; userId: string; now: string
  guest: { name: string | null; email: string | null; phone: string | null }
  participant?: { kind: 'channel'; title: string }
}): BatchQuery[] {
  const payload: ThreadPayload = { guest: input.guest, ...(input.participant ? { participant: input.participant } : {}), ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }
  threadPayload.parse(payload)
  return [{
    query: `INSERT INTO conversations (id, kind, organization_id, location_id, booking_id, user_id, payload_json, last_message_at, created_at)
      SELECT ?, 'booking', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE organization_id = ? AND id = ?)
        AND NOT EXISTS (SELECT 1 FROM conversations WHERE kind = 'booking' AND booking_id = ?)`,
    params: [input.requestId, input.organizationId, input.locationId, input.bookingId, input.userId, JSON.stringify(payload), input.now, input.now, input.organizationId, input.bookingId, input.bookingId],
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
    query: `UPDATE conversations SET location_id = ?, payload_json = json_set(payload_json, '$.guest.name', ?, '$.guest.email', ?, '$.guest.phone', ?)
      WHERE kind = 'booking' AND (json_type(payload_json, '$.participant') IS 'object' OR ? IS NOT NULL)
        AND booking_id = (SELECT id FROM bookings WHERE organization_id = ? AND id = ? AND version = ? AND updated_at = ?)`,
    params: [input.locationId, input.guest.name, input.guest.email, input.guest.phone, input.guest.name, input.organizationId, input.bookingId, input.version, input.updatedAt],
  }
}

interface GuestThreadInput { name: string; email: string; phone?: string | null; locale?: string; ipHash?: string | null }
/** A site or operator booking's thread: its guest gave a name and an email. */
export type GuestThreadPayload = ThreadPayload & { guest: { name: string; email: string } }
export function threadPayloadForGuest(input: GuestThreadInput): GuestThreadPayload {
  return {
    guest: { name: input.name, email: input.email, phone: input.phone ?? null, ...(input.locale === undefined ? {} : { locale: input.locale }) },
    ip_hash: input.ipHash ?? null,
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
  return Boolean(record && record.status === 'confirmed' && record.no_show_at === null && record.review_id === null
    && record.starts_at <= (isBookingDay(record.starts_at) ? localDateAt(new Date(now), record.timezone) : now))
}

export function canCancelBookingRequest(record: ThreadOperationalRecord | null, now: string): record is ThreadOperationalRecord {
  return Boolean(record && ['pending', 'confirmed'].includes(record.status) && record.ends_at > now && !isBookingComplete(record, now))
}

/** A stay's nights and party, in the stay's own dates: "Mar 3 – Mar 6 · 2 guests". */
export function stayPreview(record: { starts_at: string; ends_at: string; timezone: string; party_size: number }): string {
  const day = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${bookingDay(value, record.timezone)}T00:00:00Z`))
  return `${day(record.starts_at)} – ${day(record.ends_at)} · ${record.party_size} ${record.party_size === 1 ? 'guest' : 'guests'}`
}

export type RequestLocation = { title: string; timezone: string }

export function requestLocationQuery(request: Pick<ConversationRow, 'location_id' | 'organization_id'>) {
  return { query: 'SELECT title, timezone FROM business_locations WHERE id = ? AND organization_id = ?', params: [request.location_id, request.organization_id] }
}

export async function requestSummary(db: DbClient, request: GuestRequest, knownRecord?: ThreadOperationalRecord | null, knownLocation?: RequestLocation | null) {
  const record = knownRecord === undefined ? await getThreadOperationalRecord(db, request.id) : knownRecord
  const { query, params } = requestLocationQuery(request)
  const location = knownLocation !== undefined ? knownLocation
    : request.location_id === null ? null : await queryFirst<RequestLocation>(db, query, params)
  if (request.location_id !== null && !location) throw new HTTPError({ statusCode: 500, message: 'The conversation location does not exist', data: { code: 'INVALID_GUEST_THREAD', field: 'location_id', request_id: request.id } })
  return {
    guestName: request.payload.guest.name, participantLabel: participantLabel(request), guestEmail: request.payload.guest.email, guestPhone: request.payload.guest.phone,
    organizationId: request.organization_id, locationId: request.location_id,
    locationTitle: location?.title ?? null, locationTimezone: location?.timezone ?? null, productTitle: record?.product_name ?? null,
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
type GuestCancellationActor = { tokenHash: string; buyerUserId?: never } | { buyerUserId: string; tokenHash?: never }
type GuestCancellation = { now: string; env: CloudflareEnv }

export async function cancelGuestBooking(db: DbClient, input: GuestCancellation & (
  | { id: string; organizationId: string; tokenHash: string }
  | { bookingId: string; organizationId?: string; buyerUserId: string; version: number }
)): Promise<{ kind: 'booking' } | { kind: 'stay'; refund_minor: number } | null> {
  let target: Parameters<typeof cancelBookingRequest>[1]
  if ('bookingId' in input) {
    const owned = await ownedBuyerRequest(db, input.buyerUserId, input.bookingId, 'booking')
    if (input.organizationId && owned.organization_id !== input.organizationId) return null
    if (owned.unit === 'nights') {
      const { cancelStayAsGuest } = await import('~/server/domain/stays')
      const { refund_minor } = await cancelStayAsGuest(db, input.env, owned.organization_id, owned.booking_id, input.buyerUserId, input.now, input.version)
      return { kind: 'stay', refund_minor }
    }
    target = { id: owned.conversation_id, organizationId: owned.organization_id, buyerUserId: input.buyerUserId, version: input.version, now: input.now, env: input.env, kind: 'booking' }
  } else target = { ...input, kind: 'booking' }
  const cancelled = await cancelBookingRequest(db, target)
  if (!cancelled) return null
  const { notifyGuestCancellation } = await import('~/server/utils/notifications')
  await notifyGuestCancellation(input.env, db, cancelled)
  return { kind: 'booking' }
}

export async function cancelBookingRequest(db: DbClient, input: GuestCancellation & {
  id: string; organizationId: string; kind: BookingRequest['kind']; version?: number
} & GuestCancellationActor): Promise<{ request: BookingRequest; record: ThreadOperationalRecord; wasConfirmed: boolean; changed: boolean } | null> {
  const current = await getGuestRequest(db, input.id, input.organizationId, input.kind)
  if (!current || current.kind === 'contact') return null
  const record = await getThreadOperationalRecord(db, current.id)
  if (!record || record.organization_id !== input.organizationId || record.unit !== 'slot') return null
  function authorized(request: BookingRequest, booked: ThreadOperationalRecord) {
    if (input.buyerUserId) return request.user_id === input.buyerUserId && booked.user_id === input.buyerUserId
    const capability = request.payload.cancellation
    return capability.token_hash === input.tokenHash && capability.expires_at !== null && capability.expires_at > input.now
  }
  if (!authorized(current, record)) return null
  async function readCancelled(changed = false) {
    const request = await getGuestRequest(db, input.id, input.organizationId, input.kind)
    const cancelled = await getThreadOperationalRecord(db, input.id)
    if (!request || request.kind === 'contact' || !request.payload.cancellation.used_at || !cancelled || cancelled.status !== 'cancelled' || cancelled.organization_id !== input.organizationId) return null
    if (!authorized(request, cancelled)) return null
    const entry = await queryFirst<{ payload_json: string }>(db, 'SELECT payload_json FROM messages WHERE conversation_id = ? AND dedupe_key = ?', [input.id, `booking:${cancelled.id}:guest-cancel`])
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
  if (input.version !== undefined && record.version !== input.version) {
    throw new HTTPError({ statusCode: 409, message: 'This booking changed since you opened it. Reload and try again.' })
  }
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
      query: `UPDATE conversations SET payload_json = json_set(payload_json, '$.cancellation.used_at', ?)
        WHERE id = ? AND organization_id = ? AND kind = ?
          AND ${input.buyerUserId ? 'user_id = ?' : "json_extract(payload_json, '$.cancellation.token_hash') = ? AND json_extract(payload_json, '$.cancellation.expires_at') > ?"}
          AND json_extract(payload_json, '$.cancellation.used_at') IS NULL AND (${refund.guard?.query ?? '1=1'})
          AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND organization_id = ? AND id = conversations.booking_id AND version = ? AND status = ?${input.buyerUserId ? ' AND user_id = ?' : ''}) RETURNING *`,
      params: [input.now, input.id, input.organizationId, input.kind, ...(input.buyerUserId ? [input.buyerUserId] : [input.tokenHash, input.now]), ...(refund.guard?.params ?? []), record.id, input.organizationId, record.version, record.status, ...(input.buyerUserId ? [input.buyerUserId] : [])],
    },
    bookingStatusQuery({ organizationId: input.organizationId, bookingId: record.id, status: 'cancelled', reason: 'guest_cancelled', now: input.now,
      guard: { query: `changes() = 1 AND version = ? AND status = ?${input.buyerUserId ? ' AND user_id = ?' : ''}
        AND EXISTS (SELECT 1 FROM conversations WHERE id = ? AND organization_id = ? AND booking_id = bookings.id
          AND json_extract(payload_json, '$.cancellation.used_at') = ?)`,
        params: [record.version, record.status, ...(input.buyerUserId ? [input.buyerUserId] : []), input.id, input.organizationId, input.now] } }),
    // The one record of the guest's cancellation: KrabiClaw's message, by the guest.
    ...messageQueries({ conversationId: input.id, authorKind: 'krabiclaw', authorUserId: current.user_id, eventName: 'booking.cancel',
      payload: { action: 'cancel', beforeStatus: record.status, afterStatus: 'cancelled', booking_id: record.id },
      dedupeKey: `booking:${record.id}:guest-cancel`, occurredAt: input.now,
      guard: { sql: "EXISTS (SELECT 1 FROM bookings cancelled WHERE cancelled.id = c.booking_id AND cancelled.status = 'cancelled' AND cancelled.cancelled_at = ?)", params: [input.now] } }).queries,
    ...refund.queries,
    ...(await import('~/server/domain/guest-threads/repository')).conversationTaskQueries(input.id, input.now),
  ], { operation: 'Cancel booking request' })

  const row = (consumed?.results?.[0] ?? null) as Record<string, unknown> | null
  if (!row) return await readCancelled()
  if ((released?.meta?.changes ?? 0) !== 1) throw new Error('Cancellation consumed the token without releasing the booking')

  return await readCancelled(true)
}
